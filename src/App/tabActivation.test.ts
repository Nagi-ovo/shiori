import { describe, expect, test } from "bun:test";
import { planTabActivation, type ActivationTarget } from "./tabActivation";

type Target = ActivationTarget<string, string, string>;

const pdf = (overrides: Partial<Target> = {}): Target => ({
  id: "b",
  kind: "pdf",
  hash: "hash-b",
  ...overrides,
});

const kinds = (steps: { kind: string }[]) => steps.map((step) => step.kind);

describe("planTabActivation", () => {
  test("a suspended PDF detaches the previous editor before its id is published, then loads", () => {
    const steps = planTabActivation(pdf({ status: "suspended" }), {
      resident: null,
      isMobile: false,
    });

    expect(kinds(steps)).toEqual([
      "setDraftNotices",
      "detachEditor",
      "publishActiveTab",
      "setExportState",
      "loadDocument",
    ]);
    expect(steps).toContainEqual({ kind: "publishActiveTab", tabId: "b" });
    expect(steps).toContainEqual({
      kind: "setExportState",
      hash: null,
      baseline: null,
      lastExport: null,
    });
  });

  test("a resident PDF re-attaches its own store without detaching", () => {
    let baselineReads = 0;
    const steps = planTabActivation(
      pdf({ exportBaselineSnapshot: "tab-baseline", lastExport: "export-1" }),
      {
        resident: {
          baseline: () => {
            baselineReads += 1;
            return "store-baseline";
          },
        },
        isMobile: false,
      },
    );

    expect(kinds(steps)).toEqual([
      "setDraftNotices",
      "publishActiveTab",
      "touchResident",
      "attachResident",
      "setExportState",
    ]);
    expect(steps.at(-1)).toEqual({
      kind: "setExportState",
      hash: "hash-b",
      baseline: "tab-baseline",
      lastExport: "export-1",
    });
    // The tab's own baseline wins; the store is not asked to compute one.
    expect(baselineReads).toBe(0);
  });

  test("a suspended Word document is loaded once it is on screen", () => {
    const steps = planTabActivation(
      { id: "w", kind: "docx", status: "suspended" },
      { resident: null, isMobile: false },
    );

    expect(steps.at(-1)).toEqual({ kind: "loadDocument", tabId: "w" });
  });

  test("a resident PDF with no recorded baseline takes the store's", () => {
    const steps = planTabActivation(pdf(), {
      resident: { baseline: () => "store-baseline" },
      isMobile: false,
    });

    expect(steps.at(-1)).toMatchObject({ baseline: "store-baseline" });
  });

  test("phones close the thumbnail rail before the PDF becomes visible", () => {
    const steps = planTabActivation(pdf(), {
      resident: { baseline: () => "k" },
      isMobile: true,
    });

    expect(kinds(steps).slice(0, 3)).toEqual([
      "setDraftNotices",
      "hideThumbs",
      "publishActiveTab",
    ]);
  });

  test("a text document detaches the PDF editor and clears export state", () => {
    const steps = planTabActivation(
      { id: "t", kind: "markdown", hash: "ignored" },
      { resident: null, isMobile: false },
    );

    expect(kinds(steps)).toEqual([
      "setDraftNotices",
      "publishActiveTab",
      "detachEditor",
      "setExportState",
    ]);
    expect(steps.at(-1)).toMatchObject({ hash: null, baseline: null });
  });

  test("closing the last tab leaves no active tab and an empty editor", () => {
    const steps = planTabActivation(null, { resident: null, isMobile: false });

    expect(steps).toEqual([
      { kind: "setDraftNotices", pending: null, deferred: null, restored: null },
      { kind: "detachEditor" },
      { kind: "publishActiveTab", tabId: null },
      { kind: "setExportState", hash: null, baseline: null, lastExport: null },
    ]);
  });

  test("the target's draft decision becomes exactly one notice", () => {
    const pending = planTabActivation(
      pdf({ draftRestore: { mode: "pending", draft: "d1" }, restoredDraft: "n1" }),
      { resident: null, isMobile: false },
    );
    const deferred = planTabActivation(
      pdf({ draftRestore: { mode: "deferred", draft: "d2" } }),
      { resident: null, isMobile: false },
    );

    expect(pending[0]).toEqual({
      kind: "setDraftNotices",
      pending: "d1",
      deferred: null,
      restored: "n1",
    });
    expect(deferred[0]).toEqual({
      kind: "setDraftNotices",
      pending: null,
      deferred: "d2",
      restored: null,
    });
  });
});
