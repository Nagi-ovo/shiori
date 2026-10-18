import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { useIsMobile } from "../hooks/useIsMobile";
import { useEscapeClose } from "./useEscapeClose";
import { useFocusTrap } from "./useFocusTrap";
import { useInertBackground } from "./useInertBackground";
import { CAPABILITIES } from "../../platform";

// ────── IconBtn
type IconBtnProps = Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-controls" | "aria-expanded" | "aria-label"
> & {
  onClick?: (e: React.MouseEvent) => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  title?: string;
  active?: boolean;
  children: ReactNode;
  disabled?: boolean;
  tone?: "ghost" | "primary" | "outline";
  stretch?: boolean;
};

export function IconBtn({
  onClick,
  onMouseDown,
  title,
  active,
  children,
  disabled,
  tone = "ghost",
  stretch,
  "aria-controls": ariaControls,
  "aria-expanded": ariaExpanded,
  "aria-label": ariaLabel,
}: IconBtnProps) {
  const [hover, setHover] = useState(false);
  const baseStyle: CSSProperties = {
    height: 32,
    minWidth: 32,
    padding: "0 8px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    // Longhands, not `border`: a tone or the active state sets borderColor,
    // and when active clears React removes that longhand alone, leaving no
    // colour at all (currentColor) instead of the shorthand's transparent.
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: 6,
    background: "transparent",
    color: T.ink2,
    cursor: disabled ? "not-allowed" : "pointer",
    font: `500 13px/1 ${T.sans}`,
    letterSpacing: "-0.005em",
    transition: "background .12s, color .12s, border-color .12s",
    opacity: disabled ? 0.35 : 1,
    width: stretch ? "100%" : undefined,
  };
  const toneStyle: CSSProperties =
    tone === "primary"
      ? { background: T.ink, color: T.cream, borderColor: T.ink }
      : tone === "outline"
        ? { borderColor: T.rule, background: T.surface }
        : {};
  const activeStyle: CSSProperties | null = active
    ? { background: T.ink, color: T.cream, borderColor: T.ink }
    : null;
  const hoverStyle: CSSProperties | null =
    hover && !disabled && !active && tone === "ghost"
      ? { background: T.tint }
      : null;
  return (
    <button
      type="button"
      // `disabled` used to drive only the styling and the click guard, leaving
      // the button focusable: keyboard users tabbed onto a dead control, screen
      // readers never announced it as unavailable, and the modal focus trap
      // counted it as a landing spot (its selector excludes `[disabled]`).
      // `MiniIconBtn` has always passed it through — this matches.
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      onMouseDown={disabled ? undefined : onMouseDown}
      title={title}
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      // Most call sites are icon-only and name themselves with `title` alone.
      // `title` is only a last-resort accessible name: touch has no hover to
      // reveal it and several screen readers skip it by default. Promote it
      // unless the caller passed a real label. Call sites that also render
      // visible text must pass `aria-label` explicitly so the visible string
      // stays inside the accessible name (WCAG 2.5.3).
      aria-label={ariaLabel ?? title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...baseStyle, ...toneStyle, ...activeStyle, ...hoverStyle }}
    >
      {children}
    </button>
  );
}

// ────── Mini icon button for tight spaces; keeps the icon small but gives
// touch users a less fiddly target.
export function MiniIconBtn({
  onClick,
  title,
  children,
  disabled = false,
  size = 32,
}: {
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  children: ReactNode;
  disabled?: boolean;
  // Defaults to a 32px touch target; tighter contexts (tab close button)
  // pass a smaller size so it fits inside short chrome without overflowing.
  size?: number;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: size,
        height: size,
        border: "none",
        background: hover && !disabled ? T.tint : "transparent",
        color: T.ink2,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        borderRadius: 4,
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

// ────── Kbd
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 26,
        height: 22,
        padding: "0 7px",
        borderRadius: 4,
        background: T.tint,
        color: T.dim,
        border: `1px solid ${T.rule}`,
        // box-sizing is border-box globally, so content area needs enough
        // room for wide glyphs like ⌘ (U+2318) in JetBrains Mono.
        font: `500 11.5px/1 ${T.mono}`,
      }}
    >
      {children}
    </kbd>
  );
}

