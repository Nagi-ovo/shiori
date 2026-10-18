import type {
  DocumentSource,
  LoadedDocumentPayload,
} from "../documents/types";
import type { WorkspaceTabMeta } from "../storage/workspace";

export function workspaceCacheIdsForTab(
  tab: Pick<WorkspaceTabMeta, "source" | "workingCopyCacheId">,
): string[] {
  const ids = new Set<string>();
  if (tab.source.type === "cache") ids.add(tab.source.id);
  if (tab.workingCopyCacheId) ids.add(tab.workingCopyCacheId);
  return Array.from(ids);
}

export function textReopenCacheId(
  tab: Pick<WorkspaceTabMeta, "source" | "workingCopyCacheId">,
): string | undefined {
  return (
    tab.workingCopyCacheId ??
    (tab.source.type === "cache" ? tab.source.id : undefined)
  );
}

export function documentSourcePayloadFields(
  source: DocumentSource,
): Pick<LoadedDocumentPayload, "path" | "webFileHandleId" | "cacheId"> {
  if (source.type === "path") return { path: source.path };
  if (source.type === "webFileHandle") return { webFileHandleId: source.id };
  if (source.type === "cache") return { cacheId: source.id };
  return {};
}

/**
 * Only anonymous sources dedupe by content: two files at different paths with
 * the same bytes are still two documents to the reader.
 */
export function canDedupeByContent(source: DocumentSource): boolean {
  return source.type === "cache" || source.type === "ephemeral";
}
