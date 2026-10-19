import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { nanoid } from "nanoid";
import type {
  CalloutOverlay,
  ContentTextOverlay,
  HighlightOverlay,
  OverlayTextAnchor,
  PageModel,
  TextOverlay,
} from "../../pdf/model/types";
import {
  CALLOUT_POINT_TARGET_PT,
  CALLOUT_TARGET_OPACITY,
  createCalloutOverlay,
} from "../../pdf/model/callout";
import type { PdfDocument as PDFDocumentProxy } from "../../pdf/engine/types";
import type { PdfPageTextContent } from "../../pdf/engine/text";
import { appPdfEngine } from "../../pdf/engine/appEngine";
import { ShioriTextLayer } from "../../pdf/render/textLayer";
import { pdfRectToDisplay, rotatedSize } from "../../pdf/geometry/coords";
import { T } from "../../design/tokens";
import { selectionMarkupPopupEnabled } from "./selectionMarkupGate";
import {
  useAppStore,
  useEditorStore,
  useEditorStoreApi,
  type PdfEditorStoreApi,
} from "../store/store";
import {
  type DisplayRect,
  type TextRunDisplayBounds,
  clientRectsToDisplayRects,
  clipSnappedRectsToGesture,
  displayRectsToPdfRects,
  filterDistantClusters,
  snapDisplayRectsToTextRuns,
  textContentToDisplayTextRuns,
} from "../textSelection/highlightRects";
import { substituteAbsorbedText } from "../textSelection/absorbText";
import {
  dominantSourceFontName,
  normalizeBaseFontName,
} from "../textSelection/sourceFontName";
import {
  detectParagraphs,
  lineDisplayRect,
  paragraphLineText,
  type DetectedParagraph,
} from "../textSelection/paragraphDetect";
import { buildSemanticTextLayerModel } from "../textSelection/semanticText";
import {
  recordTextEditDebug,
  type TextEditDebugPayload,
} from "../textSelection/textEditDebug";
import { applyHighlightGesture } from "../highlights/merge";
import { mapTextContentGlyphs } from "../textSelection/glyphGeometry";
import { glyphCaretAtPoint, markupRectsForRange, type GlyphCaret, type MarkupTextGeometry } from "../textSelection/markupSelection";
import { toast } from "../toast";
import {
  searchOffsetFromDisplayRects,
  searchViewportForElement,
  shouldScrollToSearchRects,
} from "../search/navigation";
import {
  SelectionMarkupPopup,
  type SelectionMarkupType,
} from "./SelectionMarkupPopup";
import {
  prefersReducedLiveOverlayMotion,
  prepareLiveOverlayRevealBatch,
} from "../../live/overlayReveal";
import {
  type CoverEdgeSafety,
  type Point,
  type SelectedTextRun,
  type SemanticCopyLayerModel,
  type TextGesture,
  type TextMarkupType,
  type TextRunGeometryLayerModel,
  buildSemanticClipboardText,
  contentTextEditRect,
  contentTextFirstLineIndentPt,
  displayRectsFromSelectedRunTexts,
  dominantCssFontFamily,
  expandPdfRectSides,
  filterSelectedRunTexts,
  hasActiveTextSelection,
  inferContentTextStyle,
  isBlankTextClick,
  isPdfTextTarget,
  isPurePdfTextSelection,
  isSpuriousFullLayerSelection,
  pdfRectsOverlap,
  rangeIntersectsNode,
  roundDebug,
  safeCompare,
  samplePageColors,
  searchHighlightDisplayRects,
  selectedRunRectsWithEdges,
  selectedTextFromRunTexts,
  selectedTextFromSelection,
  selectedTextRunsForDisplayRects,
  selectedTextRunsForRange,
  sourceBaselinesFromRuns,
  summarizeClientRect,
  summarizeContentTextOverlay,
  summarizeDisplayRect,
  summarizeGesture,
  summarizePdfRect,
  summarizeSelectedTextRun,
  summarizeTextRun,
  textBoxDisplayRect,
  textGestureDistance,
  textMarkupDefaults,
  trimSelectedRunTextsToGesture,
} from "./textHighlightGeometry";

// Everything the page-level build produced that a scale change can reuse.
type TextLayerBuild = {
  page: PageModel;
  textContent: PdfPageTextContent;
  textLayer: ShioriTextLayer;
  fontNames: Map<string, string>;
  glyphs: MarkupTextGeometry["glyphs"];
  scale: number;
};

type Props = {
  doc: PDFDocumentProxy;
  page: PageModel;
  pageIndex: number;
  scale: number;
  layerScale: number;
};

// Viewport-space rectangle (CSS px) bounding the live text selection, used
// to anchor the floating markup popover above/below it.
type SelectionPopupAnchor = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
type PreviewDrag = { start: Point; current: Point };
type TextLayerStyle = CSSProperties & {
  "--total-scale-factor": string;
  "--scale-round-x": string;
  "--scale-round-y": string;
  // Tint for the native ::selection inside this text layer. See app.css.
  "--shiori-selection-tint"?: string;
};

type ContentTextEditDebugDraft = Pick<TextEditDebugPayload, "selection">;

// Cover-rect padding around the selected glyph cells. The full pad soaks up
// antialiasing fringes and ink that slightly overhangs the selection at
// line/whitespace boundaries. At a MID-WORD cut edge the full pad would
// paint over the neighbouring glyph's ink and leave a clipped sliver of it
// on screen AND in the export ("foundation-m|odel" rendered as
// "foundation-m ːdel"), so cut edges get only a hairline pad.
const CONTENT_TEXT_COVER_PAD_PT = 0.8;
const CONTENT_TEXT_COVER_CUT_EDGE_PAD_PT = 0.15;

