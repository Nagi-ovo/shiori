import { T } from "../../design/tokens";
import { DocumentPreviewSurface } from "./DocumentPreviewSurface";
import {
  hasDocumentPreviewVisual,
  type DocumentPreviewData,
} from "./documentPreview";

/**
 * The popover a truncated row opens on hover or keyboard focus.
 *
 * The browser's own `title` tooltip was not enough: it waits about a second,
 * never appears at all for a row the pointer crosses quickly, and cannot be
 * reached by keyboard. A row ends in an ellipsis exactly when the reader wants
 * the rest, so getting the rest has to be immediate.
 *
 * Positioned `fixed` against the row's measured rectangle, NOT absolutely
 * inside it. Absolute positioning put it inside a scroll container, and a
 * container with `overflow-y: auto` clips horizontally too — CSS promotes a
 * `visible` axis to `auto` as soon as the other axis is not `visible`, so the
 * text was cut mid-word at the panel's edge. There is no ancestor to escape
 * once the popover is fixed.
 */

/**
 * Sized as a card you read, not a tooltip you glance at. The first version was
 * a 280px box with 8px padding and 12px text — technically the same
 * information, but cramped enough that a long paper title still felt like
 * something being withheld.
 */
const WIDTH = 400;
const MAX_HEIGHT = 340;
/** Breathing room from the anchoring row and from the viewport's edges. */
const GAP = 6;
const EDGE = 12;

export type RowPreviewPlacement = "auto" | "above" | "below";
export type RowPreviewAnchor = Pick<DOMRect, "left" | "top" | "bottom">;

export function RowPreview({
  id,
  heading,
  body,
  note,
  documentPreview,
  previewDetail,
  anchor,
  placement = "auto",
}: {
  id: string;
  /** Small dim line above the body: kind, page, folder — context, not content. */
  heading: string;
  body: string;
  /** Appended dim after the body, e.g. to admit the body is itself clipped. */
  note?: string;
  /** Last captured reading position; absent keeps the compact text card. */
  documentPreview?: DocumentPreviewData | null;
  /** Human-readable page / zoom metadata for the captured position. */
  previewDetail?: string;
  /** The row's viewport rectangle, measured when the hover began. */
  anchor: RowPreviewAnchor;
  /** A scrolling list can keep the card behind the pointer's direction. */
  placement?: RowPreviewPlacement;
}) {
  const viewportWidth =
    typeof window === "undefined" ? WIDTH + EDGE * 2 : window.innerWidth;
  const viewportHeight =
    typeof window === "undefined" ? MAX_HEIGHT * 2 : window.innerHeight;
  const width = Math.min(WIDTH, viewportWidth - EDGE * 2);
  // Prefer the row's left edge, pulled back in if that would overflow.
  const left = Math.max(
    EDGE,
    Math.min(anchor.left, viewportWidth - width - EDGE),
  );
  const spaceBelow = viewportHeight - anchor.bottom - GAP - EDGE;
  const spaceAbove = anchor.top - GAP - EDGE;
  // A requested side wins while it has enough room for a useful card. Near a
  // viewport edge we still flip rather than letting the preview escape the
  // window. Non-scrolling callers retain the original space-based behavior.
  const canUseAbove = spaceAbove >= 64;
  const canUseBelow = spaceBelow >= 64;
  const placeAbove =
    placement === "above"
      ? canUseAbove || !canUseBelow
      : placement === "below"
        ? !canUseBelow && canUseAbove
        : spaceBelow < Math.min(MAX_HEIGHT, spaceAbove);
  const maxHeight = Math.max(
    64,
    Math.min(MAX_HEIGHT, placeAbove ? spaceAbove : spaceBelow),
  );
  // If the chosen side is tight, retain the useful filename card rather than
  // squeeze an image into a sliver the reader cannot inspect.
  const showVisualPreview =
    maxHeight >= 240 && hasDocumentPreviewVisual(documentPreview);

  return (
    <div
      id={id}
      role="tooltip"
      style={{
        position: "fixed",
        left,
        ...(placeAbove
          ? { bottom: viewportHeight - anchor.top + GAP }
          : { top: anchor.bottom + GAP }),
        width,
        maxHeight,
        overflowY: "auto",
        zIndex: 60,
        padding: "14px 16px 15px",
        background: T.surface,
        border: `1px solid ${T.rule}`,
        borderRadius: 11,
        // Wide and soft rather than tight and dark: the card should look like
        // it is floating above the page, not stamped onto it.
        boxShadow: "0 12px 34px rgba(19,22,29,0.17), 0 2px 6px rgba(19,22,29,0.06)",
        // Never a hover target itself: the row owns the hover, and a popover
        // that can be hovered would keep itself open under the pointer.
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          display: "block",
          font: `600 9px/1.4 ${T.mono}`,
          letterSpacing: ".11em",
          textTransform: "uppercase",
          color: T.dim,
          marginBottom: 8,
        }}
      >
        {heading}
      </span>
      {showVisualPreview ? (
        <>
          <DocumentPreviewSurface
            preview={documentPreview}
            height={170}
            htmlScale={0.46}
          />
          {previewDetail ? (
            <span
              style={{
                display: "block",
                marginTop: 7,
                font: `500 10px/1.4 ${T.mono}`,
                color: T.dim,
              }}
            >
              {previewDetail}
            </span>
          ) : null}
        </>
      ) : null}
      <span
        style={{
          display: "block",
          marginTop: showVisualPreview ? 9 : undefined,
          font: `400 13.5px/1.7 ${T.sans}`,
          color: T.ink,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {body}
        {note ? (
          <span
            style={{
              display: "block",
              marginTop: 9,
              font: `400 11px/1.6 ${T.mono}`,
              color: T.dim,
              overflowWrap: "anywhere",
            }}
          >
            {note}
          </span>
        ) : null}
      </span>
    </div>
  );
}
