import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { DocumentList, type DocumentTreeItem } from "./DocumentTree";
import { Thumbnails } from "./Thumbnails";
import { OutlinePanel } from "./OutlinePanel";
import { MarksList } from "./MarksList";
import { useAppStore } from "../store/store";
import type { PdfDocument } from "../../pdf/engine/types";
import type { DocumentTreeAnchor } from "./documentTreeAnchors";
import { CAPABILITIES, type FolderEntry } from "../../platform";
import {
  clampNavigatorWidth,
  HEADER_BAND_HEIGHT,
  NAVIGATOR_DEFAULT_WIDTH,
  NAVIGATOR_MIN_WIDTH,
  type NavigatorView,
} from "./navigatorLayout";
import { recordTabPerfRender } from "../../perf/tabPerf";
import type { DocumentPreviewData } from "./documentPreview";

// The one Add control never asks the reader to classify what they are
// opening — the app does that, from the same authoritative classifier that
// drag-drop and file associations use. But only macOS can return both kinds
// from a single native dialog, so on Windows, Linux and the web the click
// route really is documents-only and the label has to say so. Folders still
// arrive there by drag-drop, file association, and argv.
const addTargetLabelKey = CAPABILITIES.mixedFileFolderPicker
  ? "documentTree.addTarget"
  : "documentTree.addDocument";

/**
 * One panel in the left gutter, several scales of the same question: which
 * document, and which page inside it.
 *
 * Before this, "where am I" was answered by three separate surfaces — the
 * thumbnails panel on the left, the document tree next to it, and the PDF
 * outline over in the right rail — each with its own toggle in the top bar,
 * two of which shared an icon. Splitting one question across three panels on
 * two edges of the screen is what made the window feel crowded; the panels
 * themselves were each fine.
 *
 * The right rail keeps what it is actually for: what you are *doing*
 * (terminal, browser), not where you are.
 */

// The view switcher, formerly a 44px icon rail of its own. A whole column
// whose payload was four 32px buttons — and for a text document, one button
// and three ghosts — while the header band above the tree sat mostly empty
// announcing "工作区" (the default section introducing itself). The icons
// now live in that band; the rail column is gone.
const VIEWS: ReadonlyArray<{
  view: NavigatorView;
  icon: keyof typeof Ic;
  labelKey: string;
  /** Views that read the open PDF; kept visible but disabled otherwise. */
  needsPdf?: boolean;
}> = [
  // Each view has its own glyph. These four used to borrow from the
  // thumbnail drawer, the top bar's outline toggle, the fit-page control and
  // the callout tool, so a navigator button and a tool button were the same
  // picture — the reader had no way to tell "go here" from "do this".
  { view: "documents", icon: "viewDocuments", labelKey: "navigator.documents" },
  { view: "outline", icon: "viewOutline", labelKey: "navigator.outline", needsPdf: true },
  { view: "pages", icon: "viewPages", labelKey: "navigator.pages", needsPdf: true },
  { view: "marks", icon: "viewMarks", labelKey: "navigator.marks", needsPdf: true },
];

export type LeftNavigatorProps = {
  view: NavigatorView;
  /** Only the marks link inside the documents view still switches views. */
  onViewChange: (view: NavigatorView) => void;
  /** Band icons: picking the view already showing means "close the panel". */
  onPickView: (view: NavigatorView) => void;
  hasPdf: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  /**
   * Width the right rail is holding as an in-flow column, so a drag here
   * stops where the document column still has room. Without it the gutter
   * could be dragged to its own ceiling while the rail refused to shrink
   * past its floor, and the page between them was left with 60px.
   */
  railReservePx?: number;
  /** Documents view. */
  items: DocumentTreeItem[];
  activeTabId: string | null;
  anchors: DocumentTreeAnchor[];
  onSelect: (id: string) => void;
  onPreviewRequest?: (id: string) => Promise<DocumentPreviewData | null>;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
  onOpenAnchor: (anchor: DocumentTreeAnchor) => void;
  folderPaths: readonly string[];
  activePath?: string;
  onUnmountFolder: (path: string) => void;
  onOpenFolderFile: (entry: FolderEntry) => void;
  selectedIds: readonly string[];
  /** Opens one platform picker; the intake layer decides file vs folder. */
  onNew: () => void;
  /** Pages view. Null for a text document — it has no pages to show. */
  doc: PdfDocument | null;
  pdfInsertionBusy?: boolean;
  onInsertPdfPages: (afterPageId: string | null) => void;
};

