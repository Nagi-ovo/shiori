import "../../test/setupDom";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { twoWindowsOnOneHandle } from "../../test/twoWindowDraft";

// Closing or reloading a web tab skips the in-app export-or-discard dialog, so
// the browser's own "Leave site?" prompt has to guard a copy whose draft save
// was refused for another window's newer work (audit B034). Ways it can fail:
// - a refused, unexported copy leaves without a prompt (the bug);
// - the prompt outlives the danger: after export, discard (even when a save in
//   flight is refused after it), a save that lands later, or on the next
//   document, nagging every normal close;
// - a new edit after export is unexported again but no longer held;
// - ordinary editing (dirty or saved, no refusal) starts asking;
// - the existing hold for pending text-source writes is lost.
// Desktop never arms it (CAPABILITIES.nativeWindowChrome): the native close
// guard asks instead. Tests run as the web build.

const flushPendingTextSources = async () => {};
const textSources = { pending: false };

async function webTabWithPersistence() {
  const { useDraftPersistence } = await import("./useDraftPersistence");
  return twoWindowsOnOneHandle((draftState, isExported) => {
    useDraftPersistence({
      draftState,
      flushPendingTextSources,
      hasPendingTextSourceWrites: textSources.pending,
      isExported,
    });
  });
}

/** Whether the browser would ask before reloading or closing the tab. */
function leaveIsHeld(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

async function refusedTab() {
  const w = await webTabWithPersistence();
  w.openInThisWindow(await w.saveInWindowA("a-1"));
  await w.saveInWindowA("a-2");
  expect(await w.editAndFlush("b-1")).not.toBeNull();
  return w;
}

describe("useDraftPersistence on the web", () => {
  beforeEach(() => {
    cleanup();
    textSources.pending = false;
  });
  afterEach(() => {
    cleanup();
  });

  test("a copy refused for another window's newer draft holds the tab until exported", async () => {
    const w = await refusedTab();
    try {
      expect(leaveIsHeld()).toBe(true);

      w.exportState.exported = true;
      expect(leaveIsHeld()).toBe(false);

      // A new edit is unexported again: leaving would lose it.
      w.exportState.exported = false;
      expect(await w.editAndFlush("b-2")).not.toBeNull();
      expect(leaveIsHeld()).toBe(true);
    } finally {
      await w.dispose();
    }
  });

  test("discarding the refused copy lets the tab close", async () => {
    const w = await refusedTab();
    try {
      act(() => {
        expect(w.view.result.current.discardRefusedEdits()).toBe(true);
      });
      expect(leaveIsHeld()).toBe(false);
    } finally {
      await w.dispose();
    }
  });

  // A close can start a strict flush that is refused again only after the
  // reader discarded the copy; that late refusal must not re-arm the prompt.
  test("a refusal landing after the discard does not hold the tab", async () => {
    const w = await refusedTab();
    try {
      await act(async () => {
        w.edit("b-2");
        const inFlight = w.view.result.current.flushNowOrThrow().catch((err: unknown) => err);
        expect(w.view.result.current.discardRefusedEdits()).toBe(true);
        expect(await inFlight).not.toBeNull();
      });
      expect(leaveIsHeld()).toBe(false);
    } finally {
      await w.dispose();
    }
  });

  test("a save that lands after the refusal lets the tab close", async () => {
    const w = await refusedTab();
    try {
      // Reopened from the other window's latest draft, saving works again.
      w.openInThisWindow(await w.saveInWindowA("a-3"));
      expect(await w.editAndFlush("b-3")).toBeNull();
      expect(await w.overlays()).toEqual(["b-3"]);
      expect(leaveIsHeld()).toBe(false);
    } finally {
      await w.dispose();
    }
  });

  test("a refusal on one document does not hold the next", async () => {
    const w = await refusedTab();
    try {
      w.exportState.exported = true;
      expect(await w.flush()).toBeNull();
      // Another file goes on screen, with unexported edits of its own.
      w.openInThisWindow(null, "other-handle");
      w.exportState.exported = false;
      expect(leaveIsHeld()).toBe(false);
    } finally {
      await w.dispose();
    }
  });

  test("ordinary editing never asks before leaving", async () => {
    const w = await webTabWithPersistence();
    try {
      w.openInThisWindow(await w.saveInWindowA("a-1"));
      w.edit("b-1");
      expect(leaveIsHeld()).toBe(false);
      expect(await w.flush()).toBeNull();
      expect(leaveIsHeld()).toBe(false);
    } finally {
      await w.dispose();
    }
  });

  test("pending text-source writes still hold the tab", async () => {
    const w = await webTabWithPersistence();
    try {
      textSources.pending = true;
      w.view.rerender();
      expect(leaveIsHeld()).toBe(true);
      textSources.pending = false;
      w.view.rerender();
      expect(leaveIsHeld()).toBe(false);
    } finally {
      await w.dispose();
    }
  });
});
