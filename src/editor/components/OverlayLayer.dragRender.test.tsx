import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { useMemo } from "react";
import i18n from "../../i18n";
import type {
  CalloutOverlay,
  NoteOverlay,
  Overlay,
  PageModel,
  RectOverlay,
} from "../../pdf/model/types";
import { useEditorStore } from "../store/store";
import { OverlayLayer } from "./OverlayLayer";
import { ScrollerContext } from "./ScrollerContext";

const initialStore = useEditorStore.getState();
const page: PageModel = {
  id: "page-1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
};

function rect(index: number): RectOverlay {
  return {
    type: "rect",
    id: `rect-${index}`,
    pageId: page.id,
    rect: { x: 20 + (index % 8) * 65, y: 650 - Math.floor(index / 8) * 70, w: 54, h: 42 },
    color: "#a44",
    strokeWidth: 1,
  };
}

function note(index: number): NoteOverlay {
  return {
    type: "note",
    id: `note-${index}`,
    pageId: page.id,
    rect: { x: 20 + (index % 8) * 65, y: 360 - Math.floor(index / 8) * 70, w: 54, h: 42 },
    text: `note ${index}`,
    color: "#f7e9a8",
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

const overlays: Overlay[] = [
  ...Array.from({ length: 24 }, (_, index) => rect(index)),
  ...Array.from({ length: 24 }, (_, index) => note(index)),
];

function Harness() {
  const allOverlays = useEditorStore((state) => state.model.overlays);
  const pageOverlays = useMemo(
    () => allOverlays.filter((overlay) => overlay.pageId === page.id),
    [allOverlays],
  );
  return <OverlayLayer page={page} scale={1} overlays={pageOverlays} />;
}

function reactDomProps(element: Element): object {
  const key = Object.getOwnPropertyNames(element).find((name) =>
    name.startsWith("__reactProps$"),
  );
  if (!key) throw new Error("React DOM props marker not found");
  return (element as unknown as Record<string, object>)[key]!;
}

function overlayHost(container: HTMLElement, id: string): HTMLElement {
  const root = container.querySelector<HTMLElement>(".shioriOverlayLayer")!;
  const host = Array.from(root.children).find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset.overlayId === id,
  );
  if (!host) throw new Error(`DOM host not found for ${id}`);
  return host;
}

function overlaySvgHost(container: HTMLElement, id: string): SVGGElement {
  const host = Array.from(
    container.querySelector<SVGSVGElement>(".shioriOverlayLayer > svg")!
      .children,
  ).find((child) => child.getAttribute("data-overlay-id") === id);
  if (!host) throw new Error(`SVG host not found for ${id}`);
  return host as SVGGElement;
}

function fireMoveFrames(root: HTMLElement, pointerType = "mouse") {
  for (let index = 1; index <= 24; index += 1) {
    fireEvent.pointerMove(root, {
      pointerId: 1,
      pointerType,
      clientX: 30 + index * 2,
      clientY: 100 + index,
    });
  }
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
  // happy-dom has no hit testing; the select tool probes for pdf links under
  // the pointer before deciding what a background drag means.
  if (typeof document.elementsFromPoint !== "function") {
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [],
    });
  }
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useEditorStore.setState(initialStore, true);
});

test("an existing-overlay move keeps every DOM annotation out of React", () => {
  useEditorStore.setState({
    model: { pages: [page], overlays },
    tool: "select",
    selectedIds: [overlays[0]!.id],
    activePageId: page.id,
    undoStack: [],
    redoStack: [],
  });
  const view = render(<Harness />);
  const root = view.container.querySelector<HTMLElement>(".shioriOverlayLayer")!;
  const target = overlayHost(view.container, "rect-0");
  fireEvent.pointerDown(target, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 30,
    clientY: 100,
  });
  const domRows = Array.from(root.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset.role === "interactive",
  );
  const movedRow = domRows[0]!;
  const untouchedRow = domRows[1]!;
  const movedPropsBefore = reactDomProps(movedRow);
  const untouchedPropsBefore = reactDomProps(untouchedRow);
  fireMoveFrames(root);
  expect(reactDomProps(movedRow)).toBe(movedPropsBefore);
  expect(reactDomProps(untouchedRow)).toBe(untouchedPropsBefore);
  expect(movedRow.style.translate).toBe("48px 24px");
  fireEvent.pointerUp(root, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 78,
    clientY: 124,
  });
  expect(useEditorStore.getState().model.overlays[0]!.id).toBe("rect-0");
  expect(useEditorStore.getState().undoStack).toHaveLength(1);
});

