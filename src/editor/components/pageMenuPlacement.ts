export type PageMenuViewport = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PageMenuSafeInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type PageMenuAnchor =
  | {
      kind: "point";
      x: number;
      y: number;
    }
  | {
      kind: "trigger";
      left: number;
      top: number;
      right: number;
      bottom: number;
    };

export type PageMenuPlacement = {
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
};

const PAGE_MENU_MARGIN = 8;
const PAGE_MENU_GAP = 4;

/**
 * Places both page-menu variants inside the *visual* viewport. A visual
 * viewport can be smaller and offset from the layout viewport while the user
 * is zoomed, so CSS 100vw/100vh alone cannot keep a fixed menu reachable.
 */
export function placePageMenu(
  anchor: PageMenuAnchor,
  menuSize: { width: number; height: number },
  viewport: PageMenuViewport,
  safeInsets: PageMenuSafeInsets,
): PageMenuPlacement {
  const boundaryLeft = viewport.left + safeInsets.left + PAGE_MENU_MARGIN;
  const boundaryTop = viewport.top + safeInsets.top + PAGE_MENU_MARGIN;
  const boundaryRight = Math.max(
    boundaryLeft,
    viewport.left + viewport.width - safeInsets.right - PAGE_MENU_MARGIN,
  );
  const boundaryBottom = Math.max(
    boundaryTop,
    viewport.top + viewport.height - safeInsets.bottom - PAGE_MENU_MARGIN,
  );
  const maxWidth = Math.max(0, boundaryRight - boundaryLeft);
  const maxHeight = Math.max(0, boundaryBottom - boundaryTop);
  const renderedWidth = Math.min(Math.max(0, menuSize.width), maxWidth);
  const renderedHeight = Math.min(Math.max(0, menuSize.height), maxHeight);

  if (anchor.kind === "trigger") {
    const preferredLeft = anchor.right - renderedWidth;
    const below = anchor.bottom + PAGE_MENU_GAP;
    const above = anchor.top - renderedHeight - PAGE_MENU_GAP;
    const roomBelow = Math.max(0, boundaryBottom - anchor.bottom - PAGE_MENU_GAP);
    const roomAbove = Math.max(0, anchor.top - PAGE_MENU_GAP - boundaryTop);
    const preferredTop =
      below + renderedHeight <= boundaryBottom
        ? below
        : above >= boundaryTop || roomAbove > roomBelow
          ? above
          : below;
    return {
      left: clamp(preferredLeft, boundaryLeft, boundaryRight - renderedWidth),
      top: clamp(preferredTop, boundaryTop, boundaryBottom - renderedHeight),
      maxWidth,
      maxHeight,
    };
  }

  return {
    left: clamp(anchor.x, boundaryLeft, boundaryRight - renderedWidth),
    top: clamp(anchor.y, boundaryTop, boundaryBottom - renderedHeight),
    maxWidth,
    maxHeight,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
