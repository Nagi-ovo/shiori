import { PDFArray, PDFName, type PDFPage } from 'pdf-lib';
import type { ContentTextOverlay, PdfRect } from '../../model/types';
import { effectivePdfPageBox } from '../../model/pageBoxes';
import { runPageEnvironment } from '../contentStreamEdit/replaceRunPage';
import { runContextSafety } from '../contentStreamEdit/replaceRun';
import { pdfNumber } from '../contentStreamEdit/runEncoding';
import type { Type1Options } from '../fontCoverage/type1Support';
import type { ContentTextOutcome } from '../contentText/outcomes';
import { columnInk } from '../contentText/uprightColumnInk';
import { contains, intersects } from '../contentText/regionProof/geometry';
import { reflowScene } from '../contentText/reflowScene';
import { retypesetScopes } from '../contentText/retypesetScopes';
import { address, readRetypesetSource, retypesetAdvance } from '../contentText/retypesetSource';
import type { RetypesetGlyph } from '../contentText/retypesetTypes';
import { annotationAnchorRefusal, type AnchoredAnnotation, type AnnotationAnchorRefusal } from '../sourceAnnotationAnchors';
import { inReadingOrder } from './editIntent';
import { createSemanticInspector } from './inspection';
import { operatorBytes, verifySpanMove, type InstalledPermutation, type SpanPermutation } from './spanPermutation';

const contents = PDFName.of('Contents');
const near = (a: number, b: number) => Math.abs(a - b) < .001;

function destinations(groups: RetypesetGlyph[][], order: number[]) {
  const starts = groups.map(glyphs => glyphs[0]!);
  if (groups.every(group => group.length === 1) &&
      starts.every((glyph, i) => near(glyph.x, starts[0]!.x) && (!i || glyph.y < starts[i - 1]!.y))) {
    return order.map((index, slot) => ({ dx: 0, dy: starts[slot]!.y - starts[index]!.y }));
  }
  const glyphs = groups.flat();
  if (glyphs.some((glyph, i, all) => !near(glyph.y, starts[0]!.y) || (i && glyph.x <= all[i - 1]!.x))) return;
  const widths = groups.map(group => {
    const end = group.at(-1)!;
    return end.x - group[0]!.x + retypesetAdvance(end, (x, y) => ({ x, y }));
  });
  const gaps = starts.slice(1).map((glyph, i) => glyph.x - starts[i]!.x - widths[i]!);
  // Exterior word gaps can be synthetic spaces. Reordering must keep one
  // continuous run and must preserve the interval's total advance.
  if (widths.some(w => !Number.isFinite(w) || w <= 0) ||
      gaps.some((gap, i) => !Number.isFinite(gap) || Math.abs(gap) > starts[i]!.state.fontSize * .12)) return;
  let x = starts[0]!.x;
  return order.map((index, slot) => {
    const dx = x - starts[index]!.x;
    x += widths[index]! + (gaps[slot] ?? 0);
    return { dx, dy: 0 };
  });
}

const moveBox = (box: PdfRect, dx: number, dy: number) => ({ ...box, x: box.x + dx, y: box.y + dy });
const painted = (b: PdfRect) => b.w > 0 && b.h > 0;
const byteArray = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));

/** Move the complete, self-contained text objects. Only their Tm origins
 * change. The decoded prefix, suffix, resources and other stream parts
 * are carried forward from the current page without modification. */
