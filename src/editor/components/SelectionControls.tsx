import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import {
  AlignGroup,
  ExpandableColorPicker,
  FontPicker,
  IconBtn,
  NumField,
  WidthPicker,
} from "./ui";
import { useAppStore, useEditorStore } from "../store/store";
import type {
  CalloutOverlay,
  ContentTextOverlay,
  Overlay,
  TextOverlay,
} from "../../pdf/model/types";
import { k } from "../../platform/keys";
import { copyLastTextEditDebug } from "../textSelection/textEditDebug";
import { toast } from "../toast";
import { isSignatureOverlay } from "./overlays/overlayGuards";
import { ROTATE_SNAP_DEG } from "./OverlayLayer";
import {
  FONT_OPTIONS,
  HIGHLIGHT_COLORS,
  NOTE_COLORS,
  RECT_COLORS,
  STAMP_WIDTH_OPTIONS,
  TEXT_FONT_SIZE_MAX,
  TEXT_LINE_COLORS,
} from "./inspectorOptions";
import { RectFillPicker, StampKindPicker } from "./InspectorPickers";

type EditableText = TextOverlay | ContentTextOverlay | CalloutOverlay;

/**
 * The inspector's controls for the selected annotation: its style, its size
 * and angle, lock and delete. ContextualToolbar wraps them in the row and
 * owns the toolbar text editor's history, which outlives one selection.
 */
export function SelectionControls({
  selection,
  onTextChange,
  onTextFinish,
}: {
  selection: Overlay;
  onTextChange: (overlay: EditableText, text: string) => void;
  onTextFinish: (overlay: EditableText, text: string) => void;
}) {
  const { t } = useTranslation();
  const setAnnot = useAppStore((s) => s.setAnnotDefaults);
  const setText = useEditorStore((s) => s.setTextDefaults);
  const recentColors = useAppStore((s) => s.prefs.recentColors);
  const pushRecentColor = useAppStore((s) => s.pushRecentColor);
  const collapsedCalloutIds = useEditorStore((s) => s.collapsedCalloutIds);
  const toggleCalloutCollapsed = useEditorStore((s) => s.toggleCalloutCollapsed);
  const removeSelected = useEditorStore((s) => s.removeSelected);
  const updateOverlay = useEditorStore((s) => s.updateOverlay);
  const setSelectedLocked = useEditorStore((s) => s.setSelectedLocked);

  const selType = selection.type;
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

  return (
    <>
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
              onChange={(text) => onTextChange(selection, text)}
              onFinish={(text) => onTextFinish(selection, text)}
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
