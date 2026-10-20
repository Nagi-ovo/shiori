import { describe, expect, test } from "bun:test";
import { buildLiveAnnotationDigest } from "./annotationDigest";
import type { Overlay, PageModel } from "../pdf/model/types";

const pages: PageModel[] = [
  { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
];

function callout(id: string, overrides: Partial<Overlay>): Overlay {
  return {
    type: "callout",
    id,
    pageId: "p1",
    targetRects: [{ x: 0, y: 0, w: 10, h: 10 }],
    rect: { x: 0, y: 0, w: 10, h: 10 },
    text: "why is this bound tight?",
    fontSize: 11,
    color: "#000000",
    bold: false,
    align: "left",
    fontFamily: "sans",
    ...overrides,
  } as Overlay;
}

describe("blank thread turns", () => {
  // Import folds a reply whose /Contents another tool cleared into the
  // thread as an empty turn. The CLI requires every turn's text to be
  // non-empty and discards the WHOLE context otherwise, so one blank reply
  // made `app context` and `app annotate` fail for the document.
  test("are left out instead of sent as empty text", () => {
    const overlays = [
      callout("c1", {
        thread: [
          { id: "t1", role: "user", text: "   " },
          { id: "t2", role: "agent", text: "same argument" },
          { id: "t3", role: "user", text: "" },
        ],
      } as Partial<Overlay>),
    ];

    const { annotations, truncated } = buildLiveAnnotationDigest(overlays, pages);

    expect(annotations[0]?.thread).toEqual([
      { role: "agent", text: "same argument" },
    ]);
    // Nothing readable was cut, so the digest is still complete.
    expect(truncated).toBe(false);
  });

  test("leave a callout with nothing else to read out of the digest", () => {
    const overlays = [
      callout("c1", {
        text: "",
        thread: [{ id: "t1", role: "user", text: "  " }],
      } as Partial<Overlay>),
    ];

    expect(buildLiveAnnotationDigest(overlays, pages).annotations).toEqual([]);
  });

  test("do not push a readable turn out of the kept window", () => {
    const readable = Array.from({ length: 12 }, (_, index) => ({
      id: `t${index}`,
      role: "user" as const,
      text: `turn ${index}`,
    }));
    const overlays = [
      callout("c1", {
        thread: [...readable, { id: "blank", role: "agent", text: " " }],
      } as Partial<Overlay>),
    ];

    const { annotations, truncated } = buildLiveAnnotationDigest(overlays, pages);

    expect(annotations[0]?.thread?.map((turn) => turn.text)).toEqual(
      readable.map((turn) => turn.text),
    );
    expect(truncated).toBe(false);
  });
});