test("a 24-frame multi-select move writes the store only once on pointerup", () => {
  useEditorStore.setState({
    model: { pages: [page], overlays },
    tool: "select",
    selectedIds: ["rect-0", "rect-1"],
    activePageId: page.id,
    undoStack: [],
    redoStack: [],
  });
  const view = render(<Harness />);
  const root = view.container.querySelector<HTMLElement>(".shioriOverlayLayer")!;
  const firstHost = overlayHost(view.container, "rect-0");
  const secondHost = overlayHost(view.container, "rect-1");
  const firstSvg = overlaySvgHost(view.container, "rect-0");
  const modelBeforeMove = useEditorStore.getState().model;

  fireEvent.pointerDown(firstHost, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 30,
    clientY: 100,
  });
  let storeWrites = 0;
  const unsubscribe = useEditorStore.subscribe(() => {
    storeWrites += 1;
  });
  fireMoveFrames(root);

  expect(storeWrites).toBe(0);
  expect(useEditorStore.getState().model).toBe(modelBeforeMove);
  expect(firstHost.style.translate).toBe("48px 24px");
  expect(secondHost.style.translate).toBe("48px 24px");
  expect(firstSvg.getAttribute("transform")).toBe("translate(48 24)");

  fireEvent.pointerUp(root, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 78,
    clientY: 124,
  });
  unsubscribe();

  expect(storeWrites).toBe(1);
  expect(useEditorStore.getState().undoStack).toHaveLength(1);
  const [first, second] = useEditorStore.getState().model.overlays as RectOverlay[];
  expect(first!.rect).toEqual({ x: 68, y: 626, w: 54, h: 42 });
  expect(second!.rect).toEqual({ x: 133, y: 626, w: 54, h: 42 });
  expect(firstHost.style.translate).toBe("");
  expect(firstSvg.getAttribute("transform")).toBeNull();
});

test("duplicate-on-drag previews copies and commits only the copies", () => {
  const original = rect(0);
  useEditorStore.setState({
    model: { pages: [page], overlays: [original] },
    tool: "select",
    selectedIds: [original.id],
    activePageId: page.id,
    undoStack: [],
    redoStack: [],
  });
  const view = render(<Harness />);
  const root = view.container.querySelector<HTMLElement>(".shioriOverlayLayer")!;
  const originalHost = overlayHost(view.container, original.id);

  fireEvent.pointerDown(originalHost, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 30,
    clientY: 100,
    metaKey: true,
  });
  fireMoveFrames(root);

  expect(useEditorStore.getState().model.overlays).toHaveLength(1);
  expect(originalHost.style.translate).toBeFalsy();
  const preview = root.querySelector<HTMLElement>(
    ':scope > [data-drag-duplicate-preview="true"]',
  );
  expect(preview?.style.translate).toBe("48px 24px");

  fireEvent.pointerUp(root, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 78,
    clientY: 124,
  });

  const state = useEditorStore.getState();
  expect(state.model.overlays).toHaveLength(2);
  expect((state.model.overlays[0] as RectOverlay).rect).toEqual(original.rect);
  const copy = state.model.overlays[1] as RectOverlay;
  expect(copy.id).not.toBe(original.id);
  expect(copy.rect).toEqual({ x: 68, y: 626, w: 54, h: 42 });
  expect(state.selectedIds).toEqual([copy.id]);
  expect(state.undoStack).toHaveLength(1);
  expect(
    root.querySelector('[data-drag-duplicate-preview="true"]'),
  ).toBeNull();
});

