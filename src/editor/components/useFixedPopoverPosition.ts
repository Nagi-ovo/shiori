import { useEffect, useState, type RefObject } from "react";

type FixedPopoverPosition = { left: number; top: number; ready: boolean };

const VIEWPORT_POPOVER_MARGIN = 8;

export function useFixedPopoverPosition<
  A extends HTMLElement,
  P extends HTMLElement,
>(
  open: boolean,
  anchorRef: RefObject<A | null>,
  popoverRef: RefObject<P | null>,
  fallbackSize: { width: number; height: number },
): FixedPopoverPosition {
  const [position, setPosition] = useState<FixedPopoverPosition>({
    left: VIEWPORT_POPOVER_MARGIN,
    top: VIEWPORT_POPOVER_MARGIN,
    ready: false,
  });

  useEffect(() => {
    if (!open) return;

    let frame = 0;
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      const popover = popoverRef.current;
      const width = popover?.offsetWidth || fallbackSize.width;
      const height = popover?.offsetHeight || fallbackSize.height;
      const maxLeft = Math.max(
        VIEWPORT_POPOVER_MARGIN,
        window.innerWidth - width - VIEWPORT_POPOVER_MARGIN,
      );
      const maxTop = Math.max(
        VIEWPORT_POPOVER_MARGIN,
        window.innerHeight - height - VIEWPORT_POPOVER_MARGIN,
      );
      const left = clamp(
        anchorRect.left,
        VIEWPORT_POPOVER_MARGIN,
        maxLeft,
      );
      const belowTop = anchorRect.bottom + 6;
      const aboveTop = anchorRect.top - height - 6;
      const preferredTop =
        belowTop + height <= window.innerHeight - VIEWPORT_POPOVER_MARGIN ||
        aboveTop < VIEWPORT_POPOVER_MARGIN
          ? belowTop
          : aboveTop;

      setPosition({
        left,
        top: clamp(preferredTop, VIEWPORT_POPOVER_MARGIN, maxTop),
        ready: true,
      });
    };

    update();
    frame = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, fallbackSize.height, fallbackSize.width, open, popoverRef]);

  return position;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
