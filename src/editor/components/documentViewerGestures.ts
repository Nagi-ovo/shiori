import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  SCROLL_REPORT_DEBOUNCE_MS,
  TEXT_ZOOM_MAX,
  TEXT_ZOOM_MIN,
  TRACKPAD_WHEEL_DELTA_LIMIT,
  TRACKPAD_WHEEL_ZOOM_SENSITIVITY,
} from "./DocumentViewer";
import { setLiveZoomIndicator } from "./liveZoomIndicator";
import { systemClock } from "../viewport/clock";
import {
  createZoomGestureStream,
  ZOOM_GESTURE_TIMING,
  type ZoomGestureEvent,
  type ZoomGestureStream,
} from "../viewport/zoomGestureStream";

// Committing text zoom per gesture event reflowed the whole document on every
// frame (CSS `zoom` re-lays-out everything) — the stutter readers felt — and
// the scroll correction trailed one rAF behind the commit, an rAF WebKit may
// pause for the whole native gesture. Same architecture as the PDF/DOCX
// viewers now: the live gesture only moves a compositor transform on the
// scroller's content layer, and the one real relayout happens when the
// gesture settles, with the scroll correction applied synchronously inside
// the same commit.
type TextZoomPreviewSession = {
  anchorClientX: number;
  anchorClientY: number;
  anchorLocalX: number;
  anchorLocalY: number;
  baseZoom: number;
  layer: HTMLElement;
  layerLeft: number;
  layerTop: number;
  previousTransform: string;
  previousTransformOrigin: string;
  previousTransition: string;
  previousWillChange: string;
};

// A touch pinch whose end never arrives commits after this much quiet, the
// same rescue a WebKit bracket gets.
const TEXT_PINCH_WATCHDOG_MS = ZOOM_GESTURE_TIMING.bracketFailSafeMs;

// The preview layer is the scroller's single content child; when the scroller
// is a document's scrolling element (the HTML view scrolls inside an iframe),
// it is that document's body. Cross-realm nodes defeat instanceof, so duck-
// type on `style`.
function zoomPreviewLayer(scroller: HTMLElement): HTMLElement | null {
  const doc = scroller.ownerDocument;
  const candidate =
    scroller === doc.scrollingElement || scroller === doc.documentElement
      ? doc.body
      : scroller.firstElementChild;
  return candidate && "style" in candidate
    ? (candidate as HTMLElement)
    : null;
}

