export type ResolvedReadableColor = {
  color: string;
  contrast: number;
  adjusted: boolean;
};

export const THEME_COLOR_SWATCHES = [
  "#3388bb",
  "#2a6f99",
  "#4da5d8",
  "#3b6ea8",
  "#5c6a72",
  "#708089",
  "#8da101",
  "#6f8100",
  "#a7c080",
  "#2d5a3d",
  "#3f7d55",
  "#a7542a",
  "#c47a3d",
  "#d6a548",
  "#b13a2e",
  "#d6493c",
  "#9f4f6f",
  "#b85c8a",
  "#7a4f9a",
  "#6554a6",
  "#13161d",
  "#3a4050",
  "#d3c6aa",
  "#eaeff6",
] as const;

type Rgb = { r: number; g: number; b: number };

/** Accepts only opaque #RGB / #RRGGBB colors and returns canonical lowercase. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (short) {
    const [r, g, b] = short[1] ?? "";
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function relativeLuminance(color: string): number {
  const { r, g, b } = parseHex(color);
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

export function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function mixHexColors(from: string, to: string, amount: number): string {
  const start = parseHex(from);
  const end = parseHex(to);
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex({
    r: Math.round(start.r + (end.r - start.r) * t),
    g: Math.round(start.g + (end.g - start.g) * t),
    b: Math.round(start.b + (end.b - start.b) * t),
  });
}

/**
 * Keeps the user's hue where possible, then moves it toward the theme's safe
 * foreground until normal-size text reaches the requested WCAG contrast.
 */
export function resolveReadableColor(
  seed: string,
  background: string,
  safeForeground: string,
  minimumContrast = 4.5,
): ResolvedReadableColor {
  return resolveReadableColorForBackgrounds(
    seed,
    [background],
    safeForeground,
    minimumContrast,
  );
}

/** Resolves one foreground that remains readable on every supplied surface. */
export function resolveReadableColorForBackgrounds(
  seed: string,
  backgrounds: readonly string[],
  safeForeground: string,
  minimumContrast = 4.5,
): ResolvedReadableColor {
  if (backgrounds.length === 0) {
    throw new Error("theme-color-backgrounds-empty");
  }
  const normalizedSeed = normalizeHexColor(seed) ?? normalizeRequired(safeForeground);
  const normalizedBackgrounds = backgrounds.map(normalizeRequired);
  const normalizedSafe = normalizeRequired(safeForeground);
  const seedContrast = minimumContrastRatio(
    normalizedSeed,
    normalizedBackgrounds,
  );
  if (seedContrast >= minimumContrast) {
    return { color: normalizedSeed, contrast: seedContrast, adjusted: false };
  }

  const safeContrast = minimumContrastRatio(
    normalizedSafe,
    normalizedBackgrounds,
  );
  if (safeContrast < minimumContrast) {
    const better = safeContrast > seedContrast ? normalizedSafe : normalizedSeed;
    return {
      color: better,
      contrast: Math.max(seedContrast, safeContrast),
      adjusted: better !== normalizedSeed,
    };
  }

  // The contrast path can briefly move toward the background before it moves
  // away (for example a dark seed on a dark surface with a light safe color),
  // so first locate the earliest passing interval instead of assuming global
  // monotonicity. Binary refinement then preserves as much of the seed as
  // possible.
  const coarseSteps = 128;
  let low = 0;
  let high = 1;
  for (let step = 1; step <= coarseSteps; step += 1) {
    const amount = step / coarseSteps;
    const mixed = mixHexColors(normalizedSeed, normalizedSafe, amount);
    if (
      minimumContrastRatio(mixed, normalizedBackgrounds) >= minimumContrast
    ) {
      low = (step - 1) / coarseSteps;
      high = amount;
      break;
    }
  }
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const middle = (low + high) / 2;
    const mixed = mixHexColors(normalizedSeed, normalizedSafe, middle);
    if (
      minimumContrastRatio(mixed, normalizedBackgrounds) >= minimumContrast
    ) {
      high = middle;
    } else {
      low = middle;
    }
  }

  let color = mixHexColors(normalizedSeed, normalizedSafe, high);
  // RGB rounding can put the binary-search result a hair below the threshold.
  // Nudge toward the known-safe endpoint until the serialized color passes.
  for (let step = 0; step < 256; step += 1) {
    if (
      minimumContrastRatio(color, normalizedBackgrounds) >= minimumContrast
    ) {
      break;
    }
    high = Math.min(1, high + 1 / 65_536);
    color = mixHexColors(normalizedSeed, normalizedSafe, high);
  }
  return {
    color,
    contrast: minimumContrastRatio(color, normalizedBackgrounds),
    adjusted: color !== normalizedSeed,
  };
}

export function hexToRgba(color: string, alpha: number): string {
  const { r, g, b } = parseHex(color);
  const normalizedAlpha = Number(
    Math.max(0, Math.min(1, alpha)).toFixed(3),
  );
  return `rgba(${r},${g},${b},${normalizedAlpha})`;
}

export function contrastingTextColor(
  background: string,
  light = "#f6f8fb",
  dark = "#13161d",
): string {
  return contrastRatio(light, background) >= contrastRatio(dark, background)
    ? normalizeRequired(light)
    : normalizeRequired(dark);
}

function normalizeRequired(value: string): string {
  const normalized = normalizeHexColor(value);
  if (!normalized) throw new Error(`invalid-hex-color:${value}`);
  return normalized;
}

function minimumContrastRatio(
  foreground: string,
  backgrounds: readonly string[],
): number {
  return Math.min(
    ...backgrounds.map((background) => contrastRatio(foreground, background)),
  );
}

function parseHex(value: string): Rgb {
  const normalized = normalizeRequired(value);
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}
