import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  documentKindShortLabel,
  type DocumentKind,
} from "../../documents/types";
import {
  documentTreeFolder,
  isPathInsideFolder,
} from "./documentTreeAnchors";
import { RowPreview } from "./RowPreview";
import { FolderTree } from "./FolderTree";
import type { FolderEntry } from "../../platform";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { MiniIconBtn } from "./ui";
import type {
  RowPreviewAnchor,
  RowPreviewPlacement,
} from "./RowPreview";
import {
  hasDocumentPreviewVisual,
  type DocumentPreviewData,
} from "./documentPreview";

/**
 * The left navigator's "documents" view: the documents you are actually
 * reading, flat and ordered by recency. Content only — LeftNavigator owns the
 * panel chrome, and the marks themselves have their own view.
 *
 * It answers the question TabStrip cannot: past five or six files a
 * horizontal row of equal chips stops being navigable, and it never had room
 * for what is *inside* a document.
 *
 * Deliberately NOT a file manager. Entries are references to open documents;
 * mounting a disk directory is a separate view (P1c) with its own Rust IPC.
 *
 * One line per document, following Obsidian's tree: the title takes the full
 * width, the kind sits at the right edge so every title starts in the same
 * column, and the active row is a tint with no bar and no border. Provenance
 * (the folder) is a tooltip until the document area grows a breadcrumb.
 */

/**
 * Width held for the kind label plus the pin and close buttons, whether or not
 * those buttons are currently visible. See the note at the reserved block.
 */
const RIGHT_CONTROLS_WIDTH = 74;

export type DocumentTreeItem = {
  id: string;
  kind: DocumentKind;
  title: string;
  /** Full path; shown as its folder name only, and as the row's tooltip. */
  path?: string;
  unavailable?: boolean;
  /** Explicitly kept — decides which section the row lands in. */
  pinned?: boolean;
};

type Props = {
  items: DocumentTreeItem[];
  activeTabId: string | null;
  /** How many readable marks the ACTIVE document has — a number, not a list. */
  markCount: number;
  onSelect: (id: string) => void;
  onPreviewRequest?: (id: string) => Promise<DocumentPreviewData | null>;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
  /** Jump to the marks view; the count is the link to it. */
  onShowMarks: () => void;
  /** Absolute paths of every mounted workspace root. */
  folderPaths: readonly string[];
  /** Path of the document being read, so the tree can highlight its row. */
  activePath?: string;
  onUnmountFolder: (path: string) => void;
  onOpenFolderFile: (entry: FolderEntry) => void;
};

/**
 * Scroll offset of the documents list, kept outside React because the element
 * it belongs to is unmounted and rebuilt rather than hidden. One list is ever
 * on screen, so one value is the whole state.
 */
let lastListScrollTop = 0;

type WorkspacePreview = {
  heading: string;
  body: string;
  note?: string;
  tabId?: string;
  anchor: RowPreviewAnchor;
  placement: RowPreviewPlacement;
};

/** Keep the card behind whichever vertical motion the reader just made. */
function placementAwayFromVerticalMotion(
  deltaY: number,
  fallback: RowPreviewPlacement,
): RowPreviewPlacement {
  if (deltaY > 0) return "above";
  if (deltaY < 0) return "below";
  return fallback;
}

