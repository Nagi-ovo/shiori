import {
  displayRectToPdf,
  displayToPdf,
  rotatedSize,
} from "../../../pdf/geometry/coords";
import { compactInkPath } from "../../../pdf/geometry/simplifyPath";
import type {
  InkOverlay,
  ImageOverlay,
  NoteOverlay,
  PageModel,
  PdfRect,
  RectOverlay,
  StampOverlay,
  TextOverlay,
} from "../../../pdf/model/types";
import {
  createNoteOverlay,
  NOTE_DEFAULT_HEIGHT_PT,
  NOTE_DEFAULT_WIDTH_PT,
} from "../../../pdf/model/note";
import type { SavedSignature } from "../../../storage/signatures";
import { signatureToOverlay } from "../../../storage/signatures";
import type { AnnotationDefaults, Store } from "../../store/store";
import type { DragState } from "../../overlays/dragState";
import {
  STAMP_DEFAULT_SIZE_PT,
  STAMP_MIN_SIZE_PT,
} from "./overlayConstants";

type CreationDrag = Extract<
  DragState,
  { kind: "ink" | "rect" | "highlight" | "stamp" | "note" | "text" | "signature" }
>;
type CreatedOverlay =
  | InkOverlay
  | ImageOverlay
  | StampOverlay
  | RectOverlay
  | NoteOverlay
  | TextOverlay;

export type OverlayCreationResult =
  | { kind: "none" }
  | { kind: "highlight"; rect: PdfRect }
  | {
      kind: "overlay";
      overlay: CreatedOverlay;
      edit: boolean;
      focus: boolean;
      clearEditingFirst: boolean;
    };

export function isCreationDrag(drag: DragState): drag is CreationDrag {
  return (
    drag.kind === "ink" ||
    drag.kind === "rect" ||
    drag.kind === "highlight" ||
    drag.kind === "stamp" ||
    drag.kind === "signature" ||
    drag.kind === "note" ||
    drag.kind === "text"
  );
}

