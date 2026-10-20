import { describe, expect, test } from "bun:test";
import { exportSnapshotKey } from "../../editor/export/exportStatus";
import { createPdfEditorStore } from "../../editor/store/store";
import type { Draft } from "../../storage/drafts";
import { captureSuspendedPdfSnapshot } from "../../storage/runtimeSessions";
import type { WorkspaceRuntimeTab } from "../types";
import { openDocument } from "./openDocument";
import { openPdf } from "./openPdf";
import {
  bytes,
  deferred,
  fakeEngine,
  fakePorts,
  pdf,
  tabIds,
  workspace,
} from "./testing";

describe("openPdf", () => {
  test("opens a PDF as the active tab with its pages", async () => {
    const store = workspace();
    const { ports, log, editors } = fakePorts(store);

    await openPdf(pdf("paper.pdf"), {}, ports);

    const [tab] = store.getState().tabs;
    expect(tab).toMatchObject({ kind: "pdf", title: "paper.pdf", status: "loaded" });
    expect(store.getState().activeTabId).toBe(tab!.id);
    expect(editors.get(tab!.id)?.getState().model.pages).toHaveLength(2);
    expect(log.shown).toEqual([editors.get(tab!.id)!]);
    expect(log.recents).toEqual(["paper.pdf"]);
  });

  test("an open the reader moved on from builds its tab but leaves the screen alone", async () => {
    const store = workspace();
    const parse = deferred<void>();
    const { engine } = fakeEngine();
    const { ports } = fakePorts(store, {
      engine: {
        ...engine,
        load: async (input, options) => {
          await parse.promise;
          return engine.load(input, options);
        },
      },
    });

    const opening = openPdf(pdf("big.pdf"), {}, ports);
    store.getState().claimNavigation(); // the reader clicks something else
    parse.resolve();
    await opening;

    expect(tabIds(store)).toHaveLength(1);
    expect(store.getState().activeTabId).toBeNull();
  });

  test("reopening an open file switches to its tab instead of adding one", async () => {
    const store = workspace();
    const { ports, log } = fakePorts(store);
    await openPdf(pdf("paper.pdf"), {}, ports);
    const [first] = tabIds(store);
    store.getState().setActiveTab(null);

    await openPdf(pdf("paper.pdf"), {}, ports);

    expect(tabIds(store)).toEqual([first!]);
    expect(log.activated).toEqual([first!]);
  });

  test("an encrypted PDF asks for its password and keeps the whole request", async () => {
    const store = workspace();
    const { engine } = fakeEngine({
      load: async () => {
        throw Object.assign(new Error("No password given"), { name: "PasswordException" });
      },
    });
    const { ports, log } = fakePorts(store, { engine });
    const view = { pageIndex: 3 } as never;

    await openPdf({ ...pdf("locked.pdf"), password: "wrong" }, { tabId: "t", pdfView: view }, ports);

    expect(log.passwords).toHaveLength(1);
    expect(log.passwords[0]).toMatchObject({
      input: { name: "locked.pdf", password: undefined },
      options: { tabId: "t", pdfView: view },
      wrongPassword: true,
    });
  });

  test("a restore that cannot get a resident slot marks its tab unavailable", async () => {
    const tab = { id: "t", kind: "pdf", title: "paper.pdf", status: "loading", source: { type: "path", path: "/docs/paper.pdf" } } as WorkspaceRuntimeTab;
    const store = workspace([tab], "t");
    const { ports, destroyed, editors } = fakePorts(store);
    ports.editors.reserveResidentSlot = async () => false;

    await openPdf(pdf("paper.pdf"), { tabId: "t", skipDuplicateCheck: true }, ports);

    expect(store.getState().tabs[0]).toMatchObject({
      status: "unavailable",
      unavailableDetail: "runtime-storage-admission-failed",
    });
    expect(destroyed).toHaveLength(1);
    expect(editors.size).toBe(0);
  });

  test("a tab closed while its restore finishes is not brought back", async () => {
    const tab = { id: "t", kind: "pdf", title: "paper.pdf", status: "loading", source: { type: "path", path: "/docs/paper.pdf" } } as WorkspaceRuntimeTab;
    const store = workspace([tab], "t");
    const { ports, destroyed, editors } = fakePorts(store);
    ports.runtime.removeSession = async () => {
      store.setState({ tabs: [], activeTabId: null }); // the reader closes it
    };

    await openPdf(
      pdf("paper.pdf"),
      {
        tabId: "t",
        skipDuplicateCheck: true,
        runtimeSnapshot: snapshotFor(),
        shouldActivate: () => store.getState().activeTabId === "t",
      },
      ports,
    );

    expect(tabIds(store)).toEqual([]);
    expect(editors.has("t")).toBe(false);
    expect(destroyed).toHaveLength(1);
  });

  // A resumed PDF gets its model back from the suspended snapshot, with the
  // page ids it had. The baseline computed for this load's fresh page ids
  // never matched it, so an untouched document came back "not exported".
  test("a PDF resumed from suspension is not marked unexported", async () => {
    const store = workspace();
    const { ports, editors } = fakePorts(store);
    await openPdf(pdf("paper.pdf"), {}, ports);
    const [tabId] = tabIds(store);
    const snapshot = captureSuspendedPdfSnapshot(editors.get(tabId!)!);
    editors.delete(tabId!); // suspended: only the snapshot remains
    store.getState().updateTab(tabId!, (tab) => ({ ...tab, status: "suspended" }));
    store.getState().setActiveTab(tabId!);

    await openPdf(pdf("paper.pdf"), { tabId, runtimeSnapshot: snapshot, skipDuplicateCheck: true }, ports);

    const resumed = exportSnapshotKey(editors.get(tabId!)!.getState().model);
    expect(store.getState().session.exportBaselineSnapshot).toBe(resumed);
    expect(store.getState().tabs[0]?.exportBaselineSnapshot).toBe(resumed);
  });

  test("an edit made before suspension still reads as unexported after resume", async () => {
    const store = workspace();
    const { ports, editors } = fakePorts(store);
    await openPdf(pdf("paper.pdf"), {}, ports);
    const [tabId] = tabIds(store);
    editors.get(tabId!)!.getState().insertBlankPage(null);
    const snapshot = captureSuspendedPdfSnapshot(editors.get(tabId!)!);
    editors.delete(tabId!);
    store.getState().updateTab(tabId!, (tab) => ({ ...tab, status: "suspended" }));

    await openPdf(pdf("paper.pdf"), { tabId, runtimeSnapshot: snapshot, skipDuplicateCheck: true }, ports);

    const resumed = exportSnapshotKey(editors.get(tabId!)!.getState().model);
    expect(store.getState().session.exportBaselineSnapshot).not.toBe(resumed);
  });

  test("a saved draft is restored silently, with a way back to the original", async () => {
    const store = workspace();
    const { ports, editors } = fakePorts(store);
    const note = {
      id: "n",
      type: "note",
      pageId: "draft-p1",
      rect: { x: 1, y: 1, w: 1, h: 1 },
      text: "mine",
      color: "#fff",
      createdAt: 1,
      updatedAt: 1,
    };
    ports.drafts.get = async () =>
      ({
        lastTouched: 5,
        model: {
          pages: [{ id: "draft-p1", sourceIndex: 0, rotation: 0, widthPt: 1, heightPt: 1 }],
          overlays: [note],
        },
        history: [],
        completedLiveOperationIds: ["live-1"],
      }) as unknown as Draft;

    await openPdf(pdf("paper.pdf"), {}, ports);

    const [tab] = store.getState().tabs;
    const editor = editors.get(tab!.id)!;
    expect(editor.getState().model.overlays.map((o) => o.id)).toEqual(["n"]);
    expect([...editor.getState().completedLiveOperationIds]).toEqual(["live-1"]);
    expect(store.getState().session.restoredDraft?.originalModel.overlays).toEqual([]);
  });

  test("a restore that fails to parse says why on its tab", async () => {
    const tab = { id: "t", kind: "pdf", title: "paper.pdf", status: "loading", source: { type: "path", path: "/docs/paper.pdf" } } as WorkspaceRuntimeTab;
    const store = workspace([tab], "t");
    const { engine } = fakeEngine({
      load: async () => {
        throw new Error("Invalid PDF structure");
      },
    });
    const { ports, log } = fakePorts(store, { engine });

    await openPdf(pdf("paper.pdf"), { tabId: "t", skipDuplicateCheck: true }, ports);

    expect(store.getState().tabs[0]).toMatchObject({
      status: "unavailable",
      unavailableDetail: "ERR · Invalid PDF structure",
    });
    expect(log.errors).toEqual(["Invalid PDF structure"]);
  });
});

