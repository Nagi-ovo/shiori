import { degrees, PDFName, PDFPage } from 'pdf-lib';
import type { ContentTextOverlay, PdfRect } from '../../model/types';
import { quadIntersectsRect, removeIdentifiedGlyphs } from '../contentStreamEdit/removeGlyphs';
import { pdfName, pdfNumber } from '../contentStreamEdit/runEncoding';
import { tokenizeContentStream, type ContentOp } from '../contentStreamEdit/tokenizer';
import type { GlyphPlacement } from '../contentStreamEdit/textState';
import { installRetypesetForms } from './retypesetFormCow';
import { formPageBox, pageFormGlyphs, readRetypesetStreams, type RetypesetStream } from './retypesetForms';
import { retypesetScopes, retypesetPaintOps } from './retypesetScopes';
import { reflowScene } from './reflowScene';
import { bounds } from './retypesetInk';
import { intersectRect, intersects } from './regionProof/geometry';
import { saveRasterProbe } from './contentTextRaster';

const shows = new Set(['Tj', 'TJ', "'", '"']);
const paint = (op: ContentOp) => retypesetPaintOps.has(op.operator) && op.operator !== 'n';
const allowed = new Set([
  'q', 'Q', 'cm', 'BT', 'ET', 'Tf', 'Tm', 'Td', 'TD', 'T*', 'Tr', 'Ts', 'Tc', 'Tw', 'Tz', 'TL', ...shows,
  'g', 'G', 'rg', 'RG', 'k', 'K', 'm', 'l', 'c', 'v', 'y', 'h', 're', 'w', 'd', 'J', 'j', 'M', 'W', 'W*',
  'gs', 'cs', 'CS', 'sc', 'scn', 'SC', 'SCN', 'ri', 'i', 'BMC', 'BDC', 'EMC', 'MP', 'DP', 'Do', 'sh', ...retypesetPaintOps,
]);
export const compactContactText = (text: string) => text.replace(/\s/gu, '');

export function inspectContactScene(page: PDFPage) {
  const { root, nodes, images, errors } = readRetypesetStreams(page);
  if (errors.length || nodes.length > 128 || nodes.some(node => !node.read.walk.ok ||
      node.ops.some(op => !allowed.has(op.operator) ||
        op.operator === 'Tr' && !(op.operands[0]?.kind === 'number' && op.operands[0].value >= 0 && op.operands[0].value <= 3)))) return;
  const size = nodes.reduce((n, node) => n + node.bytes.length, 0);
  if (size > 2_000_000) return;
  const crop = page.getCropBox(), media = page.getMediaBox();
  const frame = intersectRect(
    { x: crop.x, y: crop.y, w: crop.width, h: crop.height },
    { x: media.x, y: media.y, w: media.width, h: media.height },
  );
  if (!frame) return;
  const byPath = new Map<string, RetypesetStream>();
  function locate(node: RetypesetStream, path: string) {
    byPath.set(path, node);
    for (const child of node.children) locate(child, `${path}/${child.useIndex}`);
  }
  locate(root, '');
  const backdrop = new Set<number>();
  const first = root.ops.findIndex(op => paint(op) || shows.has(op.operator) || op.operator === 'Do' || op.operator === 'sh');
  reflowScene(page, root.ops, frame, (_, kind, i) => {
    if (kind === 'backdrop' && i === first) backdrop.add(i);
  }, 0);
  return { page, root, nodes, byPath, frame, backdrop, images };
}

export type ContactScene = NonNullable<ReturnType<typeof inspectContactScene>>;
export type ContactTarget = { path: string; node: RetypesetStream; glyphs: GlyphPlacement[]; footprint: PdfRect };