export function finishCreationDrag({
  drag,
  page,
  scale,
  annotDefaults,
  textDefaults,
  activeSignature,
  makeId,
}: {
  drag: CreationDrag;
  page: PageModel;
  scale: number;
  annotDefaults: AnnotationDefaults;
  textDefaults: Store["textDefaults"];
  activeSignature: SavedSignature | null;
  makeId: () => string;
}): OverlayCreationResult {
  if (drag.kind === "ink") {
    if (drag.points.length <= 1) return { kind: "none" };
    const pathPdf = drag.points.map((point) =>
      displayToPdf(point, page.widthPt, page.heightPt, page.rotation, scale),
    );
    // Drop sub-perceptual points and trim coordinate precision before the
    // stroke enters the model — pointermove captures far more points than the
    // shape needs, and they otherwise dominate draft/export size.
    const compactPath = compactInkPath(pathPdf);
    return {
      kind: "overlay",
      overlay: {
        type: "ink",
        id: makeId(),
        pageId: page.id,
        paths: [compactPath],
        color: annotDefaults.inkColor,
        width: annotDefaults.inkWidth,
      } satisfies InkOverlay,
      edit: false,
      focus: false,
      clearEditingFirst: false,
    };
  }

  const displayRect = creationDisplayRect(drag);
  const minSize =
    drag.kind === "highlight"
      ? 4
      : drag.kind === "stamp"
        ? STAMP_MIN_SIZE_PT * scale
        : drag.kind === "signature"
          ? 8
        : 8;
  const tooSmall = displayRect.w < minSize || displayRect.h < minSize;
  if (tooSmall) {
    return finishSmallCreationDrag({
      drag,
      page,
      scale,
      annotDefaults,
      textDefaults,
      activeSignature,
      makeId,
    });
  }

  const rect = displayRectToPdf(
    displayRect,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  if (drag.kind === "highlight") {
    return { kind: "highlight", rect };
  }
  if (drag.kind === "stamp") {
    return overlayResult(createStampOverlay(makeId(), page.id, rect, annotDefaults));
  }
  if (drag.kind === "rect") {
    return overlayResult(createRectOverlay(makeId(), page.id, rect, annotDefaults));
  }
  if (drag.kind === "signature") {
    if (!activeSignature) return { kind: "none" };
    return overlayResult(signatureToOverlay(activeSignature, rect, page.id, makeId));
  }
  if (drag.kind === "note") {
    return overlayResult(
      createNoteOverlay({
        id: makeId(),
        pageId: page.id,
        rect,
        color: annotDefaults.noteColor,
      }),
      { edit: true },
    );
  }
  return overlayResult(
    createTextOverlay(makeId(), page.id, rect, textDefaults),
    { edit: true, focus: true, clearEditingFirst: true },
  );
}

function finishSmallCreationDrag({
  drag,
  page,
  scale,
  annotDefaults,
  textDefaults,
  activeSignature,
  makeId,
}: {
  drag: Exclude<CreationDrag, { kind: "ink" }>;
  page: PageModel;
  scale: number;
  annotDefaults: AnnotationDefaults;
  textDefaults: Store["textDefaults"];
  activeSignature: SavedSignature | null;
  makeId: () => string;
}): OverlayCreationResult {
  if (drag.kind === "stamp") {
    const size = STAMP_DEFAULT_SIZE_PT * scale;
    const rect = displayRectToPdf(
      {
        x: drag.startX - size / 2,
        y: drag.startY - size / 2,
        w: size,
        h: size,
      },
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    );
    return overlayResult(createStampOverlay(makeId(), page.id, rect, annotDefaults));
  }
  if (drag.kind === "text") {
    const rect = displayRectToPdf(
      { x: drag.startX, y: drag.startY, w: 180, h: 42 },
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    );
    return overlayResult(
      createTextOverlay(makeId(), page.id, rect, textDefaults),
      { edit: true, focus: true, clearEditingFirst: true },
    );
  }
  if (drag.kind === "note") {
    const displaySize = rotatedSize(
      NOTE_DEFAULT_WIDTH_PT,
      NOTE_DEFAULT_HEIGHT_PT,
      page.rotation,
    );
    const rect = displayRectToPdf(
      {
        x: drag.startX,
        y: drag.startY,
        // Note defaults are PDF-space dimensions. Multiply before the
        // display→PDF conversion so zoom never changes the physical size.
        w: displaySize.width * scale,
        h: displaySize.height * scale,
      },
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    );
    return overlayResult(
      createNoteOverlay({
        id: makeId(),
        pageId: page.id,
        rect,
        color: annotDefaults.noteColor,
      }),
      { edit: true, focus: true },
    );
  }
  if (drag.kind === "signature") {
    if (!activeSignature) return { kind: "none" };
    const w = 180;
    const h = w / Math.max(1, activeSignature.aspectRatio);
    const rect = displayRectToPdf(
      { x: drag.startX - w / 2, y: drag.startY - h / 2, w, h },
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    );
    return overlayResult(signatureToOverlay(activeSignature, rect, page.id, makeId));
  }
  return { kind: "none" };
}

function creationDisplayRect(
  drag: Exclude<CreationDrag, { kind: "ink" }>,
): { x: number; y: number; w: number; h: number } {
  const x = Math.min(drag.startX, drag.curX);
  const y = Math.min(drag.startY, drag.curY);
  const w = Math.abs(drag.curX - drag.startX);
  const h = Math.abs(drag.curY - drag.startY);
  return { x, y, w, h };
}

function createStampOverlay(
  id: string,
  pageId: string,
  rect: PdfRect,
  annotDefaults: AnnotationDefaults,
): StampOverlay {
  return {
    type: "stamp",
    id,
    pageId,
    kind: annotDefaults.stampKind,
    rect,
    color: annotDefaults.stampColor,
    strokeWidth: annotDefaults.stampStrokeWidth,
  };
}

function createRectOverlay(
  id: string,
  pageId: string,
  rect: PdfRect,
  annotDefaults: AnnotationDefaults,
): RectOverlay {
  return {
    type: "rect",
    id,
    pageId,
    rect,
    color: annotDefaults.rectColor,
    strokeWidth: annotDefaults.rectStrokeWidth,
    fill: annotDefaults.rectFill,
  };
}

function createTextOverlay(
  id: string,
  pageId: string,
  rect: PdfRect,
  textDefaults: Store["textDefaults"],
): TextOverlay {
  return {
    type: "text",
    id,
    pageId,
    rect,
    text: "",
    fontSize: textDefaults.fontSize,
    color: textDefaults.color,
    bold: textDefaults.bold,
    italic: textDefaults.italic,
    align: textDefaults.align,
    fontFamily: textDefaults.fontFamily,
  };
}

function overlayResult(
  overlay: CreatedOverlay,
  options: Partial<
    Pick<
      Extract<OverlayCreationResult, { kind: "overlay" }>,
      "edit" | "focus" | "clearEditingFirst"
    >
  > = {},
): OverlayCreationResult {
  return {
    kind: "overlay",
    overlay,
    edit: options.edit ?? false,
    focus: options.focus ?? false,
    clearEditingFirst: options.clearEditingFirst ?? false,
  };
}
