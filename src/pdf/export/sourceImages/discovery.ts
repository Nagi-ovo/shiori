import { PDFDocument, type PDFDict } from "pdf-lib";
import { sourcePageDicts } from "../../import/sourcePages";
import { assertPdfWithinPageLimit } from "../../openPolicy";
import type { SourceImageInfo, SourceImageLocation } from "../sourceImages";

type DiscoveryWalk = {
  walkPage(page: PDFDict, pageIndex: number, collect: boolean): { occurrences: SourceImageLocation[] };
  isShared(occurrence: SourceImageLocation): boolean;
};

type ImageDiscovery = {
  pages: ReturnType<typeof sourcePageDicts>;
  sharing: DiscoveryWalk;
  results: Map<number, SourceImageInfo[]>;
};
const discoveries = new WeakMap<Uint8Array, Promise<ImageDiscovery>>();

/** Returns an empty list when a page is missing or its ordinary paint order cannot be established.
 * A document that cannot be loaded still rejects discovery.
 */
export async function discoverSourceImages(
  bytes: Uint8Array, pageIndex: number, createWalk: () => DiscoveryWalk,
): Promise<SourceImageInfo[]> {
  // The editor keeps the opened bytes immutable. Load only on the first
  // selection gesture and compute cross-page sharing once for this source.
  let pending = discoveries.get(bytes);
  if (!pending) {
    pending = discoverImages(bytes, pageIndex, createWalk).catch(error => {
      discoveries.delete(bytes);
      throw error;
    });
    discoveries.set(bytes, pending);
  }
  const { pages, sharing, results } = await pending;
  const page = pages[pageIndex];
  if (!page) return [];
  const known = results.get(pageIndex);
  if (known) return known;
  let images: SourceImageInfo[] = [];
  try {
    images = imageInfo(createWalk().walkPage(page, pageIndex, true).occurrences, sharing);
  } catch {
    // A page whose paint order cannot be proven offers no selectable images.
  }
  results.set(pageIndex, images);
  if (results.size > 24) results.delete(results.keys().next().value!);
  return images;
}

function imageInfo(occurrences: SourceImageLocation[], sharing: DiscoveryWalk) {
  return occurrences.map(occurrence => {
    occurrence.info.shared = sharing.isShared(occurrence);
    return occurrence.info;
  });
}

async function discoverImages(
  bytes: Uint8Array, requestedPage: number, createWalk: () => DiscoveryWalk,
): Promise<ImageDiscovery> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = sourcePageDicts(pdf);
  assertPdfWithinPageLimit(pages.length);
  const sharing = createWalk();
  const results = new Map<number, SourceImageInfo[]>();
  let requested: SourceImageLocation[] = [];
  for (const [index, page] of pages.entries()) {
    // Give the reader a chance to process input on large documents.
    if (index > 0 && index % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    if (!page) continue;
    try {
      const located = sharing.walkPage(page, index, index === requestedPage);
      if (index === requestedPage) requested = located.occurrences;
    } catch {
      // As in the writer's inspection, one opaque page does not invalidate
      // occurrences on other pages.
    }
  }
  results.set(requestedPage, imageInfo(requested, sharing));
  return { pages, sharing, results };
}

