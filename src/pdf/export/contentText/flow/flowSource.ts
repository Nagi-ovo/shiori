// Reads one page for a linked-frame flow edit and qualifies it before any
// layout: frame geometry, glyph ownership, text orientation and visibility,
// and source freshness. The dry run and the export both start here.
import {PDFDict,PDFName,PDFRawStream,type PDFPage} from 'pdf-lib';
import type {ContentTextOverlay,PdfRect,TextFlowChain} from '../../../model/types';
import {inspectRunPage,resolveRunFonts,runPageEnvironment} from '../../contentStreamEdit/replaceRunPage';
import {tokenizeContentStream,type ContentOp} from '../../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../../contentStreamEdit/walkTextPlacements';
import type {GlyphPlacement,ShowTextState,UnplacedShow} from '../../contentStreamEdit/textStateTypes';
import type {ResolvedRunFont} from '../../contentStreamEdit/replaceRun';
import type {FlowRefusal} from './flowTypes';
import {numericArray} from '../reflowScene';
import {boundFlowUnplaced,type FlowUnplacedInk} from './flowUnplacedInk';

export const showOperators = new Set(['Tj', 'TJ', "'", '"']);
const lineOperators = new Set(['Td', 'TD', 'Tm', 'T*', "'", '"']);
export type FillState = { colorSpace: string | null; color: string | null; clipped: boolean };
export type OwnedShow = { opIndex: number; state: ShowTextState; fill: FillState; glyphs: GlyphPlacement[]; font: ResolvedRunFont };
export type FlowSource = { bytes: Uint8Array; ops: ContentOp[]; fonts: ResolvedRunFont[]; glyphs: GlyphPlacement[];
  frames: [OwnedShow[], OwnedShow[]]; ownedOps: Set<number>; ctm: readonly number[]; unplacedInk: FlowUnplacedInk[];
  /** Text state at the first string of every show, owned or not. */
  shows: ReadonlyMap<number, ShowTextState> };

const area = (a: PdfRect, b: PdfRect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const contains = (r: PdfRect, p: { x: number; y: number }, tol = .01) => p.x >= r.x - tol && p.x <= r.x + r.w + tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol;
// eslint-disable-next-line no-control-regex -- control characters are extraction noise, never story text
export const stripText = (s: string) => s.normalize('NFC').replace(/[\s\u0000-\u001f\ufffe\uffff]/g, '');
const refuse = (reason: FlowRefusal['reason'], detail?: string, blockingRect?: PdfRect): FlowRefusal => ({ ok: false, reason, ...(detail ? { detail } : {}), ...(blockingRect ? { blockingRect } : {}) });

/** Frame geometry alone: two distinct frames on one page, in one column, the
 * second strictly below the first, the edit on the first. */
export function qualifyChainGeometry(chain: TextFlowChain, overlay: ContentTextOverlay): FlowRefusal | null {
  const frames = chain.frames;
  if (frames.length !== 2) return refuse('flow-ambiguous-frame', 'stage 1 links exactly two frames');
  const [a, b] = frames as [typeof frames[0], typeof frames[0]];
  if (a.id === b.id) return refuse('flow-ambiguous-frame', 'a frame repeats');
  if (a.pageId !== b.pageId) return refuse('flow-cross-page-unsupported');
  if (overlay.pageId !== a.pageId || !overlay.coverRects.some(r => area(r, a.rect) > 0)) return refuse('flow-ambiguous-frame', 'the edit is not on the first frame');
  if (area(a.rect, b.rect) > 0) return refuse('flow-ambiguous-frame', 'frames overlap', b.rect);
  const xOverlap = Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w) - Math.max(a.rect.x, b.rect.x);
  if (xOverlap < .5 * Math.min(a.rect.w, b.rect.w)) return refuse('flow-ambiguous-frame', 'frames are not in one column');
  if (b.rect.y + b.rect.h > a.rect.y + .5) return refuse('flow-ambiguous-frame', 'the second frame is not below the first');
  return null;
}

/** Fill colour and clip in effect at every op, from the page's initial state. */
function fillStates(ops: readonly ContentOp[], bytes: Uint8Array): FillState[] {
  const text = (op: ContentOp) => new TextDecoder('latin1').decode(bytes.subarray(op.start, op.end));
  const stack: FillState[] = [];
  let s: FillState = { colorSpace: null, color: null, clipped: false };
  return ops.map(op => {
    switch (op.operator) {
      case 'q': stack.push(s); break;
      case 'Q': s = stack.pop() ?? { ...s, clipped: true }; break;
      case 'cs': s = { ...s, colorSpace: text(op), color: null }; break;
      case 'g': case 'rg': case 'k': s = { ...s, colorSpace: null, color: text(op) }; break;
      case 'sc': case 'scn': s = { ...s, color: text(op) }; break;
      case 'W': case 'W*': s = { ...s, clipped: true }; break;
    }
    return s;
  });
}

