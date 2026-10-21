import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { useEscapeClose } from "./useEscapeClose";
import { useFixedPopoverPosition } from "./useFixedPopoverPosition";

// ────── ExpandableColorPicker (swatches + popover with curated palette,
// recent colors, and a native color input for fully custom hex values).
// Used by tools where the user reasonably wants free choice of colors,
// while keeping the first-row choices curated for quick common picks.

// Curated default palette — 24 colors across four hue bands. Tuned for
// Shiori's warm/editorial aesthetic: muted rather than saturated, and
// heavy on ink / terra / forest / navy variants that compose well on
// a paper-toned page. Override per call site by passing palette.
const DEFAULT_COLOR_PALETTE: string[] = [
  // Ink & warm grays
  "#1a1815", "#5a4a3a", "#8b7d6e", "#b9a98e", "#3a3a40", "#6a6c70",
  // Reds & warm accents
  "#b13a2e", "#dc6a3e", "#e89c68", "#7a2a2a", "#c28054", "#8a3a5a",
  // Greens
  "#2d5a3d", "#4a7a5a", "#7a9464", "#9fb588", "#365a5a", "#5a7a78",
  // Blues & violets
  "#2f5a8a", "#4a7aa5", "#7a94b3", "#4a4a7a", "#6a5a85", "#a08aad",
];

// Hit area for a palette swatch. The visible dot stays 20px; this is the
// tappable cell around it. Not the full 44px guideline — that would make the
// popover taller than most phone viewports — but a large enough step up that
// neighbouring colours stop being the likely target.
const COLOR_DOT_HIT_PX = 32;

