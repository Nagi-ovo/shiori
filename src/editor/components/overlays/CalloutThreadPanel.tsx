import { nanoid } from "nanoid";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../../design/tokens";
import { toast } from "../../toast";
import {
  useAppStore,
  useEditorStore,
  useEditorStoreApi,
} from "../../store/store";
import { sendCalloutFollowUp } from "../../../live/followUpLoop";
import { CAPABILITIES } from "../../../platform";
import { detectAgentClis, hasAgentCli } from "../../../platform/agentCli";
import type {
  CalloutOverlay,
  CalloutThreadEntry,
} from "../../../pdf/model/types";

/** Below this the panel is not worth showing in place — flip it instead. */
const MIN_PANEL_HEIGHT_PX = 96;

// The panel paints a fixed light paper, matching the callout card it hangs
// from, so its inks must be fixed too. Theme tokens track the UI chrome:
// under a dark theme `T.ink` resolves to #eaeff6, which on this near-white
// background rendered every reply — and the text you were typing — invisible
// (~1.06:1). The sticky note in OverlayDom pairs the same paper with exactly
// these inks; this panel is the one place that mixed the two systems.
const PAPER_INK = "#3a2f12";
const PAPER_DIM = "#7a6630";
const PAPER_ACCENT = "#6f5b28";

/**
 * The conversation under a callout: past turns plus a reply box. Rendered as
 * a sibling of the callout card (the card clips at its own bounds), inside a
 * wrapper that copies the card's box and rotation so the panel stays glued
 * to it on rotated pages. Shown only while the callout is selected/editing —
 * the printed/exported page keeps just the label, and the seal already
 * answers the density question for reading.
 */
