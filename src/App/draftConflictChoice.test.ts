import { describe, expect, test } from "bun:test";
import { DraftSaveError } from "../storage/drafts";
import { createDraftConflictChoice } from "./draftConflictChoice";

const refused = () => new DraftSaveError("conflict", "newer draft in another window");

/**
 * A leave (closing a tab or the window, quitting) refused because another
 * window saved newer work on the same file, and what the reader then chose.
 */
function blockedLeave(discardable = true) {
  const calls: string[] = [];
  const route = {
    discardRefusedEdits: () => {
      calls.push("discard");
      return discardable;
    },
    leave: () => calls.push("leave"),
  };
  return { calls, route };
}

describe("draft conflict choice", () => {
  test("a leave refused for another window's newer draft asks the reader", () => {
    const choice = createDraftConflictChoice();
    const { calls, route } = blockedLeave();

    expect(choice.offer(refused(), route)).toBe(true);

    expect(choice.pending()).toBe(true);
    expect(calls).toEqual([]);
  });

  // Discarding is only for a copy no save can keep. A full disk or a
  // transient failure may still save, so those keep their own message.
  test("any other save failure is not offered the discard", () => {
    const choice = createDraftConflictChoice();
    const { route } = blockedLeave();

    expect(choice.offer(new DraftSaveError("quota", "full"), route)).toBe(false);
    expect(choice.offer(new DraftSaveError("transient", "busy"), route)).toBe(false);
    expect(choice.offer(new Error("text write failed"), route)).toBe(false);

    expect(choice.pending()).toBe(false);
  });

  test("discarding drops the refused copy, then carries out the blocked leave once", () => {
    const choice = createDraftConflictChoice();
    const { calls, route } = blockedLeave();
    choice.offer(refused(), route);

    choice.discard();
    choice.discard();

    expect(calls).toEqual(["discard", "leave"]);
    expect(choice.pending()).toBe(false);
  });

  // The conflict cleared meanwhile (an export, a reopen): leaving now could
  // lose edits a save would keep, so nothing happens.
  test("does not leave when there is no refused copy left to discard", () => {
    const choice = createDraftConflictChoice();
    const { calls, route } = blockedLeave(false);
    choice.offer(refused(), route);

    choice.discard();

    expect(calls).toEqual(["discard"]);
  });

  test("exporting opens the export and leaves nothing behind it", () => {
    const choice = createDraftConflictChoice();
    const { calls, route } = blockedLeave();
    choice.offer(refused(), route);

    choice.exportCopy(() => calls.push("export"));

    expect(calls).toEqual(["export"]);
    expect(choice.pending()).toBe(false);
    choice.discard();
    expect(calls).toEqual(["export"]);
  });

  test("dismissing keeps the document open and its copy untouched", () => {
    const choice = createDraftConflictChoice();
    const { calls, route } = blockedLeave();
    choice.offer(refused(), route);

    choice.dismiss();
    choice.discard();

    expect(calls).toEqual([]);
  });

  // Closing the window and then quitting both hit the same refused copy;
  // discarding carries out the latest leave the reader asked for.
  test("a later blocked leave replaces the earlier one", () => {
    const choice = createDraftConflictChoice();
    const first = blockedLeave();
    const second = blockedLeave();
    choice.offer(refused(), first.route);
    choice.offer(refused(), second.route);

    choice.discard();

    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(["discard", "leave"]);
  });

  test("notifies subscribers when the choice opens and closes", () => {
    const choice = createDraftConflictChoice();
    const seen: boolean[] = [];
    const unsubscribe = choice.subscribe(() => seen.push(choice.pending()));
    choice.offer(refused(), blockedLeave().route);
    choice.dismiss();
    unsubscribe();
    choice.offer(refused(), blockedLeave().route);

    expect(seen).toEqual([true, false]);
  });
});
