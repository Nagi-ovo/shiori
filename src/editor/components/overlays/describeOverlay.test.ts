import { beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../../i18n";
import type {
  CalloutOverlay,
  HighlightOverlay,
  InkOverlay,
  NoteOverlay,
} from "../../../pdf/model/types";
import { describeOverlay } from "./describeOverlay";

const base = { id: "o1", pageId: "p1" };

describe("describeOverlay", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  const t = ((key: string, opts?: Record<string, unknown>) =>
    i18n.t(key, opts)) as unknown as Parameters<typeof describeOverlay>[1];

  // Ink, rectangles, stamps and signatures carry no words at all. Before this
  // they reached assistive tech as nothing whatsoever; the type name alone is
  // the difference between "there is a drawing here" and silence.
  test("a wordless annotation still names its type", () => {
    const ink: InkOverlay = {
      ...base,
      type: "ink",
      paths: [[{ x: 0, y: 0 }]],
      color: "#000",
      width: 2,
    };
    expect(describeOverlay(ink, t)).toBe("Ink");
  });

  test("a note leads with its type and then what it says", () => {
    const note: NoteOverlay = {
      ...base,
      type: "note",
      rect: { x: 0, y: 0, w: 10, h: 10 },
      color: "#ff0",
      text: "check this figure",
    };
    expect(describeOverlay(note, t)).toBe("Sticky note, check this figure");
  });

  test("an empty note says so rather than trailing off", () => {
    const note: NoteOverlay = {
      ...base,
      type: "note",
      rect: { x: 0, y: 0, w: 10, h: 10 },
      color: "#ff0",
      text: "   ",
    };
    expect(describeOverlay(note, t)).toBe("Sticky note, empty");
  });

  test("text markup reports how much of the page it covers", () => {
    const highlight: HighlightOverlay = {
      ...base,
      type: "highlight",
      rects: [
        { x: 0, y: 0, w: 10, h: 5 },
        { x: 0, y: 6, w: 10, h: 5 },
      ],
      color: "#ff0",
      opacity: 0.4,
    };
    expect(describeOverlay(highlight, t)).toBe("Highlight, 2 marks");
  });

  test("a callout counts its replies", () => {
    const callout: CalloutOverlay = {
      ...base,
      type: "callout",
      targetRects: [],
      rect: { x: 0, y: 0, w: 10, h: 10 },
      text: "needs a citation",
      fontSize: 12,
      color: "#000",
      bold: false,
      align: "left",
      fontFamily: "sans",
      thread: [
        { id: "r1", text: "agreed", at: 0 },
        { id: "r2", text: "fixed", at: 1 },
      ],
    } as CalloutOverlay;
    expect(describeOverlay(callout, t)).toBe(
      "Comment, needs a citation, 2 replies",
    );
  });

  test("a locked annotation says it is locked", () => {
    const ink: InkOverlay = {
      ...base,
      type: "ink",
      paths: [[{ x: 0, y: 0 }]],
      color: "#000",
      width: 2,
      locked: true,
    };
    expect(describeOverlay(ink, t)).toBe("Ink, locked");
  });

  // A whole paragraph pasted into a callout must not become the accessible
  // name verbatim — moving past the annotation would mean listening to all
  // of it.
  test("long text is cut rather than read out in full", () => {
    const note: NoteOverlay = {
      ...base,
      type: "note",
      rect: { x: 0, y: 0, w: 10, h: 10 },
      color: "#ff0",
      text: "x".repeat(400),
    };
    const name = describeOverlay(note, t);
    expect(name.length).toBeLessThan(120);
    expect(name.endsWith("…")).toBe(true);
  });
});