export function writeSpanPermutation(
  page: PDFPage, edit: ContentTextOverlay, plan: SpanPermutation, type1: Type1Options | undefined,
  anchors: readonly AnchoredAnnotation[],
): { permutation: InstalledPermutation; outcome: ContentTextOutcome } | AnnotationAnchorRefusal | undefined {
  const before = createSemanticInspector(page.doc).inspectPage(page.doc.getPages().findIndex(candidate => candidate.ref === page.ref));
  const root = before?.occurrences[0];
  if (!root?.bytes || !root.parts.length) return;
  const { bytes, ops } = root;
  const current = plan.source.map(span => root.spans.find(s => s.mcid === span.mcid && !s.issues.length));
  if (current.some((span, i) => !span || (i > 0 && current[i - 1]!.endOp! + 1 !== span.beginOp))) return;
  const original = current.map((span, i) => {
    const from = plan.source[i]!;
    return { span: from, dx: 0, dy: 0, operators: from.occurrence.ops.slice(from.beginOp, from.endOp! + 1)
      .map(op => operatorBytes(from.occurrence.bytes!, op)), current: span! };
  });
  if (original.some(move => !verifySpanMove(move, move.current))) return;
  const part = current[0]!.part;
  if (!part || current.some(span => span!.part !== part) ||
      part.dict.keys().some(key => !['Length', 'Filter', 'DecodeParms'].includes(key.decodeText()))) return;

  const firstOp = current[0]!.beginOp, lastOp = current.at(-1)!.endOp!;
  const start = ops[firstOp]!.start, end = ops[lastOp]!.end;
  const partIndex = root.parts.indexOf(part), partStart = root.partStarts[partIndex]!;
  const partEnd = root.partStarts[partIndex + 1] === undefined ? bytes.length : root.partStarts[partIndex + 1]! - 1;
  if (end > partEnd) return;
  // The allowed bodies cannot carry pending path or text state between
  // items. A path or text object already open at the entry
  // would defeat the q/Q isolation.
  const scopes = retypesetScopes(ops);
  if (scopes.get(firstOp)?.start !== firstOp || ops.slice(0, firstOp).findLast(op => op.operator === 'BT' || op.operator === 'ET')?.operator === 'BT') return;
  const unclipped = ops.map((op, i) =>
    i > firstOp && i < lastOp && ['W', 'W*'].includes(op.operator) ? { ...op, operator: 'n', operands: [] } : op);
  const safety = runContextSafety(unclipped, runPageEnvironment(page));
  if (!safety.ok || current.some(span => span!.glyphs.some(g => safety.unsafe.has(g.placement.opIndex)))) return;

  const source = readRetypesetSource(page, ops, type1);
  if (!source.walk.ok || source.walk.unplacedText) return;
  const byAddress = new Map(source.glyphs.map(g => [address(g.glyph), g]));
  const groups = current.map(span => inReadingOrder(span!.glyphs).map(g => byAddress.get(address(g.placement))));
  if (groups.some(group => group.some(glyph => !glyph || glyph.state.renderMode !== 0))) return;
  const positioned = groups as RetypesetGlyph[][];
  const order = plan.order.map(span => plan.source.indexOf(span));
  const translation = destinations(positioned, order);
  if (!translation) return;

  const ink = columnInk(page, source.fonts, ops);
  const measure = (glyph: RetypesetGlyph) => ink(source.fonts.find(f => f.resourceName === glyph.glyph.fontName)!,
    glyph.glyph.code, glyph.state, glyph.x, glyph.y);
  const crop = effectivePdfPageBox(page.getMediaBox(), page.getCropBox());
  const pageBox = { x: crop.x, y: crop.y, w: crop.width, h: crop.height };
  const fixed = source.glyphs.filter(g => g.glyph.opIndex < firstOp || g.glyph.opIndex > lastOp).map(measure);
  const paint: PdfRect[] = [];
  reflowScene(page, ops, pageBox, (box, kind) => { if (kind !== 'backdrop') paint.push(box); }, .02);
  const moved: PdfRect[][] = [];
  const movedGlyphBoxes: PdfRect[] = [];
  const output = [];
  for (const [slot, index] of order.entries()) {
    const move = original[index]!, glyphs = positioned[index]!;
    const { dx, dy } = translation[slot]!;
    const boxes: PdfRect[] = [];
    for (const glyph of glyphs) {
      const measured = measure(glyph), box = moveBox(measured.box, dx, dy);
      const clip = scopes.get(glyph.glyph.opIndex)?.clip;
      if (!measured.known || clip === null || !contains(pageBox, box) ||
          !edit.coverRects.some(r => contains(r, measured.box)) || !edit.coverRects.some(r => contains(r, box)) ||
          (clip && (!contains(clip, measured.box) || !contains(clip, box)))) return;
      if (painted(box) && (paint.some(b => intersects(b, box)) ||
          fixed.some(b => painted(b.box) && intersects(b.box, box)) ||
          moved.some(group => group.some(b => painted(b) && intersects(b, box))))) return;
      if (anchors.length && (dx || dy)) movedGlyphBoxes.push(measured.box, box);
      boxes.push(box);
    }
    moved.push(boxes);
    const localOps = ops.slice(move.current.beginOp, move.current.endOp! + 1);
    const matrixIndex = localOps.findIndex(op => op.operator === 'Tm');
    const matrix = localOps[matrixIndex]!.operands.map(o => o.kind === 'number' ? o.value : NaN);
    const [a, b, c, d] = glyphs[0]!.state.ctm!;
    const det = a! * d! - b! * c!;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-10) return;
    matrix[4]! += (d! * dx - c! * dy) / det;
    matrix[5]! += (a! * dy - b! * dx) / det;
    const operators = [...move.operators];
    if (dx || dy) operators[matrixIndex] = matrix.map(pdfNumber).join(' ') + ' Tm';
    output.push({ span: move.span, operators, dx, dy });
  }

  const paragraphBox = edit.coverRects.reduce((a, b) => {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  });
  const anchor = annotationAnchorRefusal(anchors, [paragraphBox, ...movedGlyphBoxes]);
  if (anchor) return anchor;

  const body = byteArray(output.map(move => move.operators.join('\n')).join('\n'));
  const swapped = new Uint8Array(start - partStart + body.length + partEnd - end);
  swapped.set(bytes.subarray(partStart, start));
  swapped.set(body, start - partStart);
  swapped.set(bytes.subarray(end, partEnd), start - partStart + body.length);
  const ctx = page.doc.context;
  const raw = page.node.get(contents), ref = ctx.register(ctx.flateStream(swapped));
  const lookup = ctx.lookup(raw);
  if (lookup instanceof PDFArray) {
    const parts = lookup.clone();
    parts.set(partIndex, ref);
    page.node.set(contents, parts);
  } else page.node.set(contents, ref);
  return { permutation: { source: plan.source, output }, outcome: {
    overlayId: edit.id, mode: 'retypeset', fidelity: 'approximate', retypeset: {
      reason: 'reflow-required', paragraphBox, substituteFont: null, lineCount: edit.text.split('\n').length,
      overflowed: false, pushed: false, unchangedLineDriftPt: 0, pushedDeltaPt: 0, pushedRegions: [],
      overflowInkOverlap: false,
      quality: { maxUnchangedLineStartXDriftPt: 0, maxUnchangedLineBaselineDriftPt: 0, overflowInkOverlap: false },
    },
  } };
}
