import { T } from "../../../design/tokens";
import type { Overlay, PageModel, PdfRect } from "../../../pdf/model/types";
import { pdfRectToDisplay, pdfToDisplay } from "../../../pdf/geometry/coords";
import {
  CALLOUT_TARGET_OPACITY,
  calloutConnectorGeometry,
  collapsedCalloutRect,
  collapsedCalloutSizePx,
} from "../../../pdf/model/callout";
import { useCalloutLeaderCollapsed } from "../../overlays/calloutPresentation";
import { useTranslation } from "react-i18next";
import { describeOverlay } from "./describeOverlay";
import { useEditorStore } from "../../store/store";
import { boundsOf } from "../../overlays/geometry";
import { isTextMarkupOverlay } from "./overlayGuards";
import { StampMark } from "./StampMark";
import { memo, useState } from "react";
import {
  fitLiveRevealPartTiming,
  findActiveLiveOverlayReveal,
  liveRevealAnimationDelay,
  liveRevealAnimationDuration,
  type ActiveLiveOverlayReveal,
  type LiveOverlayRevealBatch,
} from "../../../live/overlayReveal";
import {
  applyTransientOverlayGeometry,
  useTransientOverlayGeometry,
} from "./transientOverlayGeometry";

function OverlaySvgImpl({
  overlay: committedOverlay,
  page,
  scale,
  selected,
  liveReveals,
}: {
  overlay: Overlay;
  page: PageModel;
  scale: number;
  selected: boolean;
  liveReveals: readonly LiveOverlayRevealBatch[];
}) {
  const transient = useTransientOverlayGeometry(committedOverlay.id);
  const overlay = applyTransientOverlayGeometry(committedOverlay, transient);
  const { t } = useTranslation();
  // A new overlay component mounts in the same React update that commits its
  // reveal receipt. On a Virtuoso remount this fresh timestamp lets the
  // absolute schedule resume (or render statically after its item ended).
  const [mountedAtMs] = useState(() => Date.now());
  const reveal = findActiveLiveOverlayReveal(
    liveReveals,
    overlay.id,
    mountedAtMs,
  );
  const collapsedFlag = useEditorStore(
    (state) =>
      overlay.type === "callout" &&
      state.collapsedCalloutIds.includes(overlay.id),
  );
  // The leader lags on expand only: see useCalloutLeaderCollapsed.
  const leaderCollapsed = useCalloutLeaderCollapsed(collapsedFlag && !reveal);
  const collapsedRect =
    overlay.type === "callout" && leaderCollapsed
      ? collapsedCalloutRect(
          overlay.rect,
          collapsedCalloutSizePx(scale),
          scale,
        )
      : null;
  // Recomputed only when this overlay's committed or transient geometry
  // changes; resize/rotate do not invalidate every annotation on the page.
  const label = describeOverlay(overlay, t);
  // Nothing in this file carried a role or an accessible name, so every
  // annotation drawn as SVG — highlight, underline, strikethrough, ink,
  // rectangle, stamp, signature — was invisible to assistive tech: a
  // marked-up page announced its text and not one of its marks. Naming the
  // group is enough; the shapes inside stay decorative.
  return (
    <g
      role="img"
      data-overlay-id={overlay.id}
      aria-label={label}
      aria-current={selected ? "true" : undefined}
    >
      {renderOverlaySvg(
        overlay,
        page,
        scale,
        selected && !reveal,
        reveal,
        collapsedRect,
      )}
    </g>
  );
}

// Rect resize/rotate and move previews bypass React. Other resizable overlay
// types change only the active annotation's transient subscription, so every
// untouched row skips its SVG geometry and reveal work.
export const OverlaySvg = memo(OverlaySvgImpl);