test("a touch move below threshold remains a tap-to-edit", () => {
  const editable = note(0);
  useEditorStore.setState({
    model: { pages: [page], overlays: [editable] },
    tool: "select",
    selectedIds: [editable.id],
    activePageId: page.id,
    editingOverlayId: null,
    undoStack: [],
    redoStack: [],
  });
  const view = render(<Harness />);
  const root = view.container.querySelector<HTMLElement>(".shioriOverlayLayer")!;
  const host = overlayHost(view.container, editable.id);

  fireEvent.pointerDown(host, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 30,
    clientY: 100,
  });
  fireEvent.pointerMove(root, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 30.2,
    clientY: 100.2,
  });
  fireEvent.pointerUp(root, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 30.2,
    clientY: 100.2,
  });

  const state = useEditorStore.getState();
  expect(state.model.overlays[0]).toEqual(editable);
  expect(state.undoStack).toHaveLength(0);
  expect(state.editingOverlayId).toBe(editable.id);
});

test("duplicate-dragging a callout carries its target and leader in PDF user space", () => {
  const callout: CalloutOverlay = {
    type: "callout",
    id: "callout-1",
    pageId: page.id,
    targetRects: [{ x: 100, y: 400, w: 120, h: 12 }],
    leader: [
      { x: 220, y: 406 },
      { x: 240, y: 407 },
    ],
    rect: { x: 260, y: 380, w: 144, h: 54 },
    text: "Explain this",
    fontSize: 12,
    color: "#b13a2e",
    bold: false,
    align: "left",
    fontFamily: "sans",
  };
  useEditorStore.setState({
    model: { pages: [page], overlays: [callout] },
    tool: "select",
    selectedIds: [callout.id],
    activePageId: page.id,
    undoStack: [],
    redoStack: [],
  });
  const view = render(<Harness />);
  const root = view.container.querySelector<HTMLElement>(".shioriOverlayLayer")!;
  const host = overlayHost(view.container, callout.id);

  fireEvent.pointerDown(host, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 30,
    clientY: 100,
    metaKey: true,
  });
  fireMoveFrames(root);
  fireEvent.pointerUp(root, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 78,
    clientY: 124,
  });

  const state = useEditorStore.getState();
  expect(state.model.overlays[0]).toEqual(callout);
  const moved = state.model.overlays[1] as CalloutOverlay;
  expect(moved.rect).toEqual({ x: 308, y: 356, w: 144, h: 54 });
  expect(moved.targetRects).toEqual([{ x: 148, y: 376, w: 120, h: 12 }]);
  expect(moved.leader).toEqual([
    { x: 268, y: 382 },
    { x: 288, y: 383 },
  ]);
  expect(state.undoStack).toHaveLength(1);
});

