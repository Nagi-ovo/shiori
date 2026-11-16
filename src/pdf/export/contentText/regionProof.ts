import { compatible, paragraphMember, anchorForShow, lineAnchors, contains, EPS, intersects, matrixEqual, near, origin,
  physicalLeading, physicalSize, validRect, validPositionAnchor, positionAnchorMember, paragraphFrame,lineStart } from './regionProof/geometry';
import { proveOperators } from './regionProof/operators';
import type { LineSlot, ParagraphBlocker, ParagraphIndent, ParagraphInput,
  ParagraphRefusal, ParagraphResult, TextTrace } from './regionProof/types';
export type * from './regionProof/types';

/** Integration gate only. No production planner imports or enables these. */
export const stage5Reflow = Object.freeze({
  paragraphDetection: false, spacingOnly: false, boundedReflow: false,
});
const refuse = (blocker: ParagraphBlocker, detail: string): ParagraphRefusal => ({
  ok: false, code: 'reflow-paragraph-unproven', family: 'reflow-required',
  reason: 'No proven paragraph box for wrapping', blocker, detail,
});
// Deliberately excludes RTL scripts AND directional formatting controls.
const unsupportedDirection = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\u200e\u200f\u202a-\u202e\u2066-\u2069\u{10800}-\u{10fff}\u{1e800}-\u{1eeff}]/u;

/** Pure R6 proof. Input is complete operator/numeric evidence from R1/R2,
 * never PDFium visual-line strings or DOM boxes. No wrapping or mutation.
 * A caller must revalidate all hashes before consuming an exported proof.
 */
