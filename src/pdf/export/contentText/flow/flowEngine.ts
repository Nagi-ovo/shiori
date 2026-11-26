// Plans and writes one linked-frame flow edit on one page. planFlowOnPage is
// the single path for the dry run and the export: it returns the rewritten
// content stream and the moves, or a refusal; it never installs anything.
import type {PDFPage} from 'pdf-lib';
import {effectivePdfPageBox} from '../../../model/pageBoxes';
import type {ContentTextOverlay,PdfRect,TextFlowChain} from '../../../model/types';
import {codes as splitCodes,encodeRun} from '../../contentStreamEdit/runEncoding';
import {tokenizeContentStream} from '../../contentStreamEdit/tokenizer';
import {reflowScene} from '../reflowScene';
import {retypesetInk} from '../retypesetInk';
import {breakLines,frameBaselines,placeFlow} from './flowLayout';
import {movedShow,removal,slotOp,splice,storyBlock,type SpliceEdit} from './flowEmit';
import {readFlowSource,type OwnedShow} from './flowSource';
import type {FlowManifest,FlowMove,FlowRefusal} from './flowTypes';
import {verifyFlowOutput,type FlowDestination} from './flowVerify';
import type {FlowFootprint} from '../../semantic/editIntent';
import {annotationAnchorRefusal,readSourceAnnotationAnchors,type AnchoredAnnotation} from '../../sourceAnnotationAnchors';

export type CheckFlowSemantics = (footprint: FlowFootprint) => FlowRefusal | undefined;

