// Independent proof of a flow rewrite, on the rewritten stream: the shared
// retypeset glyph proof (every untouched glyph keeps font, code and position
// to 1e-4 pt; every written glyph lands at its planned pen position), then
// real ink inside its frame and no two lines closer than 0.95 em.
import type {PDFPage} from 'pdf-lib';
import type {TextFlowChain} from '../../../model/types';
import {runPageEnvironment} from '../../contentStreamEdit/replaceRunPage';
import type {ContentOp} from '../../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../../contentStreamEdit/walkTextPlacements';
import type {ShowTextState} from '../../contentStreamEdit/textStateTypes';
import {retypesetInk} from '../retypesetInk';
import {verifyRetypesetGlyphs} from '../retypesetVerify';
import type {FlowSource} from './flowSource';
import type {FlowReason} from './flowTypes';

export type FlowDestination = { fontName: string; code: number; point: { x: number; y: number }; frame: number };

export function verifyFlowOutput(page: PDFPage, source: FlowSource, ops: ContentOp[], chain: TextFlowChain,
  rewritten: ReadonlySet<number>, destinations: readonly FlowDestination[]): { reason: FlowReason; detail: string } | null {
  // A miss of the frames' room is a story that does not fit; anything else is a failed proof.
  const unproved = (detail: string) => ({ reason: 'flow-unsupported-text' as const, detail });
  const exhausted = (detail: string) => ({ reason: 'flow-chain-exhausted' as const, detail });
  const environment = runPageEnvironment(page), states = new Map<string, ShowTextState>();
  // Stroked text is kept: it paints, so it can be an obstacle; in a frame it refuses.
  const walk = walkTextPlacements(ops, { includeStroked: true,
    resolveFont: name => { const f = source.fonts.find(f => f.resourceName === name); return f ? { ...f, ok: true, appliesWordSpacing: f.bytesPerCode === 1 } : { ok: false, reason: 'unsupported font' }; },
    extGStateSetsFont: name => environment.extGStates?.get(name)?.setsFont ?? null,
    onShow: state => states.set(`${state.opIndex}:${state.arrayItemIndex}`, state),
  });
  if (!walk.ok) return unproved(`rewritten stream does not walk: ${walk.reason}`);
  try { verifyRetypesetGlyphs(walk.glyphs, source.glyphs.filter(g => !rewritten.has(g.opIndex)), destinations); }
  catch (error) { return unproved((error as Error).message); }
  const ink = retypesetInk(page, source.fonts, ops);
  const lines = chain.frames.map(() => new Map<number, number>());
  for (const g of walk.glyphs) {
    const k = chain.frames.findIndex(f => g.coreQuad[0].x >= f.rect.x - .01 && g.coreQuad[0].x <= f.rect.x + f.rect.w + .01 && g.coreQuad[0].y >= f.rect.y - .01 && g.coreQuad[0].y <= f.rect.y + f.rect.h + .01);
    if (k < 0) continue;
    const state = states.get(`${g.opIndex}:${g.arrayItemIndex}`), font = source.fonts.find(f => f.resourceName === g.fontName);
    if (!state || !font) return unproved('a frame glyph has no text state');
    const r = ink(font, g.code, state, g.coreQuad[0].x, g.coreQuad[0].y), f = chain.frames[k]!.rect;
    if (!r.known) return unproved('a frame glyph has no ink proof');
    if (r.box.w > 0 && (r.box.x < f.x - .01 || r.box.y < f.y - .01 || r.box.x + r.box.w > f.x + f.w + .01 || r.box.y + r.box.h > f.y + f.h + .01))
      return exhausted('a glyph’s ink leaves its frame');
    const y = +g.coreQuad[0].y.toFixed(4), size = state.fontSizePt ?? state.fontSize;
    lines[k]!.set(y, Math.max(lines[k]!.get(y) ?? 0, size));
  }
  for (const frame of lines) {
    const ys = [...frame.keys()].sort((a, b) => b - a);
    for (let i = 1; i < ys.length; i++) if (ys[i - 1]! - ys[i]! < .95 * Math.max(frame.get(ys[i - 1]!)!, frame.get(ys[i]!)!)) return exhausted('two lines in one frame overlap');
  }
  return null;
}
