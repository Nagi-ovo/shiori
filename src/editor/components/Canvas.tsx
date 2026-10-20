import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import type { PdfDestination, PdfDocument } from "../../pdf/engine/types";
import {
  useAppStore,
  useEditorStore,
  useEditorStoreApi,
} from "../store/store";
import { PageCanvas } from "./PageCanvas";
import { useCanvasKeyboard } from "./useCanvasKeyboard";
import { OverlayLayer } from "./OverlayLayer";
import { ScrollerContext } from "./ScrollerContext";
import { PdfLinkLayer, type PdfLinkTarget } from "./PdfLinkLayer";
import { TextHighlightLayer } from "./TextHighlightLayer";
import type { Overlay, PageModel } from "../../pdf/model/types";
import { isBlankPage } from "../../pdf/model/types";
import { pdfToDisplay, rotatedSize } from "../../pdf/geometry/coords";
import { T } from "../../design/tokens";
import { useIsMobile } from "../hooks/useIsMobile";
import { pdfPaperColor } from "../../design/pdfPaperTone";
import { canvasVirtualizationProps } from "./canvasVirtualization";
import {
  canvasSizingLayout,
  pageMarginMetrics,
  pdfPageScrollTop,
  pdfVisiblePageRange,
  type PageRange,
} from "./pdfPageLayout";
import { setLiveZoomIndicator } from "./liveZoomIndicator";
import { zoomDebugTap } from "./zoomDebugTap";
import { MAX_ZOOM_SCALE, MIN_ZOOM_SCALE } from "../zoomLimits";
import {
  attachTouchPinch,
  containsEventTarget,
} from "./documentViewerGestures";
import { appPdfEngine } from "../../pdf/engine/appEngine";
import { createPageTracker, type PageTracker } from "../viewport/pageTracker";
import { systemClock } from "../viewport/clock";
import {
  createViewportController,
  type ViewportController,
} from "../viewport/viewportController";
import {
  createZoomGestureStream,
  ZOOM_GESTURE_TIMING,
} from "../viewport/zoomGestureStream";

type Props = {
  doc: PdfDocument;
};

const cursorFor: Record<string, string> = {
  select: "default",
  highlight: "text",
  underline: "text",
  strikethrough: "text",
  ink: "crosshair",
  stamp: "crosshair",
  rect: "crosshair",
  note: "cell",
  text: "text",
};

type PdfZoomPreviewLayer = {
  layer: HTMLElement;
  left: number;
  top: number;
  previousLayerPointerEvents: string;
  previousLayerTransform: string;
  previousLayerTransformOrigin: string;
  previousLayerTransition: string;
  previousLayerWillChange: string;
};


// The preview may only touch compositor properties. It must never take the
// layer out of normal flow: a position:fixed layer escapes the scroller's
// overflow clip (fixed boxes resolve against the viewport), so zoomed pages
// painted over the sidebar and the rest of the chrome. Exported for the
// regression test that pins this invariant.
// eslint-disable-next-line react-refresh/only-export-components
export function armPdfZoomPreviewLayer(
  layer: HTMLElement,
): PdfZoomPreviewLayer {
  const rect = layer.getBoundingClientRect();
  const snapshot: PdfZoomPreviewLayer = {
    layer,
    left: rect.left,
    top: rect.top,
    previousLayerPointerEvents: layer.style.pointerEvents,
    previousLayerTransform: layer.style.transform,
    previousLayerTransformOrigin: layer.style.transformOrigin,
    previousLayerTransition: layer.style.transition,
    previousLayerWillChange: layer.style.willChange,
  };
  layer.style.pointerEvents = "none";
  // Any stylesheet transition covering transform would turn every preview
  // frame into a lagging tween — and, worse, turn the restore into an
  // animation, so the commit re-anchoring measured mid-tween rectangles and
  // landed the view hundreds of pixels off. The preview must snap.
  layer.style.transition = "none";
  layer.style.transformOrigin = "0 0";
  layer.style.willChange = "transform";
  return snapshot;
}

// eslint-disable-next-line react-refresh/only-export-components
export function restorePdfZoomPreviewLayer(
  snapshot: PdfZoomPreviewLayer,
): void {
  snapshot.layer.style.pointerEvents = snapshot.previousLayerPointerEvents;
  snapshot.layer.style.transform = snapshot.previousLayerTransform;
  snapshot.layer.style.transformOrigin =
    snapshot.previousLayerTransformOrigin;
  snapshot.layer.style.willChange = snapshot.previousLayerWillChange;
  // Whether a transition starts is decided by the AFTER-change style: if the
  // stylesheet transition came back in the same style recalc as the transform
  // reset, the reset itself would tween, and the commit would measure the
  // tween's starting (still fully transformed) rectangles — on-device this
  // double-scaled the anchor and threw the landing far down-right. Force the
  // recalc while the inline transition is still 'none', then hand back.
  void snapshot.layer.offsetWidth;
  snapshot.layer.style.transition = snapshot.previousLayerTransition;
}

