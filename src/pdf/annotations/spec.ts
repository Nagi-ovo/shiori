import type {
  CalloutOverlay,
  FontFamily,
  InkOverlay,
  PdfPoint,
  PdfRect,
  StampOverlay,
  TextOverlay,
} from "../model/types";

export const ANNOTATION_SPEC_SCHEMA = "shiori.annotations/v1" as const;
export const MAX_ANNOTATIONS_PER_SPEC = 5_000;
export const MAX_ANNOTATION_SPEC_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_CHARACTERS = 32_768;
export const MAX_TOTAL_TEXT_CHARACTERS = 262_144;
export const MAX_RECTS_PER_ANNOTATION = 10_000;
export const MAX_TOTAL_RECTS_PER_SPEC = 100_000;
export const MAX_PATHS_PER_ANNOTATION = 10_000;
export const MAX_POINTS_PER_ANNOTATION = 100_000;
export const MAX_ABSOLUTE_NUMBER = 1_000_000;

type AnnotationCommon = {
  page: number;
};

/**
 * Quote anchor: the agent-facing way to place text markup and notes. The
 * anchor is resolved to coordinates BEFORE parseAnnotationSpec ever sees the
 * spec (see resolveAnchors.ts); the parser itself stays geometry-only.
 * Matching semantics are exactly `shiori search`'s: case-insensitive,
 * whitespace-normalized, non-overlapping, reading order.
 */
export type AnnotationAnchor = {
  quote: string;
  /** 1-based; restricts the search to one page. */
  page?: number;
  /** 1-based pick in reading order: global without page, page-local with it. */
  occurrence?: number;
};

export type TextMarkupSpec = AnnotationCommon & {
  type: "highlight" | "underline" | "strikethrough";
  rects: PdfRect[];
  color: string;
  opacity: number;
  /** Informational text recovered from the rectangles; never an anchor. */
  quote?: string;
};

export type NoteSpec = AnnotationCommon & {
  type: "note";
  at: PdfPoint;
  text: string;
  color: string;
};

export type InkSpec = AnnotationCommon & {
  type: "ink";
  paths: InkOverlay["paths"];
  color: string;
  width: number;
};

export type RectSpec = AnnotationCommon & {
  type: "rect";
  rect: PdfRect;
  color: string;
  strokeWidth: number;
  fill: null;
};

export type StampSpec = AnnotationCommon & {
  type: "stamp";
  kind: StampOverlay["kind"];
  rect: PdfRect;
  color: string;
  strokeWidth: number;
};

export type TextSpec = AnnotationCommon & {
  type: "text";
  rect: PdfRect;
  text: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic?: boolean;
  align: TextOverlay["align"];
  fontFamily: Exclude<FontFamily, "notoSansSc" | "notoSansJp">;
};

export type CalloutSpec = AnnotationCommon & {
  type: "callout";
  /** The semantic source target; an anchor resolves into these rectangles. */
  targetRects: PdfRect[];
  /** Optional for creation (Shiori auto-places it), emitted by extract. */
  rect?: PdfRect;
  /** Optional target -> knee -> label PDF leader geometry (2 or 3 points). */
  leader?: PdfPoint[];
  leaderKind?: CalloutOverlay["leaderKind"];
  text: string;
  fontSize: number;
  color: string;
  /** Informational text recovered from targetRects; never an anchor. */
  quote?: string;
  align?: CalloutOverlay["align"];
};

export type AnnotationSpecAnnotation =
  | TextMarkupSpec
  | NoteSpec
  | InkSpec
  | RectSpec
  | StampSpec
  | CalloutSpec
  | TextSpec;

export type AnnotationSpecV1 = {
  schema: typeof ANNOTATION_SPEC_SCHEMA;
  annotations: AnnotationSpecAnnotation[];
};

export function annotationSpec(
  annotations: AnnotationSpecAnnotation[],
): AnnotationSpecV1 {
  return { schema: ANNOTATION_SPEC_SCHEMA, annotations };
}

