/**
 * Workspace cache rows written for a document that is still opening.
 *
 * A dropped or mobile-picked file gets its cache row before parsing, but a tab
 * (or a recents entry) points at that row only once the open finishes, which
 * can wait on a password prompt indefinitely. The orphan sweep and quota
 * eviction treat these ids as protected until a tab or recent references the
 * row or the open gives it up. A reservation never released lives only for
 * this session; the next launch's sweep reclaims an abandoned row.
 */
const reserved = new Set<string>();

export function reserveWorkspaceSource(id: string): void {
  reserved.add(id);
}

export function releaseWorkspaceSource(id: string): void {
  reserved.delete(id);
}

export function reservedWorkspaceSourceIds(): string[] {
  return [...reserved];
}
