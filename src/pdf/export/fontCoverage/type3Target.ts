import type { Type3GlyphProof } from './type3Proof';
import { type3Bounds, type3Failure, type3Transform, type Type3Box, type Type3Failure } from './type3Paths';

export type Type3PaintState = {
  // Caller transform after FontMatrix, including Tf and proposed origin.
  transform: readonly number[]; clip: Type3Box;
  fillColor: { space: string; values: readonly number[] };
  renderMode: number; fillAlpha: number; blendMode: string; softMask: string;
};
const supported = (state: Type3PaintState) => {
  const m = state.transform, count: Record<string, number> = { DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4 };
  return m.length === 6 && m.every(Number.isFinite) && Number.isFinite(m[0]! * m[3]! - m[1]! * m[2]!) && Math.abs(m[0]! * m[3]! - m[1]! * m[2]!) > 1e-12
    && Object.values(state.clip).every(Number.isFinite) && state.clip.w >= 0 && state.clip.h >= 0
    && state.fillColor.values.length === count[state.fillColor.space] && state.fillColor.values.every(v => Number.isFinite(v) && v >= 0 && v <= 1)
    && state.renderMode === 0 && state.fillAlpha === 1 && state.blendMode === 'Normal' && state.softMask === 'None';
};
/** Independent per-target check, deliberately narrower than a general clip
 * interpreter. A changed linear transform, clip or inherited fill refuses. */
export function checkType3Target(proof: Type3GlyphProof, source: Type3PaintState, target: Type3PaintState):
  { ok: true; inkBounds: Type3Box | null } | Type3Failure {
  const unsafe = (reason: string) => type3Failure('type3-charproc-unsafe', reason);
  if (!supported(source) || !supported(target)) return unsafe('Unsupported Type3 target painting state');
  if (source.fillColor.space !== target.fillColor.space || source.fillColor.values.some((v, i) => v !== target.fillColor.values[i])
    || source.transform.slice(0, 4).some((v, i) => v !== target.transform[i])
    || (['x', 'y', 'w', 'h'] as const).some(k => source.clip[k] !== target.clip[k])) return unsafe('Type3 read-set changed at the target');
  for (const state of [source, target]) {
    const hull = type3Transform(proof.inkHull, state.transform), c = state.clip;
    if (hull.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < c.x || p.x > c.x + c.w || p.y < c.y || p.y > c.y + c.h)) return unsafe('Type3 path hull crosses the unchanged clip');
  }
  return { ok: true, inkBounds: type3Bounds(type3Transform(proof.inkHull, target.transform)) };
}
