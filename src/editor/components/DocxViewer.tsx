import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
  type UIEvent,
} from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import type { DocxEditorProps } from "@docx-editor.dev/react";
import { T } from "../../design/tokens";
import { setLiveZoomIndicator } from "./liveZoomIndicator";
import { systemClock } from "../viewport/clock";
import { createZoomGestureStream } from "../viewport/zoomGestureStream";
import { ZoomControls } from "./ZoomControls";
import { DocumentControlBar, LoadingBlock } from "./DocumentViewerParts";
import {
  attachTouchPinch,
  containsEventTarget,
} from "./documentViewerGestures";
import {
  DOCX_MAX_ZOOM,
  DOCX_MIN_ZOOM,
  fitDocxZoomForWidth,
  measureDocxFitGeometry,
  type DocxFitGeometry,
} from "./docxFit";

/**
 * The renderer is ~2 MB gzipped — an order of magnitude more than the rest of
 * the app — and only a reader who actually opens a .docx ever needs it. It
 * stays behind `lazy` so the main bundle is unchanged for everyone else, and
 * so a Word file is never a cost paid at startup.
 */
const DocxSurface = lazy(async () => {
  const [
    { DocxEditor, useDocxSource },
    { loadShioriDocxFonts, scanDocxFontFamilies },
  ] = await Promise.all([
    import("@docx-editor.dev/react"),
    import("./docxFonts"),
    import("@docx-editor.dev/core/styles/editor.css"),
  ]);
  // One load per distinct family set, kept for the session: two documents
  // naming the same fonts share the bytes, and reopening a tab costs nothing.
  const fontLoads = new Map<string, ReturnType<typeof loadShioriDocxFonts>>();
  const loadWordFontsFor = (families: ReadonlySet<string>) => {
    const key = Array.from(families).sort().join("\u0000");
    let load = fontLoads.get(key);
    if (!load) {
      load = loadShioriDocxFonts({
        families,
        onFailure: (failure) => {
          console.warn("DOCX font substitute failed to load", failure);
        },
      });
      fontLoads.set(key, load);
    }
    return load;
  };
  function DocxSurfaceWithFonts(props: DocxEditorProps) {
    const source = props.document;
    if (!(source instanceof Uint8Array)) {
      throw new Error("DOCX surface requires byte-backed input");
    }
    // The zero-argument loader form holds the document until fonts settle, so
    // the page paginates once. Scanning the file first keeps that while
    // loading only the faces this document names instead of every bundled one.
    const loadWordFonts = useMemo(
      () => () => loadWordFontsFor(scanDocxFontFamilies(source)),
      [source],
    );
    const loaded = useDocxSource(source, { fonts: loadWordFonts });
    if (loaded.error) throw loaded.error;
    if (loaded.isLoading || !loaded.document) return <LoadingBlock />;
    return (
      <DocxEditor
        {...props}
        document={loaded.document}
        fonts={loaded.fonts}
      />
    );
  }
  return { default: DocxSurfaceWithFonts };
});

/**
 * The renderer's paginated surface is absolutely positioned at its own page
 * width and its mount is a plain block, so the page hugs the left edge and
 * leaves the rest of a wide viewport empty. (Its other render path centres
 * itself with `margin-inline: auto` on the page stack; this one does not.)
 * Centring is the host's job here, and a margin on the surface keeps the
 * engine's content origin on the page's top-left — which is what hit testing
 * and scroll geometry are measured from.
 */
const CENTRE_THE_PAGE = `
.shioriDocxViewer .shioriDocxViewer__surface {
  flex: 1 1 0;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  touch-action: pan-x pan-y;
  box-sizing: border-box;
}
.shioriDocxViewer .docx-paginated-surface { margin-inline: auto; }
.shioriDocxViewer .docx-page { overflow: hidden; }
.shioriDocxViewer .docx-paginated-surface,
.shioriDocxViewer .docx-editor-one-surface {
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
}
`;

