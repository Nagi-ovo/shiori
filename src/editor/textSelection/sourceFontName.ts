// Stable identification of the source font under a contentText edit, so
// the on-screen edit box can render with the document's OWN embedded font
// (the engine registers embedded fonts as FontFaces) instead of a
// lookalike CSS stack — the face swap was what read as "text shifts when I
// edit" even when the geometry was pixel-exact.

import type { TextRunDisplayBounds } from "./highlightRects";

// "KAXVBH+EBGaramond-Regular" → "EBGaramond-Regular". The six-letter
// subset tag differs per export/subsetting pass; the base name is what
// identifies the font across sessions.
export function normalizeBaseFontName(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, "");
}

// Majority vote over the runs' resolved font names — mirrors the export
// side's dominant-font aggregation, so the face shown while editing is the
// one the export path will try to write with.
export function dominantSourceFontName(
  runs: TextRunDisplayBounds[],
): string | undefined {
  const votes = new Map<string, number>();
  for (const run of runs) {
    if (!run.fontName) continue;
    const name = normalizeBaseFontName(run.fontName);
    votes.set(name, (votes.get(name) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [name, count] of votes) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}
