import { useEffect, useRef } from "react";
import type { PdfDocument, PdfEngine } from "../../pdf/engine/types";
import type { Rotation } from "../../pdf/model/types";
import {
  pageDeviceSize,
  tilesToRender,
  type DeviceRect,
  type TileCell,
} from "../../pdf/render/tiles";
import { zoomDebugTap } from "./zoomDebugTap";

export type PageTilesRuntime = {
  renderRegion: PdfEngine["renderRegion"];
  releaseCanvasBackingStore: (canvas: HTMLCanvasElement | null) => void;
  /** The part of `host` on screen, in device pixels of its layout box. */
  measureVisible: (host: HTMLElement, dpr: number) => DeviceRect | null;
};

type Tile = {
  cell: TileCell;
  canvas: HTMLCanvasElement;
  cancel: () => void;
  ready: boolean;
};

/** One scale's tiles, in their own positioned box. */
type Layer = {
  doc: PdfDocument;
  sourceIndex: number;
  rotation: Rotation;
  scale: number;
  dpr: number;
  el: HTMLDivElement;
  tiles: Map<string, Tile>;
};

type Props = {
  doc: PdfDocument;
  sourceIndex: number;
  rotation: Rotation;
  scale: number;
  /** The page's displayed size at scale 1, rotation applied, in points. */
  widthPt: number;
  heightPt: number;
  /** Whether this scale is past the whole-page budget and needs tiles. */
  tiling: boolean;
  /** The full-page raster under the tiles is sharp at `scale`. */
  backdropSharp: boolean;
  runtime: PageTilesRuntime;
};

// Same reasoning as PageCanvas's RASTER_SETTLE_MS: a lone scale change tiles
// at once, a stream of them (a window resize refitting every frame) waits for
// the stream to settle instead of starting and cancelling a grid per frame.
const TILE_SETTLE_MS = 160;

/**
 * Sharp tiles over the part of a page the reader can see, for scales whose
 * whole-page bitmap would exceed the backdrop budget. Kept out of React state:
 * tiles come and go on every scroll, and each is one canvas. Tiles are opaque
 * and blend normally over the backdrop; the paper tint multiplies the pair as
 * one group (PageCanvas), so tinted text is not darkened twice.
 *
 * A scale change keeps the previous scale's finished tiles on screen,
 * stretched, until the new scale's visible tiles are all drawn — the tile
 * version of PageCanvas's double buffer.
 */