function LeftNavigatorComponent({
  view,
  onViewChange,
  onPickView,
  hasPdf,
  width,
  onWidthChange,
  railReservePx = 0,
  items,
  activeTabId,
  anchors,
  onSelect,
  onPreviewRequest,
  onClose,
  onTogglePin,
  onOpenAnchor,
  folderPaths,
  activePath,
  onUnmountFolder,
  onOpenFolderFile,
  selectedIds,
  onNew,
  doc,
  pdfInsertionBusy = false,
  onInsertPdfPages,
}: LeftNavigatorProps) {
  recordTabPerfRender("LeftNavigator");
  const { t } = useTranslation();
  const navRef = useRef<HTMLElement | null>(null);
  const [drag, setDrag] = useState<{
    startX: number;
    startWidth: number;
  } | null>(null);
  // The dragged width is local until the pointer is released. Committing on
  // every pointermove wrote the preference to localStorage once per pixel,
  // which made the drag stutter and snap back — it felt broken, and it was.
  //
  // Mid-drag the width bypasses React entirely: each frame writes the
  // element's style directly, so the browser does layout and nothing else.
  // Any per-frame setState re-rendered this whole panel (file tree,
  // thumbnails) and stalled long enough for the pointer to visibly outrun
  // the pane — React is for the committed width, not the live one.
  useEffect(() => {
    if (!drag) return;
    // Freeze the document column's expensive reactions (fit-scale, canvas
    // re-measure) for the duration; the one deferred update settles them
    // when the drag ends.
    useAppStore.getState().setChromeResizing(true);
    let frame: number | null = null;
    let pendingX = drag.startX;
    const widthAt = (clientX: number) =>
      clampNavigatorWidth(
        drag.startWidth + (clientX - drag.startX),
        railReservePx,
      );
    const apply = () => {
      frame = null;
      const el = navRef.current;
      if (!el) return;
      const next = widthAt(pendingX);
      el.style.width = `${next}px`;
      el.style.flex = `0 0 ${next}px`;
    };
    const onMove = (event: PointerEvent) => {
      pendingX = event.clientX;
      if (frame == null) frame = window.requestAnimationFrame(apply);
    };
    const onUp = () => {
      // Persist once, at the end, and only if the width actually moved.
      const final = widthAt(pendingX);
      if (final !== width) onWidthChange(final);
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      useAppStore.getState().setChromeResizing(false);
    };
  }, [drag, onWidthChange, width, railReservePx]);

  // A text document has no pages, so the pages view would be an empty panel
  // with a live-looking tab. Fall back rather than offer a dead end.
  const effectiveView: NavigatorView = doc ? view : "documents";

  return (
    <nav
      id="shiori-left-navigator"
      ref={navRef}
      className="shioriPrintHide"
      aria-label={t("navigator.label")}
      style={{
        width,
        flex: `0 0 ${width}px`,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderRight: `1px solid ${T.rule}`,
        background: T.cream,
        userSelect: "none",
        WebkitUserSelect: "none",
        position: "relative",
      }}
    >
      {/* Drag handle on the panel's own edge. A file name is as long as it is;
          a fixed gutter width means the reader either lives with an ellipsis or
          gives up the page. Four pixels wide, invisible until grabbed. */}
      <div
        onPointerDown={(event) => {
          event.preventDefault();
          // Capture, so the drag survives the pointer crossing into the page
          // canvas — which owns pointer handlers of its own.
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({
            startX: event.clientX,
            startWidth: width,
          });
        }}
        onDoubleClick={() => onWidthChange(NAVIGATOR_DEFAULT_WIDTH)}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("navigator.resize")}
        // With no explicit bounds the implicit ARIA range is 0–100, and a
        // width of 236 announces as out of range. The bounds are the ones the
        // clamp enforces — asked for with a large finite number, because
        // clampNavigatorWidth answers a non-finite width with the DEFAULT
        // width, which would put valuemax below values the reader can reach.
        aria-valuemin={NAVIGATOR_MIN_WIDTH}
        aria-valuemax={clampNavigatorWidth(Number.MAX_SAFE_INTEGER, railReservePx)}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        // Pointer-only, this handle put a truncated file name permanently out
        // of a keyboard reader's reach: every row around it is focusable, but
        // the one control that makes the names legible was not.
        onKeyDown={(event) => {
          const step = event.shiftKey ? 64 : 16;
          const next =
            event.key === "ArrowRight"
              ? width + step
              : event.key === "ArrowLeft"
                ? width - step
                : event.key === "Home"
                  ? width + 1e4
                  : event.key === "End"
                    ? 0
                    : event.key === "Enter"
                      ? NAVIGATOR_DEFAULT_WIDTH
                      : null;
          if (next === null) return;
          event.preventDefault();
          onWidthChange(clampNavigatorWidth(next, railReservePx));
        }}
        title={t("navigator.resize")}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: -2,
          width: 5,
          cursor: "col-resize",
          background: drag ? T.accentSoft : "transparent",
          zIndex: 5,
        }}
      />
      {/* This column's slice of the header band. It carries the first
          section's name rather than the view's: the icon rail already says
          which view is open, and the documents view used to print "Workspace"
          again eight pixels below this line. Merging them fills a band that
          was otherwise an empty forty-pixel strip with one button in it.

          The band stays even when it has little to hold — its height is what
          joins this column's bottom border to the tab strip's and the right
          rail's. */}
      <div
        style={{
          height: HEADER_BAND_HEIGHT,
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 6px 0 10px",
          borderBottom: `1px solid ${T.rule}`,
          flex: "0 0 auto",
        }}
      >
        {/* No title. "工作区" was the default section introducing itself,
            and the other views' names repeat what the active icon already
            says. The band holds the switcher instead — the space works. */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 2 }}>
          {VIEWS.map((entry) => {
            const Icon = Ic[entry.icon];
            const disabled = Boolean(entry.needsPdf && !hasPdf);
            const active = !disabled && effectiveView === entry.view;
            const label = t(entry.labelKey);
            return (
              <button
                key={entry.view}
                type="button"
                aria-pressed={active}
                disabled={disabled}
                title={label}
                aria-label={label}
                onClick={() => onPickView(entry.view)}
                style={{
                  // These four are the navigator's whole switcher, and they
                  // sit alone in a 40px band — at 28/16 they read as
                  // afterthoughts next to the tree they control.
                  width: 30,
                  height: 30,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  appearance: "none",
                  border: "none",
                  borderRadius: 6,
                  padding: 0,
                  cursor: disabled ? "default" : "pointer",
                  background: active ? T.accentSoft : "transparent",
                  color: disabled ? T.dim : active ? T.accentText : T.ink2,
                }}
              >
                <Icon width={20} height={20} />
              </button>
            );
          })}
        </div>
        {effectiveView === "documents" ? (
          <button
            type="button"
            title={t(addTargetLabelKey)}
            aria-label={t(addTargetLabelKey)}
            onClick={onNew}
            style={{
              width: 26,
              height: 26,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              appearance: "none",
              border: "none",
              borderRadius: 4,
              padding: 0,
              cursor: "pointer",
              background: "transparent",
              color: T.ink2,
            }}
          >
            <Ic.plus width={16} height={16} />
          </button>
        ) : null}
      </div>
      {effectiveView === "documents" ? (
        <DocumentList
          items={items}
          activeTabId={activeTabId}
          markCount={anchors.length}
          onSelect={onSelect}
          onPreviewRequest={onPreviewRequest}
          onClose={onClose}
          onTogglePin={onTogglePin}
          onShowMarks={() => onViewChange("marks")}
          folderPaths={folderPaths}
          activePath={activePath}
          onUnmountFolder={onUnmountFolder}
          onOpenFolderFile={onOpenFolderFile}
        />
      ) : effectiveView === "marks" ? (
        <MarksList
          anchors={anchors}
          selectedIds={selectedIds}
          onOpen={onOpenAnchor}
        />
      ) : effectiveView === "outline" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 4px 16px" }}>
          <OutlinePanel doc={doc} />
        </div>
      ) : doc ? (
        // Keyed by document: the thumbnail renderer holds per-page canvases
        // and scroll position, neither of which survives a document swap.
        <Thumbnails
          key={activeTabId ?? "doc"}
          doc={doc}
          embedded
          pdfInsertionBusy={pdfInsertionBusy}
          onInsertPdfPages={onInsertPdfPages}
        />
      ) : null}
    </nav>
  );
}

export const LeftNavigator = memo(LeftNavigatorComponent);