function TextHighlightLayerImpl({
  doc,
  page,
  pageIndex,
  scale,
  layerScale,
}: Props) {
  const { t } = useTranslation();
  const editorStore = useEditorStoreApi();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const semanticCopyRef = useRef<SemanticCopyLayerModel | null>(null);
  const textRunGeometryRef = useRef<TextRunGeometryLayerModel | null>(null);
  const markupGeometryRef = useRef<MarkupTextGeometry | null>(null);
  const glyphDragRef = useRef<(GlyphCaret & { point: Point }) | null>(null);
  const glyphDragFrameRef = useRef<number | null>(null);
  const [markupPreviewRects, setMarkupPreviewRects] = useState<DisplayRect[]>([]);
  const dragStartRef = useRef<Point | null>(null);
  const textGestureRef = useRef<TextGesture | null>(null);
  const textGestureCurrentRef = useRef<Point | null>(null);
  const [previewDrag, setPreviewDrag] = useState<PreviewDrag | null>(null);
  const [debugParagraphs, setDebugParagraphs] = useState<DetectedParagraph[]>(
    [],
  );
  // Detected paragraph blocks for the current page render — drives the
  // click-to-edit-paragraph gesture (and the debug overlay above).
  const paragraphsRef = useRef<DetectedParagraph[]>([]);
  // Last "paragraph edit refused" toast, to keep repeated clicks on the
  // same refused block from stacking identical toasts.
  const refusalToastAtRef = useRef(0);
  const [contentSelectionPreviewRects, setContentSelectionPreviewRects] =
    useState<DisplayRect[]>([]);
  const [textSelectionActive, setTextSelectionActive] = useState(false);
  const [hasTextRuns, setHasTextRuns] = useState(false);
  const [searchMatchRects, setSearchMatchRects] = useState<DisplayRect[]>([]);
  // Viewport-space anchor for the selection markup popover. Non-
  // null only while a non-empty native text selection lives inside THIS
  // page's text layer, this page owns the popover (see the recompute effect
  // for the single-owner rule), and the select tool is active. The popover
  // floats above the selection and offers highlight / underline /
  // strikethrough; `crossPage` flags a selection spanning multiple pages,
  // where markup is unsupported and the popover only shows a hint.
  const [selectionPopup, setSelectionPopup] = useState<{
    anchor: SelectionPopupAnchor;
    crossPage: boolean;
  } | null>(null);
  const tool = useEditorStore((s) => s.tool);
  const commit = useEditorStore((s) => s.commit);
  const addOverlay = useEditorStore((s) => s.addOverlay);
  const selectOnly = useEditorStore((s) => s.selectOnly);
  const setEditingOverlayId = useEditorStore((s) => s.setEditingOverlayId);
  const setActivePage = useEditorStore((s) => s.setActivePage);
  const goToPage = useEditorStore((s) => s.goToPage);
  const annotDefaults = useAppStore((s) => s.annotDefaults);
  const textDefaults = useEditorStore((s) => s.textDefaults);
  const searchMatchHighlight = useEditorStore((s) => s.searchMatchHighlight);
  const textMarkupType: TextMarkupType | null =
    tool === "highlight" || tool === "underline" || tool === "strikethrough"
      ? tool
      : null;
  const contentTextEditEnabled = tool === "text";
  const calloutEnabled = tool === "callout";
  const selectionEnabled =
    tool === "select" ||
    textMarkupType !== null ||
    calloutEnabled ||
    contentTextEditEnabled;
  const createsTextMarkup = textMarkupType !== null || calloutEnabled;
  const size = rotatedSize(page.widthPt, page.heightPt, page.rotation);
  const pageWidthPx = size.width * layerScale;
  const pageHeightPx = size.height * layerScale;
  const transformScale = layerScale !== scale ? scale / layerScale : 1;
  // Colour the native text selection with the colour the active tool will
  // actually apply.
  //
  // The drag preview below already draws in the tool's colour, but only when
  // there is NO real text selection — it is the fallback for pages with no
  // text layer. On any ordinary text PDF the ONLY feedback during a drag was
  // the browser's ::selection, hardcoded to the app accent, so arming the
  // highlighter and dragging showed blue and never the highlight colour.
  // Shiori picks the tool (and therefore the colour) BEFORE the drag, so that
  // information exists and was simply being hidden.
  //
  // Only for tools that mark up text; the plain select tool keeps the accent,
  // which is the right signal for "selecting", not "about to apply colour".
  const selectionTint = calloutEnabled
    ? annotDefaults.calloutColor
    : textMarkupType !== null
      ? textMarkupDefaults(textMarkupType, annotDefaults).color
      : undefined;

  const textLayerStyle: TextLayerStyle = {
    position: "absolute",
    inset: 0,
    width: pageWidthPx,
    height: pageHeightPx,
    transform: transformScale !== 1 ? `scale(${transformScale})` : undefined,
    transformOrigin: "top left",
    "--total-scale-factor": String(layerScale),
    "--scale-round-x": "1px",
    "--scale-round-y": "1px",
    ...(selectionTint ? { "--shiori-selection-tint": selectionTint } : {}),
  };

  // The page build below — the page's text content, glyph outlines, font
  // registration, the semantic copy model — depends on the
  // page, not on the scale. It used to be keyed on layerScale too, so every
  // zoom commit re-ran all of it for every mounted page: several hundred ms
  // of engine work per pinch release, during which text could not be
  // selected and links were dead. A scale change now re-lays the existing
  // spans in place (TextLayer.update) and re-derives the display-space
  // geometry from the cached content.
  const buildRef = useRef<TextLayerBuild | null>(null);
  const layerScaleRef = useRef(layerScale);
  useEffect(() => {
    layerScaleRef.current = layerScale;
  }, [layerScale]);

  const deriveDisplayGeometry = useCallback(
    (build: TextLayerBuild, scaleValue: number) => {
      const textRuns = textContentToDisplayTextRuns(
        build.textContent,
        build.page,
        scaleValue,
        build.fontNames,
      );
      const textDivs = build.textLayer.textDivs;
      if (textRuns.length === textDivs.length) {
        textRunGeometryRef.current = { textDivs, textRuns };
        markupGeometryRef.current = {
          textDivs,
          textRuns,
          scale: scaleValue,
          glyphs: build.glyphs,
        };
      } else {
        textRunGeometryRef.current = null;
        markupGeometryRef.current = null;
      }
      // Paragraph blocks (plan: PLAN-PARAGRAPH-CONTENT-TEXT-2026-07.md):
      // click-to-edit consumes the high-confidence ones; the debug overlay
      // (localStorage.setItem("shioriDebugParagraphs", "1")) outlines all.
      paragraphsRef.current = detectParagraphs(
        textRuns.filter((r): r is TextRunDisplayBounds => r !== null),
        scaleValue,
      );
      if (window.localStorage?.getItem("shioriDebugParagraphs") === "1") {
        setDebugParagraphs(paragraphsRef.current);
      }
    },
    [],
  );
  const applyLayerScale = useCallback(
    (build: TextLayerBuild, scaleValue: number) => {
      if (build.scale === scaleValue) return;
      build.scale = scaleValue;
      build.textLayer.update({ viewport: { scale: scaleValue } });
      deriveDisplayGeometry(build, scaleValue);
    },
    [deriveDisplayGeometry],
  );

  useEffect(() => {
    let cancelled = false;
    let textLayer: ShioriTextLayer | null = null;
    let cleanupSelectionShim: (() => void) | null = null;
    const container = rootRef.current;
    if (!container) return;
    container.replaceChildren();
    buildRef.current = null;
    semanticCopyRef.current = null;
    textRunGeometryRef.current = null;
    markupGeometryRef.current = null;
    paragraphsRef.current = [];
    setHasTextRuns(false);
    // The scale this build lays out at; a zoom that commits while the page
    // is still loading is applied once the build lands.
    const builtScale = layerScaleRef.current;

    const onCopy = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !event.clipboardData) return;
      const selection = window.getSelection();
      const semanticLayer = semanticCopyRef.current;
      if (!selection || !semanticLayer || selection.isCollapsed || selection.rangeCount === 0) {
        return;
      }
      if (!isPurePdfTextSelection(selection, container)) return;
      const semanticText = buildSemanticClipboardText(selection, semanticLayer);
      if (semanticText === null) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", semanticText);
    };
    document.addEventListener("copy", onCopy);

    (async () => {
      const text = await appPdfEngine.pageText(doc, page.sourceIndex, {
        checkAbort: () => {
          if (cancelled) throw new Error("Text layer rendering was cancelled");
        },
      });
      if (cancelled) return;
      const textContent = text.content;
      const semanticModel = buildSemanticTextLayerModel(textContent);
      // The measuring canvas uses the page's language too. Inheriting the
      // UI's zh/ja locale here can pick a different generic font in WebKit.
      container.lang = textContent.lang ?? "";
      textLayer = new ShioriTextLayer({
        content: textContent,
        container,
        viewport: {
          scale: builtScale,
          rotation: page.rotation,
          pageX: page.originXPt ?? 0,
          pageY: page.originYPt ?? 0,
          pageWidth: page.widthPt,
          pageHeight: page.heightPt,
        },
      });
      await textLayer.render();
      if (cancelled) return;
      const fontNames = text.fontNames;
      registerLoadedPdfFontFaces(editorStore, fontNames, text.faceFamilies, textContent);
      setHasTextRuns(textLayer.textDivs.length > 0);
      const textDivs = textLayer.textDivs;
      if (semanticModel.textDivCount === textLayer.textDivs.length) {
        semanticCopyRef.current = {
          ...semanticModel,
          textDivs,
        };
      }
      const build: TextLayerBuild = {
        page,
        textContent,
        textLayer,
        fontNames,
        glyphs: text.glyphs ? mapTextContentGlyphs(textContent, text.glyphs) : undefined,
        scale: builtScale,
      };
      buildRef.current = build;
      if (layerScaleRef.current !== builtScale) {
        applyLayerScale(build, layerScaleRef.current);
      } else {
        deriveDisplayGeometry(build, builtScale);
      }
      const endOfContent = document.createElement("div");
      endOfContent.className = "endOfContent";
      container.append(endOfContent);
      cleanupSelectionShim = installSelectionEndShim(
        container,
        endOfContent,
        setTextSelectionActive,
      );
    })().catch((err) => {
      if (cancelled) return;
      console.error("text layer render failed", err);
    });

    return () => {
      cancelled = true;
      cleanupSelectionShim?.();
      textLayer?.cancel();
      buildRef.current = null;
      semanticCopyRef.current = null;
      textRunGeometryRef.current = null;
      markupGeometryRef.current = null;
      paragraphsRef.current = [];
      document.removeEventListener("copy", onCopy);
      container.replaceChildren();
    };
  }, [applyLayerScale, deriveDisplayGeometry, doc, editorStore, page]);

  // A zoom commit: same page, new scale. Re-lay the spans where they are.
  useEffect(() => {
    const build = buildRef.current;
    if (build) applyLayerScale(build, layerScale);
  }, [applyLayerScale, layerScale]);

  useEffect(() => {
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const root = rootRef.current;
      const geometry = markupGeometryRef.current;
      const selection = window.getSelection();
      const rects: DisplayRect[] = [];
      if (selectionEnabled && !contentTextEditEnabled && root && geometry && selection && !selection.isCollapsed) {
        const rootRect = root.getBoundingClientRect();
        for (let i = 0; i < selection.rangeCount; i += 1) {
          rects.push(...markupRectsForRange(selection.getRangeAt(i), geometry, page, scale, rootRect));
        }
      }
      setMarkupPreviewRects(rects);
    };
    const schedule = () => { if (frame === null) frame = window.requestAnimationFrame(update); };
    const endDrag = () => {
      glyphDragRef.current = null;
      if (glyphDragFrameRef.current !== null) window.cancelAnimationFrame(glyphDragFrameRef.current);
      glyphDragFrameRef.current = null;
    };
    document.addEventListener("pointerup", endDrag);
    document.addEventListener("pointercancel", endDrag);
    document.addEventListener("selectionchange", schedule);
    schedule();
    return () => {
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerup", endDrag);
      document.removeEventListener("pointercancel", endDrag);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (glyphDragFrameRef.current !== null) window.cancelAnimationFrame(glyphDragFrameRef.current);
      glyphDragFrameRef.current = null;
      glyphDragRef.current = null;
    };
  }, [contentTextEditEnabled, hasTextRuns, page, scale, selectionEnabled]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (searchMatchHighlight?.pageId !== page.id) {
        setSearchMatchRects([]);
        return;
      }
      const root = rootRef.current;
      const semanticLayer = semanticCopyRef.current;
      if (!root || !semanticLayer) {
        setSearchMatchRects([]);
        return;
      }

      const rootRect = root.getBoundingClientRect();
      const displayRects = searchHighlightDisplayRects(
        searchMatchHighlight.charStart,
        searchMatchHighlight.charEnd,
        semanticLayer,
        rootRect,
        pageWidthPx,
        pageHeightPx,
      );
      const pdfRects = displayRectsToPdfRects(displayRects, page, scale);
      setSearchMatchRects(
        pdfRects.map((rect) =>
          pdfRectToDisplay(rect, page.widthPt, page.heightPt, page.rotation, scale),
        ),
      );
      const offsetY = searchOffsetFromDisplayRects(displayRects);
      const needsScroll = shouldScrollToSearchRects({
        displayRects,
        pageRect: rootRect,
        viewportRect: searchViewportForElement(root),
      });
      if (offsetY != null && needsScroll) goToPage(page.id, pageIndex, offsetY);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    goToPage,
    hasTextRuns,
    page,
    pageHeightPx,
    pageIndex,
    pageWidthPx,
    scale,
    searchMatchHighlight,
  ]);

  // Track the live native text selection so the markup popover
  // can float above it. Only surfaces under the select tool — the markup
  // tools already commit on pointer-up, so a popover there would be
  // redundant and could double-apply. Recomputes on selectionchange and on
  // scroll/resize (the page moves under a fixed-position popover) and clears
  // the anchor when the selection collapses, leaves this page, or the tool
  // changes. All state writes go through the rAF-scheduled recompute so none
  // run synchronously in the effect body.
  useEffect(() => {
    let frame = 0;
    const recompute = () => {
      const root = rootRef.current;
      const selection = window.getSelection();
      if (
        !selectionMarkupPopupEnabled(tool) ||
        !root ||
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0
      ) {
        setSelectionPopup(null);
        return;
      }
      // A selection can span several mounted pages, and every page layer it
      // touches runs this same recompute — without a single-owner rule each
      // would float its own popover. Owner = the layer containing the
      // selection focus (where the gesture ended), falling back to the last
      // intersecting layer in document order; every instance derives the
      // same answer from the shared DOM, so exactly one renders the popover.
      const intersectingLayers = Array.from(
        document.querySelectorAll(".shioriTextLayer"),
      ).filter((layer) => {
        for (let i = 0; i < selection.rangeCount; i += 1) {
          if (rangeIntersectsNode(selection.getRangeAt(i), layer)) return true;
        }
        return false;
      });
      const ownerLayer =
        intersectingLayers.find((layer) => layer.contains(selection.focusNode)) ??
        intersectingLayers[intersectingLayers.length - 1];
      if (ownerLayer !== root) {
        setSelectionPopup(null);
        return;
      }
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (let i = 0; i < selection.rangeCount; i += 1) {
        const range = selection.getRangeAt(i);
        if (!rangeIntersectsNode(range, root)) continue;
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width <= 0 && rect.height <= 0) continue;
          left = Math.min(left, rect.left);
          top = Math.min(top, rect.top);
          right = Math.max(right, rect.right);
          bottom = Math.max(bottom, rect.bottom);
        }
      }
      if (!Number.isFinite(left)) {
        setSelectionPopup(null);
        return;
      }
      setSelectionPopup({
        anchor: { left, top, right, bottom },
        crossPage: intersectingLayers.length > 1,
      });
    };
    const scheduleRecompute = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(recompute);
    };
    // Always schedule one deferred recompute so a tool change away from
    // select clears any stale anchor. Only wire the live listeners while the
    // select tool is active to avoid per-page selection/scroll work in every
    // other tool mode.
    scheduleRecompute();
    if (tool !== "select") {
      return () => window.cancelAnimationFrame(frame);
    }
    document.addEventListener("selectionchange", scheduleRecompute);
    window.addEventListener("scroll", scheduleRecompute, true);
    window.addEventListener("resize", scheduleRecompute);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", scheduleRecompute);
      window.removeEventListener("scroll", scheduleRecompute, true);
      window.removeEventListener("resize", scheduleRecompute);
    };
  }, [tool, page.id, scale]);

  // Selection text longer than this is skipped as an anchor: a quote is a
  // re-anchoring needle, and a multi-page-sized needle helps nobody while
  // bloating every draft save and export.
  const MAX_SELECTION_ANCHOR_QUOTE_CHARACTERS = 2048;

  // Anchor provenance for an in-app selection: the selected text plus the
  // 1-based page number. No occurrence — an honest page-local count is not
  // available at selection time, and OverlayTextAnchor treats it as optional
  // for exactly this producer.
  const selectionAnchor = (quote: string): OverlayTextAnchor | undefined => {
    const trimmed = quote.trim();
    if (
      !trimmed ||
      trimmed.length > MAX_SELECTION_ANCHOR_QUOTE_CHARACTERS
    ) {
      return undefined;
    }
    const pageNumber =
      editorStore.getState().model.pages.findIndex((p) => p.id === page.id) + 1;
    if (pageNumber < 1) return undefined;
    return { quote: trimmed, page: pageNumber };
  };

  const addTextMarkup = (
    type: TextMarkupType,
    rects: HighlightOverlay["rects"],
    anchor?: OverlayTextAnchor,
  ) => {
    if (rects.length === 0) return;
    const { model } = editorStore.getState();
    const style = textMarkupDefaults(type, annotDefaults);
    const result = applyHighlightGesture({
      type,
      overlays: model.overlays,
      pageId: page.id,
      rects,
      color: style.color,
      opacity: style.opacity,
      makeId: nanoid,
      anchor,
    });
    if (!result.changed) return;
    commit({ overlays: result.overlays });
    selectOnly(result.selectedId);
  };

  const addCallout = (
    targetRects: CalloutOverlay["targetRects"],
    anchor?: OverlayTextAnchor,
  ): boolean => {
    if (targetRects.length === 0) return false;
    const state = editorStore.getState();
    // Body-text line boxes let the label pick a spot that does not sit on the
    // page's own text. paragraphsRef is the right source: textRunGeometryRef
    // can legitimately stay null on a page that does have text, and ~60 line
    // boxes beat ~2000 run boxes for a coverage test. Recomputed per callout
    // (~12µs, three orders below the commit + re-render that follows).
    // layerScale, not scale: paragraphsRef is built at layerScale, and the two
    // differ mid-pinch. An empty list means "unknown", and placement then
    // behaves exactly as it did before this existed.
    const textRects = displayRectsToPdfRects(
      paragraphsRef.current.flatMap((paragraph) =>
        paragraph.lines.map(lineDisplayRect),
      ),
      page,
      layerScale,
    );
    const overlay = createCalloutOverlay({
      id: nanoid(),
      page,
      targetRects,
      color: annotDefaults.calloutColor,
      occupiedRects: state.model.overlays.flatMap((existing) =>
        existing.pageId === page.id && existing.type === "callout"
          ? [existing.rect]
          : [],
      ),
      textRects,
    });
    if (anchor) overlay.anchor = anchor;
    const prepared = state.prepareCommit({
      overlays: [...state.model.overlays, overlay],
    });
    const reveal =
      useAppStore.getState().prefs.annotationAnimations &&
      !prefersReducedLiveOverlayMotion()
        ? prepareLiveOverlayRevealBatch(`local-callout-${overlay.id}`, [overlay])
        : null;
    if (
      !state.commitPrepared(prepared, {
        liveOverlayReveal: reveal,
        selectedIds: [overlay.id],
      })
    ) {
      return false;
    }
    setEditingOverlayId(overlay.id);
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>(
          `.shioriOverlayLayer textarea[data-overlay-id="${overlay.id}"]`,
        )
        ?.focus();
    });
    return true;
  };

  // Click-to-edit-paragraph (plan: PLAN-PARAGRAPH-CONTENT-TEXT-2026-07.md):
  // a plain single click on text inside a HIGH-confidence detected block
  // turns the whole block into one contentText edit. Low-confidence blocks
  // are not clickable — refusing beats guessing. Drag/double-click keep the
  // legacy sub-line selection path.
  const tryParagraphEditAtPoint = (
    gesture: TextGesture | null,
    end: Point,
    // The pointerup event's timeStamp — clock source for toast rate
    // limiting (the render-purity lint bars Date.now() in this closure).
    eventTimeMs: number,
  ): boolean => {
    const trace = (reason: string) => {
      // Same opt-in flag as the block overlay — rejected clicks are normal
      // (blank areas, low-confidence blocks), only worth tracing when
      // debugging detection.
      if (window.localStorage?.getItem("shioriDebugParagraphs") === "1") {
        console.debug(`[shiori:paragraph] click rejected: ${reason}`, {
          end,
          clickCount: gesture?.clickCount,
          blocks: paragraphsRef.current.length,
        });
      }
      return false;
    };
    if (!contentTextEditEnabled) return trace("tool");
    if (!gesture || !gesture.startedOnText) return trace("not on text");
    // Chrome reports UIEvent.detail = 0 on pointerdown, so 0 and 1 both mean
    // "plain click"; only an explicit multi-click (word/line select) opts out.
    if (gesture.clickCount > 1) return trace(`clickCount ${gesture.clickCount}`);
    if (textGestureDistance(gesture, end) >= 4) return trace("moved");
    if (hasActiveTextSelection(rootRef.current)) return trace("has selection");
    const pointInBlock = (candidate: DetectedParagraph) =>
      end.x >= candidate.rect.x - 2 &&
      end.x <= candidate.rect.x + candidate.rect.w + 2 &&
      end.y >= candidate.rect.y - 2 &&
      end.y <= candidate.rect.y + candidate.rect.h + 2;
    const block = paragraphsRef.current.find(
      (candidate) => candidate.confidence === "high" && pointInBlock(candidate),
    );
    if (!block) {
      // Refusing beats guessing, but refusing SILENTLY reads as "broken".
      // When the click landed on a detected-but-refused block, say why and
      // point at the path that still works (drag-select a range).
      const refused = paragraphsRef.current.find(pointInBlock);
      if (refused) {
        if (eventTimeMs - refusalToastAtRef.current > 2500) {
          refusalToastAtRef.current = eventTimeMs;
          toast.show(
            refused.hasMathFont
              ? t("toast.paragraphEditMathRefused")
              : t("toast.paragraphEditComplexRefused"),
          );
        }
        return trace(`refused block: ${refused.reasons.join("; ")}`);
      }
      return trace("no block at point");
    }
    console.debug("[shiori:paragraph] click hit block", block.rect);

    const displayRects: DisplayRect[] = block.lines.map(lineDisplayRect);
    const rects = displayRectsToPdfRects(displayRects, page, scale);
    if (rects.length !== displayRects.length) return false;
    const text = block.lines
      .map((line) => paragraphLineText(line, scale))
      .join("\n");
    if (text.trim() === "") return false;
    addContentTextEdit(
      rects,
      text,
      block.lines.flatMap((line) => line.runs),
      displayRects,
    );
    return true;
  };

  const addContentTextEdit = (
    rects: ContentTextOverlay["coverRects"],
    text: string,
    selectedRuns: TextRunDisplayBounds[],
    displayRects: DisplayRect[],
    coverEdges?: CoverEdgeSafety[],
    debug?: ContentTextEditDebugDraft,
  ) => {
    if (rects.length === 0 || text.trim() === "") return;
    const sampledColors = samplePageColors(rootRef.current, displayRects);
    const inferredStyle = inferContentTextStyle(
      selectedRuns,
      rects,
      textDefaults,
    );
    // Edge flags are in display reading order; PDF-space left/right only
    // lines up with that at rotation 0 — rotated pages keep the uniform pad.
    const edges = page.rotation === 0 ? coverEdges : undefined;
    const sourceFontName = dominantSourceFontName(selectedRuns);
    const coverRects = rects.map((rect, index) =>
      expandPdfRectSides(
        rect,
        {
          left:
            edges?.[index]?.left === false
              ? CONTENT_TEXT_COVER_CUT_EDGE_PAD_PT
              : CONTENT_TEXT_COVER_PAD_PT,
          right:
            edges?.[index]?.right === false
              ? CONTENT_TEXT_COVER_CUT_EDGE_PAD_PT
              : CONTENT_TEXT_COVER_PAD_PT,
          vertical: CONTENT_TEXT_COVER_PAD_PT,
        },
        page,
      ),
    );
    const editRect = contentTextEditRect(rects, page);
    const sourceBaselinesPt = sourceBaselinesFromRuns(selectedRuns, page, scale);
    const firstLineIndentPt = contentTextFirstLineIndentPt(rects, editRect);
    // Absorb earlier contentText edits the new selection overlaps: two
    // overlapping edits would draw both replacement texts on top of each
    // other. The old overlay is removed; its replacement is substituted into
    // the new edit's initial text so the earlier change is not lost.
    // originalText stays the SOURCE text — that is what the export covers
    // and excises.
    const absorbed = editorStore
      .getState()
      .model.overlays.filter(
        (existing): existing is ContentTextOverlay =>
          existing.type === "contentText" &&
          existing.pageId === page.id &&
          existing.coverRects.some((existingRect) =>
            coverRects.some((newRect) =>
              pdfRectsOverlap(existingRect, newRect),
            ),
          ),
      );
    let initialText = text;
    for (const old of absorbed) {
      // Best effort: an old edit whose source text no longer matches even
      // whitespace-tolerantly is still removed — the user is re-editing
      // this region and would otherwise see both texts overlap.
      initialText = substituteAbsorbedText(
        initialText,
        old.originalText,
        old.text,
      );
    }
    const overlay: ContentTextOverlay = {
      type: "contentText",
      id: nanoid(),
      pageId: page.id,
      rect: editRect,
      coverRects,
      ...(sourceBaselinesPt ? { sourceBaselinesPt } : {}),
      ...(firstLineIndentPt !== undefined ? { firstLineIndentPt } : {}),
      ...(sourceFontName ? { sourceFontName } : {}),
      originalText: text,
      text: initialText,
      fontSize: inferredStyle.fontSize,
      color: sampledColors.textColor ?? inferredStyle.color,
      bold: inferredStyle.bold,
      italic: inferredStyle.italic,
      align: "left",
      fontFamily: inferredStyle.fontFamily,
      renderedFont: dominantCssFontFamily(
        selectedRuns,
        inferredStyle.fontFamily,
      ),
      backgroundColor: sampledColors.backgroundColor ?? "#ffffff",
    };
    if (debug) {
      recordTextEditDebug({
        capturedAt: new Date().toISOString(),
        page: {
          id: page.id,
          sourceIndex: page.sourceIndex,
          widthPt: page.widthPt,
          heightPt: page.heightPt,
          rotation: page.rotation,
          scale,
        },
        selection: debug.selection,
        overlay: {
          ...summarizeContentTextOverlay(overlay),
          inferredStyle,
          sampledColors,
          sourcePdfRects: rects.map(summarizePdfRect),
          expandedCoverRects: coverRects.map(summarizePdfRect),
          editRect: summarizePdfRect(editRect),
          sourceDisplayRects: displayRects.map(summarizeDisplayRect),
        },
      });
    }
    setEditingOverlayId(null);
    const { model } = editorStore.getState();
    const absorbedIds = new Set(absorbed.map((old) => old.id));
    commit({
      overlays: [
        ...model.overlays.filter((existing) => !absorbedIds.has(existing.id)),
        overlay,
      ],
    });
    selectOnly(overlay.id);
    setEditingOverlayId(overlay.id);
    window.requestAnimationFrame(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        '.shioriOverlayLayer textarea[data-role="interactive"]',
      );
      if (textarea) textarea.focus();
    });
  };

  const addTextBox = (start: Point, end: Point) => {
    const displayRect = textBoxDisplayRect(start, end);
    const rect = displayRectsToPdfRects([displayRect], page, scale)[0];
    if (!rect) return;
    const overlay: TextOverlay = {
      type: "text",
      id: nanoid(),
      pageId: page.id,
      rect,
      text: "",
      fontSize: textDefaults.fontSize,
      color: textDefaults.color,
      bold: textDefaults.bold,
      italic: textDefaults.italic,
      align: textDefaults.align,
      fontFamily: textDefaults.fontFamily,
    };
    setEditingOverlayId(null);
    addOverlay(overlay);
    selectOnly(overlay.id);
    setEditingOverlayId(overlay.id);
    window.requestAnimationFrame(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        `.shioriOverlayLayer textarea[data-role="interactive"][data-overlay-id="${overlay.id}"]`,
      );
      if (textarea) textarea.focus();
    });
  };

  // Use the same glyph bounds for live selection and every markup entry point.
  const markupDisplayRectsFromSelection = (): { rects: DisplayRect[]; complete: boolean } => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      return { rects: [], complete: false };
    }
    const rootRect = root.getBoundingClientRect();
    const geometry = markupGeometryRef.current;
    if (!geometry) return { rects: [], complete: false };
    const displayRects: DisplayRect[] = [];
    for (let i = 0; i < selection.rangeCount; i += 1) {
      displayRects.push(...markupRectsForRange(
        selection.getRangeAt(i), geometry, page, scale, rootRect,
      ));
    }
    // The preview and persisted markup describe the same DOM selection.
    // Do not trim characters to pointer coordinates or pad into neighbours.
    return { rects: displayRects, complete:
      !!selection.anchorNode && root.contains(selection.anchorNode) &&
      !!selection.focusNode && root.contains(selection.focusNode) };

  };

  // Apply a markup type to whatever text is selected right now, regardless
  // of the active tool. Drives the selection popover; returns true if any
  // markup was created so the caller can dismiss the popover.
  const applyMarkupToCurrentSelection = (
    type: SelectionMarkupType,
  ): boolean => {
    const selection = window.getSelection();
    const picked = markupDisplayRectsFromSelection();
    if (!picked.complete || picked.rects.length === 0) return false;
    const rects = displayRectsToPdfRects(picked.rects, page, scale);
    if (rects.length === 0) return false;
    const anchor =
      picked.complete && selection
        ? selectionAnchor(selectedTextFromSelection(selection))
        : undefined;
    if (type === "callout") addCallout(rects, anchor);
    else addTextMarkup(type, rects, anchor);
    window.getSelection()?.removeAllRanges();
    return true;
  };

  const commitSelection = (gesture: TextGesture | null, end: Point): boolean => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      return false;
    }

    if (!contentTextEditEnabled) {
      const picked = markupDisplayRectsFromSelection();
      // Cross-page selections stay available for copying. The selection
      // toolbar already explains why page-local markup is unavailable.
      if (!picked.complete) return false;
      const rects = displayRectsToPdfRects(picked.rects, page, scale);
      if (rects.length === 0) return false;
      const anchor = selectionAnchor(selectedTextFromSelection(selection));
      if (calloutEnabled) addCallout(rects, anchor);
      else if (textMarkupType) addTextMarkup(textMarkupType, rects, anchor);
      else return false;
      selection.removeAllRanges();
      return true;
    }

    const rootRect = root.getBoundingClientRect();
    const displayRects: DisplayRect[] = [];
    const selectedRunTexts: SelectedTextRun[] = [];
    const rangeDebugs: unknown[] = [];
    const textRunGeometry = textRunGeometryRef.current;
    for (let i = 0; i < selection.rangeCount; i += 1) {
      const range = selection.getRangeAt(i);
      if (!rangeIntersectsNode(range, root)) continue;
      const clientRects = Array.from(range.getClientRects());
      const rangeDisplayRects = clientRectsToDisplayRects(
        clientRects,
        rootRect,
        pageWidthPx,
        pageHeightPx,
      );
      const nativeSelectedRunsWithText = selectedTextRunsForRange(
        range,
        textRunGeometry,
        rootRect,
        pageWidthPx,
        pageHeightPx,
        size.width,
      );
      const gestureSelectedRunsWithText =
        contentTextEditEnabled && gesture
          ? selectedTextRunsForDisplayRects(
              rangeDisplayRects,
              textRunGeometry,
              rootRect,
              pageWidthPx,
              pageHeightPx,
              size.width,
            )
          : [];
      const selectedRunsWithText =
        gestureSelectedRunsWithText.length > 0
          ? gestureSelectedRunsWithText
          : nativeSelectedRunsWithText;
      selectedRunTexts.push(...selectedRunsWithText);
      const selectedRuns = selectedRunsWithText.map((entry) => entry.run);
      const snapped = clipSnappedRectsToGesture(
        snapDisplayRectsToTextRuns(rangeDisplayRects, selectedRuns),
        selectedRuns,
        gesture ? gesture.start : null,
        end,
      );
      displayRects.push(...snapped);
      rangeDebugs.push({
        index: i,
        nativeText: range.toString(),
        clientRects: clientRects.map(summarizeClientRect),
        rangeDisplayRects: rangeDisplayRects.map(summarizeDisplayRect),
        selectedRunsSource:
          gestureSelectedRunsWithText.length > 0 ? "gesture" : "nativeRange",
        nativeSelectedRuns:
          nativeSelectedRunsWithText.map(summarizeSelectedTextRun),
        selectedRuns: selectedRunsWithText.map(summarizeSelectedTextRun),
        snappedDisplayRects: snapped.map(summarizeDisplayRect),
      });
    }

    if (isSpuriousFullLayerSelection(gesture, end, rootRect, displayRects)) {
      selection.removeAllRanges();
      selectOnly(null);
      return true;
    }

    const anchorY = gesture
      ? (gesture.start.y + end.y) / 2
      : null;
    const gestureYRange = gesture
      ? {
          minY: Math.min(gesture.start.y, end.y),
          maxY: Math.max(gesture.start.y, end.y),
        }
      : null;
    const filteredRects = filterDistantClusters(
      displayRects,
      anchorY,
      gestureYRange,
    );
    if (filteredRects.length === 0) return false;
    if (contentTextEditEnabled) {
      const filteredRunTexts = filterSelectedRunTexts(
        selectedRunTexts,
        filteredRects,
      );
      const gestureTrimmedRunTexts = trimSelectedRunTextsToGesture(
        filteredRunTexts,
        gesture,
        end,
      );
      if (filteredRunTexts.length > 0 && gestureTrimmedRunTexts.length === 0) {
        selection.removeAllRanges();
        selectOnly(null);
        return true;
      }
      const selectedText =
        gestureTrimmedRunTexts.length > 0
          ? selectedTextFromRunTexts(gestureTrimmedRunTexts)
          : selectedTextFromSelection(selection);
      if (!selectedText.trim()) return false;
      const styleRuns =
        gestureTrimmedRunTexts.length > 0
          ? gestureTrimmedRunTexts.map((entry) => entry.run)
          : selectedRunTexts.map((entry) => entry.run);
      const coverSelection =
        gestureTrimmedRunTexts.length > 0
          ? selectedRunRectsWithEdges(gestureTrimmedRunTexts)
          : { rects: filteredRects, edges: undefined };
      const coverDisplayRects = coverSelection.rects;
      const rects = displayRectsToPdfRects(coverDisplayRects, page, scale);
      if (rects.length === 0) return false;
      const debug: ContentTextEditDebugDraft = {
        selection: {
          nativeSelectionText: selectedTextFromSelection(selection),
          selectedText,
          rangeCount: selection.rangeCount,
          gesture: summarizeGesture(gesture, end),
          rootRect: summarizeClientRect(rootRect),
          pageDisplay: {
            widthPx: roundDebug(pageWidthPx),
            heightPx: roundDebug(pageHeightPx),
          },
          ranges: rangeDebugs,
          snappedDisplayRectsBeforeClusterFilter:
            displayRects.map(summarizeDisplayRect),
          filteredDisplayRects: filteredRects.map(summarizeDisplayRect),
          filteredRunTexts: filteredRunTexts.map(summarizeSelectedTextRun),
          gestureTrimmedRunTexts:
            gestureTrimmedRunTexts.map(summarizeSelectedTextRun),
          styleRuns: styleRuns.map(summarizeTextRun),
          coverDisplayRects: coverDisplayRects.map(summarizeDisplayRect),
          coverPdfRects: rects.map(summarizePdfRect),
        },
      };
      addContentTextEdit(
        rects,
        selectedText,
        styleRuns,
        coverDisplayRects,
        coverSelection.edges,
        debug,
      );
      selection.removeAllRanges();
      return true;
    }
    return false;
  };

  // Callout tool, plain click: point at exactly where the user clicked. A
  // figure, a formula or a scanned region carries no selectable text, so
  // without this the only way to annotate one is to drag a box around it.
  const commitPointCallout = (point: Point): boolean => {
    if (!calloutEnabled) return false;
    const size = CALLOUT_POINT_TARGET_PT * scale;
    const rects = displayRectsToPdfRects(
      [{ x: point.x - size / 2, y: point.y - size / 2, w: size, h: size }],
      page,
      scale,
    );
    if (rects.length === 0) return false;
    return addCallout(rects);
  };

  const commitFallbackRect = (end: Point): boolean => {
    const start = dragStartRef.current;
    if (!start) return false;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    if (w < 4 || h < 4) return false;
    const rects = displayRectsToPdfRects([{ x, y, w, h }], page, scale);
    if (calloutEnabled) addCallout(rects);
    else if (textMarkupType) addTextMarkup(textMarkupType, rects);
    else return false;
    return true;
  };

  const updateContentSelectionPreview = (
    gesture: TextGesture | null,
    end: Point,
  ) => {
    if (!contentTextEditEnabled || !gesture) {
      setContentSelectionPreviewRects([]);
      return;
    }
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setContentSelectionPreviewRects([]);
      return;
    }

    const rootRect = root.getBoundingClientRect();
    const displayRects: DisplayRect[] = [];
    const selectedRunTexts: SelectedTextRun[] = [];
    const textRunGeometry = textRunGeometryRef.current;
    for (let i = 0; i < selection.rangeCount; i += 1) {
      const range = selection.getRangeAt(i);
      if (!rangeIntersectsNode(range, root)) continue;
      const rangeDisplayRects = clientRectsToDisplayRects(
        Array.from(range.getClientRects()),
        rootRect,
        pageWidthPx,
        pageHeightPx,
      );
      const selectedRunsWithText = selectedTextRunsForDisplayRects(
        rangeDisplayRects,
        textRunGeometry,
        rootRect,
        pageWidthPx,
        pageHeightPx,
        size.width,
      );
      selectedRunTexts.push(...selectedRunsWithText);
      const selectedRuns = selectedRunsWithText.map((entry) => entry.run);
      displayRects.push(
        ...clipSnappedRectsToGesture(
          snapDisplayRectsToTextRuns(rangeDisplayRects, selectedRuns),
          selectedRuns,
          gesture.start,
          end,
        ),
      );
    }

    const filteredRects = filterDistantClusters(
      displayRects,
      (gesture.start.y + end.y) / 2,
      {
        minY: Math.min(gesture.start.y, end.y),
        maxY: Math.max(gesture.start.y, end.y),
      },
    );
    const filteredRunTexts = filterSelectedRunTexts(
      selectedRunTexts,
      filteredRects,
    );
    const gestureTrimmedRunTexts = trimSelectedRunTextsToGesture(
      filteredRunTexts,
      gesture,
      end,
    );
    setContentSelectionPreviewRects(
      gestureTrimmedRunTexts.length > 0
        ? displayRectsFromSelectedRunTexts(gestureTrimmedRunTexts)
        : filteredRects,
    );
  };

  const correctGlyphDrag = (end: Point) => {
    const anchor = glyphDragRef.current;
    const geometry = markupGeometryRef.current;
    if (!anchor || !geometry || !anchor.node.isConnected ||
      Math.hypot(end.x - anchor.point.x, end.y - anchor.point.y) < 1) return;
    const focus = glyphCaretAtPoint(geometry, page, scale, end);
    const selection = window.getSelection();
    if (!focus || !selection) return;
    if (selection.anchorNode === anchor.node && selection.anchorOffset === anchor.offset &&
      selection.focusNode === focus.node && selection.focusOffset === focus.offset) return;
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  };

  return (
    <>
      <div
        ref={rootRef}
        className={`textLayer shioriTextLayer${selectionEnabled ? " is-active" : ""}${contentTextEditEnabled ? " is-content-text-edit" : ""}${markupPreviewRects.length ? " is-accurate-selection" : ""}`}
        tabIndex={0}
        onPointerDown={(e) => {
          if (!selectionEnabled || e.button !== 0) return;
          setActivePage(page.id);
          const start = localPoint(e);
          const caret = !contentTextEditEnabled && e.pointerType !== "touch" &&
            e.detail <= 1 && !e.shiftKey && markupGeometryRef.current
            ? glyphCaretAtPoint(markupGeometryRef.current, page, scale, start) : null;
          glyphDragRef.current = caret ? { ...caret, point: start } : null;
          if (contentTextEditEnabled) {
            if (hasTextRuns && isPdfTextTarget(e.target, rootRef.current)) {
              textGestureRef.current = {
                start,
                startedOnText: true,
                clickCount: e.detail,
              };
              textGestureCurrentRef.current = start;
              setContentSelectionPreviewRects([]);
              dragStartRef.current = null;
              setPreviewDrag(null);
              return;
            }
            e.preventDefault();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            window.getSelection()?.removeAllRanges();
            textGestureRef.current = null;
            textGestureCurrentRef.current = null;
            setContentSelectionPreviewRects([]);
            dragStartRef.current = start;
            setPreviewDrag({ start, current: start });
            return;
          }
          if (!createsTextMarkup && !contentTextEditEnabled) return;
          if (hasTextRuns) {
            textGestureRef.current = {
              start,
              startedOnText: isPdfTextTarget(e.target, rootRef.current),
              clickCount: e.detail,
            };
            textGestureCurrentRef.current = start;
            dragStartRef.current = null;
            setPreviewDrag(null);
            return;
          }
          setTextSelectionActive(false);
          dragStartRef.current = start;
          setPreviewDrag({ start, current: start });
        }}
        onMouseDown={(e) => {
          // PointerEvent.detail is zero in WebKit. MouseEvent carries the
          // click count; preserve native word/paragraph selection on repeats.
          if (e.detail > 1) glyphDragRef.current = null;
        }}
        onPointerMove={(e) => {
          if (glyphDragRef.current && (e.buttons & 1) !== 0) {
            const end = localPoint(e);
            if (glyphDragFrameRef.current !== null) window.cancelAnimationFrame(glyphDragFrameRef.current);
            glyphDragFrameRef.current = window.requestAnimationFrame(() => {
              glyphDragFrameRef.current = null;
              correctGlyphDrag(end);
            });
          }
          if (
            contentTextEditEnabled &&
            textGestureRef.current &&
            !dragStartRef.current
          ) {
            const end = localPoint(e);
            textGestureCurrentRef.current = end;
            window.requestAnimationFrame(() => {
              if (textGestureRef.current && textGestureCurrentRef.current === end) {
                updateContentSelectionPreview(textGestureRef.current, end);
              }
            });
            return;
          }
          const start = dragStartRef.current;
          if (contentTextEditEnabled && start) {
            setPreviewDrag({ start, current: localPoint(e) });
            return;
          }
          if ((!createsTextMarkup && !contentTextEditEnabled) || !start) return;
          setTextSelectionActive(hasActiveTextSelection(rootRef.current));
          setPreviewDrag({ start, current: localPoint(e) });
        }}
        onPointerUp={(e) => {
          if (glyphDragFrameRef.current !== null) window.cancelAnimationFrame(glyphDragFrameRef.current);
          glyphDragFrameRef.current = null;
          correctGlyphDrag(localPoint(e));
          glyphDragRef.current = null;
          if ((!createsTextMarkup && !contentTextEditEnabled) || e.button !== 0) return;
          const end = localPoint(e);
          if (contentTextEditEnabled && dragStartRef.current) {
            e.preventDefault();
            releasePointerCapture(e);
            addTextBox(dragStartRef.current, end);
            setPreviewDrag(null);
            textGestureRef.current = null;
            textGestureCurrentRef.current = null;
            setContentSelectionPreviewRects([]);
            dragStartRef.current = null;
            return;
          }
          setPreviewDrag(null);
          window.setTimeout(() => {
            // On a page with a text layer pointerdown records the gesture
            // instead of a drag origin, so read whichever one this page took.
            const clickOrigin =
              dragStartRef.current ?? textGestureRef.current?.start ?? null;
            const isPlainClick =
              !!clickOrigin &&
              Math.hypot(end.x - clickOrigin.x, end.y - clickOrigin.y) < 4;
            if (
              calloutEnabled &&
              isPlainClick &&
              !hasActiveTextSelection(rootRef.current) &&
              commitPointCallout(end)
            ) {
              window.getSelection()?.removeAllRanges();
              textGestureRef.current = null;
              textGestureCurrentRef.current = null;
              setContentSelectionPreviewRects([]);
              dragStartRef.current = null;
              return;
            }
            if (isBlankTextClick(textGestureRef.current, end)) {
              window.getSelection()?.removeAllRanges();
              selectOnly(null);
              textGestureRef.current = null;
              textGestureCurrentRef.current = null;
              setContentSelectionPreviewRects([]);
              dragStartRef.current = null;
              return;
            }
            if (tryParagraphEditAtPoint(textGestureRef.current, end, e.timeStamp)) {
              window.getSelection()?.removeAllRanges();
              textGestureRef.current = null;
              textGestureCurrentRef.current = null;
              setContentSelectionPreviewRects([]);
              dragStartRef.current = null;
              return;
            }
            const createdHighlight =
              commitSelection(textGestureRef.current, end) || commitFallbackRect(end);
            if (!createdHighlight) selectOnly(null);
            textGestureRef.current = null;
            textGestureCurrentRef.current = null;
            setContentSelectionPreviewRects([]);
            dragStartRef.current = null;
          }, 0);
        }}
        onPointerCancel={(e) => {
          glyphDragRef.current = null;
          if (glyphDragFrameRef.current !== null) window.cancelAnimationFrame(glyphDragFrameRef.current);
          glyphDragFrameRef.current = null;
          releasePointerCapture(e);
          textGestureRef.current = null;
          textGestureCurrentRef.current = null;
          setContentSelectionPreviewRects([]);
          dragStartRef.current = null;
          setPreviewDrag(null);
        }}
        style={textLayerStyle}
      />
      {renderMarkupSelectionPreview(
        markupPreviewRects, size.width * scale, size.height * scale,
        selectionTint ?? T.accent,
        textMarkupType === "highlight" ? annotDefaults.highlightOpacity : 0.28,
      )}
      {contentTextEditEnabled
        ? renderTextBoxPreview(previewDrag, pageWidthPx, pageHeightPx)
        : renderFallbackPreview(
            previewDrag,
            textSelectionActive,
            pageWidthPx,
            pageHeightPx,
            textMarkupType ?? "highlight",
            calloutEnabled
              ? annotDefaults.calloutColor
              : textMarkupDefaults(textMarkupType ?? "highlight", annotDefaults).color,
            calloutEnabled
              ? CALLOUT_TARGET_OPACITY
              : textMarkupDefaults(textMarkupType ?? "highlight", annotDefaults).opacity,
          )}
      {contentTextEditEnabled
        ? renderContentSelectionPreview(
            contentSelectionPreviewRects,
            pageWidthPx,
            pageHeightPx,
          )
        : null}
      {renderSearchMatchRects(searchMatchRects, pageWidthPx, pageHeightPx)}
      {renderDebugParagraphs(debugParagraphs, pageWidthPx, pageHeightPx)}
      {selectionPopup ? (
        <SelectionMarkupPopup
          anchor={selectionPopup.anchor}
          crossPage={selectionPopup.crossPage}
          onApply={(type) => {
            applyMarkupToCurrentSelection(type);
            setSelectionPopup(null);
          }}
        />
      ) : null}
    </>
  );
}