export function ExpandableColorPicker({
  options,
  value,
  selectedValue = value,
  onChange,
  onCommit,
  onPreview,
  onPreviewEnd,
  recent = [],
  palette = DEFAULT_COLOR_PALETTE,
}: {
  options: string[];
  value: string;
  selectedValue?: string | null;
  // Live color update. Fires on every change — preset swatch click,
  // each tick of a native color picker drag. Caller wires this to
  // whatever visual state reflects the color (e.g. updateOverlay).
  onChange: (c: string) => void;
  // Committed, finalized pick. Preset swatches fire this immediately;
  // native-picker drags fire it once the stream has been quiet for
  // 300 ms, so recent-color recording doesn't flood during a drag.
  onCommit?: (c: string) => void;
  // The native picker's drag ticks, when the caller wants them apart from
  // discrete picks (without it they go to onChange). They form one session
  // per popover: a palette pick inside it lands here too, and onPreviewEnd
  // fires once the popover closes. Recolouring an annotation uses this to
  // make a whole drag one undo step instead of one per tick.
  onPreview?: (c: string) => void;
  onPreviewEnd?: () => void;
  recent?: string[];
  palette?: string[];
}) {
  const { t } = useTranslation();
  const moreLabel = t("color.more");
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  // Debounce the commit path so that rapid previews from the native
  // color picker collapse into one onCommit. useRef makes the timer
  // survive re-renders; the cleanup in useEffect fires on unmount so
  // HMR teardown doesn't leave a dangling timeout referencing the old
  // closure.
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommitRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      if (commitTimerRef.current !== null) {
        clearTimeout(commitTimerRef.current);
      }
    };
  }, []);
  const scheduleCommit = (c: string) => {
    if (!onCommit) return;
    pendingCommitRef.current = c;
    if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      const pending = pendingCommitRef.current;
      pendingCommitRef.current = null;
      commitTimerRef.current = null;
      if (pending !== null) onCommit(pending);
    }, 300);
  };
  const commitNow = (c: string) => {
    if (!onCommit) return;
    if (commitTimerRef.current !== null) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    pendingCommitRef.current = null;
    onCommit(c);
  };

  // Whether this popover session has streamed a preview. Closing the
  // popover (or unmounting with it open) ends the session.
  const previewingRef = useRef(false);
  const previewEndRef = useRef(onPreviewEnd);
  useEffect(() => {
    previewEndRef.current = onPreviewEnd;
  });
  useEffect(() => {
    if (!open) return;
    return () => {
      if (!previewingRef.current) return;
      previewingRef.current = false;
      previewEndRef.current?.();
    };
  }, [open]);

  // Main row rotates: recent colors take priority, then preset fills
  // the remaining slots up to options.length. De-duplicated so a color
  // that's both a recent and a preset doesn't show twice. Without this
  // rotation, a user picking their corporate blue custom color would
  // still be stuck going into the popover for it every time.
  const displayed: string[] = [];
  const seenRow = new Set<string>();
  for (const c of [...recent, ...options]) {
    const key = normalizeHex(c);
    if (seenRow.has(key)) continue;
    seenRow.add(key);
    displayed.push(c);
    if (displayed.length >= options.length) break;
  }

  return (
    <div
      ref={anchorRef}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        position: "relative",
      }}
    >
      {displayed.map((c) => {
        const selected = selectedValue !== null && sameColor(selectedValue, c);
        return (
          <button
            key={c}
            type="button"
            // A bare coloured square has no accessible name, so a screen
            // reader announced the whole palette as "button, button, button"
            // with nothing to tell red from blue. aria-pressed conveys which
            // one is active, which the ring only shows visually.
            title={normalizeHex(c)}
            aria-label={t("color.swatch", { hex: normalizeHex(c) })}
            aria-pressed={selected}
            onClick={() => {
              onChange(c);
              commitNow(c);
            }}
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: c,
              cursor: "pointer",
              border: `1.5px solid ${selected ? T.ink : T.rule}`,
              padding: 0,
              boxShadow: selected ? `0 0 0 2px ${T.paper}` : "none",
            }}
          />
        );
      })}
      <button
        type="button"
        title={moreLabel}
        onClick={() => setOpen((s) => !s)}
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: T.surface,
          cursor: "pointer",
          border: `1.5px dashed ${open ? T.ink : T.rule}`,
          padding: 0,
          color: T.dim,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          font: `500 14px/1 ${T.sans}`,
        }}
      >
        +
      </button>
      {open ? (
        <ColorPopover
          anchorRef={anchorRef}
          current={value}
          selectedValue={selectedValue}
          recent={recent}
          palette={palette}
          onPreview={(c) => {
            if (onPreview) {
              previewingRef.current = true;
              onPreview(c);
            } else {
              onChange(c);
            }
            scheduleCommit(c);
          }}
          onCommit={(c) => {
            if (onPreview && previewingRef.current) onPreview(c);
            else onChange(c);
            commitNow(c);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function ColorPopover({
  anchorRef,
  current,
  selectedValue = current,
  palette,
  recent,
  onPreview,
  onCommit,
  onClose,
}: {
  anchorRef: RefObject<HTMLDivElement | null>;
  current: string;
  selectedValue?: string | null;
  palette: string[];
  recent: string[];
  // Live update while interacting — the native color picker fires
  // this continuously during drag. Stays inside the popover.
  onPreview: (c: string) => void;
  // Final pick — closes the popover. Fires only from preset swatch
  // clicks, not from native picker drag events.
  onCommit: (c: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const position = useFixedPopoverPosition(true, anchorRef, popoverRef, {
    width: 184,
    // Taller than before: swatch cells grew from 20px to COLOR_DOT_HIT_PX and
    // the palette reflowed from 6 columns to 5.
    height: recent.length > 0 ? 392 : 310,
  });
  // Dismiss on Escape. Click-outside dismissal is handled by the
  // transparent backdrop rendered underneath the popover — a document
  // listener races with the trigger button's click and closes the
  // popover before onChange can fire.
  useEscapeClose(true, onClose);

  const dot = (c: string, key: string) => {
    const selected = selectedValue !== null && sameColor(selectedValue, c);
    return (
      // The button is the hit area, the span is the dot. The grid used to pack
      // 20px dots 5px apart, so on a touchscreen a neighbouring colour was
      // easy to hit; the cell is now 32px while the dot keeps its size, so the
      // palette still reads the same but is far harder to mis-tap.
      <button
        key={key}
        type="button"
        title={normalizeHex(c)}
        aria-label={t("color.swatch", { hex: normalizeHex(c) })}
        aria-pressed={selected}
        onClick={() => onCommit(c)}
        style={{
          width: COLOR_DOT_HIT_PX,
          height: COLOR_DOT_HIT_PX,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "none",
          borderRadius: "50%",
          padding: 0,
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: "block",
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: c,
            border: `1.5px solid ${selected ? T.ink : T.rule}`,
            boxShadow: selected ? `0 0 0 2px ${T.paper}` : "none",
          }}
        />
      </button>
    );
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "transparent",
          zIndex: 49,
        }}
      />
      <div
        ref={popoverRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          top: position.top,
          left: position.left,
          zIndex: 50,
          padding: 12,
          width: 184,
          visibility: position.ready ? "visible" : "hidden",
          background: T.cream,
          border: `1px solid ${T.rule}`,
          borderRadius: 6,
          boxShadow:
            "0 12px 32px rgba(20,16,10,0.18), 0 2px 4px rgba(20,16,10,0.06)",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {recent.length > 0 ? (
          <div>
            <PopoverSectionLabel>{t("color.recent")}</PopoverSectionLabel>
            <div style={{ display: "flex", gap: 0, flexWrap: "wrap" }}>
              {recent.map((c, i) => dot(c, `r-${c}-${i}`))}
            </div>
          </div>
        ) : null}
        <div>
          <PopoverSectionLabel>{t("color.palette")}</PopoverSectionLabel>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(5, ${COLOR_DOT_HIT_PX}px)`,
              columnGap: 0,
              rowGap: 0,
            }}
          >
            {palette.map((c) => dot(c, c))}
          </div>
        </div>
        <div>
          <PopoverSectionLabel>{t("color.custom")}</PopoverSectionLabel>
          <CustomColorTrigger current={current} onPreview={onPreview} />
        </div>
      </div>
    </>
  );
}

function CustomColorTrigger({
  current,
  onPreview,
}: {
  current: string;
  onPreview: (c: string) => void;
}) {
  // Programmatic .click() on a hidden <input type="color"> is
  // unreliable under WebKit / Tauri: Safari gates the native color
  // picker to trusted user gestures on a real, hit-testable element.
  // Instead, overlay a transparent-but-real input on top of the
  // styled label — the browser fires the picker directly from the
  // genuine click event.
  //
  // onChange here fires continuously while the user drags inside the
  // OS picker. Treat every emission as a live preview: update the
  // document, but do NOT close the popover — closing mid-drag would
  // unmount the input and kill the picker.
  return (
    <label
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        border: `1px solid ${T.rule}`,
        borderRadius: 4,
        background: T.surface,
        cursor: "pointer",
        font: `500 12px/1 ${T.mono}`,
        color: T.ink2,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: current,
          border: `1px solid ${T.rule}`,
          display: "inline-block",
        }}
      />
      <span style={{ letterSpacing: ".02em" }}>{normalizeHex(current)}</span>
      <input
        type="color"
        value={normalizeHex(current)}
        onChange={(e) => onPreview(e.currentTarget.value)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          opacity: 0,
          cursor: "pointer",
          padding: 0,
          border: 0,
          background: "transparent",
        }}
      />
    </label>
  );
}

function PopoverSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        font: `500 10.5px/1 ${T.mono}`,
        color: T.dim,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function sameColor(a: string, b: string): boolean {
  return normalizeHex(a) === normalizeHex(b);
}

function normalizeHex(hex: string): string {
  const raw = hex.replace(/^#/, "").toLowerCase();
  if (raw.length === 3) {
    return `#${raw
      .split("")
      .map((c) => c + c)
      .join("")}`;
  }
  if (raw.length === 6) return `#${raw}`;
  return "#000000";
}
