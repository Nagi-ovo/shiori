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
  return { ports, reads, failures, editors: base.editors };
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
