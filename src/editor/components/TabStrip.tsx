import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DocumentKind } from "../../documents/types";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { MiniIconBtn } from "./ui";
import { useIsMobile } from "../hooks/useIsMobile";
import { HEADER_BAND_HEIGHT } from "./navigatorLayout";
import {
  ACTIVE_TAB_MIN_WIDTH,
  TAB_GAP,
  TAB_MAX_WIDTH,
  TAB_MIN_WIDTH,
  estimateTabWidth,
  planTabStrip,
  splitTitleExtension,
} from "./tabStripLayout";
import { useEscapeClose } from "./useEscapeClose";
import { DocumentPreviewSurface } from "./DocumentPreviewSurface";
import {
  hasDocumentPreviewVisual,
  type DocumentPreviewData,
} from "./documentPreview";

/**
 * Tab height inside the 40px header band. Sized so the active tab's shape
 * reaches most of the way up the band — at 32px it sat as a small box with
 * 8px of dead air above it, reading as something floating in the strip
 * rather than as the top of the pane below.
 */
const TAB_HEIGHT = 34;
/** Radius of the active tab's concave bottom corners, as its top ones. */
const TAB_FOOT = 7;

export type TabStripItem = {
  id: string;
  kind: DocumentKind;
  title: string;
  dirty?: boolean;
  unavailable?: boolean;
  updatedAt?: number;
};

export type TabStripPreview = DocumentPreviewData;