// ────── Divider
export function Divider({ vertical = false }: { vertical?: boolean }) {
  return (
    <div
      style={
        vertical
          ? { width: 1, alignSelf: "stretch", background: T.rule, margin: "6px 4px" }
          : { height: 1, background: T.rule, margin: "6px 0" }
      }
    />
  );
}

// ────── Chip
export function Chip({
  children,
  active,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <span
      onClick={onClick}
      style={{
        height: 26,
        padding: "0 10px",
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 13,
        background: active ? T.ink : T.surface,
        color: active ? T.cream : T.ink2,
        border: `1px solid ${active ? T.ink : T.rule}`,
        font: `500 12px/1 ${T.sans}`,
        letterSpacing: "-.005em",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      {children}
    </span>
  );
}

// ────── ColorSwatch (display only)
export function ColorSwatch({ value }: { value: string }) {
  return (
    <div
      style={{
        width: 22,
        height: 22,
        borderRadius: "50%",
        background: value,
        border: `1px solid ${T.rule}`,
        boxShadow: "inset 0 0 0 2px rgba(255,255,255,0.6)",
      }}
    />
  );
}

// ────── ColorSwatches (selectable)
export function ColorSwatches({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange?: (c: string) => void;
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {options.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange?.(c)}
          style={{
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: c,
            cursor: "pointer",
            border: `1.5px solid ${value === c ? T.ink : T.rule}`,
            padding: 0,
            boxShadow: value === c ? `0 0 0 2px ${T.paper}` : "none",
          }}
        />
      ))}
    </div>
  );
}

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

type FixedPopoverPosition = { left: number; top: number; ready: boolean };

const VIEWPORT_POPOVER_MARGIN = 8;
// Hit area for a palette swatch. The visible dot stays 20px; this is the
// tappable cell around it. Not the full 44px guideline — that would make the
// popover taller than most phone viewports — but a large enough step up that
// neighbouring colours stop being the likely target.
const COLOR_DOT_HIT_PX = 32;

function useFixedPopoverPosition<
  A extends HTMLElement,
  P extends HTMLElement,