test("a 24-frame resize keeps OverlayLayer and Zustand out of the frame loop", () => {
  useEditorStore.setState({
    model: { pages: [page], overlays },
    tool: "select",
    selectedIds: ["rect-0"],
    activePageId: page.id,
    undoStack: [],
    redoStack: [],
  });
  const view = render(<Harness />);
  const root = view.container.querySelector<HTMLElement>(".shioriOverlayLayer")!;
  const target = overlayHost(view.container, "rect-0");
  const untouched = overlayHost(view.container, "rect-1");
  const targetSvg = overlaySvgHost(view.container, "rect-0");
  const untouchedSvg = overlaySvgHost(view.container, "rect-1");
  const resizeHandles = Array.from(
    target.querySelectorAll<HTMLElement>('[data-role="interactive"]'),
  ).filter((handle) => !handle.getAttribute("aria-label"));
  const resizeHandle = resizeHandles.at(-1)!;
  let storeWrites = 0;
  const unsubscribe = useEditorStore.subscribe(() => {
    storeWrites += 1;
  });
  fireEvent.pointerDown(resizeHandle, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 30,
    clientY: 100,
  });
  let layerRenderCount = 0;
  let overlayRenderCount = 0;
  let overlaySvgRenderCount = 0;
  let layerProps = reactDomProps(root);
  let overlayProps = reactDomProps(target);
  let overlaySvgProps = reactDomProps(targetSvg);
  const untouchedProps = reactDomProps(untouched);
  const untouchedSvgProps = reactDomProps(untouchedSvg);
  for (let index = 1; index <= 24; index += 1) {
    fireEvent.pointerMove(root, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 30 + index * 2,
      clientY: 100 + index,
    });
    const nextLayerProps = reactDomProps(root);
    const nextOverlayProps = reactDomProps(target);
    const nextOverlaySvgProps = reactDomProps(targetSvg);
    if (nextLayerProps !== layerProps) layerRenderCount += 1;
    if (nextOverlayProps !== overlayProps) overlayRenderCount += 1;
    if (nextOverlaySvgProps !== overlaySvgProps) overlaySvgRenderCount += 1;
    layerProps = nextLayerProps;
    overlayProps = nextOverlayProps;
    overlaySvgProps = nextOverlaySvgProps;
  }

  expect(layerRenderCount).toBe(0);
  expect(overlayRenderCount).toBe(0);
  expect(overlaySvgRenderCount).toBe(0);
  expect(target.style.width).toBe("102px");
  expect(target.style.height).toBe("66px");
  expect(resizeHandle.style.left).toBe("102px");
  expect(resizeHandle.style.top).toBe("66px");
  const targetShape = targetSvg.querySelector("rect")!;
  expect(targetShape.getAttribute("width")).toBe("102");
  expect(targetShape.getAttribute("height")).toBe("66");
  expect(reactDomProps(untouched)).toBe(untouchedProps);
  expect(reactDomProps(untouchedSvg)).toBe(untouchedSvgProps);
  expect(storeWrites).toBe(0);
  expect(useEditorStore.getState().undoStack).toHaveLength(0);
  expect((useEditorStore.getState().model.overlays[0] as RectOverlay).rect).toEqual({
    x: 20,
    y: 650,
    w: 54,
    h: 42,
  });

  fireEvent.pointerUp(root, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 78,
    clientY: 124,
  });
  unsubscribe();

  expect(storeWrites).toBe(1);
  expect(useEditorStore.getState().undoStack).toHaveLength(1);
  expect((useEditorStore.getState().model.overlays[0] as RectOverlay).rect).toEqual({
    x: 20,
    y: 626,
    w: 102,
    h: 66,
  });
});

test("a second touch clears an in-flight resize preview without committing it", () => {
  useEditorStore.setState({
    model: { pages: [page], overlays },
    tool: "select",
    selectedIds: ["rect-0"],
    activePageId: page.id,
    undoStack: [],
    redoStack: [],
  });
  const view = render(<Harness />);
  const root = view.container.querySelector<HTMLElement>(".shioriOverlayLayer")!;
  const target = overlayHost(view.container, "rect-0");
  const resizeHandles = Array.from(
    target.querySelectorAll<HTMLElement>('[data-role="interactive"]'),
  ).filter((handle) => !handle.getAttribute("aria-label"));
  const resizeHandle = resizeHandles.at(-1)!;
  let storeWrites = 0;
  const unsubscribe = useEditorStore.subscribe(() => {
    storeWrites += 1;
  });

  fireEvent.pointerDown(resizeHandle, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 30,
    clientY: 100,
  });
  fireEvent.pointerMove(root, {
    pointerId: 1,
    pointerType: "touch",
    clientX: 78,
    clientY: 124,
  });
  expect(target.style.width).toBe("102px");
  expect(storeWrites).toBe(0);

  fireEvent.pointerDown(root, {
    pointerId: 2,
    pointerType: "touch",
    clientX: 120,
    clientY: 140,
  });
  unsubscribe();

  expect(target.style.width).toBe("54px");
  expect(storeWrites).toBe(0);
  expect(useEditorStore.getState().undoStack).toHaveLength(0);
  expect((useEditorStore.getState().model.overlays[0] as RectOverlay).rect).toEqual({
    x: 20,
    y: 650,
    w: 54,
    h: 42,
  });
});

