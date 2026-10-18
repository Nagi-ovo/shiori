import type { Clock, TimerHandle } from "./clock";

/**
 * One classifier for every zoom gesture a document view receives: ctrl+wheel,
 * the WebKit gesturestart / gesturechange / gestureend bracket, a two-finger
 * touch pinch and a double tap. It decides which stream drives, what scale
 * each frame previews and when the preview commits; the view owns the
 * preview itself (a transform, synchronous per frame) and the commit (its
 * relayout) behind the ports.
 *
 * Platforms disagree on what a trackpad pinch emits. Chromium: ctrl+wheel
 * only. iOS Safari: gesturechange with a usable `scale`. macOS WKWebView (the
 * Tauri shell): gesturestart / gestureend as a bracket with the deltas
 * arriving as ctrl+wheel, its gesturechange possibly without a scale. So the
 * wheels may be the one real stream inside an open bracket; they are ignored
 * only once a scaled gesturechange proves the bracket itself drives, or the
 * two would stack.
 *
 * The stream holds no React state and batches nothing: each event previews
 * in the same turn it arrives.
 */

export type ZoomPoint = { x: number; y: number };

export type ZoomGestureEvent =
  /** A ctrl+wheel delta, already turned into a zoom factor. */
  | { type: "wheel"; factor: number; point: ZoomPoint; inside: boolean }
  | { type: "gestureStart"; point: ZoomPoint | null; inside: boolean }
  /** `scale` is relative to the bracket's start; null when the event has none. */
  | { type: "gestureChange"; scale: number | null; point: ZoomPoint; inside: boolean }
  | { type: "gestureEnd"; inside: boolean }
  /** A two-finger touch pinch, as attachTouchPinch reports it. */
  | { type: "pinchStart"; midpoint: ZoomPoint }
  | { type: "pinchMove"; midpoint: ZoomPoint; ratio: number }
  | { type: "pinchEnd" }
  /** Raw touches for double tap; `at` is the event's timeStamp. */
  | { type: "touchStart"; touches: number; point: ZoomPoint | null; at: number }
  | {
      type: "touchEnd";
      /** Fingers still down after this event. */
      remaining: number;
      /** Fingers this event lifted. */
      changed: number;
      point: ZoomPoint | null;
      at: number;
      /** The finger landed on the document, not on a control. */
      eligible: boolean;
    };

export type ZoomGesturePorts = {
  /** Show `scale` anchored at `point`. Called synchronously per frame. */
  preview(point: ZoomPoint, scale: number): void;
  /** Land the preview (a no-op when none is showing). */
  commit(): void;
  /** Drop the preview without landing it. */
  cancel(): void;
  /** The scale on screen now, preview included. Wheel deltas compound on it. */
  visualScale(): number;
  /**
   * A bracket or a touch pinch opens: the scale its ratios multiply. A view
   * may open its preview session here.
   */
  openGesture(point: ZoomPoint | null): number;
  /** The base for a gesturechange that arrives with no bracket open. */
  restingScale(): number;
  /** A preview or a tap zoom is running; a double tap must not start another. */
  isBusy(): boolean;
  doubleTap(point: ZoomPoint): void;
  clock: Clock;
};

export type ZoomGestureOptions = {
  /**
   * Commit a touch pinch whose fingers went this quiet without an end (the
   * end event lost to an unmounted node); null waits for the end.
   */
  pinchWatchdogMs: number | null;
  doubleTap: boolean;
};

export const ZOOM_GESTURE_TIMING = {
  /**
   * A ctrl+wheel stream with no bracket has no end event, so it commits once
   * it falls this quiet. 140 ms fired during the brief finger pauses of one
   * continuous trackpad pinch: a full relayout mid-gesture, a visible stutter.
   */
  wheelSettleMs: 250,
  /**
   * Inside a bracket the end commits; this only rescues a bracket whose end
   * never arrives (focus leaving the window mid-pinch).
   */
  bracketFailSafeMs: 900,
  /**
   * WKWebView streams coalesced ctrl+wheel momentum after the bracket closes;
   * a short settle folds that tail into the same commit instead of a second
   * relayout right after the first.
   */
  gestureEndSettleMs: 140,
  /**
   * The PDF canvas's touch pinch watchdog. A touch pinch commits on its end;
   * should that never arrive (the node the fingers landed on left the tree,
   * the webview dropped the sequence) this is the longest it may sit
   * uncommitted. Far above any pause a reader makes mid-pinch, far below
   * "forever": the canvas's gesture flag also gates its active-page tracker.
   */
  pinchWatchdogMs: 3_000,
} as const;

/** Two real taps (short and still) close in time and space. */
export const DOUBLE_TAP = {
  slopPx: 12,
  maxTapMs: 300,
  betweenMs: 300,
  betweenSlopPx: 32,
} as const;

export type ZoomGestureStream = {
  /** Feed one event; true when it was a zoom input the caller should prevent. */
  handle(event: ZoomGestureEvent): boolean;
  /** Stop: cancel the timers and the preview. Later events are not consumed. */
  dispose(): void;
};

