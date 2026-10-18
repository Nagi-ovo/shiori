import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";

export type SelectionMarkupType =
  | "highlight"
  | "underline"
  | "strikethrough"
  | "callout";

type Anchor = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

// Floating markup popover: appears above a live text selection and
// applies highlight / underline / strikethrough to it, the modern touch-first
// (and desktop) gesture — select text first, then choose the markup, instead
// of picking a tool and dragging. Positioned `fixed` in viewport space so it
// escapes the page wrapper's `overflow: hidden` clip.
//
// Touch targets are a comfortable 40px tall. We deliberately handle the apply
// on `pointerdown` (not click): on touch, tapping anywhere outside the active
// selection collapses it, and a `click` fires late enough that the selection
// may already be gone by the time it lands — `pointerdown` + preventDefault
// keeps the selection intact through the apply call.
// `crossPage` flags a selection spanning multiple pages. Cross-page markup
// isn't implemented (overlays are stored per page, and applying would only
// mark one page then destroy the selection), so the actions render disabled
// with an explanatory hint instead of silently half-applying.
export function SelectionMarkupPopup({
  anchor,
  crossPage = false,
  onApply,
}: {
  anchor: Anchor;
  crossPage?: boolean;
  onApply: (type: SelectionMarkupType) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  // Measure after layout so we can center the popover over the selection and
  // flip it below when there's no room above (top of viewport / first line).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setSize({ width: el.offsetWidth, height: el.offsetHeight });
  }, [anchor.left, anchor.right, anchor.top, anchor.bottom, crossPage]);

  const MARGIN = 8;
  const GAP = 8;
  const centerX = (anchor.left + anchor.right) / 2;
  const measured = size.width > 0 && size.height > 0;
  // The anchor is the union of every selected client rect, uncropped. Select a
  // paragraph taller than the screen and its top is far above the viewport and
  // its bottom far below, so placing relative to the raw anchor put the whole
  // toolbar off-screen: mounted and `visibility: visible`, but nowhere the user
  // could see it — indistinguishable from "select-then-annotate is broken".
  // Clamping the anchor to the viewport first keeps it beside the part of the
  // selection that is actually on screen.
  const visibleTop = Math.max(anchor.top, MARGIN);
  const visibleBottom = Math.min(anchor.bottom, window.innerHeight - MARGIN);
  const aboveTop = visibleTop - size.height - GAP;
  const belowTop = visibleBottom + GAP;
  const placeBelow = measured ? aboveTop < MARGIN : false;
  const rawLeft = centerX - size.width / 2;
  const left = measured
    ? Math.min(
        Math.max(rawLeft, MARGIN),
        window.innerWidth - size.width - MARGIN,
      )
    : rawLeft;
  const rawTop = placeBelow ? belowTop : aboveTop;
  // Vertical clamp was missing entirely while `left` had one, so flipping
  // below could still land past the bottom edge on a short viewport.
  const top = measured
    ? Math.min(
        Math.max(rawTop, MARGIN),
        Math.max(MARGIN, window.innerHeight - size.height - MARGIN),
      )
    : rawTop;

  // Roving tabindex for the toolbar. Kept as an index rather than a ref so the
  // arrow keys and the rendered tabIndex can never disagree.
  const [focusIndex, setFocusIndex] = useState(0);
  const onToolbarKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
    );
    if (buttons.length === 0) return;
    const current = buttons.findIndex((b) => b === document.activeElement);
    if (current === -1) return;
    let next = current;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (current + 1) % buttons.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (current - 1 + buttons.length) % buttons.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = buttons.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setFocusIndex(next);
    buttons[next]?.focus();
  };

  const items: Array<{
    type: SelectionMarkupType;
    icon: () => React.ReactElement;
    label: string;
  }> = [
    { type: "highlight", icon: Ic.highlight, label: t("selectionPopup.highlight") },
    { type: "underline", icon: Ic.underline, label: t("selectionPopup.underline") },
    {
      type: "strikethrough",
      icon: Ic.strikethrough,
      label: t("selectionPopup.strikethrough"),
    },
    { type: "callout", icon: Ic.callout, label: t("selectionPopup.callout") },
  ];

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={t("selectionPopup.label")}
      // Keep the popover from stealing the selection focus / collapsing the
      // range when the user reaches for a button.
      onPointerDown={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 45,
        display: "inline-flex",
        flexDirection: crossPage ? "column" : "row",
        alignItems: "center",
        gap: 2,
        padding: 3,
        background: T.cream,
        border: `1px solid ${T.rule}`,
        borderRadius: 8,
        boxShadow:
          "0 10px 28px rgba(20,16,10,0.20), 0 2px 4px rgba(20,16,10,0.08)",
        // Until measured, render off-screen-ish but mounted so we can size it.
        visibility: measured ? "visible" : "hidden",
      }}
    >
      <div
        style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
        onKeyDown={onToolbarKeyDown}
      >
        {items.map((item, i) => (
          <PopupButton
            key={item.type}
            label={item.label}
            disabled={crossPage}
            // APG toolbar: one tab stop for the group, arrows move within it.
            // Without this the declared role="toolbar" promised a navigation
            // model the popup did not implement.
            tabIndex={i === focusIndex ? 0 : -1}
            onActivate={() => onApply(item.type)}
          >
            <item.icon />
          </PopupButton>
        ))}
      </div>
      {crossPage ? (
        <div
          style={{
            maxWidth: 240,
            padding: "2px 8px 5px",
            fontSize: 11,
            lineHeight: 1.35,
            textAlign: "center",
            color: T.dim,
          }}
        >
          {t("selectionPopup.crossPageHint")}
        </div>
      ) : null}
    </div>
  );
}

function PopupButton({
  label,
  onActivate,
  disabled = false,
  tabIndex,
  children,
}: {
  label: string;
  onActivate: () => void;
  disabled?: boolean;
  tabIndex?: number;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      tabIndex={tabIndex}
      // Apply on pointerdown to survive touch selection-collapse (see note
      // on the container). preventDefault stops the synthetic mouse/click
      // chain and the focus shift that would clear the selection.
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) onActivate();
      }}
      // pointerdown alone made the button dead to the keyboard: Enter and
      // Space dispatch a click, and nothing was listening. A pointer
      // activation reports detail >= 1 and was already handled above, so only
      // the keyboard's synthetic click (detail 0) applies here — the same
      // discriminator OverlayDom uses for its disclosure buttons.
      onClick={(e) => {
        if (e.detail !== 0) return;
        e.stopPropagation();
        if (!disabled) onActivate();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 40,
        height: 40,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        borderRadius: 6,
        background: !disabled && hover ? T.tint : "transparent",
        color: disabled ? T.dim : T.ink2,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}
