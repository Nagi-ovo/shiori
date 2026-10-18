import type {
  CalloutOverlay,
  FontFamily,
  HighlightOverlay,
  InkOverlay,
  Overlay,
  PageModel,
  PdfPoint,
  PdfRect,
  RectOverlay,
  StampOverlay,
  StrikeOutOverlay,
  TextOverlay,
  UnderlineOverlay,
} from "../model/types";
import {
  CALLOUT_DEFAULT_COLOR,
  CALLOUT_DEFAULT_FONT_SIZE_PT,
  createCalloutOverlay,
} from "../model/callout";
import {
  createNoteOverlay,
  NOTE_DEFAULT_COLOR,
  NOTE_DEFAULT_HEIGHT_PT,
  NOTE_DEFAULT_WIDTH_PT,
} from "../model/note";
import {
  ANNOTATION_SPEC_SCHEMA,
  MAX_ABSOLUTE_NUMBER,
  MAX_PATHS_PER_ANNOTATION,
  MAX_POINTS_PER_ANNOTATION,
  MAX_RECTS_PER_ANNOTATION,
  annotationSpecViolation,
} from "./spec";

type JsonObject = Record<string, unknown>;
type TextMarkupType = "highlight" | "underline" | "strikethrough";
const MAX_SPEC_ERROR_BYTES = 2_048;
const TRUNCATION_MARKER = "…";
const TRUNCATION_MARKER_BYTES = new TextEncoder().encode(TRUNCATION_MARKER).length;
type PortableAnnotationType =
  | TextMarkupType
  | "note"
  | "ink"
  | "rect"
  | "stamp"
  | "callout"
  | "text";

export type ParseAnnotationSpecOptions = {
  /** Unique per request/patch. It is embedded in every generated overlay id. */
  namespace: string;
  idPrefix?: string;
  /** Shared timestamp for every note in this atomic parse. */
  now?: number;
};

export class AnnotationSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnnotationSpecError";
  }
}

const DEFAULT_HIGHLIGHT_COLOR = "#f6c744";
const DEFAULT_HIGHLIGHT_OPACITY = 0.35;
const DEFAULT_LINE_COLOR = "#b13a2e";
const DEFAULT_LINE_OPACITY = 1;
const DEFAULT_TEXT_COLOR = "#1a1815";
const DEFAULT_STROKE_WIDTH = 2;
const DEFAULT_FONT_SIZE = 14;
export function parseAnnotationSpec(
  spec: unknown,
  pages: PageModel[],
  options: ParseAnnotationSpecOptions,
): Overlay[] {
  if (!isObject(spec)) fail("Spec JSON must be an object");
  const versioned = Object.prototype.hasOwnProperty.call(spec, "schema");
  if (versioned && spec.schema !== ANNOTATION_SPEC_SCHEMA) {
    fail(`Unsupported annotation schema: ${String(spec.schema)}`);
  }
  assertKnownKeys(spec, "spec", ["schema", "annotations"]);
  if (!Array.isArray(spec.annotations)) {
    fail("Spec annotations must be an array");
  }
  const violation = annotationSpecViolation(spec.annotations);
  if (violation) fail(violation);

  const prefix = normalizeIdPart(options.idPrefix ?? "annotation", "annotation");
  const namespace = normalizeIdPart(options.namespace, "request");
  const now = options.now ?? Date.now();
  const occupiedCallouts = new Map<string, PdfRect[]>();
  const overlays: Overlay[] = [];
  spec.annotations.forEach((entry, index) => {
    const overlay = parseAnnotation(
      entry,
      index,
      pages,
      prefix,
      namespace,
      versioned,
      now,
      occupiedCallouts,
    );
    overlays.push(overlay);
    if (overlay.type === "callout") {
      const occupied = occupiedCallouts.get(overlay.pageId) ?? [];
      occupied.push({ ...overlay.rect });
      occupiedCallouts.set(overlay.pageId, occupied);
    }
  });
  return overlays;
}