export type FlowPagePlan = { ok: true; bytes: Uint8Array; moves: FlowMove[]; manifest: FlowManifest } | FlowRefusal;
const clip = (r: PdfRect, f: PdfRect): PdfRect => { if (!r.w && !r.h) return { x: f.x, y: f.y, w: 0, h: 0 }; const x = Math.max(r.x, f.x), y = Math.max(r.y, f.y); return { x, y, w: Math.max(0, Math.min(r.x + r.w, f.x + f.w) - x), h: Math.max(0, Math.min(r.y + r.h, f.y + f.h) - y) }; };
// An empty set (an emptied frame writes no ink) bounds nothing: a zero rect at the origin is clipped away.
const union = (rs: readonly PdfRect[]): PdfRect => { if (!rs.length) return { x: 0, y: 0, w: 0, h: 0 }; const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y)); return { x, y, w: Math.max(...rs.map(r => r.x + r.w)) - x, h: Math.max(...rs.map(r => r.y + r.h)) - y }; };
const intersects = (a: PdfRect, b: PdfRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const shift = (r: PdfRect, dx: number, dy: number): PdfRect => ({ ...r, x: r.x + dx, y: r.y + dy });
const markedContent = new Set(['BMC', 'BDC', 'EMC', 'MP', 'DP']);
const unsupported = (detail: string): FlowRefusal => ({ ok: false, reason: 'flow-unsupported-text', detail });
const distinctBaselines = (shows: readonly OwnedShow[]) => [...new Set(shows.map(o => +o.state.origin.y.toFixed(4)))].sort((a, b) => b - a);

/** Codes for each character in the first frame's source font: a code the
 * chain already paints for that character, else the font's own coverage proof. */
function encoder(style: OwnedShow, owned: readonly OwnedShow[]) {
  const font = style.font, seen = new Map<string, Uint8Array>();
  for (const o of owned) if (o.font.objectId === font.objectId) for (const g of o.glyphs) {
    const u = o.font.unicodeByCode.get(g.code);
    if (u && [...u].length === 1 && !seen.has(u)) seen.set(u, font.bytesPerCode === 1 ? Uint8Array.of(g.code) : Uint8Array.of(g.code >> 8, g.code & 255));
  }
  const cache = new Map<string, Uint8Array | null>();
  return (ch: string): Uint8Array | null => {
    if (!cache.has(ch)) {
      let bytes = seen.get(ch) ?? null;
      if (!bytes) try { const r = encodeRun(ch, font, new Uint8Array()); bytes = r.ok ? r.bytes : null; } catch { bytes = null; }
      cache.set(ch, bytes);
    }
    return cache.get(ch)!;
  };
}

export function planFlowOnPage(page: PDFPage, chain: TextFlowChain, overlay: ContentTextOverlay, checkSemantics?: CheckFlowSemantics, anchors: readonly AnchoredAnnotation[] = readSourceAnnotationAnchors(page)): FlowPagePlan {
  const source = readFlowSource(page, chain, overlay);
  if (!('bytes' in source)) return source;
  const [f0, f1] = chain.frames as [typeof chain.frames[0], typeof chain.frames[0]];
  const [own0, own1] = source.frames;
  const style = own0[0]!, font = style.font, s = style.state, tm = s.textMatrix!, ctm = s.ctm!;
  const size = s.fontSizePt ?? s.fontSize, th = (s.horizontalScale ?? 1) * tm[0]! * ctm[0]!;
  const baselines0 = distinctBaselines(own0), leading = (s.leading ?? 0) * tm[3]! * ctm[3]!;
  const pitch = baselines0.length > 1 ? baselines0[0]! - baselines0[1]! : leading >= .95 * size ? leading : 1.2 * size;
  if (pitch < .95 * size) return unsupported('the first frame’s lines overlap');
  const ink = retypesetInk(page, source.fonts, source.ops);
  // Ink of one code at a pen position; unknown ink refuses rather than guesses.
  const inkOf = (o: OwnedShow, code: number, x: number, y: number) => { const r = ink(o.font, code, o.state, x, y); return r.known ? r.box : null; };

  const encode = encoder(style, [...own0, ...own1]);
  const chars = [...overlay.text.replace(/\s+/g, ' ').trim()];
  const coded = new Map<string, number[]>();
  for (const ch of new Set(chars)) { const b = encode(ch); if (!b) return unsupported(`"${ch}" is not encodable in the source font`); coded.set(ch, splitCodes(b, font.bytesPerCode)); }
  // Word spacing applies to the single-byte code 32 only, as the walker applies it.
  const tw = font.bytesPerCode === 1 ? s.wordSpacing * th : 0;
  const advance = (code: number) => font.widthOf(code) / 1000 * s.fontSize * th + s.charSpacing * th + (code === 32 ? tw : 0);
  const measure = (t: string) => [...t].reduce((w, ch) => w + coded.get(ch)!.reduce((n, c) => n + advance(c), 0), 0);
  // Real outline extents of the story's glyphs, relative to the baseline.
  let descent0 = 0, ascent0 = 0;
  for (const c of new Set([...coded.values()].flat())) { const b = inkOf(style, c, 0, 0); if (!b) return unsupported('a story glyph has no ink proof'); if (b.w > 0 || b.h > 0) { descent0 = Math.max(descent0, -b.y); ascent0 = Math.max(ascent0, b.y + b.h); } }
  const ink1 = own1.flatMap(o => o.glyphs.map(g => ({ o, g, box: inkOf(o, g.code, g.coreQuad[0].x, g.coreQuad[0].y) })));
  if (ink1.some(i => !i.box)) return unsupported('a second-frame glyph has no ink proof');
  const size1 = Math.max(...own1.map(o => o.state.fontSizePt ?? o.state.fontSize));
  const descent1 = Math.max(0, ...ink1.map(i => i.g.coreQuad[0].y - i.box!.y));
  const baselines1 = distinctBaselines(own1);
  const x0 = Math.min(...own0.map(o => o.state.origin.x)), x1 = Math.min(...own1.map(o => o.state.origin.x));
  const geometry0 = { rect: f0.rect, firstBaseline: baselines0[0]!, pitch, size, descentEm: descent0 / size, ascentEm: ascent0 / size };
  const capacity = frameBaselines(f0.rect, geometry0.firstBaseline, pitch, size, geometry0.descentEm).length;
  // Advances fill the line; a half-point margin leaves room for ink that
  // overhangs its advance at the right edge (the verifier checks real ink).
  const room0 = f0.rect.x + f0.rect.w - x0 - .5, room1 = f1.rect.x + f1.rect.w - x1 - .5;
  const lines = breakLines(chars.join(''), [...Array(capacity).fill(room0), ...Array(500).fill(room1)], measure);
  if (!lines) return { ok: false, reason: 'flow-chain-exhausted', detail: 'a word is wider than its frame or the story is too long' };
  const placed = placeFlow(lines.length, geometry0, { rect: f1.rect, firstBaseline: baselines1[0]!, size: size1, descentEm: descent1 / size1, sourceBaselines: baselines1 });
  if (!placed.ok) return { ok: false, reason: 'flow-chain-exhausted', detail: `${lines.length} lines do not fit inside the linked frames at the source size` };

  // Every written glyph: its destination pen position and its ink.
  const destinations: FlowDestination[] = [];
  const setLine = (text: string, x: number, baseline: number, frame: number) => {
    const codes = [...text].flatMap(ch => coded.get(ch)!), inks: PdfRect[] = [];
    let pen = x;
    for (const code of codes) { destinations.push({ fontName: font.resourceName, code, point: { x: pen, y: baseline }, frame });
      const b = inkOf(style, code, pen, baseline)!; if (b.w > 0 || b.h > 0) inks.push(b); pen += advance(code); }
    const bytes = Uint8Array.from(codes.flatMap(c => font.bytesPerCode === 1 ? [c] : [c >> 8, c & 255]));
    return { line: { codes: bytes, x, baseline }, inks, glyphs: codes.length };
  };
  const first = placed.first.map((b, i) => setLine(lines[i]!, x0, b, 0));
  const spilled = placed.spilled.map((b, i) => setLine(lines[placed.first.length + i]!, x1, b, 1));
  const edits: SpliceEdit[] = own0.map(o => removal(source, o));
  // The whole story is written as one contiguous run at one slot, so text
  // extraction reads it in order however the source orders the frames.
  let story = storyBlock(style, first.map(l => l.line)), slot = slotOp(source, own0[0]!.opIndex);
  const sourceInk0 = own0.flatMap(o => o.glyphs.map(g => inkOf(o, g.code, g.coreQuad[0].x, g.coreQuad[0].y)).filter((b): b is PdfRect => !!b));
  const glyphs = (ls: typeof first) => ls.reduce((n, l) => n + l.glyphs, 0);
  const moves: FlowMove[] = [{ pageId: f0.pageId, frameId: f0.id, kind: 'rewrite', beforeRect: clip(union(sourceInk0), f0.rect),
    afterRect: clip(union(first.flatMap(l => l.inks)), f0.rect), glyphCount: glyphs(first) }];
  const rewritten = new Set(own0.map(o => o.opIndex));
  const checkWrite = (removed: Set<number>, slot: number) => checkSemantics?.({
    firstGlyphs: own0.flatMap(show => show.glyphs), removed, slot, ops: source.ops,
    origin: effectivePdfPageBox(page.getMediaBox(), page.getCropBox()),
  });
  if (!spilled.length) {
    const refusal = checkWrite(rewritten, slot);
    if (refusal) return refusal;
  }
  if (spilled.length) {
    const dy = placed.pushedBy, movedInk = ink1.map(i => shift(i.box!, 0, -dy));
    const occupied = union([...spilled.flatMap(l => l.inks), ...movedInk]);
    const band = clip({ x: f1.rect.x, w: f1.rect.w, y: occupied.y, h: occupied.h }, f1.rect);
    const media = page.getMediaBox();
    const foreign = source.glyphs.filter(g => !source.ownedOps.has(g.opIndex)).map(g => union(g.quad.map(p => ({ x: p.x, y: p.y, w: 0, h: 0 }))));
    // Painted content only: annotations are not page content, and the export
    // strips or keeps them independently of this page's content stream.
    // A proved backdrop (one fill under all text) is below the story by construction.
    const painted: { box: PdfRect; op: number }[] = [...source.unplacedInk];
    reflowScene(page, source.ops, { x: media.x, y: media.y, w: media.width, h: media.height }, (box, kind, op) => { if (kind !== 'annot' && kind !== 'backdrop') painted.push({ box, op }); });
    const blocking = [...painted.map(p => p.box), ...foreign].find(r => intersects(r, band));
    if (blocking) return { ok: false, reason: 'flow-destination-obstacle', detail: 'something is drawn where the flowed text would go', blockingRect: blocking };
    // Text moved to the earlier slot now paints before whatever lies between
    // the slots: that paint must not meet either frame, nor change graphics state.
    const slot1 = slotOp(source, own1[0]!.opIndex), lo = Math.min(slot, slot1), hi = Math.max(slot, slot1);
    const refusal = checkWrite(source.ownedOps, lo);
    if (refusal) return refusal;
    const crossed = source.ops.slice(lo + 1, hi);
    // Moving text across a marked-content boundary would change its tags or ActualText.
    if (crossed.some(op => markedContent.has(op.operator))) return unsupported('a marked-content boundary lies between the two frames');
    const meetsFrames = (r: PdfRect) => intersects(r, f0.rect) || intersects(r, f1.rect);
    const between = painted.find(p => p.op > lo && p.op < hi && meetsFrames(p.box));
    if (between) return { ok: false, reason: 'flow-destination-obstacle', detail: 'something painted between the frames meets them', blockingRect: between.box };
    if (crossed.some(op => op.operator === 'gs')) return unsupported('the graphics state changes between the two frames');
    // A foreign show between the slots keeps its place while the story moves
    // past it, so its ink (its advance quad when the ink is unknown) must miss both frames.
    const glyphInk = (g: typeof source.glyphs[number]) => {
      const font = source.fonts.find(f => f.resourceName === g.fontName), state = source.shows.get(g.opIndex);
      const r = font && state ? ink(font, g.code, state, g.coreQuad[0].x, g.coreQuad[0].y) : undefined;
      return r?.known ? r.box : union(g.quad.map(p => ({ x: p.x, y: p.y, w: 0, h: 0 })));
    };
    const betweenGlyph = source.glyphs.find(g => g.opIndex > lo && g.opIndex < hi && !source.ownedOps.has(g.opIndex) && meetsFrames(glyphInk(g)));
    if (betweenGlyph) return { ok: false, reason: 'flow-destination-obstacle', detail: 'text painted between the frames meets them', blockingRect: glyphInk(betweenGlyph) };
    edits.push(...own1.map(o => removal(source, o)));
    story += storyBlock(style, spilled.map(l => l.line)) + own1.map(o => movedShow(source, o, dy)).join('');
    slot = lo;
    for (const { o, g } of ink1) destinations.push({ fontName: o.font.resourceName, code: g.code, point: { x: g.coreQuad[0].x, y: g.coreQuad[0].y - dy }, frame: 1 });
    own1.forEach(o => rewritten.add(o.opIndex));
    moves.push({ pageId: f1.pageId, frameId: f1.id, kind: 'spill', afterRect: clip(union(spilled.flatMap(l => l.inks)), f1.rect), glyphCount: glyphs(spilled) });
    moves.push({ pageId: f1.pageId, frameId: f1.id, kind: 'push', beforeRect: clip(union(ink1.map(i => i.box!)), f1.rect), afterRect: clip(union(movedInk), f1.rect), glyphCount: ink1.length });
  }
  const at = source.ops[slot]!.start;
  edits.push({ at, end: at, text: story });
  const bytes = splice(source.bytes, edits);
  const failure = verifyFlowOutput(page, source, tokenizeContentStream(bytes), chain, rewritten, destinations);
  if (failure) return { ok: false, ...failure };
  const anchor = annotationAnchorRefusal(anchors, spilled.length ? [f0.rect, f1.rect] : [f0.rect]);
  if (anchor) return { ok: false, ...anchor };
  const manifest: FlowManifest = { chainId: chain.id, framesChanged: [...new Set(moves.map(m => m.frameId))], pagesChanged: [f0.pageId], movedGlyphCount: moves.reduce((n, m) => n + m.glyphCount, 0) };
  return { ok: true, bytes, moves, manifest };
}
