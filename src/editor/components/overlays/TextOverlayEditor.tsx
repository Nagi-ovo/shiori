// The textarea a text box, callout or original-text edit is typed into
// while it is being edited. Split out of ./OverlayDom.

import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type {
  CalloutOverlay,
  ContentTextOverlay,
  Overlay,
  TextOverlay,
} from "../../../pdf/model/types";

export function TextOverlayEditor({
  overlay,
  textareaRef,
  onDraftTextChange,
  onCommitEdit,
  onMaybeSuppressEditDragBlur,
}: {
  overlay: TextOverlay | ContentTextOverlay | CalloutOverlay;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onDraftTextChange?: (text: string) => void;
  onCommitEdit: (patch: Partial<Overlay>) => void;
  onMaybeSuppressEditDragBlur: (overlayId: string, now: number) => boolean;
}) {
  const isContentEdit = overlay.type === "contentText";
  const { t } = useTranslation();
  return (
    <textarea
      ref={textareaRef}
      autoFocus
      // The kind of box, as the inspector names it (describeOverlay's
      // inspector.labels.*): the text itself is the value, and a name built
      // from it would change, and be re-announced, on every keystroke.
      aria-label={t(`inspector.labels.${overlay.type}`)}
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
  );
}

function isToolbarTextEditorForOverlay(
  overlayId: string,
  target: EventTarget | null,
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const editor = target.closest<HTMLElement>("[data-shiori-text-toolbar-editor]");
  return editor?.dataset.overlayId === overlayId;
}
