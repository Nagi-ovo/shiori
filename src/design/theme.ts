// Theme palettes + the runtime applier. Writes CSS custom properties on
// `:root` — every `var(--opx-*)` reference in tokens.ts picks them up at
// paint time. Called from App.tsx with (prefs.colorMode, prefs.theme).

import type { PrefsColorMode, PrefsTheme } from "../editor/store/store";
import {
  contrastRatio,
  contrastingTextColor,
  hexToRgba,
  mixHexColors,
  normalizeHexColor,
  relativeLuminance,
  resolveReadableColorForBackgrounds,
} from "./color";

export const COLOR_MODE_OPTIONS = [
  "Auto",
  "Light",
  "Dark",
] as const satisfies readonly PrefsColorMode[];

export const THEME_OPTIONS = [
  "Default",
  "Everforest",
] as const satisfies readonly PrefsTheme[];

export type ThemePalette = {
  paper: string;
  cream: string;
  surface: string;
  ink: string;
  ink2: string;
  dim: string;
  dim2: string;
  rule: string;
  ruleSoft: string;
  soft: string;
  tint: string;
  // A subtle hover wash that reads as a lift in both light and dark.
  // Using translucent ink/paper lets the underlying panel colour show
  // through, so a hover on cream looks like cream-plus-a-whisper rather
  // than swapping to a different palette entry.
  hoverTint: string;
  highlight: string;
  highlightSoft: string;
  noteY: string;
  noteShadow: string;
  rect: string;
  rectGhost: string;
  accent: string;
  accentText: string;
  onAccent: string;
  logoOnAccent: string;
  accentDeep: string;
  accentSoft: string;
  accentGhost: string;
};

type ThemeFoundation = Omit<
  ThemePalette,
  | "accent"
  | "accentText"
  | "onAccent"
  | "logoOnAccent"
  | "accentDeep"
  | "accentSoft"
  | "accentGhost"
  | "rectGhost"
>;

type ThemeAccentTokens = Pick<
  ThemePalette,
  | "accent"
  | "accentText"
  | "onAccent"
  | "logoOnAccent"
  | "accentDeep"
  | "accentSoft"
  | "accentGhost"
>;

// Cool-white paper + #3388BB accent. Annotation colours (highlight
// yellow, note yellow, rect red) stay warm on purpose — they read as
// tool colours against the cool chrome.
export const LIGHT_PALETTE: ThemePalette = createPalette({
  paper: "#f6f8fb",
  cream: "#eef3f8",
  surface: "#ffffff",
  ink: "#13161d",
  ink2: "#3a4050",
  // Secondary text must clear 4.5:1 on paper, cream, surface and tint —
  // the status bar, hints and metadata all sit on those. #7a8292 only
  // reached 3.31:1 on the tint surface. See theme.test.ts.
  dim: "#656c7b",
  dim2: "#b6bcc9",
  rule: "#dde3ec",
  ruleSoft: "#e9eef4",
  soft: "#c6cdd9",
  tint: "#e8eef5",
  hoverTint: "rgba(19,22,29,0.045)",
  highlight: "#f4d674",
  highlightSoft: "rgba(244,214,116,0.42)",
  noteY: "#f7e9a8",
  noteShadow: "rgba(184,160,90,0.35)",
  rect: "#b13a2e",
}, "#3388bb");

// Cool-dark palette. The PDF canvas itself stays whatever the engine renders
// (usually white) — only the app chrome goes dark. That creates some
// contrast shock at the page edges, which is the same compromise Acrobat
// Dark Mode ships with; inverting the page render is out of scope for v1.
// Accent brightens slightly for legibility on a dark surface.
export const DARK_PALETTE: ThemePalette = createPalette({
  paper: "#111418",
  cream: "#191d25",
  surface: "#20242d",
  ink: "#eaeff6",
  ink2: "#b5bcc8",
  // 4.53:1 on the lightest dark surface (tint); the shared #7a8292 was 4.02.
  dim: "#838b9a",
  dim2: "#565c68",
  rule: "#2b313b",
  ruleSoft: "#252b34",
  soft: "#3a4150",
  tint: "#1d2129",
  hoverTint: "rgba(234,239,246,0.05)",
  highlight: "#f4d674",
  highlightSoft: "rgba(244,214,116,0.28)",
  noteY: "#d4b95c",
  noteShadow: "rgba(0,0,0,0.6)",
  rect: "#d6493c",
}, "#4da5d8");

// Everforest by sainnhe, MIT: https://github.com/sainnhe/everforest
// Medium contrast palettes, adapted from palette.md.
//
// Upstream's secondary greys (#708089, #829181) sit at 3.4:1 and 2.8:1 on
// these papers, below the 4.5:1 normal-text minimum. The light theme's own
// ink only reaches 4.66:1, so any readable secondary colour has to land
// almost on top of it; ink2 and dim are therefore near-ink and the text
// hierarchy comes from size and weight instead of value. Chosen with
// resolveReadableColorForBackgrounds against paper/cream/surface/tint.
export const EVERFOREST_LIGHT_PALETTE: ThemePalette = createPalette({
  paper: "#efebd4",
  cream: "#f4f0d9",
  surface: "#fdf6e3",
  ink: "#5c6a72",
  ink2: "#5e6c75",
  dim: "#5b6b6a",
  dim2: "#a6b0a0",
  rule: "#e0dcc7",
  ruleSoft: "#e6e2cc",
  soft: "#bdc3af",
  tint: "#f0f1d2",
  hoverTint: "rgba(92,106,114,0.06)",
  highlight: "#dfa000",
  highlightSoft: "rgba(223,160,0,0.3)",
  noteY: "#faedcd",
  noteShadow: "rgba(148,120,40,0.28)",
  rect: "#f85552",
}, "#8da101");