// Stable empty-overlays reference so a memoized OverlayLayer on a page with no
// overlays skips re-rendering even when `overlaysByPage` is rebuilt (e.g. while
// an overlay on a different page is dragged). A fresh `[]` literal would change
// identity every render and defeat the memo.
const EMPTY_OVERLAYS: Overlay[] = [];

export function Canvas({ doc }: Props) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const editorStore = useEditorStoreApi();
  const pages = useEditorStore((s) => s.model.pages);
  const overlays = useEditorStore((s) => s.model.overlays);
  const scale = useEditorStore((s) => s.scale);
  const fitMode = useEditorStore((s) => s.fitMode);
  const pageJump = useEditorStore((s) => s.pageJump);
  const consumePageJump = useEditorStore((s) => s.consumePageJump);
  const outlineSelection = useEditorStore((s) => s.outlineSelection);
  const activePageId = useEditorStore((s) => s.activePageId);
  const setFitMode = useEditorStore((s) => s.setFitMode);
  const tool = useEditorStore((s) => s.tool);
  const pageMargin = useAppStore((s) => s.prefs.pageMargin);
  const pdfPaperTone = useAppStore((s) => s.prefs.pdfPaperTone);
  const pdfPaperCustomColor = useAppStore((s) => s.prefs.pdfPaperCustomColor);
  const displayPaperColor = pdfPaperColor(pdfPaperTone, pdfPaperCustomColor);

  // Vertical padding around each page in the virtual scroller. The horizontal
  // gutter stays 0 because pages are already centred by the parent flex.
  const marginMetrics = pageMarginMetrics(pageMargin);
  const pagePaddingCss = `${marginMetrics.top}px 0 ${marginMetrics.bottom}px`;
  const activePageIndex = Math.max(
    0,
    pages.findIndex((page) => page.id === activePageId),
  );
  const pagesKey = `${pages.length}:${pages[0]?.id ?? ""}:${pages[pages.length - 1]?.id ?? ""}`;
  const docKey = `${appPdfEngine.pageCount(doc)}:${pagesKey}`;
  const overlaysByPage = useMemo(() => {
    const map = new Map<string, typeof overlays>();
    for (const o of overlays) {
      const arr = map.get(o.pageId) ?? [];
      arr.push(o);
      map.set(o.pageId, arr);
    }
    return map;
  }, [overlays]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  // Gesture zooming is not React state (the viewport controller holds the
  // flag). Its one consumer is the
  // `is-gesture-zooming` class on the container (text layer pointer-events
  // off, caret hidden); setting state for it re-rendered every mounted page
  // with all its layers on the first frame of every pinch and wheel zoom —
  // the stutter readers felt at the start of a gesture.
  const setGestureZoomingClass = useCallback((zooming: boolean) => {
    containerRef.current?.classList.toggle("is-gesture-zooming", zooming);
  }, []);
  const [spacePan, setSpacePan] = useState(false);
  const [panning, setPanning] = useState(false);

  // The page column is pure arithmetic on page boxes and scale: every offset
  // is known, nothing is measured, and the same page elements stay mounted
  // across a zoom commit — the commit is a new layout for the same nodes and
  // one scrollTop write, all before paint. (A virtual list that measures its
  // items had to be re-keyed on every scale change, and that remount — a
  // fresh empty list, pages popping in, overlays reappearing — was the flash
  // on every pinch release.)
  const layout = useMemo(
    () => canvasSizingLayout(docKey, pages, scale, pageMargin),
    [docKey, pageMargin, pages, scale],
  );
  const virtualization = canvasVirtualizationProps(isMobile);
  // The mounted page range is state of its own, not derived from a scroll
  // position: a relayout then renders exactly the pages that were mounted —
  // moved, never unmounted — and the range is re-derived from the scroller's
  // real position only once the new layout has landed. Deriving it from a
  // remembered scrollTop against the new layout mounted the wrong pages for
  // one render and remounted the right ones after, which is the blank page
  // this column exists to remove. Scroll events update it only when the
  // range actually changes, so scrolling within the overscan band never
  // re-renders the column.
  const [range, setRange] = useState<PageRange>(() =>
    pdfVisiblePageRange(
      layout,
      pdfPageScrollTop(layout, activePageIndex),
      600,
      virtualization.overscan,
      virtualization.minOverscanItemCount ?? 0,
    ),
  );
  const layoutRef = useRef(layout);
  const rangeRef = useRef(range);
  const virtualizationRef = useRef(virtualization);
  // What the viewport controller's ports read of this render.
  const viewPropsRef = useRef({ docKey, pages, pageMargin, isMobile });
  useLayoutEffect(() => {
    layoutRef.current = layout;
    rangeRef.current = range;
    virtualizationRef.current = virtualization;
    viewPropsRef.current = { docKey, pages, pageMargin, isMobile };
  });
  // Re-derive the mounted range from the scroller's real position. A no-op
  // while the range is unchanged, so scroll handling stays render-free.
  const syncRange = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const scrollTop = scroller.scrollTop;
    const height = scroller.clientHeight;
    const next = pdfVisiblePageRange(
      layoutRef.current,
      scrollTop,
      height,
      virtualizationRef.current.overscan,
      virtualizationRef.current.minOverscanItemCount ?? 0,
    );
    const current = rangeRef.current;
    if (next.start === current.start && next.end === current.end) return;
    rangeRef.current = next;
    setRange(next);
  }, [setRange]);

  // Resize, fit, layout landing and the zoom preview and commit. Created
  // once; its ports read the DOM, the store and this render's props.
  const viewportRef = useRef<ViewportController | null>(null);
  const viewport = useCallback(
    () =>
      (viewportRef.current ??= createViewportController({
        scroller: () => scrollerRef.current,
        pageRects: () =>
          Array.from(
            containerRef.current?.querySelectorAll<HTMLElement>(
              "[data-shiori-page-id]",
            ) ?? [],
          ).map((node) => ({
            id: node.dataset.shioriPageId ?? "",
            rect: node.getBoundingClientRect(),
          })),
        armPreviewLayers: () =>
          Array.from(
            containerRef.current?.querySelectorAll<HTMLElement>(
              ".shioriPdfZoomPreviewLayer",
            ) ?? [],
          ).map((node) => {
            const snapshot = armPdfZoomPreviewLayer(node);
            return {
              left: snapshot.left,
              top: snapshot.top,
              transform: (translateX, translateY, ratio) => {
                node.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${ratio})`;
              },
              restore: () => restorePdfZoomPreviewLayer(snapshot),
            };
          }),
        pages: () => viewPropsRef.current.pages,
        layoutAt: (nextScale) =>
          canvasSizingLayout(
            viewPropsRef.current.docKey,
            viewPropsRef.current.pages,
            nextScale,
            viewPropsRef.current.pageMargin,
          ),
        activePageId: () => editorStore.getState().activePageId,
        scale: () => editorStore.getState().scale,
        fitMode: () => editorStore.getState().fitMode,
        isMobile: () => viewPropsRef.current.isMobile,
        fitScale: (nextScale) => editorStore.getState().setScaleKeepFit(nextScale),
        commitScale: (nextScale, scrollTop) => {
          const nextLayout = canvasSizingLayout(
            viewPropsRef.current.docKey,
            viewPropsRef.current.pages,
            nextScale,
            viewPropsRef.current.pageMargin,
          );
          const viewportHeight = scrollerRef.current?.clientHeight ?? 0;
          flushSync(() => {
            editorStore.getState().setScale(nextScale);
            // The mounted range for this very render must be the target's,
            // not the pre-commit position's, or the anchor page could be
            // unmounted.
            setRange(
              pdfVisiblePageRange(
                nextLayout,
                scrollTop,
                viewportHeight,
                virtualizationRef.current.overscan,
                virtualizationRef.current.minOverscanItemCount ?? 0,
              ),
            );
          });
        },
        syncRange,
        setGestureZooming: setGestureZoomingClass,
        showLiveZoom: setLiveZoomIndicator,
        debug: zoomDebugTap,
      })),
    [editorStore, setGestureZoomingClass, syncRange],
  );

  // Land every new layout before it paints: a zoom commit's anchor-pinned
  // target, a new document's active page, else the viewport centre.
  useLayoutEffect(() => {
    if (viewport().land(layout)) syncRange();
  }, [layout, syncRange, viewport]);

  const setScrollerElement = useCallback((next: HTMLDivElement | null) => {
    scrollerRef.current = next;
  }, []);

  // While a chrome pane (rail / navigator) is being drag-resized, the
  // container size changes on every frame. Feeding each change into React
  // state re-rendered this whole tree and re-derived the fit scale per
  // pixel of drag — the jank. During the drag the controller parks the
  // latest size; the CSS flex layout tracks the pointer for free, and the
  // drag's end applies the parked size once.
  const chromeResizing = useAppStore((s) => s.chromeResizing);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const applied = viewport().resize(
          { width: entry.contentRect.width, height: entry.contentRect.height },
          useAppStore.getState().chromeResizing,
        );
        if (applied) syncRange();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncRange, viewport]);

  useEffect(() => {
    if (chromeResizing) return;
    if (viewport().paneDragEnded()) syncRange();
  }, [chromeResizing, syncRange, viewport]);

  useEffect(() => {
    viewport().refit();
  }, [fitMode, isMobile, pages, viewport]);

  // The live stream leaves every painted item in normal flow and changes
  // only a compositor transform on its inner layer. Transforms never reach
  // layout, so the outer boxes, the virtual size tree, scrollTop, and the
  // native scrollbar remain byte-for-byte still — and the scroller's overflow
  // keeps clipping the preview to the document area (an earlier fixed-layer
  // variant escaped that clip and painted zoomed pages over the sidebar).
  // One real PDF layout is committed when the gesture settles.
  //
  // Each event applies its transform synchronously. An earlier version
  // deferred to requestAnimationFrame to coalesce events — necessary when
  // every application was a real relayout, but a transform write is cheap,
  // and WebKit can pause rAF callbacks for the whole duration of a native
  // trackpad pinch: the deferred preview then sat frozen until the fingers
  // lifted and the entire zoom landed as one end-of-gesture jump.

  useEffect(() => () => viewport().dispose(), [viewport]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    // iOS / iPadOS Safari fires Apple-flavoured `gesturestart/change/end`
    // events with a single composite `event.scale`. Every other touch
    // browser (Android Chrome, desktop Chromium with touch screen,
    // Firefox mobile) only fires Pointer Events, so we have to derive
    // pinch zoom ourselves from two simultaneous touch pointers. Branch
    // here so we never run both paths on Safari and double-apply the
    // zoom delta.
    const supportsAppleGesture =
      typeof window !== "undefined" && "GestureEvent" in window;

    // touch-action on the scroller blocks the browser's own pinch /
    // double-tap zoom (which would re-scale the entire WebView and
    // fight whatever zoom the canvas just applied). pan-x / pan-y
    // keeps single-finger scrolling intact.
    const previousTouchAction = scroller.style.touchAction;
    scroller.style.touchAction = "pan-x pan-y";

    const center = () => {
      const rect = scroller.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    };
    const canvasPoint = (event: Event) => eventClientPoint(event) ?? center();
    const isInsideCanvas = (event: Event) => {
      const container = containerRef.current;
      return container ? eventTargetsElement(event, container) : false;
    };

    // Double-tap zoom, the one gesture every native PDF reader has. touch-
    // action pan-x pan-y already suppresses the browser's own. It toggles
    // between fit-width and twice that, anchored at the tap, through the
    // same preview + commit path as a pinch — the tapped content stays put.
    let doubleTapFrame: number | null = null;
    const animateZoomTo = (
      clientX: number,
      clientY: number,
      from: number,
      to: number,
    ) => {
      const startedAt = performance.now();
      const step = () => {
        doubleTapFrame = null;
        const progress = Math.min(
          1,
          (performance.now() - startedAt) / DOUBLE_TAP_ZOOM_MS,
        );
        const eased = 1 - (1 - progress) * (1 - progress);
        viewport().preview({ x: clientX, y: clientY }, from + (to - from) * eased);
        if (progress < 1) {
          doubleTapFrame = window.requestAnimationFrame(step);
          return;
        }
        viewport().commitPreview();
        // Landing back on the fit scale is a return to fit mode: the page
        // keeps fitting through rotations and rail toggles, as before.
        const fit = viewport().fitWidthScale();
        if (fit !== null && Math.abs(to - fit) < 0.001) setFitMode("width");
      };
      step();
    };

    const stream = createZoomGestureStream(
      {
        preview: (point, scale) => viewport().preview(point, scale),
        commit: () => viewport().commitPreview(),
        cancel: () => viewport().cancelPreview(),
        // Base for composing relative wheel steps: each event applies
        // synchronously, so the visual scale is always the latest target.
        visualScale: () => viewport().visualScale(),
        // A bracket's or a pinch's ratios multiply the committed scale, not
        // a wheel preview still in flight.
        openGesture: () => editorStore.getState().scale,
        restingScale: () => editorStore.getState().scale,
        isBusy: () => viewport().isPreviewing() || doubleTapFrame !== null,
        doubleTap: (point) => {
          const current = editorStore.getState().scale;
          const fit = viewport().fitWidthScale();
          const target =
            fit !== null && current > fit * 1.05
              ? fit
              : clamp(current * 2, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE);
          if (Math.abs(target - current) < 0.001) return;
          animateZoomTo(point.x, point.y, current, target);
        },
        clock: systemClock,
      },
      {
        pinchWatchdogMs: ZOOM_GESTURE_TIMING.pinchWatchdogMs,
        doubleTap: !supportsAppleGesture,
      },
    );

    const onWheel = (event: WheelEvent) => {
      const inside = isInsideCanvas(event);
      if (import.meta.env.DEV) {
        zoomDebugTap("wheel", {
          ctrl: event.ctrlKey,
          dx: Math.round(event.deltaX),
          dy: Math.round(event.deltaY),
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
          inside,
        });
      }
      if (!event.ctrlKey) return;
      // Physical mouse wheels emit deltaY ≈ ±100 per notch; trackpads emit
      // tiny deltas. Clamping deltaY before the exponential keeps a single
      // mouse notch to a smooth ~5-10% step instead of a ~60% jump, while
      // still letting fine trackpad deltas pass through unscaled.
      const factor = Math.exp(clamp(-event.deltaY, -40, 40) * 0.005);
      const point = { x: event.clientX, y: event.clientY };
      if (stream.handle({ type: "wheel", factor, point, inside })) {
        event.preventDefault();
      }
    };
    const onGestureStart = (event: Event) => {
      const point = eventClientPoint(event);
      const inside = isInsideCanvas(event);
      zoomDebugTap("gesturestart", {
        x: Math.round(point?.x ?? -1),
        y: Math.round(point?.y ?? -1),
        inside,
      });
      if (stream.handle({ type: "gestureStart", point, inside })) {
        event.preventDefault();
      }
    };
    const onGestureChange = (event: Event) => {
      const scale = gestureScale(event);
      const changePoint = eventClientPoint(event);
      zoomDebugTap("gesturechange", {
        scale,
        x: Math.round(changePoint?.x ?? -1),
        y: Math.round(changePoint?.y ?? -1),
      });
      const consumed = stream.handle({
        type: "gestureChange",
        scale,
        point: canvasPoint(event),
        inside: isInsideCanvas(event),
      });
      if (consumed) event.preventDefault();
    };
    const onGestureEnd = (event: Event) => {
      const consumed = stream.handle({
        type: "gestureEnd",
        inside: isInsideCanvas(event),
      });
      zoomDebugTap("gestureend", { consumed });
      if (consumed) event.preventDefault();
    };

    // Two-finger pinch on non-Apple touch browsers (Android), derived from
    // Touch Events: `event.touches` is the browser's own finger list, so a
    // finger whose release never reached this scroller cannot linger and
    // pair with the next one-finger swipe as a phantom pinch (the DOCX
    // reader's runaway zoom). The non-passive touchmove also lets a pinch
    // cancel the browser's two-finger pan — preventDefault on pointermove
    // never could, so the page used to scroll away under the fingers while
    // the preview zoomed. Skipped on Safari, where `gesturechange` already
    // does this with sub-pixel precision.
    const detachTouchPinch = supportsAppleGesture
      ? () => undefined
      : attachTouchPinch(window, {
          // At the window, not the scroller: touchend is delivered to the
          // node touchstart hit, and a page this list unmounts mid-gesture
          // takes the end of the gesture with it. `accepts` still confines
          // the pinch to fingers that landed on the document, and a finger
          // whose node left the tree stops being accepted — which ends the
          // pinch instead of stranding it.
          accepts: (target) => containsEventTarget(scroller, target),
          onPinchStart: (midpoint) => {
            stream.handle({ type: "pinchStart", midpoint });
          },
          onPinchMove: (midpoint, ratio) => {
            stream.handle({ type: "pinchMove", midpoint, ratio });
          },
          onPinchEnd: () => {
            stream.handle({ type: "pinchEnd" });
          },
        });

    const touchPoint = (touch: Touch | undefined) =>
      touch ? { x: touch.clientX, y: touch.clientY } : null;
    const onTapTouchStart = (event: TouchEvent) => {
      stream.handle({
        type: "touchStart",
        touches: event.touches.length,
        point: touchPoint(event.touches[0]),
        at: event.timeStamp,
      });
    };
    const onTapTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      stream.handle({
        type: "touchEnd",
        remaining: event.touches.length,
        changed: event.changedTouches.length,
        point: touchPoint(touch),
        at: event.timeStamp,
        eligible: Boolean(
          touch &&
            containsEventTarget(scroller, touch.target) &&
            !isInteractiveTapTarget(touch.target),
        ),
      });
    };
    scroller.addEventListener("touchstart", onTapTouchStart, { passive: true });
    scroller.addEventListener("touchend", onTapTouchEnd, { passive: true });

    const onDebugScroll = () => {
      zoomDebugTap("scroll", {
        top: Math.round(scroller.scrollTop),
        left: Math.round(scroller.scrollLeft),
      });
    };
    if (import.meta.env.DEV) {
      scroller.addEventListener("scroll", onDebugScroll, { passive: true });
    }
    const zoomGestureOptions: AddEventListenerOptions = {
      capture: true,
      passive: false,
    };
    const zoomGestureRemoveOptions: EventListenerOptions = { capture: true };
    window.addEventListener("wheel", onWheel, zoomGestureOptions);
    window.addEventListener("gesturestart", onGestureStart, zoomGestureOptions);
    window.addEventListener("gesturechange", onGestureChange, zoomGestureOptions);
    window.addEventListener("gestureend", onGestureEnd, zoomGestureOptions);
    return () => {
      window.removeEventListener("wheel", onWheel, zoomGestureRemoveOptions);
      window.removeEventListener(
        "gesturestart",
        onGestureStart,
        zoomGestureRemoveOptions,
      );
      window.removeEventListener(
        "gesturechange",
        onGestureChange,
        zoomGestureRemoveOptions,
      );
      window.removeEventListener(
        "gestureend",
        onGestureEnd,
        zoomGestureRemoveOptions,
      );
      detachTouchPinch();
      scroller.removeEventListener("touchstart", onTapTouchStart);
      scroller.removeEventListener("touchend", onTapTouchEnd);
      if (doubleTapFrame !== null) window.cancelAnimationFrame(doubleTapFrame);
      if (import.meta.env.DEV) {
        scroller.removeEventListener("scroll", onDebugScroll);
      }
      scroller.style.touchAction = previousTouchAction;
      stream.dispose();
    };
  }, [editorStore, pages.length, setFitMode, viewport]);

  useCanvasKeyboard({ editorStore, setSpacePan, setPanning, panRef });

  // The active page follows what the viewport shows; every programmatic
  // scroll to a page goes through the tracker, which holds the pages a
  // smooth scroll passes from taking over (see pageTracker.ts). Built on
  // first use, outside render, since its ports read the DOM refs.
  const pageTrackerRef = useRef<PageTracker | null>(null);
  const pageTracker = useCallback(
    (): PageTracker =>
      (pageTrackerRef.current ??= createPageTracker({
        viewportHeight: () => scrollerRef.current?.clientHeight ?? 0,
        scrollTop: () => scrollerRef.current?.scrollTop ?? 0,
        pageBoxes: () => {
          const scroller = scrollerRef.current;
          const container = containerRef.current;
          if (!scroller || !container) return [];
          const viewportTop = scroller.getBoundingClientRect().top;
          return Array.from(
            container.querySelectorAll<HTMLElement>("[data-shiori-page-id]"),
            (node) => {
              const rect = node.getBoundingClientRect();
              return {
                id: node.dataset.shioriPageId ?? "",
                top: rect.top - viewportTop,
                bottom: rect.bottom - viewportTop,
              };
            },
          );
        },
        activePageId: () => editorStore.getState().activePageId,
        setActivePage: (id) => editorStore.getState().setActivePage(id),
        scrollTo: (top, smooth) =>
          scrollerRef.current?.scrollTo({
            top,
            behavior: smooth ? "smooth" : "auto",
          }),
      })),
    [editorStore],
  );

  const scrollToPdfLinkTarget = useCallback(
    (target: PdfLinkTarget) => {
      const page = pages[target.pageIndex];
      if (!page || !scrollerRef.current) return;
      const y = target.destination
        ? destinationDisplayY(
            target.destination,
            page,
            editorStore.getState().scale,
          )
        : null;
      pageTracker().navigate({
        pageId: page.id,
        top: pdfPageScrollTop(
          layout,
          target.pageIndex,
          y == null ? null : y - 24,
        ),
        smooth: y != null,
      });
    },
    [editorStore, layout, pageTracker, pages],
  );

  useEffect(() => {
    if (!pageJump) return;
    const page = pages[pageJump.index];
    const scroller = scrollerRef.current;
    if (!page || page.id !== pageJump.pageId || !scroller) {
      consumePageJump(pageJump);
      return;
    }
    const offsetY = pageJump.offsetY;
    pageTracker().navigate({
      pageId: page.id,
      top: pdfPageScrollTop(
        layout,
        pageJump.index,
        offsetY == null ? null : offsetY - 24,
      ),
      smooth: true,
    });
    consumePageJump(pageJump);
  }, [consumePageJump, layout, pageJump, pageTracker, pages]);


  // Active-page detection runs on every scroll frame: viewport overlap of
  // the mounted page nodes, read from the DOM under rAF. The same listener
  // keeps the mounted range in step with the scroll position.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const container = containerRef.current;
    if (!scroller || !container) return;

    let frame: number | null = null;

    const measure = () => {
      frame = null;
      if (viewport().isGesturing()) return;
      pageTracker().measure();
    };

    const onScroll = () => {
      viewport().onScroll();
      // Never gate this on the gesture flag. Mounting a page mid-gesture
      // paints it at the base scale beside the zoomed ones for a frame,
      // which is cosmetic; skipping the re-range when the flag is stuck
      // leaves the mounted window behind the scroll position and the reader
      // looking at blank paper, which is not. 26.9.8 shipped the gate and
      // did exactly that on Android.
      syncRange();
      if (frame !== null) return;
      frame = window.requestAnimationFrame(measure);
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [docKey, pageTracker, pages, syncRange, viewport]);

  // A long scroll lands on pages its own frame could not see: the browser
  // measures before React mounts the range the scroll asked for, and no
  // further scroll event comes. Measure again once that range is in the
  // DOM (after paint, so a layout landing has already moved the scroller).
  useEffect(() => {
    if (viewport().isGesturing()) return;
    pageTracker().measure();
  }, [pageTracker, range, viewport]);

  return (
    <ScrollerContext.Provider value={scrollerRef}>
    <div
      ref={containerRef}
      className="shioriCanvas"
      style={{
        position: "relative",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        background: T.paper,
        // `clip`, not `hidden`. Both paint the same, but `hidden` makes this a
        // scroll container — one that the user can never scroll back, because
        // it shows no scrollbar and the wheel goes to the virtual list inside.
        // Tabbing into a page below the fold made the browser scroll every
        // ancestor to reveal the focused node, this one included, and the whole
        // view slid up: blank strip at the bottom, content clipped off the top,
        // no way to undo it. `clip` cannot be scrolled at all, programmatically
        // or otherwise, so the browser skips it and scrolls the real scroller.
        overflow: "clip",
        cursor: panning ? "grabbing" : spacePan ? "grab" : cursorFor[tool] ?? "default",
      }}
    >
      {spacePan ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 30,
            cursor: panning ? "grabbing" : "grab",
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !scrollerRef.current) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            panRef.current = {
              pointerId: e.pointerId,
              startX: e.clientX,
              startY: e.clientY,
              scrollLeft: scrollerRef.current.scrollLeft,
              scrollTop: scrollerRef.current.scrollTop,
            };
            setPanning(true);
          }}
          onPointerMove={(e) => {
            const pan = panRef.current;
            const scroller = scrollerRef.current;
            if (!pan || !scroller) return;
            scroller.scrollLeft = pan.scrollLeft - (e.clientX - pan.startX);
            scroller.scrollTop = pan.scrollTop - (e.clientY - pan.startY);
          }}
          onPointerUp={(e) => {
            if (panRef.current?.pointerId === e.pointerId) {
              panRef.current = null;
              setPanning(false);
            }
          }}
          onPointerCancel={() => {
            panRef.current = null;
            setPanning(false);
          }}
        />
      ) : null}
      {pages.length === 0 ? null : (
        <div
          ref={setScrollerElement}
          data-shiori-pdf-scroller
          style={{
            height: "100%",
            overflow: "auto",
            // A reserved rail: a scrollbar appearing or vanishing must not
            // shift the centred page horizontally.
            scrollbarGutter: "stable",
            position: "relative",
            // The zoom commit resizes the column and writes scrollTop in the
            // same frame; Chrome's scroll anchoring would then add its own
            // correction on top of the anchor-pinned one.
            overflowAnchor: "none",
            // A fling that reaches the end must not hand the momentum to the
            // window (which cannot scroll) as a rubber-band glow on Android.
            overscrollBehavior: "contain",
          }}
        >
          <div
            style={{
              position: "relative",
              height: layout.totalHeight,
              // Never narrower than the widest page, so the column scrolls
              // horizontally at high zoom instead of clipping the page.
              width: Math.max(0, Math.ceil(layout.contentWidth)),
              minWidth: "100%",
            }}
          >
            {layout.pages.slice(range.start, range.end).map((item, offset) => {
              const index = range.start + offset;
              const page = pages[index];
              if (!page) return null;
              const size = rotatedSize(
                page.widthPt,
                page.heightPt,
                page.rotation,
              );
              const isActive = page.id === activePageId;
              return (
                <div
                  key={page.id}
                  data-shiori-page-item
                  style={{
                    position: "absolute",
                    top: item.offset,
                    left: 0,
                    right: 0,
                    height: item.itemHeight,
                  }}
                >
                  {/* This inner layer carries the live-zoom compositor
                      transform. It stays in normal flow: transforms never
                      reach layout, so the column, its total height and the
                      scrollbar keep exactly the same geometry while the
                      scroller's overflow still clips the scaled preview. */}
                  <div className="shioriPdfZoomPreviewLayer">
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      width: "max-content",
                      minWidth: "100%",
                      padding: pagePaddingCss,
                      gap: 8,
                    }}
                  >
                    {/* Page label sits ABOVE its page so it visually lands
                        inside the gap between this page and the previous
                        one, rather than hanging off the bottom of the
                        current page. Reads as a "divider / folio" instead
                        of an appendage. */}
                    <div
                      className="shioriPageLabel"
                      style={{
                        font: `500 11px/1 ${T.mono}`,
                        color: isActive ? T.ink : T.dim,
                        letterSpacing: ".04em",
                        transition: "color .2s",
                      }}
                    >
                      {t("meta.pageLabel", {
                        page: String(index + 1).padStart(2, "0"),
                      })}
                    </div>
                    <div className="shioriPageViewport" style={{ position: "relative" }}>
                      {/* Active-page indicator: a thin terracotta stripe
                          tucked along the page's left edge — on-brand
                          (栞 = bookmark), quiet enough for the paper
                          aesthetic, way more restrained than an opaque
                          rectangular border around the whole page. */}
                      <div
                        style={{
                          position: "absolute",
                          left: -10,
                          top: 0,
                          bottom: 0,
                          width: 3,
                          borderRadius: 1.5,
                          background: isActive ? T.accent : "transparent",
                          pointerEvents: "none",
                          transition: "background-color .2s",
                        }}
                      />
                      <div
                        className="shioriPage"
                        data-shiori-page-id={page.id}
                        data-pdf-paper-tone={pdfPaperTone}
                        style={{
                          position: "relative",
                          width: size.width * scale,
                          height: size.height * scale,
                          // Paper, never the theme surface. This is what shows in
                          // the gap between a page mounting and its raster
                          // landing, and a PDF sheet is white — painting the
                          // theme's surface there is what turned that gap into a
                          // visible flash, especially in a dark theme where it
                          // reads as a black hole followed by a white page.
                          // Pre-mounting one page ahead shortened the gap; this
                          // makes the gap invisible when scrolling still outruns
                          // it. Same fallback the blank-page renderer uses.
                          background: displayPaperColor ?? "#fffdf8",
                          isolation: displayPaperColor ? "isolate" : undefined,
                          boxShadow:
                            "0 1px 2px rgba(60,50,30,0.06), 0 20px 60px rgba(60,50,30,0.10)",
                          borderRadius: 2,
                          // Same reason as the viewport above: this only exists to
                          // clip the canvas to the rounded corner, and `hidden`
                          // would make every mounted page another scroll container
                          // for focus to shove around.
                          overflow: "clip",
                        }}
                      >
                        {isBlankPage(page) ? (
                          <BlankPage color={displayPaperColor ?? "#fffdf8"} />
                        ) : (
                          <>
                            <PageCanvas
                              doc={doc}
                              sourceIndex={page.sourceIndex}
                              rotation={page.rotation}
                              scale={scale}
                              widthPt={size.width}
                              heightPt={size.height}
                              paperColor={displayPaperColor}
                            />
                            <TextHighlightLayer
                              doc={doc}
                              page={page}
                              pageIndex={index}
                              scale={scale}
                              layerScale={scale}
                            />
                            <PdfLinkLayer
                              doc={doc}
                              page={page}
                              scale={scale}
                              layerScale={scale}
                              onNavigate={scrollToPdfLinkTarget}
                            />
                            {outlineSelection?.pageId === page.id
                              ? (() => {
                                  // Re-project the stored PDF-space top to display
                                  // pixels with the CURRENT scale so the stripe
                                  // tracks the heading after zooming.
                                  const top = pdfToDisplay(
                                    { x: 0, y: outlineSelection.pdfTop },
                                    page.widthPt,
                                    page.heightPt,
                                    page.rotation,
                                    scale,
                                  ).y;
                                  return (
                                    <div
                                      style={{
                                        position: "absolute",
                                        left: 0,
                                        right: 0,
                                        top: Math.max(
                                          0,
                                          Math.min(
                                            size.height * scale -
                                              Math.max(20, 24 * scale),
                                            top,
                                          ),
                                        ),
                                        height: Math.max(20, 24 * scale),
                                        background: T.accent,
                                        opacity: 0.22,
                                        pointerEvents: "none",
                                        zIndex: 1,
                                      }}
                                    />
                                  );
                                })()
                              : null}
                          </>
                        )}
                        <OverlayLayer
                          page={page}
                          scale={scale}
                          overlays={overlaysByPage.get(page.id) ?? EMPTY_OVERLAYS}
                        />
                      </div>
                    </div>
                  </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
    </ScrollerContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { isPdfTextSelectionContext } from "./useCanvasKeyboard";

// Resolve the PDF user-space vertical position (points, origin at page
// bottom-left) that an outline/link destination points at. Returned value is
// scale-independent so it can be stored and re-projected to pixels at any
// later zoom level. Returns null for destinations we can't resolve.
// `destination.args` are the PDF destination array's operands after the view
// name, so XYZ's [left, top, zoom] and FitR's [left, bottom, right, top].
// eslint-disable-next-line react-refresh/only-export-components
export function destinationPdfTop(
  destination: PdfDestination,
  page: PageModel,
): number | null {
  const { view, args } = destination;
  return view === "XYZ"
    ? args[1] ?? page.heightPt
    : view === "FitH" || view === "FitBH"
      ? args[0] ?? page.heightPt
      : view === "FitR"
        ? args[3] ?? null
        : view === "Fit" || view === "FitB" || view === "FitV" || view === "FitBV"
          ? page.heightPt
          : null;
}

// eslint-disable-next-line react-refresh/only-export-components
export function destinationDisplayY(
  destination: PdfDestination,
  page: PageModel,
  scale: number,
): number | null {
  const top = destinationPdfTop(destination, page);
  if (top == null) return null;
  const { view, args } = destination;
  const left =
    view === "XYZ" || view === "FitR" || view === "FitV" || view === "FitBV"
      ? args[0] ?? null
      : null;
  const point = pdfToDisplay(
    {
      x: left ?? 0,
      y: top ?? page.heightPt,
    },
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  return Math.max(0, point.y);
}

// How long a double tap's zoom animates; what counts as a double tap lives
// in zoomGestureStream (DOUBLE_TAP).
const DOUBLE_TAP_ZOOM_MS = 180;

function isInteractiveTapTarget(target: EventTarget | null): boolean {
  return Boolean(
    target &&
      typeof (target as Element).closest === "function" &&
      (target as Element).closest(
        'a, button, input, textarea, select, [contenteditable="true"], [data-overlay-id], [data-role="interactive"]',
      ),
  );
}

function gestureScale(event: Event): number | null {
  const scale = (event as Event & { scale?: unknown }).scale;
  return typeof scale === "number" && Number.isFinite(scale) ? scale : null;
}

function eventTargetsElement(event: Event, element: HTMLElement): boolean {
  const target = event.target;
  if (target instanceof Node && element.contains(target)) return true;
  const point = eventClientPoint(event);
  if (!point) return false;
  const rect = element.getBoundingClientRect();
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function eventClientPoint(event: Event): { x: number; y: number } | null {
  const point = event as Event & { clientX?: unknown; clientY?: unknown };
  return typeof point.clientX === "number" &&
    typeof point.clientY === "number" &&
    Number.isFinite(point.clientX) &&
    Number.isFinite(point.clientY)
    ? { x: point.clientX, y: point.clientY }
    : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function BlankPage({ color }: { color: string }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: color,
      }}
    />
  );
}

