import { describe, expect, test } from "bun:test";
import {
  activateTab,
  closeTab,
  goHome,
  type ActivateTabPorts,
  type CloseTabPorts,
  type GoHomePorts,
} from "./tabLifecycle";
import type { WorkspaceRuntimeTab } from "./types";
import { createWorkspaceStore, type WorkspaceStore } from "./workspaceStore";

const tab = (id: string, kind = "pdf"): WorkspaceRuntimeTab =>
  ({ id, kind, title: `${id}.${kind}`, status: "loaded" }) as WorkspaceRuntimeTab;

function workspace(ids: string[], activeTabId: string | null, kinds: Record<string, string> = {}) {
  return createWorkspaceStore({
    tabs: ids.map((id) => tab(id, kinds[id])),
    activeTabId,
    folderPaths: [],
  });
}

const ids = (store: WorkspaceStore) => store.getState().tabs.map((t) => t.id);

function activatePorts(store: WorkspaceStore, overrides: Partial<ActivateTabPorts> = {}) {
  const activated: (string | null)[] = [];
  const transitions: boolean[] = [];
  const reports: string[] = [];
  const ports: ActivateTabPorts = {
    store,
    flushTextSources: async () => {},
    persistActivePdf: async () => true,
    beforeActivate: () => {},
    applyActivation: (target) => {
      activated.push(target?.id ?? null);
      store.setState({ activeTabId: target?.id ?? null });
    },
    setTransitioning: (on) => transitions.push(on),
    reportTextSaveFailed: (leaving, error) =>
      reports.push(`${leaving?.id}: ${String(error)}`),
    ...overrides,
  };
  return { ports, activated, transitions, reports };
}

function closePorts(store: WorkspaceStore, overrides: Partial<CloseTabPorts> = {}) {
  const activated: (string | null)[] = [];
  const released: string[] = [];
  const reports: string[] = [];
  const ports: CloseTabPorts = {
    store,
    flushTextSources: async () => {},
    recordTextRecent: () => true,
    discardTextSourceState: () => {},
    flushActiveDraft: async () => {},
    activeNeedsExport: () => false,
    inactiveNeedsExport: () => false,
    captureActiveDocument: () => null,
    releaseCaches: () => {},
    releaseRuntime: async (closing) => {
      released.push(closing.id);
    },
    reportTextSaveFailed: (closing) => reports.push(`text:${closing.id}`),
    reportDraftSaveFailed: (closing) => reports.push(`draft:${closing.id}`),
    reportClosedUnexported: (closing) => reports.push(`unexported:${closing.id}`),
    clearPasswordPrompt: () => {},
    applyActivation: (target) => {
      activated.push(target?.id ?? null);
      store.setState({ activeTabId: target?.id ?? null });
    },
    ...overrides,
  };
  return { ports, activated, released, reports };
}

