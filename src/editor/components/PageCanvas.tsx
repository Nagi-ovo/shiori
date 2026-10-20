import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import type { PdfDocument as PDFDocumentProxy } from "../../pdf/engine/types";
import { releaseCanvasBackingStore } from "../../pdf/render/canvasMemory";
import {
  getPagePreview,
  storePagePreview,
} from "../../pdf/render/pagePreviewCache";
import type { Rotation } from "../../pdf/model/types";
import { appPdfEngine } from "../../pdf/engine/appEngine";
import { MAX_CANVAS_PIXELS } from "../../pdf/openPolicy";
import {
  TILED_BACKDROP_MAX_PIXELS,
  measureVisibleOnScreen,
  pageNeedsTiles,
  renderPageBackdrop,
} from "../../pdf/render/tiles";
import { PageTiles, type PageTilesRuntime } from "./PageTiles";
import { buildTimestamp } from "../../runtime/expiry";
import { zoomDebugTap } from "./zoomDebugTap";
import { appVersion } from "../../runtime/version";
import { DiagOverlay } from "./DiagOverlay";
import {
  appendLocalStorage,
  buildCaps,
  renderDiagnosticsEnabled,
  type DiagPayload,
} from "./pageCanvasDiagnostics";

type PageCanvasRuntime = PageTilesRuntime & {
  releaseCanvasBackingStore: typeof releaseCanvasBackingStore;
  getPagePreview: typeof getPagePreview;
  storePagePreview: typeof storePagePreview;
};

const DEFAULT_RUNTIME: PageCanvasRuntime = {
  releaseCanvasBackingStore,
  renderRegion: appPdfEngine.renderRegion,
  measureVisible: measureVisibleOnScreen,
  getPagePreview,
  storePagePreview,
};

type Props = {
  doc: PDFDocumentProxy;
  sourceIndex: number; // 0-based index into the original PDF
  rotation: Rotation;
  scale: number;
  /** The page's displayed size at scale 1, rotation applied, in points. */
  widthPt: number;
  heightPt: number;
  paperColor: string | null;
  runtime?: PageCanvasRuntime;
};

// How long the scale must hold still before a sharp re-raster starts, once
// the scale is arriving as a stream (a window resize re-fitting the page on
// every frame): rastering mid-stream would start dozens of renders only to
// cancel them. A lone change — a pinch or wheel commit, a toolbar step, a
// keyboard zoom — rasters at once; waiting the settle for those too was
// 160 ms of needless blur on every release. Two changes closer together
// than the settle are a stream.
const RASTER_SETTLE_MS = 160;

// What the currently displayed bitmap depicts. The bitmap stays on screen,
// stretched to the live scale, until a replacement for the same page is
// ready — swapping only then is what removes the theme-colored blank that
// used to show while the engine re-rendered into the visible canvas.
type RenderedSurface = {
  doc: PDFDocumentProxy;
  sourceIndex: number;
  rotation: Rotation;
  scale: number;
};

// Dev-only render diagnostics: the first render failure in a session shows a
// red overlay; subsequent failures only append to localStorage to keep the
// screen usable. Release builds still log diagnostics but never expose this
// engineer-facing UI to end users.
let overlayActive = false;
let overlayDismissed = false;