function parseAnnotation(
  value: unknown,
  index: number,
  pages: PageModel[],
  idPrefix: string,
  namespace: string,
  versioned: boolean,
  now: number,
  occupiedCallouts: ReadonlyMap<string, readonly PdfRect[]>,
): Overlay {
  const path = `annotations[${index}]`;
  if (!isObject(value)) fail(`${path} must be an object`);
  for (const field of ["locked", "angle"] as const) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      fail(`${path}.${field} is not supported by ${ANNOTATION_SPEC_SCHEMA}`);
    }
  }

  const type = value.type;
  if (type === "calloutReply") {
    // Replies patch the thread of a callout that is OPEN in the app; a PDF
    // file on disk has no live overlay ids to patch. The live bridge handles
    // pure-reply specs before this parser ever sees them.
    fail(
      `${path}.type calloutReply applies to the open document only; send it alone via 'shiori app annotate --spec' (not mixed with other annotation types)`,
    );
  }
  if (!isPortableAnnotationType(type)) {
    const suffix = typeof type === "string" ? `: ${type}` : "";
    fail(`${path}.type is unknown${suffix}`);
  }
  const pageNumber = parsePageNumber(value.page, path, pages.length);
  const page = pages[pageNumber - 1]!;
  const id = `${idPrefix}-${type}-${namespace}-${index + 1}`;

  if (type === "highlight" || type === "underline" || type === "strikethrough") {
    return parseTextMarkup(value, type, id, page.id, path, versioned);
  }
  if (type === "note") {
    assertAnnotationKeys(value, path, ["at", "text", "color"]);
    const at = parsePoint(value.at, `${path}.at`);
    return createNoteOverlay({
      id,
      pageId: page.id,
      rect: {
        x: at.x,
        y: at.y,
        w: NOTE_DEFAULT_WIDTH_PT,
        h: NOTE_DEFAULT_HEIGHT_PT,
      },
      text: parseString(value.text, `${path}.text`),
      color: parseColor(value.color, NOTE_DEFAULT_COLOR, `${path}.color`, versioned),
      now,
    });
  }
  if (type === "ink") {
    assertAnnotationKeys(value, path, ["paths", "color", "width"]);
    return {
      type,
      id,
      pageId: page.id,
      paths: parsePaths(value.paths, `${path}.paths`),
      color: parseColor(value.color, DEFAULT_LINE_COLOR, `${path}.color`, versioned),
      width: parsePositiveNumber(
        value.width,
        DEFAULT_STROKE_WIDTH,
        `${path}.width`,
        versioned,
      ),
    } satisfies InkOverlay;
  }
  if (type === "rect") {
    assertAnnotationKeys(value, path, ["rect", "color", "strokeWidth", "fill"]);
    return {
      type,
      id,
      pageId: page.id,
      rect: parseRect(value.rect, `${path}.rect`),
      color: parseColor(value.color, DEFAULT_LINE_COLOR, `${path}.color`, versioned),
      strokeWidth: parsePositiveNumber(
        value.strokeWidth,
        DEFAULT_STROKE_WIDTH,
        `${path}.strokeWidth`,
        versioned,
      ),
      fill: parseNullableColor(value.fill, `${path}.fill`, versioned),
    } satisfies RectOverlay;
  }
  if (type === "stamp") {
    assertAnnotationKeys(value, path, ["kind", "rect", "color", "strokeWidth"]);
    return {
      type,
      id,
      pageId: page.id,
      kind: parseStampKind(value.kind, `${path}.kind`),
      rect: parseRect(value.rect, `${path}.rect`),
      color: parseColor(value.color, DEFAULT_LINE_COLOR, `${path}.color`, versioned),
      strokeWidth: parsePositiveNumber(
        value.strokeWidth,
        DEFAULT_STROKE_WIDTH,
        `${path}.strokeWidth`,
        versioned,
      ),
    } satisfies StampOverlay;
  }
  if (type === "callout") {
    assertAnnotationKeys(value, path, [
      "targetRects",
      "rect",
      "leader",
      "leaderKind",
      "text",
      "fontSize",
      "color",
      "quote",
      "align",
    ]);
    if (value.quote != null && typeof value.quote !== "string") {
      fail(`${path}.quote must be a string`);
    }
    const overlay = createCalloutOverlay({
      id,
      page,
      targetRects: parseRects(value.targetRects, `${path}.targetRects`),
      ...(value.rect == null
        ? {}
        : { rect: parseRect(value.rect, `${path}.rect`) }),
      text: parseString(value.text, `${path}.text`),
      fontSize: parsePositiveNumber(
        value.fontSize,
        CALLOUT_DEFAULT_FONT_SIZE_PT,
        `${path}.fontSize`,
        versioned,
      ),
      color: parseColor(
        value.color,
        CALLOUT_DEFAULT_COLOR,
        `${path}.color`,
        versioned,
      ),
      occupiedRects: occupiedCallouts.get(page.id) ?? [],
    });
    return {
      ...overlay,
      ...(value.leader == null
        ? {}
        : { leader: parseCalloutLeader(value.leader, `${path}.leader`) }),
      ...(value.leaderKind == null
        ? {}
        : {
            leaderKind: parseCalloutLeaderKind(
              value.leaderKind,
              `${path}.leaderKind`,
            ),
          }),
      align: parseAlign(value.align, `${path}.align`, false),
    } satisfies CalloutOverlay;
  }

  assertAnnotationKeys(value, path, [
    "rect",
    "text",
    "fontSize",
    "color",
    "bold",
    "italic",
    "align",
    "fontFamily",
  ]);
  const text = parseString(value.text, `${path}.text`);
  const bold = parseBoolean(value.bold, false, `${path}.bold`, versioned);
  // italic was added as an optional compatibility field in v1.
  const italic = parseBoolean(value.italic, false, `${path}.italic`, false);
  const fontFamily = parseFontFamily(
    value.fontFamily,
    `${path}.fontFamily`,
    versioned,
  );
  if (hasNonAscii(text) && (bold || italic || fontFamily !== "sans")) {
    fail(`${path} non-ASCII text supports only regular sans in the portable schema`);
  }
  return {
    type,
    id,
    pageId: page.id,
    rect: parseRect(value.rect, `${path}.rect`),
    text,
    fontSize: parsePositiveNumber(
      value.fontSize,
      DEFAULT_FONT_SIZE,
      `${path}.fontSize`,
      versioned,
    ),
    color: parseColor(value.color, DEFAULT_TEXT_COLOR, `${path}.color`, versioned),
    bold,
    italic,
    align: parseAlign(value.align, `${path}.align`, versioned),
    fontFamily,
  } satisfies TextOverlay;
}

