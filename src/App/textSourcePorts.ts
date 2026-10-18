import {
  CAPABILITIES,
  saveBytes,
  writeBackTarget,
  writeTextDocumentBack,
} from "../platform";
import { putWorkspaceSource, removeWorkspaceSource } from "../storage/workspace";
import { workspaceStore } from "../workspace/appWorkspace";
import { createTextSources } from "../workspace/textSources/textSources";
import { translate } from "./translate";
import { showTextSourceNotice } from "./workspaceNotices";
import {
  persistWorkspaceMetadataNow,
  protectedWorkspaceCacheIds,
  removeWorkspaceSourceIfUnreferenced,
} from "./workspaceStorage";

/**
 * Markdown and HTML working copies on the real platform, created once per
 * window. `onPendingChange` reports whether a write is still queued.
 */
export function createAppTextSources(onPendingChange: (pending: boolean) => void) {
  const sources = createTextSources({
    store: workspaceStore(),
    timers: {
      set: (run, ms) => window.setTimeout(run, ms),
      clear: (handle) => window.clearTimeout(handle),
    },
    cache: {
      put: (entry) => putWorkspaceSource(entry, protectedWorkspaceCacheIds()),
      remove: (cacheId) => void removeWorkspaceSource(cacheId),
      removeIfUnreferenced: (cacheId) =>
        void removeWorkspaceSourceIfUnreferenced(cacheId),
    },
    persistMetadata: persistWorkspaceMetadataNow,
    writeBack: {
      target: writeBackTarget,
      write: writeTextDocumentBack,
      saveAs: (bytes, suggestedName, mime) =>
        saveBytes(bytes, { suggestedName, mime }),
      requiresOrigin: CAPABILITIES.nativePaths,
    },
    notify: (notice) => showTextSourceNotice(notice, translate),
    onPendingChange,
  });
  return {
    ...sources,
    /**
     * ⌘S: saves the text document on screen back to its file. Decides
     * synchronously whether a text document claimed the key, since the
     * listener must call preventDefault before any await.
     */
    saveActive(): boolean {
      const { activeTabId, tabs } = workspaceStore().getState();
      const tab = tabs.find((entry) => entry.id === activeTabId);
      if (!activeTabId || !tab || (tab.kind !== "markdown" && tab.kind !== "html")) {
        return false;
      }
      void sources.saveToSource(activeTabId);
      return true;
    },
  };
}

export type AppTextSources = ReturnType<typeof createAppTextSources>;