export function CalloutThreadPanel({
  overlay,
  left,
  top,
  width,
  height,
  rotateDeg,
  scale,
  pageWidthPx,
  pageHeightPx,
  agentCliAvailable,
  onAppend,
  onReplaceThread,
}: {
  overlay: CalloutOverlay;
  left: number;
  top: number;
  width: number;
  height: number;
  rotateDeg: number;
  scale: number;
  /** Page size in display pixels — the panel must stay inside it. */
  pageWidthPx: number;
  pageHeightPx: number;
  /** Test/host override; production uses the cached native detection below. */
  agentCliAvailable?: boolean;
  onAppend: (entry: CalloutThreadEntry) => void;
  onReplaceThread: (thread: CalloutThreadEntry[] | undefined) => void;
}) {
  const { t } = useTranslation();
  const editorStore = useEditorStoreApi();
  const turns = overlay.thread ?? [];
  // Presentation-only, like the note/callout seals: folding the conversation
  // must not dirty the document or enter Undo history. Deleting a turn is the
  // opposite — that edits the document and is undoable.
  const collapsed = useEditorStore((state) =>
    state.collapsedThreadIds.includes(overlay.id),
  );
  const setThreadCollapsed = useEditorStore((state) => state.setThreadCollapsed);
  const showCalloutFollowUp = useAppStore(
    (state) => state.prefs.showCalloutFollowUp,
  );
  const detectedAgentCli = useDetectedAgentCli();
  const canFollowUp = agentCliAvailable ?? detectedAgentCli;
  // Uncontrolled on purpose, mirroring collapseCallout's read-the-DOM
  // pattern: the draft belongs to the box until Enter promotes it to a
  // turn, and nothing else needs to observe the keystrokes.
  const submit = (box: HTMLTextAreaElement) => {
    const text = box.value.trim();
    if (!text) return;
    const entry: CalloutThreadEntry = {
      id: nanoid(),
      role: "user",
      text,
      at: Date.now(),
    };
    onAppend(entry);
    box.value = "";
    // The follow-up loop: the same turn goes into the embedded terminal's
    // stdin so the agent session running there can answer with a
    // calloutReply. Nothing is lost without a terminal — the turn already
    // lives on the callout — but say so, once, where the user is looking.
    if (CAPABILITIES.embeddedTerminal) {
      if (
        sendCalloutFollowUp(overlay, entry, { editorStore }) === "no-terminal"
      ) {
        toast.show(
          t("overlays.threadNoTerminalToast"),
          t("overlays.threadNoTerminalDetail"),
        );
      }
    }
  };
  const bodyPx = Math.max(9, 11 * scale);
  const rolePx = Math.max(7.5, 8.5 * scale);
  const gap = Math.max(4, 6 * scale);

  // The panel is a popover, so it obeys popover rules: never leave the page.
  // Hanging it below the card unconditionally pushed it off the bottom edge
  // for any callout near the foot of a page.
  const panelWidth = Math.max(width, 150);
  const spaceBelow = Math.max(0, pageHeightPx - (top + height) - gap * 2);
  const spaceAbove = Math.max(0, top - gap * 2);
  // Flip up only when below is genuinely too cramped AND above is roomier —
  // below is the natural reading direction, so it keeps ties.
  const placeAbove = spaceBelow < MIN_PANEL_HEIGHT_PX && spaceAbove > spaceBelow;
  // Whatever room is left becomes a scroll box rather than an overflow: a
  // conversation long enough to exceed the page has to scroll somewhere.
  //
  // The floor cannot win against the room that actually exists. The page
  // clips (overflow: hidden), so a panel taller than its side of the callout
  // does not spill into the viewport where it could still be read — it is
  // cut off, taking the reply field with it. On a short page at low zoom that
  // made a conversation unreachable, so the preferred minimum yields to the
  // real space and the thread scrolls inside whatever is left.
  // The preferred minimum decides which side to hang on; it must not decide
  // the height. The page clips (overflow: hidden), so a panel taller than the
  // room on its side is not merely cramped — its lower half, reply field
  // included, is cut off and unreachable. On a short page at low zoom that
  // lost the conversation entirely. Take the room that exists and let the
  // thread scroll inside it.
  const maxHeight = Math.min(
    placeAbove ? spaceAbove : spaceBelow,
    Math.max(0, pageHeightPx - gap * 2),
  );
  // Same clamp horizontally: a callout near the right edge would otherwise
  // push the panel past it. Negative offset pulls it back inside.
  const overflowRight = Math.max(0, left + panelWidth - (pageWidthPx - gap));
  const panelLeft = -Math.min(overflowRight, Math.max(0, left - gap));

  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
        transform: `rotate(${rotateDeg}deg)`,
        transformOrigin: "center center",
        pointerEvents: "none",
        zIndex: 9,
      }}
    >
      <div
        data-role="interactive"
        dir="auto"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        style={{
          position: "absolute",
          ...(placeAbove
            ? { bottom: "100%", marginBottom: gap }
            : { top: "100%", marginTop: gap }),
          left: panelLeft,
          width: panelWidth,
          maxHeight,
          overflowY: "auto",
          overscrollBehavior: "contain",
          display: "flex",
          flexDirection: "column",
          gap: Math.max(4, 6 * scale),
          padding: `${Math.max(5, 7 * scale)}px ${Math.max(6, 8 * scale)}px`,
          background: "rgba(255,253,247,0.97)",
          border: "1px solid rgba(35,26,15,0.14)",
          borderRadius: 5,
          boxShadow: "0 2px 8px rgba(35,26,15,0.10)",
          boxSizing: "border-box",
          // Always clickable, exactly like the collapse/expand control: a
          // creation tool makes annotation BODIES transparent so a new
          // stroke can start on top of an old one, but this panel is
          // chrome, not document content. Inheriting that transparency
          // meant clicking "reply" while the callout tool was armed fell
          // through to the text layer and created another callout.
          pointerEvents: "auto",
          font: `400 ${bodyPx}px/1.5 ${T.sans}`,
        }}
      >
        {turns.length > 0 ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={() => setThreadCollapsed(overlay.id, !collapsed)}
            style={{
              appearance: "none",
              border: "none",
              background: "transparent",
              padding: 0,
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: 5,
              cursor: "pointer",
              font: `600 ${rolePx}px/1.4 ${T.mono}`,
              letterSpacing: "0.07em",
              textTransform: "uppercase",
              color: PAPER_DIM,
              textAlign: "left",
            }}
            title={
              collapsed
                ? t("overlays.threadExpand")
                : t("overlays.threadCollapse")
            }
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="none"
              aria-hidden
              style={{
                transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
                transition: "transform 140ms ease",
                flex: "none",
              }}
            >
              <path
                d="M2.5 1L6 4L2.5 7"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {t("overlays.threadCount", { count: turns.length })}
          </button>
        ) : null}
        {collapsed
          ? null
          : turns.map((entry) => (
              <div
                key={entry.id}
                style={{ display: "flex", flexDirection: "column", gap: 1 }}
              >
                <span
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 6,
                    font: `600 ${rolePx}px/1.4 ${T.mono}`,
                    letterSpacing: "0.07em",
                    textTransform: "uppercase",
                    color: entry.role === "agent" ? PAPER_ACCENT : PAPER_DIM,
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {entry.role === "agent"
                      ? entry.author ?? t("overlays.threadAgent")
                      : t("overlays.threadYou")}
                  </span>
                  {overlay.locked ? null : (
                    <button
                      type="button"
                      title={t("overlays.threadDeleteTurn")}
                      aria-label={t("overlays.threadDeleteTurn")}
                      onClick={() => {
                        const rest = turns.filter(
                          (turn) => turn.id !== entry.id,
                        );
                        // One undo step, like any other annotation edit.
                        onReplaceThread(rest.length > 0 ? rest : undefined);
                      }}
                      style={{
                        appearance: "none",
                        border: "none",
                        background: "transparent",
                        padding: "0 2px",
                        margin: 0,
                        cursor: "pointer",
                        color: PAPER_DIM,
                        font: `500 ${Math.max(11, rolePx * 1.35)}px/1 ${T.sans}`,
                        flex: "none",
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
                <span
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    color: PAPER_INK,
                  }}
                >
                  {entry.text}
                </span>
              </div>
            ))}
        {overlay.locked || collapsed || !showCalloutFollowUp || !canFollowUp ? null : (
          <textarea
            rows={1}
            placeholder={t("overlays.threadReplyPlaceholder")}
            data-role="interactive"
            dir="auto"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              // Typing must never reach canvas shortcuts (Delete would
              // remove the overlay under the caret).
              e.stopPropagation();
              // Enter sends; Shift+Enter breaks a line; a composing IME's
              // Enter (Chinese/Japanese candidate confirm) never sends.
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                submit(e.currentTarget);
              }
            }}
            style={{
              border: "1px solid rgba(35,26,15,0.14)",
              borderRadius: 4,
              padding: `${Math.max(3, 4 * scale)}px ${Math.max(4, 6 * scale)}px`,
              font: "inherit",
              color: PAPER_INK,
              background: "rgba(255,255,255,0.9)",
              resize: "none",
              outline: "none",
              width: "100%",
              boxSizing: "border-box",
            }}
          />
        )}
      </div>
    </div>
  );
}

function useDetectedAgentCli(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let current = true;
    void detectAgentClis().then((result) => {
      if (current) setAvailable(hasAgentCli(result));
    });
    return () => {
      current = false;
    };
  }, []);
  return available;
}
