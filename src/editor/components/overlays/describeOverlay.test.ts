import { beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../../i18n";
import type {
  CalloutOverlay,
  HighlightOverlay,
  InkOverlay,
  NoteOverlay,
  Overlay,
  OverlayType,
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

  // Rectangles, images and edited original text were announced by their
  // internal slugs ("rect", "image", "contentText") in every language,
  // because the lookup fell back to the raw type when no label existed.
  // A Record keyed by OverlayType makes the next new type fail to compile
  // here until it has a sample, and so a name.
  const rect = { x: 0, y: 0, w: 10, h: 10 };
  const sampleOf: Record<OverlayType, Overlay> = {
    highlight: { ...base, type: "highlight", rects: [rect], color: "#ff0", opacity: 0.4 },
    underline: { ...base, type: "underline", rects: [rect], color: "#000", opacity: 1 },
    strikethrough: { ...base, type: "strikethrough", rects: [rect], color: "#000", opacity: 1 },
    ink: { ...base, type: "ink", paths: [[{ x: 0, y: 0 }]], color: "#000", width: 2 },
    image: { ...base, type: "image", rect, dataUrl: "data:,", mimeType: "image/png" },
    stamp: { ...base, type: "stamp", kind: "check", rect, color: "#000", strokeWidth: 2 },
    rect: { ...base, type: "rect", rect, color: "#000", strokeWidth: 1, fill: null },
    note: { ...base, type: "note", rect, color: "#ff0", text: "" },
    text: { ...base, type: "text", rect, text: "" },
    callout: { ...base, type: "callout", rect, text: "" },
    contentText: { ...base, type: "contentText", rect, text: "", originalText: "" },
  } as Record<OverlayType, Overlay>;
  const kindOf = (overlay: Overlay) => describeOverlay(overlay, t).split(", ")[0];

  test("rectangles, images and edited text are named in words", () => {
    expect(kindOf(sampleOf.rect)).toBe("Rectangle");
    expect(kindOf(sampleOf.image)).toBe("Image");
    expect(kindOf(sampleOf.contentText)).toBe("Edited text");
  });

  test("a placed signature is named as a signature, not as an image or ink", () => {
    expect(kindOf({ ...sampleOf.image, source: "signature" } as Overlay)).toBe("Signature");
    expect(kindOf({ ...sampleOf.ink, source: "signature" } as Overlay)).toBe("Signature");
  });

  for (const lang of ["zh", "ja"] as const) {
    test(`every annotation type has a ${lang} name rather than a code slug`, async () => {
      await i18n.changeLanguage(lang);
      try {
        for (const overlay of Object.values(sampleOf)) {
          // Every zh / ja type label is written in CJK script.
          expect(kindOf(overlay)).not.toMatch(/^[\x20-\x7e]*$/);
        }
      } finally {
        await i18n.changeLanguage("en");
      }
    });
  }
});