// Center-anchored, unrotated display box for a box-type overlay plus the
// SVG rotate() transform that spins it about its center by the total angle
// (page rotation + element free angle). Mirrors boxPlacement() in
// OverlayDom.tsx so the SVG visual lines up exactly with the DOM hit box.
//
// ROTATION-DIRECTION SIGN: SVG rotate(+deg) is clockwise, matching the
// DOM CSS rotate(+deg). To flip on-screen direction, negate `deg` in BOTH
// this file and OverlayDom.tsx's boxPlacement.
function boxSvgPlacement(
  rect: PdfRect,
  angle: number,
  page: PageModel,
  scale: number,
): {
  x: number;
  y: number;
  w: number;
  h: number;
  transform: string;
} {
  const totalDeg = page.rotation + angle;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const c = pdfToDisplay(
    { x: cx, y: cy },
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const w = rect.w * scale;
  const h = rect.h * scale;
  return {
    x: c.x - w / 2,
    y: c.y - h / 2,
    w,
    h,
    transform: `rotate(${totalDeg} ${c.x} ${c.y})`,
  };
}

function renderOverlaySvg(
  overlay: Overlay,
  page: PageModel,
  scale: number,
  selected: boolean,
  reveal: ActiveLiveOverlayReveal | null = null,
  collapsedRect: PdfRect | null = null,
) {
  if (isTextMarkupOverlay(overlay)) {
    return renderTextMarkupSvg(overlay, page, scale, selected, reveal);
  }
  if (overlay.type === "callout") {
    return renderCalloutSvg(
      overlay,
      page,
      scale,
      selected,
      reveal,
      collapsedRect,
    );
  }
  if (overlay.type === "contentText") {
    // Cover rects rotate with the text box about its center. They are
    // positioned in the box's local (unrotated) display frame via the same
    // center-anchored placement as the rect itself, then the whole group
    // is rotated. (coverRects share the rect's geometry; reuse the rect
    // placement to derive the local frame offset.)
    const box = boxSvgPlacement(
      overlay.rect,
      overlay.angle ?? 0,
      page,
      scale,
    );
    return (
      <g key={overlay.id} transform={box.transform}>
        {overlay.coverRects.map((rect, index) => {
          // Local frame: where this cover sits relative to the box's
          // unrotated top-left (box.x/box.y), in display px.
          const lx = box.x + (rect.x - overlay.rect.x) * scale;
          // PDF y grows up; display y grows down. Offset from the box's
          // PDF top edge (rect.y + rect.h) downward.
          const ly =
            box.y + (overlay.rect.y + overlay.rect.h - (rect.y + rect.h)) * scale;
          return (
            <rect
              key={index}
              x={lx}
              y={ly}
              width={rect.w * scale}
              height={rect.h * scale}
              fill={overlay.backgroundColor}
            />
          );
        })}
      </g>
    );
  }
  if (overlay.type === "rect") {
    const box = boxSvgPlacement(
      overlay.rect,
      overlay.angle ?? 0,
      page,
      scale,
    );
    if (reveal) {
      return (
        <g key={overlay.id} data-live-reveal="rect">
          {overlay.fill ? (
            <rect
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              transform={box.transform}
              fill={overlay.fill}
              stroke="none"
              rx={2}
              ry={2}
              style={{
                opacity: 0,
                animation: `shioriLiveTypeIn ${liveRevealAnimationDuration(reveal, 0.35)} ease-out ${liveRevealAnimationDelay(reveal, Math.round(reveal.item.durationMs * 0.58))} both`,
              }}
            />
          ) : null}
          <rect
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            transform={box.transform}
            stroke={overlay.color}
            strokeWidth={overlay.strokeWidth}
            fill="none"
            rx={2}
            ry={2}
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1}
            style={{
              animation: `shioriLiveStrokeDraw ${liveRevealAnimationDuration(reveal)} cubic-bezier(.22,.8,.24,1) ${liveRevealAnimationDelay(reveal)} both`,
            }}
          />
        </g>
      );
    }
    return (
      <rect
        key={overlay.id}
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        transform={box.transform}
        stroke={overlay.color}
        strokeWidth={overlay.strokeWidth}
        fill={overlay.fill ?? "none"}
        rx={2}
        ry={2}
      />
    );
  }
  if (overlay.type === "stamp") {
    const box = boxSvgPlacement(
      overlay.rect,
      overlay.angle ?? 0,
      page,
      scale,
    );
    const local = { x: box.x, y: box.y, w: box.w, h: box.h };
    return (
      <g
        key={overlay.id}
        transform={box.transform}
        data-live-reveal={reveal ? "stamp" : undefined}
        style={reveal ? {
          opacity: 0,
          animation: `shioriLiveTypeIn ${liveRevealAnimationDuration(reveal)} ease-out ${liveRevealAnimationDelay(reveal)} both`,
        } : undefined}
      >
        <StampMark
          kind={overlay.kind}
          rect={local}
          color={overlay.color}
          strokeWidth={overlay.strokeWidth * scale}
        />
        {selected ? (
          <rect
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            fill="none"
            stroke={T.ink}
            strokeWidth={1}
            strokeDasharray="4 3"
            rx={2}
            ry={2}
          />
        ) : null}
      </g>
    );
  }
  if (overlay.type === "image") {
    const box = boxSvgPlacement(
      overlay.rect,
      overlay.angle ?? 0,
      page,
      scale,
    );
    return (
      <g key={overlay.id} transform={box.transform}>
        <image
          href={overlay.dataUrl}
          x={box.x}
          y={box.y}
          width={box.w}
          height={box.h}
          preserveAspectRatio="none"
        />
        {selected ? (
          <rect
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            fill="none"
            stroke={T.ink}
            strokeWidth={1}
            strokeDasharray="4 3"
            rx={2}
            ry={2}
          />
        ) : null}
      </g>
    );
  }
  if (overlay.type === "ink") {
    return renderInkSvg(overlay, page, scale, selected, reveal);
  }
  return null;
}