test("a 24-frame rotate keeps OverlayLayer and Zustand out of the frame loop", () => {
  useEditorStore.setState({
    model: { pages: [page], overlays },
    tool: "select",
    selectedIds: ["rect-0"],
    activePageId: page.id,
    undoStack: [],
    redoStack: [],
  });
  const view = render(<Harness />);
  const root = view.container.querySelector<HTMLElement>(".shioriOverlayLayer")!;
  const target = overlayHost(view.container, "rect-0");
  const untouched = overlayHost(view.container, "rect-1");
  const targetSvg = overlaySvgHost(view.container, "rect-0");
  const untouchedSvg = overlaySvgHost(view.container, "rect-1");
  const rotateHandle = target.querySelector<HTMLElement>('[aria-label="Rotate"]')!;
  let storeWrites = 0;
  const unsubscribe = useEditorStore.subscribe(() => {
    storeWrites += 1;
  });
  fireEvent.pointerDown(rotateHandle, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 30,
    clientY: 100,
  });
  let layerRenderCount = 0;
  let overlayRenderCount = 0;
  let overlaySvgRenderCount = 0;
  let layerProps = reactDomProps(root);
  let overlayProps = reactDomProps(target);
  let overlaySvgProps = reactDomProps(targetSvg);
  const untouchedProps = reactDomProps(untouched);
  const untouchedSvgProps = reactDomProps(untouchedSvg);
  for (let index = 1; index <= 24; index += 1) {
    fireEvent.pointerMove(root, {
      pointerId: 1,
      pointerType: "mouse",
      shiftKey: true,
      clientX: 30 + index * 2,
      clientY: 100 + index,
    });
    const nextLayerProps = reactDomProps(root);
    const nextOverlayProps = reactDomProps(target);
    const nextOverlaySvgProps = reactDomProps(targetSvg);
    if (nextLayerProps !== layerProps) layerRenderCount += 1;
    if (nextOverlayProps !== overlayProps) overlayRenderCount += 1;
    if (nextOverlaySvgProps !== overlaySvgProps) overlaySvgRenderCount += 1;
    layerProps = nextLayerProps;
    overlayProps = nextOverlayProps;
    overlaySvgProps = nextOverlaySvgProps;
  }

  expect(layerRenderCount).toBe(0);
  expect(overlayRenderCount).toBe(0);
  expect(overlaySvgRenderCount).toBe(0);
  expect(target.style.transform).toBe("rotate(345deg)");
  expect(targetSvg.querySelector("rect")!.getAttribute("transform")).toContain(
    "rotate(345 ",
  );
  expect(reactDomProps(untouched)).toBe(untouchedProps);
  expect(reactDomProps(untouchedSvg)).toBe(untouchedSvgProps);
  expect(storeWrites).toBe(0);
  expect(useEditorStore.getState().undoStack).toHaveLength(0);
  expect((useEditorStore.getState().model.overlays[0] as RectOverlay).angle).toBeUndefined();

  fireEvent.pointerUp(root, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 78,
    clientY: 124,
  });
  unsubscribe();

  expect(storeWrites).toBe(1);
  expect(useEditorStore.getState().undoStack).toHaveLength(1);
  expect((useEditorStore.getState().model.overlays[0] as RectOverlay).angle).toBe(345);
});

// Creation gestures — drawing ink, sweeping a marquee, pulling out a new box —
// used to call setDrag on every sampled point, so the whole layer (and every
// annotation on it) re-rendered per frame. The preview now publishes through
// its own channel and is the only thing that repaints.
test("drawing ink keeps OverlayLayer and Zustand out of the frame loop", () => {
  useEditorStore.setState({
    model: { pages: [page], overlays },
    tool: "ink",
    selectedIds: [],
    activePageId: page.id,
    undoStack: [],
    redoStack: [],
  });
  const view = render(<Harness />);
  const root = view.container.querySelector<HTMLElement>(".shioriOverlayLayer")!;
  const overlaysBefore = useEditorStore.getState().model.overlays;

  fireEvent.pointerDown(root, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 30,
    clientY: 100,
  });

  let storeWrites = 0;
  const unsubscribe = useEditorStore.subscribe(() => {
    storeWrites += 1;
  });
  // A re-render of the layer replaces the props object React holds on its
  // root node, so a change in identity is one render.
  let layerRenders = 0;
  let layerProps = reactDomProps(root);
  for (let index = 1; index <= 24; index += 1) {
    fireEvent.pointerMove(root, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 30 + index * 2,
      clientY: 100 + index,
    });
    const next = reactDomProps(root);
    if (next !== layerProps) {
      layerRenders += 1;
      layerProps = next;
    }
  }

  expect(layerRenders).toBe(0);
  expect(storeWrites).toBe(0);
  expect(useEditorStore.getState().model.overlays).toBe(overlaysBefore);

  fireEvent.pointerUp(root, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 78,
    clientY: 124,
  });
  unsubscribe();

  // The stroke the user actually drew survived, despite never being in state.
  const committed = useEditorStore.getState().model.overlays;
  expect(committed.length).toBe(overlays.length + 1);
  expect(committed[committed.length - 1]!.type).toBe("ink");
  expect(useEditorStore.getState().undoStack).toHaveLength(1);
});

