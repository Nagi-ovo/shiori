// Validation and forward migration of the tab metadata stored with the
// workspace (src/storage/workspace.ts), so a stored tab from an older build
// is upgraded rather than dropped.
import type { DocumentKind, DocumentSource } from "../documents/types";
import type { FitMode, RailTab } from "../editor/store/store";
import { normalizeCollapsedNoteIds } from "../editor/overlays/notePresentation";
import { normalizeMarkdownAppearanceOverride } from "../documents/markdownAppearance";
import { normalizeLegacySnapshotKey } from "../shared/snapshotKey";
import type {
  WorkspaceExportedSnapshot,
  WorkspacePdfViewState,
  WorkspaceTabMeta,
  WorkspaceTextViewMode,
  WorkspaceTextViewState,
} from "./workspace";

export function isWorkspaceTabMeta(value: unknown): value is WorkspaceTabMeta {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.id === "string" &&
    isDocumentKind(tab.kind) &&
    typeof tab.title === "string" &&
    typeof tab.size === "number" &&
    isDocumentSource(tab.source) &&
    (tab.workingCopyCacheId === undefined ||
      typeof tab.workingCopyCacheId === "string") &&
    (tab.textDirty === undefined || typeof tab.textDirty === "boolean") &&
    (tab.hash === undefined || typeof tab.hash === "string") &&
    (tab.pinned === undefined || typeof tab.pinned === "boolean") &&
    (tab.pdfView === undefined || isPdfViewState(tab.pdfView)) &&
    (tab.textView === undefined || isTextViewState(tab.textView)) &&
    (tab.exportBaselineSnapshot === undefined ||
      tab.exportBaselineSnapshot === null ||
      typeof tab.exportBaselineSnapshot === "string") &&
    (tab.lastExport === undefined ||
      tab.lastExport === null ||
      isExportedSnapshot(tab.lastExport)) &&
    typeof tab.updatedAt === "number"
  );
}

function isExportedSnapshot(
  value: unknown,
): value is WorkspaceExportedSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.documentHash === "string" &&
    typeof snapshot.snapshotKey === "string" &&
    typeof snapshot.exportedAt === "number" &&
    typeof snapshot.path === "string" &&
    (snapshot.platform === "desktop" ||
      snapshot.platform === "web" ||
      snapshot.platform === "mobile")
  );
}

function isDocumentKind(value: unknown): value is DocumentKind {
  return (
    value === "pdf" ||
    value === "markdown" ||
    value === "html" ||
    value === "docx"
  );
}

function isDocumentSource(value: unknown): value is DocumentSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Record<string, unknown>;
  if (source.type === "path") return typeof source.path === "string";
  if (source.type === "webFileHandle") return typeof source.id === "string";
  if (source.type === "cache") return typeof source.id === "string";
  return source.type === "ephemeral";
}

function isFitMode(value: unknown): value is FitMode {
  return value === "width" || value === "none";
}

// "page" (fit the whole page) was a third mode until the control was
// removed. Accept it when validating a stored tab so upgrading does not
// silently drop the tab, and normalize it to "width" in migrateTabMeta —
// otherwise a reader who last used it would be stuck at that zoom with no
// button left to change it.
function isStoredFitMode(value: unknown): boolean {
  return isFitMode(value) || value === "page";
}

function isPdfViewState(value: unknown): value is WorkspacePdfViewState {
  if (!value || typeof value !== "object") return false;
  const view = value as Record<string, unknown>;
  return (
    typeof view.pageIndex === "number" &&
    typeof view.scale === "number" &&
    // Accept the new `fitMode` enum or a legacy `fitWidth` boolean. Older
    // workspaces predate the tri-state zoom model; migrateTabMeta() maps
    // the boolean forward on load so the tab isn't dropped on upgrade.
    (isStoredFitMode(view.fitMode) || typeof view.fitWidth === "boolean") &&
    typeof view.showThumbs === "boolean" &&
    typeof view.showRail === "boolean" &&
    isRailTab(view.railTab) &&
    typeof view.readerMode === "boolean" &&
    (view.collapsedNoteIds === undefined ||
      Array.isArray(view.collapsedNoteIds)) &&
    (view.collapsedCalloutIds === undefined ||
      Array.isArray(view.collapsedCalloutIds))
  );
}

// Forward-migrate a persisted tab: legacy `pdfView.fitWidth: boolean`
// becomes `fitMode` ("width" | "none") so restored tabs keep their fit
// behavior. No-op once a tab already carries a valid fitMode.
export function migrateTabMeta(tab: WorkspaceTabMeta): WorkspaceTabMeta {
  let migrated = tab;
  if (tab.pdfView) {
    const raw = tab.pdfView as unknown as {
      fitMode?: unknown;
      fitWidth?: unknown;
    };
    const pdfView = {
      ...tab.pdfView,
      fitMode: isFitMode(raw.fitMode)
        ? raw.fitMode
        : raw.fitMode === "page"
          ? ("width" as FitMode)
          : ((raw.fitWidth === true ? "width" : "none") as FitMode),
      collapsedNoteIds: normalizeCollapsedNoteIds(
        (tab.pdfView as unknown as Record<string, unknown>).collapsedNoteIds,
      ),
      collapsedCalloutIds: normalizeCollapsedNoteIds(
        (tab.pdfView as unknown as Record<string, unknown>).collapsedCalloutIds,
      ),
    };
    // Drop the now-defunct legacy key so it isn't re-serialized.
    delete (pdfView as { fitWidth?: unknown }).fitWidth;
    migrated = { ...migrated, pdfView };
  }

  if (tab.textView) {
    const appearance = normalizeMarkdownAppearanceOverride(
      (tab.textView as unknown as Record<string, unknown>).appearance,
    );
    const textView = { ...tab.textView };
    if (Object.keys(appearance).length > 0) {
      textView.appearance = appearance;
    } else {
      delete textView.appearance;
    }
    migrated = { ...migrated, textView };
  }

  // Tabs written before save-back existed carry no `textDirty`. A working copy
  // only ever exists because the document was edited, so treat those as unsaved
  // rather than silently clean — the marker being wrong in the safe direction
  // costs one redundant save; wrong the other way hides a real edit.
  if (
    migrated.textDirty === undefined &&
    migrated.kind !== "pdf" &&
    migrated.workingCopyCacheId
  ) {
    migrated = { ...migrated, textDirty: true };
  }

  const exportBaselineSnapshot =
    typeof migrated.exportBaselineSnapshot === "string"
      ? normalizeLegacySnapshotKey(migrated.exportBaselineSnapshot)
      : migrated.exportBaselineSnapshot;
  const lastExport = migrated.lastExport
    ? {
        ...migrated.lastExport,
        snapshotKey: normalizeLegacySnapshotKey(migrated.lastExport.snapshotKey),
      }
    : migrated.lastExport;
  if (
    exportBaselineSnapshot !== migrated.exportBaselineSnapshot ||
    lastExport?.snapshotKey !== migrated.lastExport?.snapshotKey
  ) {
    migrated = { ...migrated, exportBaselineSnapshot, lastExport };
  }
  return migrated;
}

function isRailTab(value: unknown): value is RailTab {
  return (
    value === "outline" ||
    value === "comments" ||
    value === "terminal" ||
    value === "browser"
  );
}

function isTextViewState(value: unknown): value is WorkspaceTextViewState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.scrollTop === "number" &&
    (v.zoom === undefined || typeof v.zoom === "number") &&
    (v.mode === undefined || isTextViewMode(v.mode))
  );
}

function isTextViewMode(value: unknown): value is WorkspaceTextViewMode {
  return value === "preview" || value === "edit";
}
