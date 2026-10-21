import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import {
  paletteForTheme,
  resolveEffectiveTheme,
  type ThemePalette,
} from "../../design/theme";
import { Ic } from "./icons";
import { MiniIconBtn, SegTabs } from "./ui";
import {
  useAppStore,
  useEditorStore,
  useEditorStoreApi,
  type AppStoreApi,
  type PdfEditorStoreApi,
  type PrefsColorMode,
  type PrefsTerminalTheme,
  type PrefsTheme,
  type RailTab,
} from "../store/store";
import type { PdfDocument } from "../../pdf/engine/types";
import type { NoteOverlay, Overlay } from "../../pdf/model/types";
import { useNow } from "../hooks/useNow";
import { formatRelative, relativeLabelsFor } from "../../shared/format";
import { noteDisplayTimestamp } from "../overlays/noteMetadata";
import {
  useIsMobile,
  useTerminalFitsViewport,
} from "../hooks/useIsMobile";
import {
  CAPABILITIES,
  EmbeddedTerminalError,
  IS_TABLET,
  killEmbeddedTerminal,
  listenEmbeddedTerminalExit,
  listenEmbeddedTerminalOutput,
  resizeEmbeddedTerminal,
  spawnEmbeddedTerminal,
  writeEmbeddedTerminal,
  writeEmbeddedTerminalBinary,
} from "../../platform";
import { recordTabPerfRender } from "../../perf/tabPerf";
import { safeUnlisten } from "../../platform/ipc";
import { WINDOW_CAPTION_HEIGHT } from "../../platform/windowCaption";
import { toast } from "../toast";
import {
  registerFollowUpTerminalSession,
  selectFollowUpTerminalSession,
  unregisterFollowUpTerminalSession,
} from "../../live/followUpLoop";
import {
  EMBEDDED_TERMINAL_OPTIONS,
  createTrailingTerminalResize,
  preloadEmbeddedTerminalFonts,
  type TerminalResizeScheduler,
} from "./embeddedTerminalRuntime";
import { ExternalTerminalLauncher } from "./ExternalTerminalLauncher";
import {
  clampNavigatorWidth,
  HEADER_BAND_HEIGHT,
  RAIL_MIN_WIDTH,
} from "./navigatorLayout";
import { OutlinePanel } from "./OutlinePanel";
import { BrowserPanel } from "./BrowserPanel";

type Props = {
  doc: PdfDocument | null;
  onClose: () => void;
  nativeWebviewObscured?: boolean;
};

// Shared with the navigator's clamp: both gutters budget against the same
// window, so the floor the rail refuses to go under is exactly the width the
// navigator has to leave for it.
const TERMINAL_RAIL_MIN_WIDTH = RAIL_MIN_WIDTH;
const TERMINAL_RAIL_DEFAULT_WIDTH = 460;
const TERMINAL_RAIL_MAX_WIDTH = 760;

