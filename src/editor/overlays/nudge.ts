import type { Overlay, PageModel } from "../../pdf/model/types";
import { rotateDelta, translateOverlay } from "./geometry";

export function nudgeOverlays(
  overlays: Overlay[],
  selectedIds: string[],
  pages: PageModel[],
  dxDisplayPt: number,
  dyDisplayPt: number,
): Overlay[] {
  if (selectedIds.length === 0) return overlays;
  const selected = new Set(selectedIds);
  const pagesById = new Map(pages.map((page) => [page.id, page]));

  return overlays.map((overlay) => {
    if (!selected.has(overlay.id)) return overlay;
    if (overlay.locked) return overlay;
    // contentText edits are pinned to the source glyphs they cover (same
    // rule as OverlayLayer's drag-move guard): nudging one would shift the
    // redaction covers off the original text while the baseline-anchored
    // replacement stays put — corrupting both the live render and the
    // export.
    if (overlay.type === "contentText") return overlay;
    const page = pagesById.get(overlay.pageId);
    if (!page) return overlay;
    const delta = rotateDelta(dxDisplayPt, dyDisplayPt, page.rotation);
    return {
      ...overlay,
      ...translateOverlay(overlay, delta.x, delta.y),
    } as Overlay;
  });
}
