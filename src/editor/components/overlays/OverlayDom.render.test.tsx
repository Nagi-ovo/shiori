import "../../../test/setupDom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { useState } from "react";
import i18n from "../../../i18n";
import type {
  CalloutOverlay,
  NoteOverlay,
  PageModel,
  TextOverlay,
} from "../../../pdf/model/types";
import { useEditorStore } from "../../store/store";
import { OverlayDom } from "./OverlayDom";

const initialStore = useEditorStore.getState();

const page: PageModel = {
  id: "page-1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
};

const note: NoteOverlay = {
  type: "note",
  id: "note-1",
  pageId: page.id,
  rect: { x: 40, y: 500, w: 168, h: 94 },
  text: "A careful note",
  color: "#f7e9a8",
  createdAt: 1_000,
  updatedAt: 1_000,
};

function renderNote(
  overlay: NoteOverlay = note,
  interactivePointerEvents: "auto" | "none" = "auto",
  renderPage: PageModel = page,
  scale = 1,
) {
  return render(
    <OverlayDom
      overlay={overlay}
      page={renderPage}
      scale={scale}
      selected={false}
      editing={false}
      interactivePointerEvents={interactivePointerEvents}
      onStartEdit={() => undefined}
      onCommitEdit={() => undefined}
      onPointerDown={() => undefined}
      onHandlePointerDown={() => undefined}
      onRotateHandlePointerDown={() => undefined}
      onMaybeSuppressEditDragBlur={() => false}
      now={2_000}
    />,
  );
}

function EditableNoteHarness({
  initialNote = note,
}: {
  initialNote?: NoteOverlay;
}) {
  const [editing, setEditing] = useState(false);
  const [overlay, setOverlay] = useState(initialNote);
  return (
    <OverlayDom
      overlay={overlay}
      page={page}
      scale={1}
      selected={false}
      editing={editing}
      interactivePointerEvents="auto"
      onStartEdit={() => setEditing(true)}
      onCommitEdit={(_overlay, patch) => {
        setOverlay((current) => ({ ...current, ...patch }));
        setEditing(false);
      }}
      onPointerDown={() => undefined}
      onHandlePointerDown={() => undefined}
      onRotateHandlePointerDown={() => undefined}
      onMaybeSuppressEditDragBlur={() => false}
      now={2_000}
    />
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useEditorStore.setState(initialStore, true);
});

