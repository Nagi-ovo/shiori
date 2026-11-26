import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import i18n from "../../i18n";
import { model, overlay } from "../../pdf/export/contentText/fixtures.test-support";
import { useEditorStore } from "../store/store";
import { ContextualToolbar } from "./ContextualToolbar";
import { OverlayLayer } from "./OverlayLayer";

const initialStore = useEditorStore.getState();
const [page] = model([]).pages;
const draft = overlay({ text: "ABCDE" });

function PageEditor() {
  const overlays = useEditorStore((state) => state.model.overlays);
  return <OverlayLayer page={page!} scale={1} overlays={overlays} />;
}

const originalResizeObserver = globalThis.ResizeObserver;
beforeAll(async () => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage("en");
});

afterAll(() => { globalThis.ResizeObserver = originalResizeObserver; });

afterEach(() => {
  cleanup();
  useEditorStore.setState(initialStore, true);
});

function startEditing() {
  useEditorStore.setState({ model: model([]), undoStack: [], redoStack: [], tool: "text" });
  const store = useEditorStore.getState();
  store.addOverlay(draft);
  store.selectOnly(draft.id);
  store.setEditingOverlayId(draft.id);
  const view = render(<><ContextualToolbar /><PageEditor /></>);
  const editor = view.container.querySelector<HTMLTextAreaElement>('textarea[data-role="interactive"]')!;
  const toolbarEditor = view.container.querySelector<HTMLTextAreaElement>('textarea[data-shiori-text-toolbar-editor]')!;
  return { ...view, editor, toolbarEditor };
}

for (const path of ["page blur", "page Escape", "toolbar Escape"] as const) {
  test(`clearing selected source text via ${path} commits a deletion`, () => {
    const { editor, toolbarEditor } = startEditing();
    const field = path === "toolbar Escape" ? toolbarEditor : editor;
    if (field === toolbarEditor) fireEvent.blur(editor, { relatedTarget: field });
    act(() => field.focus());
    fireEvent.input(field, { target: { value: "" } });
    fireEvent.keyUp(field, { key: "Backspace" });
    expect(useEditorStore.getState().model.overlays[0]).toMatchObject({ text: "" });
    if (path === "page blur") fireEvent.blur(field);
    else fireEvent.keyDown(field, { key: "Escape" });

    const state = useEditorStore.getState();
    expect(state.editingOverlayId).toBeNull();
    expect(state.model.overlays).toMatchObject([{ text: "", originalText: "ABCDE" }]);
    act(() => state.undo());
    expect(useEditorStore.getState().model.overlays).toEqual([]);
    act(() => state.redo());
    expect(useEditorStore.getState().model.overlays).toMatchObject([{ text: "" }]);
  });
}

test("a pristine source edit closes without any model or undo change", () => {
  const { editor } = startEditing();
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(useEditorStore.getState().model.overlays).toEqual([]);
  expect(useEditorStore.getState().undoStack).toEqual([]);
});

test("moving focus to a style control preserves a size-only edit after blur", () => {
  const { editor, getByRole } = startEditing();
  const stepper = getByRole("button", { name: "Increase: Size" });
  fireEvent.blur(editor, { relatedTarget: stepper });
  fireEvent.click(stepper);
  fireEvent.blur(stepper);
  const state = useEditorStore.getState();
  expect(state.editingOverlayId).toBeNull();
  expect(state.model.overlays).toMatchObject([{ text: "ABCDE", fontSize: 11 }]);
  act(() => state.undo());
  expect(useEditorStore.getState().model.overlays).toEqual([]);
});