>(
  open: boolean,
  anchorRef: RefObject<A | null>,
  popoverRef: RefObject<P | null>,
  fallbackSize: { width: number; height: number },
): FixedPopoverPosition {
  const [position, setPosition] = useState<FixedPopoverPosition>({
    left: VIEWPORT_POPOVER_MARGIN,
    top: VIEWPORT_POPOVER_MARGIN,
    ready: false,
  });

  useEffect(() => {
    if (!open) return;

    let frame = 0;
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const anchorRect = anchor.getBoundingClientRect();
      const popover = popoverRef.current;
      const width = popover?.offsetWidth || fallbackSize.width;
      const height = popover?.offsetHeight || fallbackSize.height;
      const maxLeft = Math.max(
        VIEWPORT_POPOVER_MARGIN,
        window.innerWidth - width - VIEWPORT_POPOVER_MARGIN,
      );
      const maxTop = Math.max(
        VIEWPORT_POPOVER_MARGIN,
        window.innerHeight - height - VIEWPORT_POPOVER_MARGIN,
      );
      const left = clamp(
        anchorRect.left,
        VIEWPORT_POPOVER_MARGIN,
        maxLeft,
      );
      const belowTop = anchorRect.bottom + 6;
      const aboveTop = anchorRect.top - height - 6;
      const preferredTop =
        belowTop + height <= window.innerHeight - VIEWPORT_POPOVER_MARGIN ||
        aboveTop < VIEWPORT_POPOVER_MARGIN
          ? belowTop
          : aboveTop;

      setPosition({
        left,
        top: clamp(preferredTop, VIEWPORT_POPOVER_MARGIN, maxTop),
        ready: true,
      });
    };

    update();
    frame = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, fallbackSize.height, fallbackSize.width, open, popoverRef]);

  return position;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function ExpandableColorPicker({
  options,
  value,
  selectedValue = value,
  onChange,
  onCommit,
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
            onChange(c);
            scheduleCommit(c);
          }}
          onCommit={(c) => {
            onChange(c);
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

// One track for the value whether it is being read or typed. Three digits plus
// a minus sign at 12.5px mono; tabular figures mean the width never shifts as
// the digits change either.
const VALUE_SLOT: CSSProperties = {
  width: 34,
  font: `500 12.5px/1 var(--opx-font-mono)`,
  fontVariantNumeric: "tabular-nums",
  color: "var(--opx-ink)",
  textAlign: "right",
};

// A 9x9 minus / plus mark. The steppers used to be two 7x4 chevrons stacked
// in a 16x13 column; side by side at 24x24 each they meet the WCAG target
// size floor and a plain +/- reads at that size where a chevron smudges.
function StepMark({ plus }: { plus: boolean }) {
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
      <path
        d={plus ? "M0.5 4.5H8.5M4.5 0.5V8.5" : "M0.5 4.5H8.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ────── NumField (stepper)
export function NumField({
  label,
  value,
  suffix,
  onMinus,
  onPlus,
  onCommit,
  min,
  max,
}: {
  label?: string;
  value: number | string;
  suffix?: string;
  onMinus?: () => void;
  onPlus?: () => void;
  // Typing a value directly. Without this the only way to reach a number is to
  // click a stepper repeatedly — 4pt or 15° at a time — which is unusable for
  // anything but the smallest adjustment.
  onCommit?: (next: number) => void;
  min?: number;
  max?: number;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape clears the draft, which unmounts the input — and unmounting fires
  // blur, whose handler commits. Without this latch, Escape would write the
  // very value it is meant to discard.
  const cancellingRef = useRef(false);
  const [hover, setHover] = useState(false);
  const editable = onCommit !== undefined;
  const editing = draft !== null;

  const commitDraft = (raw: string) => {
    const parsed = parseFloat(raw.replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(parsed) && onCommit) {
      let next = parsed;
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      onCommit(next);
    }
    setDraft(null);
  };

  // Commit on any pointerdown outside the input. Blur alone is not enough:
  // the PDF surface calls preventDefault on pointerdown, which suppresses the
  // blur and would leave the field stuck open. Same accommodation ZoomField
  // makes for the same reason.
  useEffect(() => {
    if (!editing) return;
    const onDown = (event: PointerEvent) => {
      const el = inputRef.current;
      if (el && !el.contains(event.target as Node)) commitDraft(el.value);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  // 24x24 is the WCAG 2.2 target-size floor. The previous 16x13 pair was
  // stacked with centres 15px apart, so neither the size nor the spacing
  // exception held, and on touch the two were one smudge.
  const stepBtn: CSSProperties = {
    width: 24,
    height: 24,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    borderRadius: 4,
    color: T.dim,
    cursor: "pointer",
    padding: 0,
  };
  // The steppers are the fallback now that the value can be typed, so they
  // recede while the field is idle — but they never disappear: a control
  // that only exists on hover is invisible to touch and to anyone who does
  // not already know it is there.
  const stepsEmphasised = hover || editing;
  // Arrow keys on the value button step without opening the editor, so the
  // keyboard has the same one-notch nudge the mouse gets from the buttons.
  const stepFromKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowUp" && onPlus) {
      e.preventDefault();
      e.stopPropagation();
      onPlus();
    } else if (e.key === "ArrowDown" && onMinus) {
      e.preventDefault();
      e.stopPropagation();
      onMinus();
    }
  };
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        minHeight: 36,
        padding: "0 4px 0 10px",
        borderRadius: 6,
        background: T.surface,
        border: `1px solid ${T.rule}`,
      }}
    >
      {label ? (
        <span style={{ font: `12px/1 ${T.sans}`, color: T.dim }}>{label}</span>
      ) : null}
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          value={draft}
          inputMode="decimal"
          aria-label={label}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            if (cancellingRef.current) {
              cancellingRef.current = false;
              return;
            }
            commitDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitDraft((e.target as HTMLInputElement).value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancellingRef.current = true;
              setDraft(null);
            }
            // The canvas listens for bare letters and arrows; a value being
            // typed here must not also arm a tool or nudge the selection.
            e.stopPropagation();
          }}
          style={{
            // Same track as the static value below, so opening the editor
            // does not make the whole field jump wider.
            ...VALUE_SLOT,
            background: "transparent",
            border: "none",
            outline: "none",
            padding: 0,
          }}
        />
      ) : (
        editable ? (
          // A button, not a click-handled span, so the field is reachable and
          // openable from the keyboard like any other control.
          <button
            type="button"
            onClick={() => setDraft(String(value))}
            onKeyDown={stepFromKey}
            aria-label={label ? `${label}: ${value}` : String(value)}
            style={{
              ...VALUE_SLOT,
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "text",
            }}
          >
            {value}
          </button>
        ) : (
          <span
            // Stepping used to announce nothing: press "Increase" and a screen
            // reader had no way to learn that 12 became 13. A polite region
            // re-reads it after each step.
            role="status"
            aria-live="polite"
            style={VALUE_SLOT}
          >
            {value}
          </span>
        )
      )}
      {suffix ? (
        <span style={{ font: `11.5px/1 ${T.mono}`, color: T.dim }}>{suffix}</span>
      ) : null}
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 2,
          opacity: stepsEmphasised ? 1 : 0.62,
          transition: "opacity .12s",
        }}
      >
        <button
          type="button"
          onClick={onMinus}
          style={stepBtn}
          onFocus={() => setHover(true)}
          onBlur={() => setHover(false)}
          title={t("common.decrease")}
          aria-label={
            label ? `${t("common.decrease")}: ${label}` : t("common.decrease")
          }
        >
          <StepMark plus={false} />
        </button>
        <button
          type="button"
          onClick={onPlus}
          style={stepBtn}
          onFocus={() => setHover(true)}
          onBlur={() => setHover(false)}
          title={t("common.increase")}
          // "Increase" alone never said what it increases; with several
          // NumFields side by side in the inspector that is unusable.
          aria-label={
            label ? `${t("common.increase")}: ${label}` : t("common.increase")
          }
        >
          <StepMark plus />
        </button>
      </div>
    </div>
  );
}

