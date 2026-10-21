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

/*
 * A crash log names the draft row its writer last saw (`base`). Ways the
 * choice can go wrong:
 * - the writer's own edits after its own save are dropped (base matches);
 * - another window saved since the log's writer last saw the row, and the
 *   newer log replaces that work on the next open;
 * - the writer saw no row, another window wrote one, and the log wins;
 * - the row is gone (evicted, removed) and its only copy, the log, is lost;
 * - a log or row from an older build (no base, no revision) stops recovering.
 */
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

  test("a log based on the row as it stands wins when newer", () => {
    const draft = { lastTouched: 1, revision: "r1", model: model("draft"), history: [] };
    const log = { lastTouched: 2, base: { lastTouched: 1, revision: "r1" }, model: model("logged") };

    expect(chooseDraftRecovery(draft, log, [page("fresh")], [])?.pages[0]?.id).toBe("logged");
  });

  test("a newer log written over an older row loses to the row another window saved", () => {
    const draft = { lastTouched: 3, revision: "theirs", model: model("draft"), history: [] };
    const stale = { lastTouched: 4, base: { lastTouched: 1, revision: "r1" }, model: model("logged") };
    const blind = { lastTouched: 4, base: null, model: model("logged") };

    expect(chooseDraftRecovery(draft, stale, [page("fresh")], [])?.pages[0]?.id).toBe("draft");
    expect(chooseDraftRecovery(draft, blind, [page("fresh")], [])?.pages[0]?.id).toBe("draft");
  });

  test("a log whose row is gone is still recovered", () => {
    const log = { lastTouched: 2, base: { lastTouched: 1, revision: "r1" }, model: model("logged") };

    expect(chooseDraftRecovery(null, log, [page("fresh")], [])?.pages[0]?.id).toBe("logged");
  });

  test("a row from before revisions matches a log based on it", () => {
    const draft = { lastTouched: 1, model: model("draft"), history: [] };
    const log = { lastTouched: 2, base: { lastTouched: 1, revision: null }, model: model("logged") };

    expect(chooseDraftRecovery(draft, log, [page("fresh")], [])?.pages[0]?.id).toBe("logged");
  });
});
