import "../../test/setupDom";
import { describe, expect, test } from "bun:test";
import type { LoadedDocumentPayload } from "../../documents/types";
import type { RecentEntry } from "../../editor/recentDocs";
import { PlatformPdfOpenError } from "../../platform/open";
import { WebFileHandleOpenError } from "../../storage/recentFileHandles";
import type { DocumentOpenOptions, PdfOpenInput } from "../intake/types";
import type { WorkspaceRuntimeTab } from "../types";
import { createWorkspaceStore } from "../workspaceStore";
import {
  createDocumentAcquisition,
  type AcquireNotice,
  type AcquirePorts,
} from "./acquire";

const bytes = new Uint8Array([1]);
const payload = (name: string): LoadedDocumentPayload => ({
  kind: name.endsWith(".md") ? "markdown" : "pdf",
  name,
  size: 1,
  bytes,
});

type Overrides = Omit<Partial<AcquirePorts>, "platform" | "webHandles"> & {
  platform?: Partial<AcquirePorts["platform"]>;
  webHandles?: Partial<AcquirePorts["webHandles"]>;
};

function setup(
  on: "desktop" | "web",
  { platform, webHandles, ...overrides }: Overrides = {},
  tabs: WorkspaceRuntimeTab[] = [],
) {
  const store = createWorkspaceStore({
    tabs,
    activeTabId: tabs[0]?.id ?? null,
    folderPaths: [],
  });
  const opened: { name: string; options?: DocumentOpenOptions }[] = [];
  const openedPdfs: PdfOpenInput[] = [];
  const notices: AcquireNotice[] = [];
  const forgotten: string[] = [];
  const coldLoads: string[] = [];
  const pickers: string[] = [];
  const ports: AcquirePorts = {
    store,
    platform: {
      nativePaths: on === "desktop",
      mobileDocumentPicker: false,
      isTauri: on === "desktop",
      isMac: true,
      kindEnabled: () => true,
      pickDocuments: async () => {
        pickers.push("native");
        return [];
      },
      pickPaths: async () => [],
      openPath: async () => {},
      readPdfAtPath: async () => null,
      readDocumentAtPath: async () => null,
      ...platform,
    },
    webHandles: {
      canUse: () => on === "web",
      pickDocument: async () => null,
      pickDocuments: async () => [],
      pickPdf: async () => {
        pickers.push("webPdf");
        return null;
      },
      readDocument: async () => ({ name: "x.md", size: 1, bytes }),
      readPdf: async () => ({ name: "x.pdf", size: 1, bytes }),
      forget: () => {},
      ...webHandles,
    },
    clickFileInput: () => pickers.push("fileInput"),
    readTabSource: async (tab) => ({ payload: payload(tab.title) }),
    getCachedSource: async () => undefined,
    hash: async () => "hash",
    forgetRecent: (entry) => forgotten.push(entry.name),
    open: {
      document: async (loaded, options) => {
        opened.push({ name: loaded.name, options });
      },
      pdf: async (input) => {
        openedPdfs.push(input);
      },
    },
    coldLoad: async (tabId) => {
      coldLoads.push(tabId);
    },
    settleSupersededLoad: () => {},
    notify: (notice) => notices.push(notice),
    ...overrides,
  };
  return {
    store,
    acquire: createDocumentAcquisition(ports),
    opened,
    openedPdfs,
    notices,
    forgotten,
    coldLoads,
    pickers,
  };
}

const failedTab = (overrides: Partial<WorkspaceRuntimeTab> = {}) =>
  ({
    id: "t",
    kind: "pdf",
    title: "paper.pdf",
    size: 1,
    status: "unavailable",
    unavailableDetail: "document-path-unavailable",
    source: { type: "path", path: "/gone/paper.pdf" },
    pdfView: { pageIndex: 4, scale: 1.5 },
    ...overrides,
  }) as WorkspaceRuntimeTab;

describe("picking documents", () => {
  test("several picks open one after another, in pick order, as one batch", async () => {
    let finishFirst!: () => void;
    const started: string[] = [];
    const { acquire, opened } = setup("desktop", {
      platform: {
        pickDocuments: async () => [payload("a.pdf"), payload("b.md"), payload("c.pdf")],
      },
      open: {
        document: async (loaded, options) => {
          started.push(loaded.name);
          if (loaded.name === "a.pdf") {
            await new Promise<void>((resolve) => {
              finishFirst = resolve;
            });
          }
          opened.push({ name: loaded.name, options });
        },
        pdf: async () => {},
      },
    });

    const picking = acquire.pick();
    await Bun.sleep(0);
    // In parallel, every open would race and only the last would stay.
    expect(started).toEqual(["a.pdf"]);
    finishFirst();
    await picking;

    expect(opened.map((entry) => entry.name)).toEqual(["a.pdf", "b.md", "c.pdf"]);
    const intents = opened.map((entry) => entry.options?.foregroundIntent);
    expect(intents[0]).toBeDefined();
    expect(new Set(intents).size).toBe(1);
  });

  // Chromium's File System Access picker, like every other route, takes a
  // multi-select; each file keeps its handle so its recent reopens it.
  test("on the web, every file of a handle-picker multi-select opens, in order", async () => {
    const { acquire, opened } = setup("web", {
      webHandles: {
        pickDocuments: async () => [
          { name: "a.pdf", size: 1, bytes, webFileHandleId: "h-a" },
          { name: "b.md", size: 1, bytes, webFileHandleId: "h-b" },
        ],
      },
      open: {
        document: async (loaded, options) => {
          opened.push({ name: `${loaded.name}|${loaded.webFileHandleId}`, options });
        },
        pdf: async () => {},
      },
    });

    await acquire.pick();

    expect(opened.map((entry) => entry.name)).toEqual(["a.pdf|h-a", "b.md|h-b"]);
    const intents = opened.map((entry) => entry.options?.foregroundIntent);
    expect(intents[0]).toBeDefined();
    expect(new Set(intents).size).toBe(1);
  });

  // A claimed intent sends every slower open still in flight to the
  // background, so a picker that opens nothing must not claim one.
  test.each([
    ["desktop", "a cancel", []],
    ["web", "a cancel", []],
    ["web", "only unsupported files", [{ name: "a.exe", size: 1, bytes }]],
  ] as const)(
    "%s: a pick that opens nothing (%s) leaves an earlier open in front",
    async (on, _what, files) => {
      const { acquire, store, opened } = setup(on, {
        platform: { pickDocuments: async () => [] },
        webHandles: { pickDocuments: async () => [...files] },
      });
      const before = store.getState().navigation.foregroundIntent;

      await acquire.pick();

      expect(opened).toEqual([]);
      expect(store.getState().navigation.foregroundIntent).toBe(before);
    },
  );
});

