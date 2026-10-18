import type {
  CalloutOverlay,
  ContentTextOverlay,
  HighlightOverlay,
  ImageOverlay,
  InkOverlay,
  NoteOverlay,
  Overlay,
  RectOverlay,
  StampOverlay,
  StrikeOutOverlay,
  TextOverlay,
  ToolId,
  UnderlineOverlay,
} from "../../../pdf/model/types";

export type TextMarkupOverlay =
  | HighlightOverlay
  | UnderlineOverlay
  | StrikeOutOverlay;

export type ResizableOverlay =
  | RectOverlay
  | ImageOverlay
  | InkOverlay
  | StampOverlay
  | NoteOverlay
  | CalloutOverlay
  | TextOverlay
  | ContentTextOverlay;

export function isTextMarkupTool(tool: ToolId): boolean {
  return tool === "highlight" || tool === "underline" || tool === "strikethrough";
}

export function isTextMarkupOverlay(
  overlay: Overlay,
): overlay is TextMarkupOverlay {
  return (
    overlay.type === "highlight" ||
    overlay.type === "underline" ||
    overlay.type === "strikethrough"
  );
}

export function isEditableTextOverlay(
  overlay: Overlay,
): overlay is TextOverlay | ContentTextOverlay | CalloutOverlay {
  return (
    overlay.type === "text" ||
    overlay.type === "contentText" ||
    overlay.type === "callout"
  );
}

export function isSignatureOverlay(
  overlay: Overlay,
): overlay is (InkOverlay | ImageOverlay) & { source: "signature" } {
  return (
    (overlay.type === "ink" || overlay.type === "image") &&
    overlay.source === "signature"
  );
}