describe("activateTab", () => {
  test("activates the tab record as it is after the flushes, not before", async () => {
    const store = workspace(["a", "b"], "a");
    let received: WorkspaceRuntimeTab | null = null;
    const { ports } = activatePorts(store, {
      persistActivePdf: async () => {
        store.setState({
          tabs: store.getState().tabs.map((t) =>
            t.id === "b" ? { ...t, title: "renamed" } : t,
          ),
        });
        return true;
      },
      applyActivation: (target) => {
        received = target;
      },
    });

    await activateTab("b", ports);

    expect(received).toMatchObject({ id: "b", title: "renamed" });
  });

  test("a tab closed while the previous one persists is never revived", async () => {
    const store = workspace(["a", "b"], "a");
    const { ports, activated, transitions } = activatePorts(store, {
      flushTextSources: async () => {
        store.setState({ tabs: store.getState().tabs.filter((t) => t.id !== "b") });
      },
    });

    await activateTab("b", ports);

    expect(activated).toEqual([]);
    expect(store.getState().activeTabId).toBe("a");
    expect(transitions).toEqual([true, false]);
  });

  test("stays on the current tab when its PDF could not be persisted", async () => {
    const store = workspace(["a", "b"], "a");
    const { ports, activated } = activatePorts(store, {
      persistActivePdf: async () => false,
    });

    await activateTab("b", ports);

    expect(activated).toEqual([]);
  });

  test("the reader's latest click wins even when an earlier one finishes last", async () => {
    const store = workspace(["a", "b", "c"], "a");
    let releaseFirst!: () => void;
    const firstPersist = new Promise<boolean>((resolve) => {
      releaseFirst = () => resolve(true);
    });
    const click = (tabId: string, persist: () => Promise<boolean>) =>
      activateTab(tabId, {
        ...activatePorts(store).ports,
        persistActivePdf: persist,
      });

    const toB = click("b", () => firstPersist);
    const toC = click("c", async () => true);
    await toC;
    releaseFirst();
    await toB;

    expect(store.getState().activeTabId).toBe("c");
  });

  test("ends the transition even when persisting throws", async () => {
    const store = workspace(["a", "b"], "a");
    const { ports, transitions } = activatePorts(store, {
      persistActivePdf: async () => {
        throw new Error("disk full");
      },
    });

    await expect(activateTab("b", ports)).rejects.toThrow("disk full");
    expect(transitions).toEqual([true, false]);
  });

  test("says so and stays when the text it leaves cannot be saved", async () => {
    const store = workspace(["a", "b"], "a", { a: "markdown" });
    const { ports, activated, transitions, reports } = activatePorts(store, {
      flushTextSources: async () => {
        throw new Error("QuotaExceededError");
      },
    });

    await activateTab("b", ports);

    expect(reports).toEqual(["a: Error: QuotaExceededError"]);
    expect(activated).toEqual([]);
    expect(store.getState().activeTabId).toBe("a");
    expect(transitions).toEqual([true, false]);
  });
});

describe("goHome", () => {
  function homePorts(store: WorkspaceStore, overrides: Partial<GoHomePorts> = {}) {
    const reports: string[] = [];
    const ports: GoHomePorts = {
      store,
      persistActive: async () => true,
      recordTextRecent: () => true,
      reportTextSaveFailed: () => reports.push("text"),
      clearPasswordPrompt: () => {},
      applyActivation: (target) => store.setState({ activeTabId: target?.id ?? null }),
      ...overrides,
    };
    return { ports, reports };
  }

  test("leaves the documents open and shows home", async () => {
    const store = workspace(["a", "b"], "a");

    await goHome(homePorts(store).ports);

    expect(store.getState().activeTabId).toBeNull();
    expect(ids(store)).toEqual(["a", "b"]);
  });

  test("a tab clicked while the document saves keeps the screen", async () => {
    const store = workspace(["a", "b"], "a");
    let releaseSave!: () => void;
    const save = new Promise<boolean>((resolve) => {
      releaseSave = () => resolve(true);
    });

    const home = goHome(homePorts(store, { persistActive: () => save }).ports);
    await activateTab("b", activatePorts(store).ports);
    releaseSave();
    await home;

    expect(store.getState().activeTabId).toBe("b");
  });

  test("stays on the document when it could not be saved", async () => {
    const store = workspace(["a"], "a");

    await goHome(homePorts(store, { persistActive: async () => false }).ports);

    expect(store.getState().activeTabId).toBe("a");
  });

  test("stays when an open text document would be unreachable from home", async () => {
    const store = workspace(["a", "t"], "a", { t: "markdown" });
    const { ports, reports } = homePorts(store, {
      recordTextRecent: (tab) => tab.id !== "t",
    });

    await goHome(ports);

    expect(store.getState().activeTabId).toBe("a");
    expect(reports).toEqual(["text"]);
  });
});