export function readFlowSource(page: PDFPage, chain: TextFlowChain, overlay: ContentTextOverlay): FlowSource | FlowRefusal {
  const geometry = qualifyChainGeometry(chain, overlay);
  if (geometry) return geometry;
  const rects = chain.frames.map(f => f.rect) as [PdfRect, PdfRect];
  const source = inspectRunPage(page);
  if (!source.ok) return refuse('flow-unsupported-text', source.reason);
  let ops: ContentOp[];
  try { ops = tokenizeContentStream(source.bytes); } catch (error) { return refuse('flow-unsupported-text', String(error)); }
  const fonts = resolveRunFonts(page), environment = runPageEnvironment(page);
  const shows = new Map<number, ShowTextState>(), unplaced: UnplacedShow[] = [];
  // Stroked text is kept: it paints, so it can be an obstacle; in a frame it refuses.
  const walk = walkTextPlacements(ops, { includeStroked: true,
    resolveFont: name => { const f = fonts.find(f => f.resourceName === name); return f ? { ...f, ok: true, appliesWordSpacing: f.bytesPerCode === 1 } : { ok: false, reason: 'unsupported font' }; },
    extGStateSetsFont: name => environment.extGStates?.get(name)?.setsFont ?? null,
    onShow: state => { const prior = shows.get(state.opIndex); if (!prior || state.arrayItemIndex < prior.arrayItemIndex) shows.set(state.opIndex, state); },
    onUnplaced: u => unplaced.push(u),
  });
  if (!walk.ok) return refuse('flow-unsupported-text', walk.reason);
  const unplacedInk = boundFlowUnplaced(page, ops, unplaced);
  if (!unplacedInk) return refuse('flow-unsupported-text', 'unplaced text has no ink or position proof');
  if (unplaced.some(s => s.origin && rects.some(r => contains(r, s.origin!)))) return refuse('flow-unsupported-text', 'unplaced text inside a frame');
  const fill = fillStates(ops, source.bytes);
  // Orientation first: a rotated or vertical show touching a frame is
  // unsupported text, even when it also runs out of the frame.
  for (const g of walk.glyphs) {
    if (!rects.some(r => contains(r, g.coreQuad[0]))) continue;
    const tm = shows.get(g.opIndex)?.textMatrix ?? [], m = shows.get(g.opIndex)?.ctm ?? [];
    const upright = Math.abs(tm[1] ?? 1) < 1e-9 && Math.abs(tm[2] ?? 1) < 1e-9 && tm[0]! > 0 && tm[3]! > 0
      && Math.abs(m[1] ?? 1) < 1e-9 && Math.abs(m[2] ?? 1) < 1e-9 && m[0]! > 0 && m[3]! > 0;
    if (!upright || Math.abs(g.coreQuad[1].y - g.coreQuad[0].y) > 1e-6) return refuse('flow-unsupported-text', 'rotated, mirrored or vertical text in a frame');
  }
  const owner = new Map<number, number>();
  for (const g of walk.glyphs) {
    const k = rects.findIndex(r => contains(r, g.coreQuad[0]));
    const prior = owner.get(g.opIndex);
    if (prior !== undefined && prior !== k) return refuse('flow-ambiguous-frame', 'one show spans a frame edge');
    owner.set(g.opIndex, k);
  }
  const frames: [OwnedShow[], OwnedShow[]] = [[], []];
  for (const [opIndex, k] of [...owner].sort((a, b) => a[0] - b[0])) {
    if (k < 0) continue;
    const state = shows.get(opIndex), font = fonts.find(f => f.resourceName === state?.fontName);
    if (!state || !font) return refuse('flow-unsupported-text', 'unresolved show state');
    frames[k]!.push({ opIndex, state, fill: fill[opIndex]!, glyphs: walk.glyphs.filter(g => g.opIndex === opIndex), font });
  }
  for (const [k, owned] of frames.entries()) if (!owned.length) {
    const forms = walk.xobjects.some(x => { const b = formBounds(page, x.name, x.ctm); return !!b && area(b, rects[k]!) > 0; });
    return refuse(forms ? 'flow-unsupported-text' : 'flow-ambiguous-frame', forms ? 'frame text lives inside a form XObject' : `frame ${k + 1} holds no source text`, rects[k]);
  }
  const all = frames.flat(), ctm = all[0]!.state.ctm ?? [1, 0, 0, 1, 0, 0];
  for (const s of all) {
    const tm = s.state.textMatrix ?? [], m = s.state.ctm ?? [];
    if (s.state.renderMode !== undefined && s.state.renderMode !== 0) return refuse('flow-unsupported-text', 'invisible or stroked text');
    if (s.fill.clipped) return refuse('flow-unsupported-text', 'clipped text');
    if ((s.state.rise ?? 0) !== 0) return refuse('flow-unsupported-text', 'text rise');
    if (Math.abs(tm[1]!) > 1e-9 || Math.abs(tm[2]!) > 1e-9 || !(tm[0]! > 0) || !(tm[3]! > 0)) return refuse('flow-unsupported-text', 'rotated or mirrored text');
    if (m.some((v, i) => Math.abs(v - ctm[i]!) > 1e-9) || Math.abs(m[1]!) > 1e-9 || Math.abs(m[2]!) > 1e-9 || !(m[0]! > 0) || !(m[3]! > 0)) return refuse('flow-unsupported-text', 'frames use different or rotated coordinate systems');
    if (s.glyphs.some(g => Math.abs(g.coreQuad[1].y - g.coreQuad[0].y) > 1e-6)) return refuse('flow-unsupported-text', 'vertical text');
  }
  // The story is rewritten in one style, so the first frame must have one.
  const style = (o: OwnedShow) => JSON.stringify([o.font.objectId, o.state.fontSize, o.state.fontSizePt, o.state.charSpacing,
    o.state.wordSpacing, o.state.horizontalScale, o.state.textMatrix![0], o.state.textMatrix![3], o.fill.colorSpace, o.fill.color]);
  if (frames[0].some(o => style(o) !== style(frames[0][0]!))) return refuse('flow-unsupported-text', 'the first frame mixes fonts, sizes, spacing or colours');
  const ownedOps = new Set(all.map(s => s.opIndex));
  // Removing a show must not move a foreign show that continues its line.
  let pending = false;
  for (const [i, op] of ops.entries()) {
    if (op.operator === 'BT' || lineOperators.has(op.operator)) pending = false;
    if (ownedOps.has(i)) { pending = true; continue; }
    if (pending && showOperators.has(op.operator)) return refuse('flow-unsupported-text', 'foreign text continues a frame line');
  }
  const sourceText = frames[0].flatMap(s => s.glyphs.map(g => s.font.unicodeByCode.get(g.code) ?? '�')).join('');
  if (stripText(sourceText) !== stripText(overlay.originalText)) return refuse('stale-source', 'the first frame no longer holds the edited text');
  return { bytes: source.bytes, ops, fonts, glyphs: walk.glyphs, frames, ownedOps, ctm, shows, unplacedInk };
}

