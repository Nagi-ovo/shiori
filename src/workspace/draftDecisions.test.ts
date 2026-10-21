import { describe, expect, test } from "bun:test";
import { createPdfEditorStore } from "../editor/store/store";
import type { DocumentModel, PageModel } from "../pdf/model/types";
import {
  deferDraft,
  discardDraft,
  openOriginal,
  raiseDeferredDraft,
  restoreDraft,
  type DraftDecisionPorts,
} from "./draftDecisions";
import type { PendingRestore, WorkspaceRuntimeTab } from "./types";
import { createWorkspaceStore } from "./workspaceStore";

const page = (id: string): PageModel => ({ id, sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 });
const original: DocumentModel = { pages: [page("p1")], overlays: [] };

const draft = {
  hash: "h",
  draftId: "h|path:/docs/paper.pdf",
  lastTouched: 1,
  draftModelPages: [page("p1"), page("added")],
  draftModelOverlays: [],
  draftHistory: [],
  completedLiveOperationIds: [],
} as unknown as PendingRestore;

function setup(session: Partial<ReturnType<ReturnType<typeof createWorkspaceStore>["getState"]>["session"]>) {
  const tab = { id: "t", kind: "pdf", title: "paper.pdf", status: "loaded" } as WorkspaceRuntimeTab;
  const store = createWorkspaceStore({ tabs: [tab], activeTabId: "t", folderPaths: [] });
  store.getState().setSession(session);
  const editor = createPdfEditorStore();
  editor.setState({ model: original });
  const removed: string[] = [];
  const ports: DraftDecisionPorts = {
    store,
    editor: () => editor,
    removeDraft: (draftId) => removed.push(draftId),
  };
  const pageIds = () => editor.getState().model.pages.map((p) => p.id);
  const tabNow = () => store.getState().tabs[0]!;
  return { store, editor, ports, removed, pageIds, tabNow };
}

describe("a draft set aside or in conflict", () => {
  test("restoring it loads the draft and settles the question", () => {
    const { store, ports, pageIds, tabNow } = setup({ deferredDraft: draft });

    restoreDraft(ports);

    expect(pageIds()).toEqual(["p1", "added"]);
    expect(store.getState().session).toMatchObject({ pendingRestore: null, deferredDraft: null });
    expect(tabNow().draftRestore).toBeUndefined();
  });

  test("discarding it deletes the draft and keeps the document as it is", () => {
    const { store, ports, pageIds, removed } = setup({ pendingRestore: draft });

    discardDraft(ports);

    expect(removed).toEqual(["h|path:/docs/paper.pdf"]);
    expect(pageIds()).toEqual(["p1"]);
    expect(store.getState().session.pendingRestore).toBeNull();
  });

  // Esc is not a decision: the draft must survive and the question come back.
  test("dismissing the conflict sets the draft aside instead of deciding", () => {
    const { store, ports, removed, tabNow } = setup({ pendingRestore: draft });

    deferDraft(ports);

    expect(removed).toEqual([]);
    expect(store.getState().session).toMatchObject({ pendingRestore: null, deferredDraft: draft });
    expect(tabNow().draftRestore).toEqual({ mode: "deferred", draft });
  });

  test("the first edit while a draft is set aside asks about it again", () => {
    const { store, tabNow } = setup({ deferredDraft: draft });

    raiseDeferredDraft(store, draft);

    expect(store.getState().session).toMatchObject({ pendingRestore: draft, deferredDraft: null });
    expect(tabNow().draftRestore).toEqual({ mode: "pending", draft });
  });
});

describe("opening the original after a silent restore", () => {
  test("goes back to the document as opened and sets the draft aside", () => {
    const restored: DocumentModel = { pages: [page("p1"), page("added")], overlays: [] };
    const { store, editor, ports, pageIds } = setup({});
    editor.setState({ model: restored });
    store.getState().setSession({
      restoredDraft: { draft, originalModel: original, committedModel: restored },
    });

    openOriginal(ports);

    expect(pageIds()).toEqual(["p1"]);
    expect(store.getState().session).toMatchObject({ restoredDraft: null, deferredDraft: draft });
  });

  test("does nothing once the restored document was edited", () => {
    const restored: DocumentModel = { pages: [page("p1"), page("added")], overlays: [] };
    const { store, editor, ports, pageIds } = setup({});
    store.getState().setSession({
      restoredDraft: { draft, originalModel: original, committedModel: restored },
    });
    editor.setState({ model: { ...restored, pages: [...restored.pages, page("edit")] } });

    openOriginal(ports);

    expect(pageIds()).toEqual(["p1", "added", "edit"]);
    expect(store.getState().session.deferredDraft).toBeNull();
  });
});
