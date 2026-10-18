import type { Overlay, OverlayType } from "../../pdf/model/types";

// Collapse is presentation state: it lives here and in the workspace, never in
// the document model, so it can never reach undo history or an exported PDF.
// The cap and the id normalizer are shared by every collapsible overlay type;
// the name stays note-flavoured because persisted workspaces reference it.
export const MAX_COLLAPSED_NOTE_IDS = 2_048;
const MAX_NOTE_ID_LENGTH = 256;

export function normalizeCollapsedNoteIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  // Only inspect a bounded prefix. Corrupted localStorage must not turn
  // workspace restore into unbounded validation work.
  const limit = Math.min(value.length, MAX_COLLAPSED_NOTE_IDS);
  for (let index = 0; index < limit; index += 1) {
    const id = value[index];
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_NOTE_ID_LENGTH ||
      seen.has(id)
    ) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function filterExistingCollapsedIds(
  value: unknown,
  overlays: Overlay[],
  type: OverlayType,
): string[] {
  const liveIds = new Set(
    overlays
      .filter((overlay) => overlay.type === type)
      .map((overlay) => overlay.id),
  );
  return normalizeCollapsedNoteIds(value).filter((id) => liveIds.has(id));
}

export function filterExistingCollapsedNoteIds(
  value: unknown,
  overlays: Overlay[],
): string[] {
  return filterExistingCollapsedIds(value, overlays, "note");
}

export function filterExistingCollapsedCalloutIds(
  value: unknown,
  overlays: Overlay[],
): string[] {
  return filterExistingCollapsedIds(value, overlays, "callout");
}
