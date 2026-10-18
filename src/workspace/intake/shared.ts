import { sourceKey, type DocumentKind, type DocumentSource } from "../../documents/types";
import { documentOpenMayContinue } from "../../editor/openIntent";
import { canDedupeByContent } from "../tabSources";
import type { WorkspaceRuntimeTab } from "../types";
import type { IntakePorts } from "./types";

/**
 * The two questions every open asks after each await.
 *
 * `shouldActivate`: may this open still take the screen? Only while its claim
 * is the newest and its foreground intent has not been superseded.
 * `shouldContinue`: is it worth finishing at all? A fresh open finishes in the
 * background even when it lost the screen, since the reader asked for that
 * file; a restore into an existing tab only matters while that tab owns the
 * foreground.
 */
export function openClaim(
  ports: IntakePorts,
  options: {
    tabId?: string;
    foregroundIntent?: number;
    shouldActivate?: () => boolean;
  },
) {
  const claim = ports.store.getState().claimOpen(options.foregroundIntent);
  const shouldActivate = () =>
    claim.ownsForeground() && (options.shouldActivate?.() ?? true);
  const shouldContinue = () =>
    documentOpenMayContinue(options.tabId, shouldActivate());
  return { shouldActivate, shouldContinue };
}

/**
 * Records that this open gave up, so its caller can tell it died rather than
 * being slow: a restore left saying "loading" with nobody coming back for it
 * is a tab that can never be opened again.
 */
export function abandonOpen(
  ports: IntakePorts,
  tabId: string | undefined,
  pendingCacheId: string | undefined,
): void {
  if (pendingCacheId) ports.sources.removeIfUnreferenced(pendingCacheId);
  if (tabId) ports.markSuperseded(tabId);
}

/**
 * A cache-backed tab whose cache row is gone cannot be switched to, so it
 * must not absorb a reopen of the same file.
 */
async function cachedSourceIsUsable(
  ports: IntakePorts,
  tab: WorkspaceRuntimeTab,
): Promise<boolean> {
  if (tab.source.type !== "cache") return true;
  if (
    tab.status === "loaded" &&
    ((tab.kind === "pdf" && ports.editors.get(tab.id)) ||
      (tab.kind !== "pdf" && tab.text != null))
  ) {
    return true;
  }
  return Boolean(await ports.sources.get(tab.source.id));
}

/** The open tab that already holds this document, by source or by content. */
export async function findExistingTab(
  ports: IntakePorts,
  kind: DocumentKind,
  candidate: DocumentSource,
  hash: string,
): Promise<WorkspaceRuntimeTab | null> {
  const candidateKey = sourceKey(candidate);
  for (const tab of ports.store.getState().tabs) {
    if (tab.kind !== kind) continue;
    const sameSource = Boolean(
      candidateKey && sourceKey(tab.source) === candidateKey,
    );
    const sameContent = Boolean(
      tab.hash &&
        tab.hash === hash &&
        canDedupeByContent(tab.source) &&
        canDedupeByContent(candidate),
    );
    if (!sameSource && !sameContent) continue;
    if (!(await cachedSourceIsUsable(ports, tab))) continue;
    return tab;
  }
  return null;
}
