// Shared helper for consumers of ContentTextOverlay.sourceBaselinesPt (the
// on-screen textarea and the export both need the same answer): the vertical
// pitch between consecutive source lines, in points.
//
// Median of the consecutive baseline gaps — robust against one odd gap
// (e.g. a heading line inside the selection). Null when fewer than two
// baselines were captured or no gap is usable; callers fall back to their
// font-size-derived pitch.
export function sourceLinePitchPt(
  baselines: readonly number[] | undefined,
): number | null {
  if (!baselines || baselines.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < baselines.length; i += 1) {
    // Page space, top line first: y decreases downward, so gaps are positive.
    const gap = baselines[i - 1]! - baselines[i]!;
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}
