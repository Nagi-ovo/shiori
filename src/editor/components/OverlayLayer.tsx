import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { nanoid } from "nanoid";
import {
  isBlankPage,
  type CalloutOverlay,
  type ContentTextOverlay,
  type NoteOverlay,
  type Overlay,
  type PageModel,
  type PdfRect,
  type TextOverlay,
} from "../../pdf/model/types";
import { pdfToDisplay, rotatedSize } from "../../pdf/geometry/coords";
import {
  useAppStore,
  useEditorStore,
  useEditorStoreApi,
} from "../store/store";
import { useNow } from "../hooks/useNow";
import {
  adjustRect,
  boundsOf,
  cloneOverlay,
  cloneOverlayWithId,
  resizeOverlayGeometry,
  rotateDelta,
  rotateVec,
  translateCalloutWithTarget,
  translateOverlay,
  type ResizeCorner,
} from "../overlays/geometry";
import type { DragState } from "../overlays/dragState";
import { noteTimestamps } from "../overlays/noteMetadata";
import { constrainInkPoint } from "../overlays/ink";
import { applyHighlightGesture } from "../highlights/merge";
import {
  armEditDragBlurSuppression,
  consumeEditDragBlurSuppression,
  type EditDragBlurSuppression,
} from "./editDragBlurSuppression";
import { finishCreationDrag, isCreationDrag } from "./overlays/overlayCreation";
import { overlayHitsMarquee } from "./overlays/overlayHitTesting";
import {
  CALLOUT_PAGE_MARGIN_PT,
  collapsedCalloutRect,
  collapsedCalloutSizePx,
} from "../../pdf/model/callout";
import {
  isEditableKeyboardTarget,
  isSelectablePdfTextAtPoint,
  localPointFromPointer,
  pdfLinkAtPoint,
  releaseCapturedPointers,
} from "./overlays/overlayPointer";
import { OverlayDom } from "./overlays/OverlayDom";
import { DragPreviewLayer } from "./overlays/DragPreviewLayer";
import {
  isEditableTextOverlay,
  isTextMarkupOverlay,
  isTextMarkupTool,
  type ResizableOverlay,
} from "./overlays/overlayGuards";
import { OverlaySvg } from "./overlays/overlaySvg";
import { setTransientDragPreview } from "./overlays/transientDragPreview";
import {
  clearTransientOverlayGeometry,
  getTransientOverlayGeometry,
  setTransientOverlayGeometry,
} from "./overlays/transientOverlayGeometry";
import { useScroller } from "./ScrollerContext";

// Shift-constrained rotation step, shared with the inspector's angle field
// so the two never disagree about what one notch of rotation is.
export const ROTATE_SNAP_DEG = 15;

type Props = {
  page: PageModel;
  scale: number;
  overlays: Overlay[];
};

type MovePresentation = {
  domNodes: HTMLElement[];
  svgNodes: SVGGElement[];
  previewNodes: Element[];
  duplicateOverlays?: Overlay[];
  dxPx: number;
  dyPx: number;
};

type RectOverlay = Extract<Overlay, { type: "rect" }>;

type RectGeometryPresentation = {
  id: string;
  overlay: RectOverlay;
  domNode: HTMLElement;
  svgRect: SVGRectElement;
  styleSnapshots: Array<{ node: HTMLElement; cssText: string }>;
  svgAttributes: Record<
    "x" | "y" | "width" | "height" | "transform",
    string | null
  >;
  previewRect: PdfRect | null;
  previewAngle: number | null;
};

function findOverlayPresentationNodes(
  root: HTMLDivElement,
  overlayIds: readonly string[],
): Pick<MovePresentation, "domNodes" | "svgNodes"> {
  const ids = new Set(overlayIds);
  const domNodes = Array.from(root.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.dataset.role === "interactive" &&
      ids.has(child.dataset.overlayId ?? ""),
  );
  const svgRoot = Array.from(root.children).find(
    (child) => child.tagName.toLowerCase() === "svg",
  );
  const svgNodes = svgRoot
    ? Array.from(svgRoot.children).filter(
        (child): child is SVGGElement =>
          child.tagName.toLowerCase() === "g" &&
          child.getAttribute("role") === "img" &&
          ids.has(child.getAttribute("data-overlay-id") ?? ""),
      )
    : [];
  return { domNodes, svgNodes };
}

function cloneOverlayPresentationNodes(
  nodes: Pick<MovePresentation, "domNodes" | "svgNodes">,
  duplicateIds: ReadonlyMap<string, string>,
): Pick<MovePresentation, "domNodes" | "svgNodes" | "previewNodes"> {
  const domNodes: HTMLElement[] = [];
  const svgNodes: SVGGElement[] = [];
  const previewNodes: Element[] = [];
  for (const source of nodes.domNodes) {
    const duplicateId = duplicateIds.get(source.dataset.overlayId ?? "");
    if (!duplicateId || !source.parentElement) continue;
    const preview = source.cloneNode(true) as HTMLElement;
    preview.dataset.overlayId = duplicateId;
    preview.dataset.dragDuplicatePreview = "true";
    preview.setAttribute("aria-hidden", "true");
    preview.style.pointerEvents = "none";
    source.parentElement.appendChild(preview);
    domNodes.push(preview);
    previewNodes.push(preview);
  }
  for (const source of nodes.svgNodes) {
    const duplicateId = duplicateIds.get(
      source.getAttribute("data-overlay-id") ?? "",
    );
    if (!duplicateId || !source.parentElement) continue;
    const preview = source.cloneNode(true) as SVGGElement;
    preview.setAttribute("data-overlay-id", duplicateId);
    preview.setAttribute("data-drag-duplicate-preview", "true");
    preview.setAttribute("aria-hidden", "true");
    preview.style.pointerEvents = "none";
    source.parentElement.appendChild(preview);
    svgNodes.push(preview);
    previewNodes.push(preview);
  }
  return { domNodes, svgNodes, previewNodes };
}

function applyMovePresentation(
  presentation: MovePresentation,
  dxPx: number,
  dyPx: number,
) {
  presentation.dxPx = dxPx;
  presentation.dyPx = dyPx;
  const translate = `${dxPx}px ${dyPx}px`;
  for (const node of presentation.domNodes) {
    // Standalone translate composes with the host's existing rotate transform.
    node.style.translate = translate;
  }
  for (const node of presentation.svgNodes) {
    // Geometry transforms live below this accessibility wrapper, so its own
    // transform slot is free for the transient display-space drag offset.
    node.setAttribute("transform", `translate(${dxPx} ${dyPx})`);
  }
}

function clearMovePresentation(presentation: MovePresentation | null) {
  if (!presentation) return;
  for (const node of presentation.domNodes) node.style.translate = "";
  for (const node of presentation.svgNodes) node.removeAttribute("transform");
  for (const node of presentation.previewNodes) node.remove();
}

function captureRectGeometryPresentation(
  root: HTMLDivElement,
  overlay: RectOverlay,
): RectGeometryPresentation | null {
  const nodes = findOverlayPresentationNodes(root, [overlay.id]);
  const domNode = nodes.domNodes[0];
  const svgGroup = nodes.svgNodes[0];
  const svgRect = svgGroup
    ? Array.from(svgGroup.children).find(
        (child): child is SVGRectElement =>
          child.tagName.toLowerCase() === "rect",
      )
    : undefined;
  if (!domNode || !svgRect) return null;
  const styledDescendants = domNode.querySelectorAll<HTMLElement>(
    "[data-resize-corner], [data-rotate-handle], [data-overlay-rotate-connector]",
  );
  return {
    id: overlay.id,
    overlay,
    domNode,
    svgRect,
    styleSnapshots: [domNode, ...styledDescendants].map((node) => ({
      node,
      cssText: node.style.cssText,
    })),
    svgAttributes: {
      x: svgRect.getAttribute("x"),
      y: svgRect.getAttribute("y"),
      width: svgRect.getAttribute("width"),
      height: svgRect.getAttribute("height"),
      transform: svgRect.getAttribute("transform"),
    },
    previewRect: null,
    previewAngle: null,
  };
}

