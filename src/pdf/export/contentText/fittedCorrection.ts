import type { PDFPage } from 'pdf-lib';
import type { ContactRenderer } from './contentTextRaster';
import { backgroundRaster, verifyFittedBackdrop } from './fittedBackdrop';
import type { ContentTextOverlay, PdfRect } from '../../model/types';
import { runContextSafety, type ResolvedRunFont } from '../contentStreamEdit/replaceRun';
import { removeIdentifiedGlyphs } from '../contentStreamEdit/removeGlyphs';
import { codes, hex, pdfNumber } from '../contentStreamEdit/runEncoding';
import type { RunEnvironment } from '../contentStreamEdit/textSafety';
import { walkTextPlacements, type GlyphPlacement, type ShowTextState } from '../contentStreamEdit/textState';
import { tokenizeContentStream, type ContentOp } from '../contentStreamEdit/tokenizer';
import { lineChanges } from './diff';
import type { ContentTextOutcome } from './outcomes';
import { streamInkResolver } from './reflowInk';
import { reflowScene } from './reflowScene';
import { ReflowTraceError, traceReflowSource } from './reflowTrace';
import { contains, intersects, linear, origin, validTrace } from './regionProof/geometry';
import { retypesetInk, retypesetPaintedInk } from './retypesetInk';
import { retypesetScopes } from './retypesetScopes';

const compact = (text: string) => text.replace(/\s/gu, '');
const point = (glyph: GlyphPlacement) => glyph.coreQuad[0];
type PositionedCode = { x: number; code: number; source?: GlyphPlacement };

/** Keep the authored TJ segmentation within each part. A single tracking
 * value across the attributed text preserves its word spacing in readers
 * that infer separators from the distribution of ink within a show. */
function patchShow(source: Uint8Array, op: ContentOp, first: GlyphPlacement, last: GlyphPlacement,
  next: GlyphPlacement, code: number, tracking: number, originalTracking: number, compensation: number,
  rejoin?: { anchor: readonly number[]; line: readonly number[]; adjustment: number }) {
  const groups: [string[], string[], string[]] = [[], [], []];
  const operands = op.operator === 'TJ' && op.operands[0]?.kind === 'array' ? op.operands[0].items : op.operands;
  let group = 0;
  for (const [i, item] of operands.entries()) {
    if (item.kind === 'number') {
      groups[group]!.push(pdfNumber(item.value));
      continue;
    }
    if (item.kind !== 'string') throw Error('Invalid tracked show');
    const itemIndex = op.operator === 'TJ' ? i : -1;
    const byteWidth = first.byteLength;
    let data: number[] = [];
    const flush = () => {
      if (!data.length) return;
      groups[group]!.push(hex(Uint8Array.from(data)));
      data = [];
    };
    for (let offset = 0; offset < item.bytes.length; offset += byteWidth) {
      if (itemIndex === first.arrayItemIndex && offset === first.byteOffset) { flush(); group = 1; }
      if (itemIndex === next.arrayItemIndex && offset === next.byteOffset) {
        if (byteWidth === 2) data.push(code >> 8);
        data.push(code & 255);
      }
      data.push(...item.bytes.subarray(offset, offset + byteWidth));
      if (itemIndex === last.arrayItemIndex && offset === last.byteOffset) { flush(); group = 2; }
    }
    flush();
  }

  const suffix = groups[2];
  const show = (g: string[]) => g.length ? `[${g.join(' ')}] TJ` : '';
  const matrix = (m: readonly number[]) => `${m.map(pdfNumber).join(' ')} Tm`;
  let resume: string[];
  if (rejoin) {
    // Start the untouched item at its authored matrix. Even a rounded pen
    // at the right point can shift hinted pixels when a field shares a TJ.
    while (suffix[0] && !suffix[0].startsWith('<')) suffix.shift();
    resume = [matrix(rejoin.anchor), show(suffix), matrix(rejoin.line), `[${pdfNumber(rejoin.adjustment)}] TJ`];
  } else {
    const leading = suffix[0] && !suffix[0].startsWith('<') ? Number(suffix.shift()) : 0;
    suffix.unshift(pdfNumber(leading - compensation));
    resume = [show(suffix)];
  }
  const patch = new TextEncoder().encode([
    show(groups[0]), `${pdfNumber(tracking)} Tc`, show(groups[1]), `${pdfNumber(originalTracking)} Tc`, ...resume,
  ].filter(Boolean).join(' '));
  const output = new Uint8Array(source.length - (op.end - op.start) + patch.length);
  output.set(source.subarray(0, op.start));
  output.set(patch, op.start);
  output.set(source.subarray(op.end), op.start + patch.length);
  return output;
}