export const EVERFOREST_DARK_PALETTE: ThemePalette = createPalette({
  paper: "#232a2e",
  cream: "#2d353b",
  surface: "#343f44",
  ink: "#d3c6aa",
  // Upstream #9da9a0 / #859289 reach only 3.9:1 / 2.9:1 on the tint
  // surface; these keep the green (ink2) and warm (dim) casts at ≥4.5:1.
  ink2: "#b4bba9",
  dim: "#b8b49e",
  dim2: "#7a8478",
  rule: "#3d484d",
  ruleSoft: "#343f44",
  soft: "#56635f",
  tint: "#3d484d",
  hoverTint: "rgba(211,198,170,0.06)",
  highlight: "#dbbc7f",
  highlightSoft: "rgba(219,188,127,0.24)",
  noteY: "#dbbc7f",
  noteShadow: "rgba(0,0,0,0.5)",
  rect: "#e67e80",
}, "#a7c080");

export type ThemePaletteSet = {
  light: ThemePalette;
  dark: ThemePalette;
};

export const THEME_PALETTE_SETS = {
  default: { light: LIGHT_PALETTE, dark: DARK_PALETTE },
  everforest: {
    light: EVERFOREST_LIGHT_PALETTE,
    dark: EVERFOREST_DARK_PALETTE,
  },
} satisfies Record<string, ThemePaletteSet>;

export type EffectiveTheme = "light" | "dark";

export function resolveEffectiveTheme(
  colorMode: PrefsColorMode,
  systemPrefersDark?: boolean,
): EffectiveTheme {
  if (colorMode === "Dark") return "dark";
  if (colorMode === "Light") return "light";
  const prefersDark =
    systemPrefersDark ??
    (typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  return prefersDark
    ? "dark"
    : "light";
}

export function paletteForTheme(
  theme: PrefsTheme,
  effective: EffectiveTheme,
  accentColor: string | null = null,
): ThemePalette {
  // Custom theme imports can target this { light, dark } shape once
  // the user-facing format exists.
  const set =
    theme === "Everforest" ? THEME_PALETTE_SETS.everforest : THEME_PALETTE_SETS.default;
  const palette = set[effective];
  // Intentional native-feel trade-off (REFACTOR_PLAN A3): the accent is a
  // brand token (user-tunable via Settings → AccentColorSetting), NOT the OS
  // accent (NSColor.controlAccentColor / Windows personalization colour).
  // Shiori owns its visual language, so this deliberately does not read the
  // system accent — a null seed falls back to the built-in brand palette.
  const seed = normalizeHexColor(accentColor);
  return seed ? { ...palette, ...deriveAccentTokens(palette, seed) } : palette;
}

export function applyTheme(
  effective: EffectiveTheme,
  theme: PrefsTheme = "Default",
  accentColor: string | null = null,
): void {
  if (typeof document === "undefined") return;
  const palette = paletteForTheme(theme, effective, accentColor);
  const root = document.documentElement;
  for (const key of Object.keys(palette) as (keyof ThemePalette)[]) {
    root.style.setProperty(`--opx-${key}`, palette[key]);
  }
  root.style.setProperty("color-scheme", effective);
}

function createPalette(
  foundation: ThemeFoundation,
  accentSeed: string,
): ThemePalette {
  return {
    ...foundation,
    rectGhost: hexToRgba(
      foundation.rect,
      relativeLuminance(foundation.paper) < 0.18 ? 0.14 : 0.09,
    ),
    ...deriveAccentTokens(foundation, accentSeed),
  };
}

function deriveAccentTokens(
  foundation: ThemeFoundation,
  accentSeed: string,
): ThemeAccentTokens {
  const surfaces = [
    foundation.paper,
    foundation.cream,
    foundation.surface,
  ];
  // A user-picked accent is an identity, not a suggestion. Keep the primary
  // token byte-for-byte canonical and derive only its semantic companions for
  // contrast. This makes the swatch, HEX field, and rendered accent agree.
  const accent = normalizeHexColor(accentSeed) ?? accentSeed;
  const darkSurface = relativeLuminance(foundation.paper) < 0.18;
  const softAlpha = darkSurface ? 0.18 : 0.12;
  const ghostAlpha = darkSurface ? 0.09 : 0.06;
  const accentTextSurfaces = [
    ...surfaces,
    ...surfaces.map((surface) => mixHexColors(surface, accent, ghostAlpha)),
  ];
  const safeTextForeground = contrastingTextColor(
    foundation.paper,
    "#ffffff",
    "#000000",
  );
  const accentText = resolveReadableColorForBackgrounds(
    accentSeed,
    accentTextSurfaces,
    safeTextForeground,
    4.5,
  ).color;
  // Brand marks should read as white by default. Unlike small button labels,
  // the solid glyph only needs the WCAG non-text/UI contrast threshold; switch
  // to deep ink solely when the chosen accent is too light for white at 3:1.
  const logoOnAccent =
    contrastRatio("#ffffff", accent) >= 3 ? "#ffffff" : "#13161d";
  return {
    accent,
    accentText,
    onAccent: contrastingTextColor(accent, "#ffffff", "#000000"),
    logoOnAccent,
    accentDeep: mixHexColors(accent, foundation.ink, 0.18),
    accentSoft: hexToRgba(accent, softAlpha),
    accentGhost: hexToRgba(accent, ghostAlpha),
  };
}

export function applyDisplayStyle(serifAccents: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--opx-displayStyle",
    serifAccents ? "italic" : "normal",
  );
}
