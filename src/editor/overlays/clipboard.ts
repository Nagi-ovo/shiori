import type { Overlay } from "../../pdf/model/types";
import {
  cloneOverlay,
  cloneOverlayWithId,
  translateCalloutWithTarget,
  translateOverlay,
} from "./geometry";
import { noteTimestamps } from "./noteMetadata";

// contentText edits never enter the clipboard: they are pinned to the
// exact source glyphs their cover rects redact, so a pasted copy would
// excise whatever different text happens to sit at the offset position —
// silent corruption on export. Filtered on copy AND paste so stale
// clipboard state can't smuggle one through either.
export function copySelectedOverlays(
  overlays: Overlay[],
  selectedIds: string[],
): Overlay[] {
  if (selectedIds.length === 0) return [];
  const selected = new Set(selectedIds);
  return overlays
    .filter((o) => selected.has(o.id) && o.type !== "contentText")
    .map(cloneOverlay);
}

export function pasteOverlays(
  clipboard: Overlay[],
  targetPageId: string,
  makeId: () => string,
  now: number = Date.now(),
): Overlay[] {
  return clipboard
    .filter((source) => source.type !== "contentText")
    .map((source) => {
    const copy = cloneOverlayWithId(source, makeId());
    const translated = {
      ...copy,
      ...(copy.type === "callout"
        ? translateCalloutWithTarget(copy, 12, -12)
        : translateOverlay(copy, 12, -12)),
      pageId: targetPageId,
    } as Overlay;
    if (translated.type === "note") Object.assign(translated, noteTimestamps(now));
    return translated;
  });
}
