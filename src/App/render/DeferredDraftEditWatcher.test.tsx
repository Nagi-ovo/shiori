import "../../test/setupDom";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { createPdfEditorStore, EditorStoreContext } from "../../editor/store/store";
import type { PendingRestore } from "../../workspace/types";
import { DeferredDraftEditWatcher } from "./persisters";

const draft = { hash: "h" } as PendingRestore;

function watch(deferredDraft: PendingRestore | null) {
  const editor = createPdfEditorStore();
  editor.setState({
    model: { pages: [{ id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 }], overlays: [] },
  });
  const asked: PendingRestore[] = [];
  const onEdit = (d: PendingRestore) => asked.push(d);
  const tree = (next: PendingRestore | null) => (
    <EditorStoreContext.Provider value={editor}>
      <DeferredDraftEditWatcher deferredDraft={next} onEdit={onEdit} />
    </EditorStoreContext.Provider>
  );
  const view = render(tree(deferredDraft));
  const edit = () => act(() => editor.getState().insertBlankPage(null));
  return { editor, asked, edit, setDeferred: (next: PendingRestore | null) => view.rerender(tree(next)) };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("a draft set aside", () => {
  test("the first edit after it was set aside asks about it", () => {
    const { asked, edit } = watch(draft);
    expect(asked).toEqual([]);

    edit();

    expect(asked).toEqual([draft]);
  });

  // Dismissing the conflict dialog sets the draft aside again. The edit that
  // raised the conflict was already on the undo stack, and counting it again
  // reopened the dialog at once: it could only be closed by deciding.
  test("an edit made before it was set aside does not ask again", () => {
    const { asked, edit, setDeferred } = watch(null);
    edit(); // the edit that raised the conflict
    setDeferred(draft); // the reader dismisses the dialog

    expect(asked).toEqual([]);

    edit();
    expect(asked).toEqual([draft]);
  });
});