type DocxZoomPreviewSession = {
  anchorClientX: number;
  anchorClientY: number;
  anchorLocalX: number;
  anchorLocalY: number;
  baseZoom: number;
  contentX: number;
  contentY: number;
  layer: HTMLElement;
  layerLeft: number;
  layerTop: number;
  pageAnchor: ReturnType<typeof findDocxPageAnchor>;
  previousTransform: string;
  previousTransformOrigin: string;
  previousTransition: string;
  previousWillChange: string;
  settleFrame: number | null;
  settleObserver: ResizeObserver | null;
  settleTimer: number | null;
  /**
   * True once the zoom has been committed and the session is only waiting for
   * the Word engine's relayout. Such a session's captured geometry is stale:
   * a new gesture must finish it and snapshot afresh instead of reusing it —
   * reuse computed preview transforms against the old layout and made the
   * document jump around during quick successive pinches.
   */
  settling: boolean;
};

export type DocxViewerProps = {
  bytes: Uint8Array;
  /**
   * Identity of the document being shown. Changing it remounts the surface:
   * the renderer takes its bytes once at mount, so reusing the instance across
   * two different files would keep painting the first one.
   */
  documentId: string;
  initialScrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  fitToWidth?: boolean;
};

export function DocxViewer({
  bytes,
  documentId,
  initialScrollTop = 0,
  onScrollTopChange,
  zoom = 1,
  onZoomChange,
  fitToWidth = false,
}: DocxViewerProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const initialScrollTopRef = useRef(initialScrollTop);
  const zoomRef = useRef(zoom);
  const visualZoomRef = useRef(zoom);
  const onZoomChangeRef = useRef(onZoomChange);
  const previewSessionRef = useRef<DocxZoomPreviewSession | null>(null);
  const [manuallyZoomed, setManuallyZoomed] = useState(false);
  const [autoFitZoom, setAutoFitZoom] = useState<number | null>(null);
  const [readySequence, setReadySequence] = useState(0);
  const autoFitActive =
    fitToWidth &&
    Math.abs(zoom - 1) < 0.001 &&
    !manuallyZoomed;
  const effectiveZoom = autoFitActive && autoFitZoom !== null ? autoFitZoom : zoom;
  useLayoutEffect(() => {
    zoomRef.current = effectiveZoom;
    if (!previewSessionRef.current) visualZoomRef.current = effectiveZoom;
    onZoomChangeRef.current = onZoomChange;
  }, [effectiveZoom, onZoomChange]);

  useLayoutEffect(() => {
    if (!autoFitActive || readySequence === 0) return;
    const host = hostRef.current;
    if (!host) return;
    let geometry: DocxFitGeometry | null = null;
    let frame: number | null = null;
    let attempts = 0;
    const applyFit = () => {
      frame = null;
      geometry ??= measureDocxFitGeometry(host, zoomRef.current);
      if (!geometry) {
        attempts += 1;
        if (attempts < 20) frame = window.requestAnimationFrame(applyFit);
        return;
      }
      const scroller = docxScroller(host);
      if (!scroller) return;
      const nextZoom = fitDocxZoomForWidth(
        scroller.clientWidth,
        geometry.naturalPageWidth,
      );
      setAutoFitZoom((current) =>
        current !== null && Math.abs(current - nextZoom) < 0.001
          ? current
          : nextZoom,
      );
      window.requestAnimationFrame(() => {
        const currentScroller = docxScroller(hostRef.current);
        if (currentScroller) currentScroller.scrollLeft = 0;
      });
    };
    frame = window.requestAnimationFrame(applyFit);
    const scroller = docxScroller(host);
    const observer =
      scroller && typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (frame === null) frame = window.requestAnimationFrame(applyFit);
          })
        : null;
    if (scroller) observer?.observe(scroller);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [autoFitActive, readySequence]);

  const commitUserZoom = useCallback((nextZoom: number) => {
    setManuallyZoomed(true);
    setAutoFitZoom(null);
    onZoomChangeRef.current?.(nextZoom);
  }, []);

  const finishZoomPreview = useCallback(
    (session: DocxZoomPreviewSession, nextZoom: number) => {
      if (previewSessionRef.current !== session) return;
      previewSessionRef.current = null;
      if (session.settleFrame !== null) {
        window.cancelAnimationFrame(session.settleFrame);
        session.settleFrame = null;
      }
      if (session.settleTimer !== null) {
        window.clearTimeout(session.settleTimer);
        session.settleTimer = null;
      }
      session.settleObserver?.disconnect();
      session.settleObserver = null;

      session.layer.style.transform = session.previousTransform;
      session.layer.style.transformOrigin = session.previousTransformOrigin;
      session.layer.style.willChange = session.previousWillChange;
      // Transition starting is judged against the AFTER-change style: flush
      // the transform reset while the inline transition is still 'none', or
      // the scroll correction below measures tween-start rectangles.
      void session.layer.offsetWidth;
      session.layer.style.transition = session.previousTransition;

      const host = hostRef.current;
      const nextScroller = docxScroller(host);
      if (!host || !nextScroller) return;
      const ratio = nextZoom / session.baseZoom;
      const nextPage = session.pageAnchor
        ? Array.from(
            host.querySelectorAll<HTMLElement>(
              ".docx-page[data-page-index]",
            ),
          ).find(
            (page) =>
              page.dataset.pageIndex === session.pageAnchor?.pageIndex,
          )
        : undefined;
      if (session.pageAnchor && nextPage) {
        const nextPageRect = nextPage.getBoundingClientRect();
        nextScroller.scrollLeft +=
          nextPageRect.left +
          session.pageAnchor.x * ratio -
          session.anchorClientX;
        nextScroller.scrollTop +=
          nextPageRect.top +
          session.pageAnchor.y * ratio -
          session.anchorClientY;
        return;
      }
      const nextScrollerRect = nextScroller.getBoundingClientRect();
      nextScroller.scrollLeft =
        session.contentX * ratio -
        (session.anchorClientX - nextScrollerRect.left);
      nextScroller.scrollTop =
        session.contentY * ratio -
        (session.anchorClientY - nextScrollerRect.top);
    },
    [],
  );

  const beginZoomPreview = useCallback(
    (clientX: number, clientY: number): DocxZoomPreviewSession | null => {
      const existing = previewSessionRef.current;
      if (existing && !existing.settling) return existing;
      // A settling session has already committed its zoom and is only waiting
      // for the engine's relayout; its captured geometry no longer matches the
      // DOM. Hand it off now and snapshot the fresh layout for this gesture.
      if (existing) finishZoomPreview(existing, zoomRef.current);
      const host = hostRef.current;
      const scroller = docxScroller(host);
      const layer = docxZoomLayer(host);
      if (!host || !scroller || !layer) return null;

      const layerRect = layer.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const session: DocxZoomPreviewSession = {
        anchorClientX: clientX,
        anchorClientY: clientY,
        anchorLocalX: clientX - layerRect.left,
        anchorLocalY: clientY - layerRect.top,
        baseZoom: zoomRef.current,
        contentX: scroller.scrollLeft + clientX - scrollerRect.left,
        contentY: scroller.scrollTop + clientY - scrollerRect.top,
        layer,
        layerLeft: layerRect.left,
        layerTop: layerRect.top,
        pageAnchor: findDocxPageAnchor(host, clientX, clientY),
        previousTransform: layer.style.transform,
        previousTransformOrigin: layer.style.transformOrigin,
        previousTransition: layer.style.transition,
        previousWillChange: layer.style.willChange,
        settleFrame: null,
        settleObserver: null,
        settleTimer: null,
        settling: false,
      };
      // A stylesheet transition covering transform would tween every preview
      // frame and animate the restore — the settle probes and the final
      // scroll correction must measure real geometry, so the preview snaps.
      layer.style.transition = "none";
      layer.style.transformOrigin = "0 0";
      layer.style.willChange = "transform";
      previewSessionRef.current = session;
      visualZoomRef.current = session.baseZoom;
      return session;
    },
    [finishZoomPreview],
  );

  // Each event applies its preview transform synchronously: a transform write
  // is cheap, and WebKit can pause requestAnimationFrame callbacks for the
  // whole duration of a native trackpad pinch — an rAF-deferred preview sat
  // frozen until the fingers lifted and the zoom landed as one jump.
  const zoomAtClientPoint = useCallback(
    (clientX: number, clientY: number, targetZoom: number) => {
      const session = beginZoomPreview(clientX, clientY);
      if (!session) return;
      const nextZoom = clampDocxZoom(targetZoom);
      visualZoomRef.current = nextZoom;
      setLiveZoomIndicator(nextZoom);
      session.anchorClientX = clientX;
      session.anchorClientY = clientY;
      const ratio = nextZoom / session.baseZoom;
      const translateX =
        clientX - session.layerLeft - session.anchorLocalX * ratio;
      const translateY =
        clientY - session.layerTop - session.anchorLocalY * ratio;
      session.layer.style.transform =
        `translate3d(${translateX}px, ${translateY}px, 0) scale(${ratio})`;
    },
    [beginZoomPreview],
  );

  const commitZoomPreview = useCallback(() => {
    const session = previewSessionRef.current;
    if (!session) return;
    // Already committed; the settle observer / poll / timeout below own the
    // hand-off. Re-committing would re-run the scroll correction with stale
    // anchors and double-shift the document.
    if (session.settling) return;
    setLiveZoomIndicator(null);

    const nextZoom = Number(clampDocxZoom(visualZoomRef.current).toFixed(3));
    const setZoom = onZoomChangeRef.current ? commitUserZoom : undefined;
    const restorePreviewLayer = () => {
      session.layer.style.transform = session.previousTransform;
      session.layer.style.transformOrigin = session.previousTransformOrigin;
      session.layer.style.willChange = session.previousWillChange;
      void session.layer.offsetWidth;
      session.layer.style.transition = session.previousTransition;
    };
    if (
      !setZoom ||
      !hostRef.current ||
      Math.abs(nextZoom - session.baseZoom) < 0.001
    ) {
      previewSessionRef.current = null;
      restorePreviewLayer();
      visualZoomRef.current = zoomRef.current;
      return;
    }

    // Same re-anchoring as the PDF canvas: the preview's fixed point followed
    // the fingers, so the session-start anchor no longer describes what the
    // reader sees under them. Measure against the base layout (preview
    // transform off for a pre-paint instant — the layoutHasCaughtUp trick) so
    // the commit continues exactly where the preview's final frame left off.
    const hostEl = hostRef.current;
    const previewTransformAtCommit = session.layer.style.transform;
    session.layer.style.transform = session.previousTransform;
    const finalAnchor = findDocxPageAnchor(
      hostEl,
      session.anchorClientX,
      session.anchorClientY,
    );
    const scrollerAtCommit = docxScroller(hostEl);
    if (scrollerAtCommit) {
      const commitRect = scrollerAtCommit.getBoundingClientRect();
      session.contentX =
        scrollerAtCommit.scrollLeft + session.anchorClientX - commitRect.left;
      session.contentY =
        scrollerAtCommit.scrollTop + session.anchorClientY - commitRect.top;
    }
    session.layer.style.transform = previewTransformAtCommit;
    if (finalAnchor) session.pageAnchor = finalAnchor;

    // The compositor preview above never asks the Word engine to re-layout.
    // Commit exactly once when the gesture settles. The engine applies its
    // measured relayout after this prop commit, so keep the compositor frame
    // alive until page geometry actually changes. Removing it here exposed a
    // stale-layout frame and then the engine's new one — the visible end snap.
    session.settling = true;
    flushSync(() => setZoom(nextZoom));
    zoomRef.current = nextZoom;
    visualZoomRef.current = nextZoom;

    const layoutHasCaughtUp = () => {
      const anchor = session.pageAnchor;
      const host = hostRef.current;
      if (!anchor || !host) return false;
      const page = Array.from(
        host.querySelectorAll<HTMLElement>(".docx-page[data-page-index]"),
      ).find((candidate) => candidate.dataset.pageIndex === anchor.pageIndex);
      if (!page) return false;

      // getBoundingClientRect includes the compositor transform. Temporarily
      // remove it to inspect the Word engine's natural post-layout page size;
      // this runs in rAF / ResizeObserver before paint, so no identity frame is
      // exposed to the reader.
      const previewTransform = session.layer.style.transform;
      session.layer.style.transform = session.previousTransform;
      const natural = page.getBoundingClientRect();
      session.layer.style.transform = previewTransform;
      const expectedDelta = Math.max(
        Math.abs(anchor.width * (nextZoom / session.baseZoom - 1)),
        Math.abs(anchor.height * (nextZoom / session.baseZoom - 1)),
      );
      const actualDelta = Math.max(
        Math.abs(natural.width - anchor.width),
        Math.abs(natural.height - anchor.height),
      );
      return actualDelta >= Math.max(0.5, expectedDelta * 0.5);
    };
    const tryFinish = () => {
      if (previewSessionRef.current !== session) return;
      if (layoutHasCaughtUp()) finishZoomPreview(session, nextZoom);
    };
    if (typeof ResizeObserver === "function") {
      session.settleObserver = new ResizeObserver(tryFinish);
      session.settleObserver.observe(session.layer);
    }
    const poll = () => {
      session.settleFrame = null;
      if (previewSessionRef.current !== session) return;
      if (layoutHasCaughtUp()) {
        finishZoomPreview(session, nextZoom);
        return;
      }
      session.settleFrame = window.requestAnimationFrame(poll);
    };
    session.settleFrame = window.requestAnimationFrame(poll);
    // A malformed renderer surface must not leave the document permanently
    // transformed. Normal layouts finish in the next frame; this is only the
    // fail-safe for a renderer that never publishes new geometry.
    session.settleTimer = window.setTimeout(
      () => finishZoomPreview(session, nextZoom),
      320,
    );
  }, [commitUserZoom, finishZoomPreview]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !onZoomChangeRef.current) return;
    const isInsideDocument = (event: Event) => {
      const scroller = docxScroller(hostRef.current);
      return scroller ? eventTargetsElement(event, scroller) : false;
    };
    const documentPoint = (event: Event) => {
      const point = eventClientPoint(event);
      if (point) return point;
      const rect = docxScroller(hostRef.current)?.getBoundingClientRect();
      return rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : null;
    };
    const stream = createZoomGestureStream(
      {
        preview: (point, scale) => zoomAtClientPoint(point.x, point.y, scale),
        commit: commitZoomPreview,
        cancel: () => {
          const session = previewSessionRef.current;
          if (session) {
            if (session.settleFrame !== null) {
              window.cancelAnimationFrame(session.settleFrame);
            }
            if (session.settleTimer !== null) {
              window.clearTimeout(session.settleTimer);
            }
            session.settleObserver?.disconnect();
            session.layer.style.transform = session.previousTransform;
            session.layer.style.transformOrigin = session.previousTransformOrigin;
            session.layer.style.willChange = session.previousWillChange;
            void session.layer.offsetWidth;
            session.layer.style.transition = session.previousTransition;
            previewSessionRef.current = null;
          }
          setLiveZoomIndicator(null);
        },
        visualScale: () => visualZoomRef.current,
        // Open the session first: a settling one gets handed off there, and
        // the gesture's ratios must apply to the fresh session's base.
        openGesture: (point) => {
          if (point) beginZoomPreview(point.x, point.y);
          return visualZoomRef.current;
        },
        restingScale: () => visualZoomRef.current,
        isBusy: () => previewSessionRef.current !== null,
        doubleTap: () => undefined,
        clock: systemClock,
      },
      { pinchWatchdogMs: null, doubleTap: false },
    );
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      const factor = Math.exp(clamp(-event.deltaY, -40, 40) * 0.005);
      const consumed = stream.handle({
        type: "wheel",
        factor,
        point: { x: event.clientX, y: event.clientY },
        inside: isInsideDocument(event),
      });
      if (consumed) event.preventDefault();
    };
    const onGestureStart = (event: Event) => {
      const consumed = stream.handle({
        type: "gestureStart",
        point: documentPoint(event),
        inside: isInsideDocument(event),
      });
      if (consumed) event.preventDefault();
    };
    const onGestureChange = (event: Event) => {
      const point = documentPoint(event);
      if (!point) return;
      const consumed = stream.handle({
        type: "gestureChange",
        scale: gestureScale(event),
        point,
        inside: isInsideDocument(event),
      });
      if (consumed) event.preventDefault();
    };
    const onGestureEnd = (event: Event) => {
      const consumed = stream.handle({
        type: "gestureEnd",
        inside: isInsideDocument(event),
      });
      if (consumed) event.preventDefault();
    };

    // Android and every other non-Apple touch browser: see attachTouchPinch
    // for why the finger list comes from Touch Events. A stranded Pointer
    // Events finger made each one-finger swipe here zoom the Word document
    // a little further until its text was unreadable.
    const supportsAppleGesture = "GestureEvent" in window;
    const detachTouchPinch = supportsAppleGesture
      ? () => undefined
      : attachTouchPinch(window, {
          accepts: (target) => {
            const scroller = docxScroller(hostRef.current);
            return Boolean(scroller && containsEventTarget(scroller, target));
          },
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

    const options: AddEventListenerOptions = { capture: true, passive: false };
    const removeOptions: EventListenerOptions = { capture: true };
    host.addEventListener("wheel", onWheel, options);
    host.addEventListener("gesturestart", onGestureStart, options);
    host.addEventListener("gesturechange", onGestureChange, options);
    host.addEventListener("gestureend", onGestureEnd, options);
    return () => {
      host.removeEventListener("wheel", onWheel, removeOptions);
      host.removeEventListener("gesturestart", onGestureStart, removeOptions);
      host.removeEventListener("gesturechange", onGestureChange, removeOptions);
      host.removeEventListener("gestureend", onGestureEnd, removeOptions);
      detachTouchPinch();
      stream.dispose();
    };
  }, [beginZoomPreview, commitZoomPreview, zoomAtClientPoint]);
  const restoreScroll = () => {
    setReadySequence((current) => current + 1);
    window.requestAnimationFrame(() => {
      const scroller = hostRef.current?.querySelector<HTMLElement>(
        ".shioriDocxViewer__surface",
      );
      if (scroller) scroller.scrollTop = initialScrollTopRef.current;
    });
  };
  const rememberScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.classList.contains("shioriDocxViewer__surface")
    ) {
      onScrollTopChange?.(target.scrollTop);
    }
  };

  return (
    <div
      ref={hostRef}
      className="shioriDocxViewer"
      style={{
        flex: "1 1 0",
        width: "100%",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
      aria-label={t("docx.viewerLabel")}
      onScrollCapture={rememberScroll}
    >
      <style>{CENTRE_THE_PAGE}</style>
      <DocumentControlBar
        trailing={
          <ZoomControls
            scale={effectiveZoom}
            setScale={commitUserZoom}
            zoomOutLabel={t("tooltips.zoomOut")}
            zoomInLabel={t("tooltips.zoomIn")}
            zoomLevelLabel={t("tooltips.zoomLevel")}
            minimumScale={DOCX_MIN_ZOOM}
          />
        }
      />
      <DocxViewerErrorBoundary
        fallback={
          <DocxLoadFailure
            message={t("docx.loadFailed")}
            retryLabel={t("docx.retry")}
          />
        }
      >
        <Suspense fallback={<LoadingBlock />}>
          {/*
            `chrome={false}` drops the renderer's own title bar, menu bar, toolbar
            and ruler. Shiori already supplies all of those, and stacking a second
            set inside the viewport reads as two applications in one window.
          */}
          <DocxSurface
            key={documentId}
            document={bytes}
            mode="view"
            zoom={effectiveZoom}
            chrome={false}
            className="shioriDocxViewer__surface"
            onReady={restoreScroll}
          />
        </Suspense>
      </DocxViewerErrorBoundary>
    </div>
  );
}

function docxScroller(host: HTMLElement | null): HTMLElement | null {
  return (
    host?.querySelector<HTMLElement>(".shioriDocxViewer__surface") ?? null
  );
}

function docxZoomLayer(host: HTMLElement | null): HTMLElement | null {
  return (
    host?.querySelector<HTMLElement>(
      ".docx-paginated-surface .docx-pages, .docx-pages",
    ) ?? null
  );
}

function findDocxPageAnchor(
  host: HTMLElement,
  clientX: number,
  clientY: number,
): {
  pageIndex: string;
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  const pages = Array.from(
    host.querySelectorAll<HTMLElement>(".docx-page[data-page-index]"),
  );
  let nearest: { page: HTMLElement; rect: DOMRect; distance: number } | null =
    null;
  for (const page of pages) {
    const rect = page.getBoundingClientRect();
    const dx =
      clientX < rect.left
        ? rect.left - clientX
        : clientX > rect.right
          ? clientX - rect.right
          : 0;
    const dy =
      clientY < rect.top
        ? rect.top - clientY
        : clientY > rect.bottom
          ? clientY - rect.bottom
          : 0;
    const distance = Math.hypot(dx, dy);
    if (!nearest || distance < nearest.distance) {
      nearest = { page, rect, distance };
    }
  }
  const pageIndex = nearest?.page.dataset.pageIndex;
  return nearest && pageIndex !== undefined
    ? {
        pageIndex,
        x: clientX - nearest.rect.left,
        y: clientY - nearest.rect.top,
        width: nearest.rect.width,
        height: nearest.rect.height,
      }
    : null;
}

function eventTargetsElement(event: Event, element: HTMLElement): boolean {
  const target = event.target;
  const NodeType = element.ownerDocument.defaultView?.Node;
  if (NodeType && target instanceof NodeType && element.contains(target)) {
    return true;
  }
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

function gestureScale(event: Event): number | null {
  const scale = (event as Event & { scale?: unknown }).scale;
  return typeof scale === "number" && Number.isFinite(scale) ? scale : null;
}

function clampDocxZoom(zoom: number): number {
  return clamp(zoom, DOCX_MIN_ZOOM, DOCX_MAX_ZOOM);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export class DocxViewerErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("DOCX renderer failed", error, info.componentStack);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function DocxLoadFailure({
  message,
  retryLabel,
}: {
  message: string;
  retryLabel: string;
}) {
  return (
    <div
      role="alert"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 24,
        color: T.ink2,
        textAlign: "center",
        font: `500 13px/1.5 ${T.sans}`,
      }}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          height: 30,
          padding: "0 12px",
          border: `1px solid ${T.rule}`,
          borderRadius: 6,
          background: T.surface,
          color: T.ink,
          cursor: "pointer",
          font: `600 12px/1 ${T.sans}`,
        }}
      >
        {retryLabel}
      </button>
    </div>
  );
}
