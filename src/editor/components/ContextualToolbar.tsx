import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  getLiveZoomIndicator,
  subscribeLiveZoomIndicator,
} from "./liveZoomIndicator";
import {
  ANNOTATE_BUTTON_SIZE,
  FLOATING_INSPECTOR_EDGE_GAP,
  annotateButtonBottom,
  floatingInspectorPlacement,
  floatingPanelBand,
  setFloatingInspectorBottomInset,
  type FloatingInspectorPlacement,
} from "./floatingInspectorLayout";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import {
  AlignGroup,
  ExpandableColorPicker,
  FontPicker,
  type FontPickerOption,
  IconBtn,
  NumField,
  WidthPicker,
} from "./ui";
import {
  useAppStore,
  useEditorStore,
  useEditorStoreApi,
} from "../store/store";
import type {
  CalloutOverlay,
  ContentTextOverlay,
  FontFamily,
  Overlay,
  TextOverlay,
  ToolId,
} from "../../pdf/model/types";
import { k } from "../../platform/keys";
import {
  useIsMobile,
  useIsPhone,
} from "../hooks/useIsMobile";
import { copyLastTextEditDebug } from "../textSelection/textEditDebug";
import { toast } from "../toast";
import { SignatureDialog } from "./SignatureDialog";
import { isSignatureOverlay } from "./overlays/overlayGuards";
import { ROTATE_SNAP_DEG } from "./OverlayLayer";
import { typedZoom, zoomStepDown, zoomStepUp } from "../viewport/zoomCommands";
import {
  HIGHLIGHT_COLORS,
  NOTE_COLORS,
  RECT_COLORS,
  TEXT_LINE_COLORS,
  iconForDrawTool,
  iconForSignTool,
  iconForTextMarkupTool,
  isDrawToolId,
  isSignToolId,
  isTextMarkupToolId,
  type DrawToolId,
  type SignToolId,
  type TextMarkupToolId,
} from "./inspectorOptions";
import {
  DrawModePicker,
  MarkupModePicker,
  RectFillPicker,
  SignModePicker,
  StampKindPicker,
} from "./InspectorPickers";

const FONT_OPTIONS: Array<FontPickerOption<FontFamily>> = [
  {
    value: "sans",
    name: "Helvetica",
    previewCss: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
  {
    value: "serif",
    name: "Times",
    previewCss: "'Times', 'Times New Roman', 'Liberation Serif', serif",
  },
  {
    value: "mono",
    name: "Courier",
    previewCss: "'Courier New', Courier, monospace",
  },
  {
    value: "notoSansSc",
    name: "Noto Sans SC",
    previewCss: "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    value: "notoSansJp",
    name: "Noto Sans JP",
    previewCss: "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif",
  },
];

const TEXT_FONT_SIZE_MAX = 144;
const STAMP_WIDTH_OPTIONS = [1, 1.8, 3, 5];

/**
 * Zoom readout that doubles as an editable field: shows `117%`, and on click
 * turns into a numeric input so the user can type an exact zoom (e.g. `150`).
 * Enter / blur commit (clamped to the ladder bounds); Escape reverts.
 */
function ZoomField({
  scale,
  setScale,
  label,
}: {
  scale: number;
  setScale: (s: number) => void;
  label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = draft !== null;
  // During a pinch the committed scale intentionally stands still; the live
  // preview scale streams through a micro-store so only this readout
  // re-renders per gesture frame.
  const liveZoom = useSyncExternalStore(
    subscribeLiveZoomIndicator,
    getLiveZoomIndicator,
  );
  const shownScale = liveZoom ?? scale;

  const commit = (raw: string) => {
    const typed = typedZoom(raw);
    if (typed !== null) setScale(typed);
    setDraft(null);
  };

  // Commit + close on any pointer-down outside the input. onBlur alone isn't
  // enough: clicking the PDF area calls preventDefault on pointerdown, which
  // suppresses the input's blur and would otherwise leave the field stuck open.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      const el = inputRef.current;
      if (el && !el.contains(e.target as Node)) commit(el.value);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        inputMode="numeric"
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
          }
        }}
        style={{
          width: 48,
          height: 28,
          textAlign: "center",
          font: `500 12.5px/1 ${T.mono}`,
          fontVariantNumeric: "tabular-nums",
          color: T.ink,
          background: T.surface,
          border: `1px solid ${T.accent}`,
          borderRadius: 6,
          outline: "none",
          padding: 0,
        }}
      />
    );
  }

  return (
    <button
      type="button"
      title={label}
      onClick={() => setDraft(String(Math.round(scale * 100)))}
      style={{
        minWidth: 48,
        height: 28,
        textAlign: "center",
        font: `500 12.5px/1 ${T.mono}`,
        fontVariantNumeric: "tabular-nums",
        color: T.ink2,
        background: "transparent",
        border: "1px solid transparent",
        borderRadius: 6,
        cursor: "text",
        padding: 0,
      }}
    >
      {Math.round(shownScale * 100)}%
    </button>
  );
}

const TOOLS: Array<{
  id: ToolId | "markup" | "draw" | "sign";
  i18nKey: string;
  hint: string;
  Icon: typeof Ic.cursor;
}> = [
  { id: "select", i18nKey: "tools.select", hint: "V", Icon: Ic.cursor },
  { id: "markup", i18nKey: "tools.markup", hint: "H/U/⇧U", Icon: Ic.highlight },
  { id: "draw", i18nKey: "tools.draw", hint: "I/R", Icon: Ic.ink },
  { id: "sign", i18nKey: "tools.sign", hint: "G/S", Icon: Ic.signature },
  { id: "callout", i18nKey: "tools.callout", hint: "C", Icon: Ic.callout },
  { id: "text", i18nKey: "tools.text", hint: "T", Icon: Ic.text },
];