export function useScrollableZoomGestures(
  scrollerRef: RefObject<HTMLElement | null>,
  zoom: number,
  onZoomChange?: (zoom: number) => void,
) {
  const zoomRef = useRef(zoom);
  const visualZoomRef = useRef(zoom);
  const onZoomChangeRef = useRef(onZoomChange);
  const sessionRef = useRef<TextZoomPreviewSession | null>(null);
  const streamRef = useRef<ZoomGestureStream | null>(null);
  const enabled = Boolean(onZoomChange);

  useEffect(() => {
    zoomRef.current = zoom;
    if (!sessionRef.current) visualZoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    onZoomChangeRef.current = onZoomChange;
  }, [onZoomChange]);

  const restoreSessionLayer = useCallback(
    (session: TextZoomPreviewSession) => {
      session.layer.style.transform = session.previousTransform;
      session.layer.style.transformOrigin = session.previousTransformOrigin;
      session.layer.style.willChange = session.previousWillChange;
      // Transition starting is judged against the AFTER-change style: flush
      // the transform reset while the inline transition is still 'none', or
      // everything measured below reads tween-start rectangles.
      void session.layer.offsetWidth;
      session.layer.style.transition = session.previousTransition;
    },
    [],
  );

  const beginPreview = useCallback(
    (clientX: number, clientY: number): TextZoomPreviewSession | null => {
      const existing = sessionRef.current;
      if (existing) return existing;
      const scroller = scrollerRef.current;
      const layer = scroller ? zoomPreviewLayer(scroller) : null;
      if (!scroller || !layer) return null;
      const layerRect = layer.getBoundingClientRect();
      const session: TextZoomPreviewSession = {
        anchorClientX: clientX,
        anchorClientY: clientY,
        anchorLocalX: clientX - layerRect.left,
        anchorLocalY: clientY - layerRect.top,
        baseZoom: zoomRef.current,
        layer,
        layerLeft: layerRect.left,
        layerTop: layerRect.top,
        previousTransform: layer.style.transform,
        previousTransformOrigin: layer.style.transformOrigin,
        previousTransition: layer.style.transition,
        previousWillChange: layer.style.willChange,
      };
      layer.style.transition = "none";
      layer.style.transformOrigin = "0 0";
      layer.style.willChange = "transform";
      sessionRef.current = session;
      visualZoomRef.current = session.baseZoom;
      return session;
    },
    [scrollerRef],
  );

  const commitPreview = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    setLiveZoomIndicator(null);
    if (!session) return;

    const nextZoom = Number(
      clampNumber(visualZoomRef.current, TEXT_ZOOM_MIN, TEXT_ZOOM_MAX).toFixed(
        3,
      ),
    );
    restoreSessionLayer(session);
    const setZoom = onZoomChangeRef.current;
    const scroller = scrollerRef.current;
    if (!setZoom || !scroller || Math.abs(nextZoom - session.baseZoom) < 0.001) {
      visualZoomRef.current = zoomRef.current;
      return;
    }

    // The preview's fixed point is the content under the LAST anchor
    // position. With the transforms just restored (and flushed), the base
    // layout is briefly back — measure the content anchor there.
    const preRect = scroller.getBoundingClientRect();
    const contentX =
      scroller.scrollLeft + session.anchorClientX - preRect.left;
    const contentY = scroller.scrollTop + session.anchorClientY - preRect.top;
    const ratio = nextZoom / session.baseZoom;

    // Text has no async layout engine: the relayout happens inside this
    // synchronous commit, so the correction below measures final geometry in
    // the same event turn — no rAF gap for WebKit to starve.
    flushSync(() => setZoom(nextZoom));
    zoomRef.current = nextZoom;
    visualZoomRef.current = nextZoom;

    const nextRect = scroller.getBoundingClientRect();
    scroller.scrollLeft =
      contentX * ratio - (session.anchorClientX - nextRect.left);
    scroller.scrollTop =
      contentY * ratio - (session.anchorClientY - nextRect.top);
  }, [restoreSessionLayer, scrollerRef]);

  const applyPreviewFrame = useCallback(
    (clientX: number, clientY: number, targetZoom: number) => {
      const session = beginPreview(clientX, clientY);
      if (!session) return;
      const clamped = clampNumber(targetZoom, TEXT_ZOOM_MIN, TEXT_ZOOM_MAX);
      visualZoomRef.current = clamped;
      setLiveZoomIndicator(clamped);
      session.anchorClientX = clientX;
      session.anchorClientY = clientY;
      const ratio = clamped / session.baseZoom;
      const translateX =
        clientX - session.layerLeft - session.anchorLocalX * ratio;
      const translateY =
        clientY - session.layerTop - session.anchorLocalY * ratio;
      session.layer.style.transform =
        `translate3d(${translateX}px, ${translateY}px, 0) scale(${ratio})`;
    },
    [beginPreview],
  );

  const cancelPreview = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) restoreSessionLayer(session);
    setLiveZoomIndicator(null);
    visualZoomRef.current = zoomRef.current;
  }, [restoreSessionLayer]);

  // Created on first use rather than in the listener effect: the HTML view
  // forwards its frame's events through the callbacks below even before
  // (or without) the listeners on this window.
  const feed = useCallback(
    (event: ZoomGestureEvent): boolean => {
      streamRef.current ??= createZoomGestureStream(
        {
          preview: (point, scale) => applyPreviewFrame(point.x, point.y, scale),
          commit: commitPreview,
          cancel: cancelPreview,
          visualScale: () => visualZoomRef.current,
          openGesture: () => visualZoomRef.current,
          restingScale: () => visualZoomRef.current,
          isBusy: () => sessionRef.current !== null,
          doubleTap: () => undefined,
          clock: systemClock,
        },
        { pinchWatchdogMs: TEXT_PINCH_WATCHDOG_MS, doubleTap: false },
      );
      return streamRef.current.handle(event);
    },
    [applyPreviewFrame, cancelPreview, commitPreview],
  );

  const zoomByFactor = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      feed({ type: "wheel", factor, point: { x: clientX, y: clientY }, inside: true });
    },
    [feed],
  );

  const startGesture = useCallback(() => {
    feed({ type: "gestureStart", point: null, inside: true });
  }, [feed]);

  const changeGesture = useCallback(
    (clientX: number, clientY: number, scaleValue: number) => {
      feed({
        type: "gestureChange",
        scale: scaleValue,
        point: { x: clientX, y: clientY },
        inside: true,
      });
    },
    [feed],
  );

  const endGesture = useCallback(() => {
    streamRef.current?.handle({ type: "gestureEnd", inside: true });
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const scrollerAtInstall = scrollerRef.current;
    const previousTouchAction = scrollerAtInstall?.style.touchAction;
    if (scrollerAtInstall) scrollerAtInstall.style.touchAction = "pan-x pan-y";
    const supportsAppleGesture = "GestureEvent" in window;

    const onWheel = (event: WheelEvent) => {
      const scroller = scrollerRef.current;
      if (!scroller || !event.ctrlKey) return;
      const consumed = feed({
        type: "wheel",
        factor: wheelZoomFactor(event.deltaY),
        point: eventClientPoint(event) ?? scrollerCenter(scroller),
        inside: eventTargetsElement(event, scroller),
      });
      if (consumed) event.preventDefault();
    };
    const onGestureStart = (event: Event) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const consumed = feed({
        type: "gestureStart",
        point: eventClientPoint(event),
        inside: eventTargetsElement(event, scroller),
      });
      if (consumed) event.preventDefault();
    };
    const onGestureChange = (event: Event) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const consumed = feed({
        type: "gestureChange",
        scale: gestureScale(event),
        point: eventClientPoint(event) ?? scrollerCenter(scroller),
        inside: eventTargetsElement(event, scroller),
      });
      if (consumed) event.preventDefault();
    };
    const onGestureEnd = (event: Event) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const consumed = feed({
        type: "gestureEnd",
        inside: eventTargetsElement(event, scroller),
      });
      if (consumed) event.preventDefault();
    };
    const detachTouchPinch = supportsAppleGesture
      ? () => undefined
      : attachTouchPinch(window, {
          accepts: (target) => {
            const scroller = scrollerRef.current;
            return Boolean(scroller && containsEventTarget(scroller, target));
          },
          onPinchStart: (midpoint) => {
            feed({ type: "pinchStart", midpoint });
          },
          onPinchMove: (midpoint, ratio) => {
            feed({ type: "pinchMove", midpoint, ratio });
          },
          onPinchEnd: () => {
            feed({ type: "pinchEnd" });
          },
        });
    const addOptions: AddEventListenerOptions = {
      capture: true,
      passive: false,
    };
    const removeOptions: EventListenerOptions = { capture: true };
    window.addEventListener("wheel", onWheel, addOptions);
    window.addEventListener("gesturestart", onGestureStart, addOptions);
    window.addEventListener("gesturechange", onGestureChange, addOptions);
    window.addEventListener("gestureend", onGestureEnd, addOptions);
    return () => {
      window.removeEventListener("wheel", onWheel, removeOptions);
      window.removeEventListener("gesturestart", onGestureStart, removeOptions);
      window.removeEventListener("gesturechange", onGestureChange, removeOptions);
      window.removeEventListener("gestureend", onGestureEnd, removeOptions);
      detachTouchPinch();
      if (scrollerAtInstall && previousTouchAction !== undefined) {
        scrollerAtInstall.style.touchAction = previousTouchAction;
      }
      // Dispose cancels the preview; the next event opens a fresh stream.
      streamRef.current?.dispose();
      streamRef.current = null;
    };
  }, [enabled, feed, scrollerRef]);

  return useMemo(
    () => ({
      zoomByFactor,
      startGesture,
      changeGesture,
      endGesture,
    }),
    [changeGesture, endGesture, startGesture, zoomByFactor],
  );
}