export function detectParagraphRegion(input: ParagraphInput, beforeFirst?: TextTrace): ParagraphResult {
  const { lines, evidence: e } = input;
  const nonempty = lines.filter(l => l.shows.some(s => s.unicode.trim().length > 0));
  if (nonempty.length < 3 || !lines[0]?.shows.length || !lines.at(-1)?.shows.length ||
    lines.some(l => l.shows.length > 0 && !l.shows.some(s => s.unicode.trim().length > 0))) {
    return refuse('lines', 'At least three nonempty source lines, with no exterior blank slots, are required');
  }
  if (!input.sourceHash || !input.dependencyHash || e.sourceHash !== input.sourceHash ||
    e.dependencyHash !== input.dependencyHash) return refuse('revision', 'Scene/source dependency revision mismatch');
  if (!e.boundaryProofHash || e.structure !== 'body-text' || e.columnBoundary !== 'proven' ||
    e.readingOrder !== 'proven' || e.whitespace !== 'source-codes') {
    return refuse('boundary', 'Body boundary, source order, column or whitespace provenance is unproven');
  }
  if (!e.scopeProofHash || !['plain', 'redistribution-proven'].includes(e.semantics) ||
    e.inlineFeatures !== 'plain-prose') {
    return refuse('semantics', 'Unresolved scope/reading order or inline math/superscript evidence');
  }
  const base = lines[0]!.anchor;
  const showBase=lines[0]!.shows[0]!.before;
  const perGlyph=!!input.occupancy,member=perGlyph?paragraphFrame:paragraphMember;
  if (!validPositionAnchor(base)) return refuse('state', 'Nonfinite or unsupported horizontal text state');
  for (const line of lines) {
    if (lineAnchors(line).some(t => !positionAnchorMember(t, base,perGlyph) || t.safetyHash !== e.scopeProofHash)) {
      return refuse('state', 'Line font, physical size, transform or text state differs');
    }
    let end = origin(line.anchor);
    let previousStart = -Infinity;
    for (const show of line.shows) {
      if (!show.unicode || /[\r\n\t\uFFFD]/u.test(show.unicode)) {
        return refuse('boundary', 'Unknown or control-text source decoding');
      }
      if (unsupportedDirection.test(show.unicode)) return refuse('direction', 'RTL/bidi is outside the paragraph subset');
      const anchor = anchorForShow(line, show.source.opIndex);
      if (!anchor || !member(show.before, showBase) || !positionAnchorMember(anchor,show.before,perGlyph) || !compatible(show.after, show.before) ||
        !matrixEqual(show.before.tlm, anchor.tlm) || !matrixEqual(show.after.tlm, anchor.tlm)) {
        return refuse('state', 'Show snapshots differ in font/style/state or saved Tlm');
      }
      const a = origin(show.before), b = origin(show.after);
      if ((!perGlyph&&(!near(a[1], end[1], 0.01) || !near(b[1], end[1], 0.01))) ||
        b[0] <= a[0] || a[0] <= previousStart) {
        return refuse('state', 'Nonmonotonic, overlapping or superscripted show origins');
      }
      end = b; previousStart = a[0];
    }
  }
  const operators = proveOperators(input, beforeFirst);
  if ('blocker' in operators) return refuse(operators.blocker, operators.detail);
  // Leading TJ displacement may encode an indent after a flush Tm. Capacity
  // begins at the actual first show, never the pre-kern anchor.
  const starts = lines.map(l => lineStart(l,perGlyph));
  const ends = operators.endpoints;
  const advances = starts.slice(1).map((p, i) => starts[i]![1] - p[1]);
  const explicit = physicalLeading(base);
  const leading = input.visualGroup?.pitchPt ?? (explicit > 0 ? explicit : advances[0]!);
  const leadingTolerance = Math.min(0.25, Math.max(0.10, leading * 0.01));
  if (!(leading > 0) || advances.some(a => !near(a, leading, leadingTolerance)) ||
    lines.some(l => {
      const values = [...lineAnchors(l), ...l.shows.flatMap(s => [s.before, s.after])].map(physicalLeading);
      return values.some(v => perGlyph && input.visualGroup ? v !== 0 && !near(v, leading, leadingTolerance) :
        explicit > 0 ? !near(v, leading, leadingTolerance) : v !== 0);
    })) return refuse('leading', 'Observed/explicit baseline advances are inconsistent; no blank row may be inferred');
  const em = physicalSize(base);
  const leftTolerance = Math.min(0.50, Math.max(0.25, 0.025 * em));
  const rightTolerance = Math.min(1.0, Math.max(0.50, 0.05 * em));
  const bodyLefts = starts.slice(1).map(p => p[0]);
  if (Math.max(...bodyLefts) - Math.min(...bodyLefts) > leftTolerance + EPS) {
    return refuse('edges', 'Body lines do not share one left origin');
  }
  const allLefts = starts.map(p => p[0]);
  const bodyLeft = Math.max(...bodyLefts), firstLeft = starts[0]![0];
  const flush = Math.max(...allLefts) - Math.min(...allLefts) <= leftTolerance + EPS;
  const indent: ParagraphIndent = flush ? { kind: 'flush', amountPt: 0 } : {
    kind: firstLeft > bodyLeft ? 'first-line' : 'hanging', amountPt: Math.abs(firstLeft - bodyLeft),
  };
  if (!flush && indent.amountPt <= leftTolerance + EPS) return refuse('edges', 'Ambiguous first/body left origin');
  if (!flush) {
    const multiple = ([1, 2] as const).find(n => near(indent.amountPt, n * em, Math.min(0.5, 0.05 * em)));
    if (multiple) indent.emMultiple = multiple;
  }
  const nonfinalEnds = lines.flatMap((l, i) => l.shows.length && i < lines.length - 1 ? [ends[i]!] : []);
  if (!input.visualGroup&&(nonfinalEnds.length < 2 || Math.max(...nonfinalEnds) - Math.min(...nonfinalEnds) > rightTolerance + EPS)) {
    return refuse('edges', 'At least two nonfinal advances must share the right edge');
  }
  const right = input.visualGroup?.capacityRight ?? Math.min(...nonfinalEnds);
  if (ends.at(-1)! > right + rightTolerance + EPS) return refuse('edges', 'Final line exceeds the proven right edge');
  const flushLeft = Math.max(...allLefts);
  const group=input.visualGroup;
  const slots: LineSlot[] = starts.map((p, i) => ({ baseline: p[1],
    left: group ? (lines[i]===group.lines[0]?group.firstLeft:group.left) : flush ? flushLeft : i === 0 ? firstLeft : bodyLeft, right,
    kind: lines[i]!.shows.length ? 'observed' : 'explicit-blank' }));
  if (slots.some(s => s.left >= s.right)) return refuse('edges', 'Empty or inverted line capacity');
  const guard = input.rasterGuardPt ?? 0.5;
  if (!Number.isFinite(guard) || guard < 0 || guard > 0.5 || !validRect(e.crop) || !validRect(e.clip) ||
    lines.some(l => l.shows.length ? !l.ink || !validRect(l.ink) : l.ink !== null)) {
    return refuse('bounds', 'Missing conservative ink or invalid crop/clip/raster guard');
  }
  const inks = nonempty.map(l => l.ink!);
  // Overall box includes original origins/ink, but no slot borrows that left.
  const left = Math.min(...allLefts, ...inks.map(r => r.x));
  const bottom = Math.min(...inks.map(r => r.y)) - guard;
  const top = Math.max(...inks.map(r => r.y + r.h)) + guard;
  const box = { x: left, y: bottom, w: right - left, h: top - bottom };
  if ((!perGlyph&&(!contains(e.crop, box) || !contains(e.clip, box))) ||
    inks.some(r => r.x + r.w > right + EPS || !contains(box, r)) ||
    inks.slice(1).some((r, i) => r.y + r.h > inks[i]!.y + EPS)) {
    return refuse('bounds', 'Original ink overlaps a row or exceeds the matched box/crop/clip');
  }
  if (!e.completeScene || !e.obstacleProofHash || input.occupancy?.pageBlocked || !perGlyph&&e.obstacles.some(o => {
    if (!o.box || !validRect(o.box)) return true;
    if (!intersects(box, o.box)) return false;
    return o.kind !== 'stationary-backdrop' || !o.proofHash || !contains(o.box, box);
  })) return refuse('obstacles', 'Incomplete scene or intersecting unowned text, annotation or paint');
  return { ok: true, proof: {
    sourceHash: input.sourceHash, dependencyHash: input.dependencyHash, bt: base.bt,
    kind: 'paragraph', box, indent:group?.indent??indent, leadingPt: leading, lineSlots: slots,
    owned: lines.flatMap(l => l.shows.map(s => ({ ...s.source }))),
    tjBoundaries: operators.boundaries, obstacleProofHash: e.obstacleProofHash,
    boundaryProofHash: e.boundaryProofHash, scopeProofHash: e.scopeProofHash,
  } };
}
