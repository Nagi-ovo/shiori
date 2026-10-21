import type {
  HighlightOverlay,
  InkOverlay,
  NoteOverlay,
  Overlay,
  PageModel,
  RectOverlay,
  StampOverlay,
  StrikeOutOverlay,
  TextOverlay,
  UnderlineOverlay,
} from "../model/types";
import {
  createNoteOverlay,
  NOTE_DEFAULT_COLOR,
  NOTE_DEFAULT_HEIGHT_PT,
  NOTE_DEFAULT_WIDTH_PT,
} from "../model/note";
import { coalescePdfRects } from "../geometry/rectCoalesce";
import { pdfPointToPageLocal, pdfRectToPageLocal } from "../model/pageSpace";
import { freeTextRichTextStyle, freeTextStyle } from "./freeTextStyle";

// One listed annotation (in the shape pdf.js listed it, ./sourceAnnotations)
// into an overlay, per subtype, and the readers for the listing's values
// that the importer (./annotations.ts) shares with them.

const IMPORTED_HIGHLIGHT_MAX_OPACITY = 0.45;

export const ANNOT = {
  TEXT: 1,
  FREETEXT: 3,
  SQUARE: 5,
  HIGHLIGHT: 9,
  UNDERLINE: 10,
  STRIKEOUT: 12,
  INK: 15,
} as const;

export type PdfjsAnnotation = Record<string, unknown>;

export const MAX_IMPORTED_ANNOTATION_TEXT_CHARACTERS = 65_536;

const MAX_IMPORTED_NUMBER_ARRAY_VALUES = 200_000;

export function importAnnotationByType(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
  now: number,
): Overlay | null {
  const type = annotationType(annot);
  if (type === ANNOT.HIGHLIGHT) return importHighlight(annot, page, makeId);
  if (type === ANNOT.UNDERLINE) return importUnderline(annot, page, makeId);
  if (type === ANNOT.STRIKEOUT) return importStrikeOut(annot, page, makeId);
  if (type === ANNOT.TEXT) return importStickyNote(annot, page, makeId, now);
  if (type === ANNOT.SQUARE) return importSquare(annot, page, makeId);
  if (type === ANNOT.INK) return importInk(annot, page, makeId);
  if (type === ANNOT.FREETEXT) return importFreeText(annot, page, makeId);
  return null;
}

type TextMarkupOverlay = HighlightOverlay | UnderlineOverlay | StrikeOutOverlay;

function importHighlight(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
): HighlightOverlay | null {
  return importTextMarkup({
    type: "highlight",
    annot,
    page,
    makeId,
    fallbackColor: "#f4d674",
    opacity: Math.min(
      IMPORTED_HIGHLIGHT_MAX_OPACITY,
      numberValue(annot.opacity, IMPORTED_HIGHLIGHT_MAX_OPACITY),
    ),
  }) as HighlightOverlay | null;
}

function importUnderline(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
): UnderlineOverlay | null {
  return importTextMarkup({
    type: "underline",
    annot,
    page,
    makeId,
    fallbackColor: "#b13a2e",
    opacity: numberValue(annot.opacity, 1),
  }) as UnderlineOverlay | null;
}

function importStrikeOut(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
): StrikeOutOverlay | null {
  return importTextMarkup({
    type: "strikethrough",
    annot,
    page,
    makeId,
    fallbackColor: "#b13a2e",
    opacity: numberValue(annot.opacity, 1),
  }) as StrikeOutOverlay | null;
}

function importTextMarkup({
  type,
  annot,
  page,
  makeId,
  fallbackColor,
  opacity,
}: {
  type: TextMarkupOverlay["type"];
  annot: PdfjsAnnotation;
  page: PageModel;
  makeId: () => string;
  fallbackColor: string;
  opacity: number;
}): TextMarkupOverlay | null {
  const quads = toNumberArray(annot.quadPoints);
  const fallbackRect = rectFromAnnot(annot);
  const sourceRects = quads.length >= 8
    ? quadPointsToRects(quads)
    : fallbackRect
      ? [fallbackRect]
      : [];
  const coalescedRects = coalescePdfRects(
    sourceRects.map((rect) => pdfRectToPageLocal(page, rect)),
  );
  if (coalescedRects.length === 0) return null;
  return {
    type,
    id: makeId(),
    pageId: page.id,
    rects: coalescedRects,
    color: colorToHex(annot.color, fallbackColor),
    opacity: clampOpacity(opacity),
    ...sourceComment(annot),
  } as TextMarkupOverlay;
}