export function annotationSpecViolation(
  annotations: readonly unknown[],
): string | null {
  if (annotations.length > MAX_ANNOTATIONS_PER_SPEC) {
    return `Spec cannot contain more than ${MAX_ANNOTATIONS_PER_SPEC} annotations`;
  }

  let totalNoteCharacters = 0;
  let totalTextCharacters = 0;
  let totalRects = 0;
  for (let index = 0; index < annotations.length; index += 1) {
    const annotation = annotations[index];
    if (!isObject(annotation)) continue;
    for (const field of ["text", "originalText", "quote"] as const) {
      const value = annotation[field];
      if (typeof value !== "string") continue;
      if (value.length > MAX_TEXT_CHARACTERS) {
        return `annotations[${index}].${field} exceeds ${MAX_TEXT_CHARACTERS} characters`;
      }
      totalTextCharacters += value.length;
    }
    // anchor.quote shares the text budgets, or a nested quote would slip
    // past the total cap entirely.
    const anchor = annotation.anchor;
    if (isObject(anchor) && typeof anchor.quote === "string") {
      if (anchor.quote.length > MAX_TEXT_CHARACTERS) {
        return `annotations[${index}].anchor.quote exceeds ${MAX_TEXT_CHARACTERS} characters`;
      }
      totalTextCharacters += anchor.quote.length;
    }
    if (
      (annotation.type === "note" || annotation.type === "callout") &&
      typeof annotation.text === "string"
    ) {
      totalNoteCharacters += annotation.text.length;
      if (totalNoteCharacters > MAX_TOTAL_TEXT_CHARACTERS) {
        return `Spec note text exceeds ${MAX_TOTAL_TEXT_CHARACTERS} total characters`;
      }
    }
  }
  if (totalTextCharacters > MAX_TOTAL_TEXT_CHARACTERS) {
    return `Spec text exceeds ${MAX_TOTAL_TEXT_CHARACTERS} total characters`;
  }

  for (let index = 0; index < annotations.length; index += 1) {
    const annotation = annotations[index];
    if (!isObject(annotation)) continue;
    if (Array.isArray(annotation.rects)) {
      if (annotation.rects.length > MAX_RECTS_PER_ANNOTATION) {
        return `annotations[${index}].rects cannot contain more than ${MAX_RECTS_PER_ANNOTATION} rectangles`;
      }
      totalRects += annotation.rects.length;
      if (totalRects > MAX_TOTAL_RECTS_PER_SPEC) {
        return `Spec cannot contain more than ${MAX_TOTAL_RECTS_PER_SPEC} rectangles in total`;
      }
    }
    if (Array.isArray(annotation.targetRects)) {
      if (annotation.targetRects.length > MAX_RECTS_PER_ANNOTATION) {
        return `annotations[${index}].targetRects cannot contain more than ${MAX_RECTS_PER_ANNOTATION} rectangles`;
      }
      totalRects += annotation.targetRects.length;
      if (totalRects > MAX_TOTAL_RECTS_PER_SPEC) {
        return `Spec cannot contain more than ${MAX_TOTAL_RECTS_PER_SPEC} rectangles in total`;
      }
    }
    if (Array.isArray(annotation.paths)) {
      if (annotation.paths.length > MAX_PATHS_PER_ANNOTATION) {
        return `annotations[${index}].paths cannot contain more than ${MAX_PATHS_PER_ANNOTATION} paths`;
      }
      let points = 0;
      for (const path of annotation.paths) {
        if (Array.isArray(path)) points += path.length;
        if (points > MAX_POINTS_PER_ANNOTATION) {
          return `annotations[${index}].paths cannot contain more than ${MAX_POINTS_PER_ANNOTATION} points`;
        }
      }
    }
    const numericViolation = invalidNumberPath(
      annotation,
      `annotations[${index}]`,
    );
    if (numericViolation) {
      return `${numericViolation} must be a finite number no larger than ${MAX_ABSOLUTE_NUMBER} in magnitude`;
    }
    const valueViolation = annotationValueViolation(
      annotation,
      `annotations[${index}]`,
    );
    if (valueViolation) return valueViolation;
  }
  return null;
}