describe("closeTab", () => {
  // After the reader discards a copy refused for another window's newer
  // draft, nothing of it was kept, so the "saved as a draft" cue would lie.
  test("closing a discarded copy does not say its edits were kept as a draft", async () => {
    const store = workspace(["a", "b"], "a");
    const { ports, reports, released } = closePorts(store, {
      activeNeedsExport: () => true,
    });

    await closeTab("a", ports, { changesDiscarded: true });

    expect(ids(store)).toEqual(["b"]);
    expect(released).toEqual(["a"]);
    expect(reports).toEqual([]);
  });

  test("closing the active tab activates the neighbour at its position", async () => {
    const store = workspace(["a", "b", "c"], "b");
    const { ports, activated, released } = closePorts(store);

    await closeTab("b", ports);

    expect(ids(store)).toEqual(["a", "c"]);
    expect(activated).toEqual(["c"]);
    expect(released).toEqual(["b"]);
  });

  // Releasing a closed tab deletes its session and preview from IndexedDB,
  // which takes several frames. Waiting on that before showing the neighbour
  // left the screen pointing at a tab no longer in the list, and the app
  // painted its home screen for that moment.
  test("the neighbour is on screen while the closed tab is still released", async () => {
    const store = workspace(["a", "b"], "b", { b: "markdown" });
    let finishRelease!: () => void;
    const { ports } = closePorts(store, {
      releaseRuntime: () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        }),
    });

    const closing = closeTab("b", ports);
    await Bun.sleep(0);

    expect(ids(store)).toEqual(["a"]);
    expect(store.getState().activeTabId).toBe("a");
    finishRelease();
    await closing;
  });

  test("closing the last tab in the strip falls back to the one before it", async () => {
    const store = workspace(["a", "b"], "b");
    const { ports, activated } = closePorts(store);

    await closeTab("b", ports);

    expect(activated).toEqual(["a"]);
  });

  test("closing the only tab leaves nothing active", async () => {
    const store = workspace(["a"], "a");
    const { ports, activated } = closePorts(store);

    await closeTab("a", ports);

    expect(ids(store)).toEqual([]);
    expect(activated).toEqual([null]);
  });

  test("closing a background tab leaves the active tab alone", async () => {
    const store = workspace(["a", "b"], "a");
    const { ports, activated } = closePorts(store);

    await closeTab("b", ports);

    expect(ids(store)).toEqual(["a"]);
    expect(activated).toEqual([]);
  });

  test("a tab opened during the draft flush survives the close", async () => {
    const store = workspace(["a", "b"], "b");
    const { ports } = closePorts(store, {
      flushActiveDraft: async () => {
        store.setState({ tabs: [...store.getState().tabs, tab("late")] });
      },
    });

    await closeTab("b", ports);

    expect(ids(store)).toEqual(["a", "late"]);
  });

  test("a tab already closed during the draft flush is not closed twice", async () => {
    const store = workspace(["a", "b"], "b");
    const { ports, activated, released } = closePorts(store, {
      flushActiveDraft: async () => {
        store.setState({ tabs: store.getState().tabs.filter((t) => t.id !== "b") });
      },
    });

    await closeTab("b", ports);

    expect(ids(store)).toEqual(["a"]);
    expect(released).toEqual([]);
    expect(activated).toEqual([]);
  });

  test("a PDF whose draft cannot be saved stays open", async () => {
    const store = workspace(["a", "b"], "b");
    const { ports, reports } = closePorts(store, {
      flushActiveDraft: async () => {
        throw new Error("quota");
      },
    });

    await closeTab("b", ports);

    expect(ids(store)).toEqual(["a", "b"]);
    expect(reports).toEqual(["draft:b"]);
  });

  test("a text document with no way back to its text stays open", async () => {
    const store = workspace(["a", "t"], "t", { t: "markdown" });
    const { ports, reports } = closePorts(store, {
      recordTextRecent: () => false,
    });

    await closeTab("t", ports);

    expect(ids(store)).toEqual(["a", "t"]);
    expect(reports).toEqual(["text:t"]);
  });

  test("closing unexported work warns but still closes", async () => {
    const store = workspace(["a", "b"], "b");
    const { ports, reports } = closePorts(store, {
      activeNeedsExport: () => true,
    });

    await closeTab("b", ports);

    expect(ids(store)).toEqual(["a"]);
    expect(reports).toEqual(["unexported:b"]);
  });
});