describe("openDocument", () => {
  test("a Markdown file opens as text on screen, with no PDF attached", async () => {
    const store = workspace();
    let detached = 0;
    const { ports, log } = fakePorts(store);
    ports.editors.detach = () => {
      detached += 1;
    };

    await openDocument(
      { kind: "markdown", name: "notes.md", size: 5, bytes: new TextEncoder().encode("# Hi!"), path: "/n/notes.md" },
      {},
      ports,
    );

    const [tab] = store.getState().tabs;
    expect(tab).toMatchObject({ kind: "markdown", text: "# Hi!", status: "loaded" });
    expect(store.getState().activeTabId).toBe(tab!.id);
    expect(detached).toBe(1);
    expect(log.recents).toEqual(["notes.md"]);
  });

  test("a Markdown file that is not UTF-8 opens marked lossy, so it is never saved over", async () => {
    const store = workspace();
    const { ports } = fakePorts(store);
    // "中文" in GBK: not valid UTF-8, so the decoded text is U+FFFD mojibake.
    const gbk = bytes(0x23, 0x20, 0xd6, 0xd0, 0xce, 0xc4);

    await openDocument({ kind: "markdown", name: "gbk.md", size: gbk.length, bytes: gbk, path: "/n/gbk.md" }, {}, ports);
    await openDocument(
      { kind: "markdown", name: "utf8.md", size: 8, bytes: new TextEncoder().encode("# 中文"), path: "/n/utf8.md" },
      {},
      ports,
    );

    const [lossy, clean] = store.getState().tabs;
    expect(lossy).toMatchObject({ title: "gbk.md", textLossy: true });
    expect(clean?.title).toBe("utf8.md");
    expect(clean?.textLossy).toBeUndefined();
  });

  test("a byte order mark is kept on the tab, not in the text the editor parses", async () => {
    const store = workspace();
    const { ports } = fakePorts(store);
    const withBom = bytes(0xef, 0xbb, 0xbf, ...new TextEncoder().encode("# Hi"));

    await openDocument({ kind: "markdown", name: "bom.md", size: withBom.length, bytes: withBom, path: "/n/bom.md" }, {}, ports);

    expect(store.getState().tabs[0]).toMatchObject({ text: "# Hi", textBom: true });
  });

  test("a rejected document restore marks its tab unavailable", async () => {
    const tab = { id: "t", kind: "docx", title: "a.docx", status: "loading", source: { type: "path", path: "/a.docx" } } as WorkspaceRuntimeTab;
    const store = workspace([tab], "t");
    const { ports } = fakePorts(store);
    ports.ui.reportDocumentPolicyError = () => true;

    await openDocument({ kind: "docx", name: "a.docx", size: 4, bytes: bytes(1, 2, 3, 4), path: "/a.docx" }, { tabId: "t" }, ports);

    expect(store.getState().tabs[0]?.status).toBe("unavailable");
  });
});

/** What suspending a resident PDF leaves behind. */
function snapshotFor() {
  return captureSuspendedPdfSnapshot(createPdfEditorStore());
}