describe("note presentation", () => {
  test("collapses without document history and transfers disclosure focus", async () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [note] },
      undoStack: [],
      redoStack: [],
      collapsedNoteIds: [],
    });
    const modelBefore = useEditorStore.getState().model;
    const view = renderNote();

    const collapse = view.getByRole("button", { name: "Collapse note" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapse);

    const expand = view.getByRole("button", { name: "Expand note" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect((expand as HTMLElement).style.width).toBe("30px");
    await waitFor(() => expect(document.activeElement).toBe(expand));
    expect(useEditorStore.getState().model).toBe(modelBefore);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);

    fireEvent.keyDown(expand, { key: "Enter" });
    const collapseAgain = view.getByRole("button", { name: "Collapse note" });
    await waitFor(() => expect(document.activeElement).toBe(collapseAgain));
    fireEvent.keyDown(collapseAgain, { key: "Escape" });
    const expandAgain = view.getByRole("button", { name: "Expand note" });
    await waitFor(() => expect(document.activeElement).toBe(expandAgain));
    fireEvent.keyDown(expandAgain, { key: " " });

    expect(view.getByRole("button", { name: "Collapse note" })).toBeTruthy();
    expect(useEditorStore.getState().collapsedNoteIds).toEqual([]);
  });

  test("commits editing Escape before a second Escape collapses in reader mode", async () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [note] },
      collapsedNoteIds: [],
      readerMode: true,
    });
    const view = render(<EditableNoteHarness />);
    const body = view.getByText("A careful note");
    const card = body.closest('[data-role="interactive"]');
    if (!card) throw new Error("expected note card");
    fireEvent.doubleClick(card);
    const textarea = view.getByRole("textbox");
    expect(document.activeElement).toBe(textarea);

    fireEvent.keyDown(textarea, { key: "Escape" });
    const collapse = await view.findByRole("button", { name: "Collapse note" });
    await waitFor(() => expect(document.activeElement).toBe(collapse));

    const readerEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") useEditorStore.setState({ readerMode: false });
    };
    window.addEventListener("keydown", readerEscape);
    try {
      fireEvent.keyDown(collapse, { key: "Escape" });
      const expand = await view.findByRole("button", { name: "Expand note" });
      await waitFor(() => expect(document.activeElement).toBe(expand));
      expect(useEditorStore.getState().readerMode).toBe(true);
    } finally {
      window.removeEventListener("keydown", readerEscape);
    }
  });

  test("keeps disclosure available for locked notes", async () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [{ ...note, locked: true }] },
      collapsedNoteIds: [],
      readerMode: true,
    });
    const view = renderNote({ ...note, locked: true }, "none");
    const collapse = view.getByRole("button", { name: "Collapse note" });
    expect((collapse as HTMLElement).style.pointerEvents).toBe("auto");
    fireEvent.click(collapse);
    const expand = view.getByRole("button", { name: "Expand note" });
    await waitFor(() => expect(document.activeElement).toBe(expand));
    fireEvent.keyDown(expand, { key: " " });
    expect(view.getByRole("button", { name: "Collapse note" })).toBeTruthy();
    expect(view.queryByRole("textbox")).toBeNull();
  });

  test("keeps disclosure clickable while drawing tools pass notes through", async () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [note] },
      collapsedNoteIds: [],
      readerMode: false,
    });
    const view = renderNote(note, "none");
    const collapse = view.getByRole("button", { name: "Collapse note" });
    expect((collapse as HTMLElement).style.pointerEvents).toBe("auto");
    fireEvent.click(collapse);

    const expand = view.getByRole("button", { name: "Expand note" });
    expect((expand as HTMLElement).style.pointerEvents).toBe("auto");
    fireEvent.click(expand);
    expect(view.getByRole("button", { name: "Collapse note" })).toBeTruthy();
  });

  test("commits in-progress text before collapsing an editing note", async () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [note] },
      collapsedNoteIds: [],
    });
    const view = render(<EditableNoteHarness />);
    const card = view
      .getByText("A careful note")
      .closest('[data-role="interactive"]');
    if (!card) throw new Error("expected note card");
    fireEvent.doubleClick(card);

    const textarea = view.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Edited before collapse" } });
    const collapse = view.getByRole("button", { name: "Collapse note" });
    expect((collapse as HTMLElement).style.zIndex).toBe("2");
    fireEvent.pointerDown(collapse);
    fireEvent.click(collapse);
    expect(textarea.dataset.escapeCommitted).toBe("true");

    fireEvent.click(view.getByRole("button", { name: "Expand note" }));
    expect(view.getByText("Edited before collapse")).toBeTruthy();
    expect(view.queryByRole("textbox")).toBeNull();
  });

  test("does not retain disclosure state when an empty editing note commits", () => {
    const emptyNote = { ...note, id: "empty-note", text: "" };
    useEditorStore.setState({
      model: { pages: [page], overlays: [emptyNote] },
      collapsedNoteIds: [],
    });
    const view = render(<EditableNoteHarness initialNote={emptyNote} />);
    const placeholder = view.getByText("Double-click or tap to edit…");
    const card = placeholder.closest('[data-role="interactive"]');
    if (!card) throw new Error("expected note card");
    fireEvent.doubleClick(card);
    fireEvent.click(view.getByRole("button", { name: "Collapse note" }));

    expect(useEditorStore.getState().collapsedNoteIds).toEqual([]);
  });

  test("keeps a fixed disclosure target across zoom and page rotation", () => {
    const rotatedPage = { ...page, rotation: 90 };
    useEditorStore.setState({
      model: { pages: [rotatedPage], overlays: [note] },
      collapsedNoteIds: [],
    });
    const view = renderNote(note, "auto", rotatedPage, 0.4);
    fireEvent.click(view.getByRole("button", { name: "Collapse note" }));

    const expand = view.getByRole("button", { name: "Expand note" });
    expect((expand as HTMLElement).style.width).toBe("30px");
    expect((expand as HTMLElement).style.height).toBe("30px");
    expect((expand as HTMLElement).style.transform).toBe("rotate(89.7deg)");
  });

  test("drags a collapsed note without expanding it, but still expands on tap", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [note] },
      collapsedNoteIds: [],
    });
    let pointerDownCount = 0;
    let bubbledMoveCount = 0;
    const view = render(
      <div onPointerMove={() => (bubbledMoveCount += 1)}>
        <OverlayDom
          overlay={note}
          page={page}
          scale={1}
          selected={false}
          editing={false}
          interactivePointerEvents="auto"
          onStartEdit={() => undefined}
          onCommitEdit={() => undefined}
          onPointerDown={() => (pointerDownCount += 1)}
          onHandlePointerDown={() => undefined}
          onRotateHandlePointerDown={() => undefined}
          onMaybeSuppressEditDragBlur={() => false}
          now={2_000}
        />
      </div>,
    );
    fireEvent.click(view.getByRole("button", { name: "Collapse note" }));

    const expand = view.getByRole("button", { name: "Expand note" });
    fireEvent.pointerDown(expand, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerMove(expand, {
      pointerId: 1,
      clientX: 22,
      clientY: 20,
    });
    expect(bubbledMoveCount).toBe(0);
    fireEvent.pointerMove(expand, {
      pointerId: 1,
      clientX: 28,
      clientY: 20,
    });
    expect(bubbledMoveCount).toBe(1);
    fireEvent.pointerUp(expand, { pointerId: 1, clientX: 28, clientY: 20 });
    fireEvent.click(expand, { detail: 1 });

    expect(pointerDownCount).toBe(1);
    expect(view.getByRole("button", { name: "Expand note" })).toBeTruthy();

    fireEvent.pointerDown(expand, {
      pointerId: 2,
      isPrimary: true,
      button: 0,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerUp(expand, { pointerId: 2, clientX: 20, clientY: 20 });
    fireEvent.click(expand, { detail: 1 });

    expect(pointerDownCount).toBe(2);
    expect(view.getByRole("button", { name: "Collapse note" })).toBeTruthy();
  });

  test("does not give free text sticky-note disclosure semantics", () => {
    const freeText: TextOverlay = {
      type: "text",
      id: "free-text",
      pageId: page.id,
      rect: { x: 40, y: 500, w: 168, h: 40 },
      text: "Drawn directly on the page",
      fontSize: 12,
      color: "#333333",
      bold: false,
      align: "left",
      fontFamily: "sans",
    };
    const view = render(
      <OverlayDom
        overlay={freeText}
        page={page}
        scale={1}
        selected={false}
        editing={false}
        interactivePointerEvents="auto"
        onStartEdit={() => undefined}
        onCommitEdit={() => undefined}
        onPointerDown={() => undefined}
        onHandlePointerDown={() => undefined}
        onRotateHandlePointerDown={() => undefined}
        onMaybeSuppressEditDragBlur={() => false}
        now={2_000}
      />,
    );

    expect(view.queryByRole("button", { name: "Collapse note" })).toBeNull();
    expect(view.getByText("Drawn directly on the page")).toBeTruthy();
  });
});