type Props = {
  tabs: TabStripItem[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void | Promise<void>;
  onPreviewRequest?: (id: string) => Promise<TabStripPreview | null>;
  onReorder: (activeId: string, overId: string) => void;
  onNew: () => void;
};

// A tab is its title. The format is the title's own extension, set as a dim
// suffix that never shrinks — and simply dropped (with the divider's blessing)
// when the tab is too narrow even for that, because a strip of ".pdf"s says
// nothing. The old strip did the opposite: a bold mono kind badge that never
// shrank while the title collapsed to one letter.
// No hairlines between tabs. They were a third vertical rhythm in a 40px
// band that already has two — the active tab's own outline and the column
// dividers — and next to the selected tab they read as a stray mark rather
// than a separator: the selection is already saying where one tab ends.
// Titles plus the gap separate them; the active tab's shape does the rest.
const STRIP_CSS = `
.shioriTab { container-type: inline-size; }
/* The active tab's feet: a concave fillet at each bottom corner, so its
   sides curve out into the strip's rule instead of meeting it square. Each
   is an arc of the rule colour with paper outside it, one column wider
   than the radius to cover the tab's own side border below the arc. */
.shioriTabActive::before,
.shioriTabActive::after {
  content: "";
  position: absolute;
  bottom: -1px;
  width: ${TAB_FOOT + 1}px;
  height: ${TAB_FOOT}px;
  pointer-events: none;
}
.shioriTabActive::before {
  left: -${TAB_FOOT + 1}px;
  background: radial-gradient(circle at 0 0, transparent ${TAB_FOOT - 1}px, ${T.rule} ${TAB_FOOT - 1}px, ${T.rule} ${TAB_FOOT}px, ${T.paper} ${TAB_FOOT + 0.5}px);
}
.shioriTabActive::after {
  right: -${TAB_FOOT + 1}px;
  background: radial-gradient(circle at 100% 0, transparent ${TAB_FOOT - 1}px, ${T.rule} ${TAB_FOOT - 1}px, ${T.rule} ${TAB_FOOT}px, ${T.paper} ${TAB_FOOT + 0.5}px);
}
@container (max-width: 119px) {
  .shioriTabExt { display: none; }
}
.shioriTabOverflowTrigger,
.shioriTabOverflowMenu button {
  -webkit-tap-highlight-color: transparent;
}
.shioriTabOverflowTrigger:hover,
.shioriTabOverflowTrigger:focus-visible,
.shioriTabOverflowMenuItem:hover,
.shioriTabOverflowMenuItem:focus-visible,
.shioriTabOverflowClose:hover,
.shioriTabOverflowClose:focus-visible,
.shioriTabOverflowBatch:hover,
.shioriTabOverflowBatch:focus-visible {
  background: ${T.hoverTint} !important;
  color: ${T.ink} !important;
}
.shioriTabOverflowTrigger:focus-visible,
.shioriTabOverflowMenuItem:focus-visible,
.shioriTabOverflowClose:focus-visible,
.shioriTabOverflowBatch:focus-visible {
  outline: 2px solid ${T.accent};
  outline-offset: -2px;
}
.shioriTabOverflowClose:active,
.shioriTabOverflowBatch:active {
  transform: scale(0.96);
}
`;

function TabStripComponent({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onPreviewRequest,
  onReorder,
  onNew,
}: Props) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const sensors = useSensors(
    // PointerSensor treats a touch swipe as a drag after only a few pixels,
    // which makes a horizontal tab strip impossible to pan. Keep the precise
    // desktop threshold, but give touch its native-scroll gesture unless the
    // reader deliberately holds before reordering.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 220, tolerance: 8 },
    }),
    // dnd-kit injects aria-roledescription="draggable" and an
    // aria-describedby pointing at "To pick up a draggable item, press the
    // space bar…" the moment {...attributes} is spread. With only a pointer
    // sensor registered, screen readers read that instruction out and the
    // space bar did nothing — the markup promised a keyboard contract the
    // code never implemented. Registering the sensor makes it true.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const stripRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null);
  const overflowMenuRef = useRef<HTMLDivElement | null>(null);
  const newButtonRef = useRef<HTMLButtonElement | null>(null);
  const overflowCloseQueueRef = useRef<Promise<void>>(Promise.resolve());
  const focusAfterCloseRef = useRef<{ id: string; index: number } | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const previewRequestRef = useRef(0);
  const previewIntentRef = useRef<string | null>(null);
  const [stripWidth, setStripWidth] = useState(0);
  const [pendingOverflowCloseIds, setPendingOverflowCloseIds] = useState(
    () => new Set<string>(),
  );
  const [overflowMenuAt, setOverflowMenuAt] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [previewTargetId, setPreviewTargetId] = useState<string | null>(null);
  const [overflowPreview, setOverflowPreview] = useState<
    TabStripPreview | null | undefined
  >(undefined);
  const overflowOpen = overflowMenuAt !== null;
  const hasTabs = tabs.length > 0;

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setStripWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasTabs]);

  // Space the tabs may use: the strip minus its padding and the "+" button.
  const PLUS_WIDTH = 30;
  const available = Math.max(0, stripWidth - PLUS_WIDTH - TAB_GAP);
  const { visible, overflow } = isMobile
    ? { visible: tabs, overflow: [] }
    : stripWidth > 0
      ? planTabStrip(tabs, activeTabId, available)
      : { visible: tabs, overflow: [] };

  useEffect(() => {
    if (!isMobile || !activeTabId) return;
    const activeTab = tabRefs.current.get(activeTabId);
    if (typeof activeTab?.scrollIntoView !== "function") return;
    activeTab.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, isMobile, visible.length]);

  useEffect(() => {
    if (!overflowOpen) return;
    const dismiss = () => {
      if (previewTimerRef.current !== null) {
        window.clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }
      previewRequestRef.current += 1;
      previewIntentRef.current = null;
      setPreviewTargetId(null);
      setOverflowPreview(undefined);
      setOverflowMenuAt(null);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [overflowOpen]);

  // Escape goes through the shared overlay stack, not a local keydown
  // listener. The local one only called preventDefault, which Canvas's own
  // Escape handler does not check, so dismissing this menu also disarmed the
  // active drawing tool. useEscapeClose listens in capture phase and stops
  // the event dead.
  useEscapeClose(overflowOpen, () => {
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    previewRequestRef.current += 1;
    previewIntentRef.current = null;
    setPreviewTargetId(null);
    setOverflowPreview(undefined);
    setOverflowMenuAt(null);
    overflowButtonRef.current?.focus({ preventScroll: true });
  });

  useEffect(() => {
    if (!overflowOpen) return;
    overflowMenuRef.current
      ?.querySelector<HTMLButtonElement>("[data-overflow-tab-select]")
      ?.focus({ preventScroll: true });
  }, [overflowOpen]);

  useEffect(
    () => () => {
      if (previewTimerRef.current !== null) {
        window.clearTimeout(previewTimerRef.current);
      }
      previewRequestRef.current += 1;
    },
    [],
  );

  const overflowIds = overflow.map((tab) => tab.id).join("\u0000");
  useLayoutEffect(() => {
    const pendingFocus = focusAfterCloseRef.current;
    if (
      !pendingFocus ||
      overflowIds.split("\u0000").includes(pendingFocus.id)
    ) {
      return;
    }
    focusAfterCloseRef.current = null;
    const closeButtons = Array.from(
      overflowMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        "[data-overflow-tab-close]",
      ) ?? [],
    );
    const nextClose =
      closeButtons[Math.min(pendingFocus.index, closeButtons.length - 1)];
    if (nextClose) {
      nextClose.focus({ preventScroll: true });
      return;
    }
    tabRefs.current.get(activeTabId ?? "")?.focus({ preventScroll: true });
    if (document.activeElement === document.body) {
      newButtonRef.current?.focus({ preventScroll: true });
    }
  }, [activeTabId, overflowIds]);

  useEffect(() => {
    if (!overflowOpen || overflow.length > 0) return;
    // Leave the empty-boundary render before clearing the anchor. Updating
    // state directly inside the effect creates a second synchronous render;
    // the microtask still prevents a stale menu from reopening if tabs later
    // overflow again.
    window.queueMicrotask(() => setOverflowMenuAt(null));
  }, [overflow.length, overflowOpen]);

  if (tabs.length === 0) return null;

  const onDragEnd = (event: DragEndEvent) => {
    const overId = event.over?.id;
    if (!overId || event.active.id === overId) return;
    onReorder(String(event.active.id), String(overId));
  };
  const focusableTabId = activeTabId ?? visible[0]?.id ?? null;
  const selectByOffset = (fromId: string, offset: number) => {
    const index = visible.findIndex((tab) => tab.id === fromId);
    if (index < 0) return;
    const next = visible[(index + offset + visible.length) % visible.length];
    if (!next) return;
    onSelect(next.id);
    window.requestAnimationFrame(() => {
      tabRefs.current.get(next.id)?.focus({ preventScroll: true });
    });
  };
  const onOverflowMenuKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    const buttons = Array.from(
      overflowMenuRef.current?.querySelectorAll<HTMLButtonElement>("button") ??
        [],
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1) % buttons.length;
    else if (event.key === "ArrowUp") {
      next = (current - 1 + buttons.length) % buttons.length;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next]?.focus();
  };
  const queueOverflowClose = (id: string, index: number) => {
    if (pendingOverflowCloseIds.has(id)) return;
    focusAfterCloseRef.current = { id, index };
    setPendingOverflowCloseIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    const close = async () => {
      try {
        await onClose(id);
      } catch (error) {
        console.error("Failed to close hidden tab", error);
      } finally {
        setPendingOverflowCloseIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    };
    // Text tabs may need to flush their file-backed edits first. Keep all
    // closes in one queue so rapid clicks cannot race against stale workspace
    // snapshots, while still letting the reader queue several rows at once.
    overflowCloseQueueRef.current = overflowCloseQueueRef.current.then(
      close,
      close,
    );
  };
  const closeOverflowTabs = (ids: string[]) => {
    ids.forEach((id) => {
      const index = overflow.findIndex((tab) => tab.id === id);
      if (index >= 0) queueOverflowClose(id, index);
    });
  };
  const hideOverflowPreview = (id?: string) => {
    if (id && previewIntentRef.current !== id) return;
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    previewRequestRef.current += 1;
    previewIntentRef.current = null;
    setPreviewTargetId(null);
    setOverflowPreview(undefined);
  };
  const showOverflowPreview = (id: string, immediate: boolean) => {
    if (isMobile || previewIntentRef.current === id) return;
    hideOverflowPreview();
    previewIntentRef.current = id;
    const request = () => {
      previewTimerRef.current = null;
      if (previewIntentRef.current !== id) return;
      const requestId = ++previewRequestRef.current;
      setPreviewTargetId(id);
      setOverflowPreview(undefined);
      if (!onPreviewRequest) {
        setOverflowPreview(null);
        return;
      }
      void onPreviewRequest(id)
        .then((preview) => {
          if (
            previewRequestRef.current === requestId &&
            previewIntentRef.current === id
          ) {
            setOverflowPreview(preview);
          }
        })
        .catch(() => {
          // Preview is derived and optional. The metadata card remains useful
          // if IndexedDB is unavailable or a cache row was evicted.
          if (previewRequestRef.current === requestId) {
            setOverflowPreview(null);
          }
        });
    };
    if (immediate) request();
    else previewTimerRef.current = window.setTimeout(request, 300);
  };

  return (
    <div
      className="shioriPrintHide"
      data-mobile-tab-strip={isMobile ? "" : undefined}
      style={{
        height: HEADER_BAND_HEIGHT,
        flex: "0 0 auto",
        display: "flex",
        // Tabs sit ON the band's bottom edge, so they align to the bottom and
        // the strip has no bottom padding to lift them off it.
        alignItems: "flex-end",
        padding: isMobile
          ? "5px calc(8px + var(--shiori-safe-right, 0px)) 0 0"
          : `5px 12px 0 ${12 - TAB_FOOT}px`,
        // The rule under the strip is painted inside the band, beneath the
        // tabs, so the active tab (opaque paper) covers its stretch of it and
        // joins the toolbar below. As a border it sat outside the tabs'
        // overflow clip, where no tab could reach, and ran under the active
        // tab too, cutting it off from its pane.
        boxShadow: `inset 0 -1px 0 ${T.rule}`,
        background: T.cream,
        overflowY: "hidden",
        userSelect: "none",
        WebkitUserSelect: "none",
        position: "relative",
      }}
    >
      <style>{STRIP_CSS}</style>
      <div
        ref={stripRef}
        className="shioriTabStrip"
        data-mobile-tab-scrollport={isMobile ? "" : undefined}
        role="tablist"
        aria-label={t("tabs.label")}
        style={{
          minWidth: 0,
          flex: "1 1 auto",
          height: "100%",
          display: "flex",
          alignItems: "flex-end",
          gap: TAB_GAP,
          // Room for the edge tabs' feet inside the clip (see STRIP_CSS);
          // the band's own padding gives up as much on the left.
          paddingLeft: isMobile
            ? "calc(8px + var(--shiori-safe-left, 0px))"
            : TAB_FOOT,
          paddingRight: TAB_FOOT,
          overflowX: isMobile ? "auto" : "hidden",
          overflowY: "hidden",
          overscrollBehaviorX: isMobile ? "contain" : undefined,
          touchAction: isMobile ? "pan-x" : undefined,
          WebkitOverflowScrolling: isMobile ? "touch" : undefined,
        }}
      >
        {overflow.length > 0 ? (
          <button
            ref={overflowButtonRef}
            type="button"
            className="shioriTabOverflowTrigger"
            onClick={(event) => {
              event.stopPropagation();
              if (overflowOpen) {
                hideOverflowPreview();
                setOverflowMenuAt(null);
                return;
              }
              hideOverflowPreview();
              const rect = event.currentTarget.getBoundingClientRect();
              setOverflowMenuAt({
                x: Math.max(8, Math.min(rect.left, window.innerWidth - 328)),
                y: rect.bottom + 4,
              });
            }}
            onPointerDown={(event) => event.stopPropagation()}
            title={t("tabs.overflowTitle", { count: overflow.length })}
            aria-label={t("tabs.overflowTitle", { count: overflow.length })}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            style={{
              height: TAB_HEIGHT,
              flex: "0 0 auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              padding: "0 9px",
              marginBottom: -1,
              border: "none",
              borderRadius: "7px 7px 0 0",
              background: overflowOpen ? T.hoverTint : "transparent",
              color: T.dim,
              font: `600 11px/1 ${T.mono}`,
              cursor: "pointer",
            }}
          >
            ⋯ +{overflow.length}
          </button>
        ) : null}
      {overflowMenuAt && overflow.length > 0 ? (
        <div
          ref={overflowMenuRef}
          role="menu"
          className="shioriTabOverflowMenu"
          aria-label={t("tabs.overflowMenuLabel")}
          onKeyDown={onOverflowMenuKeyDown}
          style={{
            // Fixed, not absolute: the strip clips its own box (overflowX
            // hidden), so a child menu could never hang below it.
            position: "fixed",
            left: overflowMenuAt.x,
            top: overflowMenuAt.y,
            zIndex: 60,
            width: 320,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "min(420px, calc(100vh - 56px))",
            display: "flex",
            flexDirection: "column",
            padding: 6,
            background: T.surface,
            border: `1px solid ${T.rule}`,
            borderRadius: 10,
            boxShadow: "0 18px 50px rgba(0,0,0,0.22)",
            color: T.ink,
          }}
        >
          <div
            role="presentation"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              minHeight: 30,
              padding: "0 8px 4px",
              color: T.dim,
              font: `600 10.5px/1 ${T.mono}`,
              letterSpacing: ".04em",
            }}
          >
            <span>{t("tabs.overflowMenuLabel")}</span>
            <span aria-hidden="true">{overflow.length}</span>
          </div>
          <span
            role="status"
            aria-live="polite"
            style={{
              position: "absolute",
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: "hidden",
              clip: "rect(0, 0, 0, 0)",
              whiteSpace: "nowrap",
              border: 0,
            }}
          >
            {t("tabs.overflowTitle", { count: overflow.length })}
          </span>
          <div
            role="presentation"
            style={{
              minHeight: 0,
              overflowY: "auto",
              overscrollBehavior: "contain",
            }}
          >
            {overflow.map((tab, index) => {
              const { base, ext } = splitTitleExtension(tab.title);
              const closing = pendingOverflowCloseIds.has(tab.id);
              return (
                <div
                  key={tab.id}
                  role="presentation"
                  onMouseEnter={() => showOverflowPreview(tab.id, false)}
                  onMouseLeave={() => hideOverflowPreview(tab.id)}
                  onFocusCapture={() => showOverflowPreview(tab.id, true)}
                  onBlurCapture={(event) => {
                    if (
                      !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                      )
                    ) {
                      hideOverflowPreview(tab.id);
                    }
                  }}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) 30px",
                    alignItems: "stretch",
                    gap: 2,
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="shioriTabOverflowMenuItem"
                    data-overflow-tab-select
                    aria-describedby={
                      previewTargetId === tab.id
                        ? "shiori-tab-overflow-preview"
                        : undefined
                    }
                    title={tab.title}
                    onClick={() => {
                      hideOverflowPreview();
                      setOverflowMenuAt(null);
                      onSelect(tab.id);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    style={{
                      appearance: "none",
                      display: "flex",
                      alignItems: "baseline",
                      minWidth: 0,
                      minHeight: 32,
                      border: "none",
                      background: "transparent",
                      padding: "6px 8px",
                      borderRadius: 6,
                      cursor: "pointer",
                      textAlign: "left",
                      font: `500 12.5px/1.4 ${T.sans}`,
                      color: tab.unavailable ? T.dim : T.ink,
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
                      {base}
                    </span>
                    {ext ? (
                      <span
                        style={{ flex: "none", color: T.dim, fontWeight: 400 }}
                      >
                        {ext}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="shioriTabOverflowClose"
                    data-overflow-tab-close
                    aria-describedby={
                      previewTargetId === tab.id
                        ? "shiori-tab-overflow-preview"
                        : undefined
                    }
                    aria-busy={closing || undefined}
                    aria-disabled={closing || undefined}
                    aria-label={t("tabs.closeNamed", { title: tab.title })}
                    title={t("tabs.closeNamed", { title: tab.title })}
                    onClick={() => {
                      if (!closing) queueOverflowClose(tab.id, index);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    style={{
                      appearance: "none",
                      width: 30,
                      minHeight: 30,
                      alignSelf: "center",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      border: "none",
                      borderRadius: 6,
                      background: "transparent",
                      color: T.dim,
                      cursor: closing ? "progress" : "pointer",
                      opacity: closing ? 0.62 : 1,
                      transition:
                        "transform 90ms ease, color 120ms ease, background 120ms ease",
                    }}
                  >
                    {closing ? (
                      <Ic.ellipsis width={14} height={14} />
                    ) : (
                      <Ic.x width={14} height={14} />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
          <div
            role="separator"
            style={{
              height: 1,
              flex: "none",
              margin: "5px 4px",
              background: T.rule,
            }}
          />
          <button
            type="button"
            role="menuitem"
            className="shioriTabOverflowBatch"
            aria-busy={pendingOverflowCloseIds.size > 0 || undefined}
            aria-disabled={pendingOverflowCloseIds.size > 0 || undefined}
            onClick={() => {
              if (pendingOverflowCloseIds.size === 0) {
                closeOverflowTabs(overflow.map((tab) => tab.id));
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            style={{
              appearance: "none",
              width: "100%",
              minHeight: 34,
              display: "flex",
              alignItems: "center",
              gap: 8,
              border: "none",
              borderRadius: 6,
              background: "transparent",
              color: T.ink2,
              padding: "6px 8px",
              cursor:
                pendingOverflowCloseIds.size > 0 ? "progress" : "pointer",
              opacity: pendingOverflowCloseIds.size > 0 ? 0.62 : 1,
              textAlign: "left",
              font: `600 12px/1.3 ${T.sans}`,
              transition:
                "transform 90ms ease, color 120ms ease, background 120ms ease",
            }}
          >
            <Ic.x width={14} height={14} />
            <span>{t("tabs.closeOverflow", { count: overflow.length })}</span>
          </button>
        </div>
      ) : null}
      {overflowMenuAt && previewTargetId && !isMobile ? (
        <OverflowPreviewCard
          item={overflow.find((tab) => tab.id === previewTargetId) ?? null}
          preview={overflowPreview}
          menuX={overflowMenuAt.x}
          menuY={overflowMenuAt.y}
        />
      ) : null}
      <DndContext
        sensors={sensors}
        modifiers={[({ transform, draggingNodeRect, containerNodeRect }) => ({
          ...transform,
          y: 0,
          x: draggingNodeRect && containerNodeRect
            ? Math.min(
                containerNodeRect.right - draggingNodeRect.right,
                Math.max(containerNodeRect.left - draggingNodeRect.left, transform.x),
              )
            : transform.x,
        })]}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <SortableContext
          items={visible.map((tab) => tab.id)}
          strategy={horizontalListSortingStrategy}
        >
          {visible.map((tab) => (
            <SortableTab
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              focusable={tab.id === focusableTabId}
              isMobile={isMobile}
              onSelect={onSelect}
              onArrow={(offset) => selectByOffset(tab.id, offset)}
              onClose={onClose}
              registerRef={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              closeLabel={t("tabs.close")}
              dirtyLabel={t("exportStatus.needsExport")}
            />
          ))}
        </SortableContext>
      </DndContext>
      </div>
      <button
        ref={newButtonRef}
        type="button"
        onClick={onNew}
        title={t("tabs.new")}
        style={{
          width: 28,
          height: 28,
          flex: "0 0 auto",
          alignSelf: "center",
          marginLeft: TAB_GAP,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          borderRadius: 6,
          background: "transparent",
          color: T.dim,
          cursor: "pointer",
          padding: 0,
        }}
      >
        <Ic.plus />
      </button>
    </div>
  );
}

function OverflowPreviewCard({
  item,
  preview,
  menuX,
  menuY,
}: {
  item: TabStripItem | null;
  preview: TabStripPreview | null | undefined;
  menuX: number;
  menuY: number;
}) {
  const { t } = useTranslation();
  if (!item || window.innerWidth < 648) return null;
  const width = 300;
  const gap = 8;
  const menuWidth = 320;
  const right = menuX + menuWidth + gap;
  const leftCandidate = menuX - width - gap;
  const left =
    right + width <= window.innerWidth - 8
      ? right
      : leftCandidate >= 8
        ? leftCandidate
        : null;
  if (left === null) return null;
  const top = Math.max(8, Math.min(menuY, window.innerHeight - 314));
  const zoom = preview?.scale
    ? `${Math.round(preview.scale * 100)}%`
    : undefined;
  const detail = preview?.pageNumber
    ? t("tabs.previewPage", { page: preview.pageNumber, zoom: zoom ?? "—" })
    : zoom
      ? t("tabs.previewPosition", { zoom })
      : t("tabs.previewPositionUnknown");

  return (
    <div
      id="shiori-tab-overflow-preview"
      role="tooltip"
      aria-label={`${t("tabs.previewLabel", { title: item.title })} · ${detail}`}
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 60,
        width,
        maxHeight: "min(306px, calc(100vh - 16px))",
        padding: 6,
        border: `1px solid ${T.rule}`,
        borderRadius: 12,
        background: T.surface,
        boxShadow: "0 18px 50px rgba(0,0,0,0.22)",
        color: T.ink,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {hasDocumentPreviewVisual(preview) ? (
        <DocumentPreviewSurface
          preview={preview}
          height={220}
          htmlScale={0.36}
        />
      ) : (
        <div
          style={{
            height: 220,
            borderRadius: 6,
            overflow: "hidden",
            background: T.paper,
            boxShadow: "0 0 0 1px rgba(0,0,0,0.10)",
            position: "relative",
          }}
        >
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              color: T.dim,
              font: `500 11px/1.4 ${T.sans}`,
            }}
          >
            <Ic.viewPages width={28} height={28} />
            <span>
              {preview === undefined
                ? t("tabs.previewLoading")
                : t("tabs.previewUnavailable")}
            </span>
          </div>
        </div>
      )}
      <div style={{ padding: "9px 8px 5px", minWidth: 0 }}>
        <div
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            font: `600 12.5px/1.35 ${T.sans}`,
          }}
        >
          {item.title}
        </div>
        <div
          style={{
            marginTop: 3,
            color: T.dim,
            font: `500 10.5px/1.3 ${T.mono}`,
          }}
        >
          {detail}
        </div>
      </div>
    </div>
  );
}

export const TabStrip = memo(TabStripComponent);

function SortableTab({
  tab,
  active,
  focusable,
  isMobile,
  onSelect,
  onArrow,
  onClose,
  registerRef,
  closeLabel,
  dirtyLabel,
}: {
  tab: TabStripItem;
  active: boolean;
  focusable: boolean;
  isMobile: boolean;
  onSelect: (id: string) => void;
  onArrow: (offset: number) => void;
  onClose: (id: string) => void;
  registerRef: (node: HTMLDivElement | null) => void;
  closeLabel: string;
  dirtyLabel: string;
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: tab.id });
  // Obsidian shows the close control on the current tab and on hover only. At
  // the narrow end that difference is the whole title: a permanent × costs
  // ~22px on every tab, which is most of what a squeezed tab has left.
  const [hovered, setHovered] = useState(false);
  // Dirty and close share one slot (VS Code's move): the dot at rest, the ×
  // under the pointer. Two side-by-side controls cost a second slot that a
  // squeezed tab cannot spare.
  const showAux = active || hovered || tab.dirty === true;
  const showClose = hovered || (active && tab.dirty !== true);
  const { base, ext } = splitTitleExtension(tab.title);

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        registerRef(node);
      }}
      {...attributes}
      {...listeners}
      role="tab"
      tabIndex={focusable ? 0 : -1}
      aria-selected={active}
      aria-controls={`shiori-document-panel-${tab.id}`}
      aria-label={tab.title}
      data-tab-id={tab.id}
      title={tab.title}
      className={active ? "shioriTab shioriTabActive" : "shioriTab"}
      onClick={() => onSelect(tab.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // This handler is spread AFTER {...listeners}, so it replaces dnd-kit's
      // own onKeyDown outright. Everything the keyboard sensor needs has to be
      // handed back explicitly — otherwise registering the sensor changes
      // nothing and the "press space bar" instruction stays a lie.
      onKeyDown={(event) => {
        // Held by the keyboard sensor: arrows move the tab, Space drops it,
        // Escape cancels. Walking the tablist now would fight the drag.
        if (isDragging) {
          listeners?.onKeyDown?.(event);
          return;
        }
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onArrow(-1);
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          onArrow(1);
          return;
        }
        // Space is dnd-kit's pick-up key and the DOM already advertises it.
        // Enter keeps activating the tab, so the APG tab pattern still has a
        // working activation key.
        if (event.key === " ") {
          listeners?.onKeyDown?.(event);
          return;
        }
        if (event.key !== "Enter") return;
        event.preventDefault();
        onSelect(tab.id);
      }}
      style={{
        height: TAB_HEIGHT,
        // A tab is as wide as its title, no wider. Growing to a shared basis
        // padded "codex-fix.html" out to the same width as a truncated
        // 40-character title, which made the strip look like fixed slots the
        // titles happened to sit in. Shrinking still happens when the row is
        // full; below the fold threshold planTabStrip folds tabs into the
        // ⋯ +N chip rather than letting them become stubs.
        flex: isMobile ? "0 0 auto" : "0 1 auto",
        // The floor applies to titles long enough to need it. A short name is
        // already narrower than the floor, and forcing it up to 88px was the
        // padding that made the strip look like fixed slots.
        minWidth: Math.min(
          active ? ACTIVE_TAB_MIN_WIDTH : TAB_MIN_WIDTH,
          estimateTabWidth(tab.title),
        ),
        maxWidth: isMobile ? 176 : TAB_MAX_WIDTH,
        display: "grid",
        gridTemplateColumns: showAux ? "minmax(0, 1fr) auto" : "minmax(0, 1fr)",
        alignItems: "center",
        gap: 6,
        // No box around every tab. Inactive tabs are just their label; the
        // active one is a shape that rises out of the strip and bites into
        // the rule underneath, which is how a tab says "this pane is mine".
        // A tab picked up to reorder takes the active shape too, so the
        // whole tab moves rather than a floating label.
        border: active || isDragging ? `1px solid ${T.rule}` : "1px solid transparent",
        borderBottom: active || isDragging ? `1px solid ${T.paper}` : "1px solid transparent",
        borderRadius: "7px 7px 0 0",
        background: active || isDragging ? T.paper : "transparent",
        // The thumbnails' lift shadow, so both reorder gestures read alike.
        boxShadow: isDragging ? "0 4px 12px rgba(10,14,24,0.12)" : undefined,
        color: tab.unavailable ? T.dim : active ? T.ink : T.dim,
        padding: "0 6px 0 12px",
        // Stacks above the strip's rule (drawn inside the band's bottom
        // pixel) so the active tab erases the 1px of it beneath the tab.
        position: "relative",
        cursor: isDragging ? "grabbing" : "pointer",
        font: `${active ? 600 : 500} 12.5px/1 ${T.sans}`,
        // Translate only: tabs differ in width, and the sortable's scale
        // stretched the dragged title over a wider neighbour.
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 2 : active ? 1 : undefined,
      }}
    >
      <span
        style={{
          minWidth: 0,
          display: "flex",
          alignItems: "baseline",
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: "left",
            lineHeight: 1.28,
          }}
        >
          {base}
        </span>
        {ext ? (
          <span
            className="shioriTabExt"
            style={{
              flex: "none",
              fontWeight: 400,
              color: tab.unavailable ? T.dim : active ? T.ink2 : T.dim,
              opacity: 0.85,
              lineHeight: 1.28,
            }}
          >
            {ext}
          </span>
        ) : null}
      </span>
      {showAux ? (
        <span
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
          }}
        >
          {showClose ? (
            <MiniIconBtn
              title={closeLabel}
              size={20}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              <Ic.x width={12} height={12} />
            </MiniIconBtn>
          ) : (
            <span
              aria-hidden
              title={dirtyLabel}
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: T.accent,
              }}
            />
          )}
        </span>
      ) : null}
    </div>
  );
}