// Rotation is free by default and Shift constrains it — the way every tool a
// user arrives with behaves. It used to be inverted, which read as the
// rotation being broken rather than as a feature.
test("rotation is continuous by default and snaps only with Shift", () => {
  const rotated = (shiftKey: boolean) => {
    useEditorStore.setState({
      model: { pages: [page], overlays },
      tool: "select",
      selectedIds: ["rect-0"],
      activePageId: page.id,
      undoStack: [],
      redoStack: [],
    });
    const view = render(<Harness />);
    const root = view.container.querySelector<HTMLElement>(".shioriOverlayLayer")!;
    const target = overlayHost(view.container, "rect-0");
    const rotateHandle = Array.from(
      target.querySelectorAll<HTMLElement>('[data-role="interactive"]'),
    ).find((node) => node.getAttribute("aria-label"))!;
    fireEvent.pointerDown(rotateHandle, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 200,
      clientY: 100,
    });
    fireEvent.pointerMove(root, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 213,
      clientY: 152,
      shiftKey,
    });
    fireEvent.pointerUp(root, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 213,
      clientY: 152,
      shiftKey,
    });
    const committed = useEditorStore
      .getState()
      .model.overlays.find((o) => o.id === "rect-0")!;
    const angle = (committed as { angle?: number }).angle ?? 0;
    cleanup();
    return angle;
  };

  const snapped = rotated(true);
  expect(snapped % 15).toBe(0);

  // Free rotation must be able to land somewhere a 15° grid cannot.
  const free = rotated(false);
  expect(free % 15).not.toBe(0);
});

test("a finger drag on the page background leaves scrolling to the browser", () => {
  useEditorStore.setState({
    model: { pages: [page], overlays: [] },
    tool: "select",
    selectedIds: [],
    activePageId: page.id,
    undoStack: [],
    redoStack: [],
  });
  const scroller = document.createElement("div");
  scroller.scrollTop = 400;
  const view = render(
    <ScrollerContext.Provider value={{ current: scroller }}>
      <Harness />
    </ScrollerContext.Provider>,
  );
  const root = view.container.querySelector<HTMLElement>(".shioriOverlayLayer")!;

  // A mouse has no native pan: the drag scrolls the column itself.
  fireEvent.pointerDown(root, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: 100,
    clientY: 300,
  });
  fireEvent.pointerMove(root, {
    pointerId: 1,
    pointerType: "mouse",
    clientX: 100,
    clientY: 250,
  });
  expect(scroller.scrollTop).toBe(450);
  fireEvent.pointerUp(root, { pointerId: 1, pointerType: "mouse" });

  // A finger already scrolls the column natively (touch-action pan-x pan-y)
  // with momentum. Scrolling it from here as well fought the compositor: a
  // jump at the start of every flick until pointercancel took the finger
  // away, and no fling.
  scroller.scrollTop = 400;
  fireEvent.pointerDown(root, {
    pointerId: 2,
    pointerType: "touch",
    button: 0,
    clientX: 100,
    clientY: 300,
  });
  fireEvent.pointerMove(root, {
    pointerId: 2,
    pointerType: "touch",
    clientX: 100,
    clientY: 250,
  });
  expect(scroller.scrollTop).toBe(400);
  fireEvent.pointerCancel(root, { pointerId: 2, pointerType: "touch" });
});