/** Page-space bounds of a form XObject invocation (BBox through Matrix and
 * CTM); null for an image. An unreadable BBox bounds the whole page. */
function formBounds(page: PDFPage, name: string, ctm: readonly number[]): PdfRect | null {
  const x = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.lookup(PDFName.of(name));
  if (!(x instanceof PDFRawStream) || x.dict.lookup(PDFName.of('Subtype'))?.toString() !== '/Form') return null;
  const media = page.getMediaBox(), whole = { x: media.x, y: media.y, w: media.width, h: media.height };
  const b = numericArray(x.dict, 'BBox'), m = numericArray(x.dict, 'Matrix') ?? [1, 0, 0, 1, 0, 0];
  if (b?.length !== 4 || m.length !== 6 || ![...b, ...m].every(Number.isFinite)) return whole;
  const t = [m[0]! * ctm[0]! + m[1]! * ctm[2]!, m[0]! * ctm[1]! + m[1]! * ctm[3]!, m[2]! * ctm[0]! + m[3]! * ctm[2]!, m[2]! * ctm[1]! + m[3]! * ctm[3]!,
    m[4]! * ctm[0]! + m[5]! * ctm[2]! + ctm[4]!, m[4]! * ctm[1]! + m[5]! * ctm[3]! + ctm[5]!];
  const ps = [[b[0]!, b[1]!], [b[2]!, b[1]!], [b[2]!, b[3]!], [b[0]!, b[3]!]].map(([u, v]) => [t[0]! * u! + t[2]! * v! + t[4]!, t[1]! * u! + t[3]! * v! + t[5]!]);
  const xs = ps.map(p => p[0]!), ys = ps.map(p => p[1]!);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