export function findContactTarget(scene: ContactScene, overlay: ContentTextOverlay, requested: string, original: ContactTarget | null) {
  const expected = compactContactText(requested);
  const covers = overlay.coverRects.map(r => ({ ...r, x: r.x + scene.frame.x, y: r.y + scene.frame.y }));
  const baselines = overlay.sourceBaselinesPt?.map(y => y + scene.frame.y);
  const search = original ? [...scene.byPath].filter(([key]) => key === original.path) : [...scene.byPath];
  if (!expected) {
    const [path, node] = search[0] ?? [];
    return original && node ? { path: path!, node, glyphs: [], footprint: original.footprint } : undefined;
  }
  const matches: ContactTarget[] = [];
  function match(path: string, node: RetypesetStream, pageGlyphs: ReturnType<typeof pageFormGlyphs>) {
    const local = new Map(node.read.glyphs.map(g => [address(g.glyph), g.glyph]));
    for (const [i, first] of pageGlyphs.entries()) {
      if (!first.text || !expected.startsWith(compactContactText(first.text)) || !first.text.trim()) continue;
      const atSource = covers.some(r => quadIntersectsRect(first.glyph.coreQuad, r));
      if (!original && (!atSource || baselines?.length && !baselines.some(y => Math.abs(y - first.y) < .15))) continue;
      const reach = Math.max(2, overlay.fontSize);
      if (original && !atSource && !intersects(bounds(first.glyph.quad), {
        x: original.footprint.x - reach, y: original.footprint.y - reach,
        w: original.footprint.w + 2 * reach, h: original.footprint.h + 2 * reach,
      })) continue;
      let word = '';
      for (let j = i; j < pageGlyphs.length; j++) {
        const candidate = pageGlyphs[j]!;
        if (candidate.text === undefined) break;
        word += compactContactText(candidate.text);
        if (!expected.startsWith(word)) break;
        if (word !== expected) continue;
        const measured = pageGlyphs.slice(i, j + 1);
        if (measured.some(g => ![0, 1, 2].includes(g.state.renderMode ?? 0) ||
          !original && !!g.text?.trim() && !covers.some(r => quadIntersectsRect(g.glyph.coreQuad, r)))) break;
        matches.push({ path, node, glyphs: measured.map(g => local.get(address(g.glyph))!),
          footprint: bounds(measured.flatMap(g => g.glyph.quad)) });
        break;
      }
    }
  }
  for (const [path, node] of search) match(path, node, pageFormGlyphs(node));
  if (!matches.length) {
    for (const [path, node] of search) match(path, node, inHorizontalReadingOrder(pageFormGlyphs(node)));
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function inHorizontalReadingOrder(glyphs: ReturnType<typeof pageFormGlyphs>) {
  const horizontal = glyphs.every(({ glyph }) => Math.abs(glyph.coreQuad[1].y - glyph.coreQuad[0].y) < .01 &&
    glyph.coreQuad[1].x >= glyph.coreQuad[0].x);
  if (!horizontal) return glyphs;
  const lines: { y: number; glyphs: typeof glyphs }[] = [];
  for (const glyph of [...glyphs].sort((a, b) => b.y - a.y)) {
    const line = lines.at(-1);
    if (line && line.y - glyph.y < .15) line.glyphs.push(glyph);
    else lines.push({ y: glyph.y, glyphs: [glyph] });
  }
  return lines.flatMap(line => line.glyphs.sort((a, b) => a.x - b.x));
}

const address = (g: GlyphPlacement) => `${g.opIndex}:${g.arrayItemIndex}:${g.byteOffset}`;

export function unsupportedPaintAt(scene: ContactScene, box: PdfRect) {
  if (scene.images.some(image => intersects(box, formPageBox(image.matrix, { x: 0, y: 0, w: 1, h: 1 })))) return true;
  let annotation = false;
  reflowScene(scene.page, scene.root.ops, scene.frame, (bounds, kind) => {
    if (kind === 'annot' && intersects(bounds, box)) annotation = true;
  }, 0);
  return annotation;
}

function patch(bytes: Uint8Array, ops: ContentOp[], change: (op: ContentOp, i: number) => string | undefined) {
  const encoder = new TextEncoder(), parts: Uint8Array[] = [];
  let from = 0;
  for (const [i, op] of ops.entries()) {
    const replacement = change(op, i);
    if (replacement === undefined) continue;
    parts.push(bytes.subarray(from, op.start), encoder.encode(replacement));
    from = op.end;
  }
  if (!parts.length) return bytes;
  parts.push(bytes.subarray(from));
  const result = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of parts) {
    result.set(b, offset);
    offset += b.length;
  }
  return result;
}

type Layer = 'composite' | 'counterpart' | 'target' | 'substrate' | 'artwork' | 'target-over-artwork';
/** Muting complete shows retains their original pen motions, including
 * unmapped foreign fonts. Partial target shows use exact byte addresses. */
export async function contactProbe(scene: ContactScene, target: ContactTarget, layer: Layer) {
  const page = PDFPage.of(scene.page.node.clone(), scene.page.ref, scene.page.doc);
  // Use the visible frame in its upright orientation for every raster layer.
  // PDF user-space glyph positions and the saved page's rotation stay intact.
  const { x, y, w, h } = scene.frame;
  page.setRotation(degrees(0));
  page.setMediaBox(x, y, w, h);
  page.setCropBox(x, y, w, h);
  if (layer === 'composite') return saveRasterProbe(page);
  const muteText = layer !== 'counterpart';
  const muteGraphics = layer === 'target' || layer === 'substrate';
  const keepTarget = layer === 'target' || layer === 'target-over-artwork';
  const selected = new Set(target.glyphs);
  const owns = new Set(target.glyphs.map(g => g.opIndex));
  const rewrite = (node: RetypesetStream, inherited = 0): RetypesetStream => {
    const hits = node !== target.node ? [] : layer === 'counterpart' ? target.glyphs : keepTarget
      ? node.read.glyphs.map(g => g.glyph).filter(g => owns.has(g.opIndex) && !selected.has(g)) : [];
    const remove = removeIdentifiedGlyphs(node.bytes, node.ops, hits, undefined, pdfNumber);
    const source = remove.changed ? remove.bytes : node.bytes;
    // Removing glyphs inside quotes desugars line positioning and would
    // change the paint-operator indices. Do not use a guessed address.
    if (hits.some(g => !['Tj', 'TJ'].includes(node.ops[g.opIndex]!.operator))) throw Error('Unsupported partial quote show');
    const ops = remove.changed ? tokenizeContentStream(source) : node.ops;
    if (ops.length !== node.ops.length) throw Error('Contact probe lost stream addresses');
    const scopes = retypesetScopes(ops, undefined, inherited);
    const childCalls = new Set(node.children.map(child => child.useIndex));
    let call = -1;
    const data = patch(source, ops, (op, i) => {
      if (op.operator === 'Do') {
        call++;
        const name = op.operands[0];
        if (muteGraphics && !childCalls.has(call)) {
          if (name?.kind !== 'name') throw Error('Invalid XObject invocation');
          return `q 0 0 0 0 re W n ${pdfName(name.value)} Do Q`;
        }
      }
      if (muteGraphics && paint(op) && !(node === scene.root && scene.backdrop.has(i))) return 'n';
      if (muteGraphics && op.operator === 'sh') return '';
      if (muteText && shows.has(op.operator) && !(keepTarget && node === target.node && owns.has(i))) {
        // The raw spelling can contain binary literal strings. Copying
        // through the tokenizer's string data preserves every source code.
        const mode = scopes.get(i)?.renderMode ?? 0;
        return `3 Tr ${serializeShow(op)} ${mode} Tr`;
      }
    });
    const page = PDFPage.of(node.page.node.clone(), node.page.ref, node.page.doc);
    if (data !== node.bytes) page.node.set(PDFName.of('Contents'), page.doc.context.flateStream(data));
    const calls = node.ops.flatMap((op, i) => op.operator === 'Do' ? [i] : []);
    const children = node.children.map(child =>
      rewrite(child, node.read.invocations.get(calls[child.useIndex!]!)?.renderMode ?? inherited));
    return { ...node, page, changed: data !== node.bytes, children };
  };
  const root = rewrite(scene.root);
  installRetypesetForms(page, root);
  return saveRasterProbe(page);
}

function serializeShow(op: ContentOp) {
  const operand = (o: ContentOp['operands'][number]): string => {
    switch (o.kind) {
      case 'string': return `<${Array.from(o.bytes, v => v.toString(16).padStart(2, '0')).join('')}>`;
      case 'number': return pdfNumber(o.value);
      case 'array': return `[${o.items.map(operand).join(' ')}]`;
      default: throw Error('Invalid show operands');
    }
  };
  return `${op.operands.map(operand).join(' ')} ${op.operator}`;
}
