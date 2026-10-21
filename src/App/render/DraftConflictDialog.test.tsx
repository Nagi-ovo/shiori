import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { DraftSaveError } from "../../storage/drafts";
import { createDraftConflictChoice } from "../draftConflictChoice";
import { DraftConflictDialog } from "./DraftConflictDialog";

const refused = () => new DraftSaveError("conflict", "newer draft in another window");

function blockedClose() {
  const choice = createDraftConflictChoice();
  const calls: string[] = [];
  const view = render(
    <DraftConflictDialog
      choice={choice}
      fileName="paper.pdf"
      onExport={() => calls.push("export")}
    />,
  );
  const block = () =>
    act(() => {
      choice.offer(refused(), {
        discardRefusedEdits: () => {
          calls.push("discard");
          return true;
        },
        leave: () => calls.push("close"),
      });
    });
  return { calls, view, block };
}

describe("DraftConflictDialog", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(cleanup);

  test("explains the refused copy and closes after the reader discards it", () => {
    const { calls, view, block } = blockedClose();
    expect(view.queryByRole("dialog")).toBeNull();

    block();

    expect(
      view.getByRole("dialog", { name: "This document changed in another window" }),
    ).toBeDefined();
    expect(view.getByText("paper.pdf")).toBeDefined();
    expect(
      view.getByText(
        "Another window saved newer changes to this file, so the edits in this window weren't saved as a draft. Export them as a copy to keep them, or discard them. The other window's work stays as it is.",
      ),
    ).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: "Discard and close" }));

    expect(calls).toEqual(["discard", "close"]);
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("exporting opens the export and keeps the document open", () => {
    const { calls, view, block } = blockedClose();
    block();

    fireEvent.click(view.getByRole("button", { name: "Export a copy" }));

    expect(calls).toEqual(["export"]);
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("cancelling keeps the document open and its edits on screen", () => {
    const { calls, view, block } = blockedClose();
    block();

    fireEvent.click(view.getByRole("button", { name: "Keep editing" }));

    expect(calls).toEqual([]);
    expect(view.queryByRole("dialog")).toBeNull();
  });
});