// Memoized: App re-renders on every store change it subscribes to (page
// turns, selection, overlays…), and the rail hosts an xterm instance plus a
// native browser webview whose bounds work should not run for unrelated
// renders. Props are a stable doc proxy, a stable callback, and a boolean,
// so the shallow comparison holds. Store-driven updates (tab, overlays,
// prefs) reach the rail through its own subscriptions.
export const RightRail = memo(function RightRail({
  doc,
  onClose,
  nativeWebviewObscured = false,
}: Props) {
  recordTabPerfRender("RightRail");
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const editorStore = useEditorStoreApi();
  const outlineInRail = isMobile;
  const notesInRail = isMobile;
  // Where the rail lands when its current tab becomes unavailable. On desktop
  // the reading tabs are gone, so it falls back to a working surface.
  const fallbackTab: RailTab = outlineInRail
    ? "outline"
    : notesInRail
      ? "comments"
      : CAPABILITIES.embeddedTerminal
        ? "terminal"
        : "browser";
  const terminalFits = useTerminalFitsViewport();
  const tab = useAppStore((s) => s.railTab);
  const setTab = useAppStore((s) => s.setRailTab);
  const overlays = useEditorStore((s) => s.model.overlays);
  const pages = useEditorStore((s) => s.model.pages);
  const goToPage = useEditorStore((s) => s.goToPage);
  const selectOnly = useEditorStore((s) => s.selectOnly);
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const updateOverlay = useEditorStore((s) => s.updateOverlay);
  const openedPath = useEditorStore((s) => s.opened?.path);
  // Any full-screen overlay that would otherwise be hidden behind the
  // native Browser webview (an OS layer that ignores DOM stacking). When
  // one is open we hide the webview so the dialog is usable.
  const anyOverlayOpen = useAppStore(
    (s) =>
      s.showSettings ||
      s.showExport ||
      s.showShortcuts ||
      s.showGoToPage ||
      s.showFind ||
      s.showBetaDisclaimer ||
      s.isPrinting,
  );
  const now = useNow(60_000);
  const [terminalMounted, setTerminalMounted] = useState(tab === "terminal");
  // Several terminals, not one. A single session meant the agent answering a
  // follow-up and a build you wanted to watch had to take turns in the same
  // pane. Every session stays mounted so its scrollback and its running
  // process survive switching away — hiding a terminal must not kill it.
  const [terminalIds, setTerminalIds] = useState<readonly string[]>(() => [
    newTerminalPaneId(),
  ]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const currentTerminalId = activeTerminalId ?? terminalIds[0] ?? null;
  const addTerminal = () => {
    const id = newTerminalPaneId();
    setTerminalIds((current) => [...current, id]);
    setActiveTerminalId(id);
  };
  const closeTerminal = (id: string) => {
    setTerminalIds((current) => {
      const next = current.filter((item) => item !== id);
      // Never zero: an empty terminal tab with no way back would be a dead
      // end, so closing the last one starts a fresh session instead.
      const kept = next.length > 0 ? next : [newTerminalPaneId()];
      setActiveTerminalId((active) =>
        active === id ? kept[kept.length - 1] ?? null : active,
      );
      return kept;
    });
  };
  const [browserMounted, setBrowserMounted] = useState(tab === "browser");
  // Terminal and Browser share the wider, resizable rail layout.
  const isWideRail =
    (tab === "terminal" && CAPABILITIES.embeddedTerminal) ||
    (tab === "browser" && CAPABILITIES.embeddedBrowserPanel);
  const [terminalRailWidth, setTerminalRailWidth] = useState(TERMINAL_RAIL_DEFAULT_WIDTH);
  const [railDrag, setRailDrag] = useState<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const browserObscured = anyOverlayOpen || nativeWebviewObscured || railDrag != null;
  // Mid-drag the width bypasses React entirely: each frame writes the rail
  // element's style directly, so the browser does layout and nothing else.
  // A per-frame setState re-rendered the whole rail (terminal wrappers,
  // panels) and stalled long enough for the pointer to visibly outrun the
  // pane — React gets the committed width once, on release.
  const railRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!railDrag) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // Tell the document column to hold its expensive reactions (fit-scale,
    // re-measures) until the drag ends.
    useAppStore.getState().setChromeResizing(true);

    const maxWidth = terminalRailMaxWidth(useAppStore, editorStore);
    let frame: number | null = null;
    let pendingX = railDrag.startX;
    const widthAt = (clientX: number) =>
      clamp(
        railDrag.startWidth + railDrag.startX - clientX,
        TERMINAL_RAIL_MIN_WIDTH,
        maxWidth,
      );
    const apply = () => {
      frame = null;
      const el = railRef.current;
      if (!el) return;
      const next = widthAt(pendingX);
      el.style.width = `${next}px`;
      el.style.flex = `0 0 ${next}px`;
    };
    // Every way a drag can end, funnelled into one finish. Releasing the
    // button outside the window delivers no mouseup here, so a mouseup-only
    // teardown left the rail following the pointer after the user came back
    // — with body selection still disabled and the document's resize
    // reactions still suppressed. A move with no button held is that same
    // release, observed one frame later.
    const finish = (clientX: number) => {
      setTerminalRailWidth(widthAt(clientX));
      setRailDrag(null);
    };
    const onMove = (event: MouseEvent) => {
      if (event.buttons === 0) {
        finish(event.clientX);
        return;
      }
      pendingX = event.clientX;
      if (frame == null) frame = window.requestAnimationFrame(apply);
    };
    const onUp = (event: MouseEvent) => finish(event.clientX);
    const onCancel = () => finish(pendingX);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      if (frame != null) window.cancelAnimationFrame(frame);
      useAppStore.getState().setChromeResizing(false);
    };
  }, [editorStore, railDrag]);

  useEffect(() => {
    if (isMobile) return;
    const onResize = () => {
      setTerminalRailWidth((width) =>
        clamp(width, TERMINAL_RAIL_MIN_WIDTH, terminalRailMaxWidth(useAppStore, editorStore)),
      );
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [editorStore, isMobile]);

  // The max width depends on the navigator too, so opening or widening it
  // must re-clamp the rail — a window resize is not the only way the space
  // budget changes. Subscribing is enough: the render below re-clamps the
  // displayed width against terminalRailMaxWidth(useAppStore, editorStore) on every render, this
  // just makes sure a navigator change causes one.
  const navigatorWidth = useAppStore((s) =>
    s.prefs.showNavigator ? s.prefs.navigatorWidth : 0,
  );
  const readerMode = useEditorStore((s) => s.readerMode);
  void (readerMode ? 0 : navigatorWidth);

  useEffect(() => {
    if (!CAPABILITIES.embeddedTerminal) return;
    if (tab !== "terminal" || terminalMounted) return;
    const handle = window.setTimeout(() => setTerminalMounted(true), 0);
    return () => window.clearTimeout(handle);
  }, [tab, terminalMounted]);

  useEffect(() => {
    if (!CAPABILITIES.embeddedBrowserPanel) return;
    if (tab !== "browser" || browserMounted) return;
    const handle = window.setTimeout(() => setBrowserMounted(true), 0);
    return () => window.clearTimeout(handle);
  }, [tab, browserMounted]);

  // Clamp a stale persisted rail tab to a valid one. A session/draft saved
  // with railTab "terminal"/"browser" can be restored on a build or platform
  // where that capability is off (mobile, or a re-narrowed Windows gate),
  // which would otherwise strand an empty rail pane with no active SegTab.
  //
  // The fallback must itself be available. On web desktop NO tab is: the
  // reading tabs live in the navigator and neither the terminal nor the
  // browser panel exists, so `fallbackTab` resolves to "browser" — which
  // App's own clamp immediately rewrites back to "outline", which is not
  // available here either. Each effect depends on the value the other
  // writes, so a rail left open across the mobile→desktop breakpoint used to
  // ping-pong until React bailed out with "Maximum update depth exceeded"
  // and tore the editor down. Nothing renders in that state anyway (see the
  // `tabs.length === 0` return below), so there is nothing to clamp to.
  const tabAvailable = useCallback(
    (candidate: RailTab) =>
      (candidate === "outline" && outlineInRail) ||
      (candidate === "comments" && notesInRail) ||
      (candidate === "terminal" && CAPABILITIES.embeddedTerminal) ||
      (candidate === "browser" && CAPABILITIES.embeddedBrowserPanel),
    [outlineInRail, notesInRail],
  );
  useEffect(() => {
    if (tabAvailable(tab)) return;
    if (!tabAvailable(fallbackTab)) return;
    setTab(fallbackTab);
  }, [tab, setTab, tabAvailable, fallbackTab]);

  // Collapse the terminal when the window gets too narrow to hold it and a
  // usable page, and put it back when the width returns.
  //
  // The window used to prevent this situation outright (minWidth 960), which
  // charged every window for one optional panel. A panel that cannot fit
  // should step aside, not veto the window size.
  //
  // The ref is the user's intent, not just the last tab: if they deliberately
  // pick another tab while narrow, the terminal must NOT come back on its own.
  const terminalAutoCollapsedRef = useRef(false);
  useEffect(() => {
    if (!CAPABILITIES.embeddedTerminal) return;
    if (!terminalFits) {
      if (tab === "terminal") {
        terminalAutoCollapsedRef.current = true;
        setTab(fallbackTab);
      } else if (tab !== fallbackTab) {
        // A deliberate choice while narrow supersedes the pending restore.
        terminalAutoCollapsedRef.current = false;
      }
      return;
    }
    if (terminalAutoCollapsedRef.current) {
      terminalAutoCollapsedRef.current = false;
      setTab("terminal");
    }
  }, [terminalFits, tab, setTab, fallbackTab]);


  const notes = overlays
    .filter((o): o is NoteOverlay => o.type === "note")
    .toSorted(
      (a, b) =>
        (noteDisplayTimestamp(b) ?? 0) - (noteDisplayTimestamp(a) ?? 0),
    );
  const unresolved = notes.length;
  const tabs: Array<{ v: RailTab; label: string; badge?: number }> = [
    // Desktop reads the outline in the left navigator, alongside the other
    // answers to "where am I". A phone has no gutter for that navigator, so
    // the rail stays its home there.
    ...(outlineInRail
      ? [{ v: "outline" as const, label: t("rail.outline") }]
      : []),
    // Same reasoning as the outline: on desktop the notes are already in the
    // navigator's marks view, which lists EVERY kind of mark rather than
    // only sticky notes. Keeping this tab meant a permanently empty panel --
    // Shiori has no note tool left in the toolbar, so a new document can
    // never produce one -- taking width from the terminal and browser.
    ...(notesInRail
      ? [{ v: "comments" as const, label: t("rail.comments"), badge: unresolved }]
      : []),
  ];
  // Hidden rather than disabled while the window is too narrow: a tab that
  // bounces straight back to Outline reads as broken. It returns, with the
  // terminal reselected, as soon as there is room again.
  if (CAPABILITIES.embeddedTerminal && terminalFits) {
    tabs.push({ v: "terminal", label: t("rail.terminal") });
  }
  if (CAPABILITIES.embeddedBrowserPanel) {
    tabs.push({ v: "browser", label: t("rail.browser") });
  }

  const handleRailTabChange = useCallback(
    (nextTab: RailTab) => {
      setTab(nextTab);
    },
    [setTab],
  );

  // Nothing left to show. On web desktop there is no embedded terminal and no
  // browser panel, so once the reading tabs moved to the navigator this rail
  // has no tabs at all — and an empty bordered column beside the page is
  // worse than no column. Every entry point is capability-gated, so this only
  // catches a `showRail: true` restored from a session that had tabs.
  if (tabs.length === 0) return null;

  // Mobile slides the rail in from the right as a drawer over the
  // canvas; desktop keeps the long-standing in-flow column. Width
  // jumps to ~85vw so outline labels and comment notes have room to
  // wrap without horizontal scroll on a phone.
  const constrainedTerminalRailWidth = clamp(
    terminalRailWidth,
    TERMINAL_RAIL_MIN_WIDTH,
    terminalRailMaxWidth(useAppStore, editorStore),
  );
  // One resizable width shared by every tab, so switching to Outline /
  // Comments no longer snaps the rail back to a narrow size.
  const desktopRailWidth = `${constrainedTerminalRailWidth}px`;
  const railStyle: React.CSSProperties = isMobile
    ? {
        position: "fixed",
        top: 0,
        bottom: 0,
        right: 0,
        width: "min(85vw, 360px)",
        zIndex: 45,
        borderLeft: `1px solid ${T.rule}`,
        background: T.cream,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        boxShadow: "0 18px 40px rgba(20,16,10,0.18)",
        // A narrow Windows window gets this drawer too; keep its top clear
        // of the caption buttons.
        paddingTop: `calc(${
          CAPABILITIES.customWindowCaption ? WINDOW_CAPTION_HEIGHT : 0
        }px + var(--shiori-safe-top, 0px))`,
        paddingBottom: "var(--shiori-safe-bottom, 0px)",
        paddingRight: "var(--shiori-safe-right, 0px)",
      }
    : {
        width: desktopRailWidth,
        flex: `0 0 ${desktopRailWidth}`,
        borderLeft: `1px solid ${T.rule}`,
        background: T.cream,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        position: "relative",
      };

  return (
    // Was a plain <div>: absent from the landmark list entirely, so the rail
    // could not be reached by landmark navigation at all.
    <aside
      ref={railRef}
      className="shioriPrintHide"
      aria-label={t("a11y.landmarks.rail")}
      style={railStyle}
    >
      {/* No drag-to-resize on touch tablets: the rail's wide layout hosts the
          native Browser plugin view (an OS layer over the DOM), and dragging a
          thin handle across it would eat touches. Desktop keeps the handle. */}
      {!isMobile && !IS_TABLET ? (
        <div
          role="separator"
          aria-orientation="vertical"
          title={
            tab === "browser"
              ? t("browser.resize")
              : tab === "terminal"
                ? t("terminal.resize")
                : t("rail.resize")
          }
          tabIndex={0}
          aria-valuemin={TERMINAL_RAIL_MIN_WIDTH}
          aria-valuemax={Math.round(terminalRailMaxWidth(useAppStore, editorStore))}
          aria-valuenow={Math.round(constrainedTerminalRailWidth)}
          onMouseDown={(event) => {
            event.preventDefault();
            setRailDrag({
              startX: event.clientX,
              startWidth: constrainedTerminalRailWidth,
            });
          }}
          // A separator that only answers to a pointer leaves a keyboard
          // reader unable to widen a rail that is covering what they are
          // reading. Arrows nudge, Home/End take the extremes, and Enter
          // matches what a double-click does with a mouse.
          onKeyDown={(event) => {
            const max = terminalRailMaxWidth(useAppStore, editorStore);
            const step = event.shiftKey ? 64 : 16;
            const next =
              event.key === "ArrowLeft"
                ? constrainedTerminalRailWidth + step
                : event.key === "ArrowRight"
                  ? constrainedTerminalRailWidth - step
                  : event.key === "Home"
                    ? max
                    : event.key === "End"
                      ? TERMINAL_RAIL_MIN_WIDTH
                      : event.key === "Enter"
                        ? TERMINAL_RAIL_DEFAULT_WIDTH
                        : null;
            if (next === null) return;
            event.preventDefault();
            setTerminalRailWidth(clamp(next, TERMINAL_RAIL_MIN_WIDTH, max));
          }}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            // Kept inside the rail's own box. At -4 it reached over the
            // toolbar beside it, so the last few pixels of that row answered
            // to the rail instead of to the button under the pointer.
            left: 0,
            width: 6,
            cursor: "col-resize",
            zIndex: 2,
          }}
        >
          {/* Native split views (Finder, Xcode) mark a resizable seam with
              the cursor alone — no parked pill. Feedback appears only while
              the drag is live. */}
          {railDrag ? (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                width: 2,
                background: T.accent,
              }}
            />
          ) : null}
        </div>
      ) : null}
      <div
        style={{
          // This column's slice of the header band — the same height as the
          // tab strip and the navigator's header, so the three bottom borders
          // join into one line across the window.
          height: HEADER_BAND_HEIGHT,
          display: "flex",
          alignItems: "center",
          padding: "0 10px 0 14px",
          borderBottom: `1px solid ${T.rule}`,
          gap: 8,
          flex: "0 0 auto",
        }}
      >
        <div style={{ flex: 1, minWidth: 0, display: "flex" }}>
          <SegTabs tabs={tabs} value={tab} onChange={handleRailTabChange} />
        </div>
        {tab === "terminal" && CAPABILITIES.embeddedTerminal ? (
          <ExternalTerminalLauncher
            workingDirectory={parentDirectory(openedPath)}
          />
        ) : null}
        {tab === "terminal" && CAPABILITIES.embeddedTerminal ? (
          <MiniIconBtn
            title={t("terminal.newSession")}
            onClick={addTerminal}
            size={28}
          >
            <Ic.plus />
          </MiniIconBtn>
        ) : null}
        <MiniIconBtn title={t("rail.close")} onClick={onClose} size={28}>
          <Ic.x />
        </MiniIconBtn>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: isWideRail ? "hidden" : "auto",
          // Working surfaces run flush to the rail's edges — the rail's own
          // border is the frame, and a second inset frame around a terminal
          // or web page was one nested box too many.
          padding: isWideRail ? 0 : "10px 6px 16px",
        }}
      >
        {outlineInRail ? (
          <div style={{ display: tab === "outline" ? "block" : "none" }}>
            <OutlinePanel doc={doc} />
          </div>
        ) : null}
        <div style={{ display: tab === "comments" ? "block" : "none" }}>
          <CommentsList
            notes={notes.map((n) => ({
              id: n.id,
              text: n.text,
              pageId: n.pageId,
              createdAt: n.createdAt,
              updatedAt: n.updatedAt,
            }))}
            pages={pages}
            selectedIds={selectedIds}
            now={now}
            onSelect={(pageId, id) => {
              const index = pages.findIndex((page) => page.id === pageId);
              if (index >= 0) goToPage(pageId, index);
              selectOnly(id);
            }}
            onEdit={(id, text) => {
              updateOverlay(id, {
                text,
                updatedAt: Date.now(),
              } as Partial<Overlay>);
            }}
          />
        </div>
        {CAPABILITIES.embeddedTerminal && (terminalMounted || tab === "terminal") ? (
          <div
            style={{
              display: tab === "terminal" ? "flex" : "none",
              flexDirection: "column",
              height: "100%",
              minHeight: 0,
            }}
          >
            {/* The session bar only appears once there is a choice to make. */}
            {terminalIds.length > 1 ? (
              <div
                role="tablist"
                aria-label={t("terminal.sessions")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  padding: "6px 8px 4px",
                  flex: "0 0 auto",
                  overflowX: "auto",
                  scrollbarWidth: "none",
                }}
              >
                {terminalIds.map((id, index) => (
                  <TerminalSessionTab
                    key={id}
                    label={String(index + 1)}
                    active={id === currentTerminalId}
                    onSelect={() => setActiveTerminalId(id)}
                    onClose={() => closeTerminal(id)}
                    closeLabel={t("terminal.closeSession")}
                  />
                ))}
              </div>
            ) : null}
            {terminalIds.map((id) => (
              <div
                key={id}
                style={{
                  display: id === currentTerminalId ? "block" : "none",
                  flex: 1,
                  minHeight: 0,
                }}
              >
                <TerminalPanel
                  filePath={openedPath}
                  active={tab === "terminal" && id === currentTerminalId}
                  resizing={railDrag != null}
                />
              </div>
            ))}
          </div>
        ) : null}
        {CAPABILITIES.embeddedBrowserPanel && (browserMounted || tab === "browser") ? (
          <div
            style={{
              display: tab === "browser" ? "block" : "none",
              height: "100%",
              minHeight: 0,
            }}
          >
            <BrowserPanel
              active={tab === "browser"}
              obscured={browserObscured}
            />
          </div>
        ) : null}
      </div>
    </aside>
  );
});