function parseTextMarkup(
  value: JsonObject,
  type: TextMarkupType,
  id: string,
  pageId: string,
  path: string,
  versioned: boolean,
): HighlightOverlay | UnderlineOverlay | StrikeOutOverlay {
  assertAnnotationKeys(value, path, ["rects", "color", "opacity", "quote"]);
  if (value.quote != null && typeof value.quote !== "string") {
    fail(`${path}.quote must be a string`);
  }
  if (!Array.isArray(value.rects) && typeof value.quote === "string") {
    fail(`${path}.rects are required; quote-only anchoring is not supported`);
  }
  const opacity = parseOpacity(
    value.opacity,
    type === "highlight" ? DEFAULT_HIGHLIGHT_OPACITY : DEFAULT_LINE_OPACITY,
    `${path}.opacity`,
    versioned,
  );
  if (type === "highlight" && opacity > 0.45) {
    fail(`${path}.opacity cannot exceed 0.45 for portable highlights`);
  }
  return {
    type,
    id,
    pageId,
    rects: parseRects(value.rects, `${path}.rects`),
    color: parseColor(
      value.color,
      type === "highlight" ? DEFAULT_HIGHLIGHT_COLOR : DEFAULT_LINE_COLOR,
      `${path}.color`,
      versioned,
    ),
    opacity,
  };
}

function assertAnnotationKeys(value: JsonObject, path: string, fields: string[]): void {
  assertKnownKeys(value, path, ["type", "page", ...fields]);
}

function assertKnownKeys(value: JsonObject, path: string, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) fail(`${path}.${unknown} is not supported`);
}

function parseString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} must be a string`);
  return value;
}

function parseColor(
  value: unknown,
  fallback: string,
  path: string,
  required: boolean,
): string {
  if (required && value == null) {
    fail(`${path} is required by ${ANNOTATION_SPEC_SCHEMA}`);
  }
  if (value == null) return fallback;
  if (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)) return value;
  fail(`${path} must be a #RRGGBB color`);
}

function parseOpacity(
  value: unknown,
  fallback: number,
  path: string,
  required: boolean,
): number {
  if (required && value == null) {
    fail(`${path} is required by ${ANNOTATION_SPEC_SCHEMA}`);
  }
  if (value == null) return fallback;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  ) {
    return value;
  }
  fail(`${path} must be a number from 0 to 1`);
}

function parsePositiveNumber(
  value: unknown,
  fallback: number,
  path: string,
  required: boolean,
): number {
  if (value == null) {
    if (required) fail(`${path} is required by ${ANNOTATION_SPEC_SCHEMA}`);
    return fallback;
  }
  const parsed = parseFiniteNumber(value, path);
  if (parsed <= 0) fail(`${path} must be positive`);
  return parsed;
}