function renderCalloutSvg(
  overlay: Extract<Overlay, { type: "callout" }>,
  page: PageModel,
  scale: number,
  selected: boolean,
  reveal: ActiveLiveOverlayReveal | null,
  collapsedRect: PdfRect | null,
) {
  const targets = overlay.targetRects.map((rect) =>
    pdfRectToDisplay(rect, page.widthPt, page.heightPt, page.rotation, scale),
  );
  // Collapsed: the leader aims at the seal instead of the label box. Both
  // share a centre, so only the start point moves — outward along the same
  // ray, into the area the shrinking card is vacating.
  const connector = calloutConnectorGeometry(
    collapsedRect ? { ...overlay, rect: collapsedRect } : overlay,
  );
  const from = pdfToDisplay(
    connector.from,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const control = pdfToDisplay(
    connector.control,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const to = pdfToDisplay(
    connector.to,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const arrowLeft = pdfToDisplay(
    connector.arrowLeft,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const arrowRight = pdfToDisplay(
    connector.arrowRight,
    page.widthPt,
    page.heightPt,
    page.rotation,
    scale,
  );
  const path =
    connector.kind === "polyline"
      ? `M${from.x},${from.y} L${control.x},${control.y} L${to.x},${to.y}`
      : `M${from.x},${from.y} Q${control.x},${control.y} ${to.x},${to.y}`;
  const arrowPath =
    `M${arrowLeft.x},${arrowLeft.y} L${to.x},${to.y} L${arrowRight.x},${arrowRight.y}`;
  const targetTiming = reveal
    ? fitLiveRevealPartTiming(
        Math.max(1, Math.round(reveal.item.durationMs * 0.3)),
        targets.length,
        36,
      )
    : null;
  const connectorDelay = reveal
    ? Math.round(reveal.item.durationMs * 0.18)
    : 0;
  const arrowDelay = reveal ? Math.round(reveal.item.durationMs * 0.64) : 0;
  return (
    <g key={overlay.id} data-live-reveal={reveal ? "callout" : undefined}>
      <g style={{ mixBlendMode: "multiply" }}>
        {targets.map((target, index) => (
          <rect
            key={index}
            x={target.x}
            y={target.y}
            width={target.w}
            height={target.h}
            rx={1.5}
            ry={1.5}
            fill={overlay.color}
            opacity={CALLOUT_TARGET_OPACITY}
            stroke={selected ? T.accent : "none"}
            strokeWidth={selected ? 1 : 0}
            style={reveal ? {
              transformBox: "fill-box",
              transformOrigin: "left center",
              animation: `shioriLiveHighlightSweep ${targetTiming!.partDurationMs}ms cubic-bezier(.2,.75,.2,1) ${liveRevealAnimationDelay(reveal, index * targetTiming!.staggerMs)} both`,
            } : undefined}
          />
        ))}
      </g>
      <path
        d={path}
        fill="none"
        stroke={overlay.color}
        strokeWidth={Math.max(1.5, 1.7 * scale)}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={reveal ? 1 : undefined}
        strokeDasharray={reveal ? 1 : undefined}
        strokeDashoffset={reveal ? 1 : undefined}
        style={reveal ? {
          animation: `shioriLiveStrokeDraw ${liveRevealAnimationDuration(reveal, 0.54)} cubic-bezier(.22,.8,.24,1) ${liveRevealAnimationDelay(reveal, connectorDelay)} both`,
        } : undefined}
      />
      <path
        d={arrowPath}
        fill="none"
        stroke={overlay.color}
        strokeWidth={Math.max(1.5, 1.7 * scale)}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={reveal ? 1 : undefined}
        strokeDasharray={reveal ? 1 : undefined}
        strokeDashoffset={reveal ? 1 : undefined}
        style={reveal ? {
          animation: `shioriLiveStrokeDraw ${liveRevealAnimationDuration(reveal, 0.2)} cubic-bezier(.22,.8,.24,1) ${liveRevealAnimationDelay(reveal, arrowDelay)} both`,
        } : undefined}
      />
    </g>
  );
}

function renderTextMarkupSvg(
  overlay: Extract<Overlay, { type: "highlight" | "underline" | "strikethrough" }>,
  page: PageModel,
  scale: number,
  selected: boolean,
  reveal: ActiveLiveOverlayReveal | null,
) {
  const displayRects = overlay.rects.map((rect) =>
    pdfRectToDisplay(rect, page.widthPt, page.heightPt, page.rotation, scale),
  );
  const selBox = selected ? selectionBox(displayRects, 2) : null;
  return (
    <g key={overlay.id}>
      {overlay.type === "underline" || overlay.type === "strikethrough" ? (
        <g>
          {displayRects.map((d, i) => {
            const y = textLineDisplayY(overlay.type, d);
            const timing = reveal
              ? fitLiveRevealPartTiming(
                  reveal.item.durationMs,
                  displayRects.length,
                  44,
                )
              : null;
            return (
              <line
                key={i}
                x1={d.x}
                y1={y}
                x2={d.x + d.w}
                y2={y}
                stroke={overlay.color}
                strokeWidth={underlineDisplayStrokeWidth(d)}
                strokeLinecap="round"
                opacity={overlay.opacity}
                pathLength={reveal ? 1 : undefined}
                strokeDasharray={reveal ? 1 : undefined}
                strokeDashoffset={reveal ? 1 : undefined}
                data-live-reveal={reveal ? overlay.type : undefined}
                style={reveal ? {
                  animation: `shioriLiveStrokeDraw ${timing!.partDurationMs}ms cubic-bezier(.22,.8,.24,1) ${liveRevealAnimationDelay(reveal, i * timing!.staggerMs)} both`,
                } : undefined}
              />
            );
          })}
        </g>
      ) : (
        <g style={{ mixBlendMode: "multiply" }}>
          {displayRects.map((d, i) => {
            const timing = reveal
              ? fitLiveRevealPartTiming(
                  reveal.item.durationMs,
                  displayRects.length,
                  54,
                )
              : null;
            return (
            <rect
              key={i}
              x={d.x}
              y={d.y}
              width={d.w}
              height={d.h}
              fill={overlay.color}
              opacity={overlay.opacity}
              rx={1}
              ry={1}
              data-live-reveal={reveal ? "highlight" : undefined}
              style={reveal ? {
                transformBox: "fill-box",
                transformOrigin: "left center",
                animation: `shioriLiveHighlightSweep ${timing!.partDurationMs}ms cubic-bezier(.2,.75,.2,1) ${liveRevealAnimationDelay(reveal, i * timing!.staggerMs)} both`,
              } : undefined}
            />
            );
          })}
        </g>
      )}
      {selBox ? (
        <rect
          x={selBox.x}
          y={selBox.y}
          width={selBox.w}
          height={selBox.h}
          fill="none"
          stroke={T.accent}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          rx={2}
          ry={2}
        />
      ) : null}
    </g>
  );
}

function renderInkSvg(
  overlay: Extract<Overlay, { type: "ink" }>,
  page: PageModel,
  scale: number,
  selected: boolean,
  reveal: ActiveLiveOverlayReveal | null,
) {
  let selBox: { x: number; y: number; w: number; h: number } | null = null;
  if (selected) {
    const flat = overlay.paths.flat();
    if (flat.length > 0) {
      const bounds = boundsOf(flat);
      const d = pdfRectToDisplay(
        bounds,
        page.widthPt,
        page.heightPt,
        page.rotation,
        scale,
      );
      const pad = Math.max(4, overlay.width);
      selBox = {
        x: d.x - pad,
        y: d.y - pad,
        w: d.w + pad * 2,
        h: d.h + pad * 2,
      };
    }
  }
  return (
    <g key={overlay.id}>
      {overlay.paths.map((pts, i) => {
        const d = pts.map((p) =>
          pdfToDisplay(p, page.widthPt, page.heightPt, page.rotation, scale),
        );
        if (d.length < 2) return null;
        const path = d
          .map((pt, j) => `${j === 0 ? "M" : "L"}${pt.x},${pt.y}`)
          .join(" ");
        const timing = reveal
          ? fitLiveRevealPartTiming(
              reveal.item.durationMs,
              overlay.paths.length,
              48,
            )
          : null;
        return (
          <path
            key={i}
            d={path}
            fill="none"
            stroke={overlay.color}
            strokeWidth={overlay.width}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={reveal ? 1 : undefined}
            strokeDasharray={reveal ? 1 : undefined}
            strokeDashoffset={reveal ? 1 : undefined}
            data-live-reveal={reveal ? "ink" : undefined}
            style={reveal ? {
              animation: `shioriLiveStrokeDraw ${timing!.partDurationMs}ms cubic-bezier(.22,.8,.24,1) ${liveRevealAnimationDelay(reveal, i * timing!.staggerMs)} both`,
            } : undefined}
          />
        );
      })}
      {selBox ? (
        <rect
          x={selBox.x}
          y={selBox.y}
          width={selBox.w}
          height={selBox.h}
          fill="none"
          stroke={T.ink}
          strokeWidth={1}
          strokeDasharray="4 3"
          rx={2}
          ry={2}
        />
      ) : null}
    </g>
  );
}

function selectionBox(
  rects: Array<{ x: number; y: number; w: number; h: number }>,
  pad: number,
): { x: number; y: number; w: number; h: number } | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  if (!Number.isFinite(minX)) return null;
  return {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  };
}

function underlineDisplayY(rect: { y: number; h: number }): number {
  return rect.y + rect.h - Math.max(1, Math.min(3, rect.h * 0.12));
}

function strikethroughDisplayY(rect: { y: number; h: number }): number {
  return rect.y + rect.h * 0.55;
}

function textLineDisplayY(
  type: "underline" | "strikethrough",
  rect: { y: number; h: number },
): number {
  return type === "strikethrough"
    ? strikethroughDisplayY(rect)
    : underlineDisplayY(rect);
}

function underlineDisplayStrokeWidth(rect: { h: number }): number {
  return Math.max(1, Math.min(3, rect.h * 0.08));
}