export function ContextualToolbar() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const editorStore = useEditorStoreApi();
  // Phones spread the tools as a stretched 4-col grid; tablets are wide enough
  // to keep them content-width (a desktop-like pill) instead of ballooning.
  const isPhone = useIsPhone();
  // Collapse ONLY this annotation tool row (+ the style inspector below) into a
  // slim strip, leaving the tabs and top bar in place. Distinct from reader
  // mode, which hides every bit of chrome. Mobile/tablet only — desktop has
  // room for the full row.
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [showSignatureDialog, setShowSignatureDialog] = useState(false);
  // Width of the desktop toolbar row itself — not the viewport. The rail
  // and navigator shrink this row without the window changing size, so a
  // viewport breakpoint can't see it. Below the threshold the tool labels
  // drop and the buttons keep their icons and tooltips; the zoom cluster
  // must stay reachable before any label deserves the room.
  const [toolbarRowWidth, setToolbarRowWidth] = useState(0);
  const toolbarRowObserver = useRef<ResizeObserver | null>(null);
  // A callback ref, not an effect over a ref object: the row is conditionally
  // rendered (collapsing the toolbar unmounts it, expanding mounts a NEW
  // node). An effect keyed on `isMobile` never re-ran across that, so the
  // observer stayed bound to the detached node — which reports 0×0, and the
  // `> 0` guard below then pinned `iconOnlyTools` to false for the rest of
  // the session, killing the narrow-row degradation exactly when the rail or
  // navigator squeezed the row. React calls this with the new node every
  // time, and with null on unmount.
  const toolbarRowRef = useCallback((el: HTMLDivElement | null) => {
    toolbarRowObserver.current?.disconnect();
    toolbarRowObserver.current = null;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setToolbarRowWidth(entry.contentRect.width);
    });
    ro.observe(el);
    toolbarRowObserver.current = ro;
  }, []);
  const iconOnlyTools = !isMobile && toolbarRowWidth > 0 && toolbarRowWidth < 720;
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);
  const activeSignature = useAppStore((s) => s.activeSignature);
  const setActiveSignature = useAppStore((s) => s.setActiveSignature);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const overlays = useEditorStore((s) => s.model.overlays);
  const collapsedCalloutIds = useEditorStore((s) => s.collapsedCalloutIds);
  const toggleCalloutCollapsed = useEditorStore((s) => s.toggleCalloutCollapsed);
  const selection: Overlay | null =
    selectedIds.length > 0
      ? overlays.find((o) => o.id === selectedIds[0]) ?? null
      : null;

  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.undoStack.length > 0);
  const canRedo = useEditorStore((s) => s.redoStack.length > 0);

  const scale = useEditorStore((s) => s.scale);
  const setScale = useEditorStore((s) => s.setScale);
  const setFitMode = useEditorStore((s) => s.setFitMode);
  const readerMode = useEditorStore((s) => s.readerMode);
  const toggleReaderMode = useEditorStore((s) => s.toggleReaderMode);
  // Reading is the phone's default: no tool grid, the tool pinned to select,
  // and one button to step into annotating. See the store's setAnnotationMode.
  const annotationMode = useEditorStore((s) => s.annotationMode);
  const setAnnotationMode = useEditorStore((s) => s.setAnnotationMode);

  const annot = useAppStore((s) => s.annotDefaults);
  const setAnnot = useAppStore((s) => s.setAnnotDefaults);
  const textDef = useEditorStore((s) => s.textDefaults);
  const setText = useEditorStore((s) => s.setTextDefaults);
  const recentColors = useAppStore((s) => s.prefs.recentColors);
  const pushRecentColor = useAppStore((s) => s.pushRecentColor);

  const removeSelected = useEditorStore((s) => s.removeSelected);
  const removeOverlay = useEditorStore((s) => s.removeOverlay);
  const updateOverlay = useEditorStore((s) => s.updateOverlay);
  const updateOverlayNoHistory = useEditorStore((s) => s.updateOverlayNoHistory);
  const beginHistoryStep = useEditorStore((s) => s.beginHistoryStep);
  const setSelectedLocked = useEditorStore((s) => s.setSelectedLocked);
  const setEditingOverlayId = useEditorStore((s) => s.setEditingOverlayId);
  const [toolbarTextHistoryId, setToolbarTextHistoryId] = useState<string | null>(
    null,
  );
  const activeMarkupTool = isTextMarkupToolId(tool)
    ? tool
    : annot.textMarkupTool;
  const setTextMarkupTool = (next: TextMarkupToolId) => {
    setAnnot({ textMarkupTool: next });
    setTool(next);
  };
  const activeDrawTool: DrawToolId = isDrawToolId(tool) ? tool : "ink";
  const setDrawTool = (next: DrawToolId) => setTool(next);
  const activeSignTool: SignToolId = isSignToolId(tool) ? tool : "signature";
  // Arming the group just selects the mode (like the draw group). The
  // signature picker opens on demand from the inspector's "choose
  // signature" button, so switching to signature never dead-ends into a
  // modal that hides the stamp mode.
  const setSignTool = (next: SignToolId) => setTool(next);
  const startToolbarTextHistory = (
    overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
  ) => {
    if (toolbarTextHistoryId === overlay.id) return;
    const isFreshText =
      overlay.type === "text" || overlay.type === "callout"
        ? overlay.text.trim() === ""
        : overlay.text === overlay.originalText;
    const liveEditingId = editorStore.getState().editingOverlayId;
    if (!(liveEditingId === overlay.id && isFreshText)) {
      beginHistoryStep();
    }
    setToolbarTextHistoryId(overlay.id);
  };
  const updateTextContent = (
    overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
    text: string,
  ) => {
    if (overlay.text === text) return;
    startToolbarTextHistory(overlay);
    updateOverlayNoHistory(overlay.id, { text } as never);
  };
  const finishTextContentEdit = (
    overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
    liveText?: string,
  ) => {
    setToolbarTextHistoryId(null);
    const state = editorStore.getState();
    if (state.editingOverlayId === overlay.id) {
      setEditingOverlayId(null);
      return;
    }
    const latest = state.model.overlays.find(
      (o): o is TextOverlay | ContentTextOverlay | CalloutOverlay =>
        o.id === overlay.id &&
        (o.type === "text" ||
          o.type === "contentText" ||
          o.type === "callout"),
    );
    const current = latest ?? { ...overlay, text: liveText ?? overlay.text };
    const empty =
      current.type === "text" || current.type === "callout"
        ? current.text.trim() === ""
        : current.text.trim() === "" || current.text === current.originalText;
    if (empty) removeOverlay(current.id);
  };

  const toolSegment = (
    <div
      style={{
        // Mobile spreads the six tool buttons across the full row,
        // letting them wrap onto a second visual line (4+2) instead
        // of horizontal-scrolling.
        //
        // No shell of its own: this group used to draw a bordered,
        // tinted capsule around the buttons, which stacked a third
        // visible container between the toolbar band and the buttons
        // (window → band → capsule → button). The band is the
        // container; grouping is carried by spacing alone.
        display: isMobile ? "flex" : "inline-flex",
        flexWrap: isMobile ? "wrap" : "nowrap",
        alignItems: "center",
        gap: 2,
        // Mobile: grow to fill the row but leave room for the collapse caret
        // beside us (was width:100%, which crowded the caret off the edge).
        flex: isMobile ? 1 : undefined,
        minWidth: isMobile ? 0 : undefined,
      }}
    >
      {TOOLS.map((tl) => {
        const isMarkupButton = tl.id === "markup";
        const isDrawButton = tl.id === "draw";
        const isSignButton = tl.id === "sign";
        const active = isMarkupButton
          ? isTextMarkupToolId(tool)
          : isDrawButton
            ? isDrawToolId(tool)
            : isSignButton
              ? isSignToolId(tool)
              : tool === tl.id;
        const label = t(tl.i18nKey);
        const Icon = isMarkupButton
          ? iconForTextMarkupTool(activeMarkupTool)
          : isDrawButton
            ? iconForDrawTool(activeDrawTool)
            : isSignButton
              ? iconForSignTool(activeSignTool)
              : tl.Icon;
        const hint = k(tl.hint);
        const activateTool = () => {
          if (tl.id === "markup") {
            setTextMarkupTool(activeMarkupTool);
            return;
          }
          if (tl.id === "draw") {
            setDrawTool(activeDrawTool);
            return;
          }
          if (tl.id === "sign") {
            setSignTool(activeSignTool);
            return;
          }
          setTool(tl.id as ToolId);
        };
        return (
          <button
            key={tl.id}
            type="button"
            aria-pressed={active}
            title={
              isMarkupButton
                ? `${label} · ${t(`tools.${activeMarkupTool}`)} (${hint})`
                : isDrawButton
                  ? `${label} · ${t(`tools.${activeDrawTool}`)} (${hint})`
                  : isSignButton
                    ? `${label} · ${t(`tools.${activeSignTool}`)} (${hint})`
                    : `${label} (${hint})`
            }
            onClick={activateTool}
            style={{
              // 32 px is the tightest comfortable touch target while
              // still leaving the 2-row tool grid under ~80 px tall;
              // wraps to 25 % basis so six tools lay out as 4 + 2.
              height: isMobile ? 32 : 28,
              padding: isMobile ? "0 4px" : "0 10px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: isMobile ? 4 : 7,
              borderRadius: 6,
              border: "1px solid transparent",
              cursor: "pointer",
              // Quiet selection: the armed tool is operational state, not a
              // headline. The old solid-ink fill was the darkest block in
              // the whole window; a brand-blue tint says "current" in the
              // same language as the navigator and rail selections.
              background: active ? T.accentSoft : "transparent",
              color: active ? T.accentText : T.ink2,
              font: `${active ? 600 : 500} 12.5px/1 ${T.sans}`,
              letterSpacing: "-.005em",
              // Phone: stretch to a 4-col grid. Tablet: content-width so the
              // pill stays compact (a 25% basis balloons each button at ~768px
              // and shoves the rest off-screen). Desktop: inline pill.
              flex: isPhone ? "1 0 calc(25% - 2px)" : isMobile ? "0 0 auto" : undefined,
              minWidth: isMobile ? 0 : undefined,
            }}
          >
            <Icon />
            {/* Never let the label break: a wrapped label is what turned the
                tool pill into a two-row toolbar on a narrow window. And when
                the row is squeezed (rail + navigator open), labels go
                entirely — icons and tooltips carry the six tools, so the
                zoom cluster on the right stays on screen. */}
            {iconOnlyTools ? null : (
              <span style={{ whiteSpace: "nowrap" }}>{label}</span>
            )}
            {/* No inline shortcut chip. Shortcuts are teaching information,
                not operating information: once learned they were 20-40px of
                dead weight per button, and the multi-key lists (H/U/⇧U)
                taught nothing at a glance. They live in each button's
                tooltip and in the ⌘/ sheet. */}
          </button>
        );
      })}
    </div>
  );

  let inspector: ReactNode = null;
  if (selection) {
    const selType = selection.type;
    const typeLabel = isSignatureOverlay(selection)
      ? t("types.signature")
      : t(`types.${selType}`);
    // Size and angle as numbers, because the drag handles are unreachable
    // without a pointer: HandleHit renders a bare <div> with onPointerDown
    // and no tabIndex, role or key handling, so Tab never lands on any of the
    // five. Rather than bolt keys onto the handles, expose the same two
    // properties as fields — which a screen reader can also read back, unlike
    // a handle that only ever reports a position.
    const sizable =
      "rect" in selection && selection.rect ? selection : null;
    const nudgeRect = (dw: number, dh: number) => {
      if (!sizable) return;
      updateOverlay(selection.id, {
        rect: {
          ...sizable.rect,
          w: Math.max(4, sizable.rect.w + dw),
          h: Math.max(4, sizable.rect.h + dh),
        },
      } as Partial<Overlay>);
    };
    // Not every resizable type carries a free angle (a note and a callout do
    // not), so the rotation field only appears where rotation is a property
    // the model actually has.
    const rotatable =
      sizable && "angle" in sizable
        ? (sizable as typeof sizable & { angle?: number })
        : null;
    const nudgeAngle = (delta: number) => {
      if (!rotatable) return;
      const next = ((((rotatable.angle ?? 0) + delta) % 360) + 360) % 360;
      updateOverlay(selection.id, { angle: next } as Partial<Overlay>);
    };

    inspector = (
      <InspectorRow label={t("inspector.selectionPrefix", { type: typeLabel })}>
        {selType === "highlight" || selType === "underline" || selType === "strikethrough" ? (() => {
          const lineMarkup = selType === "underline" || selType === "strikethrough";
          const maxOpacity = selType === "strikethrough" ? 1 : 0.9;
          const applyHighlightStyle = (patch: {
            color?: string;
            opacity?: number;
          }) => {
            updateOverlay(selection.id, patch as Partial<Overlay>);
          };
          return (
            <>
              <ExpandableColorPicker
                options={lineMarkup ? TEXT_LINE_COLORS : HIGHLIGHT_COLORS}
                value={selection.color}
                onChange={(c) => applyHighlightStyle({ color: c })}
                recent={recentColors}
                onCommit={pushRecentColor}
              />
              <NumField
                label={t("inspector.fields.opacity")}
                value={Math.round(selection.opacity * 100)}
                suffix="%"
                onMinus={() =>
                  applyHighlightStyle({
                    opacity: Math.max(0.1, selection.opacity - 0.05),
                  })
                }
                onPlus={() =>
                  applyHighlightStyle({
                    opacity: Math.min(maxOpacity, selection.opacity + 0.05),
                  })
                }
                onCommit={(next) =>
                  applyHighlightStyle({ opacity: next / 100 })
                }
                min={10}
                max={maxOpacity * 100}
              />
            </>
          );
        })() : null}
        {selType === "rect" ? (() => {
          const applyRectStyle = (patch: {
            color?: string;
            strokeWidth?: number;
            fill?: string | null;
          }) => {
            updateOverlay(selection.id, patch as Partial<Overlay>);
          };
          return (
            <>
              <ExpandableColorPicker
                options={RECT_COLORS}
                value={selection.color}
                recent={recentColors}
                onChange={(c) => applyRectStyle({ color: c })}
                onCommit={pushRecentColor}
              />
              <NumField
                label={t("inspector.fields.weight")}
                value={selection.strokeWidth}
                suffix="pt"
                onMinus={() =>
                  applyRectStyle({
                    strokeWidth: Math.max(1, selection.strokeWidth - 1),
                  })
                }
                onPlus={() =>
                  applyRectStyle({
                    strokeWidth: Math.min(24, selection.strokeWidth + 1),
                  })
                }
              />
              <RectFillPicker
                value={selection.fill}
                recent={recentColors}
                onChange={(fill) => applyRectStyle({ fill })}
                onCommit={pushRecentColor}
              />
            </>
          );
        })() : null}
        {!isSignatureOverlay(selection) && selType === "ink" ? (() => {
          const applyInkStyle = (patch: { color?: string; width?: number }) => {
            updateOverlay(selection.id, patch as Partial<Overlay>);
          };
          return (
            <>
              <ExpandableColorPicker
                options={["#b13a2e", "#1a1815", "#2d5a3d", "#2f5a8a"]}
                value={selection.color}
                recent={recentColors}
                onChange={(c) => applyInkStyle({ color: c })}
                onCommit={pushRecentColor}
              />
              <WidthPicker
                value={selection.width}
                onChange={(v) => applyInkStyle({ width: v })}
              />
            </>
          );
        })() : null}
        {selType === "stamp" ? (() => {
          // "Last-used style wins" — edits to a selected stamp overlay
          // also update annotDefaults so the next newly-placed stamp
          // inherits the same kind / color / width.
          const applyStampStyle = (patch: {
            kind?: "check" | "cross";
            color?: string;
            strokeWidth?: number;
          }) => {
            updateOverlay(selection.id, patch as Partial<Overlay>);
            setAnnot({
              ...(patch.kind !== undefined ? { stampKind: patch.kind } : {}),
              ...(patch.color !== undefined ? { stampColor: patch.color } : {}),
              ...(patch.strokeWidth !== undefined
                ? { stampStrokeWidth: patch.strokeWidth }
                : {}),
            });
          };
          return (
            <>
              <StampKindPicker
                value={selection.kind}
                onChange={(kind) => applyStampStyle({ kind })}
              />
              <ExpandableColorPicker
                options={["#1a1815", "#b13a2e", "#2d5a3d", "#2f5a8a"]}
                value={selection.color}
                recent={recentColors}
                onChange={(c) => applyStampStyle({ color: c })}
                onCommit={pushRecentColor}
              />
              <WidthPicker
                value={selection.strokeWidth}
                options={STAMP_WIDTH_OPTIONS}
                onChange={(v) => applyStampStyle({ strokeWidth: v })}
              />
            </>
          );
        })() : null}
        {selType === "note" ? (() => {
          const applyNoteStyle = (color: string) => {
            updateOverlay(selection.id, {
              color,
              updatedAt: Date.now(),
            } as Partial<Overlay>);
            setAnnot({ noteColor: color });
          };
          return (
            <>
              <ExpandableColorPicker
                options={NOTE_COLORS}
                value={selection.color}
                recent={recentColors}
                onChange={applyNoteStyle}
                onCommit={pushRecentColor}
              />
            </>
          );
        })() : null}
        {selType === "text" || selType === "contentText" || selType === "callout" ? (() => {
          // "Last-used style wins" — edits to a selected text overlay
          // also update textDefaults so the next newly-drawn text
          // inherits the same font / size / color / weight / alignment.
          const applyTextStyle = (patch: Parameters<typeof setText>[0]) => {
            const overlayPatch =
              selection.type === "contentText" && patch.fontFamily
                ? ({
                    ...patch,
                    renderedFont: undefined,
                  } satisfies Partial<ContentTextOverlay>)
                : (patch as Partial<Overlay>);
            updateOverlay(selection.id, overlayPatch as Partial<Overlay>);
            if (selection.type === "callout") {
              if (patch.color) setAnnot({ calloutColor: patch.color });
            } else {
              setText(patch);
            }
          };
          return (
            <>
              <TextContentEditor
                overlay={selection}
                label={t("inspector.fields.content")}
                placeholder={t(
                  selection.type === "callout"
                    ? "overlays.calloutPlaceholder"
                    : "overlays.textPlaceholder",
                )}
                onChange={(text) => updateTextContent(selection, text)}
                onFinish={(text) => finishTextContentEdit(selection, text)}
              />
              {selection.type === "contentText" ? (
                <IconBtn
                  title={t("tooltips.copyTextEditDebug")}
                  onClick={() => {
                    void copyLastTextEditDebug().then((copied) => {
                      if (copied) toast.show(t("diagnostics.copied"));
                      else toast.error(t("diagnostics.copyFailed"));
                    });
                  }}
                >
                  <Ic.copy />
                </IconBtn>
              ) : null}
              {selection.type === "callout" ? null : (
                <FontPicker
                  options={FONT_OPTIONS}
                  value={selection.fontFamily}
                  onChange={(v) => applyTextStyle({ fontFamily: v })}
                />
              )}
              <NumField
                label={t("inspector.fields.size")}
                value={selection.fontSize}
                suffix="pt"
                onMinus={() =>
                  applyTextStyle({
                    fontSize: Math.max(6, selection.fontSize - 1),
                  })
                }
                onPlus={() =>
                  applyTextStyle({
                    fontSize: Math.min(
                      TEXT_FONT_SIZE_MAX,
                      selection.fontSize + 1,
                    ),
                  })
                }
              onCommit={(next) => applyTextStyle({ fontSize: next })}
                min={6}
                max={TEXT_FONT_SIZE_MAX}
                />
              <ExpandableColorPicker
                options={["#2b2620", "#b13a2e", "#33506e", "#3d5942"]}
                value={selection.color}
                recent={recentColors}
                onChange={(c) => applyTextStyle({ color: c })}
                onCommit={pushRecentColor}
              />
              {selection.type === "callout" ? (
                // The callout card has no persistent header chrome to hang a
                // chevron on, so the toolbar is the discoverable entry point
                // for disclosure. Notes do not need one.
                <IconBtn
                  active={collapsedCalloutIds.includes(selection.id)}
                  onClick={() => toggleCalloutCollapsed(selection.id)}
                  title={t(
                    collapsedCalloutIds.includes(selection.id)
                      ? "overlays.calloutExpand"
                      : "overlays.calloutCollapse",
                  )}
                >
                  <Ic.collapse />
                </IconBtn>
              ) : (
                <>
                  <IconBtn
                    active={selection.bold}
                    onClick={() => applyTextStyle({ bold: !selection.bold })}
                    title={t("tooltips.bold")}
                  >
                    <Ic.bold />
                  </IconBtn>
                  <IconBtn
                    active={Boolean(selection.italic)}
                    onClick={() => applyTextStyle({ italic: !selection.italic })}
                    title={t("tooltips.italic")}
                  >
                    <Ic.italic />
                  </IconBtn>
                </>
              )}
              <AlignGroup
                value={selection.align}
                onChange={(v) => applyTextStyle({ align: v })}
              />
            </>
          );
        })() : null}
        {sizable && !selection.locked ? (
          <>
            <NumField
              label={t("inspector.fields.width")}
              value={Math.round(sizable.rect.w)}
              onPlus={() => nudgeRect(4, 0)}
              onMinus={() => nudgeRect(-4, 0)}
              onCommit={(next) => nudgeRect(next - sizable.rect.w, 0)}
              min={4}
            />
            <NumField
              label={t("inspector.fields.height")}
              value={Math.round(sizable.rect.h)}
              onPlus={() => nudgeRect(0, 4)}
              onMinus={() => nudgeRect(0, -4)}
              onCommit={(next) => nudgeRect(0, next - sizable.rect.h)}
              min={4}
            />
            {rotatable ? (
              <NumField
                label={t("inspector.fields.angle")}
                value={Math.round(rotatable.angle ?? 0)}
                suffix="°"
                onPlus={() => nudgeAngle(ROTATE_SNAP_DEG)}
                onMinus={() => nudgeAngle(-ROTATE_SNAP_DEG)}
                onCommit={(next) =>
                  nudgeAngle(next - (rotatable.angle ?? 0))
                }
              />
            ) : null}
          </>
        ) : null}
        <div style={{ flex: 1 }} />
        <IconBtn
          active={selection.locked}
          title={t(selection.locked ? "tooltips.unlock" : "tooltips.lock")}
          onClick={() => setSelectedLocked(!selection.locked)}
        >
          <Ic.lock />
        </IconBtn>
        <IconBtn title={k(t("tooltips.delete"))} onClick={removeSelected}>
          <Ic.trash />
        </IconBtn>
      </InspectorRow>
    );
  } else if (isTextMarkupToolId(tool)) {
    const lineMarkup = tool === "underline" || tool === "strikethrough";
    const colorKey =
      tool === "highlight"
        ? "highlightColor"
        : tool === "underline"
          ? "underlineColor"
          : "strikethroughColor";
    const opacityKey =
      tool === "highlight"
        ? "highlightOpacity"
        : tool === "underline"
          ? "underlineOpacity"
          : "strikethroughOpacity";
    const opacityMax = tool === "highlight" ? 0.9 : 1;
    inspector = (
      <InspectorRow label={t("inspector.labels.markup")}>
        <MarkupModePicker value={tool} onChange={setTextMarkupTool} />
        <ExpandableColorPicker
          options={lineMarkup ? TEXT_LINE_COLORS : HIGHLIGHT_COLORS}
          value={annot[colorKey]}
          recent={recentColors}
          onChange={(v) => setAnnot({ [colorKey]: v })}
          onCommit={pushRecentColor}
        />
        <NumField
          label={t("inspector.fields.opacity")}
          value={Math.round(annot[opacityKey] * 100)}
          suffix="%"
          min={10}
          max={Math.round(opacityMax * 100)}
          onMinus={() =>
            setAnnot({
              [opacityKey]: Math.max(0.1, annot[opacityKey] - 0.05),
            })
          }
          onPlus={() =>
            setAnnot({
              [opacityKey]: Math.min(opacityMax, annot[opacityKey] + 0.05),
            })
          }
          onCommit={(percent) =>
            setAnnot({ [opacityKey]: Math.round(percent) / 100 })
          }
        />
        <Hint>{t(`inspector.hints.${tool}`)}</Hint>
      </InspectorRow>
    );
  } else if (tool === "ink") {
    inspector = (
      <InspectorRow label={t("inspector.labels.ink")}>
        <DrawModePicker value={tool} onChange={setDrawTool} />
        <ExpandableColorPicker
          options={["#b13a2e", "#1a1815", "#2d5a3d", "#2f5a8a"]}
          value={annot.inkColor}
          recent={recentColors}
          onChange={(v) => setAnnot({ inkColor: v })}
          onCommit={pushRecentColor}
        />
        <WidthPicker
          value={annot.inkWidth}
          onChange={(v) => setAnnot({ inkWidth: v })}
        />
        <Hint>{t("inspector.hints.ink")}</Hint>
      </InspectorRow>
    );
  } else if (tool === "signature") {
    inspector = (
      <InspectorRow label={t("inspector.labels.signature")}>
        <SignModePicker value={tool} onChange={setSignTool} />
        <IconBtn
          tone="outline"
          title={t("signatures.title")}
          // The only IconBtn whose `title` differs from its visible text, so
          // it cannot ride the component's title-to-aria-label fallback: that
          // would replace the signature's name with the generic section title.
          // Name it explicitly, visible string included (WCAG 2.5.3).
          aria-label={`${t("signatures.title")}: ${
            activeSignature?.name ?? t("signatures.choose")
          }`}
          onClick={() => setShowSignatureDialog(true)}
        >
          <Ic.signature />
          <span>{activeSignature?.name ?? t("signatures.choose")}</span>
        </IconBtn>
        <Hint>
          {activeSignature
            ? t("inspector.hints.signature")
            : t("inspector.hints.signatureEmpty")}
        </Hint>
      </InspectorRow>
    );
  } else if (tool === "stamp") {
    inspector = (
      <InspectorRow label={t("inspector.labels.stamp")}>
        <SignModePicker value={tool} onChange={setSignTool} />
        <StampKindPicker
          value={annot.stampKind}
          onChange={(kind) => setAnnot({ stampKind: kind })}
        />
        <ExpandableColorPicker
          options={["#1a1815", "#b13a2e", "#2d5a3d", "#2f5a8a"]}
          value={annot.stampColor}
          recent={recentColors}
          onChange={(v) => setAnnot({ stampColor: v })}
          onCommit={pushRecentColor}
        />
        <WidthPicker
          value={annot.stampStrokeWidth}
          options={STAMP_WIDTH_OPTIONS}
          onChange={(v) => setAnnot({ stampStrokeWidth: v })}
        />
        <Hint>{t("inspector.hints.stamp")}</Hint>
      </InspectorRow>
    );
  } else if (tool === "rect") {
    inspector = (
      <InspectorRow label={t("inspector.labels.rectangle")}>
        <DrawModePicker value={tool} onChange={setDrawTool} />
        <ExpandableColorPicker
          options={RECT_COLORS}
          value={annot.rectColor}
          recent={recentColors}
          onChange={(v) => setAnnot({ rectColor: v })}
          onCommit={pushRecentColor}
        />
        <NumField
          label={t("inspector.fields.weight")}
          value={annot.rectStrokeWidth}
          suffix="pt"
          onMinus={() =>
            setAnnot({
              rectStrokeWidth: Math.max(1, annot.rectStrokeWidth - 1),
            })
          }
          onPlus={() =>
            setAnnot({
              rectStrokeWidth: Math.min(24, annot.rectStrokeWidth + 1),
            })
          }
        />
        <RectFillPicker
          value={annot.rectFill}
          recent={recentColors}
          onChange={(v) => setAnnot({ rectFill: v })}
          onCommit={pushRecentColor}
        />
      </InspectorRow>
    );
  } else if (tool === "note") {
    inspector = (
      <InspectorRow label={t("inspector.labels.note")}>
        <ExpandableColorPicker
          options={NOTE_COLORS}
          value={annot.noteColor}
          recent={recentColors}
          onChange={(v) => setAnnot({ noteColor: v })}
          onCommit={pushRecentColor}
        />
        <Hint>{t("inspector.hints.note")}</Hint>
      </InspectorRow>
    );
  } else if (tool === "callout") {
    inspector = (
      <InspectorRow label={t("inspector.labels.callout")}>
        <ExpandableColorPicker
          options={TEXT_LINE_COLORS}
          value={annot.calloutColor}
          recent={recentColors}
          onChange={(v) => setAnnot({ calloutColor: v })}
          onCommit={pushRecentColor}
        />
        <Hint>{t("inspector.hints.callout")}</Hint>
      </InspectorRow>
    );
  } else if (tool === "text") {
    inspector = (
      <InspectorRow label={t("inspector.labels.text")}>
        <FontPicker
          options={FONT_OPTIONS}
          value={textDef.fontFamily}
          onChange={(v) => setText({ fontFamily: v })}
        />
        <NumField
          label={t("inspector.fields.size")}
          value={textDef.fontSize}
          suffix="pt"
          min={8}
          max={TEXT_FONT_SIZE_MAX}
          onMinus={() =>
            setText({ fontSize: Math.max(8, textDef.fontSize - 1) })
          }
          onPlus={() =>
            setText({
              fontSize: Math.min(TEXT_FONT_SIZE_MAX, textDef.fontSize + 1),
            })
          }
          onCommit={(size) => setText({ fontSize: Math.round(size) })}
        />
        <ExpandableColorPicker
          options={["#2b2620", "#b13a2e", "#33506e", "#3d5942"]}
          value={textDef.color}
          recent={recentColors}
          onChange={(v) => setText({ color: v })}
          onCommit={pushRecentColor}
        />
        <IconBtn
          active={textDef.bold}
          onClick={() => setText({ bold: !textDef.bold })}
          title={t("tooltips.bold")}
        >
          <Ic.bold />
        </IconBtn>
        <IconBtn
          active={textDef.italic}
          onClick={() => setText({ italic: !textDef.italic })}
          title={t("tooltips.italic")}
        >
          <Ic.italic />
        </IconBtn>
        <AlignGroup
          value={textDef.align}
          onChange={(v) => setText({ align: v })}
        />
      </InspectorRow>
    );
  } else {
    // A phone's select inspector said one word, "Select", with the tool pill
    // beside it already lit — and the row only existed to hold the flow open
    // (see SelectInspector). The phone inspector is out of the flow now, so
    // there is nothing left to hold open and nothing worth floating.
    inspector = isPhone ? null : <SelectInspector />;
  }
  const signatureDialog = showSignatureDialog ? (
    <SignatureDialog
      activeSignatureId={activeSignature?.id}
      onClose={() => setShowSignatureDialog(false)}
      onUse={(signature) => {
        setActiveSignature(signature);
        setTool("signature");
      }}
      onDeleted={(id) => {
        if (activeSignature?.id !== id) return;
        setActiveSignature(null);
        if (tool === "signature") setTool("select");
      }}
    />
  ) : null;

  // A phone puts NOTHING in the document's flow. Reading is the default:
  // the tool grid is not rendered at all and its ~85px belong to the page.
  // Annotation mode floats the grid over the document instead of pushing it
  // down, so stepping in and out never moves the reading position — the same
  // rule the inspector already follows.
  //
  // Tablets and desktop fall through to the row below, unchanged: they have
  // the width for the grid, the inspector and its keyboard hints at once.
  if (isPhone) {
    const panelContents = {
      toolGrid: annotationMode,
      inspector: inspector != null,
    };
    const panelBand = floatingPanelBand(panelContents);
    return (
      <>
        {panelBand > 0 ? (
          <FloatingInspector
            selectionId={selection?.id ?? null}
            band={panelBand}
          >
            {annotationMode ? (
              <div data-shiori-tool-grid style={{ padding: "6px 8px" }}>
                {toolSegment}
              </div>
            ) : null}
            {inspector ? (
              <div
                data-shiori-floating-inspector-row
                style={{
                  borderTop: annotationMode
                    ? `1px dashed ${T.ruleSoft}`
                    : undefined,
                  // One line of controls, scroll sideways for the rest —
                  // wrapping would stack the Text inspector three deep and
                  // turn the panel into a sheet.
                  overflowX: "auto",
                  overflowY: "hidden",
                  WebkitOverflowScrolling: "touch",
                }}
              >
                {inspector}
              </div>
            ) : null}
          </FloatingInspector>
        ) : null}
        <AnnotateModeButton
          annotationMode={annotationMode}
          panelBand={panelBand}
          onToggle={() => setAnnotationMode(!annotationMode)}
        />
        {signatureDialog}
      </>
    );
  }

  return (
    <>
    <div
      className="shioriPrintHide"
      data-shiori-toolbar-flow
      style={{
        flex: "0 0 auto",
        // The active tab's colour (TabStrip): tab and toolbar read as one
        // surface rising out of the cream strip, as a browser's do. On cream
        // the white tab sat on the bar like a patch.
        background: T.paper,
        borderBottom: `1px solid ${T.rule}`,
      }}
    >
      {toolbarCollapsed ? (
        // Collapsed: a slim full-width strip that restores the tool row. The
        // tabs + top bar stay put — only this row (and the inspector below) is
        // hidden, unlike reader mode which hides all chrome. Shared by mobile
        // and desktop.
        <button
          type="button"
          onClick={() => setToolbarCollapsed(false)}
          title={t("nav.pdfChromeExpand")}
          style={{
            width: "100%",
            height: 26,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            border: "none",
            background: T.paper,
            color: T.dim,
            cursor: "pointer",
            font: `600 11px/1 ${T.sans}`,
            padding: 0,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <Ic.chev style={{ transform: "rotate(90deg)", width: 13, height: 13 }} />
          <span>{t("nav.pdfChromeExpand")}</span>
        </button>
      ) : isMobile ? (
        // Tool segment + a compact collapse caret on the right. Undo / redo /
        // fit-width live in the TopBar on mobile; zoom % is in the StatusBar.
        <div
          style={{
            padding:
              "4px calc(10px + var(--shiori-safe-right, 0px)) 4px calc(10px + var(--shiori-safe-left, 0px))",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {toolSegment}
          <IconBtn
            title={t("nav.pdfChromeCollapse")}
            onClick={() => setToolbarCollapsed(true)}
          >
            <Ic.chev style={{ transform: "rotate(-90deg)" }} />
          </IconBtn>
        </div>
      ) : (
        <div
          ref={toolbarRowRef}
          className="shioriToolbarRow"
          style={{
            height: 52,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "0 14px",
            // The toolbar shares its row's width with the right rail now, so
            // opening the terminal narrows it. Without this the buttons simply
            // ran off the end and were clipped at the rail's edge, which read
            // as the rail covering the toolbar rather than shrinking it.
            overflowX: "auto",
            overflowY: "hidden",
            scrollbarWidth: "none",
          }}
        >
          {toolSegment}

          {/* Undo/redo forfeit their spot before the zoom cluster does:
              they live on ⌘Z/⇧⌘Z anyway, and a squeezed row must keep the
              controls that have no keyboard twin. */}
          {iconOnlyTools ? null : (
            <>
              <div style={{ width: 1, height: 20, background: T.rule, margin: "0 4px" }} />
              <IconBtn title={k(t("tooltips.undo"))} onClick={undo} disabled={!canUndo}>
                <Ic.undo />
              </IconBtn>
              <IconBtn title={k(t("tooltips.redo"))} onClick={redo} disabled={!canRedo}>
                <Ic.redo />
              </IconBtn>
            </>
          )}

          <div style={{ flex: 1 }} />

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              flex: "0 0 auto",
              // The row overflow-scrolls when the rail + navigator squeeze
              // it. Anything not pinned scrolls out to the right — which is
              // exactly where this cluster sits, so it was the first thing
              // to vanish and read as "the rail covers the zoom controls".
              // Sticky pins it to the visible right edge at ANY width; the
              // tools scroll under it instead. The background masks them.
              position: "sticky",
              right: 0,
              zIndex: 1,
              background: T.paper,
              paddingLeft: 6,
            }}
          >
            <IconBtn
              title={t("tooltips.zoomOut")}
              onClick={() => setScale(zoomStepDown(scale))}
            >
              <Ic.zoomOut />
            </IconBtn>
            <ZoomField
              scale={scale}
              setScale={setScale}
              label={t("tooltips.zoomLevel")}
            />
            <IconBtn
              title={t("tooltips.zoomIn")}
              onClick={() => setScale(zoomStepUp(scale))}
            >
              <Ic.zoomIn />
            </IconBtn>
            {/* Fit-width is a momentary action, not a sticky toggle: each
                click just (re)applies the fit. The mode still lives in the
                store so the view re-fits on window resize, but we don't paint
                a persistent "selected" state — it reads as stuck (it's on by
                default and only clears on a manual zoom). */}
            <IconBtn
              title={t("tooltips.fitWidth")}
              onClick={() => setFitMode("width")}
            >
              <Ic.fit />
            </IconBtn>
            <IconBtn
              title={k(t("nav.readerMode"))}
              active={readerMode}
              onClick={toggleReaderMode}
            >
              <Ic.reader />
            </IconBtn>
            {/* Collapse the tool row, mirroring mobile — folds just this row
                and the inspector, not the whole chrome (that's reader mode). */}
            <div style={{ width: 1, height: 20, background: T.rule, margin: "0 2px" }} />
            <IconBtn
              title={t("nav.pdfChromeCollapse")}
              onClick={() => setToolbarCollapsed(true)}
            >
              <Ic.chev style={{ transform: "rotate(-90deg)" }} />
            </IconBtn>
          </div>
        </div>
      )}

      {inspector && !toolbarCollapsed ? (
        <div
          data-shiori-inspector-flow
          style={{
            borderTop: `1px dashed ${T.ruleSoft}`,
            background: T.paper,
            overflowX: isMobile ? "auto" : "visible",
            WebkitOverflowScrolling: isMobile ? "touch" : undefined,
            scrollbarWidth: isMobile ? "none" : undefined,
          }}
        >
          {inspector}
        </div>
      ) : null}
    </div>
    {signatureDialog}
    </>
  );
}

function TextContentEditor({
  overlay,
  label,
  placeholder,
  onChange,
  onFinish,
}: {
  overlay: TextOverlay | ContentTextOverlay | CalloutOverlay;
  label: string;
  placeholder: string;
  onChange: (text: string) => void;
  onFinish: (text: string) => void;
}) {
  return (
    <textarea
      dir="auto"
      value={overlay.text}
      aria-label={label}
      title={label}
      placeholder={placeholder}
      data-shiori-text-toolbar-editor="true"
      data-overlay-id={overlay.id}
      rows={1}
      onChange={(e) => onChange(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.dataset.escapeCommitted = "true";
        onFinish(e.currentTarget.value);
        e.currentTarget.blur();
      }}
      onBlur={(e) => {
        if (e.currentTarget.dataset.escapeCommitted === "true") {
          delete e.currentTarget.dataset.escapeCommitted;
          return;
        }
        onFinish(e.currentTarget.value);
      }}
      style={{
        width: 260,
        minWidth: 220,
        maxWidth: 360,
        height: 30,
        padding: "6px 9px",
        border: `1px solid ${T.rule}`,
        borderRadius: 6,
        background: T.surface,
        color: T.ink,
        outline: "none",
        resize: "none",
        overflow: "hidden",
        whiteSpace: "pre",
        font: `500 12.5px/1.2 ${T.sans}`,
        letterSpacing: 0,
      }}
      wrap="off"
    />
  );
}

/**
 * The phone's inspector: a fixed panel over the document rather than a row
 * in the toolbar's flow.
 *
 * Anchored to the bottom by default — the edge a thumb reaches, and the room
 * the status bar gave back. It moves to the top when the annotation it is
 * editing is down there, because a panel covering its own subject hides the
 * change being made. The choice is made once per selection: the panel is
 * small and the reader can always scroll, so re-deciding on every scroll
 * frame would cost far more than it is worth.
 */
/**
 * The phone's one way in and out of annotation mode.
 *
 * A single button in a fixed corner rather than a control that moves with
 * the mode: the pencil says "mark this up", and once you are in, the same
 * spot holds a filled ✓ that says "done". Both states carry a visible
 * accessible name, and the tool grid appearing underneath is the other half
 * of the answer to "which mode am I in".
 *
 * It rides above whatever the panel took, so opening the grid lifts the
 * button clear of it instead of parking it on top.
 */
function AnnotateModeButton({
  annotationMode,
  panelBand,
  onToggle,
}: {
  annotationMode: boolean;
  panelBand: number;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = annotationMode
    ? t("nav.annotateExit")
    : t("nav.annotateEnter");
  return (
    <button
      type="button"
      className="shioriPrintHide"
      data-shiori-annotate-button
      aria-pressed={annotationMode}
      title={label}
      aria-label={label}
      onClick={onToggle}
      style={{
        position: "fixed",
        right: `calc(${FLOATING_INSPECTOR_EDGE_GAP}px + var(--shiori-safe-right, 0px))`,
        bottom: annotateButtonBottom(panelBand),
        width: ANNOTATE_BUTTON_SIZE,
        height: ANNOTATE_BUTTON_SIZE,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        borderRadius: 999,
        // Filled while annotating, outlined while reading: the mode is
        // legible from the button alone, without reading its label.
        border: `1px solid ${annotationMode ? T.accent : T.rule}`,
        background: annotationMode ? T.accent : T.cream,
        color: annotationMode ? T.onAccent : T.ink2,
        boxShadow: "0 8px 24px rgba(20,16,10,0.22)",
        cursor: "pointer",
        // Above the page pill (42), below the drawer scrim (44) so an open
        // navigator dims it with the rest of the document.
        zIndex: 43,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      {annotationMode ? (
        <Ic.check width={20} height={20} />
      ) : (
        <Ic.edit width={20} height={20} />
      )}
    </button>
  );
}

type FloatingInspectorAnchor = {
  placement: FloatingInspectorPlacement;
  viewportTop: number;
};

/**
 * Read the geometry the placement depends on: the document viewport, and the
 * selected annotation inside it. Both belong to an already-committed tree, so
 * this reads what is on screen right now.
 */
function measureFloatingInspectorAnchor(
  selectionId: string | null,
  band: number,
): FloatingInspectorAnchor {
  const viewport = document
    .querySelector("[data-shiori-document-viewport]")
    ?.getBoundingClientRect();
  // Nothing measurable yet (first mount, before the shell has committed).
  // The bottom is the default anyway, so there is nothing to correct later.
  if (!viewport) return { placement: "bottom", viewportTop: 0 };
  // Overlay ids are nanoid (letters, digits, `_`, `-`), so a quoted
  // attribute selector needs no escaping.
  const selection = selectionId
    ? document
        .querySelector(`[data-overlay-id="${selectionId}"]`)
        ?.getBoundingClientRect() ?? null
    : null;
  return {
    placement: floatingInspectorPlacement({ selection, viewport, band }),
    viewportTop: viewport.top,
  };
}

function FloatingInspector({
  selectionId,
  band,
  children,
}: {
  selectionId: string | null;
  /** How much of the edge this panel's contents take — see floatingPanelBand. */
  band: number;
  children: ReactNode;
}) {
  // Measured once per selection, while rendering rather than from an effect:
  // React's "adjust state when a prop changes" pattern. An effect would paint
  // the panel at the old edge for a frame and then move it, and the
  // measurement has to come from the committed DOM, not from React state.
  const [anchor, setAnchor] = useState<FloatingInspectorAnchor>(() =>
    measureFloatingInspectorAnchor(selectionId, band),
  );
  // Re-measured when the selection changes, and when the panel grows or
  // shrinks: opening the tool grid doubles the band, which can put the
  // selection inside it.
  const [measuredFor, setMeasuredFor] = useState({ selectionId, band });
  if (measuredFor.selectionId !== selectionId || measuredFor.band !== band) {
    setMeasuredFor({ selectionId, band });
    setAnchor(measureFloatingInspectorAnchor(selectionId, band));
  }

  // Tell the page pill how much of the bottom edge is taken, so the two
  // never stack on top of each other.
  useEffect(() => {
    setFloatingInspectorBottomInset(
      anchor.placement === "bottom" ? band : 0,
    );
    return () => setFloatingInspectorBottomInset(0);
  }, [anchor.placement, band]);

  const atBottom = anchor.placement === "bottom";
  return (
    <div
      className="shioriPrintHide shioriFloatingInspector"
      data-shiori-floating-inspector
      data-placement={anchor.placement}
      style={{
        position: "fixed",
        left: `calc(${FLOATING_INSPECTOR_EDGE_GAP}px + var(--shiori-safe-left, 0px))`,
        right: `calc(${FLOATING_INSPECTOR_EDGE_GAP}px + var(--shiori-safe-right, 0px))`,
        ...(atBottom
          ? {
              bottom: `calc(${FLOATING_INSPECTOR_EDGE_GAP}px + var(--shiori-safe-bottom, 0px))`,
            }
          : { top: anchor.viewportTop + FLOATING_INSPECTOR_EDGE_GAP }),
        // Above the page pill (42), below the drawer scrim (44) so an open
        // navigator dims this with the rest of the document.
        zIndex: 43,
        background: T.cream,
        border: `1px solid ${T.rule}`,
        borderRadius: 12,
        boxShadow: "0 10px 30px rgba(20,16,10,0.22)",
        // The panel itself never scrolls: the tool grid wraps to its 4+2
        // rows, and the inspector row inside scrolls sideways on its own.
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

// Select mode has no properties, only a hint — and the hint is dropped on
// compact layouts. The row used to collapse to nothing there, so switching
// select ↔ any markup tool (or tapping an annotation) grew the toolbar by a
// full inspector row plus its border and pushed the document down 47 CSS px
// under the reader's eyes. The row therefore stays, label only, so the
// document keeps its screen position across every tool.
//
// Phones no longer reach this at all: their inspector floats over the
// document, so nothing in the flow has to be held open and select mode
// renders nothing. This placeholder is what keeps the same promise on
// tablets and narrow desktop windows, which still carry the row.
export function SelectInspector() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  return (
    <InspectorRow label={t("inspector.labels.select")}>
      {isMobile ? null : <Hint>{k(t("inspector.hints.select"))}</Hint>}
    </InspectorRow>
  );
}

export function InspectorRow({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}) {
  const isMobile = useIsMobile();
  return (
    <div
      style={{
        // Clear the tallest single-row control (the NumField weight
        // stepper, ~38 px) plus row padding, so the inspector height stays
        // fixed across tools — switching ink (WidthPicker, ~28) ↔ rect
        // (NumField) no longer makes the toolbar jump vertically. Padding
        // is 8 px on mobile (→ 46) and 16 px on desktop (→ 54).
        minHeight: isMobile ? 46 : 54,
        display: "flex",
        alignItems: "center",
        padding: isMobile ? "4px 10px" : "8px 14px",
        gap: isMobile ? 6 : 10,
      }}
    >
      <div
        style={{
          font: isMobile ? `13px/1 ${T.bodySerif}` : `14.5px/1 ${T.bodySerif}`,
          color: T.ink,
          marginRight: isMobile ? 2 : 6,
          // Sized by its text. The old 88px reservation was alignment
          // insurance across tools, but a two-character label ("文字")
          // left ~58px of nothing between it and its own controls — a
          // void with no job. Controls may shift a little when the tool
          // changes; the row switching content entirely masks it.
          letterSpacing: "-.01em",
          flex: "0 0 auto",
        }}
      >
        {label}
      </div>
      {children == null ? null : (
        <>
      <div
        style={{
          width: 1,
          height: isMobile ? 14 : 18,
          background: T.rule,
          marginRight: isMobile ? 2 : 4,
          flex: "0 0 auto",
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flex: 1,
          // Mobile keeps controls on a single line and lets the parent
          // overflowX scroll handle anything that doesn't fit (e.g.
          // the Text inspector with FontPicker + Size + Color + B +
          // Align). Otherwise wrap stacks them into 3-4 visual rows
          // and the toolbar eats half the screen.
          flexWrap: isMobile ? "nowrap" : "wrap",
        }}
      >
        {children}
      </div>
        </>
      )}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  // Hint copy is keyboard-shortcut-heavy ("Shift-click", "⌘+drag") and
  // reads as noise on a phone where none of those gestures exist. Drop
  // the entire hint on mobile so the inspector row only shows the
  // controls the user can actually act on.
  const isMobile = useIsMobile();
  if (isMobile) return null;
  return (
    <span
      style={{
        color: T.dim,
        font: `12.5px/1 ${T.sans}`,
        // Teaching text yields, never wraps: pushed to the row's right
        // edge, ellipsized when the controls need the room. As a plain
        // flex child it used to wrap onto a second line, doubling the
        // inspector's height with a mostly-empty row.
        marginLeft: "auto",
        flex: "0 1 auto",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        paddingLeft: 8,
      }}
    >
      {children}
    </span>
  );
}