describe("a tab whose file could not be restored", () => {
  // Desktop once reopened through the generic picker: the same file matched
  // this very tab as a duplicate, so nothing happened and the failure stayed.
  test("on desktop, reads the picked file into itself; extra picks become new tabs", async () => {
    const { acquire, opened } = setup(
      "desktop",
      { platform: { pickDocuments: async () => [payload("paper.pdf"), payload("notes.md")] } },
      [failedTab()],
    );

    await acquire.reselectTab("t");

    expect(opened[0]).toMatchObject({
      name: "paper.pdf",
      options: { tabId: "t", skipDuplicateCheck: true, pdfView: { pageIndex: 4 } },
    });
    expect(opened[1]?.name).toBe("notes.md");
    expect(opened[1]?.options?.tabId).toBeUndefined();
  });

  test("a password-locked PDF asks for its password again, not for a file", async () => {
    const { acquire, store, coldLoads, pickers } = setup("desktop", {}, [
      failedTab({ unavailableDetail: "pdf-password-required" }),
    ]);

    await acquire.reselectTab("t");

    expect(coldLoads).toEqual(["t"]);
    expect(pickers).toEqual([]);
    expect(store.getState().tabs[0]).toMatchObject({ status: "unloaded" });
    expect(store.getState().tabs[0]?.unavailableDetail).toBeUndefined();
  });
});

describe("reopening a recent document", () => {
  const recentPdf = (overrides: Partial<RecentEntry> = {}) =>
    ({ name: "paper.pdf", pages: 3, size: 1, savedAt: 1, ...overrides }) as RecentEntry;

  test("a desktop file that moved drops its row and says so", async () => {
    const { acquire, forgotten, notices } = setup("desktop", {
      platform: {
        readPdfAtPath: async () => {
          throw new PlatformPdfOpenError("unavailable", "gone");
        },
      },
    });

    const ok = await acquire.reopenRecent(recentPdf({ path: "/moved/paper.pdf" }));

    expect(ok).toBe(false);
    expect(forgotten).toEqual(["paper.pdf"]);
    expect(notices).toEqual([{ kind: "recentMissing", detail: "/moved/paper.pdf" }]);
  });

  // Browsers revoke handles after a reload; the file is still there.
  test("a web file whose access lapsed keeps its row and offers to grant it again", async () => {
    const { acquire, forgotten, notices, pickers } = setup("web", {
      webHandles: {
        readPdf: async () => {
          throw new WebFileHandleOpenError("permissionDenied", "denied");
        },
      },
    });

    const ok = await acquire.reopenRecent(recentPdf({ webFileHandleId: "h1" }));

    expect(ok).toBe(false);
    expect(forgotten).toEqual([]);
    expect(notices).toMatchObject([
      { kind: "webAccessLost", name: "paper.pdf", code: "permissionDenied" },
    ]);
    const notice = notices[0];
    if (notice?.kind === "webAccessLost") notice.reauthorize();
    await Bun.sleep(0);
    expect(pickers).toEqual(["webPdf"]);
  });

  test("a recent Markdown opens its working copy, still anchored to its file", async () => {
    const { acquire, opened } = setup("desktop", {
      getCachedSource: async (id) => ({
        id,
        kind: "markdown",
        name: "notes.md",
        size: 5,
        bytes,
        savedAt: 1,
      }),
      open: {
        document: async (loaded) => {
          opened.push({ name: `${loaded.name}|${loaded.path}|${loaded.cacheId}` });
        },
        pdf: async () => {},
      },
    });

    const ok = await acquire.reopenRecent(
      recentPdf({ name: "notes.md", kind: "markdown", cacheId: "copy-1", path: "/n/notes.md" }),
    );

    expect(ok).toBe(true);
    expect(opened.map((entry) => entry.name)).toEqual(["notes.md|/n/notes.md|copy-1"]);
  });

  test("a recent Markdown whose working copy is gone drops its row", async () => {
    const { acquire, forgotten, notices, opened } = setup("desktop");

    const ok = await acquire.reopenRecent(
      recentPdf({ name: "notes.md", kind: "markdown", cacheId: "copy-1", path: "/n/notes.md" }),
    );

    expect(ok).toBe(false);
    expect(opened).toEqual([]);
    expect(forgotten).toEqual(["notes.md"]);
    expect(notices).toEqual([{ kind: "workingCopyMissing", name: "notes.md" }]);
  });
});
