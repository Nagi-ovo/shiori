import { useCallback } from "react";
import {
  clampNavigatorWidth,
  RAIL_MIN_WIDTH,
  type NavigatorView,
} from "../../editor/components/navigatorLayout";
import { useViewportWidth } from "../../editor/hooks/useIsMobile";
import { useAppStore, useEditorStore } from "../../editor/store/store";
import { CAPABILITIES, type FolderEntry } from "../../platform";
import { useWorkspace, workspaceStore } from "../../workspace/appWorkspace";
import type { WorkspaceRuntimeTab } from "../../workspace/types";
import type { AppAcquisition } from "../acquisitionPorts";
import type { AppMergePicker } from "../mergePickerPorts";
import type { AppTabs } from "../tabLifecyclePorts";
import { documentTreeItems, requestTabPreview } from "../workspaceLists";
import { PdfDocumentNavigator } from "./PdfDocumentNavigator";

/**
 * The left gutter: the document tree and the open PDF's outline and
 * thumbnails. Renders nothing where the navigator cannot show, so the shell
 * keeps one slot for it across every document kind.
 */
export function WorkspaceNavigator({
  available,
  isMobile,
  tab,
  tabFlows,
  acquisition,
  mergePicker,
  openPlatformPath,
  pdfInsertionBusy,
}: {
  /** Whether this layout has a gutter for it at all. */
  available: boolean;
  isMobile: boolean;
  tab: WorkspaceRuntimeTab | null;
  tabFlows: AppTabs;
  acquisition: AppAcquisition;
  mergePicker: AppMergePicker;
  openPlatformPath: (path: string) => Promise<void>;
  pdfInsertionBusy: boolean;
}) {
  const opened = useEditorStore((s) => s.opened);
  const showRail = useAppStore((s) => s.showRail);
  const showNavigator = useAppStore((s) => s.prefs.showNavigator);
  const setPrefs = useAppStore((s) => s.setPrefs);
  const navigatorView = useAppStore((s) => s.prefs.navigatorView);
  const navigatorWidth = useAppStore((s) => s.prefs.navigatorWidth);
  const tabs = useWorkspace((state) => state.tabs);
  const activeTabId = useWorkspace((state) => state.activeTabId);
  const folderPaths = useWorkspace((state) => state.folderPaths);
  // Width the right rail is holding as a real column, which the navigator's
  // ceiling has to leave for it. Zero when the rail is closed, when it is a
  // mobile drawer laid OVER the canvas, or when it has no tab to show at all
  // — on web neither the terminal nor the browser panel exists, so the rail
  // renders nothing and occupies nothing.
  //
  // Deliberately NOT conditioned on the document having pages: the rail is
  // mounted in the text-document and loading branches too, where `pages` is
  // empty. Gating on that reserved nothing for a Markdown or HTML tab and
  // left it with the same squeezed document column this reservation exists
  // to prevent. The cost of the other direction — an empty PDF, where the
  // rail is not mounted — is a navigator ceiling 360px lower than it could
  // be on a page showing an empty state.
  const railTakesColumn =
    showRail &&
    !isMobile &&
    (CAPABILITIES.embeddedTerminal || CAPABILITIES.embeddedBrowserPanel);
  const railReservePx = railTakesColumn ? RAIL_MIN_WIDTH : 0;
  // clampNavigatorWidth reads the window width, which React cannot see on its
  // own: dragging the window from 1600 to 1000 crosses no media query, so
  // without this subscription the gutter kept a width the window no longer
  // had and the document column between the two panes was squeezed to
  // nothing. The rail has always re-clamped itself on resize; this is the
  // navigator's half of the same budget.
  const viewportWidth = useViewportWidth();
  const unmountFolder = useCallback(
    (path: string) => workspaceStore().getState().unmountFolder(path),
    [],
  );
  const openFolderFile = useCallback(
    (entry: FolderEntry) => {
      void openPlatformPath(entry.path);
    },
    [openPlatformPath],
  );

  // View buttons choose content; the top-bar's stateful panel button owns
  // opening and closing. Keeping those actions separate means a view glyph
  // never silently changes from "show this" to "hide the whole navigator".
  const pickNavigatorView = (view: NavigatorView) => {
    setPrefs({ showNavigator: true, navigatorView: view });
  };
  return available ? (
    <>
      {/* The 44px icon rail is gone: a whole column for four buttons (one
          button and three ghosts on a text document) while the navigator's
          own header band sat mostly empty. The view switcher lives in that
          band now — see LeftNavigator. Reopening a fully closed navigator
          stays on the top bars' navigator buttons. */}
      {showNavigator ? (
      <PdfDocumentNavigator
        view={navigatorView}
        onViewChange={(view) => setPrefs({ navigatorView: view })}
        onPickView={pickNavigatorView}
        hasPdf={tab?.kind === "pdf" && Boolean(opened?.doc)}
        width={clampNavigatorWidth(
          navigatorWidth,
          railReservePx,
          viewportWidth,
        )}
        onWidthChange={(next) => setPrefs({ navigatorWidth: next })}
        railReservePx={railReservePx}
        items={documentTreeItems(tabs)}
        activeTabId={activeTabId}
        onSelect={(id) => {
          void tabFlows.activate(id);
        }}
        onPreviewRequest={requestTabPreview}
        onClose={(id) => {
          void tabFlows.close(id);
        }}
        onTogglePin={tabFlows.togglePin}
        folderPaths={folderPaths}
        // Every kind opened from a path highlights its row. Enumerating kinds
        // here meant each new format silently lost its highlight until someone
        // noticed — the path is the path, whatever the format.
        activePath={
          tab?.source.type === "path" ? tab.source.path : undefined
        }
        onUnmountFolder={unmountFolder}
        onOpenFolderFile={openFolderFile}
        onNew={() => {
          void acquisition.pickWorkspaceTarget();
        }}
        doc={tab?.kind === "pdf" ? opened?.doc ?? null : null}
        pdfInsertionBusy={pdfInsertionBusy}
        onInsertPdfPages={(afterPageId) => {
          void mergePicker.pick(afterPageId);
        }}
      />
      ) : null}
    </>
  ) : null;
}
