import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useShallow } from "zustand/react/shallow";
import { useAppStore, useEditorStore } from "../store/store";
import { isBlankPage, type Overlay, type PageModel } from "../../pdf/model/types";
import type { PdfDocument as PDFDocumentProxy } from "../../pdf/engine/types";
import { releaseCanvasBackingStore } from "../../pdf/render/canvasMemory";
import { appPdfEngine } from "../../pdf/engine/appEngine";
import { rotatedSize } from "../../pdf/geometry/coords";
import { MAX_CANVAS_PIXELS } from "../../pdf/openPolicy";
import { renderPageBackdrop } from "../../pdf/render/tiles";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { MiniIconBtn } from "./ui";
import { THUMBNAIL_PRE_RENDER_PAGE_LIMIT } from "../../pdf/openPolicy";
import {
  THUMBNAIL_PAPER,
  THUMBNAIL_TARGET_WIDTH,
  drawThumbnailOverlays,
  drawThumbnailPaper,
  fitThumbnailCanvasToTile,
  loadThumbnailOverlayFonts,
  prepareThumbnailCanvas,
  thumbnailViewportForPage,
} from "./thumbnailCompositor";
import { useIsMobile } from "../hooks/useIsMobile";
import { toast } from "../toast";
import {
  compositePdfPaperColor,
  pdfPaperColor,
} from "../../design/pdfPaperTone";
import { useEscapeClose } from "./useEscapeClose";
import {
  placePageMenu,
  type PageMenuPlacement,
  type PageMenuSafeInsets,
  type PageMenuViewport,
} from "./pageMenuPlacement";

type Props = {
  doc: PDFDocumentProxy;
  /** Disables duplicate PDF insertion and announces long-running local work. */
  pdfInsertionBusy?: boolean;
  /** Insert another PDF's pages immediately after this stable editor page. */
  onInsertPdfPages: (afterPageId: string | null) => void;
  /**
   * Render as the body of the left navigator instead of as a panel of its
   * own: no width, no border, no background — the navigator supplies all
   * three — and a compact header, since the navigator's segmented control
   * already names this view. Desktop only; on mobile the thumbnails are
   * still their own drawer.
   */
  embedded?: boolean;
};

