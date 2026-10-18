import type { DocumentModel } from "../../pdf/model/types";
import { snapshotKeyFromJson } from "../../shared/snapshotKey";

export type ExportedSnapshot = {
  documentHash: string;
  snapshotKey: string;
  exportedAt: number;
  path: string;
  platform: "desktop" | "web" | "mobile";
};

export type ExportStatusKind = "clean" | "needsExport" | "exported";

export type ExportStatus = {
  kind: ExportStatusKind;
  exportedAt?: number;
  path?: string;
  platform?: "desktop" | "web" | "mobile";
};

export function exportSnapshotKey(model: DocumentModel): string {
  return snapshotKeyFromJson(
    JSON.stringify({
      pages: model.pages,
      overlays: model.overlays,
    }),
  );
}

export function resolveExportStatus({
  documentHash,
  snapshotKey,
  hasChanges,
  lastExport,
}: {
  documentHash: string | null;
  // null while the digest of a large model is still being computed.
  snapshotKey: string | null;
  hasChanges: boolean;
  lastExport: ExportedSnapshot | null;
}): ExportStatus {
  if (!hasChanges) return { kind: "clean" };
  // Only a content-derived snapshot key proves the document still matches
  // the exported bytes. Undo-stack depth is no substitute: the stack is
  // capped at 100 (depth saturates), and undo followed by a different edit
  // returns to the same depth with different content. A pending key proves
  // nothing, so it can never read as exported.
  if (
    documentHash &&
    snapshotKey !== null &&
    lastExport?.documentHash === documentHash &&
    lastExport.snapshotKey === snapshotKey
  ) {
    return {
      kind: "exported",
      exportedAt: lastExport.exportedAt,
      path: lastExport.path,
      platform: lastExport.platform,
    };
  }
  return { kind: "needsExport" };
}