// The reviewer's comment on a markup, shape or ink (its /Contents), when it
// has one. Shiori's own export writes an empty /Contents on markup.
function sourceComment(annot: PdfjsAnnotation): { comment?: string } {
  const comment = contentsText(annot);
  return comment ? { comment } : {};
}

// A listed /CA below 1. Opaque marks carry no opacity, as in Shiori.
function translucency(annot: PdfjsAnnotation): { opacity?: number } {
  const opacity = clampOpacity(numberValue(annot.opacity, 1));
  return opacity < 1 ? { opacity } : {};
}

function importStickyNote(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
  now: number,
): NoteOverlay | null {
  const rect = rectFromAnnot(annot);
  if (!rect) return null;
  const localRect = pdfRectToPageLocal(page, rect);
  const note = createNoteOverlay({
    id: makeId(),
    pageId: page.id,
    rect: {
      x: localRect.x,
      y: localRect.y + localRect.h - NOTE_DEFAULT_HEIGHT_PT,
      w: NOTE_DEFAULT_WIDTH_PT,
      h: NOTE_DEFAULT_HEIGHT_PT,
    },
    text: contentsText(annot),
    color: colorToHex(annot.color, NOTE_DEFAULT_COLOR),
    now,
  });
  // Its icon, pop-up state and review state, written back on export.
  if (typeof annot.name === "string") note.sourceIcon = annot.name;
  if (typeof annot.open === "boolean") note.sourceOpen = annot.open;
  if (typeof annot.state === "string") note.sourceState = annot.state;
  if (typeof annot.stateModel === "string") note.sourceStateModel = annot.stateModel;
  return note;
}

function importSquare(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
): RectOverlay | null {
  const rect = rectFromAnnot(annot);
  if (!rect) return null;
  const border = recordValue(annot.borderStyle);
  const turn = appearanceTurn(annot);
  return {
    type: "rect",
    id: makeId(),
    pageId: page.id,
    rect: pdfRectToPageLocal(page, turn ? turnedBox(rect, turn) : rect),
    ...(turn ? { angle: turn.angle } : {}),
    color: colorToHex(annot.color, "#b13a2e"),
    strokeWidth: numberValue(border?.width, 2),
    fill: null,
    ...sourceComment(annot),
    ...translucency(annot),
  };
}

function importInk(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
): InkOverlay | null {
  const rawLists = Array.isArray(annot.inkLists) ? annot.inkLists : [];
  const paths = rawLists
    .map(toNumberArray)
    .map((list) => {
      const points = [];
      for (let i = 0; i + 1 < list.length; i += 2) {
        points.push({ x: list[i]!, y: list[i + 1]! });
      }
      return points.map((point) => pdfPointToPageLocal(page, point));
    })
    .filter((path) => path.length > 0);
  if (paths.length === 0) return null;
  const border = recordValue(annot.borderStyle);
  return {
    type: "ink",
    id: makeId(),
    pageId: page.id,
    paths,
    color: colorToHex(annot.color, "#b13a2e"),
    width: numberValue(border?.width, 2),
    ...sourceComment(annot),
    ...translucency(annot),
  };
}

