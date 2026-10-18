import { isTextDocumentKind } from "../documents/types";
import {
  canReopenRecent,
  getRecent,
  recordRecent,
  type RecentEntry,
} from "../editor/recentDocs";
import { CAPABILITIES } from "../platform";
import { textReopenCacheId } from "../workspace/tabSources";
import type { WorkspaceRuntimeTab } from "../workspace/types";

function recentEntryForDocumentTab(
  tab: WorkspaceRuntimeTab,
): Omit<RecentEntry, "savedAt"> | null {
  if (tab.kind === "pdf") return null;
  const textKind = isTextDocumentKind(tab.kind) ? tab.kind : null;
  if (textKind && tab.text == null) return null;
  return {
    name: tab.title,
    pages: 0,
    size: tab.size,
    kind: tab.kind,
    hash: tab.hash,
    path: tab.source.type === "path" ? tab.source.path : undefined,
    webFileHandleId:
      tab.source.type === "webFileHandle" ? tab.source.id : undefined,
    cacheId: textReopenCacheId(tab),
    ...(textKind && tab.text != null
      ? recentPreviewFields(tab.text, textKind)
      : {}),
  };
}

/**
 * Makes a text tab reachable from recents. False means there is no way back
 * to its unsaved text; anything that needs no record passes.
 */
export function recordTextRecent(tab: WorkspaceRuntimeTab): boolean {
  const recentEntry = recentEntryForDocumentTab(tab);
  if (
    !recentEntry ||
    !canReopenRecent(
      recentEntry,
      CAPABILITIES.nativePaths,
      CAPABILITIES.workspaceSourceCache,
    )
  ) {
    return true;
  }
  if (recordRecent(recentEntry)) return true;
  const reopenCacheId = textReopenCacheId(tab);
  return (
    !reopenCacheId ||
    getRecent().some((entry) => entry.cacheId === reopenCacheId)
  );
}

// A short plain-text excerpt for the Markdown recents preview — keeps line
// breaks, capped small to stay light in localStorage and cheap to render.
export function documentTextPreview(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 240);
}

// Preview payload stored on a recents entry. Markdown gets a text excerpt;
// HTML gets capped raw markup (scripts stripped) so the row can render the
// page in a sandboxed iframe and show the rendered look, not the source.
const HTML_PREVIEW_MAX_CHARS = 16_000;

export function recentPreviewFields(
  text: string,
  kind: "markdown" | "html",
): { textPreview?: string; htmlPreview?: string } {
  if (kind === "html") {
    return {
      htmlPreview: text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .slice(0, HTML_PREVIEW_MAX_CHARS),
    };
  }
  return { textPreview: documentTextPreview(text) };
}