function renderMarkupSelectionPreview(
  rects: DisplayRect[], width: number, height: number,
  color: string, opacity: number,
) {
  if (!rects.length) return null;
  return <svg aria-hidden="true" data-shiori-selection-preview="true" width={width} height={height}
    style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 4 }}>
    <g opacity={opacity} style={{ mixBlendMode: "multiply" }}>
      {rects.map((rect, index) =>
        <rect key={index} x={rect.x} y={rect.y} width={rect.w} height={rect.h} fill={color} />)}
    </g>
  </svg>;
}

function renderTextBoxPreview(
  preview: PreviewDrag | null,
  pageWidthPx: number,
  pageHeightPx: number,
) {
  if (!preview) return null;
  const rect = textBoxDisplayRect(preview.start, preview.current);
  if (Math.abs(preview.current.x - preview.start.x) < 2 && Math.abs(preview.current.y - preview.start.y) < 2) {
    return null;
  }
  return (
    <svg
      width={pageWidthPx}
      height={pageHeightPx}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 2,
      }}
    >
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill="none"
        stroke={T.ink}
        strokeWidth={1}
        strokeDasharray="4 3"
        opacity={0.55}
        rx={1}
        ry={1}
      />
    </svg>
  );
}

// Dev-only overlay: outline every detected paragraph block — green solid =
// high confidence (editable), orange dashed = low (refused), with the
// detected alignment as a tag. Enabled via localStorage "shioriDebugParagraphs".
function renderDebugParagraphs(
  paragraphs: DetectedParagraph[],
  pageWidthPx: number,
  pageHeightPx: number,
) {
  if (paragraphs.length === 0) return null;
  return (
    <svg
      width={pageWidthPx}
      height={pageHeightPx}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 4,
      }}
    >
      {paragraphs.map((block, index) => {
        const high = block.confidence === "high";
        const color = high ? "#1a7f37" : "#c26a00";
        return (
          <g key={index}>
            <rect
              x={block.rect.x - 2}
              y={block.rect.y - 2}
              width={block.rect.w + 4}
              height={block.rect.h + 4}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeDasharray={high ? undefined : "5 4"}
            />
            <text
              x={block.rect.x}
              y={block.rect.y - 5}
              fontSize={10}
              fill={color}
              fontFamily="monospace"
            >
              {`${block.align} ×${block.lines.length}${high ? "" : ` — ${block.reasons.join("; ")}`}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function renderContentSelectionPreview(
  rects: DisplayRect[],
  pageWidthPx: number,
  pageHeightPx: number,
) {
  if (rects.length === 0) return null;
  return (
    <svg
      width={pageWidthPx}
      height={pageHeightPx}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        // Above the overlay layer (zIndex 3): the selection tint must stay
        // visible while sweeping across an existing contentText edit, whose
        // opaque cover would otherwise hide it.
        zIndex: 4,
      }}
    >
      <g>
        {rects.map((rect, index) => (
          <rect
            key={`${rect.x}:${rect.y}:${rect.w}:${rect.h}:${index}`}
            x={rect.x}
            y={rect.y}
            width={rect.w}
            height={rect.h}
            fill={T.accent}
            opacity={0.28}
            rx={1}
            ry={1}
          />
        ))}
      </g>
    </svg>
  );
}

function renderFallbackPreview(
  preview: PreviewDrag | null,
  textSelectionActive: boolean,
  pageWidthPx: number,
  pageHeightPx: number,
  type: TextMarkupType,
  color: string,
  opacity: number,
) {
  if (!preview || textSelectionActive) return null;
  const x = Math.min(preview.start.x, preview.current.x);
  const y = Math.min(preview.start.y, preview.current.y);
  const w = Math.abs(preview.current.x - preview.start.x);
  const h = Math.abs(preview.current.y - preview.start.y);
  if (w < 2 || h < 2) return null;

  const lineY = textLineDisplayY(type, { y, h });

  return (
    <svg
      width={pageWidthPx}
      height={pageHeightPx}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 2,
      }}
    >
      {type === "underline" || type === "strikethrough" ? (
        <line
          x1={x}
          y1={lineY}
          x2={x + w}
          y2={lineY}
          stroke={color}
          strokeWidth={Math.max(1, Math.min(3, h * 0.08))}
          strokeLinecap="round"
          opacity={opacity}
        />
      ) : (
        <g style={{ mixBlendMode: "multiply" }}>
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill={color}
            opacity={opacity}
            rx={1}
            ry={1}
          />
        </g>
      )}
    </svg>
  );
}

function textLineDisplayY(
  type: TextMarkupType,
  rect: { y: number; h: number },
): number {
  if (type === "strikethrough") return rect.y + rect.h * 0.55;
  return rect.y + rect.h - Math.max(1, Math.min(3, rect.h * 0.12));
}

function renderSearchMatchRects(
  rects: DisplayRect[],
  pageWidthPx: number,
  pageHeightPx: number,
) {
  if (rects.length === 0) return null;
  return (
    <svg
      width={pageWidthPx}
      height={pageHeightPx}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 1,
      }}
    >
      <g>
        {rects.map((rect, index) => (
          <rect
            key={`${rect.x}:${rect.y}:${rect.w}:${rect.h}:${index}`}
            x={rect.x}
            y={rect.y}
            width={rect.w}
            height={rect.h}
            fill={T.accent}
            opacity={0.28}
            rx={1}
            ry={1}
          />
        ))}
      </g>
    </svg>
  );
}

// Publish BaseFont → loaded-FontFace mappings for this session so
// contentText edit boxes can render in the document's own embedded font
// (OverlayDom prepends the face to its CSS stack). Only faces the browser
// confirms usable are published; document.fonts is read here — an effect
// context — because the render-purity lint bars impure reads in render.
// The page's characters are recorded per font alongside: they approximate
// the (subset) font's glyph coverage for the missing-glyph edit warning.
function registerLoadedPdfFontFaces(
  editorStore: PdfEditorStoreApi,
  fontNames: Map<string, string>,
  faceFamilies: Map<string, string>,
  textContent: PdfPageTextContent,
) {
  const charsByFace = new Map<string, string>();
  for (const item of textContent.items) {
    const text = (item as { str?: string }).str;
    const face = (item as { fontName?: string }).fontName;
    if (!text || !face) continue;
    charsByFace.set(face, (charsByFace.get(face) ?? "") + text);
  }
  const entries: Array<{
    baseFontName: string;
    faceFamily: string;
    chars?: string;
  }> = [];
  // Only families the engine really loaded: FontFaceSet.check() reports an
  // unknown family as ready, so it cannot tell a loaded face from none.
  for (const [styleKey, faceFamily] of faceFamilies) {
    const resolved = fontNames.get(styleKey);
    if (!resolved) continue;
    let usable = false;
    try {
      usable = document.fonts?.check(`12px "${faceFamily}"`) ?? false;
    } catch {
      usable = false;
    }
    if (usable) {
      entries.push({
        baseFontName: normalizeBaseFontName(resolved),
        faceFamily,
        chars: charsByFace.get(styleKey),
      });
    }
  }
  if (entries.length > 0) editorStore.getState().registerPdfFontFaces(entries);
}

function installSelectionEndShim(
  textLayer: HTMLDivElement,
  endOfContent: HTMLDivElement,
  setSelectionActive: (active: boolean) => void,
): () => void {
  const reset = () => {
    textLayer.append(endOfContent);
    endOfContent.style.width = "";
    endOfContent.style.height = "";
    endOfContent.style.userSelect = "";
    endOfContent.style.removeProperty("-webkit-user-select");
    textLayer.classList.remove("selecting");
    setSelectionActive(false);
  };
  let pointerDown = false;
  let prevRange: Range | null = null;

  const onMouseDown = () => {
    textLayer.classList.add("selecting");
  };
  const onPointerDown = () => {
    pointerDown = true;
  };
  const onPointerUp = () => {
    pointerDown = false;
    prevRange = null;
    reset();
  };
  const onBlur = () => {
    pointerDown = false;
    prevRange = null;
    reset();
  };
  const onKeyUp = () => {
    if (!pointerDown) {
      prevRange = null;
      reset();
    }
  };
  const onSelectionChange = () => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
      prevRange = null;
      reset();
      return;
    }
    let active = false;
    for (let i = 0; i < selection.rangeCount; i += 1) {
      if (rangeIntersectsNode(selection.getRangeAt(i), textLayer)) {
        active = true;
        break;
      }
    }
    if (!active) {
      reset();
      return;
    }

    setSelectionActive(true);
    textLayer.classList.add("selecting");
    const range = selection.getRangeAt(0);
    const modifyStart =
      prevRange !== null
        ? safeCompare(range, Range.END_TO_END, prevRange) === 0 ||
          safeCompare(range, Range.START_TO_END, prevRange) === 0
        : false;
    let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) {
      anchor = anchor.parentNode;
    }
    if (anchor instanceof Element && anchor.classList.contains("highlight")) {
      anchor = anchor.parentNode;
    }
    if (!modifyStart && range.endOffset === 0) {
      anchor = previousSelectableAnchor(anchor, textLayer);
    }

    const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
    if (anchorElement?.closest(".textLayer") === textLayer && anchorElement.parentElement) {
      endOfContent.style.width = textLayer.style.width;
      endOfContent.style.height = textLayer.style.height;
      endOfContent.style.userSelect = "text";
      endOfContent.style.setProperty("-webkit-user-select", "text");
      anchorElement.parentElement.insertBefore(
        endOfContent,
        modifyStart ? anchorElement : anchorElement.nextSibling,
      );
    }
    prevRange = range.cloneRange();
  };

  textLayer.addEventListener("mousedown", onMouseDown);
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointerup", onPointerUp);
  window.addEventListener("blur", onBlur);
  document.addEventListener("keyup", onKeyUp);
  document.addEventListener("selectionchange", onSelectionChange);

  return () => {
    textLayer.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("selectionchange", onSelectionChange);
  };
}

function previousSelectableAnchor(anchor: Node | null, root: Node): Node | null {
  let current = anchor;
  while (current && current !== root && !current.previousSibling) {
    current = current.parentNode;
  }
  if (!current || current === root) return anchor;
  current = current.previousSibling;
  while (current && !current.childNodes.length && current.previousSibling) {
    current = current.previousSibling;
  }
  return current ?? anchor;
}

function localPoint(e: ReactPointerEvent): Point {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function releasePointerCapture(e: ReactPointerEvent) {
  const target = e.currentTarget as HTMLElement;
  if (target.hasPointerCapture(e.pointerId)) {
    target.releasePointerCapture(e.pointerId);
  }
}

// Memoized: the text/selection layer depends only on doc/page/pageIndex/scale/
// layerScale. Its own store subscriptions still drive selection updates, but it
// no longer re-runs on every parent render caused by the active page changing on
// scroll or an overlay being dragged on another page.
export const TextHighlightLayer = memo(TextHighlightLayerImpl);
