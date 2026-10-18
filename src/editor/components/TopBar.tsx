import { memo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { toast } from "../toast";
import { Ic } from "./icons";
import { IconBtn } from "./ui";
import { k } from "../../platform/keys";
import { ShioriTile } from "../../brand/Mark";
import { CAPABILITIES, IS_ANDROID, IS_IOS, IS_MAC, IS_TABLET } from "../../platform";
import { WINDOW_CAPTION_WIDTH } from "../../platform/windowCaption";
import { useIsMobile, useIsPhone } from "../hooks/useIsMobile";
import { documentIdentityRow } from "./documentIdentityRow";
import { useEditorStore } from "../store/store";
import { recordTabPerfRender } from "../../perf/tabPerf";
import type { DocumentKind } from "../../documents/types";

type Props = {
  documentKind?: DocumentKind;
  fileName: string;
  meta: string;
  onOpenShortcuts: () => void;
  onOpenSettings: () => void;
  onOpen?: () => void;
  onOpenExport?: () => void;
  onToggleOutline?: () => void;
  onToggleThumbs?: () => void;
  navigatorOpen: boolean;
  onToggleTerminal?: () => void;
  onToggleBrowser?: () => void;
  onGoHome?: () => void;
  onFind?: () => void;
  onPrint?: () => void;
  exportNeedsAttention?: boolean;
  exportStatusLabel?: string;
  /**
   * Open workspace tabs. A phone shows either this bar's filename line or
   * the tab strip, never both — see documentIdentityRow. Defaults to the
   * single-document case, which is what a bar rendered outside a workspace
   * is showing.
   */
  tabCount?: number;
};

function MobilePdfControls() {
  const { t } = useTranslation();
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const canUndo = useEditorStore((s) => s.undoStack.length > 0);
  const canRedo = useEditorStore((s) => s.redoStack.length > 0);
  // Undo/redo are annotation controls: while reading there is nothing to
  // undo, and the phone's bar has no room to spare. Tablets keep them at all
  // times — they never enter annotation mode and have the width for both.
  const annotationMode = useEditorStore((s) => s.annotationMode);
  const showHistory = !useIsPhone() || annotationMode;
  const setFitMode = useEditorStore((s) => s.setFitMode);
  const readerMode = useEditorStore((s) => s.readerMode);
  const toggleReaderMode = useEditorStore((s) => s.toggleReaderMode);

  return (
    <>
      {showHistory ? (
        <>
          <IconBtn
            title={t("tooltips.undo")}
            onClick={canUndo ? undo : undefined}
            disabled={!canUndo}
          >
            <Ic.undo />
          </IconBtn>
          <IconBtn
            title={t("tooltips.redo")}
            onClick={canRedo ? redo : undefined}
            disabled={!canRedo}
          >
            <Ic.redo />
          </IconBtn>
        </>
      ) : null}
      {/* A momentary action, not a sticky toggle — see ContextualToolbar. */}
      <IconBtn
        title={t("tooltips.fitWidth")}
        onClick={() => setFitMode("width")}
      >
        <Ic.fit />
      </IconBtn>
      <IconBtn
        title={t("nav.readerMode")}
        active={readerMode}
        onClick={toggleReaderMode}
      >
        <Ic.reader />
      </IconBtn>
    </>
  );
}

// The filename is a real button so the keyboard can copy it, but it must
// keep looking like the title it is: no chrome, inherits the bar's colour,
// and still the one element in the row that yields to an ellipsis.
const FILE_NAME_BUTTON_RESET: CSSProperties = {
  appearance: "none",
  background: "transparent",
  border: "none",
  borderRadius: 3,
  padding: 0,
  margin: 0,
  color: T.ink,
  textAlign: "left",
  cursor: "default",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
};

function TopBarComponent({
  documentKind = "pdf",
  fileName,
  meta,
  onOpenShortcuts,
  onOpenSettings,
  onOpen,
  onOpenExport,
  onToggleOutline,
  onToggleThumbs,
  navigatorOpen,
  onToggleTerminal,
  onToggleBrowser,
  onGoHome,
  onFind,
  onPrint,
  exportNeedsAttention = false,
  exportStatusLabel,
  tabCount = 1,
}: Props) {
  recordTabPerfRender("TopBar");
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  // Tablets are wide enough for the inline (desktop-style) filename; only true
  // phones / narrow windows drop it to a second line. See useIsPhone.
  const isPhone = useIsPhone();
  // On a phone this bar's second line and the tab strip are mutually
  // exclusive: whichever one is naming the document, the other is not shown.
  const identityRow = documentIdentityRow({
    isPhone,
    tabCount,
    hasFileName: fileName.length > 0,
  });
  const isPdf = documentKind === "pdf";
  const copyFileName = () => {
    navigator.clipboard.writeText(fileName).then(
      () => toast.show(t("meta.fileNameCopied")),
      () => toast.error(t("meta.fileNameCopyFailed")),
    );
  };
  // Full name first: when the ellipsis has eaten the middle of a long title
  // the tooltip is the only place the whole thing is readable.
  const copyFileNameTitle = `${fileName}\n${t("meta.copyFileName")}`;
  // Undo / redo / fit-width sit in the TopBar on mobile so the
  // ContextualToolbar can drop its dedicated utility row entirely
  // (otherwise the empty middle of that row was just dead pixels).
  // Reader mode (full-bleed, chrome hidden) has a desktop toggle in the
  // ContextualToolbar and a Cmd+\ shortcut, but neither is reachable on a
  // phone — the ContextualToolbar's utility row is dropped on mobile and
  // there's no hardware modifier key. Surface the same toggle here so the
  // mobile button cluster can ENTER reader mode (exit already has its own
  // floating affordance in App.tsx).
  // With titleBarStyle: "Overlay" on macOS the traffic lights float on top
  // of the webview in the top-left; we reserve ~80px so the Home button
  // doesn't collide with them. `data-tauri-drag-region` makes the bar a
  // drag handle for moving the window — Tauri automatically ignores the
  // gesture on interactive children (buttons, inputs).
  const overlayPadLeft = CAPABILITIES.nativeWindowChrome && IS_MAC;
  const useHorizontalSafeArea =
    isMobile || IS_IOS || CAPABILITIES.mobileDocumentPicker;
  // iOS fills the variable from env(); the Android shell publishes the
  // status bar into it (the WebView sits under the bar edge to edge).
  const safeTop = IS_IOS || IS_ANDROID ? "var(--shiori-safe-top, 0px)" : "0px";
  const safeLeft = useHorizontalSafeArea ? "var(--shiori-safe-left, 0px)" : "0px";
  const safeRight = useHorizontalSafeArea ? "var(--shiori-safe-right, 0px)" : "0px";
  const padLeft = overlayPadLeft
    ? "82px"
    : isMobile
      ? `calc(8px + ${safeLeft})`
      : "16px";
  // Windows draws its caption buttons over the right end of this bar.
  const captionPad = CAPABILITIES.customWindowCaption ? WINDOW_CAPTION_WIDTH : 0;
  const padRight = isMobile
    ? `calc(${8 + captionPad}px + ${safeRight})`
    : `${14 + captionPad}px`;
  return (
    <div
      data-tauri-drag-region
      className="shioriPrintHide"
      style={{
        borderBottom: `1px solid ${T.rule}`,
        background: T.cream,
        flex: "0 0 auto",
        boxSizing: "border-box",
        // The bar doubles as the window drag region; without this a drag
        // sweeps a text selection across the filename and meta labels.
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      <div
        data-tauri-drag-region
        className={isMobile ? "shioriTouchScroll" : undefined}
        style={{
          height: `calc(48px + ${safeTop})`,
          display: "flex",
          alignItems: "center",
          // Mobile crams 11 fixed-width controls + the logo into a ~360 px
          // viewport, so we squeeze the inter-button gap to 2 px (vs. 12 on
          // desktop) and trim the side padding. Even then the row can exceed a
          // small phone's width (long zh/ja tooltips don't widen it, but the
          // safe-area insets and the sheer control count do), so on compact
          // viewports the row scrolls horizontally instead of clipping the
          // rightmost button. The primary actions (find / settings / Export)
          // stay pinned at the right edge via the sticky cluster below, so they
          // are always reachable without scrolling.
          gap: isMobile ? 2 : 12,
          padding: `${safeTop} ${padRight} 0 ${padLeft}`,
          boxSizing: "border-box",
          overflowX: isMobile ? "auto" : undefined,
          flexWrap: "nowrap",
        }}
      >
      <button
        type="button"
        onClick={onGoHome}
        disabled={!onGoHome}
        title={t("nav.home")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginRight: 6,
          background: "transparent",
          border: "none",
          padding: "4px 6px",
          borderRadius: 6,
          cursor: onGoHome ? "pointer" : "default",
          color: T.ink,
          font: "inherit",
        }}
        onMouseEnter={(e) => {
          if (onGoHome) e.currentTarget.style.background = T.tint;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <ShioriTile size={24} radius={0.22} title={t("app.brand")} />
        {/* Brand wordmark is a 8-char serif glyph that visually pads
            the home button. On a phone every pixel of the topbar is
            premium real estate, so we drop the wordmark and keep the
            tile alone — it still reads as "home" and the icon is
            distinctive enough to brand the screen. */}
        {isMobile ? null : (
          <span
            style={{
              fontFamily: T.klee,
              fontWeight: 600,
              fontSize: 17.5,
              lineHeight: 1,
              color: T.ink,
              letterSpacing: "-.005em",
            }}
          >
            {t("app.brand")}
          </span>
        )}
      </button>

      {isMobile ? null : (
        <div style={{ width: 1, height: 18, background: T.rule, margin: "0 4px" }} />
      )}

      {/* One button for the whole left gutter. Which view it shows is the
          icon rail's job now, so the top bar no longer needs a button per
          panel — it had two, one of which shared the rail's icon. */}
      <IconBtn
        title={
          isMobile
            ? t("nav.thumbnails")
            : navigatorOpen
              ? t("navigator.collapse")
              : t("navigator.show")
        }
        aria-label={
          isMobile
            ? t("nav.thumbnails")
            : navigatorOpen
              ? t("navigator.collapse")
              : t("navigator.show")
        }
        aria-expanded={navigatorOpen}
        aria-controls={isMobile ? undefined : "shiori-left-navigator"}
        onClick={onToggleThumbs}
        disabled={!onToggleThumbs}
      >
        {navigatorOpen ? <Ic.navigatorClose /> : <Ic.navigatorOpen />}
      </IconBtn>
      {/* Mobile has no icon rail (no gutter for one), so the outline is still
          only reachable through the right rail — and only through this. */}
      {isPdf && isMobile && onToggleOutline ? (
        <IconBtn title={t("nav.outline")} onClick={onToggleOutline}>
          <Ic.outline />
        </IconBtn>
      ) : null}
      {onToggleTerminal && !isMobile ? (
        <IconBtn title={t("nav.terminal")} onClick={onToggleTerminal}>
          <Ic.terminal />
        </IconBtn>
      ) : null}
      {onToggleBrowser && (!isMobile || IS_TABLET) ? (
        <IconBtn title={t("nav.browser")} onClick={onToggleBrowser}>
          <Ic.globe />
        </IconBtn>
      ) : null}

      {isPdf && isMobile ? <MobilePdfControls /> : null}

      {/* Tauri 2.10 only starts a native drag when the exact event target has
          the attribute. Mark the nested flex boxes too, otherwise their empty
          gutters turn into ordinary web content even though the bar is marked. */}
      <div
        data-tauri-drag-region
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          minWidth: 0,
        }}
      >
        {/* Filename + meta only fit inline on desktop. On mobile the
            button row leaves no horizontal room, so the same info moves
            to a slim second line below (rendered after this row). */}
        {isPhone ? null : (
          <div
            data-tauri-drag-region
            style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}
          >
            <button
              // Selection stays off for the whole bar (a selectable island
              // still gets swept up by drags starting next to it), so copying
              // the filename is an explicit action. A button rather than a
              // double-click span: it is focusable, Enter/Space fire the same
              // handler, and the tooltip carries the full name when the
              // ellipsis has eaten part of it.
              type="button"
              title={copyFileNameTitle}
              onClick={copyFileName}
              style={{
                ...FILE_NAME_BUTTON_RESET,
                font: `500 15.5px/1.28 ${T.sans}`,
                // The filename is the ONLY thing here that gives way. A fixed
                // max-width plus a shrinkable meta had it backwards: the meta
                // wrapped to two lines first, grew the row, and squeezed the
                // name that had room to spare.
                flex: "1 1 auto",
              }}
            >
              {fileName}
            </button>
            <span
              style={{
                font: `10.5px/1.2 ${T.mono}`,
                color: T.dim,
                letterSpacing: ".04em",
                // "17 页 · 4.0 MB" is 14 characters; it never earns a second
                // line, and wrapping it is what pushed the filename around.
                flex: "0 0 auto",
                whiteSpace: "nowrap",
              }}
            >
              {meta}
            </span>
          </div>
        )}
      </div>

      {/* Primary actions. On compact viewports the row above scrolls, so this
          cluster sticks to the right edge and floats over the scrolling tools
          (opaque bar-colored background + a soft left fade) to stay reachable.
          On desktop it's display:contents — a layout no-op — so the wide bar is
          unchanged. */}
      <div
        style={
          isMobile
            ? {
                position: "sticky",
                right: 0,
                flex: "0 0 auto",
                display: "flex",
                alignItems: "center",
                gap: 2,
                background: T.cream,
                paddingLeft: 6,
                boxShadow: `-10px 0 8px -6px ${T.cream}`,
              }
            : { display: "contents" }
        }
      >
      {onFind ? (
        <IconBtn title={k(t("tooltips.find"))} onClick={onFind}>
          <Ic.search />
        </IconBtn>
      ) : null}
      {onOpen ? (
        <IconBtn title={t("tabs.new")} onClick={onOpen}>
          <Ic.plus />
        </IconBtn>
      ) : null}
      {isMobile ? null : (
        <IconBtn title={t("nav.shortcuts")} onClick={onOpenShortcuts}>
          <Ic.kbd />
        </IconBtn>
      )}
      <IconBtn title={t("nav.settings")} onClick={onOpenSettings}>
        <Ic.settings />
      </IconBtn>
      {isMobile ? null : (
        <IconBtn
          title={k(t("nav.print"))}
          onClick={onPrint}
          disabled={!onPrint}
        >
          <Ic.printer />
        </IconBtn>
      )}
      <>
          {isMobile ? null : (
            <div
              style={{
                width: 1,
                height: 18,
                background: T.rule,
                margin: "0 4px",
              }}
            />
          )}
          <IconBtn
            tone="primary"
            onClick={onOpenExport}
            disabled={!onOpenExport}
            title={exportStatusLabel ?? t("nav.exportPdf")}
          >
            <Ic.download />
            {exportNeedsAttention ? (
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "#f4d674",
                  boxShadow: "0 0 0 1px rgba(20,16,10,0.22)",
                  marginLeft: isMobile ? 0 : -2,
                }}
              />
            ) : null}
            {isMobile ? null : <span>{t("nav.export")}</span>}
          </IconBtn>
      </>
      </div>
      </div>
      {identityRow === "fileName" ? (
        <div
          data-shiori-file-name-row
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "center",
            gap: 8,
            padding: `0 calc(12px + ${safeRight}) 5px calc(12px + ${safeLeft})`,
            minWidth: 0,
          }}
        >
          <button
            type="button"
            title={copyFileNameTitle}
            onClick={copyFileName}
            style={{
              ...FILE_NAME_BUTTON_RESET,
              font: `500 12px/1.28 ${T.sans}`,
            }}
          >
            {fileName}
          </button>
          <span
            style={{
              font: `10px/1.2 ${T.mono}`,
              color: T.dim,
              letterSpacing: ".04em",
              whiteSpace: "nowrap",
            }}
          >
            {meta}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export const TopBar = memo(TopBarComponent);
