import {
  sourceForPayload,
  sourceKey,
  type DocumentSource,
  type LoadedDocumentPayload,
} from "../documents/types";

/**
 * Which draft a PDF tab reads and writes (AGENTS.md fact 4).
 *
 * The content hash, qualified by the source when the source has a durable
 * identity: a desktop path or a web file handle. Two files with the same
 * bytes at two paths are two tabs (canDedupeByContent), so they need two
 * drafts, or each tab's autosave overwrites the other's. Cache rows (mobile
 * picker and share, drops, pasted bytes, merged pages) and ephemeral sources
 * dedupe by content and keep the hash alone, which is also what builds before
 * this one wrote; claimDraft hands such a draft to a durable source.
 *
 * The id is `<hash>|<sourceKey>`. A hash is hex, so the first "|" ends it and
 * the source key after it may contain anything.
 */
const SEPARATOR = "|";

export function draftIdFor(hash: string, source: DocumentSource): string {
  if (source.type !== "path" && source.type !== "webFileHandle") return hash;
  return `${hash}${SEPARATOR}${sourceKey(source)}`;
}

/** The draft id of an opened document, from the fields it opened with. */
export function draftIdForPayload(
  hash: string,
  fields: Pick<LoadedDocumentPayload, "path" | "webFileHandleId" | "cacheId">,
): string {
  return draftIdFor(hash, sourceForPayload(fields));
}

export function draftContentHash(id: string): string {
  const at = id.indexOf(SEPARATOR);
  return at < 0 ? id : id.slice(0, at);
}

export function isHashOnlyDraftId(id: string): boolean {
  return !id.includes(SEPARATOR);
}

/** The id prefix shared by every draft of these bytes from a web file handle. */
export function webHandleDraftPrefix(hash: string): string {
  return `${hash}${SEPARATOR}web:`;
}

/** The source a draft belongs to; null for a hash-only draft. */
export function draftSource(id: string): DocumentSource | null {
  const at = id.indexOf(SEPARATOR);
  if (at < 0) return null;
  const key = id.slice(at + 1);
  if (key.startsWith("path:")) return { type: "path", path: key.slice(5) };
  if (key.startsWith("web:")) return { type: "webFileHandle", id: key.slice(4) };
  return null;
}