function PageCanvasImpl({
  doc,
  sourceIndex,
  rotation,
  scale,
  widthPt,
  heightPt,
  paperColor,
  runtime = DEFAULT_RUNTIME,
}: Props) {
  // Double buffer: the front canvas shows the last completed raster
  // (stretched by CSS while the scale moves); the back canvas is where the
  // next raster lands. They swap roles on completion, in one React commit,
  // so there is never a frame showing a cleared canvas.
  const canvasARef = useRef<HTMLCanvasElement | null>(null);
  const canvasBRef = useRef<HTMLCanvasElement | null>(null);
  const [front, setFront] = useState<"a" | "b">("a");
  const { t } = useTranslation();
  const [diag, setDiag] = useState<DiagPayload | null>(null);
  const [rendered, setRendered] = useState<RenderedSurface | null>(null);

  // The old bitmap is only a valid stand-in while it depicts the same page
  // face; across a page/rotation/document change it would show the wrong
  // content, so those raster immediately with the front hidden (the
  // pre-double-buffer behavior).
  const sameSurface =
    rendered !== null &&
    rendered.doc === doc &&
    rendered.sourceIndex === sourceIndex &&
    rendered.rotation === rotation;

  // Past the backdrop budget the full-page raster stays a small backdrop and
  // tiles carry the sharpness (src/pdf/render/tiles.ts says why).
  const tiling = pageNeedsTiles(
    widthPt,
    heightPt,
    scale,
    window.devicePixelRatio || 1,
  );

  const lastScaleChangeAtRef = useRef(0);
  useEffect(() => {
    if (sameSurface && rendered.scale === scale) return;
    let cancelled = false;
    let handle: { cancel: () => void; done: Promise<void> } | null = null;
    let settleTimer: number | null = null;
    let viewport: { width: number; height: number } = { width: 0, height: 0 };
    const back = front === "a" ? "b" : "a";
    const backRef = back === "a" ? canvasARef : canvasBRef;

    const maybeShow = (payload: DiagPayload) => {
      appendLocalStorage(payload);
      if (cancelled || buildTimestamp !== 0) return;
      if (overlayActive || overlayDismissed) return;
      overlayActive = true;
      setDiag(payload);
    };

    const run = () => (async () => {
      const canvas = backRef.current;
      if (!canvas) return;
      viewport = { width: widthPt * scale, height: heightPt * scale };
      zoomDebugTap("rasterStart", { page: sourceIndex, scale });
      handle = renderPageBackdrop(
        runtime.renderRegion,
        doc,
        {
          sourceIndex,
          rotation,
          scale,
          widthPt,
          heightPt,
          dpr: window.devicePixelRatio || 1,
          maxPixels: tiling ? TILED_BACKDROP_MAX_PIXELS : MAX_CANVAS_PIXELS,
        },
        canvas,
      );
      await handle.done;
      if (cancelled) return;
      // One commit: the fresh bitmap becomes the front, the stale one
      // hides. `rendered` moving to the new scale drops the CSS stretch
      // in the same commit.
      setFront(back);
      setRendered({ doc, sourceIndex, rotation, scale });
      zoomDebugTap("rasterDone", {
        page: sourceIndex,
        scale,
        w: canvas.width,
        h: canvas.height,
        dpr: window.devicePixelRatio || 1,
      });
      if (!renderDiagnosticsEnabled()) return;
      const ctx = canvas.getContext("2d");
      if (!ctx || canvas.width === 0 || canvas.height === 0) return;
      const w = canvas.width;
      const h = canvas.height;
      // 7x7 grid across the inner 80% of the canvas. A genuinely rendered
      // content page has plenty of ink and will almost always show some
      // non-white among 49 samples; a never-painted canvas (our failure
      // signature) is uniformly (255,255,255,255). Accept only the strict
      // case — any non-white pixel anywhere and we treat the render as OK.
      const GRID = 7;
      const pts: Array<[number, number]> = [];
      for (let iy = 0; iy < GRID; iy += 1) {
        for (let ix = 0; ix < GRID; ix += 1) {
          const fx = 0.1 + (0.8 * ix) / (GRID - 1);
          const fy = 0.1 + (0.8 * iy) / (GRID - 1);
          pts.push([w * fx, h * fy]);
        }
      }
      try {
        const colors = pts.map(([x, y]) => {
          const d = ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
          return `${d[0]},${d[1]},${d[2]},${d[3]}`;
        });
        const stage1AllWhite = colors.every((c) => c === "255,255,255,255");
        if (stage1AllWhite) {
          // Stage 1 (49 inner-80% points) sees only white. That's a
          // suspect signal, not a verdict — a page that's mostly
          // whitespace can pass stage 1 entirely on background. Run a
          // denser deterministic scan over the inner 80% before
          // emitting "blank": one big getImageData call, then stride
          // through the byte buffer. Bail on the first non-white
          // pixel found.
          const innerX = Math.floor(w * 0.1);
          const innerY = Math.floor(h * 0.1);
          const innerW = Math.max(1, Math.floor(w * 0.8));
          const innerH = Math.max(1, Math.floor(h * 0.8));
          const region = ctx.getImageData(innerX, innerY, innerW, innerH);
          const px = region.data;
          // Stride 16 = sample every 16th pixel; on a 2280×3226 canvas
          // that's ~37k samples — orders of magnitude denser than 49,
          // and finishes in single-digit ms.
          const STRIDE = 16;
          let checkedPixels = 0;
          let nonWhiteSamples = 0;
          for (let i = 0; i < px.length; i += 4 * STRIDE) {
            checkedPixels += 1;
            if (
              px[i] !== 255 ||
              px[i + 1] !== 255 ||
              px[i + 2] !== 255 ||
              px[i + 3] !== 255
            ) {
              nonWhiteSamples += 1;
              break;
            }
          }
          if (nonWhiteSamples === 0) {
            maybeShow({
              when: new Date().toISOString(),
              phase: "render-succeeded-but-blank",
              err: null,
              ua: navigator.userAgent,
              engine: appPdfEngine.label,
              appVersion,
              pageIndex: sourceIndex,
              canvas: { w: canvas.width, h: canvas.height },
              viewport: { w: viewport.width, h: viewport.height },
              dpr: window.devicePixelRatio || 1,
              caps: buildCaps(),
              loc: location.href,
              samplePixels: [`${colors.length} pts all 255,255,255,255`],
              checkedPixels,
              nonWhiteSamples,
            });
          }
        }
      } catch {
        // getImageData can throw on tainted canvas or OOM — ignore.
      }
    })().catch((err: unknown) => {
      if (cancelled) return;
      const e = err as { name?: string; message?: string; stack?: string };
      const canvas = backRef.current;
      maybeShow({
        when: new Date().toISOString(),
        phase: "render-rejected",
        err: {
          name: e?.name,
          message: e?.message,
          stack: e?.stack?.slice(0, 1000),
        },
        ua: navigator.userAgent,
        engine: appPdfEngine.label,
        appVersion,
        pageIndex: sourceIndex,
        canvas: { w: canvas?.width ?? 0, h: canvas?.height ?? 0 },
        viewport: { w: viewport.width, h: viewport.height },
        dpr: window.devicePixelRatio || 1,
        caps: buildCaps(),
        loc: location.href,
      });
    });

    // A bare scale change means a usable bitmap is already on screen; wait
    // for the stream (wheel, pinch, sidebar-drag refit) to settle instead
    // of rastering per tick. A new page face has nothing to show — raster
    // immediately.
    if (sameSurface) {
      const now = performance.now();
      const streaming = now - lastScaleChangeAtRef.current < RASTER_SETTLE_MS;
      lastScaleChangeAtRef.current = now;
      // Even a lone change waits one macrotask: the commit that brought the
      // new scale should paint before the raster starts competing for the
      // main thread.
      settleTimer = window.setTimeout(run, streaming ? RASTER_SETTLE_MS : 0);
    } else {
      run();
    }
    return () => {
      cancelled = true;
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      handle?.cancel();
    };
    // `rendered`/`sameSurface` are deliberately not dependencies: the effect
    // reads them only to decide immediate-vs-settled, and the completion
    // setState re-satisfies the guard at the top on the follow-up run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, sourceIndex, rotation, scale, widthPt, heightPt, tiling, front, runtime]);

  // Free the hidden canvas after a swap: its bitmap was just replaced, and
  // keeping it allocated would double per-page canvas memory at high zoom.
  // The next raster resizes it anyway before drawing.
  useEffect(() => {
    const hidden = front === "a" ? canvasBRef.current : canvasARef.current;
    runtime.releaseCanvasBackingStore(hidden);
  }, [front, runtime]);

  // WebKit can keep a removed canvas' graphics allocation until a later GC.
  // Tab suspension and Virtuoso page recycling need deterministic release:
  // both double buffers are large at Retina scale, and the visible one is not
  // covered by the hidden-buffer cleanup above when the component unmounts.
  useEffect(() => {
    // Capture the nodes now: React clears object refs before passive-effect
    // cleanup runs, so reading ref.current inside the returned callback is too
    // late and silently turns this release into a no-op.
    const canvasA = canvasARef.current;
    const canvasB = canvasBRef.current;
    return () => {
      runtime.releaseCanvasBackingStore(canvasA);
      runtime.releaseCanvasBackingStore(canvasB);
    };
  }, [runtime]);

  // Cache from the completed FRONT surface in a separate lifecycle. The
  // render effect swaps `front`, which necessarily cleans that effect up
  // before an idle callback can run; keeping the encoder there meant the
  // preview cache was permanently empty. This effect is keyed to the committed
  // surface and cancels only if that exact surface stops being current.
  useEffect(() => {
    if (!rendered) return;
    const canvas =
      front === "a" ? canvasARef.current : canvasBRef.current;
    if (!canvas) return;
    let cancelled = false;
    let idleId: number | null = null;
    let timerId: number | null = null;
    const remember = () => {
      if (cancelled) return;
      runtime.storePagePreview(
        rendered.doc,
        rendered.sourceIndex,
        rendered.rotation,
        canvas,
      );
    };
    if (typeof requestIdleCallback === "function") {
      idleId = requestIdleCallback(remember);
    } else {
      timerId = window.setTimeout(remember, 200);
    }
    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      if (idleId !== null && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(idleId);
      }
    };
  }, [front, rendered, runtime]);

  const transformScale =
    sameSurface && rendered.scale !== scale ? scale / rendered.scale : 1;

  const canvasStyle = (visible: boolean): CSSProperties => ({
    display: "block",
    position: "absolute",
    left: 0,
    top: 0,
    visibility: visible ? "visible" : "hidden",
    transform:
      visible && transformScale !== 1
        ? `scale(${transformScale})`
        : undefined,
    transformOrigin: "top left",
  });

  // While there is no sharp bitmap for this page face, show the last one we
  // kept, stretched. It is this page — blurry, but this page — so a fast
  // scroll reads as "sharpening" instead of "blank sheet, then content".
  // Only a page that has been rendered before has one; the very first visit
  // still falls back to the paper the page box paints.
  const preview = sameSurface
    ? null
    : runtime.getPagePreview(doc, sourceIndex, rotation);

  return (
    <>
      {preview ? (
        <img
          src={preview}
          alt=""
          aria-hidden
          draggable={false}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            display: "block",
            pointerEvents: "none",
            mixBlendMode: paperColor ? "multiply" : undefined,
          }}
        />
      ) : null}
      {/* The raster and its tiles tint as one group: multiplying each
          canvas separately would darken ink twice where a tile covers the
          backdrop. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          mixBlendMode: paperColor ? "multiply" : undefined,
        }}
      >
        <canvas
          ref={canvasARef}
          className="shioriPageCanvas"
          style={canvasStyle(front === "a" && sameSurface)}
        />
        <canvas
          ref={canvasBRef}
          className="shioriPageCanvas"
          style={canvasStyle(front === "b" && sameSurface)}
        />
        <PageTiles
          doc={doc}
          sourceIndex={sourceIndex}
          rotation={rotation}
          scale={scale}
          widthPt={widthPt}
          heightPt={heightPt}
          tiling={tiling}
          backdropSharp={sameSurface && rendered.scale === scale}
          runtime={runtime}
        />
      </div>
      {diag ? (
        <DiagOverlay
            diag={diag}
            dialogLabel={t("diagnostics.dialogLabel")}
            closeLabel={t("common.close")}
            onClose={() => {
            overlayDismissed = true;
            overlayActive = false;
            setDiag(null);
          }}
        />
      ) : null}
    </>
  );
}

// Memoized: a page's raster depends only on doc/sourceIndex/rotation/scale, none
// of which change when the active page or an overlay on another page does. The
// parent re-runs itemContent for every overscanned page on those churny updates;
// memo lets this heavy canvas skip them and re-render only when its own inputs
// actually change.
export const PageCanvas = memo(PageCanvasImpl);
