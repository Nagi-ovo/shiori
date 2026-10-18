import { describe, expect, test } from "bun:test";
import type { DocumentModel } from "../../pdf/model/types";
import {
  exportSnapshotKey,
  resolveExportStatus,
  type ExportedSnapshot,
} from "./exportStatus";

function noteOverlay(id: string, text: string) {
  return {
    id,
    type: "note" as const,
    pageId: "page-a",
    rect: { x: 10, y: 20, w: 100, h: 50 },
    text,
    color: "#f7e9a8",
  };
}

function modelWithNotes(count: number): DocumentModel {
  return {
    pages: [
      {
        id: "page-a",
        sourceIndex: 0,
        rotation: 0,
        widthPt: 612,
        heightPt: 792,
      },
    ],
    overlays: Array.from({ length: count }, (_, i) =>
      noteOverlay(`note-${i}`, `note ${i}`),
    ),
  };
}

describe("export status", () => {
  test("treats unchanged documents as clean", () => {
    expect(
      resolveExportStatus({
        documentHash: "hash-a",
        snapshotKey: "snapshot-a",
        hasChanges: false,
        lastExport: null,
      }),
    ).toEqual({ kind: "clean" });
  });

  test("reports changed documents as exported only for the matching snapshot", () => {
    const lastExport: ExportedSnapshot = {
      documentHash: "hash-a",
      snapshotKey: "snapshot-a",
      exportedAt: 123,
      path: "doc-edited.pdf",
      platform: "web",
    };

    expect(
      resolveExportStatus({
        documentHash: "hash-a",
        snapshotKey: "snapshot-a",
        hasChanges: true,
        lastExport,
      }),
    ).toEqual({
      kind: "exported",
      exportedAt: 123,
      path: "doc-edited.pdf",
      platform: "web",
    });

    expect(
      resolveExportStatus({
        documentHash: "hash-a",
        snapshotKey: "snapshot-b",
        hasChanges: true,
        lastExport,
      }),
    ).toEqual({ kind: "needsExport" });
  });

  test("a pending snapshot key needs export even against a matching export", () => {
    const model = modelWithNotes(2);
    const lastExport: ExportedSnapshot = {
      documentHash: "hash-a",
      snapshotKey: exportSnapshotKey(model),
      exportedAt: 1,
      path: "/tmp/a.pdf",
      platform: "desktop",
    };
    expect(
      resolveExportStatus({
        documentHash: "hash-a",
        snapshotKey: null,
        hasChanges: true,
        lastExport,
      }),
    ).toEqual({ kind: "needsExport" });
  });

  test("snapshot keys change when pages or overlays change", () => {
    const model: DocumentModel = {
      pages: [
        {
          id: "page-a",
          sourceIndex: 0,
          rotation: 0,
          widthPt: 612,
          heightPt: 792,
        },
      ],
      overlays: [],
    };
    const withOverlay: DocumentModel = {
      ...model,
      overlays: [
        {
          id: "note-a",
          type: "note",
          pageId: "page-a",
          rect: { x: 10, y: 20, w: 100, h: 50 },
          text: "todo",
          color: "#f7e9a8",
        },
      ],
    };

    expect(exportSnapshotKey(model)).not.toBe(exportSnapshotKey(withOverlay));
  });

  test("snapshot keys are compact SHA-256 digests, not model JSON", () => {
    const model: DocumentModel = {
      pages: [
        {
          id: "page-a",
          sourceIndex: 0,
          rotation: 0,
          widthPt: 612,
          heightPt: 792,
        },
      ],
      overlays: [],
    };
    const key = exportSnapshotKey(model);

    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(key).not.toContain("overlays");
    expect(exportSnapshotKey(structuredClone(model))).toBe(key);
  });

  test("an edit after exporting past the undo-stack cap needs export", () => {
    // 105 edits is past the 100-entry undo cap: any depth-based comparison
    // saturates here, which once froze the status at "exported" forever.
    const exportedModel = modelWithNotes(105);
    const lastExport: ExportedSnapshot = {
      documentHash: "hash-a",
      snapshotKey: exportSnapshotKey(exportedModel),
      exportedAt: 123,
      path: "doc-edited.pdf",
      platform: "desktop",
    };

    expect(
      resolveExportStatus({
        documentHash: "hash-a",
        snapshotKey: exportSnapshotKey(exportedModel),
        hasChanges: true,
        lastExport,
      }).kind,
    ).toBe("exported");

    const afterOneMoreEdit = modelWithNotes(106);
    expect(
      resolveExportStatus({
        documentHash: "hash-a",
        snapshotKey: exportSnapshotKey(afterOneMoreEdit),
        hasChanges: true,
        lastExport,
      }).kind,
    ).toBe("needsExport");
  });

  test("undo plus a different edit at the same depth needs export", () => {
    const base = modelWithNotes(0);
    const exportedModel: DocumentModel = {
      ...base,
      overlays: [noteOverlay("note-alpha", "alpha")],
    };
    const lastExport: ExportedSnapshot = {
      documentHash: "hash-a",
      snapshotKey: exportSnapshotKey(exportedModel),
      exportedAt: 123,
      path: "doc-edited.pdf",
      platform: "desktop",
    };

    // Undo back to base, then a different edit: same undo depth as the
    // exported state, different content.
    const divergedModel: DocumentModel = {
      ...base,
      overlays: [noteOverlay("note-beta", "beta")],
    };
    expect(
      resolveExportStatus({
        documentHash: "hash-a",
        snapshotKey: exportSnapshotKey(divergedModel),
        hasChanges: true,
        lastExport,
      }).kind,
    ).toBe("needsExport");
  });
});
