import { describe, expect, test } from "bun:test";
import type { WorkspacePdfViewState } from "../storage/workspace";
import { explicitInitialPdfPageIndex } from "./openViewState";

const view = (pageIndex: number): WorkspacePdfViewState => ({
  pageIndex,
  scale: 1,
  fitMode: "width",
  showThumbs: true,
  showRail: false,
  railTab: "outline",
  readerMode: false,
});

describe("explicitInitialPdfPageIndex", () => {
  test("does not treat the default view page 0 as an explicit restore page", () => {
    expect(explicitInitialPdfPageIndex(undefined)).toBeUndefined();
  });

  test("uses a replacement recent entry when no workspace view was supplied", () => {
    expect(
      explicitInitialPdfPageIndex(undefined, { lastViewedPageIndex: 37 }),
    ).toBe(37);
  });

  test("lets an explicit workspace page 0 override recent state", () => {
    expect(explicitInitialPdfPageIndex(view(0), { lastViewedPageIndex: 37 })).toBe(
      0,
    );
  });

  test("uses an explicit workspace page when present", () => {
    expect(explicitInitialPdfPageIndex(view(12))).toBe(12);
  });
});
