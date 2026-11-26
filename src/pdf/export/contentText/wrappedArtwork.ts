import { PDFDict, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream, type PDFPage } from 'pdf-lib';
import type { PdfRect } from '../../model/types';
import type { GlyphPlacement } from '../contentStreamEdit/textState';
import { tokenizeContentStream, type ContentOp } from '../contentStreamEdit/tokenizer';
import { numericArray, reflowScene } from './reflowScene';
import type { planRetypeset } from './retypesetPlan';
import { contains, intersects } from './regionProof/geometry';
import { retypesetScopes } from './retypesetScopes';

type Ink = { box: PdfRect; known: boolean };
const imageFormOps = new Set(['q', 'Q', 'cm', 'Do']);
const padded = (box: PdfRect, pad: number) => ({
  x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad,
});
const axisAligned = (m: readonly number[]) =>
  m.length === 6 && m.every(Number.isFinite) && m[1] === 0 && m[2] === 0 && m[0]! > 0 && m[3]! > 0;
const compose = (a: readonly number[], b: readonly number[]) =>
  [a[0]! * b[0]!, 0, 0, a[3]! * b[3]!, a[0]! * b[4]! + a[4]!, a[3]! * b[5]! + a[5]!];
const decoded = (raw: PDFRawStream) => raw.dict.has(PDFName.of('Filter'))
  ? decodePDFRawStream(raw).decode() : raw.getContents();

/** Project the actual pixel grid through an opaque image or simple Form
 * invocation. Every candidate box must clear its clipping boundaries. */
function imageGrid(page: PDFPage, op: ContentOp, transform: readonly number[], clip?: PdfRect) {
  let resources = page.node.Resources();
  let draw = op;
  let matrix = transform;
  const clips = clip ? [clip] : [];
  for (let depth = 0; depth < 8; depth++) {
    const name = draw.operands[0];
    if (draw.operands.length !== 1 || name?.kind !== 'name' || !axisAligned(matrix)) return;
    const raw = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.lookup(PDFName.of(name.value));
    if (!(raw instanceof PDFRawStream) || raw.dict.has(PDFName.of('OC'))) return;
    const kind = raw.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
    if (kind === 'Image') {
      return { raw, clips, frame: { x: matrix[4]!, y: matrix[5]!, w: matrix[0]!, h: matrix[3]! } };
    }
    if (kind !== 'Form' || raw.dict.has(PDFName.of('Group'))) return;
    const bbox = numericArray(raw.dict, 'BBox');
    const local = numericArray(raw.dict, 'Matrix') ?? [1, 0, 0, 1, 0, 0];
    if (bbox?.length !== 4 || !bbox.every(Number.isFinite) || !axisAligned(local)) return;
    matrix = compose(matrix, local);
    const [l, b, r, t] = bbox as [number, number, number, number];
    clips.push({ x: matrix[4]! + matrix[0]! * l, y: matrix[5]! + matrix[3]! * b, w: matrix[0]! * (r - l), h: matrix[3]! * (t - b) });
    if (raw.getContentsSize() > 65536) return;
    const ops = tokenizeContentStream(decoded(raw));
    const calls = ops.filter(o => o.operator === 'Do');
    if (calls.length !== 1 || ops.some(o => !imageFormOps.has(o.operator))) return;
    draw = calls[0]!;
    const scope = retypesetScopes(ops).get(ops.indexOf(draw));
    if (!scope || !axisAligned(scope.ct)) return;
    matrix = compose(matrix, scope.ct);
    resources = raw.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources;
  }
}

/** A flat perimeter witnesses the paper color. Compare the exact source
 * samples beneath each candidate glyph. Any local deviation reserves its
 * pixels for the artwork, even if its contrast is barely visible. */