function setHandleCenter(node: HTMLElement, x: number, y: number) {
  const hitWidth = Number.parseFloat(node.style.width);
  const hitHeight = Number.parseFloat(node.style.height);
  node.style.left = `${Number.isFinite(hitWidth) ? x - hitWidth / 2 : x}px`;
  node.style.top = `${Number.isFinite(hitHeight) ? y - hitHeight / 2 : y}px`;
}

function setHandleHorizontalCenter(node: HTMLElement, x: number) {
  const hitWidth = Number.parseFloat(node.style.width);
  node.style.left = `${Number.isFinite(hitWidth) ? x - hitWidth / 2 : x}px`;
}

function applyRectGeometryPresentation(
  presentation: RectGeometryPresentation,
  rect: PdfRect,
  angle: number,
  page: PageModel,
  scale: number,
) {
  const totalDeg = page.rotation + angle;
  const center = pdfToDisplay(
    { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const width = rect.w * scale;
  const height = rect.h * scale;
  const left = center.x - width / 2;
  const top = center.y - height / 2;

  Object.assign(presentation.domNode.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    transform: `rotate(${totalDeg}deg)`,
  });
  for (const handle of presentation.domNode.querySelectorAll<HTMLElement>(
    "[data-resize-corner]",
  )) {
    const corner = handle.dataset.resizeCorner;
    if (!corner) continue;
    setHandleCenter(
      handle,
      corner.endsWith("e") ? width : 0,
      corner.startsWith("s") ? height : 0,
    );
  }
  const rotateHandle = presentation.domNode.querySelector<HTMLElement>(
    '[data-rotate-handle="true"]',
  );
  if (rotateHandle) setHandleHorizontalCenter(rotateHandle, width / 2);
  const rotateConnector = presentation.domNode.querySelector<HTMLElement>(
    '[data-overlay-rotate-connector="true"]',
  );
  if (rotateConnector) rotateConnector.style.left = `${width / 2 - 0.5}px`;

  presentation.svgRect.setAttribute("x", String(left));
  presentation.svgRect.setAttribute("y", String(top));
  presentation.svgRect.setAttribute("width", String(width));
  presentation.svgRect.setAttribute("height", String(height));
  presentation.svgRect.setAttribute(
    "transform",
    `rotate(${totalDeg} ${center.x} ${center.y})`,
  );
  presentation.previewRect = rect;
  presentation.previewAngle = angle;
}

function clearRectGeometryPresentation(
  presentation: RectGeometryPresentation | null,
) {
  if (!presentation) return;
  for (const snapshot of presentation.styleSnapshots) {
    snapshot.node.style.cssText = snapshot.cssText;
  }
  for (const [name, value] of Object.entries(presentation.svgAttributes)) {
    if (value === null) presentation.svgRect.removeAttribute(name);
    else presentation.svgRect.setAttribute(name, value);
  }
}

function resizeStartRect(overlay: ResizableOverlay): PdfRect {
  return overlay.type === "ink"
    ? boundsOf(overlay.paths.flat())
    : { ...overlay.rect };
}

// React 19 does not yet expose a general-purpose useEvent hook. Keep the prop
// identity stable for memoized annotation rows while still dispatching into
// the latest render's state and closures. Layout timing publishes the new
// handler before the browser can deliver another pointer event.
function useStableEvent<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  return useCallback((...args: Args) => handlerRef.current(...args), []);
}