const callout: CalloutOverlay = {
  type: "callout",
  id: "callout-1",
  pageId: page.id,
  targetRects: [{ x: 100, y: 400, w: 120, h: 12 }],
  rect: { x: 260, y: 380, w: 144, h: 54 },
  text: "这里论证跳步了",
  fontSize: 12,
  color: "#b13a2e",
  bold: false,
  align: "left",
  fontFamily: "sans",
};

function renderCallout(
  overlay: CalloutOverlay = callout,
  scale = 1,
  selected = false,
) {
  return render(
    <OverlayDom
      overlay={overlay}
      page={page}
      scale={scale}
      selected={selected}
      editing={false}
      interactivePointerEvents="auto"
      onStartEdit={() => undefined}
      onCommitEdit={() => undefined}
      onPointerDown={() => undefined}
      onHandlePointerDown={() => undefined}
      onRotateHandlePointerDown={() => undefined}
      onMaybeSuppressEditDragBlur={() => false}
      now={2_000}
    />,
  );
}

function EditableCalloutHarness({
  initialCallout = callout,
}: {
  initialCallout?: CalloutOverlay;
}) {
  const [editing, setEditing] = useState(true);
  const [overlay, setOverlay] = useState(initialCallout);
  return (
    <OverlayDom
      overlay={overlay}
      page={page}
      scale={1}
      selected
      editing={editing}
      interactivePointerEvents="auto"
      onStartEdit={() => setEditing(true)}
      onCommitEdit={(_overlay, patch) => {
        setOverlay((current) => ({ ...current, ...patch }));
        setEditing(false);
      }}
      // Mirrors OverlayLayer: the textarea is fully controlled and every
      // keystroke round-trips through the model before it is committed.
      onDraftTextChange={(_overlay, text) =>
        setOverlay((current) => ({ ...current, text }))
      }
      onPointerDown={() => undefined}
      onHandlePointerDown={() => undefined}
      onRotateHandlePointerDown={() => undefined}
      onMaybeSuppressEditDragBlur={() => false}
      now={2_000}
    />
  );
}

