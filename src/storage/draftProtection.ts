/**
 * Drafts the LRU sweep must keep: those of documents open in workspace tabs,
 * resident or not. A tab that never suspended has no runtime-session copy, so
 * evicting its draft would reopen it after a restart without its edits.
 * The workspace registers the provider; storage cannot import the workspace.
 */
let openDraftIds: () => Iterable<string> = () => [];

export function protectOpenDrafts(provider: () => Iterable<string>): () => void {
  openDraftIds = provider;
  return () => {
    if (openDraftIds === provider) openDraftIds = () => [];
  };
}

export function isDraftProtected(id: string): boolean {
  for (const openId of openDraftIds()) if (openId === id) return true;
  return false;
}
