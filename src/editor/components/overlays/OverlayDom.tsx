import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { describeOverlay } from "./describeOverlay";
import { T } from "../../../design/tokens";
import { Ic } from "../icons";
import { useIsCoarsePointer } from "../../hooks/useIsCoarsePointer";
import {
  pdfRectToDisplay,
  pdfToDisplay,
  rotatedSize,
} from "../../../pdf/geometry/coords";
import { sourceLinePitchPt } from "../../../pdf/model/baselines";
import {
  CALLOUT_LABEL_PADDING_X_PT,
  CALLOUT_LABEL_PADDING_Y_PT,
  collapsedCalloutRect,
  collapsedCalloutSizePx,
} from "../../../pdf/model/callout";
import { splitGraphemes } from "../../../shared/graphemes";
import {
  CALLOUT_DISCLOSURE_MS,
  COLLAPSED_CALLOUT_DRAG_THRESHOLD_PX,
  useCalloutDisclosureMorph,
} from "../../overlays/calloutPresentation";
import { CalloutThreadPanel } from "./CalloutThreadPanel";
import type {
  CalloutOverlay,
  ContentTextOverlay,
  NoteOverlay,
  Overlay,
  PageModel,
  PdfRect,
  TextOverlay,
} from "../../../pdf/model/types";
import {
  formatRelative,
  relativeLabelsFor,
  type RelativeLabels,
} from "../../../shared/format";
import { boundsOf, type ResizeCorner } from "../../overlays/geometry";
import { noteDisplayTimestamp } from "../../overlays/noteMetadata";
import { useEditorStore } from "../../store/store";
import {
  isEditableTextOverlay,
  isSignatureOverlay,
  isTextMarkupOverlay,
  type ResizableOverlay,
} from "./overlayGuards";
import { contentFontFamilyCss, fontFamilyCss } from "./overlayTextStyle";
import { LiveRevealText } from "./LiveRevealText";
import {
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

type OverlayDomProps = {
  overlay: Overlay;
  page: PageModel;
  scale: number;
  selected: boolean;
  editing: boolean;
  interactivePointerEvents: "auto" | "none";
  onStartEdit: (overlay: Overlay) => void;
  onCommitEdit: (overlay: Overlay, patch: Partial<Overlay>) => void;
  onPointerDown: (e: PointerEvent, overlay: Overlay) => void;
  onHandlePointerDown: (
    e: PointerEvent,
    overlay: ResizableOverlay,
    corner: ResizeCorner,
  ) => void;
  onRotateHandlePointerDown: (e: PointerEvent, overlay: ResizableOverlay) => void;
  onDraftTextChange?: (
    overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
    text: string,
  ) => void;
  onCalloutAutoHeight?: (overlay: CalloutOverlay, heightPt: number) => void;
  onMaybeSuppressEditDragBlur: (overlayId: string, now: number) => boolean;
  now: number;
  liveReveals?: readonly LiveOverlayRevealBatch[];
};

// Keep a collapsed note feeling like one physical object: a deliberate tap
// opens it, while a small pointer travel turns the same target into the
// existing overlay move gesture. Pointer moves below this threshold stay out
// of OverlayLayer so hand jitter cannot create a history entry before a tap.
const COLLAPSED_NOTE_DRAG_THRESHOLD_PX = 4;

// Center-anchored box placement. Box-type overlays are rendered as a
// natural-size (unrotated) rectangle positioned by its CENTER, then CSS-
// rotated about that center by the total angle (page rotation + the
// element's free angle). The rect center is rotation-invariant, so the
// box lands on the same screen region as the old swapped-dimension AABB
// for 90° multiples — but now its CONTENT (glyphs, border) rotates with
// the page, which fixes the page-rotation bug, and free angles compose
// on top for the rotation handle.
//
// ROTATION-DIRECTION SIGN: CSS `rotate(+deg)` (clockwise) is the correct
// sign here, and that now follows from coords.ts rather than being an
// assumption. pdf.js PageViewport at rotation 90 maps PDF (x, y) to display
// (y, x), so the PDF +x axis (reading direction) becomes screen-down; CSS
// rotate(+90deg) likewise takes a right-pointing vector to down. They agree.
//
// This only holds because coords.ts maps 90/270 the way pdf.js does. Those
// two branches were swapped until the direction was pinned by
// coords.test.ts ("matches pdf.js PageViewport direction") — with the old
// mapping this `+` sign was actually backwards. Do not negate `totalDeg`
// without re-deriving against that test.
function boxPlacement(
  rect: PdfRect,
  angle: number,
  page: PageModel,
  scale: number,
): {
  left: number;
  top: number;
  width: number;
  height: number;
  totalDeg: number;
  centerX: number;
  centerY: number;
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
  const width = rect.w * scale;
  const height = rect.h * scale;
  return {
    left: c.x - width / 2,
    top: c.y - height / 2,
    width,
    height,
    totalDeg,
    centerX: c.x,
    centerY: c.y,
  };
}

// First-line CSS baseline position inside a line box, as em ratios measured
// once per font via canvas fontBoundingBox metrics. With `line-height: 1` the
// browser centers the (ascent + descent) strip in a line box of exactly
// fontSize, so baseline = (lineBox − (ascent+descent))/2 + ascent. Returns
// null where fontBoundingBox* is unsupported (older WebViews) — callers keep
// the legacy top-anchored layout, which only affects the visual box, never
// the export.
const fontMetricsCache = new Map<
  string,
  { ascentEm: number; descentEm: number } | null
>();

// Measured at 1000px: Chrome reports fontBoundingBox* as integers, so a
// 100px sample quantizes the em ratios to 0.01 (≈0.3px of baseline error
// at body sizes, read as "the text sits a hair high"); 1000px keeps three
// decimals.
function fontMetricsEm(
  fontShorthand1000px: string,
): { ascentEm: number; descentEm: number } | null {
  const cached = fontMetricsCache.get(fontShorthand1000px);
  if (cached !== undefined) return cached;
  let metrics: { ascentEm: number; descentEm: number } | null = null;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.font = fontShorthand1000px;
      const m = ctx.measureText("Mg");
      const ascent = m.fontBoundingBoxAscent;
      const descent = m.fontBoundingBoxDescent;
      if (
        Number.isFinite(ascent) &&
        Number.isFinite(descent) &&
        ascent > 0 &&
        descent >= 0
      ) {
        metrics = { ascentEm: ascent / 1000, descentEm: descent / 1000 };
      }
    }
  } catch {
    metrics = null;
  }
  fontMetricsCache.set(fontShorthand1000px, metrics);
  return metrics;
}

// Line-width measurer bound to a font shorthand, sharing one lazy canvas.
// Uses the same font stack the box renders with (embedded face included),
// so the overflow check sees exactly what the user sees. Null where canvas
// text metrics are unavailable — the warning simply stays off.
let measureCanvasCtx: CanvasRenderingContext2D | null | undefined;

function measureLineWidth(
  fontShorthand: string,
): ((line: string) => number) | null {
  if (measureCanvasCtx === undefined) {
    try {
      measureCanvasCtx = document.createElement("canvas").getContext("2d");
    } catch {
      measureCanvasCtx = null;
    }
  }
  const ctx = measureCanvasCtx;
  if (!ctx) return null;
  ctx.font = fontShorthand;
  return (line) => ctx.measureText(line).width;
}