function importFreeText(
  annot: PdfjsAnnotation,
  page: PageModel,
  makeId: () => string,
): StampOverlay | TextOverlay | null {
  const rect = rectFromAnnot(annot);
  if (!rect) return null;
  // A FreeText's own /Rotate (Acrobat writes the page's, so the text reads
  // upright on a rotated page) turns its content within /Rect. Shiori keeps
  // the box unrotated and turns it by `angle` (clockwise, the opposite sense)
  // about its centre, so a quarter turn swaps the box's sides there.
  // Without one, a turn its appearance's /Matrix gives it (Shiori's export).
  const rotation = numberValue(annot.rotation, 0);
  const turn = rotation ? undefined : appearanceTurn(annot);
  const box = turn
    ? turnedBox(rect, turn)
    : rotation % 180 === 0
      ? rect
      : { x: rect.x + (rect.w - rect.h) / 2, y: rect.y + (rect.h - rect.w) / 2, w: rect.h, h: rect.w };
  const localRect = pdfRectToPageLocal(page, box);
  const angle = turn ? { angle: turn.angle } : rotation ? { angle: 360 - rotation } : {};
  const appearance = recordValue(annot.defaultAppearanceData);
  const text = contentsText(annot);
  const stampKind = stampKindFromText(text);
  if (stampKind && isZapfDingbatsAppearance(annot, appearance)) {
    const border = recordValue(annot.borderStyle);
    return {
      type: "stamp",
      id: makeId(),
      pageId: page.id,
      kind: stampKind,
      rect: localRect,
      color: colorToHex(annot.color ?? appearance?.fontColor, "#1a1815"),
      strokeWidth: numberValue(border?.width, 1.8),
      ...angle,
    };
  }
  const appearanceStyle = freeTextStyle(appearance);
  const richTextStyle = freeTextRichTextStyle(annot);
  const bold = richTextStyle.bold ?? appearanceStyle.bold;
  const italic = richTextStyle.italic ?? appearanceStyle.italic;
  return {
    type: "text",
    id: makeId(),
    pageId: page.id,
    rect: localRect,
    text,
    fontSize: parseDefaultAppearanceFontSize(annot, appearance),
    color: colorToHex(appearance?.fontColor ?? annot.color, "#1a1815"),
    bold,
    ...(italic ? { italic: true } : {}),
    align:
      richTextStyle.align ??
      alignFromNumber(numberValue(annot.textAlignment, 0)),
    fontFamily: richTextStyle.fontFamily ?? appearanceStyle.fontFamily,
    ...angle,
    ...freeTextBox(annot),
  };
}

// A text box's fill (/C, its background on FreeText), frame (/BS width; the
// frame takes the text colour, as Acrobat draws it) and /CA. Text colour
// comes from the appearance or /DA, so a fill never doubles as it.
function freeTextBox(annot: PdfjsAnnotation): Partial<TextOverlay> {
  const box: Partial<TextOverlay> = {};
  if (toNumberArray(annot.color).length >= 3) box.fill = colorToHex(annot.color, "#ffffff");
  const border = numberValue(recordValue(annot.borderStyle)?.width, 0);
  if (border > 0) box.borderWidth = border;
  return { ...box, ...translucency(annot) };
}

type AppearanceTurn = { angle: number; w: number; h: number };

function appearanceTurn(annot: PdfjsAnnotation): AppearanceTurn | undefined {
  const turn = recordValue(annot.appearanceTurn);
  if (!turn) return undefined;
  const [angle, w, h] = [turn.angle, turn.w, turn.h].map((n) => numberValue(n, NaN));
  return angle! > 0 && w! > 0 && h! > 0 ? { angle: angle!, w: w!, h: h! } : undefined;
}

// The unturned box a turn was drawn from, about the centre of /Rect.
function turnedBox(rect: { x: number; y: number; w: number; h: number }, turn: AppearanceTurn) {
  return { x: rect.x + (rect.w - turn.w) / 2, y: rect.y + (rect.h - turn.h) / 2, w: turn.w, h: turn.h };
}

function stampKindFromText(text: string): StampOverlay["kind"] | null {
  const trimmed = text.trim();
  if (trimmed === "✓") return "check";
  if (trimmed === "✗") return "cross";
  return null;
}

function isZapfDingbatsAppearance(
  annot: PdfjsAnnotation,
  appearance: Record<string, unknown> | null,
): boolean {
  const fontName = String(appearance?.fontName ?? "").toLowerCase();
  if (fontName.includes("zapf")) return true;
  return defaultAppearanceString(annot).toLowerCase().includes("zapf");
}

export function parseDefaultAppearanceFontSize(
  annot: PdfjsAnnotation,
  appearance: Record<string, unknown> | null,
): number {
  const fromAppearance = numberValue(appearance?.fontSize, NaN);
  if (fromAppearance > 0) return fromAppearance;

  const match = defaultAppearanceString(annot).match(/\S+\s+(\d+(?:\.\d+)?)\s+Tf/);
  const fromDefaultAppearance = match ? Number(match[1]) : NaN;
  return Number.isFinite(fromDefaultAppearance) && fromDefaultAppearance > 0
    ? fromDefaultAppearance
    : 14;
}

