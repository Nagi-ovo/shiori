import {
  useLayoutEffect,
  useMemo,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  resolveExportStatus,
  type ExportedSnapshot,
  type ExportStatus,
} from "../../editor/export/exportStatus";
import { useExportSnapshotKey } from "../hooks/useExportSnapshotKey";
import { useEditorStore } from "../../editor/store/store";
import {
  TabStrip,
  type TabStripItem,
  type TabStripPreview,
} from "../../editor/components/TabStrip";
import {
  PdfExportStatusContext,
  usePdfExportStatus,
} from "./PdfExportStatusContext";

export type PdfExportControllerApi = {
  status: ExportStatus;
};

type Props = {
  documentHash: string | null;
  baselineSnapshot: string | null;
  lastExport: ExportedSnapshot | null;
  apiRef: MutableRefObject<PdfExportControllerApi | null>;
  children: ReactNode;
};

/** Isolates full-model snapshot work from App and stabilizes status identity. */
export function PdfExportController({
  documentHash,
  baselineSnapshot,
  lastExport,
  apiRef,
  children,
}: Props) {
  const model = useEditorStore((state) => state.model);
  const hasOpenedDocument = useEditorStore((state) => Boolean(state.opened));
  // null while a large model's digest is pending; that reads as "changed"
  // below, so the bar says "needs export" until the digest proves otherwise.
  const snapshotKey = useExportSnapshotKey(model);
  const nextStatus = resolveExportStatus({
    documentHash,
    snapshotKey,
    hasChanges: Boolean(
      hasOpenedDocument &&
        baselineSnapshot &&
        snapshotKey !== baselineSnapshot,
    ),
    lastExport,
  });
  const statusKind = nextStatus.kind;
  const exportedAt = nextStatus.exportedAt;
  const path = nextStatus.path;
  const platform = nextStatus.platform;
  const status = useMemo(
    () => ({
      kind: statusKind,
      ...(exportedAt === undefined ? {} : { exportedAt }),
      ...(path === undefined ? {} : { path }),
      ...(platform === undefined ? {} : { platform }),
    }),
    [exportedAt, path, platform, statusKind],
  );

  useLayoutEffect(() => {
    apiRef.current = { status };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, status]);

  return (
    <PdfExportStatusContext.Provider value={status}>
      {children}
    </PdfExportStatusContext.Provider>
  );
}

type ExportAwareTabStripProps = {
  tabs: TabStripItem[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPreviewRequest?: (id: string) => Promise<TabStripPreview | null>;
  onReorder: (activeId: string, overId: string) => void;
  onNew: () => void;
};

export function PdfExportAwareTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onPreviewRequest,
  onReorder,
  onNew,
}: ExportAwareTabStripProps) {
  const status = usePdfExportStatus();
  const activeNeedsExport = status.kind === "needsExport";
  const resolvedTabs = useMemo(
    () =>
      tabs.map((tab) =>
        tab.id === activeTabId && tab.kind === "pdf"
          ? { ...tab, dirty: activeNeedsExport }
          : tab,
      ),
    [activeNeedsExport, activeTabId, tabs],
  );
  return (
    <TabStrip
      tabs={resolvedTabs}
      activeTabId={activeTabId}
      onSelect={onSelect}
      onClose={onClose}
      onPreviewRequest={onPreviewRequest}
      onReorder={onReorder}
      onNew={onNew}
    />
  );
}
