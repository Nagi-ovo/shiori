import { renderDragPreview, type DragPreviewDefaults } from "./dragPreview";
import type { SavedSignature } from "../../../storage/signatures";
import { useTransientDragPreview } from "./transientDragPreview";

// The only subscriber to the creation-gesture channel. Drawing a stroke or
// sweeping a marquee repaints this and nothing else — the annotations, the
// page canvas and OverlayLayer itself never re-render for it, which is the
// rule docs/POSTMORTEMS.md 2026-07-30 arrived at for pointer-tracking work.
export function DragPreviewLayer({
  pageId,
  scale,
  defaults,
  activeSignature,
}: {
  pageId: string;
  scale: number;
  defaults: DragPreviewDefaults;
  activeSignature?: SavedSignature | null;
}) {
  const drag = useTransientDragPreview(pageId);
  return <>{renderDragPreview(drag, scale, defaults, activeSignature)}</>;
}
