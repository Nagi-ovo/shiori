import type { PdfTextStyle as TextStyle } from "../engine/text";

type TextStyleMetrics = Pick<TextStyle, "ascent" | "descent">;

const FALLBACK_ASCENT_RATIO = 0.8;
const FALLBACK_DESCENT_RATIO = 0.2;
const MAX_FONT_EM_SPAN_RATIO = 1;
const MIN_PLAUSIBLE_ASCENT_SHARE = 0.55;
const MAX_PLAUSIBLE_ASCENT_SHARE = 0.95;

/**
 * Convert a text style's font ascent/descent into a deterministic glyph band.
 *
 * Some embedded fonts publish a font-wide bbox taller than one em (for
 * example ascent 1.06 + descent 0.34). That bbox is useful for font layout,
 * but using it verbatim for markup makes a highlight visibly taller than the
 * rendered text. Preserve normal sub-em metrics; normalize oversized but
 * plausible metrics back to one em; and fail closed to the fixed 80/20 band
 * when the metadata is malformed.
 */
export function deterministicTextVerticalMetrics(
  fontHeight: number,
  style: TextStyleMetrics | undefined,
): { ascent: number; descent: number } {
  const safeFontHeight =
    Number.isFinite(fontHeight) && fontHeight > 0 ? fontHeight : 0;
  const fallback = {
    ascent: safeFontHeight * FALLBACK_ASCENT_RATIO,
    descent: safeFontHeight * FALLBACK_DESCENT_RATIO,
  };
  if (safeFontHeight === 0) return fallback;

  const rawAscent = finiteNumber(style?.ascent);
  const rawDescent = finiteNumber(style?.descent);
  if (
    (rawAscent !== null && rawAscent <= 0) ||
    (rawDescent !== null && rawDescent > 0)
  ) {
    return fallback;
  }
  let ascentRatio = rawAscent ?? (rawDescent !== null ? 1 + rawDescent : null);
  let descentRatio = rawDescent !== null
    ? Math.abs(rawDescent)
    : rawAscent !== null
      ? 1 - rawAscent
      : null;
  if (
    ascentRatio === null ||
    descentRatio === null ||
    ascentRatio <= 0 ||
    descentRatio < 0
  ) {
    return fallback;
  }

  const spanRatio = ascentRatio + descentRatio;
  if (!(Number.isFinite(spanRatio) && spanRatio > 0)) return fallback;
  const ascentShare = ascentRatio / spanRatio;
  if (
    ascentShare < MIN_PLAUSIBLE_ASCENT_SHARE ||
    ascentShare > MAX_PLAUSIBLE_ASCENT_SHARE
  ) {
    return fallback;
  }
  if (spanRatio > MAX_FONT_EM_SPAN_RATIO) {
    ascentRatio = ascentShare * MAX_FONT_EM_SPAN_RATIO;
    descentRatio = (1 - ascentShare) * MAX_FONT_EM_SPAN_RATIO;
  }

  return {
    ascent: safeFontHeight * ascentRatio,
    descent: safeFontHeight * descentRatio,
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
