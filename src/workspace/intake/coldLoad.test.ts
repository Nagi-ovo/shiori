import { describe, expect, test } from "bun:test";
import { createPdfEditorStore } from "../../editor/store/store";
import {
  captureSuspendedPdfSnapshot,
  type RuntimeSessionRecord,
} from "../../storage/runtimeSessions";
import type { WorkspaceRuntimeTab } from "../types";
import type { WorkspaceStore } from "../workspaceStore";
import {
  coldLoadTab,
  loadActiveTab,
  markSupersededLoad,
  type ColdLoadPorts,
} from "./coldLoad";
import type { PdfEngine } from "../../pdf/engine/types";
import { createSerialQueue } from "../../shared/serialQueue";
import { openDocument } from "./openDocument";
import type { TabSourceRead } from "./readTabSource";
import { bytes, deferred, fakeEngine, fakePorts, workspace } from "./testing";

let nextId = 0;
/** A PDF tab restored from the saved workspace: known, but not yet opened. */
function savedTab(status: WorkspaceRuntimeTab["status"] = "unloaded") {
  nextId += 1;
  return {
    id: `saved-${nextId}`,
    kind: "pdf",
    title: "paper.pdf",
    size: 4,
    status,
    source: { type: "path", path: `/docs/paper-${nextId}.pdf` },
  } as WorkspaceRuntimeTab;
}

const read = (): TabSourceRead => ({
  payload: { kind: "pdf", name: "paper.pdf", size: 4, bytes: bytes(1, 2, 3, 4) },
});

function coldPorts(store: WorkspaceStore, overrides: Partial<ColdLoadPorts> = {}) {
  const base = fakePorts(store, { markSuperseded: markSupersededLoad });
  const reads: string[] = [];
  const failures: string[] = [];
  const ports: ColdLoadPorts = {
    ...base.ports,
    readTabSource: async (tab) => {
      reads.push(tab.id);
      return read();
    },
    readRuntimeSession: async () => null,
    storageRepaired: async () => {},
    credential: () => undefined,
    reportRestoreFailed: (_tab, detail) => failures.push(detail),
    ...overrides,
  };
  return { ports, reads, failures, editors: base.editors, log: base.log };
}

const statusOf = (store: WorkspaceStore, id: string) =>
  store.getState().tabs.find((tab) => tab.id === id)?.status;

describe("cold load", () => {
  test("the saved workspace's tab on screen opens at launch", async () => {
    const tab = savedTab();
    const store = workspace([tab], tab.id);
    const { ports, reads, editors } = coldPorts(store);

    loadActiveTab(ports);
    await Bun.sleep(0);

    expect(reads).toEqual([tab.id]);
    expect(statusOf(store, tab.id)).toBe("loaded");
    expect(editors.get(tab.id)?.getState().model.pages).toHaveLength(2);
  });

  test("a suspended tab resumes from its session, not its source", async () => {
    const tab = savedTab("suspended");
    const store = workspace([tab], tab.id);
    const session = {
      tabId: tab.id,
      bytes: bytes(1, 2, 3, 4),
      snapshot: captureSuspendedPdfSnapshot(createPdfEditorStore()),
    } as RuntimeSessionRecord;
    const { ports, reads } = coldPorts(store, { readRuntimeSession: async () => session });

    await coldLoadTab(tab.id, ports);

    expect(reads).toEqual([]);
    expect(statusOf(store, tab.id)).toBe("loaded");
  });

  test("a tab the reader left before it loaded can load again later", async () => {
    const tab = savedTab();
    const other = savedTab("loaded");
    const store = workspace([tab, other], tab.id);
    const source = deferred<void>();
    const { ports } = coldPorts(store, {
      readTabSource: async () => {
        await source.promise;
        return read();
      },
    });

    const loading = coldLoadTab(tab.id, ports);
    store.getState().setActiveTab(other.id);
    source.resolve();
    await loading;

    expect(statusOf(store, tab.id)).toBe("unloaded");
  });

  test("a restore that loses its claim while its tab stays on screen loads again", async () => {
    const tab = savedTab();
    const store = workspace([tab], tab.id);
    const firstParse = deferred<void>();
    const inner = fakeEngine().engine;
    let parses = 0;
    const { ports } = coldPorts(store, {
      engine: {
        ...inner,
        load: async (input, options) => {
          parses += 1;
          if (parses === 1) await firstParse.promise;
          return inner.load(input, options);
        },
      },
    });

    const loading = coldLoadTab(tab.id, ports);
    while (parses === 0) await Bun.sleep(1);
    store.getState().claimNavigation(); // the reader clicks the same tab again
    firstParse.resolve();
    await loading;
    while (statusOf(store, tab.id) === "loading") await Bun.sleep(1);

    expect(parses).toBe(2);
    expect(statusOf(store, tab.id)).toBe("loaded");
  });

  test("a source that cannot be read says so, on the tab and to the reader", async () => {
    const tab = savedTab();
    const store = workspace([tab], tab.id);
    const { ports, failures } = coldPorts(store, {
      readTabSource: async () => {
        throw new Error("document-path-unavailable");
      },
    });

    await coldLoadTab(tab.id, ports);

    expect(store.getState().tabs[0]).toMatchObject({
      status: "unavailable",
      unavailableDetail: "document-path-unavailable",
    });
    expect(failures).toEqual(["document-path-unavailable"]);
  });

  test("an encrypted tab waits on its password dialog instead of reloading", async () => {
    const tab = savedTab();
    const store = workspace([tab], tab.id);
    const { engine } = fakeEngine({
      load: async () => {
        throw Object.assign(new Error("No password given"), { name: "PasswordException" });
      },
    });
    let reads = 0;
    const { ports } = coldPorts(store, {
      engine,
      readTabSource: async () => {
        reads += 1;
        return read();
      },
    });

    await coldLoadTab(tab.id, ports);
    await Bun.sleep(0);

    expect(statusOf(store, tab.id)).toBe("loading");
    expect(reads).toBe(1);
  });
});

