import { describe, expect, test } from "bun:test";
import { DraftSaveError } from "../storage/drafts";
import { createDraftConflictChoice } from "./draftConflictChoice";
import { createLeaveGuard } from "./leaveGuard";

/**
 * The desktop window-close safeguard and the quit handshake: persist the
 * draft and text sources, then leave; on failure, stay and say why.
 */
function nativeLeave(draftFailure: Error | null, textFailure: Error | null = null) {
  const calls: string[] = [];
  const choice = createDraftConflictChoice();
  const isConflict = draftFailure instanceof DraftSaveError && draftFailure.kind === "conflict";
  // Like useDraftSync: once the refused copy is discarded, the flush passes.
  let refusedCopy = isConflict;
  const steps = {
    flushDraft: async () => {
      calls.push("flush draft");
      if (draftFailure && (!isConflict || refusedCopy)) throw draftFailure;
    },
    flushTextSources: async () => {
      calls.push("flush text");
      if (textFailure) throw textFailure;
    },
    discardRefusedEdits: () => {
      calls.push("discard");
      const had = refusedCopy;
      refusedCopy = false;
      return had;
    },
    offerConflictChoice: choice.offer,
    reportSaveFailed: () => calls.push("save failed"),
    leave: async () => {
      calls.push("leave");
    },
    blocked: () => calls.push("blocked"),
  };
  return { calls, choice, steps, leaveAfterPersisting: createLeaveGuard() };
}

const conflict = () => new DraftSaveError("conflict", "newer draft in another window");

describe("leaving after persisting", () => {
  test("leaves once the draft and text sources are saved", async () => {
    const { calls, steps, leaveAfterPersisting } = nativeLeave(null);

    await leaveAfterPersisting(steps);

    expect(calls).toEqual(["flush draft", "flush text", "leave"]);
  });

  // Before: the close safeguard told the reader to free device storage,
  // which does nothing for a copy refused for another window's newer draft.
  test("a copy refused for another window's draft asks the reader, not for storage", async () => {
    const { calls, choice, steps, leaveAfterPersisting } = nativeLeave(conflict());

    await leaveAfterPersisting(steps);

    expect(calls).toEqual(["flush draft", "blocked"]);
    expect(choice.pending()).toBe(true);
  });

  test("discarding the refused copy closes after the text sources are saved", async () => {
    const { calls, choice, steps, leaveAfterPersisting } = nativeLeave(conflict());
    await leaveAfterPersisting(steps);
    calls.length = 0;

    choice.discard();
    await Bun.sleep(0);

    expect(calls).toEqual(["discard", "flush draft", "flush text", "leave"]);
  });

  test("a storage failure still says so and offers no discard", async () => {
    const { calls, choice, steps, leaveAfterPersisting } = nativeLeave(
      new DraftSaveError("quota", "full"),
    );

    await leaveAfterPersisting(steps);

    expect(calls).toEqual(["flush draft", "blocked", "save failed"]);
    expect(choice.pending()).toBe(false);
  });

  test("a text source that cannot be written blocks the leave with its failure", async () => {
    const { calls, choice, steps, leaveAfterPersisting } = nativeLeave(
      null,
      new Error("disk"),
    );

    await leaveAfterPersisting(steps);

    expect(calls).toEqual(["flush draft", "flush text", "blocked", "save failed"]);
    expect(choice.pending()).toBe(false);
  });

  test("a second request while one is persisting is ignored, and a retry after a failure runs", async () => {
    const { calls, steps, leaveAfterPersisting } = nativeLeave(new DraftSaveError("transient", "busy"));

    await Promise.all([leaveAfterPersisting(steps), leaveAfterPersisting(steps)]);
    expect(calls).toEqual(["flush draft", "blocked", "save failed"]);

    await leaveAfterPersisting(steps);
    expect(calls.filter((call) => call === "flush draft")).toHaveLength(2);
  });
});
