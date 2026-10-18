import type { PrefsPdfPaperTone } from "../editor/store/store";
import {
  mixHexColors,
  normalizeHexColor,
  relativeLuminance,
} from "./color";
import { EVERFOREST_LIGHT_PALETTE } from "./theme";

export const PDF_PAPER_TONE_OPTIONS = [
  "Original",
  "Everforest",
  "Custom",
] as const satisfies readonly PrefsPdfPaperTone[];

export const EVERFOREST_PDF_PAPER = EVERFOREST_LIGHT_PALETTE.paper;
export const MIN_PDF_PAPER_LUMINANCE = 0.72;
export const PDF_PAPER_COLOR_SWATCHES = [
  EVERFOREST_PDF_PAPER,
  "#fdf6e3",
  "#f4ecd8",
  "#f2e6cf",
  "#eee8d5",
  "#e8e8e4",
  "#e6edf2",
  "#e3ecd9",
  "#eee5eb",
  "#e8e3ef",
  "#e6ece8",
  "#f1e7dc",
] as const;

export type ResolvedPdfPaperColor = {
  color: string;
  adjusted: boolean;
};

/**
 * Keeps a custom paper colour light enough to behave like paper. Dark seeds
 * are mixed toward white while preserving as much of their hue as possible.
 */
export function resolvePdfPaperCustomColor(
  seed: string,
): ResolvedPdfPaperColor {
  const normalized = normalizeHexColor(seed) ?? EVERFOREST_PDF_PAPER;
  if (relativeLuminance(normalized) >= MIN_PDF_PAPER_LUMINANCE) {
    return { color: normalized, adjusted: false };
  }

  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const middle = (low + high) / 2;
    const mixed = mixHexColors(normalized, "#ffffff", middle);
    if (relativeLuminance(mixed) >= MIN_PDF_PAPER_LUMINANCE) {
      high = middle;
    } else {
      low = middle;
    }
  }

  let color = mixHexColors(normalized, "#ffffff", high);
  // RGB rounding can leave the serialized result a fraction below the floor.
  for (let step = 0; step < 256; step += 1) {
    if (relativeLuminance(color) >= MIN_PDF_PAPER_LUMINANCE) break;
    high = Math.min(1, high + 1 / 65_536);
    color = mixHexColors(normalized, "#ffffff", high);
  }
  return { color, adjusted: color !== normalized };
}

export function pdfPaperColor(
  tone: PrefsPdfPaperTone,
  customColor = EVERFOREST_PDF_PAPER,
): string | null {
  if (tone === "Original") return null;
  if (tone === "Everforest") return EVERFOREST_PDF_PAPER;
  return resolvePdfPaperCustomColor(customColor).color;
}

/**
 * Applies the display-only paper tone to an already-rendered bitmap.
 * Multiplication maps white to the selected paper colour while keeping
 * black ink black. Call this before drawing Shiori's annotation overlays so
 * their authored colours stay exact.
 */
export function compositePdfPaperColor(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  color: string | null,
): void {
  if (!color) return;
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}
