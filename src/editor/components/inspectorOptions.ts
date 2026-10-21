import type { FontFamily, ToolId } from "../../pdf/model/types";
import type { FontPickerOption } from "./ui";
import { Ic } from "./icons";

// The inspector's option sets: which tools share a toolbar slot, and the
// preset colours each annotation type offers.

// Annotation preset palettes, tuned toward vintage stationery — fountain
// pen inks (oxblood, sepia-black, Prussian blue, forest, plum) for lines
// and letterpress/riso tints (mustard, apricot, sage, dusty blue, mauve)
// for fills. The first entry of each set is the long-standing default hex,
// kept so existing annotDefaults still match a swatch.
export const RECT_DEFAULT_COLOR = "#b13a2e";
export const RECT_COLORS = [RECT_DEFAULT_COLOR, "#2b2620", "#3d5942", "#8a6134"];
export const TEXT_LINE_COLORS = ["#b13a2e", "#2b2620", "#33506e", "#3d5942", "#6d4a67"];
export const HIGHLIGHT_COLORS = ["#f4d674", "#e8a37a", "#aac296", "#a9bdd6", "#cdb2cc"];
export const NOTE_COLORS = ["#f7e9a8", "#ecc9a5", "#cbdcc0", "#c3d2e4", "#dcc9dc"];

export const TEXT_MARKUP_TOOLS = ["highlight", "underline", "strikethrough"] as const;
export type TextMarkupToolId = (typeof TEXT_MARKUP_TOOLS)[number];

export function isTextMarkupToolId(tool: ToolId): tool is TextMarkupToolId {
  return TEXT_MARKUP_TOOLS.includes(tool as TextMarkupToolId);
}

export function iconForTextMarkupTool(tool: TextMarkupToolId): typeof Ic.cursor {
  if (tool === "underline") return Ic.underline;
  if (tool === "strikethrough") return Ic.strikethrough;
  return Ic.highlight;
}

// Freehand ink and rectangle share one "draw" toolbar slot (like the markup
// group), with a mode picker in the inspector to switch between them.
export const DRAW_TOOLS = ["ink", "rect"] as const;
export type DrawToolId = (typeof DRAW_TOOLS)[number];

export function isDrawToolId(tool: ToolId): tool is DrawToolId {
  return DRAW_TOOLS.includes(tool as DrawToolId);
}

export function iconForDrawTool(tool: DrawToolId): typeof Ic.cursor {
  return tool === "rect" ? Ic.rect : Ic.ink;
}

// Signature and stamp share one "sign" toolbar slot (like the markup and
// draw groups), with a mode picker in the inspector to switch between
// placing a saved signature and stamping a seal.
export const SIGN_TOOLS = ["signature", "stamp"] as const;
export type SignToolId = (typeof SIGN_TOOLS)[number];

export function isSignToolId(tool: ToolId): tool is SignToolId {
  return SIGN_TOOLS.includes(tool as SignToolId);
}

export function iconForSignTool(tool: SignToolId): typeof Ic.cursor {
  return tool === "stamp" ? Ic.stamp : Ic.signature;
}

export const FONT_OPTIONS: Array<FontPickerOption<FontFamily>> = [
  {
    value: "sans",
    name: "Helvetica",
    previewCss: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
  {
    value: "serif",
    name: "Times",
    previewCss: "'Times', 'Times New Roman', 'Liberation Serif', serif",
  },
  {
    value: "mono",
    name: "Courier",
    previewCss: "'Courier New', Courier, monospace",
  },
  {
    value: "notoSansSc",
    name: "Noto Sans SC",
    previewCss: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    value: "notoSansJp",
    name: "Noto Sans JP",
    previewCss: "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif",
  },
];

export const TEXT_FONT_SIZE_MAX = 144;
export const STAMP_WIDTH_OPTIONS = [1, 1.8, 3, 5];
