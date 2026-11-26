import type { ContentTextOverlay, DocumentModel, Overlay, PageModel } from "../../pdf/model/types";

/**
 * The model an export of `pages` writes. Linked text frames travel with it
 * when every frame's page is exported; a chain that loses a page is dropped
 * and its edit becomes a single-frame edit, so it can never settle as a
 * silent refusal for a chain the export does not carry.
 */
export function exportModelForPages(model: DocumentModel, pages: PageModel[]): DocumentModel {
  const exported = new Set(pages.map((page) => page.id));
  const sourcePages = new Set(model.pages.map((page) => page.id));
  const droppedIds = new Set<string>();
  const kept = (model.flowChains ?? []).filter((chain) => {
    // Only unlink chains whose source pages exist and were omitted by this
    // range. Let the writer report links that could not resolve in the source.
    const known = chain.frames.every((frame) => sourcePages.has(frame.pageId));
    const dropped = known && chain.frames.some((frame) => !exported.has(frame.pageId));
    if (dropped) droppedIds.add(chain.id);
    return !dropped;
  });
  const overlays = model.overlays.map((overlay): Overlay => {
    if (overlay.type !== "contentText" || !overlay.flowChainId || !droppedIds.has(overlay.flowChainId)) return overlay;
    const unlinked: ContentTextOverlay = { ...overlay };
    delete unlinked.flowChainId;
    return unlinked;
  });
  return { pages, overlays, ...(kept.length ? { flowChains: kept } : null) };
}