const THUMBNAIL_OVERLAY_DEBOUNCE_MS = 180;
const THUMBNAIL_ITEM_CHROME_HEIGHT = 39;
const PAGE_ADD_MENU_WIDTH = 224;
const PAGE_CONTEXT_MENU_WIDTH = 216;
type RenderedPageMenuPlacement = PageMenuPlacement & { ready: boolean };
const VISUALLY_HIDDEN_STYLE: React.CSSProperties = {
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

function pageMenuViewport(): PageMenuViewport {
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

/** Resolve env(safe-area-inset-*) through a real CSS property. Reading the
 * custom property directly can return the unevaluated `env(...)` token. */
function pageMenuSafeInsets(): PageMenuSafeInsets {
  const probe = document.createElement("div");
  probe.style.cssText = [
    "position:fixed",
    "visibility:hidden",
    "pointer-events:none",
    "padding-top:var(--shiori-safe-top, 0px)",
    "padding-right:var(--shiori-safe-right, 0px)",
    "padding-bottom:var(--shiori-safe-bottom, 0px)",
    "padding-left:var(--shiori-safe-left, 0px)",
  ].join(";");
  document.body.append(probe);
  const style = window.getComputedStyle(probe);
  const insets = {
    top: nonNegativeCssPixel(style.paddingTop),
    right: nonNegativeCssPixel(style.paddingRight),
    bottom: nonNegativeCssPixel(style.paddingBottom),
    left: nonNegativeCssPixel(style.paddingLeft),
  };
  probe.remove();
  return insets;
}

function nonNegativeCssPixel(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function Thumbnails({
  doc,
  pdfInsertionBusy = false,
  onInsertPdfPages,
  embedded = false,
}: Props) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const pages = useEditorStore((s) => s.model.pages);
  const activePageId = useEditorStore((s) => s.activePageId);
  const goToPage = useEditorStore((s) => s.goToPage);
  const setShowThumbs = useEditorStore((s) => s.setShowThumbs);
  const deletePage = useEditorStore((s) => s.deletePage);
  const undo = useEditorStore((s) => s.undo);
  const rotatePage = useEditorStore((s) => s.rotatePage);
  const duplicatePage = useEditorStore((s) => s.duplicatePage);
  const deletePageWithUndo = (id: string) => {
    const idx = pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    deletePage(id);
    toast.showAction(t("toast.deletedPage", { page: idx + 1 }), {
      label: t("toast.undo"),
      onClick: () => undo(),
    });
  };
  const insertBlankPage = useEditorStore((s) => s.insertBlankPage);
  const movePage = useEditorStore((s) => s.movePage);
  const preRenderThumbs = useAppStore((s) => s.prefs.preRenderThumbs);
  const pdfPaperTone = useAppStore((s) => s.prefs.pdfPaperTone);
  const pdfPaperCustomColor = useAppStore((s) => s.prefs.pdfPaperCustomColor);
  const paperColor = pdfPaperColor(pdfPaperTone, pdfPaperCustomColor);
  const preRender =
    !isMobile && preRenderThumbs && pages.length <= THUMBNAIL_PRE_RENDER_PAGE_LIMIT;
  const [menu, setMenu] = useState<{ pageId: string; x: number; y: number } | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const activePageIndex = useMemo(
    () => (activePageId ? pages.findIndex((page) => page.id === activePageId) : -1),
    [activePageId, pages],
  );
  const heightEstimates = useMemo(
    () => pages.map((page, index) => estimateThumbnailItemHeight(page, index === 0)),
    [pages],
  );
  const defaultItemHeight = heightEstimates[0] ?? 252;

  // Escape goes through the shared overlay stack rather than a local keydown
  // listener. The local one only called preventDefault, which Canvas's own
  // Escape handler does not check, so dismissing this menu also disarmed the
  // active tool: press `h`, right-click a page, press Escape, and the next
  // drag selected text instead of highlighting. useEscapeClose listens in
  // capture phase and stops the event dead.
  useEscapeClose(menu != null, () => setMenu(null));

  // Smoothly track the canvas's active page in the rail, the way
  // macOS Preview / Acrobat keep the bookmark sidebar coherent with
  // the document scroll. Three guard rails make the motion feel
  // gentle rather than yanking:
  //
  //   1. Comfort zone. We only scroll when the active thumbnail
  //      drifts outside the central 60 % of the rail's visible band.
  //      So long as the highlighted tile is comfortably mid-rail, we
  //      leave the user's manual scroll alone — Acrobat's "don't
  //      fight me" behavior.
  //   2. Center on move. When we do scroll, we aim to center the
  //      active thumbnail rather than dropping it on the edge — that
  //      gives surrounding context (page n−1, n+1) the same airtime
  //      as page n itself, and reads as "follow", not "snap".
  //   3. Smooth on subsequent updates, instant on first mount. The
  //      first sync after the rail opens jumps directly so the user
  //      sees the right region immediately; every further change
  //      animates so rapid canvas scrolls don't strobe.
  //
  // dnd-kit drags update activePageId mid-gesture; skipping while
  // dragging keeps the rail from auto-scrolling out from under the
  // user's finger.
  const firstSyncRef = useRef(true);
  const draggingRef = useRef(false);
  useEffect(() => {
    if (!activePageId) return;
    if (activePageIndex < 0) return;
    if (draggingRef.current) return;
    const rail = railRef.current;
    const behavior = firstSyncRef.current ? "auto" : "smooth";
    const scrollToActive = () => {
      virtuosoRef.current?.scrollToIndex({
        index: activePageIndex,
        align: "center",
        behavior,
      });
      firstSyncRef.current = false;
    };
    if (!rail) {
      scrollToActive();
      return;
    }
    const node = rail.querySelector<HTMLElement>(
      `[data-thumb-page-id="${activePageId}"]`,
    );
    if (!node) {
      scrollToActive();
      return;
    }

    const railRect = rail.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const margin = railRect.height * 0.2;
    const comfortTop = railRect.top + margin;
    const comfortBottom = railRect.bottom - margin;
    const insideComfort =
      nodeRect.top >= comfortTop && nodeRect.bottom <= comfortBottom;

    if (insideComfort && !firstSyncRef.current) return;

    scrollToActive();
  }, [activePageId, activePageIndex]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const ids = useMemo(() => pages.map((p) => p.id), [pages]);

  const jumpToPage = (pageId: string) => {
    const index = pages.findIndex((page) => page.id === pageId);
    if (index >= 0) goToPage(pageId, index);
    // On mobile the rail covers the canvas, so the page the user
    // just tapped would still be hidden behind the drawer. Close it
    // automatically — they can reopen via the TopBar toggle.
    if (isMobile) setShowThumbs(false);
    if (index >= 0) {
      virtuosoRef.current?.scrollToIndex({
        index,
        align: "center",
        behavior: "smooth",
      });
    }
  };

  const onRailKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const current = activePageId
      ? pages.findIndex((page) => page.id === activePageId)
      : -1;
    const nextIndex =
      e.key === "ArrowDown"
        ? current < 0
          ? 0
          : current + 1
        : current - 1;
    const next = pages[nextIndex];
    e.preventDefault();
    if (!next) return;
    jumpToPage(next.id);
  };

  const onDragStart = () => {
    draggingRef.current = true;
  };
  const onDragEnd = (e: DragEndEvent) => {
    draggingRef.current = false;
    if (!e.over || e.active.id === e.over.id) return;
    const from = pages.findIndex((p) => p.id === e.active.id);
    const to = pages.findIndex((p) => p.id === e.over!.id);
    if (from < 0 || to < 0) return;
    movePage(from, to);
  };
  const onDragCancel = () => {
    draggingRef.current = false;
  };

  // Mobile renders the rail as a slide-in drawer from the left, layered
  // above the canvas with a tap-out backdrop owned by App.tsx. Desktop
  // keeps the original in-flow sidebar so the editor still uses every
  // pixel of the window without an overlay panel covering the page.
  const asideStyle: React.CSSProperties = embedded
    ? {
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }
    : isMobile
    ? {
        position: "fixed",
        top: 0,
        bottom: 0,
        left: 0,
        width: "min(82vw, 320px)",
        zIndex: 45,
        borderRight: `1px solid ${T.rule}`,
        background: T.cream,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        boxShadow: "0 18px 40px rgba(20,16,10,0.18)",
        paddingTop: "var(--shiori-safe-top, 0px)",
        paddingBottom: "var(--shiori-safe-bottom, 0px)",
        paddingLeft: "var(--shiori-safe-left, 0px)",
      }
    : {
        width: "clamp(180px, 14vw, 260px)",
        flex: "0 0 clamp(180px, 14vw, 260px)",
        borderRight: `1px solid ${T.rule}`,
        background: T.cream,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      };

  return (
    // An unnamed <aside> shows up in a landmark list as a bare
    // "complementary" with no way to tell what it is, so there was no way to
    // jump to the page rail.
    <aside
      className="shioriPrintHide"
      aria-label={t("a11y.landmarks.thumbnails")}
      style={asideStyle}
    >
      <div
        style={{
          padding: embedded ? "5px 6px 5px 10px" : "12px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid ${embedded ? T.ruleSoft : T.rule}`,
          flex: "0 0 auto",
        }}
      >
        {/* Embedded, the segmented control above already says "pages", so the
            title would be the second label in eight vertical pixels. The
            page count survives — it is data, not a name. */}
        <div
          style={
            embedded
              ? {
                  font: `500 10px/1 ${T.mono}`,
                  color: T.dim,
                  letterSpacing: ".04em",
                }
              : { font: `600 14.5px/1 ${T.sans}`, color: T.ink }
          }
        >
          {embedded
            ? t("thumbs.total", { count: pages.length })
            : t("thumbs.header")}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <PageAddControl
            embedded={embedded}
            mobile={isMobile}
            busy={pdfInsertionBusy}
            onInsertBlank={() => insertBlankPage(activePageId)}
            onInsertPdf={() => onInsertPdfPages(activePageId)}
          />
          <span role="status" aria-live="polite" style={VISUALLY_HIDDEN_STYLE}>
            {pdfInsertionBusy ? t("thumbs.insertingPdf") : ""}
          </span>
          {embedded ? null : (
            <div
              style={{
                font: `500 11px/1 ${T.mono}`,
                color: T.dim,
                letterSpacing: ".04em",
              }}
            >
              {t("thumbs.total", { count: pages.length })}
            </div>
          )}
          {isMobile && !embedded ? (
            <MiniIconBtn
              title={t("rail.close")}
              onClick={() => setShowThumbs(false)}
            >
              <Ic.x />
            </MiniIconBtn>
          ) : null}
        </div>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <Virtuoso
            ref={virtuosoRef}
            scrollerRef={(ref) => {
              railRef.current = ref instanceof HTMLElement ? ref : null;
            }}
            data={pages}
            computeItemKey={(_index, page) => page.id}
            className="shioriThumbsRail"
            tabIndex={0}
            onKeyDown={onRailKeyDown}
            onPointerDownCapture={(e) => {
              if (
                e.target instanceof window.Element &&
                e.target.closest("button")
              ) {
                return;
              }
              e.currentTarget.focus({ preventScroll: true });
            }}
            style={{
              flex: 1,
              minHeight: 0,
            }}
            initialTopMostItemIndex={
              activePageIndex >= 0
                ? { index: activePageIndex, align: "center" }
                : 0
            }
            defaultItemHeight={defaultItemHeight}
            heightEstimates={heightEstimates}
            increaseViewportBy={{ top: 260, bottom: 520 }}
            overscan={{ main: 360, reverse: 180 }}
            itemContent={(i, p) => (
              <div style={{ padding: i === 0 ? "10px 10px 10px" : "0 10px 10px" }}>
                <Thumb
                  page={p}
                  index={i}
                  active={p.id === activePageId}
                  doc={doc}
                  preRender={preRender}
                  paperColor={paperColor}
                  onClick={() => jumpToPage(p.id)}
                  onDelete={() => deletePageWithUndo(p.id)}
                  onRotate={() => rotatePage(p.id, 90)}
                  onDuplicate={() => duplicatePage(p.id)}
                  onContextMenu={(x, y) => setMenu({ pageId: p.id, x, y })}
                />
              </div>
            )}
          />
        </SortableContext>
      </DndContext>
      {menu ? (
        <ThumbContextMenu
          x={menu.x}
          y={menu.y}
          onInsertBlank={() => insertBlankPage(menu.pageId)}
          onInsertPdf={() => onInsertPdfPages(menu.pageId)}
          pdfInsertionBusy={pdfInsertionBusy}
          onRotate={() => rotatePage(menu.pageId, 90)}
          onDuplicate={() => duplicatePage(menu.pageId)}
          onDelete={() => deletePageWithUndo(menu.pageId)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </aside>
  );
}

function PageAddControl({
  embedded,
  mobile,
  busy,
  onInsertBlank,
  onInsertPdf,
}: {
  embedded: boolean;
  mobile: boolean;
  busy: boolean;
  onInsertBlank: () => void;
  onInsertPdf: () => void;
}) {
  const { t } = useTranslation();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<0 | 1>(0);
  const restoreFocusOnCloseRef = useRef(true);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<0 | 1>(0);
  const [position, setPosition] = useState<RenderedPageMenuPlacement>({
    left: 8,
    top: 8,
    maxWidth: PAGE_ADD_MENU_WIDTH,
    maxHeight: 10_000,
    ready: false,
  });
  const targetSize = mobile ? 44 : embedded ? 26 : 32;

  const closeWithFocusRestore = () => {
    restoreFocusOnCloseRef.current = true;
    setOpen(false);
    queueMicrotask(() => {
      const trigger = triggerRef.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
  };
  const openAt = (index: 0 | 1) => {
    initialFocusRef.current = index;
    restoreFocusOnCloseRef.current = true;
    setActiveIndex(index);
    setPosition({
      left: 8,
      top: 8,
      maxWidth: PAGE_ADD_MENU_WIDTH,
      maxHeight: 10_000,
      ready: false,
    });
    setOpen(true);
  };

  useEscapeClose(open, closeWithFocusRestore);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    setPosition({
      ...placePageMenu(
        {
          kind: "trigger",
          left: triggerRect.left,
          top: triggerRect.top,
          right: triggerRect.right,
          bottom: triggerRect.bottom,
        },
        { width: menuRect.width, height: menuRect.height },
        pageMenuViewport(),
        pageMenuSafeInsets(),
      ),
      ready: true,
    });
  }, [open, position.maxWidth]);

  useLayoutEffect(() => {
    if (!open || !position.ready) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const initialIndex = initialFocusRef.current;
    const buttons = menu.querySelectorAll<HTMLButtonElement>("button");
    buttons[initialIndex]?.focus({
      preventScroll: true,
    });
    return () => {
      if (!menu.contains(document.activeElement)) return;
      const shouldRestore = restoreFocusOnCloseRef.current;
      restoreFocusOnCloseRef.current = true;
      if (!shouldRestore) return;
      queueMicrotask(() => {
        if (trigger.isConnected) trigger.focus({ preventScroll: true });
      });
    };
  }, [open, position.ready]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      restoreFocusOnCloseRef.current = false;
      setOpen(false);
    };
    const closeForViewportMove = (event: Event) => {
      const target = event.target;
      if (target instanceof window.Node && menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const visualViewport = window.visualViewport;
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("resize", closeForViewportMove);
    window.addEventListener("scroll", closeForViewportMove, true);
    visualViewport?.addEventListener("resize", closeForViewportMove);
    visualViewport?.addEventListener("scroll", closeForViewportMove);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("resize", closeForViewportMove);
      window.removeEventListener("scroll", closeForViewportMove, true);
      visualViewport?.removeEventListener("resize", closeForViewportMove);
      visualViewport?.removeEventListener("scroll", closeForViewportMove);
    };
  }, [open]);

  const choose = (action: () => void) => {
    action();
    closeWithFocusRestore();
  };
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("thumbs.addPages")}
        title={busy ? t("thumbs.insertingPdf") : t("thumbs.addPages")}
        aria-busy={busy || undefined}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (open) closeWithFocusRestore();
          else openAt(0);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          openAt(event.key === "ArrowDown" ? 0 : 1);
        }}
        style={{
          width: targetSize,
          height: targetSize,
          border: "none",
          borderRadius: 4,
          background: open ? T.tint : "transparent",
          color: busy ? T.dim : T.ink2,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: busy ? "progress" : "pointer",
          opacity: busy ? 0.72 : 1,
        }}
      >
        {busy ? (
          <Ic.refresh
            className="shioriPdfInsertionSpinner"
            width={embedded ? 13 : 15}
            height={embedded ? 13 : 15}
          />
        ) : (
          <Ic.plus width={embedded ? 13 : 15} height={embedded ? 13 : 15} />
        )}
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={t("thumbs.addPages")}
          onKeyDown={onMenuKeyDown}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (
              next instanceof window.Node &&
              event.currentTarget.contains(next)
            ) {
              return;
            }
            restoreFocusOnCloseRef.current = false;
            setOpen(false);
          }}
          style={{
            position: "fixed",
            left: position.left,
            top: position.top,
            zIndex: 60,
            width: PAGE_ADD_MENU_WIDTH,
            maxWidth: position.maxWidth,
            maxHeight: position.maxHeight,
            overflowY: "auto",
            overscrollBehavior: "contain",
            boxSizing: "border-box",
            visibility: position.ready ? "visible" : "hidden",
            padding: 4,
            border: "none",
            borderRadius: 10,
            background: T.surface,
            boxShadow: `0 0 0 1px ${T.rule}, 0 4px 12px rgba(10,14,24,0.07), 0 14px 32px rgba(10,14,24,0.12)`,
          }}
        >
          <PageMenuItem
            icon={<Ic.filePlus width={16} height={16} />}
            label={t("thumbs.insertBlankPage")}
            active={activeIndex === 0}
            mobile={mobile}
            onActivate={() => setActiveIndex(0)}
            onClick={() => choose(onInsertBlank)}
          />
          <PageMenuItem
            icon={<Ic.fileInput width={16} height={16} />}
            label={t("thumbs.insertPdfPages")}
            active={activeIndex === 1}
            mobile={mobile}
            onActivate={() => setActiveIndex(1)}
            onClick={() => choose(onInsertPdf)}
          />
        </div>
      ) : null}
    </>
  );
}