function clearsImage(grid: NonNullable<ReturnType<typeof imageGrid>>, glyphs: readonly PdfRect[]) {
  const { raw, frame, clips } = grid;
  const number = (key: string) => raw.dict.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber();
  const color = raw.dict.lookupMaybe(PDFName.of('ColorSpace'), PDFName)?.decodeText();
  const channels = color === 'DeviceRGB' ? 3 : color === 'DeviceGray' ? 1 : 0;
  const width = number('Width'), height = number('Height');
  if (!channels || !width || !height || !Number.isInteger(width) || !Number.isInteger(height) ||
      width < 2 || height < 2 || width * height * channels > 24_000_000 || number('BitsPerComponent') !== 8 ||
      ['Decode', 'Mask', 'SMask', 'ImageMask', 'Interpolate', 'SMaskInData', 'Alternates'].some(k => raw.dict.has(PDFName.of(k)))) return false;
  const data = decoded(raw);
  if (data.length !== width * height * channels) return false;
  const paper = (x: number, y: number) => {
    const offset = (y * width + x) * channels;
    for (let c = 0; c < channels; c++) if (data[offset + c] !== data[c]) return false;
    return true;
  };
  for (let x = 0; x < width; x++) if (!paper(x, 0) || !paper(x, height - 1)) return false;
  for (let y = 0; y < height; y++) if (!paper(0, y) || !paper(width - 1, y)) return false;
  for (const box of glyphs) {
    if (![frame, ...clips].every(clip => contains(clip, box))) return false;
    const left = Math.floor((box.x - frame.x) * width / frame.w);
    const right = Math.ceil((box.x + box.w - frame.x) * width / frame.w);
    const top = Math.floor((frame.y + frame.h - box.y - box.h) * height / frame.h);
    const bottom = Math.ceil((frame.y + frame.h - box.y) * height / frame.h);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) if (!paper(x, y)) return false;
  }
  return true;
}

function clearsWrappedArtwork(page: PDFPage, ops: ContentOp[], output: readonly Ink[],
  stationary: readonly Ink[], firstShow: number) {
  const crop = page.getCropBox(), frame = { x: crop.x, y: crop.y, w: crop.width, h: crop.height };
  if (output.some(o => !o.known)) return false;
  const glyphs = output.filter(o => o.box.w > 0 && o.box.h > 0).map(o => padded(o.box, .125));
  if (!glyphs.length || glyphs.some(b => !contains(frame, b) || stationary.some(s => intersects(s.box, b)))) return false;
  const scopes = retypesetScopes(ops);
  let clear = true;
  try {
    reflowScene(page, ops, frame, (obstacle, kind, index) => {
      if (!clear || kind === 'backdrop') return;
      const overlapping = glyphs.filter(box => intersects(obstacle, box));
      if (!overlapping.length) return;
      const scope = scopes.get(index);
      const grid = (kind === 'image' || kind === 'form') && index < firstShow &&
        scope && scope.clip !== null && !ops.slice(0, index).some(o => o.operator === 'gs')
        ? imageGrid(page, ops[index]!, scope.ct, scope.clip) : undefined;
      clear = !!grid && clearsImage(grid, overlapping);
    }, .01);
  } catch {
    return false;
  }
  return clear;
}

/** Retry the original bounded wrap only before any source streams change.
 * Preserve the selected size and reject any fallback that moves other ink. */
export function verifyWrappedArtwork(page: PDFPage, ops: ContentOp[], plans: ReturnType<typeof planRetypeset>[],
  lines: number, pushed: boolean, newFonts: number, output: Iterable<Ink>, source: ReadonlyMap<string, Ink>,
  target: ReadonlySet<string>, hits: readonly GlyphPlacement[]) {
  const stationary = [...source].filter(([key]) => !target.has(key)).map(([, ink]) => ink);
  const plan = plans[0]!;
  if (plans.length !== 1 || plan.group.lines.length !== 1 || lines < 2 || pushed || newFonts ||
      plan.output.some(a => (a.fit?.sizeScale ?? 1) !== 1 || (a.size ?? 1) !== 1) ||
      !clearsWrappedArtwork(page, ops, [...output], stationary, Math.min(...hits.map(g => g.opIndex)))) {
    throw Error('wrapped correction could not prove clearance of nearby artwork');
  }
}