const TerminalPanel = memo(function TerminalPanel({
  filePath,
  active,
  resizing = false,
}: {
  filePath?: string;
  active: boolean;
  // True while the rail's width handle is being dragged. Refitting xterm
  // means reflowing the whole scrollback buffer; per-frame during a drag it
  // is the single heaviest thing on the main thread, so fits are held until
  // the drag ends and run once.
  resizing?: boolean;
}) {
  const { t } = useTranslation();
  const appColorMode = useAppStore((s) => s.prefs.colorMode);
  const appTheme = useAppStore((s) => s.prefs.theme);
  const terminalColorMode = useAppStore((s) => s.prefs.terminalColorMode);
  const terminalTheme = useAppStore((s) => s.prefs.terminalTheme);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const resizeSchedulerRef = useRef<TerminalResizeScheduler | null>(null);
  const activeRef = useRef(active);
  const terminalVisual = useMemo(
    () =>
      embeddedTerminalVisual(
        terminalTheme,
        terminalColorMode,
        appTheme,
        appColorMode,
      ),
    [appColorMode, appTheme, terminalColorMode, terminalTheme],
  );
  const terminalVisualRef = useRef(terminalVisual);
  const [status, setStatus] = useState<"connecting" | "ready" | "ended" | "error">(
    "connecting",
  );
  const workingDirectory = parentDirectory(filePath);
  const workingDirectoryRef = useRef<string | null>(workingDirectory);
  const terminalCopy = useMemo(() => makeTerminalCopy(t), [t]);
  const copyRef = useRef<TerminalCopy>(terminalCopy);

  // A callout follow-up goes to the terminal on screen. Selecting a tab does
  // not respawn anything, so "most recently spawned" drifts away from "the
  // one the reader is looking at" as soon as a second terminal exists —
  // dispatch has to be told which pane is showing. `status` is in the deps
  // because the session id only exists once the pty has spawned.
  useEffect(() => {
    if (!active) return;
    const sessionId = sessionRef.current;
    if (sessionId) selectFollowUpTerminalSession(sessionId);
  }, [active, status]);

  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);

  const resizingRef = useRef(resizing);
  useLayoutEffect(() => {
    resizingRef.current = resizing;
  }, [resizing]);

  useEffect(() => {
    workingDirectoryRef.current = workingDirectory;
  }, [workingDirectory]);

  useEffect(() => {
    copyRef.current = terminalCopy;
  }, [terminalCopy]);

  useEffect(() => {
    terminalVisualRef.current = terminalVisual;
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalVisual.xterm;
    if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
  }, [terminalVisual]);

  const fitAndScheduleResize = useCallback(() => {
    if (!activeRef.current || resizingRef.current) return;
    const terminal = terminalRef.current;
    if (!fitRef.current || !terminal) return;
    const host = hostRef.current;
    if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    fitRef.current.fit();
    if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
    const currentSessionId = sessionRef.current;
    if (!currentSessionId) return;
    resizeSchedulerRef.current?.schedule({
      sessionId: currentSessionId,
      cols: terminal.cols,
      rows: terminal.rows,
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    const handle = window.setTimeout(() => {
      fitAndScheduleResize();
      terminalRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [active, fitAndScheduleResize]);

  // The one fit that was held back during the drag, once it ends.
  useEffect(() => {
    if (resizing || !active) return;
    const handle = window.setTimeout(fitAndScheduleResize, 0);
    return () => window.clearTimeout(handle);
  }, [resizing, active, fitAndScheduleResize]);

  useEffect(() => {
    if (!CAPABILITIES.embeddedTerminal) return;
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let resizeFrame: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let disposeData: { dispose: () => void } | null = null;
    let disposeBinary: { dispose: () => void } | null = null;
    let disposeScroll: { dispose: () => void } | null = null;
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let refreshFrame: number | null = null;
    const resizeScheduler = createTrailingTerminalResize(
      ({ sessionId, cols, rows }) => {
        void resizeEmbeddedTerminal(sessionId, cols, rows).catch(() => undefined);
      },
    );
    resizeSchedulerRef.current = resizeScheduler;

    const cleanupSession = () => {
      const sessionId = sessionRef.current;
      sessionRef.current = null;
      if (sessionId) {
        unregisterFollowUpTerminalSession(sessionId);
        void killEmbeddedTerminal(sessionId).catch(() => undefined);
      }
    };

    const scheduleViewportRefresh = () => {
      if (refreshFrame != null) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = null;
        const terminal = terminalRef.current;
        if (!terminal || terminal.rows <= 0) return;
        terminal.refresh(0, terminal.rows - 1);
      });
    };

    const scheduleFit = () => {
      if (!activeRef.current || resizeFrame != null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        fitAndScheduleResize();
      });
    };

    const boot = async () => {
      setStatus("connecting");
      host.textContent = "";

      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      if (disposed) return;
      await preloadEmbeddedTerminalFonts();
      if (disposed) return;

      const terminal = new Terminal({
        ...EMBEDDED_TERMINAL_OPTIONS,
        theme: terminalVisualRef.current.xterm,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      terminalRef.current = terminal;
      fitRef.current = fit;
      fit.fit();

      const sessionId = newTerminalSessionId();
      sessionRef.current = sessionId;
      const outputDecoder = new TextDecoder();

      const outputUnlisten = await listenEmbeddedTerminalOutput((event) => {
        if (event.sessionId !== sessionRef.current) return;
        const decoded = outputDecoder.decode(decodeBase64Bytes(event.data), {
          stream: true,
        });
        if (decoded) terminal.write(decoded);
      });
      if (disposed) {
        outputUnlisten();
        return;
      }
      unlistenOutput = outputUnlisten;

      const exitUnlisten = await listenEmbeddedTerminalExit((event) => {
        if (event.sessionId !== sessionRef.current) return;
        unregisterFollowUpTerminalSession(event.sessionId);
        const copy = copyRef.current;
        setStatus("ended");
        const rest = outputDecoder.decode();
        if (rest) terminal.write(rest);
        terminal.write(`\r\n${copy.sessionEnded}\r\n`);
      });
      if (disposed) {
        exitUnlisten();
        return;
      }
      unlistenExit = exitUnlisten;

      const initialCols = terminal.cols;
      const initialRows = terminal.rows;
      await spawnEmbeddedTerminal({
        sessionId,
        workingDirectory: workingDirectoryRef.current,
        cols: initialCols,
        rows: initialRows,
      });
      if (disposed) {
        void killEmbeddedTerminal(sessionId).catch(() => undefined);
        return;
      }
      // The callout follow-up loop dispatches to the session the reader has
      // selected (see the effect below); registering only says this one is
      // alive. A dead session unregisters via the exit listener above and
      // the teardown below.
      registerFollowUpTerminalSession(sessionId);
      resizeScheduler.markDelivered({
        sessionId,
        cols: initialCols,
        rows: initialRows,
      });
      setStatus("ready");
      terminal.focus();

      disposeData = terminal.onData((data) => {
        const currentSessionId = sessionRef.current;
        if (!currentSessionId) return;
        void writeEmbeddedTerminal(currentSessionId, data).catch(() => undefined);
      });
      disposeBinary = terminal.onBinary((data) => {
        const currentSessionId = sessionRef.current;
        if (!currentSessionId) return;
        void writeEmbeddedTerminalBinary(currentSessionId, data).catch(
          () => undefined,
        );
      });
      disposeScroll = terminal.onScroll(scheduleViewportRefresh);

      resizeObserver = new ResizeObserver(() => {
        if (!activeRef.current) return;
        scheduleFit();
      });
      resizeObserver.observe(host);
      fitAndScheduleResize();
    };

    void boot().catch((err) => {
      if (disposed) return;
      setStatus("error");
      const copy = copyRef.current;
      const detail = terminalErrorDetail(err, copy);
      terminalRef.current?.write(`\r\n${detail}\r\n`);
      toast.error(copy.openFailed, detail);
      cleanupSession();
    });

    return () => {
      disposed = true;
      if (resizeFrame != null) window.cancelAnimationFrame(resizeFrame);
      if (refreshFrame != null) window.cancelAnimationFrame(refreshFrame);
      resizeScheduler.cancel();
      if (resizeSchedulerRef.current === resizeScheduler) {
        resizeSchedulerRef.current = null;
      }
      resizeObserver?.disconnect();
      disposeData?.dispose();
      disposeBinary?.dispose();
      disposeScroll?.dispose();
      // Before the terminal is disposed, and never throwing: a failed detach
      // used to abandon the rest of this cleanup, leaking the xterm instance
      // and its pty alongside the listener.
      safeUnlisten(unlistenOutput);
      safeUnlisten(unlistenExit);
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      cleanupSession();
    };
  }, [fitAndScheduleResize]);

  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <style>{`
        .shioriTerminalHost .xterm {
          height: 100%;
          width: 100%;
        }
        .shioriTerminalHost .xterm-viewport,
        .shioriTerminalHost .xterm-screen {
          background: transparent !important;
        }
        /* Shape the VS Code-derived slider like every other considered
           scroller in the app (app.css .shioriThumbsRail): rounded, and
           inset by a transparent border so the visible thumb is slim
           instead of a full-width slab. xterm sets only the slider's
           background-color inline, so these three properties are ours. */
        .shioriTerminalHost .xterm-scrollable-element > .scrollbar > .slider {
          border-radius: 10px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
      `}</style>
      {/* Full-bleed pane, not a card. The terminal's own background runs to
          the rail's edges (VS Code / Warp style); the rail border is the
          only frame. The old rounded, bordered, inset-shadowed box inside
          the bordered rail was the seam's third nested container. */}
      <div
        className="shioriTerminalFrame"
        style={{
          flex: 1,
          minHeight: 240,
          padding: "8px 10px",
          background: terminalVisual.background,
          overflow: "hidden",
          boxSizing: "border-box",
          display: "flex",
        }}
      >
        <div
          ref={hostRef}
          className="shioriTerminalHost"
          aria-label={t("terminal.title")}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            position: "relative",
            overflow: "hidden",
          }}
        />
      </div>
      {status === "connecting" ? (
        <div
          style={{
            font: `12px/1.35 ${T.sans}`,
            color: T.dim,
            padding: "6px 10px 8px",
          }}
        >
          {t("terminal.connecting")}
        </div>
      ) : null}
    </div>
  );
});