// Pixel offset (down from the inner content top) that puts the first text
// line's CSS baseline onto the overlay's stored source baseline. Box-local
// math — (rect top − baseline) is rotation-invariant — so no display-space
// round trip. Null = no stored baseline or no font metrics: keep legacy
// top-anchored layout.
// Line-height ratio for a contentText overlay: the measured source line
// pitch over the font size, clamped to a sane band. 1 (the old constant)
// when the overlay has fewer than two captured baselines.
function contentTextLineHeightRatio(
  overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
): number {
  if (overlay.type !== "contentText") return 1;
  const pitchPt = sourceLinePitchPt(overlay.sourceBaselinesPt);
  if (pitchPt === null || overlay.fontSize <= 0) return 1;
  return Math.min(3, Math.max(0.75, pitchPt / overlay.fontSize));
}

function contentTextBaselineShiftPx(
  overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
  fontSizePx: number,
  lineHeightRatio: number,
  fontShorthand: string,
  scale: number,
): number | null {
  if (overlay.type !== "contentText") return null;
  const baselinePt = overlay.sourceBaselinesPt?.[0];
  if (typeof baselinePt !== "number" || !Number.isFinite(baselinePt)) {
    return null;
  }
  const metrics = fontMetricsEm(fontShorthand);
  if (!metrics) return null;
  const lineBoxPx = fontSizePx * lineHeightRatio;
  const stripPx = (metrics.ascentEm + metrics.descentEm) * fontSizePx;
  const baselineInLineBox = (lineBoxPx - stripPx) / 2 + metrics.ascentEm * fontSizePx;
  const targetFromBoxTop =
    (overlay.rect.y + overlay.rect.h - baselinePt) * scale;
  return targetFromBoxTop - baselineInLineBox;
}

function OverlayDomImpl({
  overlay: committedOverlay,
  page,
  scale,
  selected,
  editing,
  interactivePointerEvents,
  onStartEdit,
  onCommitEdit,
  onPointerDown,
  onHandlePointerDown,
  onRotateHandlePointerDown,
  onDraftTextChange,
  onCalloutAutoHeight,
  onMaybeSuppressEditDragBlur,
  now,
  liveReveals = [],
}: OverlayDomProps) {
  const transient = useTransientOverlayGeometry(committedOverlay.id);
  const overlay = applyTransientOverlayGeometry(committedOverlay, transient);
  const { t, i18n } = useTranslation();
  const [mountedAtMs] = useState(() => Date.now());
  const reveal = findActiveLiveOverlayReveal(
    liveReveals,
    overlay.id,
    mountedAtMs,
  );
  const visibleSelected = selected && !reveal;
  if (isEditableTextOverlay(overlay)) {
    return (
      <TextOverlayDom
        overlay={overlay}
        page={page}
        scale={scale}
        selected={visibleSelected}
        editing={editing}
        interactivePointerEvents={interactivePointerEvents}
        onStartEdit={() => onStartEdit(overlay)}
        onCommitEdit={(patch) => onCommitEdit(overlay, patch)}
        onPointerDown={(event) => onPointerDown(event, overlay)}
        onHandlePointerDown={onHandlePointerDown}
        onRotateHandlePointerDown={onRotateHandlePointerDown}
        onDraftTextChange={
          onDraftTextChange
            ? (text) => onDraftTextChange(overlay, text)
            : undefined
        }
        onCalloutAutoHeight={
          onCalloutAutoHeight && overlay.type === "callout"
            ? (heightPt) => onCalloutAutoHeight(overlay, heightPt)
            : undefined
        }
        onMaybeSuppressEditDragBlur={onMaybeSuppressEditDragBlur}
        placeholder={t(
          overlay.type === "callout"
            ? "overlays.calloutPlaceholder"
            : "overlays.textPlaceholder",
        )}
        rotateLabel={t("tooltips.rotate")}
        collapseLabel={t("overlays.calloutCollapse")}
        expandLabel={t("overlays.calloutExpand")}
        reveal={editing ? null : reveal}
      />
    );
  }
  if (overlay.type === "note") {
    return (
      <NoteOverlayDom
        overlay={overlay}
        page={page}
        scale={scale}
        selected={visibleSelected}
        editing={editing}
        interactivePointerEvents={interactivePointerEvents}
        onStartEdit={() => onStartEdit(overlay)}
        onCommitEdit={(patch) => onCommitEdit(overlay, patch)}
        onPointerDown={(event) => onPointerDown(event, overlay)}
        onHandlePointerDown={onHandlePointerDown}
        onRotateHandlePointerDown={onRotateHandlePointerDown}
        onMaybeSuppressEditDragBlur={onMaybeSuppressEditDragBlur}
        now={now}
        noteAuthor={t("overlays.noteAuthor")}
        notePlaceholder={t("overlays.notePlaceholder")}
        undatedLabel={t("rail.undated")}
        relativeLabels={relativeLabelsFor(i18n.resolvedLanguage ?? i18n.language)}
        rotateLabel={t("tooltips.rotate")}
        collapseLabel={t("overlays.noteCollapse")}
        expandLabel={t("overlays.noteExpand")}
        reveal={editing ? null : reveal}
      />
    );
  }
  if (
    overlay.type === "rect" ||
    overlay.type === "image" ||
    overlay.type === "stamp"
  ) {
    return (
      <BoxOverlayDom
        overlay={overlay}
        page={page}
        scale={scale}
        selected={visibleSelected}
        interactivePointerEvents={interactivePointerEvents}
        onPointerDown={(event) => onPointerDown(event, overlay)}
        onHandlePointerDown={onHandlePointerDown}
        onRotateHandlePointerDown={onRotateHandlePointerDown}
        rotateLabel={t("tooltips.rotate")}
      />
    );
  }
  if (isTextMarkupOverlay(overlay)) {
    const displayRects = overlay.rects.map((rect) =>
      pdfRectToDisplay(
        rect,
        page.widthPt,
        page.heightPt,
        page.rotation,
        scale,
      ),
    );
    const d = unionDisplayRects(displayRects);
    if (!d) return null;
    return (
      <div
        data-role="interactive"
        data-overlay-id={overlay.id}
        style={{
          position: "absolute",
          left: d.x,
          top: d.y,
          width: d.w,
          height: d.h,
          cursor: "default",
          pointerEvents: interactivePointerEvents,
        }}
        onPointerDown={(event) => onPointerDown(event, overlay)}
      />
    );
  }
  if (overlay.type === "ink") {
    const paths = overlay.paths.flat();
    if (paths.length === 0) return null;
    const bounds = boundsOf(paths);
    const d = pdfRectToDisplay(
      bounds,
      page.widthPt,
      page.heightPt,
      page.rotation,
      scale,
    );
    return (
      <div
        data-role="interactive"
        data-overlay-id={overlay.id}
        style={{
          position: "absolute",
          left: d.x,
          top: d.y,
          width: d.w,
          height: d.h,
          cursor: "move",
          pointerEvents: interactivePointerEvents,
        }}
        onPointerDown={(event) => onPointerDown(event, overlay)}
      >
        {visibleSelected && isSignatureOverlay(overlay) && !overlay.locked ? (
          <Handles
            width={d.w}
            height={d.h}
            onHandlePointerDown={(e, c) => onHandlePointerDown(e, overlay, c)}
          />
        ) : null}
      </div>
    );
  }
  return null;
}

