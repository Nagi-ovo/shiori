import { createWindowProtection } from "./draftProtection";

/**
 * Workspace cache rows written for a document that is still opening.
 *
 * A dropped or mobile-picked file gets its cache row before parsing, but a tab
 * (or a recents entry) points at that row only once the open finishes, which
 * can wait on a password prompt indefinitely. The orphan sweep and quota
 * eviction treat these ids as protected until a tab or recent references the
 * row or the open gives it up. A reservation never released lives only for
 * this session; the next launch's sweep reclaims an abandoned row.
 *
 * Every window of the origin shares the rows, so each window also publishes
 * the rows it holds, its reservations and its tabs' cache rows, the way it
 * publishes its open drafts (draftProtection.ts). Another window's sweep keeps
 * them, a frozen window's included, while its entry lives.
 */
const reserved = new Set<string>();

/** Published entries' key prefix; other windows read it. */
export const WORKSPACE_SOURCE_KEY_PREFIX = "shiori:open-sources:v1:";

const crossWindow = createWindowProtection(WORKSPACE_SOURCE_KEY_PREFIX);
let tabSources: () => Iterable<string> = () => [];

export function reserveWorkspaceSource(id: string): void {
  reserved.add(id);
  // At once: another window's sweep may run before the next beat.
  crossWindow.republishOpenDrafts();
}

export function releaseWorkspaceSource(id: string): void {
  if (reserved.delete(id)) crossWindow.republishOpenDrafts();
}

export function reservedWorkspaceSourceIds(): string[] {
  return [...reserved];
}

/**
 * Publishes this window's reservations and the cache rows its tabs point at
 * to other windows, until the returned function runs.
 */
export function protectWorkspaceSources(provider: () => Iterable<string>): () => void {
  tabSources = provider;
  const stop = crossWindow.protectOpenDrafts(() => [...reserved, ...tabSources()]);
  return () => {
    if (tabSources === provider) tabSources = () => [];
    stop();
  };
}

/** Republish now: call when this window's tabs' cache rows change. */
export function republishWorkspaceSources(): void {
  crossWindow.republishOpenDrafts();
}

/** Cache rows other live windows hold; their sweeps cannot see ours either. */
export function workspaceSourcesOfOtherWindows(): string[] {
  return crossWindow.otherWindowIds();
}
