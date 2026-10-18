// Design tokens — cool-white paper palette with a #3388BB accent.
// Instrument Serif for display italics, Inter Tight for UI,
// JetBrains Mono for numerics/labels, Spectral for document body serif.
//
// Colour tokens are CSS custom properties resolved at paint time, so
// changing the theme (see design/theme.ts) simply rewrites them on
// `:root` — no React re-render required. Anything using `T.paper` in
// an inline style effectively becomes `background: var(--opx-paper)`.
//
// Note: the token named `cream` is historical. In the cool palette it's
// the slightly darker panel surface (soft off-white with a faint blue
// cast) — not a warm cream. The name is kept to avoid touching every
// consumer; the palette file is the source of truth for the value.

// Fixed identity colors for public brand assets, the shipped app icon, and
// splash artwork. In-app ShioriTile badges use the live UI accent instead.
export const SHIORI_BRAND = {
  accent: "#3388bb",
  onAccent: "#eef3f8",
} as const;

export const T = {
  paper: "var(--opx-paper)",
  cream: "var(--opx-cream)",
  surface: "var(--opx-surface)",
  ink: "var(--opx-ink)",
  ink2: "var(--opx-ink2)",
  dim: "var(--opx-dim)",
  dim2: "var(--opx-dim2)",
  rule: "var(--opx-rule)",
  ruleSoft: "var(--opx-ruleSoft)",
  soft: "var(--opx-soft)",
  tint: "var(--opx-tint)",
  hoverTint: "var(--opx-hoverTint)",
  highlight: "var(--opx-highlight)",
  highlightSoft: "var(--opx-highlightSoft)",
  noteY: "var(--opx-noteY)",
  noteShadow: "var(--opx-noteShadow)",
  rect: "var(--opx-rect)",
  rectGhost: "var(--opx-rectGhost)",
  // Brand accent — the Shiori blue (#3388BB in light mode).
  //   accent       — the primary accent, use for brand tile, selected
  //                  states, primary CTAs, focus rings.
  //   accentText   — accessible accent for links and ordinary-size text.
  //   onAccent     — accessible text/icons on a solid accent background.
  //   logoOnAccent — white-first ink for the Shiori glyph; flips only when
  //                  the accent is too light for 3:1 UI contrast.
  //   accentDeep   — the hover / pressed shade toward the current theme ink.
  //   accentSoft   — a translucent accent for subtle fills (~12% alpha).
  //   accentGhost  — an even softer wash for hover highlights (~6% alpha).
  accent: "var(--opx-accent)",
  accentText: "var(--opx-accentText)",
  onAccent: "var(--opx-onAccent)",
  logoOnAccent: "var(--opx-logoOnAccent)",
  accentDeep: "var(--opx-accentDeep)",
  accentSoft: "var(--opx-accentSoft)",
  accentGhost: "var(--opx-accentGhost)",
  // Fixed public-brand colours. In-app square badges intentionally use the
  // live accent/onAccent pair; these remain for the app icon and splash art.
  brandAccent: SHIORI_BRAND.accent,
  brandOnAccent: SHIORI_BRAND.onAccent,
  // Display heading style — flips to `normal` / sans when the user
  // disables serifAccents in Settings.
  displayStyle: "var(--opx-displayStyle)",
  // Primary UI stacks resolve through CSS variables so the whole app
  // tracks `<html lang>` without per-component wiring. Defaults are
  // Latin; `html[lang^="zh"]` / `html[lang^="ja"]` in `app.css` swap in
  // CJK-appropriate fallbacks (important for Han glyph variants).
  serif: "var(--opx-font-serif)",
  sans: "var(--opx-font-sans)",
  mono: "var(--opx-font-mono)",
  // Explicit per-language stacks are kept for cases like ChangelogModal
  // that render a specific language regardless of app-wide locale. They
  // must stay in sync with the CSS variable overrides in app.css.
  serifZh:
    "'Songti SC', 'STSong', 'Source Han Serif SC', 'Noto Serif SC', 'PingFang SC', 'Microsoft YaHei', 'Instrument Serif', Georgia, serif",
  serifJa:
    "'Hiragino Mincho ProN', 'Yu Mincho', 'MS PMincho', 'MS Mincho', 'Shippori Mincho', 'Source Han Serif JP', 'Noto Serif JP', 'Instrument Serif', Georgia, serif",
  sansZh:
    "'PingFang SC', 'Heiti SC', 'Microsoft YaHei', 'Source Han Sans SC', 'Noto Sans SC', 'Inter Tight', 'Inter', -apple-system, Helvetica, Arial, sans-serif",
  sansJa:
    "'Hiragino Sans', 'Yu Gothic', 'Yu Gothic UI', 'Meiryo', 'Meiryo UI', 'MS PGothic', 'MS Gothic', 'Source Han Sans JP', 'Noto Sans JP', 'Inter Tight', 'Inter', -apple-system, Helvetica, Arial, sans-serif",
  monoZh:
    "'JetBrains Mono', 'SF Mono', Menlo, 'Cascadia Code', 'Cascadia Mono', Consolas, 'PingFang SC', 'Heiti SC', 'Songti SC', 'Microsoft YaHei', monospace",
  monoJa:
    "'JetBrains Mono', 'SF Mono', Menlo, 'Cascadia Code', 'Cascadia Mono', Consolas, 'Hiragino Sans', 'Yu Gothic', 'Meiryo', monospace",
  // Kanji face for the 栞 glyph. Shippori Mincho carries the traditional
  // brushstroke weight we want; Noto Serif JP is the broadest fallback on
  // Linux; system -apple-system handles macOS when CDN is unreachable.
  kanji:
    "'Shippori Mincho', 'Noto Serif JP', 'Hiragino Mincho ProN', 'Yu Mincho', serif",
  // Display wordmark face. Klee One is a soft handwritten-style Japanese
  // typeface that pairs warmly with 栞 without fighting the editorial tone.
  klee:
    "'Klee One', 'Shippori Mincho', 'Noto Serif JP', 'Hiragino Mincho ProN', serif",
  // Legacy alias — retained so existing consumers keep compiling.
  // User-facing Text overlay body. Lead with Times because arXiv/LaTeX
  // papers commonly embed Nimbus Roman / Times-compatible faces, and
  // macOS' Times is closer to that PDF look than Times New Roman.
  // Export still uses PDF StandardFonts TimesRoman / TimesRomanBold.
  bodySerif:
    "'Times', 'Times New Roman', 'Liberation Serif', 'Nimbus Roman', 'Charter', 'Iowan Old Style', Georgia, serif",
} as const;

export type Tokens = typeof T;