function OverlayLayerImpl({ page, scale, overlays }: Props) {
  const editorStore = useEditorStoreApi();
  const tool = useEditorStore((s) => s.tool);
  const addOverlay = useEditorStore((s) => s.addOverlay);
  const updateOverlay = useEditorStore((s) => s.updateOverlay);
  const updateOverlayNoHistory = useEditorStore((s) => s.updateOverlayNoHistory);
  const beginHistoryStep = useEditorStore((s) => s.beginHistoryStep);
  const commit = useEditorStore((s) => s.commit);
  const removeOverlay = useEditorStore((s) => s.removeOverlay);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const liveOverlayReveals = useEditorStore((s) => s.liveOverlayReveals);
  const pendingOverlayReveals = useEditorStore((s) => s.pendingOverlayReveals);
  const activatePendingOverlayReveals = useEditorStore(
    (s) => s.activatePendingOverlayReveals,
  );
  const selectOnly = useEditorStore((s) => s.selectOnly);
  const toggleSelected = useEditorStore((s) => s.toggleSelected);
  const setSelected = useEditorStore((s) => s.setSelected);
  const editingId = useEditorStore((s) => s.editingOverlayId);
  const setEditingId = useEditorStore((s) => s.setEditingOverlayId);
  const setActivePage = useEditorStore((s) => s.setActivePage);
  const activePageId = useEditorStore((s) => s.activePageId);
  const textDefaults = useEditorStore((s) => s.textDefaults);
  const annotDefaults = useAppStore((s) => s.annotDefaults);
  const activeSignature = useAppStore((s) => s.activeSignature);
  const now = useNow(60_000);
  // Mirror the Canvas scroller element into a local ref. The element
  // identity is stable across renders (Virtuoso creates it once), so the
  // pan gesture reads the live element from this ref and writes its
  // scroll offsets at gesture time. Going through a local ref (rather
  // than mutating the useContext() value directly) keeps the react-hooks
  // immutability rule happy; mirroring in an effect (not during render)
  // satisfies the refs rule.
  const scroller = useScroller();
  const scrollerRef = useRef<HTMLElement | null>(null);

  const size = rotatedSize(page.widthPt, page.heightPt, page.rotation);
  const displayW = size.width * scale;
  const displayH = size.height * scale;
  const textToolUsesPdfTextLayer = tool === "text" && !isBlankPage(page);

  // Virtuoso only mounts nearby pages. Consume reveal intents in a layout
  // effect so the matching absolute timeline starts immediately before the
  // first paint, never while the page is still offscreen. The store removes
  // each id atomically, so remounting a visited page does not replay it.
  useLayoutEffect(() => {
    const pendingIds = overlays
      .filter((overlay) => pendingOverlayReveals.has(overlay.id))
      .map((overlay) => overlay.id);
    if (pendingIds.length > 0) {
      activatePendingOverlayReveals(pendingIds);
    }
  }, [activatePendingOverlayReveals, overlays, pendingOverlayReveals]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDragState] = useState<DragState>({ kind: "none" });
  // The authoritative in-flight drag. `drag` state is only refreshed when the
  // gesture *kind* changes (start, transition, end); the per-frame geometry
  // never goes through setState, so anything reading it during a gesture —
  // finalizeDrag above all — must read this ref, not the state.
  const liveDragRef = useRef<DragState>({ kind: "none" });
  // Accumulated ink points, kept out of state for the same reason: state would
  // rebuild and re-render the whole layer on every sampled point.
  const liveInkPointsRef = useRef<{ x: number; y: number }[]>([]);
  const setDrag = useCallback(
    (next: DragState) => {
      liveDragRef.current = next;
      if (next.kind === "ink") liveInkPointsRef.current = next.points;
      setTransientDragPreview(page.id, next);
      setDragState(next);
    },
    [page.id],
  );
  // Shift toggles the select-tool gesture from pan → marquee, so the cursor
  // must flip from the grab hand to a normal pointer the instant Shift is
  // pressed/released (even with no pointer movement). Track it as state so
  // the cursor-sync effect below re-asserts on every toggle.
  const [shiftHeld, setShiftHeld] = useState(false);
  // For resize/move this means the movement threshold was crossed; rotate is
  // armed on pointerdown. Geometry and its history snapshot are committed
  // atomically on release so pointermove never writes Zustand.
  const gestureSnapshotRef = useRef(false);
  const movePresentationRef = useRef<MovePresentation | null>(null);
  const rectGeometryPresentationRef = useRef<RectGeometryPresentation | null>(
    null,
  );
  const resizeRootOffsetRef = useRef<{ left: number; top: number } | null>(
    null,
  );
  const activeTransientGeometryIdRef = useRef<string | null>(null);
  const pendingPdfLinkRef = useRef<{
    link: HTMLAnchorElement;
    start: { x: number; y: number };
  } | null>(null);
  const hoveredPdfLinkRef = useRef<HTMLAnchorElement | null>(null);
  const textLayerPassthroughRef = useRef(false);
  const textSelectionPointerDownRef = useRef(false);
  const [textLayerPassthrough, setTextLayerPassthrough] = useState(false);
  // Tracks every active touch-pointer landing on this overlay. The
  // moment a second finger arrives, we know the gesture is a pinch
  // (not a marquee/draw) and abort whatever single-finger drag the
  // first pointer started — otherwise the dashed selection rectangle
  // keeps growing under a two-finger zoom and stutters the canvas.
  const activeTouchPointersRef = useRef<Set<number>>(new Set());
  // ID of an overlay whose drag started while it was being edited.
  // In some browsers the textarea blur fires before React commits the
  // queued setDrag(move), so the onCommitEdit closure can still see
  // `drag.kind === "none"` and fail to tell that a drag is in flight.
  // Refs are read at call time, so this lets the commit-time guard skip
  // the auto-delete and finalizeDrag refocus the textarea once the
  // gesture settles.
  const dragInitiatedWhileEditingRef = useRef<string | null>(null);
  // WebKit can deliver the textarea blur well after the pointer gesture
  // has ended and after finalizeDrag has restored focus. The arm is one-
  // shot and time-bounded so a delayed blur is suppressed but later
  // blurs (deliberate click-out, normal commit) fall through.
  //
  // v3 used to clear this on `onInput`, but WebKit can deliver the late
  // blur AFTER the user has typed input — at which point the ref was
  // already cleared and the blur deleted the note. Bounding by time
  // avoids that race; see editDragBlurSuppression.ts.
  const editDragBlurSuppressionRef = useRef<EditDragBlurSuppression | null>(
    null,
  );
  const draftTextHistoryRef = useRef<string | null>(null);

  const clearActiveTransientGeometry = () => {
    const overlayId = activeTransientGeometryIdRef.current;
    if (overlayId) clearTransientOverlayGeometry(overlayId);
    activeTransientGeometryIdRef.current = null;
    clearRectGeometryPresentation(rectGeometryPresentationRef.current);
    rectGeometryPresentationRef.current = null;
    resizeRootOffsetRef.current = null;
  };

  useEffect(
    () => () => {
      const overlayId = activeTransientGeometryIdRef.current;
      if (overlayId) clearTransientOverlayGeometry(overlayId);
      clearRectGeometryPresentation(rectGeometryPresentationRef.current);
    },
    [],
  );

  const clearEditDragBlurSuppression = () => {
    editDragBlurSuppressionRef.current = null;
  };

  const shouldSuppressEditDragBlur = (overlayId: string, now: number) => {
    const result = consumeEditDragBlurSuppression(
      editDragBlurSuppressionRef.current,
      overlayId,
      now,
    );
    editDragBlurSuppressionRef.current = result.next;
    return result.suppress;
  };

  const startDraftTextHistory = (
    overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
  ) => {
    if (draftTextHistoryRef.current === overlay.id) return;
    const isFreshText =
      overlay.type === "text" || overlay.type === "callout"
        ? overlay.text.trim() === ""
        : overlay.text === overlay.originalText;
    if (!(editingId === overlay.id && isFreshText)) {
      beginHistoryStep();
    }
    draftTextHistoryRef.current = overlay.id;
  };

  const updateDraftText = (
    overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
    text: string,
  ) => {
    if (overlay.text === text) return;
    startDraftTextHistory(overlay);
    updateOverlayNoHistory(overlay.id, { text } as never);
  };

  // Callout labels grow and shrink with their text while the user types, so a
  // long remark is never silently clipped by the fixed default box. The top
  // edge stays put (PDF y grows up, so hold y + h), which keeps the card
  // anchored where it was placed instead of creeping upward line by line.
  const applyCalloutAutoHeight = (
    overlay: CalloutOverlay,
    heightPt: number,
  ) => {
    const current = overlay.rect;
    const next = Math.max(24, heightPt);
    if (Math.abs(current.h - next) < 0.5) return;
    const maxY = Math.max(
      CALLOUT_PAGE_MARGIN_PT,
      page.heightPt - CALLOUT_PAGE_MARGIN_PT - next,
    );
    const y = Math.min(
      maxY,
      Math.max(CALLOUT_PAGE_MARGIN_PT, current.y + current.h - next),
    );
    // No beginHistoryStep: the keystroke that changed the text already opened
    // one, and the height belongs to that same edit.
    updateOverlayNoHistory(overlay.id, {
      rect: { ...current, y, h: next },
      leader: undefined,
    } as never);
  };

  const focusOverlayTextarea = (overlayId: string) => {
    window.requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLTextAreaElement>(
          `textarea[data-role="interactive"][data-overlay-id="${overlayId}"]`,
        )
        ?.focus();
    });
  };

  // When the user scrolls to a different page while a text/note overlay on
  // THIS page is being edited, blur the editor so it commits. A focused
  // textarea that has scrolled off-screen otherwise hijacks the next
  // keystroke: pressing Ctrl+Z runs the textarea's native undo and the
  // browser yanks the focused textarea back into view — which looks like
  // "undo jumped the page back to where I was editing". Blurring routes
  // through the normal onBlur commit (text is already persisted live), and
  // Ctrl+Z afterwards is handled by the app, not the textarea.
  useEffect(() => {
    if (!editingId || activePageId === page.id) return;
    if (!overlays.some((o) => o.id === editingId)) return;
    rootRef.current
      ?.querySelector<HTMLTextAreaElement>(
        `textarea[data-role="interactive"][data-overlay-id="${editingId}"]`,
      )
      ?.blur();
  }, [activePageId, editingId, page.id, overlays]);

  // Base cursor when no pdf link is hovered. In select mode the overlay
  // background offers a pan gesture (plain drag), so show grab / grabbing.
  // The text-passthrough case sets pointerEvents:none, so this grab
  // cursor never shows over selectable text.
  const baseCursor = () => {
    if (tool !== "select") return "";
    if (drag.kind === "pan" && drag.moved) return "grabbing";
    // Shift held → marquee select, so show the normal arrow rather than the
    // pan hand.
    if (shiftHeld) return "default";
    return "grab";
  };

  const setHoveredPdfLink = (link: HTMLAnchorElement | null) => {
    const current = hoveredPdfLinkRef.current;
    if (current !== link) {
      current?.classList.remove("is-shiori-hovered");
      link?.classList.add("is-shiori-hovered");
      hoveredPdfLinkRef.current = link;
    }
    if (rootRef.current) {
      // A hovered pdf link wins (pointer); otherwise fall back to the
      // tool's base cursor so the grab affordance survives a hover-out.
      rootRef.current.style.cursor =
        link && tool === "select" ? "pointer" : baseCursor();
    }
  };

  const getLocalXY = (e: React.PointerEvent | PointerEvent) =>
    localPointFromPointer(rootRef.current!, e);

  // Registers a touch and aborts the in-flight gesture once a second finger
  // lands, so a pinch never drags whatever the first finger happened to be on.
  // Returns true when the caller should stop handling this event.
  //
  // Every pointerdown entry point must call this, not just the root one: the
  // overlay, resize-handle and rotate-handle handlers all stopPropagation(),
  // so the root handler never saw their touches and the abort below could not
  // fire. Pinching with a finger on a note therefore moved or resized it —
  // and because a history step had already been pushed, that misplacement was
  // a committed edit which autosaved straight into the draft.
  const registerTouchAndMaybeAbort = (e: React.PointerEvent): boolean => {
    if (e.pointerType !== "touch") return false;
    activeTouchPointersRef.current.add(e.pointerId);
    if (activeTouchPointersRef.current.size <= 1) return false;
    releaseCapturedPointers(rootRef.current, activeTouchPointersRef.current);
    clearMovePresentation(movePresentationRef.current);
    movePresentationRef.current = null;
    clearActiveTransientGeometry();
    setDrag({ kind: "none" });
    gestureSnapshotRef.current = false;
    dragInitiatedWhileEditingRef.current = null;
    clearEditDragBlurSuppression();
    return true;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (editingId && tool !== "text") return;
    if (registerTouchAndMaybeAbort(e)) return;
    setActivePage(page.id);
    const target = e.target as HTMLElement;
    if (target.dataset?.role === "interactive") return;

    const { x, y } = getLocalXY(e);
    const pdfLink =
      tool === "select"
        ? pdfLinkAtPoint(e.clientX, e.clientY, rootRef.current)
        : null;
    if (pdfLink) {
      pendingPdfLinkRef.current = { link: pdfLink, start: { x, y } };
      setHoveredPdfLink(pdfLink);
      return;
    }
    // Any gesture that starts on the blank overlay background kills
    // leftover browser selection and stops the default text-selection
    // behavior the pointerdown would otherwise trigger.
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    if (tool === "select") {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      if (e.shiftKey) {
        // Shift+drag → marquee (rubber-band) selection. If the gesture
        // ends as a tiny click we treat it as an empty-area click; if it
        // extends into a real rect we hit-test against all overlays in
        // finalizeDrag. `additive` is true (Shift held) so the marquee
        // unions into the existing selection.
        setDrag({
          kind: "marquee",
          startX: x,
          startY: y,
          curX: x,
          curY: y,
          additive: e.shiftKey,
        });
      } else {
        // Plain drag → pan the canvas (gives mouse users a pan gesture).
        // Use viewport coords because the page scrolls under the pointer.
        // Even when the scroller can't be resolved we still set the drag
        // so a non-moving click finalizes as an empty-area deselect.
        const sc = scrollerRef.current;
        setDrag({
          kind: "pan",
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          scrollLeft: sc?.scrollLeft ?? 0,
          scrollTop: sc?.scrollTop ?? 0,
          moved: false,
        });
      }
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === "ink") {
      setDrag({ kind: "ink", points: [{ x, y }] });
    } else if (
      tool === "highlight" ||
      tool === "stamp" ||
      tool === "rect" ||
      tool === "signature" ||
      tool === "note" ||
      tool === "text"
    ) {
      if (tool === "signature" && !activeSignature) return;
      setDrag({ kind: tool, startX: x, startY: y, curX: x, curY: y });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    // While a pinch is in flight, ignore single-finger move deltas so
    // they don't keep growing a marquee or drawing an overlay under
    // the zoom gesture.
    if (e.pointerType === "touch" && activeTouchPointersRef.current.size > 1) {
      return;
    }
    // A move/resize/rotate belongs to the pointer that started it. Without
    // this, a second pointer's moves were applied to the first one's gesture,
    // so a stray finger or a pen resting on the screen steered the drag.
    if (
      (drag.kind === "move" ||
        drag.kind === "resize" ||
        drag.kind === "rotate") &&
      drag.pointerId !== undefined &&
      drag.pointerId !== e.pointerId
    ) {
      return;
    }
    const pendingPdfLink = pendingPdfLinkRef.current;
    if (pendingPdfLink) {
      const { x, y } = getLocalXY(e);
      if (
        Math.hypot(x - pendingPdfLink.start.x, y - pendingPdfLink.start.y) > 4
      ) {
        pendingPdfLinkRef.current = null;
        setHoveredPdfLink(null);
      } else {
        setHoveredPdfLink(pendingPdfLink.link);
      }
      return;
    }
    if (tool === "select" && drag.kind === "none") {
      setHoveredPdfLink(pdfLinkAtPoint(e.clientX, e.clientY, rootRef.current));
    } else {
      setHoveredPdfLink(null);
    }
    if (drag.kind === "none") return;
    const localPoint =
      drag.kind === "rotate"
        ? null
        : drag.kind === "resize" && resizeRootOffsetRef.current
          ? {
              x: e.clientX - resizeRootOffsetRef.current.left,
              y: e.clientY - resizeRootOffsetRef.current.top,
            }
          : getLocalXY(e);
    const x = localPoint?.x ?? 0;
    const y = localPoint?.y ?? 0;
    if (drag.kind === "ink") {
      const start = drag.points[0];
      // Creation gestures publish through the transient channel instead of
      // setState: only the preview layer subscribes, so the stroke repaints
      // without re-rendering the annotations, the page or this layer. The ref
      // carries the authoritative geometry to pointerup.
      const next: DragState =
        e.shiftKey && start
          ? { kind: "ink", points: [start, constrainInkPoint(start, { x, y })] }
          : { kind: "ink", points: [...liveInkPointsRef.current, { x, y }] };
      if (next.kind === "ink") liveInkPointsRef.current = next.points;
      liveDragRef.current = next;
      setTransientDragPreview(page.id, next);
    } else if (
      drag.kind === "rect" ||
      drag.kind === "highlight" ||
      drag.kind === "stamp" ||
      drag.kind === "signature" ||
      drag.kind === "note" ||
      drag.kind === "text" ||
      drag.kind === "marquee"
    ) {
      const next = { ...drag, curX: x, curY: y };
      liveDragRef.current = next;
      setTransientDragPreview(page.id, next);
    } else if (drag.kind === "pan") {
      // Pan by scrolling the Virtuoso scroller. Viewport-relative deltas
      // because the page content scrolls under the pointer.
      const sc = scrollerRef.current;
      if (!sc) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) > 3)
        setDrag({ ...drag, moved: true });
      // A finger scrolls natively (touch-action: pan-x pan-y on the
      // scroller), with momentum. Writing scrollTop here as well fought the
      // compositor: a jump at the start of every flick until pointercancel
      // handed the finger over, and no fling. A mouse has no native pan, so
      // it keeps this one.
      if (e.pointerType === "touch") return;
      sc.scrollLeft = drag.scrollLeft - dx;
      sc.scrollTop = drag.scrollTop - dy;
    } else if (drag.kind === "move") {
      const dxPt = (x - drag.origin.x) / scale;
      const dyPt = (y - drag.origin.y) / scale;
      const movedEnough = Math.abs(dxPt) + Math.abs(dyPt) > 0.5;
      if (!gestureSnapshotRef.current) {
        if (!movedEnough) return;
        gestureSnapshotRef.current = true;
        const sourceNodes = findOverlayPresentationNodes(
          rootRef.current!,
          drag.startOverlays.map((overlay) => overlay.id),
        );
        if (drag.duplicateOnDrag) {
          const duplicateOverlays = drag.startOverlays.map((startOverlay) => {
            const copy = cloneOverlayWithId(startOverlay, nanoid());
            if (copy.type === "note") Object.assign(copy, noteTimestamps());
            return copy;
          });
          const duplicateIds = new Map(
            drag.startOverlays.map((startOverlay, index) => [
              startOverlay.id,
              duplicateOverlays[index]!.id,
            ]),
          );
          movePresentationRef.current = {
            ...cloneOverlayPresentationNodes(sourceNodes, duplicateIds),
            duplicateOverlays,
            dxPx: 0,
            dyPx: 0,
          };
        } else {
          movePresentationRef.current = {
            ...sourceNodes,
            previewNodes: [],
            dxPx: 0,
            dyPx: 0,
          };
        }
      }
      const presentation = movePresentationRef.current;
      if (!presentation) return;
      applyMovePresentation(presentation, x - drag.origin.x, y - drag.origin.y);
    } else if (drag.kind === "resize") {
      const dxPt = (x - drag.origin.x) / scale;
      const dyPt = (y - drag.origin.y) / scale;
      if (
        !gestureSnapshotRef.current &&
        Math.abs(dxPt) + Math.abs(dyPt) > 0.5
      ) {
        gestureSnapshotRef.current = true;
      }
      // The grabbed corner lives on the visually-rotated box, so the raw
      // screen delta is expressed in the box's spun frame. Un-spin it by
      // the element's free angle θ first, then run the existing page-
      // rotation pipeline. For θ=0 rotateVec is the identity, so non-
      // rotated and page-rotation-only behaviour is byte-for-byte unchanged.
      const theta =
        "angle" in drag.startOverlay
          ? ((drag.startOverlay as { angle?: number }).angle ?? 0)
          : 0;
      const local = rotateVec(dxPt, dyPt, -theta);
      const dPdf = rotateDelta(local.x, local.y, page.rotation);
      const rect = adjustRect(drag.startRect, drag.corner, dPdf, page.rotation);
      const presentation = rectGeometryPresentationRef.current;
      if (presentation?.id === drag.id) {
        applyRectGeometryPresentation(
          presentation,
          rect,
          drag.startOverlay.type === "rect"
            ? (drag.startOverlay.angle ?? 0)
            : 0,
          page,
          scale,
        );
      } else {
        activeTransientGeometryIdRef.current = drag.id;
        setTransientOverlayGeometry(drag.id, { rect });
      }
    } else if (drag.kind === "rotate") {
      const curDeg =
        (Math.atan2(
          e.clientY - drag.centerClientY,
          e.clientX - drag.centerClientX,
        ) *
          180) /
        Math.PI;
      let next = drag.startAngle + (curDeg - drag.startPointerDeg);
      // Free by default, Shift snaps to 15°. This used to be the other way
      // round, which every other tool a user arrives with — Figma,
      // Illustrator, Keynote, PowerPoint — has backwards: dragging is
      // continuous and the modifier constrains it. Snapping by default read
      // as the rotation being broken rather than as a feature.
      if (e.shiftKey)
        next = Math.round(next / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG;
      // Normalize to [0, 360).
      next = ((next % 360) + 360) % 360;
      const presentation = rectGeometryPresentationRef.current;
      if (presentation?.id === drag.id) {
        applyRectGeometryPresentation(
          presentation,
          presentation.overlay.rect,
          next,
          page,
          scale,
        );
      } else {
        activeTransientGeometryIdRef.current = drag.id;
        setTransientOverlayGeometry(drag.id, { angle: next });
      }
    }
  };

  const finalizeDrag = (now: number) => {
    // The per-frame geometry never reached state, so the ref is the only
    // place holding what the user actually drew.
    const drag = liveDragRef.current;
    if (drag.kind === "none") return;
    // Read from the ref (synchronously set in onOverlayPointerDown) so we
    // know whether this gesture interrupted an editing session, even
    // though the textarea may have already blurred mid-gesture.
    const editingDuringGesture = dragInitiatedWhileEditingRef.current;
    dragInitiatedWhileEditingRef.current = null;
    if (isCreationDrag(drag)) {
      const creation = finishCreationDrag({
        drag,
        page,
        scale,
        annotDefaults,
        textDefaults,
        activeSignature,
        makeId: nanoid,
      });
      if (creation.kind === "highlight") {
        const { model } = editorStore.getState();
        const result = applyHighlightGesture({
          overlays: model.overlays,
          pageId: page.id,
          rects: [creation.rect],
          color: annotDefaults.highlightColor,
          opacity: annotDefaults.highlightOpacity,
          makeId: nanoid,
        });
        if (result.changed) {
          commit({ overlays: result.overlays });
          selectOnly(result.selectedId);
        }
      } else if (creation.kind === "overlay") {
        if (creation.clearEditingFirst) setEditingId(null);
        addOverlay(creation.overlay);
        // A finished pen stroke stays unselected so the next stroke can
        // start immediately (selection boxes between strokes broke the
        // drawing flow). Signature placement still selects: its ink
        // overlay is positioned/resized right after dropping it.
        if (drag.kind !== "ink") selectOnly(creation.overlay.id);
        if (creation.edit) setEditingId(creation.overlay.id);
        if (creation.focus) focusOverlayTextarea(creation.overlay.id);
      }
    } else if (drag.kind === "marquee") {
      const x = Math.min(drag.startX, drag.curX);
      const y = Math.min(drag.startY, drag.curY);
      const w = Math.abs(drag.curX - drag.startX);
      const h = Math.abs(drag.curY - drag.startY);
      if (w < 4 && h < 4) {
        // Treat as an empty-area click. Non-additive clears the
        // selection; additive (Shift-click empty) leaves it alone.
        if (!drag.additive) selectOnly(null);
      } else {
        const marqueeDisplay = { x, y, w, h };
        const hits: string[] = [];
        for (const o of overlays) {
          // Committed collapse state, not the leader's lagged one: what the
          // user can see and click is what the marquee should catch.
          const collapsedRect =
            o.type === "callout" &&
            editorStore.getState().collapsedCalloutIds.includes(o.id)
              ? collapsedCalloutRect(
                  o.rect,
                  collapsedCalloutSizePx(scale),
                  scale,
                )
              : null;
          if (
            overlayHitsMarquee(o, marqueeDisplay, page, scale, collapsedRect)
          ) {
            hits.push(o.id);
          }
        }
        if (drag.additive) {
          // Union with existing selection, preserve existing order
          // (so the primary selection stays primary).
          const unionList = [...selectedIds];
          for (const id of hits) {
            if (!unionList.includes(id)) unionList.push(id);
          }
          setSelected(unionList);
        } else {
          setSelected(hits);
        }
      }
    } else if (drag.kind === "pan") {
      // A pan that never moved is a plain click on empty area → preserve
      // the old empty-click behavior and clear the selection. A pan that
      // moved already scrolled the canvas; nothing to finalize.
      if (!drag.moved) selectOnly(null);
    } else if (drag.kind === "move") {
      const presentation = movePresentationRef.current;
      clearMovePresentation(presentation);
      movePresentationRef.current = null;
      if (gestureSnapshotRef.current && presentation) {
        // Synchronous for the same reason as resize below: clearMovePresentation
        // above has just put the annotation back where it started, so if the
        // commit landed a frame later the user would see it snap home and then
        // jump to the drop point.
        flushSync(() => {
          const dPdf = rotateDelta(
            presentation.dxPx / scale,
            presentation.dyPx / scale,
            page.rotation,
          );
          const committedAt = Date.now();
          const state = editorStore.getState();
          if (presentation.duplicateOverlays) {
            const copies = presentation.duplicateOverlays.map((copy) => {
              const patch =
                copy.type === "callout"
                  ? translateCalloutWithTarget(copy, dPdf.x, dPdf.y)
                  : translateOverlay(copy, dPdf.x, dPdf.y);
              return {
                ...copy,
                ...patch,
                localActivityAt: committedAt,
              } as Overlay;
            });
            const prepared = state.prepareCommit({
              overlays: [...state.model.overlays, ...copies],
            });
            state.commitPrepared(prepared, {
              selectedIds: copies.map((copy) => copy.id),
            });
          } else {
            const startById = new Map(
              drag.startOverlays.map((overlay) => [overlay.id, overlay]),
            );
            const nextOverlays = state.model.overlays.map((overlay) => {
              const startOverlay = startById.get(overlay.id);
              if (!startOverlay) return overlay;
              const patch = translateOverlay(startOverlay, dPdf.x, dPdf.y);
              return {
                ...overlay,
                ...patch,
                localActivityAt: committedAt,
              } as Overlay;
            });
            const prepared = state.prepareCommit({ overlays: nextOverlays });
            state.commitPrepared(prepared);
          }
        });
      }
      // Touch tap on an already-selected text/note that never became a drag
      // (no history snapshot was taken, i.e. movement stayed under the
      // threshold) → enter edit mode. The mouse double-click path is
      // untouched; this only fires for the touch tap-edit candidate armed in
      // onOverlayPointerDown.
      if (drag.tapEditCandidate && !gestureSnapshotRef.current) {
        setEditingId(drag.tapEditCandidate);
      }
    } else if (drag.kind === "resize") {
      const transient = getTransientOverlayGeometry(drag.id);
      const directRect = rectGeometryPresentationRef.current?.previewRect;
      clearActiveTransientGeometry();
      if (gestureSnapshotRef.current && (transient?.rect || directRect)) {
        // Synchronous on purpose. Clearing the preview above restores the box
        // to the geometry it had before the gesture; if the commit landed a
        // frame later, the annotation would visibly snap back to its old size
        // and then jump to the new one. flushSync keeps both inside one block,
        // so the browser never gets a chance to paint the intermediate state.
        flushSync(() => {
          updateOverlay(
            drag.id,
            resizeOverlayGeometry(
              drag.startOverlay,
              transient?.rect ?? directRect!,
            ) as never,
          );
        });
      }
    } else if (drag.kind === "rotate") {
      const transient = getTransientOverlayGeometry(drag.id);
      const directAngle = rectGeometryPresentationRef.current?.previewAngle;
      clearActiveTransientGeometry();
      const angle = transient?.angle ?? directAngle;
      if (gestureSnapshotRef.current && angle !== null && angle !== undefined) {
        // Same reason as resize above: the restore and the commit must paint
        // as one step, or the box spins back before it spins forward.
        flushSync(() => {
          updateOverlay(drag.id, { angle } as never);
        });
      }
    }
    setDrag({ kind: "none" });
    gestureSnapshotRef.current = false;
    if (editingDuringGesture) {
      // The drag captured the pointer and shifted focus off the textarea;
      // we deferred the commit in onCommitEdit. Restore focus so the
      // user can keep typing without their empty in-progress note being
      // auto-deleted.
      //
      // Re-arm the late-blur suppression here, anchored to gesture *end*
      // rather than gesture start — a long drag (>250ms) would otherwise
      // expire the original arm before WebKit's delayed blur arrives,
      // leaving the post-refocus blur to delete the note. The window now
      // covers the focus restoration + any reasonable WebKit blur lag.
      editDragBlurSuppressionRef.current = armEditDragBlurSuppression(
        editingDuringGesture,
        now,
      );
      window.requestAnimationFrame(() => {
        rootRef.current
          ?.querySelector<HTMLTextAreaElement>(
            'textarea[data-role="interactive"]',
          )
          ?.focus();
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      activeTouchPointersRef.current.delete(e.pointerId);
    }
    const pendingPdfLink = pendingPdfLinkRef.current;
    if (pendingPdfLink) {
      pendingPdfLinkRef.current = null;
      const { x, y } = getLocalXY(e);
      if (
        Math.hypot(x - pendingPdfLink.start.x, y - pendingPdfLink.start.y) < 4
      ) {
        e.preventDefault();
        pendingPdfLink.link.click();
      }
      return;
    }
    finalizeDrag(e.timeStamp);
  };

  const onOverlayPointerDown = (e: React.PointerEvent, o: Overlay) => {
    // Clicking an existing overlay always selects and may start a move,
    // regardless of the active tool. Creation flows only fire when the
    // pointer hits the blank overlay-layer background.
    if (registerTouchAndMaybeAbort(e)) {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    if (editingId === o.id && isEditableKeyboardTarget(e.target)) {
      return;
    }
    // preventDefault on pointerdown suppresses the synthesized
    // mousedown/click/dblclick chain. Skip it for overlays that are not
    // being edited so onDoubleClick (the only path back into edit mode
    // for an existing text/note overlay) can still fire. When this
    // overlay IS being edited, we keep preventDefault so the click on
    // the surrounding container doesn't shift focus off the textarea
    // (which would trigger empty-text auto-delete).
    if (editingId === o.id) {
      e.preventDefault();
      // A freshly created note that is still empty has no content the
      // user could lose, but does sit in `editing` mode autoFocused.
      // Letting it drag immediately routes through finalizeDrag's
      // empty-text auto-delete path on the trailing blur, leaving the
      // user with neither a draggable note nor an editable one. Read
      // the *live* textarea value (the store still says "" until the
      // user blurs/commits) and short-circuit drag for the
      // empty/new case — refocus the textarea so typing continues.
      if (o.type === "note" || isEditableTextOverlay(o)) {
        const textarea = rootRef.current?.querySelector<HTMLTextAreaElement>(
          'textarea[data-role="interactive"]',
        );
        if (textarea && textarea.value.trim() === "") {
          textarea.focus();
          return;
        }
      }
      // Mark synchronously so the about-to-fire textarea blur sees the
      // intent — closure-captured `drag` is still "none" until React
      // re-renders after the queued setDrag(move) below.
      dragInitiatedWhileEditingRef.current = o.id;
      editDragBlurSuppressionRef.current = armEditDragBlurSuppression(
        o.id,
        e.timeStamp,
      );
    } else {
      if (editingId) {
        clearEditDragBlurSuppression();
      }
    }
    window.getSelection()?.removeAllRanges();
    setActivePage(page.id);
    if (e.shiftKey) {
      toggleSelected(o.id);
      return;
    }
    const alreadySelected = selectedIds.includes(o.id);
    if (!alreadySelected) selectOnly(o.id);
    if (o.locked) return;
    if (isTextMarkupOverlay(o)) return;
    // contentText edits are pinned to the source text they cover — moving
    // one would drag the cover away from the original glyphs and show both
    // texts at once. They select and edit, never move.
    if (o.type === "contentText") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const { x, y } = getLocalXY(e);
    const duplicateOnDrag = e.metaKey || e.ctrlKey;
    const moving = (
      alreadySelected
        ? overlays.filter((overlay) => selectedIds.includes(overlay.id))
        : [o]
    ).filter((overlay) => overlay.type !== "contentText");
    if (moving.length === 0) return;
    clearMovePresentation(movePresentationRef.current);
    movePresentationRef.current = null;
    gestureSnapshotRef.current = false;
    // Touch tap-to-edit: double-click is the only mouse path back into a
    // text/note editor, but it's unreliable on touch. When a finger taps an
    // already-selected, editable text/note overlay, arm a tap-edit candidate
    // that finalizeDrag promotes to edit mode IF the gesture doesn't turn
    // into a drag. First tap only selects (alreadySelected is false), so a
    // second deliberate tap is required — this avoids edits during a pan and
    // keeps the gesture discoverable (tap to select, tap again to edit).
    const tapEditCandidate =
      e.pointerType === "touch" &&
      alreadySelected &&
      !e.shiftKey &&
      (o.type === "note" || isEditableTextOverlay(o))
        ? o.id
        : undefined;
    setDrag({
      kind: "move",
      pointerId: e.pointerId,
      ids: moving.map((overlay) => overlay.id),
      origin: { x, y },
      startOverlays: moving.map(cloneOverlay),
      duplicateOnDrag,
      tapEditCandidate,
    });
  };

  const onHandlePointerDown = (
    e: React.PointerEvent,
    o: ResizableOverlay,
    corner: ResizeCorner,
  ) => {
    if (registerTouchAndMaybeAbort(e)) {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    if (o.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const { x, y } = getLocalXY(e);
    clearActiveTransientGeometry();
    resizeRootOffsetRef.current = {
      left: e.clientX - x,
      top: e.clientY - y,
    };
    rectGeometryPresentationRef.current =
      o.type === "rect"
        ? captureRectGeometryPresentation(rootRef.current!, o)
        : null;
    setDrag({
      kind: "resize",
      pointerId: e.pointerId,
      id: o.id,
      corner,
      origin: { x, y },
      startRect: resizeStartRect(o),
      startOverlay: cloneOverlay(o),
    });
  };

  const onRotateHandlePointerDown = (
    e: React.PointerEvent,
    o: ResizableOverlay,
  ) => {
    if (registerTouchAndMaybeAbort(e)) {
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    if (o.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // The handle is a child of the rotated box; its parent is the box div.
    // getBoundingClientRect() returns the rotated element's AABB, whose
    // center equals the box center (rotation is center-preserving), which
    // is what we pivot around.
    const boxEl = (e.currentTarget as HTMLElement).parentElement;
    const rect = boxEl?.getBoundingClientRect();
    const centerClientX = rect ? rect.left + rect.width / 2 : e.clientX;
    const centerClientY = rect ? rect.top + rect.height / 2 : e.clientY;
    const startPointerDeg =
      (Math.atan2(e.clientY - centerClientY, e.clientX - centerClientX) * 180) /
      Math.PI;
    // The final angle is committed once on release, producing one history
    // step without writing Zustand during the pointer-tracking loop.
    clearActiveTransientGeometry();
    rectGeometryPresentationRef.current =
      o.type === "rect"
        ? captureRectGeometryPresentation(rootRef.current!, o)
        : null;
    gestureSnapshotRef.current = true;
    setDrag({
      kind: "rotate",
      pointerId: e.pointerId,
      id: o.id,
      centerClientX,
      centerClientY,
      startPointerDeg,
      startAngle: "angle" in o ? (o.angle ?? 0) : 0,
    });
  };

  const onStartOverlayEdit = useStableEvent((overlay: Overlay) => {
    setEditingId(overlay.id);
  });
  const onCommitOverlayEdit = useStableEvent(
    (o: Overlay, patch: Partial<Overlay>) => {
      // A drag gesture started while this overlay was being edited blurred the
      // textarea incidentally; the user still wants to keep editing. Read the
      // ref, because the setDrag(move) render may not have committed yet.
      if (dragInitiatedWhileEditingRef.current === o.id) return;
      const liveEditingId = editorStore.getState().editingOverlayId;
      if (
        isEditableTextOverlay(o) &&
        liveEditingId !== null &&
        liveEditingId !== o.id
      ) {
        if (draftTextHistoryRef.current === o.id) {
          draftTextHistoryRef.current = null;
        }
        return;
      }
      const nextText =
        (patch as { text?: string }).text ??
        (o as TextOverlay | ContentTextOverlay | CalloutOverlay | NoteOverlay)
          .text ??
        "";
      const clearOrRemoveEmptyEdit = () => {
        if (editorStore.getState().editingOverlayId === o.id) {
          setEditingId(null);
        } else {
          removeOverlay(o.id);
        }
        draftTextHistoryRef.current = null;
      };
      if (
        (isEditableTextOverlay(o) || o.type === "note") &&
        nextText.trim() === ""
      ) {
        clearOrRemoveEmptyEdit();
        return;
      }
      if (o.type === "contentText" && nextText === o.originalText) {
        clearOrRemoveEmptyEdit();
        return;
      }
      const nextPatch =
        o.type === "note" &&
        (patch as Partial<NoteOverlay>).text !== undefined &&
        (patch as Partial<NoteOverlay>).text !== o.text
          ? ({ ...patch, updatedAt: Date.now() } as Partial<Overlay>)
          : patch;
      const textOnlyPatch =
        isEditableTextOverlay(o) &&
        Object.keys(nextPatch).length === 1 &&
        (
          nextPatch as Partial<
            TextOverlay | ContentTextOverlay | CalloutOverlay
          >
        ).text !== undefined;
      if (!(
        textOnlyPatch &&
        (nextText === o.text || draftTextHistoryRef.current === o.id)
      )) {
        updateOverlay(o.id, nextPatch as never);
      }
      // Re-select after committing so handles reappear for drag/resize.
      if (editorStore.getState().editingOverlayId === o.id) {
        selectOnly(o.id);
        setEditingId(null);
      }
      draftTextHistoryRef.current = null;
    },
  );
  const onOverlayDomPointerDown = useStableEvent(onOverlayPointerDown);
  const onOverlayDomHandlePointerDown = useStableEvent(onHandlePointerDown);
  const onOverlayDomRotateHandlePointerDown = useStableEvent(
    onRotateHandlePointerDown,
  );
  const onOverlayDraftTextChange = useStableEvent(
    (
      overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
      text: string,
    ) => updateDraftText(overlay, text),
  );
  const onOverlayCalloutAutoHeight = useStableEvent(
    (overlay: CalloutOverlay, heightPt: number) =>
      applyCalloutAutoHeight(overlay, heightPt),
  );
  const onMaybeSuppressOverlayEditDragBlur = useStableEvent(
    shouldSuppressEditDragBlur,
  );

  useEffect(() => {
    scrollerRef.current = scroller;
  }, [scroller]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Text/note editors commit their textarea value in their own Escape
      // handler. Do not let this global fallback win the race and unmount the
      // editor before the field-level commit can read the latest DOM value.
      if (isEditableKeyboardTarget(e.target)) return;
      setEditingId(null);
      draftTextHistoryRef.current = null;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setEditingId]);

  useEffect(() => {
    const isInOverlayLayer = (target: EventTarget | null) =>
      target instanceof Node && rootRef.current?.contains(target);
    const onNativePointerDown = (event: PointerEvent) => {
      if (!isInOverlayLayer(event.target)) {
        editDragBlurSuppressionRef.current = null;
      }
    };
    document.addEventListener("pointerdown", onNativePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onNativePointerDown, true);
    };
  }, []);

  // Track the Shift key globally so the select-tool cursor can flip between
  // pan (grab) and marquee (arrow) the instant Shift is pressed/released,
  // without waiting for a pointer move. baseCursor() only consults shiftHeld
  // in select mode, so tracking it everywhere is harmless. All setState here
  // happens inside event callbacks, never synchronously in the effect body.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setShiftHeld(e.shiftKey);
    const onBlur = () => setShiftHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Keep the imperative cursor in sync with the tool, the pan gesture, and the
  // Shift key. setHoveredPdfLink only runs on pointer move, so without this the
  // grab affordance wouldn't appear on tool switch, grab→grabbing wouldn't flip
  // mid-pan, and grab↔arrow wouldn't flip on Shift. A hovered pdf link still
  // wins (its cursor is "pointer" and pointer moves keep re-asserting it).
  useEffect(() => {
    if (tool !== "select") {
      hoveredPdfLinkRef.current?.classList.remove("is-shiori-hovered");
      hoveredPdfLinkRef.current = null;
    }
    if (rootRef.current && !hoveredPdfLinkRef.current) {
      rootRef.current.style.cursor = baseCursor();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, drag.kind, drag.kind === "pan" ? drag.moved : false, shiftHeld]);

  useEffect(() => {
    const setPassthrough = (next: boolean) => {
      if (textLayerPassthroughRef.current === next) return;
      textLayerPassthroughRef.current = next;
      setTextLayerPassthrough(next);
    };
    if (tool !== "select" || drag.kind !== "none") {
      textSelectionPointerDownRef.current = false;
      setPassthrough(false);
      return;
    }
    const textAtPoint = (event: PointerEvent) =>
      isSelectablePdfTextAtPoint(event.clientX, event.clientY, rootRef.current);
    const onPointerDown = (event: PointerEvent) => {
      textSelectionPointerDownRef.current = textAtPoint(event);
      if (textSelectionPointerDownRef.current) setPassthrough(true);
    };
    const onPointerMove = (event: PointerEvent) => {
      setPassthrough(textSelectionPointerDownRef.current || textAtPoint(event));
    };
    const onPointerUp = (event: PointerEvent) => {
      textSelectionPointerDownRef.current = false;
      setPassthrough(textAtPoint(event));
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
    };
  }, [drag.kind, tool]);

  // `user-select: none` alone is not enough in WebKit / Tauri: a
  // pointerdown that starts on this layer but drags onto pdfjs' text
  // layer (which lives below at z:1) can still engage native range
  // selection and paint the page blue during drawing. Harden with an
  // explicit selectstart guard — only leave it open in text-markup
  // tools, where text selection is exactly the gesture we want. React
  // doesn't ship a typed onSelectStart prop, so wire it through the
  // native DOM event.
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onSelectStart = (e: Event) => {
      if (isEditableKeyboardTarget(e.target)) return;
      if (!isTextMarkupTool(tool) && tool !== "callout") e.preventDefault();
    };
    node.addEventListener("selectstart", onSelectStart);
    return () => node.removeEventListener("selectstart", onSelectStart);
  }, [tool]);

  return (
    <div
      ref={rootRef}
      className="shioriOverlayLayer"
      style={{
        position: "absolute",
        inset: 0,
        width: displayW,
        height: displayH,
        zIndex: 3,
        userSelect: "none",
        WebkitUserSelect: "none",
        pointerEvents:
          isTextMarkupTool(tool) ||
          tool === "callout" ||
          textToolUsesPdfTextLayer ||
          (tool === "select" && textLayerPassthrough)
            ? "none"
            : "auto",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={(e) => {
        pendingPdfLinkRef.current = null;
        setHoveredPdfLink(null);
        onPointerUp(e);
      }}
      onPointerLeave={() => setHoveredPdfLink(null)}
    >
      <svg
        width={displayW}
        height={displayH}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          overflow: "visible",
        }}
      >
        {overlays
          .filter((o) => o.type === "contentText")
          .map((o) => (
            <OverlaySvg
              key={o.id}
              overlay={o}
              page={page}
              scale={scale}
              selected={selectedIds.includes(o.id)}
              liveReveals={liveOverlayReveals}
            />
          ))}
        {overlays
          .filter((o) => o.type !== "contentText")
          .map((o) => (
            <OverlaySvg
              key={o.id}
              overlay={o}
              page={page}
              scale={scale}
              selected={selectedIds.includes(o.id)}
              liveReveals={liveOverlayReveals}
            />
          ))}
        <DragPreviewLayer
          pageId={page.id}
          scale={scale}
          activeSignature={activeSignature}
          defaults={{
            inkColor: annotDefaults.inkColor,
            inkWidth: annotDefaults.inkWidth,
            highlightColor: annotDefaults.highlightColor,
            highlightOpacity: annotDefaults.highlightOpacity,
            rectColor: annotDefaults.rectColor,
            rectStrokeWidth: annotDefaults.rectStrokeWidth,
            rectFill: annotDefaults.rectFill,
            stampKind: annotDefaults.stampKind,
            stampColor: annotDefaults.stampColor,
            stampStrokeWidth: annotDefaults.stampStrokeWidth,
            noteColor: annotDefaults.noteColor,
            textColor: textDefaults.color,
            textFontSize: textDefaults.fontSize,
            textBold: textDefaults.bold,
            textItalic: textDefaults.italic,
            textAlign: textDefaults.align,
            textFontFamily: textDefaults.fontFamily,
          }}
        />
      </svg>
      {overlays.map((o) => (
        <OverlayDom
          key={o.id}
          overlay={o}
          page={page}
          scale={scale}
          selected={selectedIds.includes(o.id)}
          editing={editingId === o.id}
          liveReveals={liveOverlayReveals}
          // Ink joins the text-markup tools in making existing overlays
          // transparent to the pointer: a stroke that starts on top of an
          // earlier stroke must draw, not select-and-drag what's underneath.
          // In the text tool, existing contentText edits go transparent too:
          // a selection sweep must reach the text layer beneath them (the
          // new edit then absorbs the old one) — re-edit directly via the
          // select tool's double-click. The overlay currently being edited
          // stays interactive so its textarea keeps taking clicks.
          interactivePointerEvents={
            isTextMarkupTool(tool) ||
            tool === "callout" ||
            tool === "ink" ||
            (tool === "text" && o.type === "contentText" && editingId !== o.id)
              ? "none"
              : "auto"
          }
          onStartEdit={onStartOverlayEdit}
          onCommitEdit={onCommitOverlayEdit}
          onPointerDown={onOverlayDomPointerDown}
          onHandlePointerDown={onOverlayDomHandlePointerDown}
          onRotateHandlePointerDown={onOverlayDomRotateHandlePointerDown}
          onCalloutAutoHeight={onOverlayCalloutAutoHeight}
          onDraftTextChange={onOverlayDraftTextChange}
          onMaybeSuppressEditDragBlur={onMaybeSuppressOverlayEditDragBlur}
          now={now}
        />
      ))}
    </div>
  );
}

// Memoized: with a stable `overlays` reference per page, this whole layer (and
// its ~18 store selectors) skips re-rendering on the parent's scroll-driven and
// other-page churn. Pages with no overlays get the shared EMPTY_OVERLAYS
// constant from the parent, so they stay skipped even while an overlay on a
// different page is being dragged.
export const OverlayLayer = memo(OverlayLayerImpl);