function terminalErrorDetail(
  err: unknown,
  copy: TerminalCopy,
): string {
  const code = err instanceof EmbeddedTerminalError ? err.code : "unavailable";
  return copy.errors[code];
}

type TerminalCopy = {
  openFailed: string;
  sessionEnded: string;
  errors: Record<
    | "unsupported"
    | "unavailable"
    | "cwdUnavailable"
    | "cwdNotDirectory"
    | "sessionMissing"
    | "expired",
    string
  >;
};

function makeTerminalCopy(
  t: ReturnType<typeof useTranslation>["t"],
): TerminalCopy {
  return {
    openFailed: t("terminal.openFailed"),
    sessionEnded: t("terminal.sessionEnded"),
    errors: {
      unsupported: t("terminal.errors.unsupported"),
      unavailable: t("terminal.errors.unavailable"),
      cwdUnavailable: t("terminal.errors.cwdUnavailable"),
      cwdNotDirectory: t("terminal.errors.cwdNotDirectory"),
      sessionMissing: t("terminal.errors.sessionMissing"),
      expired: t("terminal.errors.expired"),
    },
  };
}

type EmbeddedTerminalVisual = {
  background: string;
  xterm: import("@xterm/xterm").ITheme;
};

function embeddedTerminalVisual(
  terminalTheme: PrefsTerminalTheme,
  terminalColorMode: PrefsColorMode,
  appTheme: PrefsTheme,
  appColorMode: PrefsColorMode,
): EmbeddedTerminalVisual {
  const theme = terminalTheme === "Auto" ? appTheme : terminalTheme;
  const effective =
    terminalColorMode === "Auto"
      ? resolveEffectiveTheme(appColorMode)
      : resolveEffectiveTheme(terminalColorMode);
  const palette = paletteForTheme(theme, effective);
  const dark = effective === "dark";
  const background = dark ? palette.paper : palette.cream;

  return {
    background,
    xterm: embeddedTerminalTheme(palette, background, dark),
  };
}

