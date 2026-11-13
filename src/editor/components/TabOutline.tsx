import { useLayoutEffect, useRef } from "react";
import { T } from "../../design/tokens";
import { tabOutlinePaths } from "./tabOutlineGeometry";

/**
 * The active tab's shape — paper body, 1px rule outline and concave feet —
 * as one SVG path behind the tab's label (geometry and attribution in
 * `tabOutlineGeometry.ts`).
 *
 * Render it as a child of a `position: relative` tab that is its own stacking
 * context (a z-index) and keeps a 1px transparent border: the SVG covers the
 * tab's border box plus `foot` px on each side, and sits at z-index -1 so the
 * label paints over it.
 *
 * The path needs the tab's width, which only layout knows. A ResizeObserver
 * on the SVG reports it once on mount and again only when the tab's size
 * changes — never per frame, and not while a drag moves the tab by
 * transform. Its callback runs after layout and before paint, and writes
 * the path data straight onto the DOM, so the shape is there in the first
 * frame the tab is drawn, without a React re-render.
 */
export function TabOutline({ radius, foot }: { radius: number; foot: number }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fillRef = useRef<SVGPathElement | null>(null);
  const strokeRef = useRef<SVGPathElement | null>(null);

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const { fill, stroke } = tabOutlinePaths(width, height, radius, foot);
      fillRef.current?.setAttribute("d", fill);
      strokeRef.current?.setAttribute("d", stroke);
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, [radius, foot]);

  // Absolutely positioned against the tab's padding box, so the 1px border
  // comes back on every side. A replaced element ignores left + right, hence
  // the explicit size.
  const reach = foot + 1;
  return (
    <svg
      ref={svgRef}
      aria-hidden="true"
      focusable="false"
      style={{
        position: "absolute",
        top: -1,
        left: -reach,
        width: `calc(100% + ${2 * reach}px)`,
        height: "calc(100% + 2px)",
        zIndex: -1,
        pointerEvents: "none",
      }}
    >
      <path ref={fillRef} style={{ fill: T.paper }} />
      <path
        ref={strokeRef}
        style={{
          fill: "none",
          stroke: T.rule,
          strokeWidth: 1,
          strokeLinejoin: "round",
        }}
      />
    </svg>
  );
}