// Move drags and rect resize/rotate previews bypass React entirely. Other
// resizable overlay types publish only to the active row's transient
// subscription, while memo protects every untouched row from parent churn.
export const OverlayDom = memo(OverlayDomImpl);

function TextOverlayDom({
  overlay,
  page,
  scale,
  selected,
  editing,
  interactivePointerEvents,
  onStartEdit,
  onCommitEdit,
  onPointerDown,
  onHandlePointerDown,
  onRotateHandlePointerDown,
  onDraftTextChange,
  onCalloutAutoHeight,
  onMaybeSuppressEditDragBlur,
  placeholder,
  rotateLabel,
  collapseLabel,
  expandLabel,
  reveal,
}: {
  overlay: TextOverlay | ContentTextOverlay | CalloutOverlay;
  page: PageModel;
  scale: number;
  selected: boolean;
  editing: boolean;
  interactivePointerEvents: "auto" | "none";
  onStartEdit: () => void;
  onCommitEdit: (patch: Partial<Overlay>) => void;
  onPointerDown: (e: PointerEvent) => void;
  onHandlePointerDown: (
    e: PointerEvent,
    overlay: ResizableOverlay,
    corner: ResizeCorner,
  ) => void;
  onRotateHandlePointerDown: (e: PointerEvent, overlay: ResizableOverlay) => void;
  onDraftTextChange?: (text: string) => void;
  onCalloutAutoHeight?: (heightPt: number) => void;
  onMaybeSuppressEditDragBlur: (overlayId: string, now: number) => boolean;
  placeholder: string;
  rotateLabel: string;
  collapseLabel: string;
  expandLabel: string;
  reveal: ActiveLiveOverlayReveal | null;
}) {
  // The document's own embedded font for this edit, when the engine has it
  // loaded this session — prepended to the CSS stack so the edit box
  // renders glyph-identical to the page. Registered by TextHighlightLayer
  // (registerLoadedPdfFontFaces); characters missing from the (usually
  // subset) face fall through to the stack per glyph.
  const embeddedFace = useEditorStore((s) =>
    overlay.type === "contentText" && overlay.sourceFontName
      ? s.pdfFontFaces[overlay.sourceFontName]
      : undefined,
  );
  // Characters the document was seen using in that font — the coverage
  // proxy behind the missing-glyph warning below.
  const sourceCharset = useEditorStore((s) =>
    overlay.type === "contentText" && overlay.sourceFontName
      ? s.pdfFontChars[overlay.sourceFontName]
      : undefined,
  );
  const { t } = useTranslation();
  // On the drag path: a pointermove re-renders the whole overlay layer, so
  // recompute this only when the overlay itself changes.
  const a11yLabel = useMemo(() => describeOverlay(overlay, t), [overlay, t]);
  const [editWarnings, setEditWarnings] = useState({
    overflow: false,
    missing: 0,
  });
  const isCallout = overlay.type === "callout";
  const collapsedFlag = useEditorStore(
    (state) => isCallout && state.collapsedCalloutIds.includes(overlay.id),
  );
  const setCalloutCollapsed = useEditorStore((state) => state.setCalloutCollapsed);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const collapsedPointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressExpandClickRef = useRef(false);
  // A collapse transition and a one-shot reveal keyframe on the same node
  // fight each other. The reveal wins; the seal takes over once it ends.
  const collapsed = collapsedFlag && !reveal;
  const morphing = useCalloutDisclosureMorph(collapsed);
  const p = boxPlacement(
    overlay.rect,
    "angle" in overlay ? overlay.angle ?? 0 : 0,
    page,
    scale,
  );
  const sealSizePx = collapsedCalloutSizePx(scale);
  const sealPlacement = isCallout
    ? boxPlacement(
        collapsedCalloutRect(overlay.rect, sealSizePx, scale),
        0,
        page,
        scale,
      )
    : null;
  // Card geometry collapses to the seal; the CONTENT box always keeps the
  // expanded size so the text does not reflow line by line while it shrinks.
  const box = collapsed && sealPlacement ? sealPlacement : p;
  const sealRingPx = Math.max(1.5, sealSizePx * 0.062);
  const sealGlyph = isCallout
    ? (splitGraphemes(overlay.text.trim())[0] ?? null)
    : null;

  const collapseCallout = () => {
    if (editing) {
      const textarea = textareaRef.current;
      const text = textarea?.value ?? overlay.text;
      // Removing the focused editor can produce a trailing WebKit blur; the
      // click below is the authoritative commit, so mark that blur consumed.
      if (textarea) textarea.dataset.escapeCommitted = "true";
      onCommitEdit({ text } as Partial<CalloutOverlay>);
      // An empty callout is deleted on commit. Never leave a presentation-only
      // tombstone for an overlay that no longer exists.
      if (text.trim() === "") return;
    }
    setCalloutCollapsed(overlay.id, true);
  };
  const isContentEdit = overlay.type === "contentText";
  const contentEditing = isContentEdit && editing;
  const contentFontSize = overlay.fontSize * scale;
  // contentText: line pitch must match the SOURCE lines, not the font size —
  // a multi-line edit rendered at line-height 1 compresses against the
  // original leading (usually 1.15–1.4×) and drifts further every line.
  const textLineHeight = isContentEdit
    ? contentTextLineHeightRatio(overlay)
    : 1.45;
  const fallbackFontFamily = isContentEdit
    ? overlay.renderedFont ?? contentFontFamilyCss(overlay.fontFamily)
    : fontFamilyCss(overlay.fontFamily);
  const textFontFamily = embeddedFace
    ? `"${embeddedFace}", ${fallbackFontFamily}`
    : fallbackFontFamily;
  // contentText frames use `outline`, never `border`: with border-box
  // sizing a border eats into the content area, so the pinned text would
  // shift by the border width the moment the overlay is selected or edited
  // (the old vertical-nudge constants were chasing exactly this). An
  // outline occupies no layout space and still supports dashed strokes.
  const border = isContentEdit || isCallout
    ? "none"
    : `1px dashed ${selected ? T.ink : "rgba(26,24,21,0.18)"}`;
  const outline = contentEditing
    ? `1.5px solid ${T.accent}`
    : isContentEdit && selected
      ? `1px dashed ${T.accent}`
      : isCallout && selected
        ? `1px solid ${overlay.color}`
        : undefined;
  const fontShorthand = `${overlay.italic ? "italic " : ""}${overlay.bold ? 600 : 400} ${contentFontSize}px/${textLineHeight} ${textFontFamily}`;
  const baselineShiftPx = contentTextBaselineShiftPx(
    overlay,
    contentFontSize,
    textLineHeight,
    `${overlay.italic ? "italic " : ""}${overlay.bold ? 600 : 400} 1000px ${textFontFamily}`,
    scale,
  );
  // While a contentText edit is open, surface the two silent degradations
  // before they surprise the user at export time: replacement lines wider
  // than the original region (the export wraps or overflows), and
  // characters the source font likely lacks (export falls back to a
  // bundled font). Measured in an effect — canvas reads are impure and
  // barred from render by the react-hooks purity rule.
  const indentPx =
    isContentEdit && overlay.type === "contentText" && overlay.firstLineIndentPt
      ? overlay.firstLineIndentPt * scale
      : 0;
  const overlayText = overlay.text;
  // Grow the label to its text as it is typed. Measured from the live
  // textarea rather than a canvas: it already inherits the exact font,
  // wrapping and padding the committed render uses, so the box can never
  // disagree with what is inside it. Collapsing the control to zero first is
  // the standard autosize trick — without it scrollHeight can only report
  // growth, never that the text got shorter.
  useLayoutEffect(() => {
    if (!isCallout || !editing || !onCalloutAutoHeight) return;
    // rAF-deferred: a measure-then-setState inside the effect body would trip
    // both the impure-read and cascading-render lint rules.
    const frame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const previous = textarea.style.height;
      textarea.style.height = "0px";
      const contentPx = textarea.scrollHeight;
      textarea.style.height = previous;
      if (!Number.isFinite(contentPx) || contentPx <= 0) return;
      onCalloutAutoHeight(
        contentPx / Math.max(0.01, scale) + CALLOUT_LABEL_PADDING_Y_PT * 2,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    isCallout,
    editing,
    onCalloutAutoHeight,
    overlayText,
    p.width,
    scale,
    fontShorthand,
  ]);
  useLayoutEffect(() => {
    if (!contentEditing) return;
    // rAF-deferred: measuring + setState directly in the effect would both
    // trip the canvas-purity and cascading-render lint rules, and one
    // frame of warning latency is imperceptible while typing.
    const frame = window.requestAnimationFrame(() => {
      let overflow = false;
      const width = measureLineWidth(fontShorthand);
      if (width) {
        const lines = overlayText.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          const room = p.width - (i === 0 ? indentPx : 0);
          if (width(lines[i]!) > room + 1) {
            overflow = true;
            break;
          }
        }
      }
      let missing = 0;
      if (sourceCharset) {
        const checked = new Set<string>();
        for (const ch of overlayText) {
          if (/\s/.test(ch) || checked.has(ch)) continue;
          checked.add(ch);
          if (!sourceCharset.has(ch)) missing += 1;
        }
      }
      setEditWarnings((prev) =>
        prev.overflow === overflow && prev.missing === missing
          ? prev
          : { overflow, missing },
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contentEditing, overlayText, fontShorthand, p.width, indentPx, sourceCharset]);
  return (
    <>
    <div
      data-role="interactive"
      data-overlay-id={overlay.id}
      data-live-reveal={reveal ? overlay.type : undefined}
      // Named so a screen reader can tell this apart from the page text it
      // sits on: previously a note or callout read as loose prose with no
      // indication it was an annotation at all, let alone which one, or
      // whether it was the selected one.
      role="group"
      aria-label={a11yLabel}
      aria-current={selected ? "true" : undefined}
      className={
        isCallout
          ? `shioriCalloutCard${collapsed ? " is-collapsed" : ""}${
              selected ? " is-selected" : ""
            }`
          : undefined
      }
      style={{
        position: "absolute",
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        transform: `rotate(${box.totalDeg}deg)`,
        transformOrigin: "center center",
        border,
        // A seal already IS overlay.color, so the card's own selected outline
        // would be invisible on it — switch to the accent ring instead.
        outline: collapsed
          ? selected
            ? `1.5px solid ${T.accent}`
            : undefined
          : outline,
        outlineOffset: collapsed ? 2 : undefined,
        // backgroundColor, not the `background` shorthand: shorthands are not
        // transitionable, and the collapse morph needs this to animate.
        backgroundColor: isCallout
          ? collapsed
            ? overlay.color
            : "rgba(255,253,247,0.96)"
          : selected
            ? "rgba(26,24,21,0.02)"
            : "transparent",
        borderRadius: isCallout ? (collapsed ? 999 : 5) : undefined,
        boxShadow: collapsed
          ? `0 0 0 ${sealRingPx}px rgba(255,253,247,0.96), 0 2px 6px rgba(35,26,15,0.22)`
          : isCallout
            ? selected
              ? "0 4px 14px rgba(35,26,15,0.16)"
              : "0 2px 8px rgba(35,26,15,0.10)"
            : undefined,
        overflow: isCallout ? "hidden" : undefined,
        boxSizing: "border-box",
        cursor: overlay.locked
          ? "default"
          : editing
            ? "text"
            : isContentEdit
              ? "default" // pinned to the source text — not movable
              : "move",
        pointerEvents: interactivePointerEvents,
        zIndex: contentEditing ? 10 : undefined,
        // Disclosure is a state change, not a one-shot reveal, so it uses a
        // transition rather than the shioriLive* keyframes. Transitioning the
        // box (not a transform) keeps the seal exactly where the leader lands
        // and where the hit test looks, which a scale() would not.
        //
        // The geometry half is armed ONLY while a morph is in flight: left,
        // top, width and height also change on every resize-drag frame and on
        // every zoom step, and an always-on transition would make the card
        // trail the pointer while the leader tracks it exactly.
        ...(isCallout && !reveal
          ? {
              transition: [
                ...(morphing
                  ? ["left", "top", "width", "height"].map(
                      (prop) =>
                        `${prop} ${CALLOUT_DISCLOSURE_MS}ms cubic-bezier(.22,.8,.24,1)`,
                    )
                  : []),
                `border-radius ${CALLOUT_DISCLOSURE_MS}ms cubic-bezier(.22,.8,.24,1)`,
                `box-shadow ${CALLOUT_DISCLOSURE_MS}ms cubic-bezier(.22,.8,.24,1)`,
                "background-color 150ms linear",
                "filter 140ms ease",
              ].join(", "),
            }
          : {}),
        ...(reveal
          ? {
              opacity: 0,
              animation: `shioriLiveSurfaceUnfold ${liveRevealAnimationDuration(reveal, isCallout ? 0.24 : 0.34)} cubic-bezier(.22,.8,.24,1) ${liveRevealAnimationDelay(reveal, isCallout ? Math.round(reveal.item.durationMs * 0.44) : 0)} both`,
            }
          : {}),
      }}
      onPointerDown={onPointerDown}
      onDoubleClick={overlay.locked || collapsed ? undefined : onStartEdit}
      onKeyDown={
        isCallout && !collapsed
          ? (event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              collapseCallout();
            }
          : undefined
      }
    >
      <div
        dir="auto"
        style={{
          position: "absolute",
          // Pinned to the EXPANDED size: letting the text reflow while the card
          // shrinks would rewrap it line by line through the whole transition.
          ...(isCallout
            ? { left: 0, top: 0, width: p.width, height: p.height }
            : { inset: 0 }),
          ...(isCallout
            ? {
                opacity: collapsed ? 0 : 1,
                transition: "opacity 90ms linear",
              }
            : {}),
          padding: isContentEdit
            ? 0
            : isCallout
              ? `${CALLOUT_LABEL_PADDING_Y_PT * scale}px ${CALLOUT_LABEL_PADDING_X_PT * scale}px`
              : "2px 4px",
          boxSizing: "border-box",
          // contentText: the baseline shift below can push the first line's
          // descenders (p/g/y tails) past the box bottom — they must stay
          // visible, the box edge is just a visual frame around pinned text.
          overflow: isContentEdit ? "visible" : "hidden",
          // Baseline-anchored placement for contentText: shift the whole
          // content strip so the first line's CSS baseline lands on the
          // stored source baseline. transform (not padding) so a negative
          // shift also works.
          transform:
            baselineShiftPx !== null
              ? `translateY(${baselineShiftPx}px)`
              : undefined,
          font: fontShorthand,
          color: overlay.color,
          textAlign: overlay.align,
          // Mid-line selection start: CSS text-indent applies to the first
          // formatted line only — exactly the line that starts right of the
          // box edge in the source. COMMITTED render only: while editing,
          // the textarea is an inline-level child sitting on this div's
          // first line, so the indent would displace the WHOLE control
          // sideways (every line shifted, the bug behind "multi-line edits
          // jump right while typing"). The textarea keeps all lines flush
          // left; the indent applies again on commit and on export.
          textIndent:
            isContentEdit &&
            overlay.type === "contentText" &&
            overlay.firstLineIndentPt &&
            !editing
              ? overlay.firstLineIndentPt * scale
              : undefined,
          whiteSpace: isContentEdit ? "pre" : "pre-wrap",
          wordBreak: isContentEdit ? "normal" : "break-word",
          overflowWrap: isCallout ? "anywhere" : undefined,
          unicodeBidi: isCallout ? "plaintext" : undefined,
        }}
      >
        {editing ? (
          <textarea
            ref={textareaRef}
            autoFocus
            dir="auto"
            value={overlay.text}
            data-role="interactive"
            data-overlay-id={overlay.id}
            onChange={(e) => onDraftTextChange?.(e.currentTarget.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={(e) => {
              if (e.currentTarget.dataset.escapeCommitted === "true") return;
              if (isToolbarTextEditorForOverlay(overlay.id, e.relatedTarget)) {
                return;
              }
              if (onMaybeSuppressEditDragBlur(overlay.id, e.timeStamp)) {
                const textarea = e.currentTarget;
                window.requestAnimationFrame(() => textarea.focus());
                return;
              }
              onCommitEdit({
                text: e.currentTarget.value,
              } as Partial<TextOverlay | ContentTextOverlay | CalloutOverlay>);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.dataset.escapeCommitted = "true";
              onCommitEdit({
                text: e.currentTarget.value,
              } as Partial<TextOverlay | ContentTextOverlay | CalloutOverlay>);
            }}
            style={{
              width: "100%",
              // A textarea always clips at its own bounds, so the visible-
              // overflow fix above cannot save descenders while editing —
              // give the control bottom slack instead (transparent, no
              // border: the extra strip is invisible).
              height: isContentEdit ? "calc(100% + 1em)" : "100%",
              // text-indent inherits, and Chrome applies it to EVERY line of
              // a textarea (not just the first formatted line like the div
              // above) — zero it here. While editing a mid-line-start edit,
              // the first line sits flush left; the committed render and the
              // export use the real indent.
              textIndent: 0,
              border: "none",
              background: "transparent",
              outline: "none",
              resize: "none",
              font: "inherit",
              color: "inherit",
              textAlign: "inherit",
              padding: 0,
              overflow: "hidden",
              whiteSpace: "inherit",
            }}
            wrap={isContentEdit ? "off" : "soft"}
          />
        ) : overlay.text ? (
          <LiveRevealText
            text={overlay.text}
            reveal={reveal}
            shellRatio={isCallout ? 0.56 : 0.08}
          />
        ) : (
          <em style={{ color: T.dim2, fontStyle: "italic" }}>
            {placeholder}
          </em>
        )}
      </div>
      {isCallout ? (
        <>
          <span
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              font: `600 ${Math.round(sealSizePx * 0.46)}px/1 ${T.sans}`,
              letterSpacing: "0.01em",
              color: "rgba(255,253,247,0.97)",
              opacity: collapsed ? 1 : 0,
              transition: "opacity 140ms linear 60ms",
              pointerEvents: "none",
            }}
          >
            {sealGlyph ?? (
              <Ic.callout
                width={Math.round(sealSizePx * 0.46) + 1}
                height={Math.round(sealSizePx * 0.46) + 1}
              />
            )}
          </span>
          <CalloutDisclosure
            collapsed={collapsed}
            locked={overlay.locked === true}
            collapseLabel={collapseLabel}
            expandLabel={expandLabel}
            collapsedPointerRef={collapsedPointerRef}
            suppressExpandClickRef={suppressExpandClickRef}
            onPointerDown={onPointerDown}
            onCollapse={collapseCallout}
            onExpand={() => setCalloutCollapsed(overlay.id, false)}
          />
        </>
      ) : null}
      {selected && !editing && !overlay.locked && !isContentEdit && !collapsed ? (
        // contentText edits are pinned to the source glyphs they cover —
        // no move/resize/rotate handles (see OverlayLayer's move guard).
        <Handles
          width={p.width}
          height={p.height}
          onHandlePointerDown={(e, c) => onHandlePointerDown(e, overlay, c)}
          onRotateHandlePointerDown={
            isCallout
              ? undefined
              : (e) => onRotateHandlePointerDown(e, overlay)
          }
          rotateLabel={rotateLabel}
        />
      ) : null}
      {contentEditing && (editWarnings.overflow || editWarnings.missing > 0) ? (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 5,
            padding: "2px 8px",
            fontSize: 11,
            lineHeight: "16px",
            background: "rgba(146, 96, 12, 0.95)",
            color: "#fff",
            borderRadius: 4,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 11,
          }}
        >
          {[
            editWarnings.overflow
              ? t("overlays.contentTextOverflow")
              : null,
            editWarnings.missing > 0
              ? t("overlays.contentTextMissingGlyphs", {
                  count: editWarnings.missing,
                })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      ) : null}
    </div>
      {/* The card clips at its own bounds (overflow hidden drives the seal
          morph), so the conversation hangs below it as a sibling that copies
          the card's placement — including page rotation. */}
      {isCallout && !collapsed && !reveal && (selected || editing) ? (
        <CalloutThreadPanel
          overlay={overlay}
          left={p.left}
          top={p.top}
          width={p.width}
          height={p.height}
          rotateDeg={p.totalDeg}
          scale={scale}
          pageWidthPx={
            rotatedSize(page.widthPt, page.heightPt, page.rotation).width * scale
          }
          pageHeightPx={
            rotatedSize(page.widthPt, page.heightPt, page.rotation).height *
            scale
          }
          onAppend={(entry) =>
            onCommitEdit({
              thread: [...(overlay.thread ?? []), entry],
            } as Partial<CalloutOverlay>)
          }
          onReplaceThread={(thread) =>
            onCommitEdit({ thread } as Partial<CalloutOverlay>)
          }
        />
      ) : null}
    </>
  );
}

/**
 * One control for both states: a corner chevron on the open card, and the whole
 * face of the seal once collapsed. Keeping it a single node means focus simply
 * survives the toggle — no focus() choreography like the note precedent needs.
 */
function CalloutDisclosure({
  collapsed,
  locked,
  collapseLabel,
  expandLabel,
  collapsedPointerRef,
  suppressExpandClickRef,
  onPointerDown,
  onCollapse,
  onExpand,
}: {
  collapsed: boolean;
  locked: boolean;
  collapseLabel: string;
  expandLabel: string;
  collapsedPointerRef: RefObject<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>;
  suppressExpandClickRef: RefObject<boolean>;
  onPointerDown: (e: PointerEvent) => void;
  onCollapse: () => void;
  onExpand: () => void;
}) {
  const label = collapsed ? expandLabel : collapseLabel;
  return (
    <button
      type="button"
      className="shioriCalloutDisclosure"
      data-role="interactive"
      aria-label={label}
      aria-expanded={!collapsed}
      title={label}
      onPointerDown={(event) => {
        if (!collapsed) {
          // Keep the textarea focused until onClick has read its value, and
          // keep the gesture out of the move/resize machinery.
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        suppressExpandClickRef.current = false;
        if (!event.isPrimary || event.button !== 0) {
          collapsedPointerRef.current = null;
          event.stopPropagation();
          return;
        }
        collapsedPointerRef.current = locked
          ? null
          : {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              moved: false,
            };
        // Bubble into the normal overlay move path so rotation, snapping,
        // multi-selection and one-step Undo stay identical to the open card.
        onPointerDown(event);
      }}
      onPointerMove={(event) => {
        const gesture = collapsedPointerRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId) return;
        if (
          !gesture.moved &&
          Math.hypot(
            event.clientX - gesture.startX,
            event.clientY - gesture.startY,
          ) >= COLLAPSED_CALLOUT_DRAG_THRESHOLD_PX
        ) {
          gesture.moved = true;
          suppressExpandClickRef.current = true;
        }
        // Sub-threshold hand jitter must not reach OverlayLayer and start a
        // move; past the threshold this bubbles and the drag begins.
        if (!gesture.moved) event.stopPropagation();
      }}
      onPointerUp={(event) => {
        if (collapsedPointerRef.current?.pointerId === event.pointerId) {
          collapsedPointerRef.current = null;
        }
      }}
      onPointerCancel={(event) => {
        if (collapsedPointerRef.current?.pointerId === event.pointerId) {
          collapsedPointerRef.current = null;
        }
        suppressExpandClickRef.current = false;
      }}
      onLostPointerCapture={() => {
        collapsedPointerRef.current = null;
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (!collapsed) {
          onCollapse();
          return;
        }
        // Browsers may synthesize a click when pointer capture ends. Consume
        // only that one; keyboard activation (detail 0) must still expand.
        if (suppressExpandClickRef.current && event.detail !== 0) {
          suppressExpandClickRef.current = false;
          event.preventDefault();
          return;
        }
        suppressExpandClickRef.current = false;
        onExpand();
      }}
      style={{
        position: "absolute",
        ...(collapsed
          ? {
              inset: 0,
              width: "100%",
              height: "100%",
              borderRadius: "inherit",
              cursor: locked ? "pointer" : "grab",
              touchAction: "none",
            }
          : {
              top: 2,
              right: 2,
              width: 20,
              height: 20,
              borderRadius: 4,
              cursor: "pointer",
            }),
        display: "grid",
        placeItems: "center",
        padding: 0,
        border: "none",
        background: "transparent",
        color: "rgba(35,26,15,0.42)",
        zIndex: 2,
        // Disclosure is a presentation control, not a canvas gesture: it stays
        // operable even while the active tool makes overlays pointer-
        // transparent (the callout tool blanks the whole layer).
        pointerEvents: "auto",
      }}
    >
      {collapsed ? null : <Ic.collapse width={13} height={13} />}
    </button>
  );
}

function NoteOverlayDom({
  overlay,
  page,
  scale,
  selected,
  editing,
  interactivePointerEvents,
  onStartEdit,
  onCommitEdit,
  onPointerDown,
  onHandlePointerDown,
  onRotateHandlePointerDown,
  onMaybeSuppressEditDragBlur,
  now,
  noteAuthor,
  notePlaceholder,
  undatedLabel,
  relativeLabels,
  rotateLabel,
  collapseLabel,
  expandLabel,
  reveal,
}: {
  overlay: NoteOverlay;
  page: PageModel;
  scale: number;
  selected: boolean;
  editing: boolean;
  interactivePointerEvents: "auto" | "none";
  onStartEdit: () => void;
  onCommitEdit: (patch: Partial<Overlay>) => void;
  onPointerDown: (e: PointerEvent) => void;
  onHandlePointerDown: (
    e: PointerEvent,
    overlay: ResizableOverlay,
    corner: ResizeCorner,
  ) => void;
  onRotateHandlePointerDown: (e: PointerEvent, overlay: ResizableOverlay) => void;
  onMaybeSuppressEditDragBlur: (overlayId: string, now: number) => boolean;
  now: number;
  noteAuthor: string;
  notePlaceholder: string;
  undatedLabel: string;
  relativeLabels: RelativeLabels;
  rotateLabel: string;
  collapseLabel: string;
  expandLabel: string;
  reveal: ActiveLiveOverlayReveal | null;
}) {
  const collapsed = useEditorStore((state) =>
    state.collapsedNoteIds.includes(overlay.id),
  );
  const setNoteCollapsed = useEditorStore((state) => state.setNoteCollapsed);
  // The disclosure is a presentation control, not a canvas editing gesture.
  // Keep it operable even when the active drawing tool deliberately makes
  // existing overlays pointer-transparent. Reader mode is therefore not a
  // special case here: every genuine note owns the same disclosure affordance.
  const disclosurePointerEvents = "auto";
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const collapsedPointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressExpandClickRef = useRef(false);
  const previousPresentation = useRef({ collapsed, editing });
  useEffect(() => {
    const previous = previousPresentation.current;
    if (previous.collapsed !== collapsed) {
      (collapsed ? expandButtonRef.current : collapseButtonRef.current)?.focus();
    } else if (previous.editing && !editing && !collapsed) {
      // Escape commits the textarea first. Put focus on the disclosure
      // control so the next Escape predictably collapses this note instead of
      // falling through to the global reader-mode handler.
      collapseButtonRef.current?.focus();
    }
    previousPresentation.current = { collapsed, editing };
  }, [collapsed, editing]);

  const collapseNote = () => {
    if (editing) {
      const textarea = textareaRef.current;
      const text = textarea?.value ?? overlay.text;
      // Removing the focused editor can produce a trailing WebKit blur. The
      // click already performs the authoritative commit, so mark that blur as
      // consumed just like the existing Escape path does.
      if (textarea) textarea.dataset.escapeCommitted = "true";
      onCommitEdit({ text } as Partial<NoteOverlay>);
      // The normal editor contract removes an empty note on commit. Do not
      // leave a presentation-only tombstone for an overlay that no longer
      // exists.
      if (text.trim() === "") return;
    }
    setNoteCollapsed(overlay.id, true);
  };

  if (collapsed) {
    const sizePx = 30;
    const sizePt = sizePx / scale;
    const collapsedRect = {
      x: overlay.rect.x,
      y: overlay.rect.y + overlay.rect.h - sizePt,
      w: sizePt,
      h: sizePt,
    };
    const collapsedPlacement = boxPlacement(
      collapsedRect,
      overlay.angle ?? 0,
      page,
      scale,
    );
    return (
      <button
        ref={expandButtonRef}
        type="button"
        data-role="interactive"
        data-overlay-id={overlay.id}
        aria-label={expandLabel}
        aria-expanded={false}
        title={expandLabel}
        onPointerDown={(event) => {
          suppressExpandClickRef.current = false;
          if (!event.isPrimary || event.button !== 0) {
            collapsedPointerRef.current = null;
            event.stopPropagation();
            return;
          }
          if (!overlay.locked) {
            collapsedPointerRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              moved: false,
            };
            event.currentTarget.style.cursor = "grabbing";
          } else {
            collapsedPointerRef.current = null;
          }
          // Reuse the normal overlay move path so page rotation, snapping,
          // multi-selection, duplication and one-step Undo stay identical.
          onPointerDown(event);
        }}
        onPointerMove={(event) => {
          const gesture = collapsedPointerRef.current;
          if (!gesture || gesture.pointerId !== event.pointerId) return;
          if (
            !gesture.moved &&
            Math.hypot(
              event.clientX - gesture.startX,
              event.clientY - gesture.startY,
            ) >= COLLAPSED_NOTE_DRAG_THRESHOLD_PX
          ) {
            gesture.moved = true;
            suppressExpandClickRef.current = true;
          }
          // OverlayLayer must not see sub-threshold hand jitter; once the
          // threshold is crossed this event bubbles and starts the move.
          if (!gesture.moved) event.stopPropagation();
        }}
        onPointerUp={(event) => {
          if (collapsedPointerRef.current?.pointerId === event.pointerId) {
            collapsedPointerRef.current = null;
          }
          event.currentTarget.style.cursor = overlay.locked ? "pointer" : "grab";
        }}
        onPointerCancel={(event) => {
          if (collapsedPointerRef.current?.pointerId === event.pointerId) {
            collapsedPointerRef.current = null;
          }
          suppressExpandClickRef.current = false;
          event.currentTarget.style.cursor = overlay.locked ? "pointer" : "grab";
        }}
        onLostPointerCapture={(event) => {
          collapsedPointerRef.current = null;
          event.currentTarget.style.cursor = overlay.locked ? "pointer" : "grab";
        }}
        onClick={(event) => {
          event.stopPropagation();
          // Browsers may synthesize a click after pointer capture completes.
          // Consume only that pointer click; keyboard activation (detail=0)
          // must remain an accessible way to expand the note.
          if (suppressExpandClickRef.current && event.detail !== 0) {
            suppressExpandClickRef.current = false;
            event.preventDefault();
            return;
          }
          suppressExpandClickRef.current = false;
          setNoteCollapsed(overlay.id, false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          setNoteCollapsed(overlay.id, false);
        }}
        style={{
          position: "absolute",
          left: collapsedPlacement.left,
          top: collapsedPlacement.top,
          width: sizePx,
          height: sizePx,
          display: "grid",
          placeItems: "center",
          boxSizing: "border-box",
          padding: 0,
          border: selected
            ? `1px solid ${T.ink}`
            : "0.5px solid rgba(158,130,40,0.5)",
          borderRadius: 3,
          background: overlay.color,
          color: "#6f5b28",
          boxShadow: selected
            ? `0 0 0 1px ${T.surface}, 2px 3px 0 ${T.noteShadow}`
            : `2px 3px 0 ${T.noteShadow}`,
          transform: `rotate(${collapsedPlacement.totalDeg - 0.3}deg)`,
          transformOrigin: "center center",
          cursor: overlay.locked ? "pointer" : "grab",
          touchAction: "none",
          pointerEvents: disclosurePointerEvents,
        }}
      >
        <Ic.note aria-hidden />
      </button>
    );
  }

  const p = boxPlacement(overlay.rect, overlay.angle ?? 0, page, scale);
  // The note's aesthetic -0.3° lean folds into the total rotation so the
  // single center-anchored transform carries page rotation, free angle,
  // and the lean together (transformOrigin must be center for the others).
  return (
    <div
      data-role="interactive"
      data-overlay-id={overlay.id}
      data-live-reveal={reveal ? "note" : undefined}
      style={{
        position: "absolute",
        left: p.left,
        top: p.top,
        width: p.width,
        height: p.height,
        background: overlay.color,
        border: "0.5px solid rgba(158,130,40,0.4)",
        borderRadius: 2,
        padding: "10px 12px",
        font: `12.5px/1.45 ${T.sans}`,
        color: "#3a2f12",
        transform: `rotate(${p.totalDeg - 0.3}deg)`,
        transformOrigin: "center center",
        boxShadow: selected
          ? `0 0 0 1px ${T.ink}, 2px 3px 0 ${T.noteShadow}`
          : `2px 3px 0 ${T.noteShadow}`,
        boxSizing: "border-box",
        overflow: "hidden",
        cursor: overlay.locked ? "default" : "pointer",
        pointerEvents: interactivePointerEvents,
        ...(reveal
          ? {
              opacity: 0,
              animation: `shioriLiveSurfaceUnfold ${liveRevealAnimationDuration(reveal, 0.3)} cubic-bezier(.22,.8,.24,1) ${liveRevealAnimationDelay(reveal)} both`,
            }
          : {}),
      }}
      onPointerDown={onPointerDown}
      onDoubleClick={overlay.locked ? undefined : onStartEdit}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        collapseNote();
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          font: `500 10.5px/1 ${T.mono}`,
          color: "#7a6630",
          letterSpacing: ".04em",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {noteAuthor}
        </span>
        <span style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
          {(() => {
            const timestamp = noteDisplayTimestamp(overlay);
            return timestamp == null
              ? undatedLabel
              : formatRelative(timestamp, now, relativeLabels);
          })()}
        </span>
        <button
          ref={collapseButtonRef}
          type="button"
          data-role="interactive"
          aria-label={collapseLabel}
          aria-expanded={true}
          title={collapseLabel}
          onPointerDown={(event) => {
            // Retain textarea focus until onClick has synchronously captured
            // its current value. This also keeps the gesture out of the
            // overlay move/resize machinery.
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            collapseNote();
          }}
          style={{
            position: "relative",
            zIndex: 2,
            width: 30,
            height: 30,
            margin: -10,
            marginLeft: 4,
            padding: 0,
            display: "grid",
            placeItems: "center",
            flex: "0 0 auto",
            border: "0.5px solid rgba(122,102,48,0.2)",
            borderRadius: 3,
            background: "rgba(122,102,48,0.08)",
            color: "inherit",
            cursor: "pointer",
            pointerEvents: disclosurePointerEvents,
          }}
        >
          <Ic.collapse aria-hidden />
        </button>
      </div>
      {editing ? (
        <textarea
          ref={textareaRef}
          autoFocus
          defaultValue={overlay.text}
          data-role="interactive"
          onBlur={(e) => {
            if (e.currentTarget.dataset.escapeCommitted === "true") return;
            if (onMaybeSuppressEditDragBlur(overlay.id, e.timeStamp)) {
              const textarea = e.currentTarget;
              window.requestAnimationFrame(() => textarea.focus());
              return;
            }
            onCommitEdit({ text: e.currentTarget.value } as Partial<NoteOverlay>);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.dataset.escapeCommitted = "true";
            onCommitEdit({ text: e.currentTarget.value } as Partial<NoteOverlay>);
          }}
          style={{
            width: "100%",
            height: `calc(100% - 22px)`,
            border: "none",
            background: "transparent",
            outline: "none",
            resize: "none",
            font: "inherit",
            color: "inherit",
            padding: 0,
          }}
        />
      ) : (
        <span>
          {overlay.text ? (
            <LiveRevealText
              text={overlay.text}
              reveal={reveal}
              shellRatio={0.3}
            />
          ) : (
            <em style={{ color: "#a08845", fontStyle: "italic" }}>
              {notePlaceholder}
            </em>
          )}
        </span>
      )}
      {selected && !editing && !overlay.locked ? (
        <Handles
          width={p.width}
          height={p.height}
          onHandlePointerDown={(e, c) => onHandlePointerDown(e, overlay, c)}
          onRotateHandlePointerDown={(e) => onRotateHandlePointerDown(e, overlay)}
          rotateLabel={rotateLabel}
        />
      ) : null}
    </div>
  );
}

function BoxOverlayDom({
  overlay,
  page,
  scale,
  selected,
  interactivePointerEvents,
  onPointerDown,
  onHandlePointerDown,
  onRotateHandlePointerDown,
  rotateLabel,
}: {
  overlay: Extract<Overlay, { type: "rect" | "image" | "stamp" }>;
  page: PageModel;
  scale: number;
  selected: boolean;
  interactivePointerEvents: "auto" | "none";
  onPointerDown: (e: PointerEvent) => void;
  onHandlePointerDown: (
    e: PointerEvent,
    overlay: ResizableOverlay,
    corner: ResizeCorner,
  ) => void;
  onRotateHandlePointerDown: (e: PointerEvent, overlay: ResizableOverlay) => void;
  rotateLabel: string;
}) {
  // Box visual (border / stamp mark) is drawn in the SVG layer; this DOM
  // box is the hit-test + handle host. Center-anchor and rotate it so the
  // hit area and handles track the rotated box drawn in the SVG.
  const p = boxPlacement(overlay.rect, overlay.angle ?? 0, page, scale);
  return (
    <div
      data-role="interactive"
      data-overlay-id={overlay.id}
      style={{
        position: "absolute",
        left: p.left,
        top: p.top,
        width: p.width,
        height: p.height,
        transform: `rotate(${p.totalDeg}deg)`,
        transformOrigin: "center center",
        cursor: overlay.locked ? "default" : "move",
        pointerEvents: interactivePointerEvents,
      }}
      onPointerDown={onPointerDown}
    >
      {selected && !overlay.locked ? (
        <Handles
          width={p.width}
          height={p.height}
          onHandlePointerDown={(e, c) => onHandlePointerDown(e, overlay, c)}
          onRotateHandlePointerDown={(e) => onRotateHandlePointerDown(e, overlay)}
          rotateLabel={rotateLabel}
        />
      ) : null}
    </div>
  );
}

function unionDisplayRects(
  rects: Array<{ x: number; y: number; w: number; h: number }>,
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
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function isToolbarTextEditorForOverlay(
  overlayId: string,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const editor = target.closest<HTMLElement>("[data-shiori-text-toolbar-editor]");
  return editor?.dataset.overlayId === overlayId;
}

// Distance (px) the rotation handle floats above the box's top edge.
const ROTATE_HANDLE_OFFSET = 20;

// Visible handle sizes (px) — small and unobtrusive on the paper canvas.
// Round, not square: a hard-cornered outline reads as a dialog widget stamped
// on the page, while a disc with a hairline ring and a soft drop shadow sits on
// the paper the way the overlays themselves do.
const RESIZE_DOT_SIZE = 8;
const ROTATE_DOT_SIZE = 10;
const HANDLE_RING = `1px solid ${T.rule}`;
const HANDLE_SHADOW = "0 1px 2.5px rgba(35,26,15,0.28)";
// Finger-sized invisible hit target wrapped around each visible handle when
// the device has a coarse pointer. The dot stays the same size; only the
// touch-catching area grows, so desktop precision is untouched.
const TOUCH_HANDLE_HIT = 30;

function Handles({
  width,
  height,
  onHandlePointerDown,
  onRotateHandlePointerDown,
  rotateLabel,
}: {
  width: number;
  height: number;
  onHandlePointerDown: (e: PointerEvent, corner: ResizeCorner) => void;
  onRotateHandlePointerDown?: (e: PointerEvent) => void;
  rotateLabel?: string;
}) {
  const coarsePointer = useIsCoarsePointer();
  const dotStyle: CSSProperties = {
    width: RESIZE_DOT_SIZE,
    height: RESIZE_DOT_SIZE,
    background: T.surface,
    border: HANDLE_RING,
    borderRadius: "50%",
    boxShadow: HANDLE_SHADOW,
  };
  // Corner anchor points in the box's local (unrotated) coordinate space.
  const corners: Array<{
    key: "nw" | "ne" | "sw" | "se";
    cx: number;
    cy: number;
    cursor: string;
  }> = [
    { key: "nw", cx: 0, cy: 0, cursor: "nwse-resize" },
    { key: "ne", cx: width, cy: 0, cursor: "nesw-resize" },
    { key: "sw", cx: 0, cy: height, cursor: "nesw-resize" },
    { key: "se", cx: width, cy: height, cursor: "nwse-resize" },
  ];
  return (
    <>
      {onRotateHandlePointerDown ? (
        <>
          {/* Connector line from top-center up to the rotation handle. Both
              are children of the rotated box, so they rotate with it for
              free — the handle always floats "above" the box's current
              top edge regardless of the element/page angle. */}
          <div
            data-overlay-rotate-connector="true"
            style={{
              position: "absolute",
              left: width / 2 - 0.5,
              top: -ROTATE_HANDLE_OFFSET,
              width: 1,
              height: ROTATE_HANDLE_OFFSET,
              background: T.rule,
              pointerEvents: "none",
            }}
          />
          <HandleHit
            center={{ x: width / 2, y: -ROTATE_HANDLE_OFFSET }}
            coarse={coarsePointer}
            cursor="grab"
            rotateHandle
            ariaLabel={rotateLabel}
            title={rotateLabel}
            onPointerDown={onRotateHandlePointerDown}
          >
            <div
              aria-hidden
              style={{
                width: ROTATE_DOT_SIZE,
                height: ROTATE_DOT_SIZE,
                background: T.surface,
                border: HANDLE_RING,
                borderRadius: "50%",
                boxShadow: HANDLE_SHADOW,
              }}
            />
          </HandleHit>
        </>
      ) : null}
      {corners.map((c) => (
        <HandleHit
          key={c.key}
          center={{ x: c.cx, y: c.cy }}
          coarse={coarsePointer}
          cursor={c.cursor}
          resizeCorner={c.key}
          onPointerDown={(e) => onHandlePointerDown(e, c.key)}
        >
          <div aria-hidden style={dotStyle} />
        </HandleHit>
      ))}
    </>
  );
}

// One selection handle. Renders the small visible glyph (children) centered on
// `center`; on a coarse pointer it wraps that glyph in a larger transparent
// hit target (also centered) so a finger can grab it. On a fine pointer the
// interactive box hugs the glyph exactly, preserving the original desktop
// precision. The flex centering keeps the visible glyph pinned on the anchor
// point at either size, so positions never shift between input types.
function HandleHit({
  center,
  coarse,
  cursor,
  resizeCorner,
  rotateHandle,
  ariaLabel,
  title,
  onPointerDown,
  children,
}: {
  center: { x: number; y: number };
  coarse: boolean;
  cursor: string;
  resizeCorner?: ResizeCorner;
  rotateHandle?: boolean;
  ariaLabel?: string;
  title?: string;
  onPointerDown: (e: PointerEvent) => void;
  children: ReactNode;
}) {
  const size = coarse ? TOUCH_HANDLE_HIT : undefined;
  return (
    <div
      data-role="interactive"
      data-resize-corner={resizeCorner}
      data-rotate-handle={rotateHandle ? "true" : undefined}
      aria-label={ariaLabel}
      title={title}
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        left: coarse ? center.x - TOUCH_HANDLE_HIT / 2 : center.x,
        top: coarse ? center.y - TOUCH_HANDLE_HIT / 2 : center.y,
        width: size,
        height: size,
        transform: coarse ? undefined : "translate(-50%, -50%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // Transparent on coarse so only the glyph is visible; the hit area
        // around it is invisible but catches the touch.
        background: "transparent",
        cursor,
        touchAction: "none",
      }}
    >
      {children}
    </div>
  );
}
