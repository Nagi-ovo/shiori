import { CAPABILITIES } from "../platform";
import { loadWorkspaceState } from "../storage/workspace";

/**
 * The saved workspace, narrowed to what this build can open: builds without
 * text documents drop their tabs.
 */
export function loadSavedWorkspace() {
  const workspace = loadWorkspaceState();
  if (CAPABILITIES.textDocuments) return workspace;
  const tabs = workspace.tabs.filter((tab) => tab.kind === "pdf");
  // Mirrors loadWorkspaceState: a stored null means "the user was on the home
  // screen", so dropping text tabs on a build without them must not promote
  // the first PDF tab into focus.
  const activeTabId =
    workspace.activeTabId === null
      ? null
      : tabs.some((tab) => tab.id === workspace.activeTabId)
        ? workspace.activeTabId
        : tabs[0]?.id ?? null;
  return { ...workspace, tabs, activeTabId };
}