// ────── WidthPicker (line weight)
export function WidthPicker({
  value,
  onChange,
  options = [1, 2, 4, 6],
}: {
  value: number;
  onChange: (v: number) => void;
  options?: number[];
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t("inspector.fields.weight")}
      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
    >
      {options.map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => onChange(w)}
          // The only child is an unlabelled bar <div>, so without this the
          // whole row announced as "button, button, button" with no way to
          // tell 1pt from 6pt, nor which one is active.
          aria-label={t("inspector.fields.lineWeight", { value: w })}
          aria-pressed={value === w}
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: value === w ? T.tint : "transparent",
            border: `1px solid ${value === w ? T.rule : "transparent"}`,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <div
            style={{
              width: 14,
              height: w,
              borderRadius: w,
              background: T.ink,
            }}
          />
        </button>
      ))}
    </div>
  );
}

// ────── AlignGroup
export function AlignGroup({
  value,
  onChange,
}: {
  value: "left" | "center" | "right";
  onChange: (v: "left" | "center" | "right") => void;
}) {
  const { t } = useTranslation();
  const opts: Array<{ v: "left" | "center" | "right"; I: typeof Ic.alignL }> = [
    { v: "left", I: Ic.alignL },
    { v: "center", I: Ic.alignC },
    { v: "right", I: Ic.alignR },
  ];
  return (
    <div
      role="group"
      aria-label={t("inspector.align.label")}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0,
        border: `1px solid ${T.rule}`,
        borderRadius: 6,
        background: T.surface,
      }}
    >
      {opts.map((o, i) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          // Icon-only, so each option needs its own name and pressed state —
          // otherwise the group reads as three anonymous buttons with no
          // indication of the current alignment.
          aria-label={t(`inspector.align.${o.v}`)}
          aria-pressed={value === o.v}
          style={{
            width: 28,
            height: 28,
            background: value === o.v ? T.ink : "transparent",
            color: value === o.v ? T.cream : T.ink2,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            border: "none",
            borderLeft: i === 0 ? "none" : `1px solid ${T.rule}`,
            padding: 0,
          }}
        >
          <o.I />
        </button>
      ))}
    </div>
  );
}

// ────── Switch
export function Switch({
  on,
  onChange,
  ariaLabel,
}: {
  on: boolean;
  onChange?: (v: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange?.(!on)}
      style={{
        width: 40,
        height: 24,
        borderRadius: 12,
        background: on ? T.ink : T.soft,
        position: "relative",
        transition: "background .15s",
        flex: "0 0 auto",
        marginTop: 1,
        border: "none",
        cursor: onChange ? "pointer" : "default",
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 19 : 3,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: T.surface,
          transition: "left .15s",
        }}
      />
    </button>
  );
}