export function createZoomGestureStream(
  ports: ZoomGesturePorts,
  options: Partial<ZoomGestureOptions> = {},
): ZoomGestureStream {
  const pinchWatchdogMs = options.pinchWatchdogMs ?? null;
  const doubleTapEnabled = options.doubleTap ?? false;
  const { clock } = ports;

  let disposed = false;
  let timer: TimerHandle | null = null;
  /** The scale the open bracket's ratios multiply; null outside a bracket. */
  let bracketBase: number | null = null;
  /** A scaled gesturechange drives the open bracket; wheels stand down. */
  let bracketDriving = false;
  let pinchBase: number | null = null;
  let tapStart: { point: ZoomPoint; at: number } | null = null;
  let lastTap: { point: ZoomPoint; at: number } | null = null;

  const disarm = () => {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  };
  const commitAfter = (ms: number) => {
    disarm();
    timer = clock.setTimeout(() => {
      timer = null;
      // Hand wheels back, but keep the base: a pinch held still past the
      // fail-safe goes on scaling against where its bracket opened.
      bracketDriving = false;
      ports.commit();
    }, ms);
  };

  const onTouchEnd = (event: Extract<ZoomGestureEvent, { type: "touchEnd" }>) => {
    const start = tapStart;
    tapStart = null;
    if (!start || !event.point || event.remaining !== 0 || event.changed !== 1) return;
    const point = event.point;
    const isTap =
      distance(point, start.point) <= DOUBLE_TAP.slopPx &&
      event.at - start.at <= DOUBLE_TAP.maxTapMs;
    if (!isTap || !event.eligible) {
      lastTap = null;
      return;
    }
    const previous = lastTap;
    lastTap = { point, at: event.at };
    if (
      !previous ||
      event.at - previous.at > DOUBLE_TAP.betweenMs ||
      distance(point, previous.point) > DOUBLE_TAP.betweenSlopPx
    ) {
      return;
    }
    lastTap = null;
    // A pinch or wheel preview still in flight owns the zoom.
    if (ports.isBusy()) return;
    ports.doubleTap(point);
  };

  const handle = (event: ZoomGestureEvent): boolean => {
    if (disposed) return false;
    switch (event.type) {
      case "wheel": {
        if (!event.inside) return false;
        if (bracketDriving) return true;
        if (!Number.isFinite(event.factor) || event.factor <= 0) return true;
        ports.preview(event.point, ports.visualScale() * event.factor);
        commitAfter(
          bracketBase !== null
            ? ZOOM_GESTURE_TIMING.bracketFailSafeMs
            : ZOOM_GESTURE_TIMING.wheelSettleMs,
        );
        return true;
      }
      case "gestureStart": {
        if (!event.inside) return false;
        // A wheel that slipped in just before must not commit under it.
        disarm();
        bracketDriving = false;
        bracketBase = ports.openGesture(event.point);
        return true;
      }
      case "gestureChange": {
        const scale = event.scale;
        if (scale === null || !Number.isFinite(scale) || scale <= 0) return false;
        // Once open over the view, the bracket follows the fingers anywhere.
        if (bracketBase === null && !event.inside) return false;
        bracketDriving = true;
        commitAfter(ZOOM_GESTURE_TIMING.bracketFailSafeMs);
        ports.preview(event.point, (bracketBase ?? ports.restingScale()) * scale);
        return true;
      }
      case "gestureEnd": {
        if (bracketBase === null && !event.inside) return false;
        bracketBase = null;
        bracketDriving = false;
        commitAfter(ZOOM_GESTURE_TIMING.gestureEndSettleMs);
        return true;
      }
      case "pinchStart": {
        if (pinchWatchdogMs === null) disarm();
        else commitAfter(pinchWatchdogMs);
        pinchBase = ports.openGesture(event.midpoint);
        return true;
      }
      case "pinchMove": {
        if (pinchBase === null) return false;
        if (pinchWatchdogMs !== null) commitAfter(pinchWatchdogMs);
        ports.preview(event.midpoint, pinchBase * event.ratio);
        return true;
      }
      case "pinchEnd": {
        if (pinchBase === null) return false;
        pinchBase = null;
        // A touch pinch has no momentum tail to fold in.
        disarm();
        ports.commit();
        return true;
      }
      case "touchStart": {
        if (!doubleTapEnabled) return false;
        tapStart =
          event.touches === 1 && event.point ? { point: event.point, at: event.at } : null;
        return false;
      }
      case "touchEnd": {
        if (!doubleTapEnabled) return false;
        onTouchEnd(event);
        return false;
      }
    }
  };

  return {
    handle,
    dispose() {
      if (disposed) return;
      disposed = true;
      disarm();
      bracketBase = null;
      bracketDriving = false;
      pinchBase = null;
      ports.cancel();
    },
  };
}

function distance(a: ZoomPoint, b: ZoomPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