/**
 * A document handed in from outside (CLI, Finder "Open with", Windows/Linux
 * argv, Android intent) while the saved workspace's active tab restores at
 * launch. The reader asked for that document, so it must end on screen; the
 * restored tab may finish, but only in the background.
 */
describe("cold load vs an incoming open", () => {
  const incoming = {
    kind: "pdf" as const,
    name: "requested.pdf",
    size: 4,
    bytes: bytes(9, 9, 9, 9),
    path: "/inbox/requested.pdf",
  };
  const activeTitle = (store: WorkspaceStore) =>
    store.getState().tabs.find((tab) => tab.id === store.getState().activeTabId)
      ?.title;
  const incomingTab = (store: WorkspaceStore) =>
    store.getState().tabs.find((tab) => tab.title === "requested.pdf");
  /** Waits for a step to start (never for completion: that is awaited). */
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 1000 && !condition(); i += 1) await Bun.sleep(1);
    expect(condition()).toBe(true);
  };
  const passwordError = () =>
    Object.assign(new Error("No password given"), { name: "PasswordException" });
  /** An engine whose parses are held or failed per document, by first byte. */
  const gatedEngine = (
    behave: (first: number) => { gate?: Promise<void>; error?: Error },
  ) => {
    const inner = fakeEngine().engine;
    const started: number[] = [];
    const engine: PdfEngine = {
      ...inner,
      load: async (input, options) => {
        const first = input[0] ?? -1;
        started.push(first);
        const { gate, error } = behave(first);
        if (gate) await gate;
        if (error) throw error;
        return inner.load(input, options);
      },
    };
    return { engine, started };
  };
  const slowSource = (
    store: WorkspaceStore,
    overrides: Partial<ColdLoadPorts> = {},
  ) => {
    const source = deferred<void>();
    const cold = coldPorts(store, {
      enqueuePdfOpen: createSerialQueue(),
      readTabSource: async () => {
        await source.promise;
        return read();
      },
      ...overrides,
    });
    return { ...cold, source };
  };

  test("an open arriving while the restore still reads its source wins", async () => {
    const tab = savedTab();
    const store = workspace([tab], tab.id);
    const { ports, source } = slowSource(store);

    const restoring = loadActiveTab(ports); // App mounts: the saved tab restores
    await Bun.sleep(0);
    const opening = openDocument(incoming, {}, ports); // the handoff lands
    source.resolve();
    await Promise.all([restoring, opening]);

    expect(activeTitle(store)).toBe("requested.pdf");
    expect(statusOf(store, tab.id)).toBe("unloaded");
  });

  test("an open arriving while the restore parses wins", async () => {
    const tab = savedTab();
    const store = workspace([tab], tab.id);
    const restoreParse = deferred<void>();
    const { engine, started } = gatedEngine(() =>
      started.length === 1 ? { gate: restoreParse.promise } : {},
    );
    const { ports } = coldPorts(store, {
      enqueuePdfOpen: createSerialQueue(),
      engine,
    });

    const restoring = loadActiveTab(ports);
    await until(() => started.length === 1);
    const opening = openDocument(incoming, {}, ports);
    restoreParse.resolve();
    await Promise.all([restoring, opening]);

    expect(activeTitle(store)).toBe("requested.pdf");
    expect(statusOf(store, tab.id)).toBe("unloaded");
  });

  test("an encrypted restore leaves the password dialog to an encrypted open", async () => {
    // The dialog has one slot. The restore, reloading behind the open that
    // superseded it, must not replace that open's prompt with its own: the
    // requested document would then have no way to be unlocked.
    const tab = savedTab();
    const store = workspace([tab], tab.id);
    const { engine } = gatedEngine(() => ({ error: passwordError() }));
    const { ports, source, log } = slowSource(store, { engine });

    const restoring = loadActiveTab(ports);
    await Bun.sleep(0);
    const opening = openDocument(incoming, {}, ports);
    source.resolve();
    await Promise.all([restoring, opening]);

    expect(log.passwords.map((pending) => pending.input.name)).toEqual([
      "requested.pdf",
    ]);
    // The restored tab can still be unlocked from the tab itself.
    expect(store.getState().tabs.find((t) => t.id === tab.id)).toMatchObject({
      status: "unavailable",
      unavailableDetail: "pdf-password-required",
    });
  });

  test("the restored tab comes back when the incoming open fails", async () => {
    const tab = savedTab();
    const store = workspace([tab], tab.id);
    const { engine } = gatedEngine((first) =>
      first === 9 ? { error: new Error("broken xref") } : {},
    );
    const { ports, source, log } = slowSource(store, { engine });

    const restoring = loadActiveTab(ports);
    await Bun.sleep(0);
    const opening = openDocument(incoming, {}, ports);
    source.resolve();
    await Promise.all([restoring, opening]);

    expect(log.errors).toEqual(["broken xref"]);
    expect(activeTitle(store)).toBe("paper.pdf");
    expect(statusOf(store, tab.id)).toBe("loaded");
  });

  test("a tab the reader picks during the restore's reload keeps the screen", async () => {
    const tab = savedTab();
    const other = savedTab("loaded");
    const store = workspace([tab, other], tab.id);
    const restoreParse = deferred<void>();
    const incomingParse = deferred<void>();
    const reloadRead = deferred<void>();
    let reads = 0;
    const { engine, started } = gatedEngine((first) => {
      if (first === 9) return { gate: incomingParse.promise };
      return started.length === 1 ? { gate: restoreParse.promise } : {};
    });
    const { ports } = coldPorts(store, {
      enqueuePdfOpen: createSerialQueue(),
      engine,
      readTabSource: async () => {
        reads += 1;
        if (reads === 2) await reloadRead.promise;
        return read();
      },
    });

    const restoring = loadActiveTab(ports);
    await until(() => started.length === 1);
    const opening = openDocument(incoming, {}, ports);
    restoreParse.resolve();
    await until(() => reads === 2); // superseded, the restore reloads behind it
    store.getState().claimNavigation(); // the reader clicks another tab
    store.getState().setActiveTab(other.id);
    reloadRead.resolve();
    incomingParse.resolve();
    await Promise.all([restoring, opening]);

    expect(store.getState().activeTabId).toBe(other.id);
    expect(statusOf(store, tab.id)).toBe("unloaded");
    expect(incomingTab(store)?.status).toBe("loaded"); // built in the background
  });

  test("a Markdown open arriving during the restore wins", async () => {
    const tab = savedTab();
    const store = workspace([tab], tab.id);
    const { ports, source } = slowSource(store);

    const restoring = loadActiveTab(ports);
    await Bun.sleep(0);
    const opening = openDocument(
      {
        kind: "markdown",
        name: "notes.md",
        size: 2,
        bytes: bytes(35, 10),
        path: "/inbox/notes.md",
      },
      {},
      ports,
    );
    source.resolve();
    await Promise.all([restoring, opening]);

    expect(activeTitle(store)).toBe("notes.md");
  });
});