// Hides a control visually while keeping it focusable and in the accessibility
// tree — the distinction `display: none` and `visibility: hidden` both lose.
// (ToastHost and ExternalTerminalLauncher each grew their own copy of this
// shape; folding the three together is a refactor for its own change.)
const VISUALLY_HIDDEN_INPUT: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

// ────── Radio (vertical list)
export type RadioOption<V extends string> = {
  v: V;
  label: string;
  hint?: string;
};
export function Radio<V extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<RadioOption<V>>;
  value: V;
  onChange: (v: V) => void;
  // Names the group for assistive tech. Callers that render their own visible
  // heading should pass its text so the group announces the same thing.
  label?: string;
}) {
  // One shared `name` turns the options into a real radio group, which is what
  // gives arrow-key navigation and single-selection semantics for free.
  const groupName = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{
        display: "flex",
        flexDirection: "column",
        border: `1px solid ${T.rule}`,
        borderRadius: 4,
        background: T.surface,
        overflow: "hidden",
      }}
    >
      {options.map((o, i) => {
        const a = value === o.v;
        return (
          <label
            key={o.v}
            // The clipped input is what actually takes focus, so the row
            // borrows its ring (see .shioriRadioRow in app.css) — otherwise
            // keyboard focus would be completely invisible here.
            className="shioriRadioRow"
            style={{
              display: "grid",
              gridTemplateColumns: "17px minmax(0, 1fr)",
              alignItems: "start",
              columnGap: 12,
              padding: "11px 14px",
              cursor: "pointer",
              borderTop: i === 0 ? "none" : `1px solid ${T.ruleSoft}`,
              background: a ? T.paper : "transparent",
            }}
          >
            <span
              style={{
                width: 15,
                height: 15,
                marginTop: 2,
                borderRadius: "50%",
                border: `1.5px solid ${a ? T.ink : T.soft}`,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "0 0 auto",
              }}
            >
              {a ? (
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: T.ink,
                  }}
                />
              ) : null}
            </span>
            <span
              style={{
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <span
                style={{
                  font: `600 13.5px/1.25 ${T.sans}`,
                  color: T.ink,
                }}
              >
                {o.label}
              </span>
              {o.hint ? (
                <span
                  style={{
                    font: `12.5px/1.45 ${T.sans}`,
                    color: T.dim,
                    letterSpacing: 0,
                    overflowWrap: "anywhere",
                  }}
                >
                  {o.hint}
                </span>
              ) : null}
            </span>
            <input
              type="radio"
              name={groupName}
              checked={a}
              onChange={() => onChange(o.v)}
              // `display: none` did not merely hide the control, it removed it
              // from the tab order AND the accessibility tree — so the visible
              // dot above was the only thing left, and it is a decorative
              // <span>. Every Radio group in the app was keyboard-unreachable:
              // in Export, that meant page range, annotations and quality
              // could never be changed without a mouse. Clip it instead, which
              // hides it visually while leaving a real, focusable radio.
              style={VISUALLY_HIDDEN_INPUT}
            />
          </label>
        );
      })}
    </div>
  );
}

// ────── Toggle row (switch + label + hint)
export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "10px 0",
        cursor: onChange ? "pointer" : "default",
      }}
    >
      {/* HTML-AAM does not list <label> as a naming source for <button>, so
          wrapping the switch in one left its accessible name browser-dependent
          — "switch, off" with no hint of which setting, in a panel full of
          them. Pass the row's text through explicitly. */}
      <Switch on={checked} onChange={onChange} ariaLabel={label} />
      <div style={{ flex: 1 }}>
        <div style={{ font: `500 13.5px/1.3 ${T.sans}`, color: T.ink }}>
          {label}
        </div>
        {hint ? (
          <div
            style={{
              font: `12.5px/1.45 ${T.sans}`,
              color: T.dim,
              marginTop: 2,
            }}
          >
            {hint}
          </div>
        ) : null}
      </div>
    </label>
  );
}

