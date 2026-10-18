// Simplified Chinese variant of Noto Sans CJK. Covers CJK Unified
// Ideographs with Chinese-style glyph shapes. Does not include
// hiragana or katakana — those are in the JP subset below.
export const cjkScExportFontUrl = new URL(
  "../../assets/fonts/NotoSansSC-Regular.otf",
  import.meta.url,
).href;

// Japanese variant of Noto Sans CJK. Covers hiragana, katakana, and
// CJK Unified Ideographs with Japanese-style glyph shapes. Selected
// per-overlay whenever the text contains kana so Japanese annotations
// embed correctly.
export const cjkJpExportFontUrl = new URL(
  "../../assets/fonts/NotoSansJP-Regular.otf",
  import.meta.url,
).href;
