import type { DocumentKind, LoadedDocumentPayload } from "../documents/types";
import type { RecentEntry } from "./recentDocs";

type TextDocumentKind = Extract<DocumentKind, "markdown" | "html">;

/** Finds the durable local edit associated with an origin opened elsewhere. */
export function findTextWorkingCopyRecent(
  kind: TextDocumentKind,
  payload: Pick<
    LoadedDocumentPayload,
    "path" | "webFileHandleId" | "cacheId"
  >,
  recents: readonly RecentEntry[],
): RecentEntry | null {
  // A cache-backed payload is already the selected local version. Looking it
  // up by another anchor could accidentally replace it with an older copy.
  if (payload.cacheId) return null;
  if (payload.path) {
    return (
      recents.find(
        (entry) =>
          entry.kind === kind &&
          entry.path === payload.path &&
          Boolean(entry.cacheId),
      ) ?? null
    );
  }
  if (payload.webFileHandleId) {
    return (
      recents.find(
        (entry) =>
          entry.kind === kind &&
          entry.webFileHandleId === payload.webFileHandleId &&
          Boolean(entry.cacheId),
      ) ?? null
    );
  }
  return null;
}