export function useDebouncedScrollTopChange(
  onScrollTopChange: (scrollTop: number) => void,
) {
  const onScrollTopChangeRef = useRef(onScrollTopChange);
  const pendingScrollTopRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    onScrollTopChangeRef.current = onScrollTopChange;
  }, [onScrollTopChange]);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingScrollTopRef.current;
    if (pending === null) return;
    pendingScrollTopRef.current = null;
    onScrollTopChangeRef.current(pending);
  }, []);

  const report = useCallback(
    (scrollTop: number) => {
      pendingScrollTopRef.current = scrollTop;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(
        flush,
        SCROLL_REPORT_DEBOUNCE_MS,
      );
    },
    [flush],
  );

  useEffect(() => flush, [flush]);

  return { report, flush };
}

export function isElementTarget(target: EventTarget | null): target is Element {
  return Boolean(target && target instanceof window.Element);
}

export type TouchPinchHandlers = {
  /**
   * Whether a finger belongs to the document. `event.touches` lists every
   * finger on the glass, so fingers that landed on the toolbar or beside the
   * scroller must be filtered out by where they started.
   */
  accepts: (target: EventTarget | null) => boolean;
  onPinchStart: (midpoint: { x: number; y: number }) => void;
  /** `ratio` is the current finger distance over the distance at start. */
  onPinchMove: (midpoint: { x: number; y: number }, ratio: number) => void;
  onPinchEnd: () => void;
};