function embeddedTerminalTheme(
  palette: ThemePalette,
  background: string,
  dark: boolean,
): import("@xterm/xterm").ITheme {
  return {
    background,
    foreground: palette.ink,
    cursor: palette.accent,
    cursorAccent: background,
    selectionBackground: palette.accentSoft,
    // xterm draws a VS Code-style scrollbar, and its default slider is the
    // foreground at a flat 20/40/50% — a hard, full-width bar that reads as
    // a stock desktop scrollbar next to the rest of the app. Match the
    // thumbnails rail instead (app.css .shioriThumbsRail): the same 32% /
    // 50% ink ramp, with the rounding and inset applied in CSS below.
    scrollbarSliderBackground: `${palette.ink}52`,
    scrollbarSliderHoverBackground: `${palette.ink}80`,
    scrollbarSliderActiveBackground: `${palette.ink}99`,
    black: dark ? "#10151d" : palette.ink,
    brightBlack: palette.dim,
    red: palette.rect,
    brightRed: dark ? "#ff776b" : "#c83f36",
    green: dark ? "#4f9f6f" : "#2f7d58",
    brightGreen: dark ? "#73c991" : "#3f9f70",
    yellow: palette.highlight,
    brightYellow: dark ? "#ffe08a" : "#b98500",
    blue: palette.accent,
    brightBlue: palette.accentDeep,
    magenta: dark ? "#b285c9" : "#8f5fa8",
    brightMagenta: dark ? "#d2a4ee" : "#a56bc1",
    cyan: dark ? "#56b6c2" : "#2b7f8a",
    brightCyan: dark ? "#7bd7e3" : "#399aa7",
    white: dark ? "#d7dee9" : palette.ink2,
    brightWhite: dark ? "#f6f8fb" : palette.ink,
  };
}

