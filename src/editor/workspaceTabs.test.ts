import { describe, expect, test } from "bun:test";
import type { WorkspaceTabMeta } from "../storage/workspace";
import {
  applyTextSourceWriteCompletion,
  applyReopenedWorkspaceTab,
  mergeReconstructedWorkspaceTab,
  replaceOrAppendWorkspaceTab,
} from "./workspaceTabs";

const exported = {
  documentHash: "hash-a",
  snapshotKey: "sha256:exported",
  exportedAt: 42,
  path: "/tmp/export.pdf",
  platform: "desktop" as const,
};

function pdfTab(patch: Partial<WorkspaceTabMeta> = {}): WorkspaceTabMeta {
  return {
    id: "tab-a",
    kind: "pdf",
    title: "paper.pdf",
    size: 10,
    source: { type: "path", path: "/tmp/paper.pdf" },
    hash: "hash-a",
    updatedAt: 1,
    ...patch,
  };
}

describe("workspace tab reconstruction", () => {
  test("keeps pin and PDF export bookkeeping for the same document", () => {
    const previous = pdfTab({
      pinned: true,
      exportBaselineSnapshot: "sha256:baseline",
      lastExport: exported,
    });
    const next = pdfTab({
      exportBaselineSnapshot: "sha256:reparsed",
      lastExport: null,
      updatedAt: 2,
    });

    expect(mergeReconstructedWorkspaceTab(previous, next)).toMatchObject({
      pinned: true,
      exportBaselineSnapshot: "sha256:baseline",
      lastExport: exported,
      updatedAt: 2,
    });
  });

  test("keeps text dirty state and the current working copy", () => {
    const previous: WorkspaceTabMeta = {
      id: "tab-a",
      kind: "markdown",
      title: "note.md",
      size: 4,
      source: { type: "path", path: "/tmp/note.md" },
      workingCopyCacheId: "copy-a",
      textDirty: true,
      pinned: true,
      hash: "hash-a",
      updatedAt: 1,
    };
    const next = {
      ...previous,
      workingCopyCacheId: undefined,
      textDirty: undefined,
      pinned: undefined,
      updatedAt: 2,
    };

    expect(mergeReconstructedWorkspaceTab(previous, next)).toMatchObject({
      workingCopyCacheId: "copy-a",
      textDirty: true,
      pinned: true,
    });
  });

  test("resets document-specific state when a slot gets different bytes", () => {
    const previous = pdfTab({
      pinned: true,
      exportBaselineSnapshot: "sha256:baseline",
      lastExport: exported,
    });
    const next = pdfTab({
      source: { type: "path", path: "/tmp/replacement.pdf" },
      hash: "hash-b",
      exportBaselineSnapshot: "sha256:new-baseline",
      lastExport: null,
    });

    expect(mergeReconstructedWorkspaceTab(previous, next)).toMatchObject({
      pinned: true,
      exportBaselineSnapshot: "sha256:new-baseline",
      lastExport: null,
    });
  });

  test("replaces in place without disturbing sibling order", () => {
    const sibling = pdfTab({ id: "tab-b", title: "b.pdf" });
    const previous = pdfTab({ pinned: true });
    const result = replaceOrAppendWorkspaceTab(
      [sibling, previous],
      pdfTab({ updatedAt: 2 }),
    );

    expect(result.map((tab) => tab.id)).toEqual(["tab-b", "tab-a"]);
    expect(result[1]?.pinned).toBe(true);
  });
});

describe("text source save completion", () => {
  const tab = {
    ...pdfTab(),
    kind: "markdown" as const,
    text: "newer edit",
    textDirty: true,
    hash: "newer-hash",
  };

  test("does not mark a newer edit clean when an older write finishes", () => {
    expect(applyTextSourceWriteCompletion(tab, "older save", "older-hash")).toBe(
      tab,
    );
  });

  test("marks only the exact written snapshot clean", () => {
    expect(
      applyTextSourceWriteCompletion(tab, "newer edit", "saved-hash"),
    ).toMatchObject({ textDirty: false, hash: "saved-hash" });
  });
});

describe("reopening a workspace tab", () => {
  test("hands back the export record after a password retry rebuilds the tab", () => {
    // The failure this guards: the encrypted route re-enters handleBytes once
    // the reader unlocks, finalizeOpen clears lastExport again, and the tab
    // literal built there always carries lastExport: null. If the transition
    // does not derive the record back out, editor state stays null and the
    // next tab switch persists that null over the tab's correct record.
    const previous = pdfTab({ lastExport: exported });
    const afterUnlock = pdfTab({ lastExport: null, updatedAt: 9 });

    const transition = applyReopenedWorkspaceTab([previous], afterUnlock);

    expect(transition.restoredLastExport).toEqual(exported);
    expect(transition.activeTabId).toBe(afterUnlock.id);
    expect(transition.nextTabs).toHaveLength(1);
  });

  test("restores nothing for a document that was never exported", () => {
    const transition = applyReopenedWorkspaceTab(
      [],
      pdfTab({ lastExport: null }),
    );

    expect(transition.restoredLastExport).toBeNull();
    expect(transition.nextTabs).toHaveLength(1);
  });

  test("restores nothing for a text document", () => {
    const previous = pdfTab({ lastExport: exported });
    const asText = {
      ...pdfTab({ lastExport: null }),
      kind: "markdown",
    } as WorkspaceTabMeta;

    expect(
      applyReopenedWorkspaceTab([previous], asText).restoredLastExport,
    ).toBeNull();
  });
});