function parseBoolean(
  value: unknown,
  fallback: boolean,
  path: string,
  required: boolean,
): boolean {
  if (value == null) {
    if (required) fail(`${path} is required by ${ANNOTATION_SPEC_SCHEMA}`);
    return fallback;
  }
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

function parseNullableColor(
  value: unknown,
  path: string,
  required: boolean,
): null {
  if (value === null) return null;
  if (value == null) {
    if (required) fail(`${path} is required by ${ANNOTATION_SPEC_SCHEMA}`);
    return null;
  }
  fail(`${path} must be null because filled rectangles are not portable`);
}

function parseStampKind(value: unknown, path: string): StampOverlay["kind"] {
  if (value === "check" || value === "cross") return value;
  fail(`${path} must be "check" or "cross"`);
}

function parseAlign(
  value: unknown,
  path: string,
  required: boolean,
): TextOverlay["align"] {
  if (value == null && !required) return "left";
  if (value === "left" || value === "center" || value === "right") return value;
  fail(`${path} must be left, center, or right`);
}

function parseFontFamily(
  value: unknown,
  path: string,
  required: boolean,
): Exclude<FontFamily, "notoSansSc" | "notoSansJp"> {
  if (value == null && !required) return "sans";
  if (value === "sans" || value === "serif" || value === "mono") return value;
  fail(`${path} is not a supported font family`);
}

function parsePaths(value: unknown, path: string): PdfPoint[][] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${path} must be a non-empty array`);
  }
  if (value.length > MAX_PATHS_PER_ANNOTATION) {
    fail(`${path} cannot contain more than ${MAX_PATHS_PER_ANNOTATION} paths`);
  }
  let pointCount = 0;
  return value.map((rawPath, pathIndex) => {
    if (!Array.isArray(rawPath) || rawPath.length === 0) {
      fail(`${path}[${pathIndex}] must be a non-empty array`);
    }
    pointCount += rawPath.length;
    if (pointCount > MAX_POINTS_PER_ANNOTATION) {
      fail(`${path} cannot contain more than ${MAX_POINTS_PER_ANNOTATION} points`);
    }
    return rawPath.map((point, pointIndex) =>
      parsePoint(point, `${path}[${pathIndex}][${pointIndex}]`),
    );
  });
}

function parsePageNumber(value: unknown, path: string, pageCount: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${path}.page must be a 1-based integer`);
  }
  if (value < 1 || value > pageCount) {
    fail(`${path}.page is out of range (1-${pageCount})`);
  }
  return value;
}

function parseRects(value: unknown, path: string): PdfRect[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${path} must be a non-empty array`);
  }
  if (value.length > MAX_RECTS_PER_ANNOTATION) {
    fail(`${path} cannot contain more than ${MAX_RECTS_PER_ANNOTATION} rectangles`);
  }
  return value.map((rect, index) => parseRect(rect, `${path}[${index}]`));
}

function parseRect(value: unknown, path: string): PdfRect {
  if (!isObject(value)) fail(`${path} must be an object`);
  assertKnownKeys(value, path, ["x", "y", "w", "h"]);
  const rect = {
    x: parseFiniteNumber(value.x, `${path}.x`),
    y: parseFiniteNumber(value.y, `${path}.y`),
    w: parseFiniteNumber(value.w, `${path}.w`),
    h: parseFiniteNumber(value.h, `${path}.h`),
  };
  if (rect.w <= 0 || rect.h <= 0) {
    fail(`${path}.w and ${path}.h must be positive`);
  }
  return rect;
}

function parsePoint(value: unknown, path: string): PdfPoint {
  if (!isObject(value)) fail(`${path} must be an object`);
  assertKnownKeys(value, path, ["x", "y"]);
  return {
    x: parseFiniteNumber(value.x, `${path}.x`),
    y: parseFiniteNumber(value.y, `${path}.y`),
  };
}

function parseCalloutLeader(value: unknown, path: string): PdfPoint[] {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) {
    fail(`${path} must contain 2 or 3 points`);
  }
  return value.map((point, index) => parsePoint(point, `${path}[${index}]`));
}

function parseCalloutLeaderKind(
  value: unknown,
  path: string,
): NonNullable<CalloutOverlay["leaderKind"]> {
  if (value === "polyline" || value === "quadratic") return value;
  fail(`${path} must be polyline or quadratic`);
}

function parseFiniteNumber(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_ABSOLUTE_NUMBER
  ) {
    fail(
      `${path} must be a finite number no larger than ${MAX_ABSOLUTE_NUMBER} in magnitude`,
    );
  }
  return value;
}

function isPortableAnnotationType(value: unknown): value is PortableAnnotationType {
  return (
    value === "highlight" ||
    value === "underline" ||
    value === "strikethrough" ||
    value === "note" ||
    value === "ink" ||
    value === "rect" ||
    value === "stamp" ||
    value === "callout" ||
    value === "text"
  );
}

function normalizeIdPart(value: string, fallback: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
  return normalized || fallback;
}

function hasNonAscii(text: string): boolean {
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) return true;
  }
  return false;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new AnnotationSpecError(boundSpecErrorMessage(message));
}

function boundSpecErrorMessage(message: string): string {
  const encoder = new TextEncoder();
  const contentBudget = MAX_SPEC_ERROR_BYTES - TRUNCATION_MARKER_BYTES;
  let bytes = 0;
  let bounded = "";
  for (const character of message) {
    const characterBytes = encoder.encode(character).length;
    if (bytes + characterBytes > contentBudget) {
      return `${bounded}${TRUNCATION_MARKER}`;
    }
    bounded += character;
    bytes += characterBytes;
  }
  return bounded;
}