/** A measured, tracked single-line insertion in its original page-level show.
 * Keeps the font, baseline and paint slot, including when artwork precedes it.
 * The ordinary compiler remains responsible for other edits and wrapping. */
export async function compileFittedCorrection(
  page: PDFPage, bytes: Uint8Array, ops: ContentOp[], fonts: ResolvedRunFont[],
  overlay: ContentTextOverlay, env: RunEnvironment, otherCovers: readonly PdfRect[], render?: ContactRenderer,
): Promise<{ outcome: ContentTextOutcome; bytes?: Uint8Array } | undefined> {
  const { originalText, text, sourceStyle, sourceGlyphs, coverRects, sourceBaselinesPt } = overlay;
  if (!sourceStyle || !sourceGlyphs?.length || coverRects.length !== 1 || sourceBaselinesPt?.length !== 1 ||
      !originalText || /[\r\n]/u.test(originalText) || overlay.angle ||
      Object.keys(sourceStyle).some(k => sourceStyle[k as keyof typeof sourceStyle] !== overlay[k as keyof typeof sourceStyle])) return;
  const [change, ...others] = lineChanges(originalText, text);
  const excluding = text === '';
  if (!excluding && (!change || others.length || change.start !== change.end ||
      !/^\p{L}$/u.test(change.replacement))) return;

  const byName = new Map(fonts.map(font => [font.resourceName, font]));
  const callbacks = {
    resolveFont: (name: string) => {
      const font = byName.get(name);
      return font ? { ...font, ok: true as const, appliesWordSpacing: font.bytesPerCode === 1 } : null;
    },
    extGStateSetsFont: (name: string) => env.extGStates?.get(name)?.setsFont ?? null,
  };
  const before = walkTextPlacements(ops, callbacks);
  if (!before.ok || before.unplacedText || before.glyphs.length > 4096) return;
  const label = (g: GlyphPlacement) => byName.get(g.fontName)!.unicodeByCode.get(g.code) ?? '';
  const cover = coverRects[0]!;
  const baseline = sourceBaselinesPt[0]!;
  const selected = before.glyphs.filter(g => {
    const { x, y } = point(g);
    return Math.abs(y - baseline) < .05 && x >= cover.x - .8 && x <= cover.x + cover.w + .05;
  });
  const first = selected[0], last = selected.at(-1);
  if (!first || !last || !compact(originalText) || compact(selected.map(label).join('')) !== compact(originalText) ||
      selected.some(g => Array.from(label(g)).length !== 1 || g.opIndex !== first.opIndex || g.fontName !== first.fontName ||
        (compact(label(g)) && !sourceGlyphs.some(o => o.text === label(g) &&
          Math.abs(o.x - point(g).x) < .05 && Math.abs(o.y - point(g).y) < .05)))) return;
  const op = ops[first.opIndex]!;
  if (op.operator !== 'Tj' && op.operator !== 'TJ') return;
  const show = before.glyphs.filter(g => g.opIndex === first.opIndex);
  if (show.length > 256 || show.some((g, i) => i && point(g).x <= point(show[i - 1]!).x)) return;
  const safety = runContextSafety(ops, env);
  if (!safety.ok || safety.unsafe.has(first.opIndex) || retypesetScopes(ops).get(first.opIndex)?.clip !== undefined) return;
  let trace: ReturnType<typeof traceReflowSource>;
  try {
    trace = traceReflowSource(ops, fonts, 'source-show', env);
  } catch (error) {
    if (error instanceof ReflowTraceError) return;
    throw error;
  }
  const state = trace.shows.get(`${first.opIndex}:${first.arrayItemIndex}`)?.before;
  if (!state || !validTrace(state) || state.renderMode !== 0 || state.rise !== 0) return;
  const [sx,,,sy] = linear(state);
  const em = sy! * state.size;
  const factor = sx! * state.size * state.tz / 100000;
  if (Math.abs(em - overlay.fontSize) > .01 || !(factor > 0) || 1000 * state.tc / state.size * factor < em * .06) return;

  const result = (output: Uint8Array) => ({
    bytes: output, outcome: { overlayId: overlay.id, mode: 'in-place', fidelity: 'approximate', ...(!excluding && { sourceSpacingAdjusted: true }) } as const,
  });
  if (excluding) {
    const removed = removeIdentifiedGlyphs(bytes, ops, selected, undefined, pdfNumber);
    return removed.changed ? result(removed.bytes) : undefined;
  }

  const textAt = Array.from(compact(originalText.slice(0, change!.start))).length;
  const content = selected.filter(g => compact(label(g)));
  const next = content[textAt], prev = content[textAt - 1];
  if (!next || !prev || show.indexOf(next) !== show.indexOf(prev) + 1 ||
      !/^\p{L}+$/u.test(label(prev) + label(next))) return;
  const font = byName.get(first.fontName)!;
  const encoding = font.canEncode?.(change!.replacement);
  if (!encoding?.ok || encoding.bytes.length !== font.bytesPerCode) return;
  const code = codes(encoding.bytes, font.bytesPerCode)[0]!;
  if (font.unicodeByCode.get(code) !== change!.replacement || !(font.widthOf(code) > 0)) return;
  const measure = streamInkResolver(page, [font]);
  const outline = (c: number) => {
    const ink = measure(font.resourceName, c, state);
    return ink && !ink.conservative && ink.glyph && ink.box.w > 0 && ink.box.h > 0 ? ink.box : undefined;
  };
  const owned = show.slice(show.indexOf(content[0]!), show.indexOf(content.at(-1)!) + 1);
  if (owned.some(g => !selected.includes(g))) return;
  const at = owned.indexOf(next);
  const advance = (font.widthOf(code) + 1000 * state.tc / state.size) * factor;
  const reduction = advance / owned.length;
  const tracking = state.tc - reduction * state.size / (1000 * factor);
  if (tracking < 0) return;
  // Several words keep a reserve of the authored gap (tracking as painted,
  // after horizontal scaling) so each separator stays wide for readers that
  // infer spaces from gaps. One word has no separator to lose: no space in
  // its text, every owned glyph visible text whose outline the gap check
  // measures, and no owned gap wider than the tracking, as a TJ move would be.
  const authoredGap = 1000 * state.tc / state.size * factor;
  const separated = owned.some((g, i) => i > 0 && point(g).x - point(owned[i - 1]!).x -
    font.widthOf(owned[i - 1]!.code) * factor > authoredGap + .01 * em);
  if (reduction > Math.min(.08 * em, .4 * authoredGap) && (separated ||
      /\s/u.test(originalText.trim()) || owned.some(g => !/^\S$/u.test(label(g))))) return;
  const fitted: PositionedCode[] = owned.flatMap((g, i) => {
    const p = { x: point(g).x - i * reduction + (i >= at ? advance - reduction : 0), code: g.code, source: g };
    return i === at ? [{ x: point(g).x - at * reduction, code }, p] : [p];
  });
  const ink: { box: PdfRect; position: PositionedCode }[] = [];
  for (const position of fitted) {
    if (position.source && !compact(label(position.source))) continue;
    const hull = outline(position.code);
    if (!hull) return;
    const box = { ...hull, x: position.x + hull.x, y: baseline + hull.y };
    const prevInk = ink.at(-1);
    if (prevInk && prevInk.box.x + prevInk.box.w + .015 * em > box.x) return;
    ink.push({ box, position });
  }
  const destination = ink.filter(({ position }) => !position.source ||
    Math.abs(position.x - point(position.source).x) > 1e-6).map(({ box }) => box);
  const crop = page.getCropBox(), frame = { x: crop.x, y: crop.y, w: crop.width, h: crop.height };
  if (destination.some(r => !contains(frame, r) || r.y < cover.y - .8 || r.y + r.h > cover.y + cover.h + .8 ||
      otherCovers.some(b => intersects(r, b)))) return;
  const refusePaint = () => ({ outcome: {
    overlayId: overlay.id, mode: 'unsupported', reason: 'unsupported-artwork-contact',
    detail: 'Nearby artwork could not be preserved by the tracked correction',
  } as const });
  let blocked = false, needsRaster = false;
  reflowScene(page, ops, frame, (box, kind, index) => {
    if (destination.every(r => !intersects(r, box))) return;
    if (index < first.opIndex) {
      if (kind === 'backdrop') return;
      if (kind === 'image' || kind === 'form') {
        const image = backgroundRaster(page, ops[index]!);
        if (image) {
          needsRaster = true;
          return;
        }
      }
    }
    blocked = true;
  }, .15);
  if (blocked || needsRaster && !render) return refusePaint();
  const externalInk = retypesetInk(page, fonts, ops);
  const states = new Map<string, Parameters<typeof externalInk>[2]>();
  walkTextPlacements(ops, { ...callbacks, onShow: s => states.set(`${s.opIndex}:${s.arrayItemIndex}`, s) });
  // Every glyph the correction does not own keeps its origin, and its
  // paint must be clear of the moved ink. Each is bounded by its outline or
  // declared FontBBox under its full matrix, so a far glyph cannot veto the
  // fit; a glyph whose paint has no such bound refuses it. A zero-area
  // measurement grants nothing unless the glyph is proved to paint nothing:
  // invisible text, a program proof of an empty path, or a space whose
  // program draws no path. An empty path read from any other glyph may be
  // one the parser dropped.
  const paintedInk = retypesetPaintedInk(page, fonts), unitInk = streamInkResolver(page, fonts);
  const unit = [1, 0, 0, 1, 0, 0];
  const paintsNothing = (g: GlyphPlacement, s: ShowTextState) => {
    if (s.renderMode === 3) return true;
    const ink = unitInk(g.fontName, g.code, { bt: 0, opIndex: s.opIndex, ctm: unit, tm: unit, tlm: unit,
      fontObject: byName.get(g.fontName)!.objectId, size: 1, tc: 0, tw: 0, tz: 100, leading: 0, rise: 0,
      renderMode: 0, safetyHash: 'approximate', scopeSafe: true });
    return !!ink && (ink.provedEmpty === true ||
      !ink.conservative && ink.box.w === 0 && ink.box.h === 0 && /^\s+$/u.test(label(g)));
  };
  const ownedGlyphs = new Set(owned);
  for (const g of before.glyphs) {
    if (ownedGlyphs.has(g)) continue;
    const s = states.get(`${g.opIndex}:${g.arrayItemIndex}`)!;
    const glyphFont = byName.get(g.fontName)!, { x, y } = point(g);
    let ink = externalInk(glyphFont, g.code, s, x, y);
    if (!ink.known) ink = paintedInk(glyphFont, g.code, s, x, y) ?? ink;
    if (!ink.known) return;
    if (!(ink.box.w > 0 && ink.box.h > 0)) {
      if (paintsNothing(g, s)) continue;
      return;
    }
    if (destination.some(r => intersects(r, ink.box))) return;
  }

  const placed = (g: GlyphPlacement) => ({ x: point(g).x, code: g.code, source: g });
  const start = show.indexOf(owned[0]!), end = show.indexOf(owned.at(-1)!);
  const replacement = [...show.slice(0, start).map(placed), ...fitted, ...show.slice(end + 1).map(placed)];
  const suffix = show[end + 1];
  const anchor = suffix?.arrayItemIndex !== -1 && suffix?.byteOffset === 0
    ? trace.shows.get(`${first.opIndex}:${suffix.arrayItemIndex}`)?.before : undefined;
  const endState = trace.ends.get(first.opIndex);
  const rejoin = anchor && endState ? { anchor: anchor.tm, line: endState.tlm,
    adjustment: (origin({ ...endState, tm: endState.tlm })[0] - origin(endState)[0]) / factor } : undefined;
  const output = patchShow(bytes, op, owned[0]!, owned.at(-1)!, next, code, tracking, state.tc, reduction / factor, rejoin);
  const after = walkTextPlacements(tokenizeContentStream(output), callbacks);
  if (!after.ok || after.unplacedText || after.glyphs.length !== before.glyphs.length + 1) return;
  const expected = before.glyphs.flatMap(g => g === show[0]
    ? replacement.map(p => ({ ...p, y: point(g).y, name: g.fontName }))
    : g.opIndex === first.opIndex ? [] : [{ ...placed(g), y: point(g).y, name: g.fontName }]);
  if (after.glyphs.some((g, i) => {
    const p = expected[i]!;
    return g.fontName !== p.name || g.code !== p.code ||
      Math.abs(point(g).x - p.x) > .001 || Math.abs(point(g).y - p.y) > .001;
  })) return;
  if (needsRaster) {
    const hidden = removeIdentifiedGlyphs(bytes, ops, show, undefined, pdfNumber);
    if (!hidden.changed || !await verifyFittedBackdrop(page, frame, destination, bytes, output, hidden.bytes, render!)) return refusePaint();
  }
  return result(output);
}