/**
 * Two-finger pinch for touch browsers without Apple gesture events (Android
 * WebView, Chromium on touch screens, Firefox mobile), derived from Touch
 * Events rather than Pointer Events.
 *
 * `event.touches` is the browser's own list of the fingers currently on the
 * glass, so this tracker can never strand one. The Pointer Events tracker it
 * replaces had to hear every pointerup / pointercancel itself, and Android
 * WebView delivers those to the pointerdown target — which the Word engine
 * captures and re-renders, so the release never bubbled to the host. The
 * stranded pointer then paired with every later one-finger swipe as a
 * "pinch" against a phantom finger: each swipe up zoomed the document a
 * little further, until the text was unreadable.
 *
 * touchmove is registered non-passive so a pinch can cancel the browser's
 * own two-finger pan — preventDefault on pointermove never stops a scroll.
 * Only the moves before the browser commits to a scroll are cancelable, so
 * the first two-finger move decides.
 */
export function attachTouchPinch(
  host: EventTarget,
  handlers: TouchPinchHandlers,
): () => void {
  let baseDistance: number | null = null;

  const fingers = (event: TouchEvent) => {
    const points: { x: number; y: number }[] = [];
    for (const touch of Array.from(event.touches)) {
      if (handlers.accepts(touch.target)) {
        points.push({ x: touch.clientX, y: touch.clientY });
      }
    }
    return points;
  };
  const geometry = (points: { x: number; y: number }[]) => {
    const [a, b] = points;
    if (!a || !b) return null;
    return {
      midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.hypot(b.x - a.x, b.y - a.y),
    };
  };
  // Re-derive the pinch state from the fingers the browser reports right
  // now: exactly two document fingers means a pinch, anything else ends one.
  const sync = (event: TouchEvent) => {
    const points = fingers(event);
    if (points.length === 2) {
      if (baseDistance !== null) return;
      const pair = geometry(points);
      if (!pair || pair.distance <= 0) return;
      baseDistance = pair.distance;
      handlers.onPinchStart(pair.midpoint);
      return;
    }
    if (baseDistance === null) return;
    baseDistance = null;
    handlers.onPinchEnd();
  };
  const onTouchStart = (event: Event) => sync(event as TouchEvent);
  const onTouchEnd = (event: Event) => sync(event as TouchEvent);
  const onTouchMove = (event: Event) => {
    const touchEvent = event as TouchEvent;
    const points = fingers(touchEvent);
    if (points.length !== 2) {
      sync(touchEvent);
      return;
    }
    const pair = geometry(points);
    if (!pair || pair.distance <= 0) return;
    if (baseDistance === null) {
      baseDistance = pair.distance;
      handlers.onPinchStart(pair.midpoint);
    }
    if (touchEvent.cancelable) touchEvent.preventDefault();
    handlers.onPinchMove(pair.midpoint, pair.distance / baseDistance);
  };

  const passive: AddEventListenerOptions = { capture: true, passive: true };
  const blocking: AddEventListenerOptions = { capture: true, passive: false };
  const remove: EventListenerOptions = { capture: true };
  host.addEventListener("touchstart", onTouchStart, passive);
  host.addEventListener("touchmove", onTouchMove, blocking);
  host.addEventListener("touchend", onTouchEnd, passive);
  host.addEventListener("touchcancel", onTouchEnd, passive);
  return () => {
    host.removeEventListener("touchstart", onTouchStart, remove);
    host.removeEventListener("touchmove", onTouchMove, remove);
    host.removeEventListener("touchend", onTouchEnd, remove);
    host.removeEventListener("touchcancel", onTouchEnd, remove);
  };
}

/**
 * `element.contains` for an event target that may come from another realm
 * (an iframe document, or the test DOM): duck-type on nodeType instead of
 * instanceof Node.
 */
export function containsEventTarget(
  element: HTMLElement,
  target: EventTarget | null,
): boolean {
  return Boolean(
    target &&
      typeof (target as Node).nodeType === "number" &&
      element.contains(target as Node),
  );
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

export function eventClientPoint(event: Event): { x: number; y: number } | null {
  const point = event as Event & { clientX?: unknown; clientY?: unknown };
  return typeof point.clientX === "number" &&
    typeof point.clientY === "number" &&
    Number.isFinite(point.clientX) &&
    Number.isFinite(point.clientY)
    ? { x: point.clientX, y: point.clientY }
    : null;
}

export function scrollerCenter(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(
    clampNumber(
      -deltaY,
      -TRACKPAD_WHEEL_DELTA_LIMIT,
      TRACKPAD_WHEEL_DELTA_LIMIT,
    ) * TRACKPAD_WHEEL_ZOOM_SENSITIVITY,
  );
}

export function gestureScale(event: Event): number | null {
  const scale = (event as Event & { scale?: unknown }).scale;
  return typeof scale === "number" && Number.isFinite(scale) ? scale : null;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