export function DocumentList({
  items,
  activeTabId,
  markCount,
  onSelect,
  onPreviewRequest,
  onClose,
  onTogglePin,
  onShowMarks,
  folderPaths,
  activePath,
  onUnmountFolder,
  onOpenFolderFile,
}: Props) {
  const { t } = useTranslation();
  // The navigator swaps this list out for thumbnails or the outline whenever
  // the active document changes what it can show, so the scroll box is
  // remounted rather than merely re-rendered — and a remounted box starts at
  // the top. Opening the fourth file down a long folder and being thrown back
  // to the first one is disorienting in a way that has nothing to do with the
  // file that was opened, so the offset outlives the mount.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const observedScrollTopRef = useRef(lastListScrollTop);
  const placementRef = useRef<RowPreviewPlacement>("auto");
  const documentPreviewTimerRef = useRef<number | null>(null);
  const documentPreviewRequestRef = useRef(0);
  const documentPreviewIntentRef = useRef<string | null>(null);
  const [preview, setPreview] = useState<WorkspacePreview | null>(null);
  const [documentPreview, setDocumentPreview] = useState<{
    tabId: string;
    data: DocumentPreviewData;
  } | null>(null);

  const clearDocumentPreview = () => {
    if (documentPreviewTimerRef.current !== null) {
      window.clearTimeout(documentPreviewTimerRef.current);
      documentPreviewTimerRef.current = null;
    }
    documentPreviewRequestRef.current += 1;
    documentPreviewIntentRef.current = null;
    setDocumentPreview(null);
  };

  const showDocumentPreview = (tabId: string, immediate: boolean) => {
    const request = () => {
      documentPreviewTimerRef.current = null;
      if (
        documentPreviewIntentRef.current !== tabId ||
        !onPreviewRequest
      ) {
        return;
      }
      const requestId = ++documentPreviewRequestRef.current;
      void onPreviewRequest(tabId)
        .then((data) => {
          if (
            requestId === documentPreviewRequestRef.current &&
            documentPreviewIntentRef.current === tabId
          ) {
            setDocumentPreview(
              hasDocumentPreviewVisual(data) ? { tabId, data } : null,
            );
          }
        })
        .catch(() => {
          // A derived preview must never make document navigation fail.
          if (requestId === documentPreviewRequestRef.current) {
            setDocumentPreview(null);
          }
        });
    };

    if (documentPreviewIntentRef.current === tabId) {
      if (immediate && documentPreviewTimerRef.current !== null) {
        window.clearTimeout(documentPreviewTimerRef.current);
        request();
      }
      return;
    }
    clearDocumentPreview();
    if (!onPreviewRequest) return;
    documentPreviewIntentRef.current = tabId;
    if (immediate) request();
    else documentPreviewTimerRef.current = window.setTimeout(request, 300);
  };

  useEffect(
    () => () => {
      if (documentPreviewTimerRef.current !== null) {
        window.clearTimeout(documentPreviewTimerRef.current);
      }
      documentPreviewRequestRef.current += 1;
    },
    [],
  );

  const showPreviewForRow = (
    row: HTMLElement | null,
    pointerY: number | null,
    placement: RowPreviewPlacement,
  ) => {
    const box = scrollRef.current;
    if (!row || !box?.contains(row)) {
      clearDocumentPreview();
      setPreview(null);
      return;
    }
    const { workspacePreviewBody: body } = row.dataset;
    if (!body) {
      clearDocumentPreview();
      setPreview(null);
      return;
    }
    const tabId = row.dataset.workspacePreviewTabId;
    if (tabId) showDocumentPreview(tabId, pointerY === null);
    else clearDocumentPreview();
    const rect = row.getBoundingClientRect();
    setPreview({
      heading: row.dataset.workspacePreviewHeading ?? "",
      body,
      note: row.dataset.workspacePreviewNote || undefined,
      tabId,
      // During scroll, anchor vertically to the stationary pointer instead of
      // a row rect that is moving underneath it. Focus keeps the full row.
      anchor:
        pointerY === null
          ? rect
          : { left: rect.left, top: pointerY, bottom: pointerY },
      placement,
    });
  };

  const rowFromTarget = (target: EventTarget | null) => {
    // The test DOM does not install the browser's global `Element`
    // constructor, so feature-detect the one operation we need instead of
    // relying on instanceof across realms.
    const element = target as Element | null;
    return typeof element?.closest === "function"
      ? element.closest<HTMLElement>("[data-workspace-preview-id]")
      : null;
  };

  const syncPreviewAtPointer = (placement: RowPreviewPlacement) => {
    const pointer = pointerRef.current;
    if (!pointer || typeof document.elementFromPoint !== "function") return;
    showPreviewForRow(
      rowFromTarget(document.elementFromPoint(pointer.x, pointer.y)),
      pointer.y,
      placement,
    );
  };

  const rememberScroll = () => {
    const box = scrollRef.current;
    if (!box) return;
    const nextScrollTop = box.scrollTop;
    const previousScrollTop = observedScrollTopRef.current;
    if (nextScrollTop !== previousScrollTop) {
      const placement = placementAwayFromVerticalMotion(
        previousScrollTop - nextScrollTop,
        placementRef.current,
      );
      placementRef.current = placement;
      observedScrollTopRef.current = nextScrollTop;
      lastListScrollTop = nextScrollTop;
      // Scrolling does not reliably emit mouseenter/mouseleave for rows that
      // move underneath a stationary pointer. Re-hit-test now, in the scroll
      // event, so the filename changes with the visible row rather than after
      // the reader next wiggles the mouse. Match the visible content motion:
      // content moving down puts the card above the pointer; content moving
      // up puts it below, so the area being revealed stays unobstructed.
      syncPreviewAtPointer(placement);
    }
  };
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box || lastListScrollTop === 0) return;
    // Before paint: restoring in a plain effect shows one frame at the top.
    box.scrollTop = lastListScrollTop;
    observedScrollTopRef.current = box.scrollTop;
  }, []);
  // Two sections, one rule: pinned or not. "Workspace" is what you decided you
  // are working on; "unfiled" is everything you merely opened. Nothing moves
  // between them on its own.
  // A file inside the mounted folder is already in the workspace by being
  // there — listing it again under "unfiled" would double it. Membership is
  // derived from the path, so there is no second copy of the truth to keep in
  // sync. The pin covers the other case: a file you want kept that lives
  // somewhere else entirely.
  const insideFolder = (item: DocumentTreeItem) =>
    folderPaths.some((folderPath) => isPathInsideFolder(item.path, folderPath));
  const pinned = items.filter((item) => item.pinned && !insideFolder(item));
  const unfiled = items.filter(
    (item) => !item.pinned && !insideFolder(item),
  );
  const previewTabIdsByPath = useMemo(
    () =>
      new Map(
        items.flatMap((item) =>
          item.path ? ([[item.path, item.id]] as const) : [],
        ),
      ),
    [items],
  );
  const renderRow = (item: DocumentTreeItem) => (
    <DocumentRow
      key={item.id}
      item={item}
      active={item.id === activeTabId}
      markCount={item.id === activeTabId ? markCount : 0}
      onSelect={onSelect}
      onClose={onClose}
      onTogglePin={onTogglePin}
      onShowMarks={onShowMarks}
      t={t}
    />
  );
  const visualPreview =
    preview?.tabId && documentPreview?.tabId === preview.tabId
      ? documentPreview.data
      : null;
  const zoom = visualPreview?.scale
    ? `${Math.round(visualPreview.scale * 100)}%`
    : undefined;
  const previewDetail = visualPreview?.pageNumber
    ? t("tabs.previewPage", {
        page: visualPreview.pageNumber,
        zoom: zoom ?? "—",
      })
    : zoom
      ? t("tabs.previewPosition", { zoom })
      : undefined;
  return (
    <div
      ref={scrollRef}
      className="shioriWorkspaceRail"
      onScroll={rememberScroll}
      onMouseMove={(event) => {
        const previousPointer = pointerRef.current;
        const placement = previousPointer
          ? placementAwayFromVerticalMotion(
              event.clientY - previousPointer.y,
              placementRef.current,
            )
          : placementRef.current;
        placementRef.current = placement;
        pointerRef.current = { x: event.clientX, y: event.clientY };
        showPreviewForRow(
          rowFromTarget(event.target),
          event.clientY,
          placement,
        );
      }}
      onMouseLeave={() => {
        pointerRef.current = null;
        placementRef.current = "auto";
        clearDocumentPreview();
        setPreview(null);
      }}
      onFocusCapture={(event) => {
        showPreviewForRow(rowFromTarget(event.target), null, "auto");
      }}
      onBlurCapture={(event) => {
        if (rowFromTarget(event.relatedTarget)) return;
        clearDocumentPreview();
        setPreview(null);
      }}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        // Keep filenames out from under macOS' overlay scrollbar. The gutter
        // also stops the usable row width changing when the OS switches from
        // an overlay thumb to a mouse-draggable one.
        scrollbarGutter: "stable",
        padding: "4px 4px 4px 0",
      }}
    >
      {/* WORKSPACE — mounted folders, plus anything pinned from outside them.
          Its name lives in the header band above, not in a row of its own. */}
      {folderPaths.map((folderPath) => (
        <FolderTree
          key={folderPath}
          path={folderPath}
          activePath={activePath}
          previewTabIdsByPath={previewTabIdsByPath}
          onOpenFile={onOpenFolderFile}
          onUnmount={() => onUnmountFolder(folderPath)}
        />
      ))}
      {pinned.map(renderRow)}

      {/* UNFILED — opened, but not part of the folder and not pinned. */}
      {unfiled.length > 0 ? (
        <>
          <SectionLabel text={t("documentTree.sectionUnfiled")} />
          {unfiled.map(renderRow)}
        </>
      ) : null}
      {preview ? (
        <RowPreview
          id="workspace-row-preview"
          heading={preview.heading}
          body={preview.body}
          note={preview.note}
          documentPreview={visualPreview}
          previewDetail={previewDetail}
          anchor={preview.anchor}
          placement={preview.placement}
        />
      ) : null}
    </div>
  );
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "9px 10px 3px",
        font: `600 9px/1.4 ${T.mono}`,
        letterSpacing: ".09em",
        textTransform: "uppercase",
        color: T.dim,
      }}
    >
      {text}
    </div>
  );
}

