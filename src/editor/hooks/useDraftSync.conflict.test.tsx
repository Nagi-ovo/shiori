import "../../test/setupDom";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { page, twoWindowsOnOneHandle } from "../../test/twoWindowDraft";

// Two browser windows (or two desktop windows on one path) share a draft id.
describe("useDraftSync across windows", () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  test("a second window on the same file never overwrites the other's newer draft", async () => {
    const { readOperationLog } = await import("../../storage/operationLog");
    const w = await twoWindowsOnOneHandle();
    const { id } = w;
    try {
      // This window read A's draft as A last saved it: its save may go on.
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      expect(await w.editAndFlush("b-1")).toBeNull();
      expect(await w.overlays()).toEqual(["b-1"]);

      // A saves on top meanwhile; this window's next save would undo A's work.
      await w.saveInWindowA("a-2");
      expect(await w.editAndFlush("b-2")).not.toBeNull();
      expect(w.view.result.current.errorKind).toBe("conflict");
      expect(await w.overlays()).toEqual(["a-2"]);
      // Its crash log must not outrank A's draft on the next open either.
      expect(readOperationLog(id)).toBeNull();

      // Reopened from A's latest draft, it logs edits again.
      w.openInThisWindow(await w.saveInWindowA("a-3"));
      w.edit("b-3");
      await act(() => Bun.sleep(400));
      expect(readOperationLog(id)).not.toBeNull();
    } finally {
      await w.dispose();
    }
  });

  test("a window that closed after saving keeps its draft from the other's stale save", async () => {
    const w = await twoWindowsOnOneHandle();
    try {
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      // A saves newer work and closes before this window saves.
      await w.saveInWindowA("a-2");
      w.closeWindowA();

      expect(await w.editAndFlush("b-1")).not.toBeNull();
      expect(w.view.result.current.errorKind).toBe("conflict");
      expect(await w.overlays()).toEqual(["a-2"]);
    } finally {
      await w.dispose();
    }
  });

  // Close, tab switch and quit all wait on the strict flush. After a refusal
  // its retry is refused too; once this copy is exported, leaving loses
  // nothing and must go through, still without touching the other's row.
  test("a refused window can leave its copy once it is exported", async () => {
    const w = await twoWindowsOnOneHandle();
    try {
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      await w.saveInWindowA("a-2");
      expect(await w.editAndFlush("b-1")).not.toBeNull();
      expect(await w.flush()).not.toBeNull();

      w.exportState.exported = true;
      expect(await w.flush()).toBeNull();
      expect(await w.overlays()).toEqual(["a-2"]);

      // A new edit is unexported again: leaving would lose it.
      w.exportState.exported = false;
      expect(await w.editAndFlush("b-2")).not.toBeNull();
      expect(await w.overlays()).toEqual(["a-2"]);
    } finally {
      await w.dispose();
    }
  });

  // Instead of exporting, the reader may drop the refused copy: the blocked
  // leave goes on, the other window's draft stays, and no crash log can bring
  // this copy back on the next open as if it had been saved.
  test("a refused window can discard its copy and leave", async () => {
    const { readOperationLog } = await import("../../storage/operationLog");
    const w = await twoWindowsOnOneHandle();
    try {
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      await w.saveInWindowA("a-2");
      w.edit("b-1");
      await act(() => Bun.sleep(400));
      expect(await w.flush()).not.toBeNull();

      let discarded = false;
      act(() => {
        discarded = w.view.result.current.discardRefusedEdits();
      });
      expect(discarded).toBe(true);
      expect(await w.flush()).toBeNull();
      expect(await w.overlays()).toEqual(["a-2"]);
      expect(readOperationLog(w.id)).toBeNull();
      await act(() => Bun.sleep(900));
      expect(await w.overlays()).toEqual(["a-2"]);
      expect(readOperationLog(w.id)).toBeNull();

      // A new edit is unsaved again: leaving would lose it.
      expect(await w.editAndFlush("b-2")).not.toBeNull();
      expect(await w.overlays()).toEqual(["a-2"]);
    } finally {
      await w.dispose();
    }
  });

  // A close or quit can start a strict flush while the dialog is open; if the
  // other window then removes the row, that save is accepted. A discard
  // landing while it is in flight must still leave nothing behind, and the
  // leave the discard releases must wait until that is so (a quit exits next).
  test("a discard overtaking a save in flight leaves no draft of this copy", async () => {
    const { readOperationLog } = await import("../../storage/operationLog");
    const { default: drafts } = await import("../../storage/drafts");
    const w = await twoWindowsOnOneHandle();
    try {
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      await w.saveInWindowA("a-2");
      expect(await w.editAndFlush("b-1")).not.toBeNull();

      // Window A undoes back to the original: its row is removed.
      await drafts.remove(w.id);
      let inFlight: Promise<unknown> = Promise.resolve();
      let leave: Promise<unknown> = Promise.resolve();
      await act(async () => {
        inFlight = w.view.result.current.flushNowOrThrow().catch((err: unknown) => err);
        expect(w.view.result.current.discardRefusedEdits()).toBe(true);
        leave = w.view.result.current.flushNowOrThrow().then(() => null, (err: unknown) => err);
        expect(await leave).toBeNull();
        // The leave has gone on: nothing of this copy may be in the store.
        expect(await w.overlays()).toBeUndefined();
        await inFlight;
      });
      await act(() => Bun.sleep(900));
      expect(await w.overlays()).toBeUndefined();
      expect(readOperationLog(w.id)).toBeNull();
    } finally {
      await w.dispose();
    }
  });

  test("discarding never drops edits a save can still keep", async () => {
    const w = await twoWindowsOnOneHandle();
    try {
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      w.edit("b-1");
      let discarded = true;
      act(() => {
        discarded = w.view.result.current.discardRefusedEdits();
      });
      expect(discarded).toBe(false);
      expect(await w.flush()).toBeNull();
      expect(await w.overlays()).toEqual(["b-1"]);
    } finally {
      await w.dispose();
    }
  });

  // The crash log lands at 250 ms, before the 800 ms save that would find
  // the conflict. A crash between the two must not let it outrank A's draft.
  test("a crash log written before the refusal does not outrank the other's draft", async () => {
    const { readOperationLog } = await import("../../storage/operationLog");
    const { default: drafts } = await import("../../storage/drafts");
    const { chooseDraftRecovery } = await import("../../workspace/intake/recovery");
    const w = await twoWindowsOnOneHandle();
    try {
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      await w.saveInWindowA("a-2");
      w.edit("b-1");
      await act(() => Bun.sleep(400));
      expect(readOperationLog(w.id)).not.toBeNull();

      // The browser crashes here; the next open picks what to restore.
      const recovery = chooseDraftRecovery(await drafts.get(w.id), readOperationLog(w.id), [page], []);
      expect(recovery?.overlays.map((o) => o.id)).toEqual(["a-2"]);
    } finally {
      await w.dispose();
    }
  });
});