// ────── Segmented buttons (compact 3-way)
export function SegButtons<V extends string>({
  options,
  value,
  onChange,
}: {
  options: V[];
  value: V;
  onChange?: (v: V) => void;
}) {
  // On mobile the row stacks the control under its label, so stretch to fill
  // the width with equal-width segments (a deliberate, tappable bar) instead
  // of floating compact at the left with dead space beside it. Desktop keeps
  // the inline pill that reads as a control next to its label.
  const isMobile = useIsMobile();
  const mobileGrid = isMobile && options.length > 3;
  return (
    <div
      style={{
        display: mobileGrid ? "grid" : isMobile ? "flex" : "inline-flex",
        gridTemplateColumns: mobileGrid ? "repeat(2, minmax(0, 1fr))" : undefined,
        width: isMobile ? "100%" : undefined,
        gap: 0,
        border: `1px solid ${T.rule}`,
        borderRadius: 6,
        background: T.surface,
        overflow: "hidden",
      }}
    >
      {options.map((o, i) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange?.(o)}
          // Which segment is current was carried by background colour alone.
          // A screen-reader user heard "English, button. 中文, button." with
          // nothing to say which one is in effect.
          aria-pressed={o === value}
          style={{
            flex: isMobile && !mobileGrid ? "1 1 0" : undefined,
            minWidth: 0,
            padding: isMobile ? "7px 6px" : "4px 10px",
            font: `500 12px/1.15 ${T.sans}`,
            background: o === value ? T.ink : "transparent",
            color: o === value ? T.cream : T.ink2,
            borderLeft:
              i === 0 || (mobileGrid && i % 2 === 0)
                ? "none"
                : `1px solid ${T.rule}`,
            borderTop: mobileGrid && i > 1 ? `1px solid ${T.rule}` : "none",
            borderRight: "none",
            borderBottom: "none",
            cursor: "pointer",
            whiteSpace: "normal",
          }}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

// ────── SegTabs (rounded, cream bg, like the outline/comments tabs)
export function SegTabs<V extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ v: V; label: string; badge?: number }>;
  value: V;
  onChange: (v: V) => void;
}) {
  const activeButtonRef = useRef<HTMLButtonElement>(null);
  const activeTab = tabs.find((tab) => tab.v === value);

  useEffect(() => {
    activeButtonRef.current?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTab?.badge, activeTab?.label, tabs.length, value]);

  return (
    <div
      className="shioriSegTabs"
      // Flat on purpose. This used to be a bordered, tinted box holding
      // bordered white pills, sitting inside a panel that already has a
      // border — three nested frames for one row of words. The active tab is
      // marked by weight and an underline instead, which needs no box at all.
      style={{
        display: "flex",
        width: "100%",
        minWidth: 0,
        gap: 2,
        overflowX: "auto",
        scrollbarWidth: "none",
      }}
    >
      {tabs.map((t) => {
        const a = value === t.v;
        return (
          <button
            ref={a ? activeButtonRef : undefined}
            key={t.v}
            type="button"
            onClick={() => onChange(t.v)}
            // Selection was conveyed by weight and an underline only. Stated
            // as aria-pressed rather than role="tab"/aria-selected on purpose:
            // there is no tabpanel wiring here, and claiming the tab pattern
            // without it would promise arrow-key navigation that does not
            // exist — the same trap the drag handles fell into.
            aria-pressed={a}
            style={{
              height: 30,
              padding: "0 8px",
              border: "none",
              // The underline sits on the row's own baseline, so the strip
              // reads as one line of labels rather than a tray of buttons.
              borderBottom: `2px solid ${a ? T.accent : "transparent"}`,
              cursor: "pointer",
              background: "transparent",
              color: a ? T.ink : T.dim,
              font: `${a ? 600 : 500} 12px/1 ${T.sans}`,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              flex: "0 0 auto",
            }}
          >
            {t.label}
            {typeof t.badge === "number" && t.badge > 0 ? (
              <span
                style={{
                  minWidth: 16,
                  height: 16,
                  padding: "0 4px",
                  borderRadius: 8,
                  background: T.ink,
                  color: T.cream,
                  font: `600 10px/1 ${T.sans}`,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {t.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ────── FontPicker (compact dropdown)
export type FontPickerOption<V extends string> = {
  value: V;
  name: string;
  previewCss: string;
};

export function FontPicker<V extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<FontPickerOption<V>>;
  value: V;
  onChange: (v: V) => void;
}) {
  const active = options.find((o) => o.value === value) ?? options[0];
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const position = useFixedPopoverPosition(open, anchorRef, popoverRef, {
    width: 212,
    height: Math.max(44, options.length * 36 + 8),
  });
  const close = () => setOpen(false);
  useEscapeClose(open, close);

  return (
    <div
      ref={anchorRef}
      style={{
        display: "inline-flex",
        position: "relative",
        flex: "0 0 auto",
      }}
    >
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((s) => !s)}
        style={{
          height: 28,
          minWidth: 148,
          maxWidth: 190,
          padding: "0 8px 0 9px",
          border: `1px solid ${T.rule}`,
          borderRadius: 6,
          background: T.surface,
          color: T.ink,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          font: `500 12px/1 ${active?.previewCss ?? T.sans}`,
          letterSpacing: 0,
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {active?.name ?? ""}
        </span>
        <Ic.chev
          style={{
            flex: "0 0 auto",
            color: T.dim,
            transform: open ? "rotate(-90deg)" : "rotate(90deg)",
          }}
        />
      </button>
      {open ? (
        <>
          <div
            onClick={close}
            style={{
              position: "fixed",
              inset: 0,
              background: "transparent",
              zIndex: 49,
            }}
          />
          <div
            ref={popoverRef}
            role="listbox"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              width: 212,
              maxWidth: "calc(100vw - 16px)",
              padding: 4,
              zIndex: 50,
              visibility: position.ready ? "visible" : "hidden",
              background: T.cream,
              border: `1px solid ${T.rule}`,
              borderRadius: 6,
              boxShadow:
                "0 12px 32px rgba(20,16,10,0.18), 0 2px 4px rgba(20,16,10,0.06)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {options.map((o) => {
              const selected = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(o.value);
                    close();
                  }}
                  style={{
                    height: 34,
                    padding: "0 9px",
                    border: "none",
                    borderRadius: 4,
                    background: selected ? T.ink : "transparent",
                    color: selected ? T.cream : T.ink,
                    cursor: "pointer",
                    textAlign: "left",
                    font: `500 12.5px/1 ${o.previewCss}`,
                    letterSpacing: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {o.name}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ────── Section (uppercase mono label + stacked children)
export function Section({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          font: `500 11px/1 ${T.mono}`,
          color: T.dim,
          letterSpacing: ".08em",
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

// ────── Modal shell
export function Modal({
  children,
  onClose,
  title,
  subtitle,
  footer,
  width = 520,
  closeDisabled = false,
  hideClose = false,
}: {
  children: ReactNode;
  onClose: () => void;
  title: string;
  subtitle?: string;
  footer?: ReactNode;
  width?: number;
  closeDisabled?: boolean;
  hideClose?: boolean;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const backdropRef = useRef<HTMLDivElement | null>(null);
  useEscapeClose(!closeDisabled, onClose);
  useFocusTrap(panelRef, true);
  // The focus trap only intercepts Tab. Everything outside the backdrop is
  // marked inert so the browse cursor, touch swipe and find-in-page cannot
  // wander behind the dialog either.
  useInertBackground(backdropRef, true);
  useEffect(() => {
    const restoreFocus = restoreFocusRef.current;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      panel.focus({ preventScroll: true });
    }
    return () => {
      if (restoreFocus?.isConnected) {
        restoreFocus.focus({ preventScroll: true });
      }
    };
  }, []);
  // A click is dispatched on the nearest common ancestor of pointerdown and
  // pointerup. Drag-select some text inside the panel and release a few pixels
  // outside it and that ancestor is this backdrop — the panel is not on the
  // path, so its stopPropagation never runs and the dialog closed, discarding
  // whatever had been typed. Only treat a click as "clicked the backdrop" when
  // the gesture also STARTED on the backdrop.
  const backdropPressRef = useRef(false);
  return (
    <div
      ref={backdropRef}
      onPointerDown={(e) => {
        backdropPressRef.current = e.target === e.currentTarget;
      }}
      onClick={
        closeDisabled
          ? undefined
          : (e) => {
              if (e.target !== e.currentTarget) return;
              if (!backdropPressRef.current) return;
              onClose();
            }
      }
      data-shiori-modal-open=""
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(26,24,21,0.42)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        // Without this, scrolling past the end of a tall dialog hands the
        // remaining delta to the document behind it, so the page creeps away
        // underneath while the dialog looks stationary.
        overscrollBehavior: "contain",
      }}
    >
      {CAPABILITIES.nativeWindowChrome ? (
        // The backdrop covers the top bar, the window's only drag handle,
        // and the page behind is inert, so the window could not be moved
        // while any dialog was open. This strip over the bar takes its
        // place; the panel is painted above it and stays clickable.
        <div
          data-tauri-drag-region
          aria-hidden="true"
          style={{ position: "absolute", top: 0, left: 0, right: 0, height: 48 }}
        />
      ) : null}
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          // Pin the modal box itself at `position: relative` so the
          // absolute close button below anchors to *this* element rather
          // than the fixed backdrop (which would let it drift off-screen
          // when the viewport is shorter than the modal contents).
          position: "relative",
          width,
          // `maxWidth: 100%` only protects against the parent flex
          // container; flex items default to `min-width: auto` (≈
          // min-content) which lets a single long unbreakable token
          // inside the modal force the box wider than the viewport.
          // Belt-and-braces: clamp by both the parent and the viewport.
          maxWidth: "min(100%, calc(100vw - 40px))",
          minWidth: 0,
          maxHeight: "90%",
          background: T.cream,
          borderRadius: 4,
          border: `1px solid ${T.rule}`,
          boxShadow:
            "0 30px 80px rgba(20,16,10,0.28), 0 2px 4px rgba(20,16,10,0.06)",
          display: "flex",
          flexDirection: "column",
          fontFamily: T.sans,
          overflow: "hidden",
        }}
      >
        {/* Anchored close button. Right padding inside the header used
            to be the only thing keeping it off the corner; long titles
            could shrink the right gap below the visual minimum and on
            narrow viewports the button looked like it was clipping the
            modal edge. Pinning it absolutely guarantees a fixed inset
            regardless of header content. */}
        {hideClose ? null : (
          <button
            type="button"
            onClick={closeDisabled ? undefined : onClose}
            title={t("common.close")}
            disabled={closeDisabled}
            style={{
              position: "absolute",
              top: 14,
              right: 14,
              width: 32,
              height: 32,
              border: "none",
              background: "transparent",
              color: T.ink2,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: closeDisabled ? "not-allowed" : "pointer",
              opacity: closeDisabled ? 0.45 : 1,
              borderRadius: 6,
              padding: 0,
              zIndex: 1,
            }}
            onMouseEnter={(e) => {
              if (!closeDisabled) e.currentTarget.style.background = T.tint;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <Ic.x />
          </button>
        )}
        <div
          style={{
            // Reserve room on the right for the absolute close button
            // (14 inset + 26 button = 40, plus a small gap so long
            // titles don't run under the X glyph).
            padding: "20px 56px 14px 22px",
            borderBottom: `1px solid ${T.rule}`,
            flex: "0 0 auto",
          }}
        >
          <div
            id={titleId}
            style={{
              font: `${T.displayStyle} 22px/1.15 ${T.serif}`,
              color: T.ink,
              letterSpacing: "-.01em",
            }}
          >
            {title}
          </div>
          {subtitle ? (
            <div
              style={{
                font: `500 11.5px/1 ${T.mono}`,
                color: T.dim,
                letterSpacing: ".04em",
                textTransform: "uppercase",
                marginTop: 6,
              }}
            >
              {subtitle}
            </div>
          ) : null}
        </div>
        <div
          style={{
            padding: footer ? "16px 22px 18px" : "16px 22px 22px",
            overflowX: "hidden",
            overflowY: "auto",
            flex: "1 1 auto",
            minWidth: 0,
            minHeight: 0,
          }}
        >
          {children}
        </div>
        {footer ? (
          <div
            style={{
              // Footer is `flex: 0 0 auto` so the action row never gets
              // pushed below the visible modal area when the body has to
              // scroll. Combined with removing the body's own max-height
              // / inner scroll wrapper this kills the "tiny scrollband
              // hiding the close button" trap that otherwise emerges
              // when the modal box hits its 90 vh ceiling.
              padding: "12px 22px 18px",
              borderTop: `1px solid ${T.rule}`,
              background: T.cream,
              flex: "0 0 auto",
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const Dot = () => (
  <span
    style={{
      width: 3,
      height: 3,
      borderRadius: 2,
      background: T.soft,
    }}
  />
);