function defaultAppearanceString(annot: PdfjsAnnotation): string {
  if (typeof annot.defaultAppearance === "string") return annot.defaultAppearance;
  if (typeof annot.defaultAppearanceString === "string") {
    return annot.defaultAppearanceString;
  }
  return "";
}

export function annotationType(annot: PdfjsAnnotation): number | null {
  const numeric = numberValue(annot.annotationType, NaN);
  if (Number.isFinite(numeric)) return numeric;
  switch (annot.subtype) {
    case "Text":
      return ANNOT.TEXT;
    case "FreeText":
      return ANNOT.FREETEXT;
    case "Square":
      return ANNOT.SQUARE;
    case "Highlight":
      return ANNOT.HIGHLIGHT;
    case "Underline":
      return ANNOT.UNDERLINE;
    case "StrikeOut":
      return ANNOT.STRIKEOUT;
    case "Ink":
      return ANNOT.INK;
    default:
      return null;
  }
}

export function rectFromAnnot(annot: PdfjsAnnotation) {
  const raw = toNumberArray(annot.rect);
  if (raw.length < 4) return null;
  const x1 = raw[0]!;
  const y1 = raw[1]!;
  const x2 = raw[2]!;
  const y2 = raw[3]!;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

function quadPointsToRects(points: number[]) {
  const rects = [];
  for (let i = 0; i + 7 < points.length; i += 8) {
    const xs = [points[i]!, points[i + 2]!, points[i + 4]!, points[i + 6]!];
    const ys = [points[i + 1]!, points[i + 3]!, points[i + 5]!, points[i + 7]!];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    rects.push({
      x,
      y,
      w: Math.max(...xs) - x,
      h: Math.max(...ys) - y,
    });
  }
  return rects;
}

/**
 * A listed colour as #rrggbb. The listing holds colours as pdf.js does, RGB
 * bytes 0–255 (./pdfjsValues.ts), so a channel of 1 is 1/255, not full.
 */
export function colorToHex(value: unknown, fallback: string): string {
  const parts = toNumberArray(value);
  if (parts.length < 3) return fallback;
  const hex = parts
    .slice(0, 3)
    .map((part) => {
      const channel = Math.round(part);
      return Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0");
    })
    .join("");
  return `#${hex}`;
}

export function contentsText(annot: PdfjsAnnotation): string {
  const contents = recordValue(annot.contentsObj);
  if (typeof contents?.str === "string") {
    return contents.str.slice(0, MAX_IMPORTED_ANNOTATION_TEXT_CHARACTERS);
  }
  if (Array.isArray(annot.textContent)) {
    let text = "";
    for (const part of annot.textContent) {
      if (typeof part !== "string") continue;
      const remaining = MAX_IMPORTED_ANNOTATION_TEXT_CHARACTERS - text.length;
      if (remaining <= 0) break;
      if (text) text += "\n";
      text += part.slice(0, remaining);
    }
    return text.slice(0, MAX_IMPORTED_ANNOTATION_TEXT_CHARACTERS);
  }
  return "";
}

export function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampOpacity(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function toNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    if (value.length > MAX_IMPORTED_NUMBER_ARRAY_VALUES) return [];
    return value.filter((n): n is number => typeof n === "number");
  }
  if (ArrayBuffer.isView(value) && "length" in value) {
    if ((value as unknown as ArrayLike<number>).length > MAX_IMPORTED_NUMBER_ARRAY_VALUES) {
      return [];
    }
    return Array.from(value as unknown as ArrayLike<number>);
  }
  const record = recordValue(value);
  if (!record) return [];
  const numericKeys: string[] = [];
  for (const key in record) {
    if (!/^\d+$/.test(key) || typeof record[key] !== "number") continue;
    numericKeys.push(key);
    if (numericKeys.length > MAX_IMPORTED_NUMBER_ARRAY_VALUES) return [];
  }
  return numericKeys
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => record[key] as number);
}

export function alignFromNumber(q: number): TextOverlay["align"] {
  if (q === 1) return "center";
  if (q === 2) return "right";
  return "left";
}
