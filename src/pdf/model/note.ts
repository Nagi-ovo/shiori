import type { NoteOverlay, PdfRect } from "./types";

export const NOTE_DEFAULT_COLOR = "#f7e9a8";
export const NOTE_DEFAULT_WIDTH_PT = 168;
export const NOTE_DEFAULT_HEIGHT_PT = 94;

export function noteTimestamps(now: number = Date.now()) {
  return { createdAt: now, updatedAt: now };
}

export function createNoteOverlay({
  id,
  pageId,
  rect,
  text = "",
  color = NOTE_DEFAULT_COLOR,
  now = Date.now(),
}: {
  id: string;
  pageId: string;
  rect: PdfRect;
  text?: string;
  color?: string;
  now?: number;
}): NoteOverlay {
  return {
    type: "note",
    id,
    pageId,
    rect,
    text,
    color,
    ...noteTimestamps(now),
  };
}
