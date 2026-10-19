import type { PdfDocument } from "../engine/types";

/**
 * A tiny bitmap per page, kept so a page that is scrolled back into view has
 * something correct to show while its sharp raster runs.
 *
 * Rasterizing a page takes ~62ms at reading zoom. Virtualization can mount a
 * page ahead of time, but a fast fling always outruns any fixed lookahead, and
 * the honest answer to "what do we show in the gap" is not an empty sheet —
 * it is this page, blurry. The eye reads blurry-to-sharp as loading; it reads
 * blank-to-content as a flash.
 *
 * The preview is DERIVED from the sharp bitmap the page just produced — one
 * drawImage into a small canvas — so it costs the engine no extra work. It is
 * stored as an encoded data URL rather than a live canvas: ~10-20KB of string
 * versus ~0.3MB of pixels, and an <img> can stretch it without us holding a
 * second canvas per page alive.
 */

/** Long edge of the stored preview, in device pixels. */
const PREVIEW_MAX_EDGE = 320;
/**
 * Pages kept per document. A reader moves through a document in a window, so
 * recency is the right eviction rule; 64 previews is roughly 1MB of strings
 * and covers any realistic scrollback.
 */
const PREVIEW_LIMIT = 64;

// Keyed by the document proxy so previews are released with the document, and
// a Map inside so eviction is per-document. Map preserves insertion order,
// which is all an LRU needs: delete-then-set moves a key to the end.
const cache = new WeakMap<PdfDocument, Map<string, string>>();

function keyFor(sourceIndex: number, rotation: number): string {
  return `${sourceIndex}:${rotation}`;
}

/** The stored preview for this page face, if one was ever rendered. */
export function getPagePreview(
  doc: PdfDocument,
  sourceIndex: number,
  rotation: number,
): string | null {
  const perDoc = cache.get(doc);
  if (!perDoc) return null;
  const key = keyFor(sourceIndex, rotation);
  const url = perDoc.get(key);
  if (url === undefined) return null;
  // Touch: this page is being looked at, so it should evict last.
  perDoc.delete(key);
  perDoc.set(key, url);
  return url;
}

/**
 * Downscale a freshly rendered page canvas and remember it. Cheap enough to
 * call on every completed raster, but call it off the critical path — the
 * encode is a few milliseconds and the page is already on screen by then.
 */
export function storePagePreview(
  doc: PdfDocument,
  sourceIndex: number,
  rotation: number,
  source: HTMLCanvasElement,
): void {
  if (source.width <= 0 || source.height <= 0) return;
  const longEdge = Math.max(source.width, source.height);
  const ratio = Math.min(1, PREVIEW_MAX_EDGE / longEdge);
  const width = Math.max(1, Math.round(source.width * ratio));
  const height = Math.max(1, Math.round(source.height * ratio));

  let url: string;
  try {
    const small = document.createElement("canvas");
    small.width = width;
    small.height = height;
    const ctx = small.getContext("2d");
    if (!ctx) return;
    // The sharp bitmap has no alpha of its own — the engine paints the sheet — so
    // JPEG is safe here and a third the size of PNG at this scale.
    ctx.drawImage(source, 0, 0, width, height);
    url = small.toDataURL("image/jpeg", 0.6);
  } catch {
    // A tainted canvas or an out-of-memory encode. A missing preview only
    // costs us the blank sheet we had before, so there is nothing to report.
    return;
  }

  let perDoc = cache.get(doc);
  if (!perDoc) {
    perDoc = new Map();
    cache.set(doc, perDoc);
  }
  const key = keyFor(sourceIndex, rotation);
  perDoc.delete(key);
  perDoc.set(key, url);
  while (perDoc.size > PREVIEW_LIMIT) {
    const oldest = perDoc.keys().next();
    if (oldest.done) break;
    perDoc.delete(oldest.value);
  }
}
