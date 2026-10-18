import type { PdfEditorStoreApi } from "./store/store";
import { getPagePreview } from "../pdf/render/pagePreviewCache";

const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 220;

export type CapturedPdfTabPreview = {
  imageUrl: string;
  pageNumber: number;
  scale: number;
};

type RectLike = Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">;

export type PreviewCrop = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
};

/** Map the visible part of a rendered PDF page into a fixed viewport card. */
export function previewCrop(
  viewer: RectLike,
  page: RectLike,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number = PREVIEW_WIDTH,
  targetHeight: number = PREVIEW_HEIGHT,
): PreviewCrop | null {
  if (
    viewer.width <= 0 ||
    viewer.height <= 0 ||
    page.width <= 0 ||
    page.height <= 0 ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return null;
  }
  const left = Math.max(viewer.left, page.left);
  const top = Math.max(viewer.top, page.top);
  const right = Math.min(viewer.right, page.right);
  const bottom = Math.min(viewer.bottom, page.bottom);
  if (right <= left || bottom <= top) return null;

  const targetScale = Math.min(
    targetWidth / viewer.width,
    targetHeight / viewer.height,
  );
  const offsetX = (targetWidth - viewer.width * targetScale) / 2;
  const offsetY = (targetHeight - viewer.height * targetScale) / 2;
  return {
    sx: ((left - page.left) / page.width) * sourceWidth,
    sy: ((top - page.top) / page.height) * sourceHeight,
    sw: ((right - left) / page.width) * sourceWidth,
    sh: ((bottom - top) / page.height) * sourceHeight,
    dx: offsetX + (left - viewer.left) * targetScale,
    dy: offsetY + (top - viewer.top) * targetScale,
    dw: (right - left) * targetScale,
    dh: (bottom - top) * targetScale,
  };
}

function mostVisiblePageElement(preferredPageId: string | null): HTMLElement | null {
  let fallback: HTMLElement | null = null;
  let best: { node: HTMLElement; area: number } | null = null;
  for (const node of document.querySelectorAll<HTMLElement>(
    "[data-shiori-page-id]",
  )) {
    const viewer = node.closest<HTMLElement>(".shioriCanvas");
    if (!viewer) continue;
    if (node.dataset.shioriPageId === preferredPageId) fallback = node;
    const viewerRect = viewer.getBoundingClientRect();
    const pageRect = node.getBoundingClientRect();
    const width = Math.max(
      0,
      Math.min(viewerRect.right, pageRect.right) -
        Math.max(viewerRect.left, pageRect.left),
    );
    const height = Math.max(
      0,
      Math.min(viewerRect.bottom, pageRect.bottom) -
        Math.max(viewerRect.top, pageRect.top),
    );
    const area = width * height;
    if (!best || area > best.area) best = { node, area };
  }
  return best && best.area > 0 ? best.node : fallback;
}

function visiblePageCanvas(page: HTMLElement): HTMLCanvasElement | null {
  return (
    Array.from(page.querySelectorAll<HTMLCanvasElement>(".shioriPageCanvas"))
      .find(
        (canvas) =>
          canvas.width > 0 &&
          canvas.height > 0 &&
          canvas.style.visibility !== "hidden",
      ) ?? null
  );
}

function encodeVisibleViewport(
  viewer: HTMLElement,
  page: HTMLElement,
  source: HTMLCanvasElement,
): string | null {
  const crop = previewCrop(
    viewer.getBoundingClientRect(),
    page.getBoundingClientRect(),
    source.width,
    source.height,
  );
  if (!crop) return null;
  try {
    const output = document.createElement("canvas");
    output.width = PREVIEW_WIDTH;
    output.height = PREVIEW_HEIGHT;
    const ctx = output.getContext("2d");
    if (!ctx) return null;
    // Preserve the current reader field and paper tone in the derived crop.
    ctx.fillStyle = getComputedStyle(viewer).backgroundColor || "#e9e5dc";
    ctx.fillRect(0, 0, output.width, output.height);
    ctx.fillStyle = getComputedStyle(page).backgroundColor || "#fffdf8";
    ctx.fillRect(crop.dx, crop.dy, crop.dw, crop.dh);
    if (source.style.mixBlendMode === "multiply") {
      ctx.globalCompositeOperation = "multiply";
    }
    ctx.drawImage(
      source,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      crop.dx,
      crop.dy,
      crop.dw,
      crop.dh,
    );
    ctx.globalCompositeOperation = "source-over";
    return output.toDataURL("image/jpeg", 0.62);
  } catch {
    return null;
  }
}

/**
 * Capture only pixels already painted for the active page. This never calls
 * pdf.js, so switching tabs cannot wake or reraster a document for its card.
 */
export function capturePdfTabPreview(
  store: PdfEditorStoreApi,
): CapturedPdfTabPreview | null {
  const state = store.getState();
  const opened = state.opened;
  const pageElement = mostVisiblePageElement(state.activePageId);
  const visiblePageId = pageElement?.dataset.shioriPageId;
  let pageIndex = state.model.pages.findIndex(
    (page) => page.id === visiblePageId,
  );
  if (pageIndex < 0) {
    pageIndex = state.model.pages.findIndex(
      (page) => page.id === state.activePageId,
    );
  }
  const page = state.model.pages[Math.max(0, pageIndex)];
  if (!opened || !page) return null;

  const viewer = pageElement?.closest<HTMLElement>(".shioriCanvas") ?? null;
  const canvas = pageElement ? visiblePageCanvas(pageElement) : null;
  const captured =
    viewer && pageElement && canvas
      ? encodeVisibleViewport(viewer, pageElement, canvas)
      : null;
  const fallback = captured
    ? null
    : getPagePreview(opened.doc, page.sourceIndex, page.rotation);
  const imageUrl = captured ?? fallback;
  if (!imageUrl) return null;
  return {
    imageUrl,
    pageNumber: Math.max(0, pageIndex) + 1,
    scale: state.scale,
  };
}
