import type { DraftWriteVersion } from "./drafts";

// The draft row each open document last read or wrote, so a later save can
// tell its own row from one another window wrote since.
const draftVersionByDocument = new WeakMap<object, DraftWriteVersion | null>();
// The same, by draft id: a tab resumed from its suspended snapshot has a new
// document and opens without reading its draft.
const draftVersionById = new Map<string, DraftWriteVersion | null>();

/** The draft row this document last read or wrote; null when none. */
export function observedDraftVersion(
  opened: { doc: object; draftVersion?: DraftWriteVersion | null } | null,
  draftId: string | null,
): DraftWriteVersion | null {
  if (!opened?.doc) return null;
  if (draftVersionByDocument.has(opened.doc)) {
    return draftVersionByDocument.get(opened.doc) ?? null;
  }
  return opened.draftVersion ?? (draftId ? draftVersionById.get(draftId) : null) ?? null;
}

/** Records the row a save wrote (null: the draft was removed). */
export function rememberDraftVersion(
  doc: object,
  draftId: string,
  version: DraftWriteVersion | null,
): void {
  draftVersionByDocument.set(doc, version);
  draftVersionById.set(draftId, version);
}