function DocumentRow({
  item,
  active,
  markCount,
  onSelect,
  onClose,
  onTogglePin,
  onShowMarks,
  t,
}: {
  item: DocumentTreeItem;
  active: boolean;
  markCount: number;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onTogglePin: (id: string) => void;
  onShowMarks: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [engaged, setEngaged] = useState(false);
  const folder = documentTreeFolder(item.path);
  const previewHeading = [
    documentKindShortLabel(item.kind),
    item.unavailable ? t("documentTree.unavailable") : null,
    folder,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={() => {
        setEngaged(true);
      }}
      onMouseLeave={() => setEngaged(false)}
      // Focus, not just hover: the close button has to be reachable by
      // keyboard, and it cannot be reachable while it is invisible.
      onFocus={() => {
        setEngaged(true);
      }}
      onBlur={() => setEngaged(false)}
    >
      <div
        role="button"
        tabIndex={0}
        aria-current={active}
        aria-describedby="workspace-row-preview"
        data-workspace-preview-id={item.id}
        data-workspace-preview-tab-id={item.id}
        data-workspace-preview-heading={previewHeading}
        data-workspace-preview-body={item.title}
        data-workspace-preview-note={
          item.path && item.path !== item.title ? item.path : undefined
        }
        onClick={() => onSelect(item.id)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onSelect(item.id);
        }}
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          alignItems: "baseline",
          gap: 8,
          // Same insets as the folder tree's rows, so the tinted highlight and
          // the kind label line up between the two lists in this one panel.
          padding: "5px 7px 5px 8px",
          margin: "0 4px",
          borderRadius: 5,
          cursor: "pointer",
          // An inset tint, not a full-bleed band. Spanning the panel edge to
          // edge made the active row read as a divider slicing the list in
          // two; inset with a small radius it reads as one row, highlighted.
          background: active ? T.accentSoft : engaged ? T.paper : "transparent",
          color: item.unavailable ? T.dim : T.ink,
        }}
      >
        <span
          style={{
            minWidth: 0,
            font: `${active ? 600 : 500} 12.5px/1.55 ${T.sans}`,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.title}
        </span>
        <span
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 5,
            flex: "none",
            // Reserved, not grown on hover. When the pin and close buttons
            // appeared only while hovering, they pushed the kind label left and
            // re-truncated the title under the pointer — the row changed shape
            // exactly as the reader tried to read it.
            width: RIGHT_CONTROLS_WIDTH,
          }}
        >
          {/* The marks live in their own view; here they are one number that
              links to it. The list used to hang under this row, where seven
              of them buried every other document. */}
          {markCount > 0 ? (
            <button
              type="button"
              title={t("navigator.showMarks")}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(item.id);
                onShowMarks();
              }}
              style={{
                appearance: "none",
                border: "none",
                background: "transparent",
                padding: 0,
                margin: 0,
                cursor: "pointer",
                font: `500 9px/1.6 ${T.mono}`,
                color: T.dim,
                flex: "none",
              }}
            >
              {markCount}
            </button>
          ) : null}
          {/* Pin and close appear together on hover or focus, not dimmed:
              controls that are always visible on every row made the right
              edge as busy as the left. A pinned row keeps its pin lit, since
              that state has to be readable without hovering. */}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 1,
              opacity: engaged || item.pinned ? 1 : 0,
              pointerEvents: engaged || item.pinned ? "auto" : "none",
              transition: "opacity 120ms ease",
            }}
          >
            <MiniIconBtn
              title={
                item.pinned
                  ? t("documentTree.unpin")
                  : t("documentTree.pin")
              }
              size={16}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin(item.id);
              }}
            >
              <Ic.bookmark
                width={10}
                height={10}
                style={{ color: item.pinned ? T.accent : undefined }}
              />
            </MiniIconBtn>
            <MiniIconBtn
              title={t("tabs.close")}
              size={16}
              onClick={(event) => {
                event.stopPropagation();
                onClose(item.id);
              }}
            >
              <Ic.x width={9} height={9} />
            </MiniIconBtn>
          </span>
          {/* Kind LAST, so it is the row's right edge. Sitting before the
              pin and close controls put it ~34px further left than the same
              label in the folder tree, and two lists in one panel ending
              their rows on different columns reads as a mistake. */}
          <span
            style={{
              font: `500 9px/1.6 ${T.mono}`,
              letterSpacing: ".06em",
              color: T.dim,
              flex: "none",
            }}
          >
            {item.unavailable
              ? t("documentTree.unavailable")
              : documentKindShortLabel(item.kind)}
          </span>
        </span>
      </div>
    </div>
  );
}
