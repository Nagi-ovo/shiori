import { create } from "zustand";
import { suspendInactiveDocxTabs } from "../documents/docxResidency";
import type { ExportedSnapshot } from "../editor/export/exportStatus";
import type {
  PendingRestore,
  RestoredDraftNotice,
  WorkspaceRuntimeTab,
} from "./types";

/**
 * The live markers of the document on screen.
 *
 * These are the current values; the active tab's record holds the persisted
 * copy, which is synced on tab switch and on export. They are kept apart on
 * purpose until a planned change makes the tab record write-through.
 */
export type ActiveSession = {
  activeHash: string | null;
  exportBaselineSnapshot: string | null;
  lastExport: ExportedSnapshot | null;
  /**
   * A draft-overwrite conflict that needs an explicit decision. Drafts
   * restore silently on open, so this only arises when the reader chose "open
   * the original" and then edited: the edit would overwrite the set-aside
   * draft.
   */
  pendingRestore: PendingRestore | null;
  /**
   * A draft set aside via "open the original". It stays on disk and autosave
   * is suspended (useDraftSync `disabled`) until the reader restores it or
   * edits, which raises `pendingRestore` instead of overwriting silently.
   */
  deferredDraft: PendingRestore | null;
  /**
   * Set after a silent restore; drives the notice and its "open the original"
   * affordance. Informational, never blocking.
   */
  restoredDraft: RestoredDraftNotice | null;
};

const EMPTY_SESSION: ActiveSession = {
  activeHash: null,
  exportBaselineSnapshot: null,
  lastExport: null,
  pendingRestore: null,
  deferredDraft: null,
  restoredDraft: null,
};

/**
 * Who may take the screen when an async flow finishes.
 *
 * `generation` is claimed by every navigation and every open: only the holder
 * of the newest one may take the screen, so the reader's latest choice wins
 * rather than whichever flow finishes last. A superseded open still builds its
 * tab; it just stays in the background.
 *
 * `foregroundIntent` is coarser: one intent can span a sequential multi-select
 * batch, so each picked document may come forward in turn, while a newer user
 * action ends the batch's right to the screen without cancelling its opens.
 *
 * A page merge reads the generation and never claims one: a merge that
 * claimed while it waited in its queue outranked an open the reader had
 * started meanwhile (a P1). ESLint keeps claims out of the merge functions.
 */
export type Navigation = { generation: number; foregroundIntent: number };

export type NavigationClaim = {
  /** No newer navigation or open has been claimed since. */
  isCurrent: () => boolean;
  /** Current, and the foreground intent this claim joined is still the newest. */
  ownsForeground: () => boolean;
};

/**
 * The workspace's single owner: which documents are open, which one is on
 * screen, which folders are mounted, and the on-screen document's markers.
 *
 * Async flows (open, close, merge) read `getState()` after every await, which
 * is what App's `*Ref` mirrors used to fake. Components subscribe with
 * selectors. See docs/PLAN-APP-ARCHITECTURE-2026-09.md.
 */
export type WorkspaceState = {
  tabs: WorkspaceRuntimeTab[];
  activeTabId: string | null;
  /** Mounted folder roots; each listing is read fresh from disk on expand. */
  folderPaths: string[];
  session: ActiveSession;
  navigation: Navigation;
};

type WorkspaceActions = {
  /** Rewrites one tab; a no-op when the updater returns the same object. */
  updateTab: (
    tabId: string,
    updater: (tab: WorkspaceRuntimeTab) => WorkspaceRuntimeTab,
  ) => void;
  /** Puts a tab on screen (or none). Inactive Word tabs drop their DOM. */
  setActiveTab: (tabId: string | null) => void;
  mountFolder: (path: string) => void;
  unmountFolder: (path: string) => void;
  setSession: (patch: Partial<ActiveSession>) => void;
  /** A direct navigation (tab click, home): supersedes every in-flight open. */
  claimNavigation: () => NavigationClaim;
  /**
   * An open. Pass the intent from `claimForegroundIntent` to join a batch;
   * omit it to start a new one. Claim when the reader acts, never when a
   * queued job dequeues: a late claim outranks what the reader did since.
   */
  claimOpen: (foregroundIntent?: number) => NavigationClaim;
  /** Starts a foreground intent that several sequential opens will share. */
  claimForegroundIntent: () => number;
};

export function createWorkspaceStore(
  initial: Omit<WorkspaceState, "session" | "navigation">,
) {
  return create<WorkspaceState & WorkspaceActions>()((set, get) => {
    const claim = (joinIntent?: number): NavigationClaim => {
      const { navigation } = get();
      const generation = navigation.generation + 1;
      const foregroundIntent = joinIntent ?? navigation.foregroundIntent + 1;
      set({
        navigation: {
          generation,
          foregroundIntent:
            joinIntent === undefined
              ? foregroundIntent
              : navigation.foregroundIntent,
        },
      });
      const isCurrent = () => get().navigation.generation === generation;
      return {
        isCurrent,
        ownsForeground: () =>
          isCurrent() &&
          get().navigation.foregroundIntent === foregroundIntent,
      };
    };
    return {
      ...initial,
      session: EMPTY_SESSION,
      navigation: { generation: 0, foregroundIntent: 0 },
      updateTab: (tabId, updater) => {
        let changed = false;
        const tabs = get().tabs.map((tab) => {
          if (tab.id !== tabId) return tab;
          const updated = updater(tab);
          if (updated !== tab) changed = true;
          return updated;
        });
        if (changed) set({ tabs });
      },
      setActiveTab: (tabId) =>
        set({
          tabs: suspendInactiveDocxTabs(get().tabs, tabId),
          activeTabId: tabId,
        }),
      mountFolder: (path) => {
        if (get().folderPaths.includes(path)) return;
        set({ folderPaths: [...get().folderPaths, path] });
      },
      unmountFolder: (path) =>
        set({ folderPaths: get().folderPaths.filter((root) => root !== path) }),
      setSession: (patch) => set({ session: { ...get().session, ...patch } }),
      claimNavigation: () => claim(),
      claimOpen: (joinIntent) => claim(joinIntent),
      claimForegroundIntent: () => {
        const foregroundIntent = get().navigation.foregroundIntent + 1;
        set({ navigation: { ...get().navigation, foregroundIntent } });
        return foregroundIntent;
      },
    };
  });
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