function PageMenuItem({
  icon,
  label,
  active,
  mobile = false,
  disabled = false,
  busy = false,
  tone = "default",
  menuIndex,
  onActivate,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  mobile?: boolean;
  disabled?: boolean;
  busy?: boolean;
  tone?: "default" | "danger";
  menuIndex?: number;
  onActivate: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="shioriPageMenuItem"
      data-active={active ? "true" : undefined}
      data-tone={tone}
      data-menu-index={menuIndex}
      tabIndex={active ? 0 : -1}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={onClick}
      onFocus={onActivate}
      style={{
        width: "100%",
        minHeight: mobile ? 44 : 38,
        display: "grid",
        gridTemplateColumns: "24px minmax(0, 1fr)",
        columnGap: 9,
        alignItems: "center",
        border: "none",
        borderRadius: 6,
        padding: "6px 10px",
        color: tone === "danger" ? T.rect : T.ink2,
        textAlign: "start",
        fontFamily: T.sans,
        cursor: disabled ? "progress" : "pointer",
      }}
    >
      <span
        className="shioriPageMenuItemIcon"
        style={{ display: "inline-grid", width: 24, placeItems: "center" }}
      >
        {icon}
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            font: `500 13px/1.25 ${T.sans}`,
          }}
        >
          {label}
        </span>
      </span>
    </button>
  );
}