describe("callout disclosure", () => {
  test("collapses to a seal without touching the document model", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [callout] },
      undoStack: [],
      redoStack: [],
      collapsedCalloutIds: [],
    });
    const modelBefore = useEditorStore.getState().model;
    const view = renderCallout();

    const collapse = view.getByRole("button", { name: "Collapse comment" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapse);

    // Same node, so focus survives the toggle without any focus() call.
    const expand = view.getByRole("button", { name: "Expand comment" });
    expect(expand).toBe(collapse);
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(view.getAllByRole("button")).toHaveLength(1);

    const card = view.container.querySelector(
      ".shioriCalloutCard",
    ) as HTMLElement;
    expect(card.style.width).toBe("24px");
    expect(card.style.height).toBe("24px");
    expect(card.style.borderRadius).toBe("999px");

    expect(useEditorStore.getState().collapsedCalloutIds).toEqual(["callout-1"]);
    expect(useEditorStore.getState().model).toBe(modelBefore);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);

    fireEvent.click(expand);
    expect(useEditorStore.getState().collapsedCalloutIds).toEqual([]);
  });

  test("only animates its box while a disclosure morph is in flight", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [callout] },
      collapsedCalloutIds: [],
    });
    const view = renderCallout();
    const card = view.container.querySelector(
      ".shioriCalloutCard",
    ) as HTMLElement;
    // At rest the box must not be transitioned: left/top/width/height also
    // change on every resize-drag frame and every zoom step, and animating
    // those makes the card trail the pointer while the leader tracks it.
    expect(card.style.transition).not.toContain("width");
    expect(card.style.transition).toContain("border-radius");

    fireEvent.click(view.getByRole("button", { name: "Collapse comment" }));
    expect(card.style.transition).toContain("width");
  });

  test("grows the label to fit the text being typed", async () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [callout] },
      collapsedCalloutIds: [],
    });
    // jsdom does no layout, so scrollHeight is always 0 — stand in for the
    // measurement the browser would make.
    const textareaProto = (
      window as unknown as { HTMLTextAreaElement: { prototype: object } }
    ).HTMLTextAreaElement.prototype;
    const original = Object.getOwnPropertyDescriptor(
      textareaProto,
      "scrollHeight",
    );
    Object.defineProperty(textareaProto, "scrollHeight", {
      configurable: true,
      get: () => 90,
    });
    const heights: number[] = [];
    try {
      render(
        <OverlayDom
          overlay={callout}
          page={page}
          scale={2}
          selected
          editing
          interactivePointerEvents="auto"
          onStartEdit={() => undefined}
          onCommitEdit={() => undefined}
          onPointerDown={() => undefined}
          onHandlePointerDown={() => undefined}
          onRotateHandlePointerDown={() => undefined}
          onCalloutAutoHeight={(_overlay, h) => heights.push(h)}
          onMaybeSuppressEditDragBlur={() => false}
          now={2_000}
        />,
      );
      // 90px of content at scale 2 is 45pt, plus 5pt of padding top and bottom.
      await waitFor(() => expect(heights).toEqual([55]));
    } finally {
      if (original) {
        Object.defineProperty(textareaProto, "scrollHeight", original);
      } else {
        delete (textareaProto as Record<string, unknown>).scrollHeight;
      }
    }
  });

  test("keeps a constant on-screen seal across the zoom range", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [callout] },
      collapsedCalloutIds: [callout.id],
    });
    for (const [scale, expected] of [
      [0.3, "24px"],
      [1, "24px"],
      [2, "28px"],
      [4, "40px"],
    ] as const) {
      const view = renderCallout(callout, scale);
      const card = view.container.querySelector(
        ".shioriCalloutCard",
      ) as HTMLElement;
      expect(card.style.width).toBe(expected);
      cleanup();
    }
  });

  test("carries the first grapheme, falling back to an icon when blank", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [callout] },
      collapsedCalloutIds: [callout.id],
    });
    const emoji = renderCallout({ ...callout, text: "👩‍💻 review" });
    expect(emoji.getByText("👩‍💻")).toBeTruthy();
    cleanup();

    const blank = renderCallout({ ...callout, text: "   " });
    const card = blank.container.querySelector(
      ".shioriCalloutCard",
    ) as HTMLElement;
    expect(card.querySelector("svg")).toBeTruthy();
  });

  test("Escape on an open callout collapses it", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [callout] },
      collapsedCalloutIds: [],
    });
    const view = renderCallout(callout, 1, true);
    const card = view.container.querySelector(
      ".shioriCalloutCard",
    ) as HTMLElement;
    fireEvent.keyDown(card, { key: "Escape" });
    expect(useEditorStore.getState().collapsedCalloutIds).toEqual(["callout-1"]);
  });

  test("collapsing mid-edit commits the text first", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [callout] },
      collapsedCalloutIds: [],
    });
    const view = render(<EditableCalloutHarness />);
    const textarea = view.container.querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "edited on the way out" } });
    fireEvent.click(view.getByRole("button", { name: "Collapse comment" }));

    expect(view.getByText("edited on the way out")).toBeTruthy();
    expect(useEditorStore.getState().collapsedCalloutIds).toEqual(["callout-1"]);
  });

  test("never leaves a tombstone for a callout emptied while editing", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [callout] },
      collapsedCalloutIds: [],
    });
    const view = render(<EditableCalloutHarness />);
    const textarea = view.container.querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.click(view.getByRole("button", { name: "Collapse comment" }));

    // An empty callout is removed on commit, so recording its id would leave
    // presentation state pointing at an overlay that no longer exists.
    expect(useEditorStore.getState().collapsedCalloutIds).toEqual([]);
  });
});