function annotationValueViolation(
  annotation: Record<string, unknown>,
  path: string,
): string | null {
  if (
    annotation.page != null &&
    (!Number.isInteger(annotation.page) || Number(annotation.page) < 1)
  ) {
    return `${path}.page must be a 1-based integer`;
  }
  if (annotation.color != null && !isHexColor(annotation.color)) {
    return `${path}.color must be a #RRGGBB color`;
  }

  const type = annotation.type;
  const anchorViolation = anchorValueViolation(annotation, path);
  if (anchorViolation) return anchorViolation;
  if (type === "highlight" || type === "underline" || type === "strikethrough") {
    const rectViolation = rectArrayViolation(annotation.rects, `${path}.rects`);
    if (rectViolation) return rectViolation;
    if (
      annotation.opacity != null &&
      (typeof annotation.opacity !== "number" ||
        annotation.opacity < 0 ||
        annotation.opacity > 1)
    ) {
      return `${path}.opacity must be a number from 0 to 1`;
    }
    if (type === "highlight" && Number(annotation.opacity) > 0.45) {
      return `${path}.opacity cannot exceed 0.45 for portable highlights`;
    }
    if (annotation.quote != null && typeof annotation.quote !== "string") {
      return `${path}.quote must be a string`;
    }
    return null;
  }
  if (type === "note") {
    const pointViolation = pointValueViolation(annotation.at, `${path}.at`);
    if (pointViolation) return pointViolation;
    if (annotation.text != null && typeof annotation.text !== "string") {
      return `${path}.text must be a string`;
    }
    return null;
  }
  if (type === "callout") {
    const targetsViolation = rectArrayViolation(
      annotation.targetRects,
      `${path}.targetRects`,
    );
    if (targetsViolation) return targetsViolation;
    const rectViolation = rectValueViolation(annotation.rect, `${path}.rect`);
    if (rectViolation) return rectViolation;
    if (annotation.leader != null) {
      if (
        !Array.isArray(annotation.leader) ||
        (annotation.leader.length !== 2 && annotation.leader.length !== 3)
      ) {
        return `${path}.leader must contain 2 or 3 points`;
      }
      for (let index = 0; index < annotation.leader.length; index += 1) {
        const pointViolation = pointValueViolation(
          annotation.leader[index],
          `${path}.leader[${index}]`,
        );
        if (pointViolation) return pointViolation;
      }
    }
    if (
      annotation.leaderKind != null &&
      annotation.leaderKind !== "polyline" &&
      annotation.leaderKind !== "quadratic"
    ) {
      return `${path}.leaderKind must be polyline or quadratic`;
    }
    if (annotation.text != null && typeof annotation.text !== "string") {
      return `${path}.text must be a string`;
    }
    if (annotation.quote != null && typeof annotation.quote !== "string") {
      return `${path}.quote must be a string`;
    }
    const sizeViolation = positiveValueViolation(
      annotation.fontSize,
      `${path}.fontSize`,
    );
    if (sizeViolation) return sizeViolation;
    if (
      annotation.align != null &&
      annotation.align !== "left" &&
      annotation.align !== "center" &&
      annotation.align !== "right"
    ) {
      return `${path}.align must be left, center, or right`;
    }
    return null;
  }
  if (type === "ink") {
    if (annotation.paths != null) {
      if (!Array.isArray(annotation.paths) || annotation.paths.length === 0) {
        return `${path}.paths must be a non-empty array`;
      }
      for (let pathIndex = 0; pathIndex < annotation.paths.length; pathIndex += 1) {
        const points = annotation.paths[pathIndex];
        if (!Array.isArray(points) || points.length === 0) {
          return `${path}.paths[${pathIndex}] must be a non-empty array`;
        }
        for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
          const pointViolation = pointValueViolation(
            points[pointIndex],
            `${path}.paths[${pathIndex}][${pointIndex}]`,
          );
          if (pointViolation) return pointViolation;
        }
      }
    }
    return positiveValueViolation(annotation.width, `${path}.width`);
  }
  if (type === "rect" || type === "stamp" || type === "text") {
    const rectViolation = rectValueViolation(annotation.rect, `${path}.rect`);
    if (rectViolation) return rectViolation;
  }
  if (type === "rect") {
    const widthViolation = positiveValueViolation(
      annotation.strokeWidth,
      `${path}.strokeWidth`,
    );
    if (widthViolation) return widthViolation;
    if (annotation.fill !== undefined && annotation.fill !== null) {
      return `${path}.fill must be null because filled rectangles are not portable`;
    }
    return null;
  }
  if (type === "stamp") {
    if (annotation.kind != null && annotation.kind !== "check" && annotation.kind !== "cross") {
      return `${path}.kind must be "check" or "cross"`;
    }
    return positiveValueViolation(annotation.strokeWidth, `${path}.strokeWidth`);
  }
  if (type === "text") {
    if (annotation.text != null && typeof annotation.text !== "string") {
      return `${path}.text must be a string`;
    }
    const sizeViolation = positiveValueViolation(
      annotation.fontSize,
      `${path}.fontSize`,
    );
    if (sizeViolation) return sizeViolation;
    if (annotation.bold != null && typeof annotation.bold !== "boolean") {
      return `${path}.bold must be a boolean`;
    }
    if (annotation.italic != null && typeof annotation.italic !== "boolean") {
      return `${path}.italic must be a boolean`;
    }
    if (
      annotation.align != null &&
      annotation.align !== "left" &&
      annotation.align !== "center" &&
      annotation.align !== "right"
    ) {
      return `${path}.align must be left, center, or right`;
    }
    if (
      annotation.fontFamily != null &&
      annotation.fontFamily !== "sans" &&
      annotation.fontFamily !== "serif" &&
      annotation.fontFamily !== "mono"
    ) {
      return `${path}.fontFamily is not a supported font family`;
    }
    if (
      typeof annotation.text === "string" &&
      hasNonAscii(annotation.text) &&
      (annotation.bold === true ||
        annotation.italic === true ||
        (annotation.fontFamily != null && annotation.fontFamily !== "sans"))
    ) {
      return `${path} non-ASCII text supports only regular sans in the portable schema`;
    }
  }
  return null;
}