function estimateThumbnailItemHeight(page: PageModel, isFirst: boolean): number {
  const size = rotatedSize(page.widthPt, page.heightPt, page.rotation);
  const thumbnailHeight =
    (THUMBNAIL_TARGET_WIDTH * Math.max(1, size.height)) / Math.max(1, size.width);
  return Math.ceil(thumbnailHeight + THUMBNAIL_ITEM_CHROME_HEIGHT + (isFirst ? 10 : 0));
}

/**
 * The page actions only exist on the active thumbnail, so changing pages
 * unmounts them. If focus was inside — a keyboard user tabbing to Rotate —
 * it landed on <body>, and the rail's arrow-key navigation had nothing to
 * move from. Hand focus back to the rail before the buttons go away.
 *
 * useLayoutEffect, not useEffect: its cleanup runs before React detaches the
 * node, so document.activeElement is still the button and the rail is still
 * an ancestor.
 */
function PageActions({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      if (!node?.contains(document.activeElement)) return;
      node
        .closest<HTMLElement>(".shioriThumbsRail")
        ?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div ref={ref} style={{ display: "flex", gap: 2 }}>
      {children}
    </div>
  );
}

function Thumb({
  page,
  index,
  active,
  doc,
  preRender,
  paperColor,
  onClick,
  onDelete,
  onRotate,
  onDuplicate,
  onContextMenu,
}: {
  page: PageModel;
  index: number;
  active: boolean;
  doc: PDFDocumentProxy;
  preRender: boolean;
  paperColor: string | null;
  onClick: () => void;
  onDelete: () => void;
  onRotate: () => void;
  onDuplicate: () => void;
  onContextMenu: (x: number, y: number) => void;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: page.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const overlays = useEditorStore(
    useShallow((s) => s.model.overlays.filter((o) => o.pageId === page.id)),
  );
  const lastRenderedRef = useRef<{
    page: PageModel;
    overlays: Overlay[];
    paperColor: string | null;
  } | null>(null);
  // When pre-render is on, every thumbnail rasterises on mount. When off,
  // we defer each thumb's render until it scrolls near the viewport — saves
  // CPU/memory on long documents.
  const [intersected, setIntersected] = useState(false);
  const shouldRender = preRender || intersected;

  useEffect(() => {
    if (shouldRender) return;
    const el = containerRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setIntersected(true);
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shouldRender]);

  useEffect(() => {
    if (!shouldRender) return;
    const lastRendered = lastRenderedRef.current;
    const dirty =
      lastRendered?.page !== page ||
      lastRendered?.overlays !== overlays ||
      lastRendered?.paperColor !== paperColor;
    if (!dirty) return;
    let cancelled = false;
    let handle: ReturnType<typeof renderPageBackdrop> | null = null;
    const timer = window.setTimeout(() => {
      (async () => {
        await loadThumbnailOverlayFonts(overlays);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (isBlankPage(page)) {
          const ctx = canvas.getContext("2d");
          if (!ctx) return;
          const viewport = prepareThumbnailCanvas(
            canvas,
            page,
            THUMBNAIL_TARGET_WIDTH,
          );
          drawThumbnailPaper(ctx, viewport);
          compositePdfPaperColor(ctx, canvas.width, canvas.height, paperColor);
          drawThumbnailOverlays(ctx, page, overlays, viewport);
          if (!cancelled) {
            setReady(true);
            lastRenderedRef.current = { page, overlays, paperColor };
          }
          return;
        }

        const viewport = thumbnailViewportForPage(page, THUMBNAIL_TARGET_WIDTH);
        const size = rotatedSize(page.widthPt, page.heightPt, page.rotation);
        handle = renderPageBackdrop(
          appPdfEngine.renderRegion,
          doc,
          {
            sourceIndex: page.sourceIndex,
            rotation: page.rotation,
            scale: viewport.scale,
            widthPt: size.width,
            heightPt: size.height,
            dpr: window.devicePixelRatio || 1,
            maxPixels: MAX_CANVAS_PIXELS,
            priority: "thumbnail",
          },
          canvas,
        );
        await handle.done;
        if (cancelled) return;
        fitThumbnailCanvasToTile(canvas);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          compositePdfPaperColor(ctx, canvas.width, canvas.height, paperColor);
          drawThumbnailOverlays(ctx, page, overlays, viewport);
        }
        if (!cancelled) {
          setReady(true);
          lastRenderedRef.current = { page, overlays, paperColor };
        }
      })().catch((err) => {
        if (!cancelled) console.warn("Thumbnail render failed:", err);
      });
    }, THUMBNAIL_OVERLAY_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      handle?.cancel();
    };
  }, [doc, overlays, page, paperColor, shouldRender]);

  // Virtuoso recycles thumbnails as they leave its overscan window. Release
  // their bitmap at that lifecycle boundary instead of waiting for WebKit's
  // graphics GC, especially when pre-rendering a short document mounted all
  // of its thumbnails at once.
  useEffect(() => {
    // React clears object refs before passive-effect cleanup. Capture the node
    // while mounted so the returned callback can still release its bitmap.
    const canvas = canvasRef.current;
    return () => releaseCanvasBackingStore(canvas);
  }, []);

  const combinedRef = (el: HTMLDivElement | null) => {
    containerRef.current = el;
    setNodeRef(el);
  };

  return (
    <div
      ref={combinedRef}
      data-thumb-page-id={page.id}
      style={{
        ...style,
        position: "relative",
        padding: 6,
        borderRadius: 4,
        background: active ? T.paper : "transparent",
        border: `1px solid ${active ? T.ink : "transparent"}`,
        cursor: "pointer",
        transition: "background .12s, border-color .12s",
      }}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      <div
        {...attributes}
        {...listeners}
        title={t("thumbs.dragHint")}
        style={{
          width: "100%",
          // Lock the tile to the UNROTATED page aspect so rotating a page
          // (90/270 swaps the rendered dims) doesn't resize the tile — which
          // would shift the rotate button and break continuous clicking. The
          // rotated render is fitted inside via object-fit: contain below.
          aspectRatio: `${page.widthPt}/${page.heightPt}`,
          background: paperColor ?? THUMBNAIL_PAPER,
          border: `0.5px solid ${T.rule}`,
          borderRadius: 2,
          boxShadow: active
            ? "0 4px 14px rgba(0,0,0,0.08)"
            : "0 1px 2px rgba(0,0,0,0.04)",
          position: "relative",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: "100%",
            height: "100%",
            display: "block",
            // The canvas bitmap is the rotated render (its aspect can differ
            // from the fixed unrotated tile); contain letterboxes it inside
            // the stable tile instead of stretching.
            objectFit: "contain",
          }}
        />
        {!ready && !isBlankPage(page) ? (
          <div
            style={{
              position: "absolute",
              color: T.dim,
              font: `500 10px/1 ${T.mono}`,
              letterSpacing: ".06em",
            }}
          >
            …
          </div>
        ) : null}
      </div>
      <div
        style={{
          marginTop: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          font: `500 11px/1 ${T.mono}`,
          color: active ? T.ink : T.dim,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>{String(index + 1).padStart(2, "0")}</span>
        {active ? (
          <PageActions>
            <MiniIconBtn
              title={t("thumbs.rotate")}
              onClick={(e) => {
                e.stopPropagation();
                onRotate();
              }}
            >
              <Ic.rotate />
            </MiniIconBtn>
            <MiniIconBtn
              title={t("thumbs.duplicate")}
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate();
              }}
            >
              <Ic.dup />
            </MiniIconBtn>
            <MiniIconBtn
              title={t("thumbs.delete")}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Ic.trash />
            </MiniIconBtn>
          </PageActions>
        ) : null}
      </div>
    </div>
  );
}

