import { T } from "../../../design/tokens";
import type { StampOverlay, TextOverlay } from "../../../pdf/model/types";
import type { SavedSignature } from "../../../storage/signatures";
import type { DragState } from "../../overlays/dragState";
import {
  STAMP_DEFAULT_SIZE_PT,
  STAMP_MIN_SIZE_PT,
} from "./overlayConstants";
import { fontFamilyCss } from "./overlayTextStyle";
import { StampMark } from "./StampMark";

export type DragPreviewDefaults = {
  inkColor: string;
  inkWidth: number;
  highlightColor: string;
  highlightOpacity: number;
  rectColor: string;
  rectStrokeWidth: number;
  rectFill: string | null;
  stampKind: StampOverlay["kind"];
  stampColor: string;
  stampStrokeWidth: number;
  noteColor: string;
  textColor: string;
  textFontSize: number;
  textBold: boolean;
  textItalic: boolean;
  textAlign: TextOverlay["align"];
  textFontFamily: TextOverlay["fontFamily"];
};

export function renderDragPreview(
  drag: DragState,
  scale: number,
  defaults: DragPreviewDefaults,
  activeSignature?: SavedSignature | null,
) {
  if (drag.kind === "rect") {
    const x = Math.min(drag.startX, drag.curX);
    const y = Math.min(drag.startY, drag.curY);
    const w = Math.abs(drag.curX - drag.startX);
    const h = Math.abs(drag.curY - drag.startY);
    return (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={defaults.rectFill ?? "none"}
        stroke={defaults.rectColor}
        strokeWidth={defaults.rectStrokeWidth}
        rx={2}
        ry={2}
      />
    );
  }
  if (drag.kind === "highlight") {
    const x = Math.min(drag.startX, drag.curX);
    const y = Math.min(drag.startY, drag.curY);
    const w = Math.abs(drag.curX - drag.startX);
    const h = Math.abs(drag.curY - drag.startY);
    return (
      <g style={{ mixBlendMode: "multiply" }}>
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          fill={defaults.highlightColor}
          opacity={defaults.highlightOpacity}
          rx={1}
          ry={1}
        />
      </g>
    );
  }
  if (drag.kind === "stamp") {
    const x = Math.min(drag.startX, drag.curX);
    const y = Math.min(drag.startY, drag.curY);
    const w = Math.abs(drag.curX - drag.startX);
    const h = Math.abs(drag.curY - drag.startY);
    const rect =
      w < STAMP_MIN_SIZE_PT * scale || h < STAMP_MIN_SIZE_PT * scale
        ? {
            x: drag.startX - (STAMP_DEFAULT_SIZE_PT * scale) / 2,
            y: drag.startY - (STAMP_DEFAULT_SIZE_PT * scale) / 2,
            w: STAMP_DEFAULT_SIZE_PT * scale,
            h: STAMP_DEFAULT_SIZE_PT * scale,
          }
        : { x, y, w, h };
    return (
      <StampMark
        kind={defaults.stampKind}
        rect={rect}
        color={defaults.stampColor}
        strokeWidth={defaults.stampStrokeWidth * scale}
      />
    );
  }
  if (drag.kind === "note") {
    const x = Math.min(drag.startX, drag.curX);
    const y = Math.min(drag.startY, drag.curY);
    const w = Math.abs(drag.curX - drag.startX);
    const h = Math.abs(drag.curY - drag.startY);
    return (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={defaults.noteColor}
        stroke="rgba(158,130,40,0.4)"
        strokeWidth={0.5}
        rx={2}
        ry={2}
      />
    );
  }
  if (drag.kind === "text") {
    const x = Math.min(drag.startX, drag.curX);
    const y = Math.min(drag.startY, drag.curY);
    const w = Math.abs(drag.curX - drag.startX);
    const h = Math.abs(drag.curY - drag.startY);
    const fontSize = Math.max(6, defaults.textFontSize * scale);
    const textAnchor =
      defaults.textAlign === "center"
        ? "middle"
        : defaults.textAlign === "right"
          ? "end"
          : "start";
    const sampleX =
      defaults.textAlign === "center"
        ? x + w / 2
        : defaults.textAlign === "right"
          ? x + w - 4
          : x + 4;
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          fill="transparent"
          stroke={defaults.textColor}
          strokeDasharray="4 3"
          strokeWidth={1}
        />
        {w > 20 && h > fontSize + 8 ? (
          <text
            x={sampleX}
            y={y + 4 + fontSize}
            fill={defaults.textColor}
            fontFamily={fontFamilyCss(defaults.textFontFamily)}
            fontSize={fontSize}
            fontWeight={defaults.textBold ? 600 : 400}
            fontStyle={defaults.textItalic ? "italic" : "normal"}
            textAnchor={textAnchor}
          >
            Aa
          </text>
        ) : null}
      </g>
    );
  }
  if (drag.kind === "signature") {
    const x = Math.min(drag.startX, drag.curX);
    const y = Math.min(drag.startY, drag.curY);
    const w = Math.abs(drag.curX - drag.startX);
    const h = Math.abs(drag.curY - drag.startY);
    const signature = activeSignature ?? null;
    const fitted =
      signature && w > 0 && h > 0
        ? fitDisplayRectToAspect({ x, y, w, h }, signature.aspectRatio)
        : null;
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          fill="rgba(26,24,21,0.02)"
          stroke={T.ink}
          strokeDasharray="4 3"
          strokeWidth={1}
          rx={2}
          ry={2}
        />
        {fitted && signature ? renderSignaturePreview(signature, fitted) : null}
      </g>
    );
  }
  if (drag.kind === "marquee") {
    const x = Math.min(drag.startX, drag.curX);
    const y = Math.min(drag.startY, drag.curY);
    const w = Math.abs(drag.curX - drag.startX);
    const h = Math.abs(drag.curY - drag.startY);
    return (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="rgba(26,24,21,0.02)"
        stroke={T.ink}
        strokeDasharray="3 3"
        strokeWidth={1}
      />
    );
  }
  if (drag.kind === "ink") {
    if (drag.points.length < 2) return null;
    const d = drag.points
      .map((p, j) => `${j === 0 ? "M" : "L"}${p.x},${p.y}`)
      .join(" ");
    return (
      <path
        d={d}
        fill="none"
        stroke={defaults.inkColor}
        strokeWidth={defaults.inkWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  return null;
}

function renderSignaturePreview(
  signature: SavedSignature,
  rect: { x: number; y: number; w: number; h: number },
) {
  if (signature.kind === "image") {
    return (
      <image
        href={signature.dataUrl}
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        preserveAspectRatio="none"
        opacity={0.85}
      />
    );
  }
  return (
    <g opacity={0.85}>
      {signature.paths.map((path, index) => (
        <path
          key={index}
          d={path
            .map(
              (point, i) =>
                `${i === 0 ? "M" : "L"}${rect.x + point.x * rect.w},${rect.y + point.y * rect.h}`,
            )
            .join(" ")}
          fill="none"
          stroke={signature.color}
          strokeWidth={Math.max(
            1,
            signature.lineWidthRatio * Math.min(rect.w, rect.h),
          )}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </g>
  );
}

function fitDisplayRectToAspect(
  rect: { x: number; y: number; w: number; h: number },
  aspectRatio: number,
): { x: number; y: number; w: number; h: number } {
  const safeAspect =
    Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 3;
  const rectAspect = rect.w / rect.h;
  if (rectAspect > safeAspect) {
    const w = rect.h * safeAspect;
    return { x: rect.x + (rect.w - w) / 2, y: rect.y, w, h: rect.h };
  }
  const h = rect.w / safeAspect;
  return { x: rect.x, y: rect.y + (rect.h - h) / 2, w: rect.w, h };
}
