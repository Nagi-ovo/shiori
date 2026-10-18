import { describe, expect, test } from "bun:test";
import type { DocumentModel, PageModel } from "../../pdf/model/types";
import { chooseDraftRecovery } from "./recovery";

const page = (id: string, widthPt = 612): PageModel => ({
  id,
  sourceIndex: 0,
  rotation: 0,
  widthPt,
  heightPt: 792,
});
const model = (id: string): DocumentModel => ({ pages: [page(id, 100)], overlays: [] });

describe("chooseDraftRecovery", () => {
  test("edits logged after the last draft save win, with the draft as their undo step", () => {
    const draft = { lastTouched: 1, model: model("draft"), history: [] };
    const log = { lastTouched: 2, model: model("logged") };

    const recovery = chooseDraftRecovery(draft, log, [page("fresh")], []);

    expect(recovery?.pages.map((p) => p.id)).toEqual(["logged"]);
    expect(recovery?.history).toHaveLength(1);
    expect((recovery?.history[0] as DocumentModel).pages[0]?.id).toBe("draft");
  });

  test("an older log loses to the draft, and page boxes come from the file", () => {
    const draft = { lastTouched: 2, model: model("draft"), history: [] };
    const log = { lastTouched: 1, model: model("logged") };

    const recovery = chooseDraftRecovery(draft, log, [page("fresh", 595)], []);

    expect(recovery?.pages).toMatchObject([{ id: "draft", widthPt: 595 }]);
  });

  test("nothing to recover opens the file as it is", () => {
    expect(chooseDraftRecovery(undefined, null, [page("fresh")], [])).toBeNull();
  });
});