function ThumbContextMenu({
  x,
  y,
  onInsertBlank,
  onInsertPdf,
  pdfInsertionBusy,
  onRotate,
  onDuplicate,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  onInsertBlank: () => void;
  onInsertPdf: () => void;
  pdfInsertionBusy: boolean;
  onRotate: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusOnCloseRef = useRef(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<RenderedPageMenuPlacement>({
    left: x,
    top: y,
    maxWidth: PAGE_CONTEXT_MENU_WIDTH,
    maxHeight: 10_000,
    ready: false,
  });
  const items: Array<{
    label: string;
    action: () => void;
    icon: ReactNode;
    disabled?: boolean;
    busy?: boolean;
    tone?: "default" | "danger";
  }> = [
    {
      label: t("thumbs.insertBlankPage"),
      action: onInsertBlank,
      icon: <Ic.filePlus width={16} height={16} />,
    },
    {
      label: pdfInsertionBusy
        ? t("thumbs.insertingPdf")
        : t("thumbs.insertPdfPages"),
      action: onInsertPdf,
      disabled: pdfInsertionBusy,
      busy: pdfInsertionBusy,
      icon: pdfInsertionBusy ? (
        <Ic.refresh
          className="shioriPdfInsertionSpinner"
          width={16}
          height={16}
        />
      ) : (
        <Ic.fileInput width={16} height={16} />
      ),
    },
    {
      label: t("thumbs.rotate"),
      action: onRotate,
      icon: <Ic.rotate width={16} height={16} />,
    },
    {
      label: t("thumbs.duplicate"),
      action: onDuplicate,
      icon: <Ic.dup width={16} height={16} />,
    },
    {
      label: t("thumbs.delete"),
      action: onDelete,
      icon: <Ic.trash width={16} height={16} />,
      tone: "danger",
    },
  ];
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({
      ...placePageMenu(
        { kind: "point", x, y },
        { width: rect.width, height: rect.height },
        pageMenuViewport(),
        pageMenuSafeInsets(),
      ),
      ready: true,
    });
  }, [position.maxWidth, x, y]);
  useEffect(() => {
    if (!position.ready) return;
    // Remember where focus came from so closing can put it back. Without
    // this, dismissing the menu left focus on <body> and the thumbnail
    // rail's arrow-key navigation had nothing to move from — keyboard
    // users were stranded after a single context-menu interaction.
    const opener = document.activeElement;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus({
      preventScroll: true,
    });
    return () => {
      if (!restoreFocusOnCloseRef.current) return;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
        return;
      }
      document
        .querySelector<HTMLElement>(".shioriThumbsRail")
        ?.focus({ preventScroll: true });
    };
  }, [position.ready]);
  useEffect(() => {
    const closeWithoutRestoringFocus = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node | null)) return;
      restoreFocusOnCloseRef.current = false;
      onClose();
    };
    const closeForViewportMove = (event: Event) => {
      const target = event.target;
      if (target instanceof window.Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    const visualViewport = window.visualViewport;
    window.addEventListener("pointerdown", closeWithoutRestoringFocus, true);
    window.addEventListener("resize", closeForViewportMove);
    window.addEventListener("scroll", closeForViewportMove, true);
    visualViewport?.addEventListener("resize", closeForViewportMove);
    visualViewport?.addEventListener("scroll", closeForViewportMove);
    return () => {
      window.removeEventListener("pointerdown", closeWithoutRestoringFocus, true);
      window.removeEventListener("resize", closeForViewportMove);
      window.removeEventListener("scroll", closeForViewportMove, true);
      visualViewport?.removeEventListener("resize", closeForViewportMove);
      visualViewport?.removeEventListener("scroll", closeForViewportMove);
    };
  }, [onClose]);
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
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
    const nextButton = buttons[next];
    nextButton?.focus();
    if (nextButton?.dataset.menuIndex) {
      setActiveIndex(Number(nextButton.dataset.menuIndex));
    }
  };
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t("thumbs.pageActions")}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (
          next instanceof window.Node &&
          event.currentTarget.contains(next)
        ) {
          return;
        }
        restoreFocusOnCloseRef.current = false;
        onClose();
      }}
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        zIndex: 45,
        width: PAGE_CONTEXT_MENU_WIDTH,
        maxWidth: position.maxWidth,
        maxHeight: position.maxHeight,
        overflowY: "auto",
        overscrollBehavior: "contain",
        touchAction: "manipulation",
        boxSizing: "border-box",
        visibility: position.ready ? "visible" : "hidden",
        background: T.surface,
        border: "none",
        borderRadius: 10,
        boxShadow: `0 0 0 1px ${T.rule}, 0 4px 12px rgba(10,14,24,0.07), 0 14px 32px rgba(10,14,24,0.12)`,
        padding: 4,
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onMenuKeyDown}
    >
      {[items.slice(0, 2), items.slice(2, 4), items.slice(4)].map(
        (group, groupIndex) => (
          <div key={groupIndex} role="presentation">
            {groupIndex > 0 ? (
              <div
                role="separator"
                style={{ height: 1, margin: "4px 6px", background: T.ruleSoft }}
              />
            ) : null}
            <div role="presentation" style={{ display: "grid", gap: 2 }}>
              {group.map((item) => {
                const index = items.indexOf(item);
                return (
                  <PageMenuItem
                    key={`${index}:${item.label}`}
                    icon={item.icon}
                    label={item.label}
                    active={!item.disabled && activeIndex === index}
                    mobile={isMobile}
                    disabled={item.disabled}
                    busy={item.busy}
                    tone={item.tone}
                    menuIndex={index}
                    onActivate={() => setActiveIndex(index)}
                    onClick={() => {
                      item.action();
                      onClose();
                    }}
                  />
                );
              })}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