let terminalPaneCounter = 0;
/** Identifies a PANE, not a pty. The pty id is minted inside TerminalPanel. */
function newTerminalPaneId(): string {
  terminalPaneCounter += 1;
  return `term-pane-${terminalPaneCounter}`;
}

function TerminalSessionTab({
  label,
  active,
  onSelect,
  onClose,
  closeLabel,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        padding: "0 2px 0 8px",
        height: 22,
        borderRadius: 5,
        flex: "none",
        background: active ? T.surface : "transparent",
        color: active ? T.ink : T.dim,
        font: `${active ? 600 : 500} 10.5px/1 ${T.mono}`,
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        style={{
          appearance: "none",
          border: "none",
          background: "transparent",
          padding: 0,
          margin: 0,
          cursor: "pointer",
          font: "inherit",
          color: "inherit",
        }}
      >
        {label}
      </button>
      <MiniIconBtn title={closeLabel} size={16} onClick={onClose}>
        <Ic.x width={9} height={9} />
      </MiniIconBtn>
    </span>
  );
}

function newTerminalSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `terminal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parentDirectory(path?: string): string | null {
  if (!path) return null;
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx < 0) return null;
  if (idx === 0) return path.slice(0, 1);
  if (idx === 2 && path[1] === ":") return path.slice(0, 3);
  return path.slice(0, idx);
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function terminalRailMaxWidth(
  appStore: AppStoreApi,
  editorStore: PdfEditorStoreApi,
): number {
  if (typeof window === "undefined") return TERMINAL_RAIL_MAX_WIDTH;
  // Reserve room for everything that is NOT this rail: the document column
  // (tab strip, toolbar with its zoom cluster, a readable page) plus the
  // navigator when it is open. The old constant 420 ignored the navigator,
  // so with it open the rail could squeeze the document column to ~180px
  // and the toolbar's zoom controls scrolled out under the rail's edge —
  // which read as the rail covering them.
  const state = appStore.getState();
  const readerMode = editorStore.getState().readerMode;
  const navigatorWidth =
    state.prefs.showNavigator && !readerMode
      ? // Deliberately clamped with no rail reserve: the navigator's own clamp
        // reserves RAIL_MIN_WIDTH for this rail, and feeding that back in here
        // would make the two ceilings chase each other. The rail reads the
        // navigator's un-reserved ceiling and floors at RAIL_MIN_WIDTH, which
        // is the conservative side of the same budget.
        clampNavigatorWidth(state.prefs.navigatorWidth)
      : 0;
  return Math.max(
    TERMINAL_RAIL_MIN_WIDTH,
    Math.min(
      TERMINAL_RAIL_MAX_WIDTH,
      window.innerWidth - 420 - navigatorWidth,
    ),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function CommentsList({
  notes,
  pages,
  selectedIds,
  now,
  onSelect,
  onEdit,
}: {
  notes: Array<{
    id: string;
    text: string;
    pageId: string;
    createdAt?: number;
    updatedAt?: number;
  }>;
  pages: { id: string }[];
  selectedIds: string[];
  now: number;
  onSelect: (pageId: string, id: string) => void;
  onEdit: (id: string, text: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const relativeLabels = relativeLabelsFor(i18n.resolvedLanguage ?? i18n.language);
  if (notes.length === 0) {
    return (
      <div
        style={{
          padding: "14px 14px",
          color: T.dim,
          font: `12.5px/1.5 ${T.sans}`,
        }}
      >
        {t("rail.commentsEmpty")}
      </div>
    );
  }
  return (
    <div
      style={{
        padding: "4px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {notes.map((c) => {
        const pageIdx = pages.findIndex((p) => p.id === c.pageId);
        const selected = selectedIds.includes(c.id);
        return (
          <div
            key={c.id}
            onClick={() => onSelect(c.pageId, c.id)}
            style={{
              padding: "10px 12px",
              borderRadius: 4,
              background: T.paper,
              border: `1px solid ${selected ? T.ink : T.rule}`,
              cursor: "pointer",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                font: `500 11px/1 ${T.mono}`,
                color: T.dim,
                letterSpacing: ".02em",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              <span>{t("overlays.noteAuthor")}</span>
              <span>
                {t("rail.pagePrefix")}{pageIdx + 1} ·{" "}
                {(() => {
                  const timestamp = noteDisplayTimestamp(c);
                  return timestamp == null
                    ? t("rail.undated")
                    : formatRelative(timestamp, now, relativeLabels);
                })()}
              </span>
            </div>
            {selected ? (
              <textarea
                key={`${c.id}:${c.updatedAt ?? c.createdAt ?? 0}`}
                defaultValue={c.text}
                placeholder={t("overlays.notePlaceholder")}
                onBlur={(e) => {
                  const next = e.currentTarget.value;
                  if (next !== c.text) onEdit(c.id, next);
                }}
                style={{
                  width: "100%",
                  minHeight: 72,
                  border: `1px solid ${T.rule}`,
                  borderRadius: 4,
                  background: T.surface,
                  color: T.ink2,
                  resize: "vertical",
                  outline: "none",
                  padding: 8,
                  font: `13px/1.5 ${T.sans}`,
                }}
              />
            ) : (
              <div style={{ font: `13px/1.5 ${T.sans}`, color: T.ink2 }}>
                {c.text || (
                  <em style={{ color: T.dim }}>
                    {t("overlays.notePlaceholder")}
                  </em>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