describe("callout thread panel", () => {
  const threaded: CalloutOverlay = {
    ...callout,
    thread: [
      {
        id: "turn-1",
        role: "agent",
        author: "Claude Code",
        text: "它们是方差的上下界。",
        at: 1_000,
      },
      { id: "turn-2", role: "user", text: "推导在哪？" },
    ],
  };

  function renderThreaded(
    overlay: CalloutOverlay,
    selected: boolean,
    onCommitEdit: (patch: Partial<CalloutOverlay>) => void = () => undefined,
  ) {
    return render(
      <OverlayDom
        overlay={overlay}
        page={page}
        scale={1}
        selected={selected}
        editing={false}
        interactivePointerEvents="auto"
        onStartEdit={() => undefined}
        onCommitEdit={(_overlay, patch) =>
          onCommitEdit(patch as Partial<CalloutOverlay>)
        }
        onPointerDown={() => undefined}
        onHandlePointerDown={() => undefined}
        onRotateHandlePointerDown={() => undefined}
        onMaybeSuppressEditDragBlur={() => false}
        now={2_000}
      />,
    );
  }

  test("shows the conversation only while selected", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [threaded] },
      collapsedCalloutIds: [],
    });
    const idle = renderThreaded(threaded, false);
    expect(idle.queryByText("推导在哪？")).toBeNull();
    idle.unmount();

    const selectedView = renderThreaded(threaded, true);
    expect(selectedView.getByText("它们是方差的上下界。")).toBeTruthy();
    expect(selectedView.getByText("推导在哪？")).toBeTruthy();
    // Roles: the agent turn shows its author; the user turn shows "You".
    expect(selectedView.getByText("Claude Code")).toBeTruthy();
    expect(selectedView.getByText("You")).toBeTruthy();
  });

  test("does not offer follow-up without a detected local agent", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [threaded] },
      collapsedCalloutIds: [],
    });
    const view = renderThreaded(threaded, true);
    expect(view.queryByPlaceholderText("Follow up…")).toBeNull();
  });

  test("a locked callout shows the thread but no reply box", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [] },
      collapsedCalloutIds: [],
    });
    const view = renderThreaded({ ...threaded, locked: true }, true);
    expect(view.getByText("推导在哪？")).toBeTruthy();
    expect(view.queryByPlaceholderText("Follow up…")).toBeNull();
    // Deleting is an edit; a locked callout offers no per-turn control.
    expect(view.queryByLabelText("Delete this turn")).toBeNull();
  });

  test("flips above the callout instead of hanging off the page bottom", () => {
    // A callout sitting near the foot of the page: rendering the panel below
    // it pushed the conversation past the page edge entirely.
    const nearBottom: CalloutOverlay = {
      ...threaded,
      rect: { x: 260, y: 20, w: 144, h: 54 },
    };
    useEditorStore.setState({
      model: { pages: [page], overlays: [nearBottom] },
      collapsedThreadIds: [],
    });
    const view = renderThreaded(nearBottom, true);
    const panel = view.getByText("推导在哪？").closest("div[data-role]") as
      | HTMLElement
      | null;
    if (!panel) throw new Error("expected the thread panel");

    // Anchored to the card's top edge, not its bottom.
    expect(panel.style.bottom).toBe("100%");
    expect(panel.style.top).toBe("");
    // And bounded, so a long conversation scrolls rather than overflowing.
    expect(parseFloat(panel.style.maxHeight)).toBeGreaterThan(0);
    expect(panel.style.overflowY).toBe("auto");
  });

  test("hangs below and stays inside the page when there is room", () => {
    const nearTop: CalloutOverlay = {
      ...threaded,
      rect: { x: 260, y: 700, w: 144, h: 54 },
    };
    useEditorStore.setState({
      model: { pages: [page], overlays: [nearTop] },
      collapsedThreadIds: [],
    });
    const view = renderThreaded(nearTop, true);
    const panel = view.getByText("推导在哪？").closest("div[data-role]") as
      | HTMLElement
      | null;
    if (!panel) throw new Error("expected the thread panel");

    expect(panel.style.top).toBe("100%");
    expect(panel.style.bottom).toBe("");
    // The card's top in display space is 792 - 700 - 54 = 38px; the panel can
    // use the rest of the page below it, never more.
    const cardTopPx = page.heightPt - 700 - 54;
    expect(parseFloat(panel.style.maxHeight)).toBeLessThanOrEqual(
      page.heightPt - cardTopPx - 54,
    );
  });

  test("folding the conversation touches no document state", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [threaded] },
      undoStack: [],
      collapsedThreadIds: [],
    });
    const modelBefore = useEditorStore.getState().model;
    const view = renderThreaded(threaded, true);

    const toggle = view.getByTitle("Collapse conversation");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);

    // Turns and the reply box fold away; the summary line stays.
    expect(view.queryByText("推导在哪？")).toBeNull();
    expect(view.queryByPlaceholderText("Follow up…")).toBeNull();
    expect(view.getByText("2 turns")).toBeTruthy();
    expect(
      view.getByTitle("Expand conversation").getAttribute("aria-expanded"),
    ).toBe("false");

    // Presentation only — same contract as the note/callout seals.
    expect(useEditorStore.getState().collapsedThreadIds).toEqual(["callout-1"]);
    expect(useEditorStore.getState().model).toBe(modelBefore);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
  });

  test("deleting a turn edits the document through onCommitEdit", () => {
    useEditorStore.setState({
      model: { pages: [page], overlays: [threaded] },
      collapsedThreadIds: [],
    });
    let patch: Partial<CalloutOverlay> | null = null;
    const view = renderThreaded(threaded, true, (next) => {
      patch = next;
    });
    fireEvent.click(view.getAllByLabelText("Delete this turn")[0]!);

    const committed = patch as Partial<CalloutOverlay> | null;
    expect(committed?.thread).toHaveLength(1);
    expect(committed!.thread![0]!.id).toBe("turn-2");
  });

  test("deleting the last turn clears the thread rather than leaving it empty", () => {
    const single: CalloutOverlay = {
      ...callout,
      thread: [{ id: "only", role: "user", text: "solo" }],
    };
    useEditorStore.setState({
      model: { pages: [page], overlays: [single] },
      collapsedThreadIds: [],
    });
    let patch: Partial<CalloutOverlay> | null = null;
    const view = renderThreaded(single, true, (next) => {
      patch = next;
    });
    fireEvent.click(view.getByLabelText("Delete this turn"));
    expect((patch as Partial<CalloutOverlay> | null)?.thread).toBeUndefined();
  });
});