export function PageTiles({
  doc,
  sourceIndex,
  rotation,
  scale,
  widthPt,
  heightPt,
  tiling,
  backdropSharp,
  runtime,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef<Layer | null>(null);
  const staleRef = useRef<Layer | null>(null);
  const lastScaleChangeAtRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const releaseTile = (layer: Layer, tile: Tile) => {
      tile.cancel();
      if (!tile.ready) {
        zoomDebugTap("tileCancel", {
          page: layer.sourceIndex,
          scale: layer.scale,
          key: tile.cell.key,
        });
      }
      runtime.releaseCanvasBackingStore(tile.canvas);
      tile.canvas.remove();
    };
    const releaseLayer = (layer: Layer | null) => {
      if (!layer) return;
      for (const tile of layer.tiles.values()) releaseTile(layer, tile);
      layer.tiles.clear();
      layer.el.remove();
    };
    const releaseStale = () => {
      releaseLayer(staleRef.current);
      staleRef.current = null;
    };

    const sameFace = (layer: Layer | null) =>
      layer !== null &&
      layer.doc === doc &&
      layer.sourceIndex === sourceIndex &&
      layer.rotation === rotation;

    // A different page face: nothing old is a valid stand-in.
    if (!sameFace(currentRef.current)) {
      releaseLayer(currentRef.current);
      currentRef.current = null;
    }
    if (!sameFace(staleRef.current)) releaseStale();

    // A new scale: what is finished at the old one stays, stretched, until
    // the new one covers the screen; what is still rendering is dropped.
    const previous = currentRef.current;
    const scaleChanged = previous !== null && previous.scale !== scale;
    if (scaleChanged) {
      releaseStale();
      for (const [key, tile] of previous.tiles) {
        if (tile.ready) continue;
        releaseTile(previous, tile);
        previous.tiles.delete(key);
      }
      staleRef.current = previous;
      currentRef.current = null;
    }
    const stale = staleRef.current;
    if (stale) {
      stale.el.style.transform = `scale(${scale / stale.scale})`;
    }

    if (!tiling) {
      // Leaving tiled scales: the stretched tiles stay until the full-page
      // raster at the new scale lands, then go.
      releaseLayer(currentRef.current);
      currentRef.current = null;
      if (backdropSharp) releaseStale();
      return;
    }

    if (!currentRef.current) {
      const el = document.createElement("div");
      el.style.cssText =
        "position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:0 0;";
      host.appendChild(el);
      currentRef.current = {
        doc,
        sourceIndex,
        rotation,
        scale,
        dpr: window.devicePixelRatio || 1,
        el,
        tiles: new Map(),
      };
    }
    const layer = currentRef.current;
    const pagePx = pageDeviceSize(widthPt, heightPt, scale, layer.dpr);

    const visibleCovered = () => {
      const visible = runtime.measureVisible(host, layer.dpr);
      if (!visible) return true;
      return tilesToRender({ page: pagePx, visible, ring: 0 }).every(
        (cell) => layer.tiles.get(cell.key)?.ready,
      );
    };

    const sync = () => {
      const visible = runtime.measureVisible(host, layer.dpr);
      const wanted = visible
        ? tilesToRender({ page: pagePx, visible })
        : [];
      const wantedKeys = new Set(wanted.map((cell) => cell.key));
      for (const [key, tile] of layer.tiles) {
        if (wantedKeys.has(key)) continue;
        releaseTile(layer, tile);
        layer.tiles.delete(key);
      }
      for (const cell of wanted) {
        if (layer.tiles.has(cell.key)) continue;
        const canvas = document.createElement("canvas");
        canvas.className = "shioriPageTile";
        canvas.style.position = "absolute";
        canvas.style.left = `${cell.x / layer.dpr}px`;
        canvas.style.top = `${cell.y / layer.dpr}px`;
        const tile: Tile = { cell, canvas, cancel: () => {}, ready: false };
        layer.tiles.set(cell.key, tile);
        let cancelled = false;
        const handle = runtime.renderRegion(
          doc,
          {
            sourceIndex,
            rotation,
            scale,
            dpr: layer.dpr,
            region: cell,
            priority: "visible",
          },
          canvas,
        );
        tile.cancel = () => {
          cancelled = true;
          handle.cancel();
        };
        handle.done.then(
          () => {
            if (cancelled) return;
            tile.ready = true;
            // Attach only once drawn, so a tile never shows as a blank square.
            layer.el.appendChild(canvas);
            zoomDebugTap("tileDone", {
              page: sourceIndex,
              scale,
              key: cell.key,
              w: canvas.width,
              h: canvas.height,
            });
            if (staleRef.current && visibleCovered()) releaseStale();
          },
          (error: unknown) => {
            if (cancelled) return;
            console.warn("Failed to render a page tile", error);
            runtime.releaseCanvasBackingStore(canvas);
            layer.tiles.delete(cell.key);
          },
        );
      }
    };

    let frame: number | null = null;
    const onViewportChange = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        sync();
      });
    };

    const now = performance.now();
    const streaming =
      scaleChanged && now - lastScaleChangeAtRef.current < TILE_SETTLE_MS;
    if (scaleChanged) lastScaleChangeAtRef.current = now;
    const settle = window.setTimeout(sync, streaming ? TILE_SETTLE_MS : 0);
    window.addEventListener("scroll", onViewportChange, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", onViewportChange);
    return () => {
      window.clearTimeout(settle);
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onViewportChange, { capture: true });
      window.removeEventListener("resize", onViewportChange);
    };
  }, [
    doc,
    sourceIndex,
    rotation,
    scale,
    widthPt,
    heightPt,
    tiling,
    backdropSharp,
    runtime,
  ]);

  // Unmount (page recycled, tab suspended): every tile bitmap goes now, not
  // at the next GC — same reason as PageCanvas's double buffers.
  useEffect(() => {
    const current = currentRef;
    const stale = staleRef;
    return () => {
      for (const ref of [current, stale]) {
        const layer = ref.current;
        if (!layer) continue;
        for (const tile of layer.tiles.values()) {
          tile.cancel();
          runtime.releaseCanvasBackingStore(tile.canvas);
        }
        layer.tiles.clear();
        layer.el.remove();
        ref.current = null;
      }
    };
  }, [runtime]);

  return (
    <div
      ref={hostRef}
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
    />
  );
}