const ANCHOR_KEYS = new Set(["quote", "page", "occurrence"]);

function anchorValueViolation(
  annotation: Record<string, unknown>,
  path: string,
): string | null {
  if (!hasOwn(annotation, "anchor")) return null;
  const anchor = annotation.anchor;
  const type = annotation.type;
  const geometryField =
    type === "highlight" || type === "underline" || type === "strikethrough"
      ? "rects"
      : type === "note"
        ? "at"
        : type === "callout"
          ? "targetRects"
        : null;
  if (geometryField === null) {
    return `${path}.anchor is only supported for highlight, underline, strikethrough, note, and callout`;
  }
  if (!isObject(anchor)) {
    return `${path}.anchor must be an object`;
  }
  // Exactly one way to say each thing: anchors replace the geometry, page
  // scoping lives inside the anchor, and quote is written by the resolver.
  if (hasOwn(annotation, geometryField)) {
    return `${path}.anchor and ${path}.${geometryField} are mutually exclusive`;
  }
  if (hasOwn(annotation, "page")) {
    return `${path}.page must be omitted when ${path}.anchor is present; use ${path}.anchor.page`;
  }
  if (
    (geometryField === "rects" || geometryField === "targetRects") &&
    hasOwn(annotation, "quote")
  ) {
    return `${path}.quote is written by anchor resolution and must be omitted`;
  }
  for (const key of Object.keys(anchor)) {
    if (!ANCHOR_KEYS.has(key)) {
      return `${path}.anchor.${key} is not supported`;
    }
  }
  if (
    typeof anchor.quote !== "string" ||
    anchor.quote.trim().length === 0
  ) {
    return `${path}.anchor.quote must be a non-empty string`;
  }
  if (
    hasOwn(anchor, "page") &&
    (!Number.isInteger(anchor.page) || Number(anchor.page) < 1)
  ) {
    return `${path}.anchor.page must be a 1-based integer`;
  }
  if (
    hasOwn(anchor, "occurrence") &&
    (!Number.isInteger(anchor.occurrence) || Number(anchor.occurrence) < 1)
  ) {
    return `${path}.anchor.occurrence must be a 1-based integer`;
  }
  return null;
}

function rectArrayViolation(value: unknown, path: string): string | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    return `${path} must be a non-empty array`;
  }
  for (let index = 0; index < value.length; index += 1) {
    const violation = rectValueViolation(value[index], `${path}[${index}]`);
    if (violation) return violation;
  }
  return null;
}

function rectValueViolation(value: unknown, path: string): string | null {
  if (value == null) return null;
  if (!isObject(value)) return `${path} must be an object`;
  if (typeof value.w === "number" && typeof value.h === "number") {
    if (value.w <= 0 || value.h <= 0) {
      return `${path}.w and ${path}.h must be positive`;
    }
  }
  return null;
}

function pointValueViolation(value: unknown, path: string): string | null {
  return value == null || isObject(value) ? null : `${path} must be an object`;
}

function positiveValueViolation(value: unknown, path: string): string | null {
  return typeof value === "number" && value <= 0
    ? `${path} must be positive`
    : null;
}

function isHexColor(value: unknown): boolean {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function hasNonAscii(value: string): boolean {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) return true;
  }
  return false;
}

export function annotationSpecByteLength(spec: AnnotationSpecV1): number {
  // console.log writes one trailing LF; include it so a redirected --as-spec
  // file is guaranteed to stay inside annotate's byte limit.
  return new TextEncoder().encode(`${JSON.stringify(spec)}\n`).byteLength;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidNumberPath(value: unknown, path: string): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NUMBER
      ? null
      : path;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const invalid = invalidNumberPath(value[index], `${path}[${index}]`);
      if (invalid) return invalid;
    }
    return null;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const invalid = invalidNumberPath(entry, `${path}.${key}`);
      if (invalid) return invalid;
    }
  }
  return null;
}
