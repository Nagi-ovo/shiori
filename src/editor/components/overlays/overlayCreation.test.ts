import { describe, expect, test } from "bun:test";
import type { PageModel } from "../../../pdf/model/types";
import type { AnnotationDefaults } from "../../store/store";
import { STAMP_DEFAULT_SIZE_PT } from "./overlayConstants";
import {
  NOTE_DEFAULT_HEIGHT_PT,
  NOTE_DEFAULT_WIDTH_PT,
} from "../../../pdf/model/note";
import { finishCreationDrag, isCreationDrag } from "./overlayCreation";

const page: PageModel = {
  id: "page-1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 200,
  heightPt: 300,
};

const annotDefaults = {
  textMarkupTool: "highlight",
  highlightColor: "#fff08a",
  highlightOpacity: 0.45,
  underlineColor: "#4f46e5",
  underlineOpacity: 1,
  strikethroughColor: "#ef4444",
  strikethroughOpacity: 1,
  inkColor: "#111827",
  inkWidth: 3,
  stampKind: "check",
  stampColor: "#16a34a",
  stampStrokeWidth: 2,
  rectColor: "#2563eb",
  rectStrokeWidth: 1.5,
  rectFill: null,
  noteColor: "#facc15",
} satisfies AnnotationDefaults;

const textDefaults = {
  fontSize: 16,
  color: "#111827",
  bold: false,
  italic: false,
  align: "left",
  fontFamily: "sans",
} satisfies Store["textDefaults"];

function makeId() {
  let next = 0;
  return () => {
    next += 1;
    return `overlay-${next}`;
  };
}

describe("overlay creation gestures", () => {
  test("recognizes only creation drag kinds", () => {
    expect(isCreationDrag({ kind: "ink", points: [] })).toBe(true);
    expect(
      isCreationDrag({
        kind: "marquee",
        startX: 0,
        startY: 0,
        curX: 1,
        curY: 1,
        additive: false,
      }),
    ).toBe(false);
    expect(isCreationDrag({ kind: "none" })).toBe(false);
  });

  test("returns no overlay for a one-point ink gesture", () => {
    const result = finishCreationDrag({
      drag: { kind: "ink", points: [{ x: 10, y: 20 }] },
      page,
      scale: 1,
      annotDefaults,
      textDefaults,
      makeId: makeId(),
    });

    expect(result).toEqual({ kind: "none" });
  });

  test("creates ink paths in PDF user space", () => {
    const result = finishCreationDrag({
      drag: {
        kind: "ink",
        points: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
      },
      page,
      scale: 1,
      annotDefaults,
      textDefaults,
      makeId: makeId(),
    });

    expect(result.kind).toBe("overlay");
    if (result.kind !== "overlay") return;
    expect(result.overlay).toMatchObject({
      type: "ink",
      id: "overlay-1",
      pageId: page.id,
      color: annotDefaults.inkColor,
      width: annotDefaults.inkWidth,
      paths: [
        [
          { x: 10, y: 280 },
          { x: 30, y: 260 },
        ],
      ],
    });
  });

  test("returns highlight geometry for the merge pipeline", () => {
    const result = finishCreationDrag({
      drag: { kind: "highlight", startX: 10, startY: 20, curX: 50, curY: 70 },
      page,
      scale: 1,
      annotDefaults,
      textDefaults,
      makeId: makeId(),
    });

    expect(result).toEqual({
      kind: "highlight",
      rect: { x: 10, y: 230, w: 40, h: 50 },
    });
  });

  test("preserves small-click defaults for stamp, text, and note", () => {
    const id = makeId();
    const stamp = finishCreationDrag({
      drag: { kind: "stamp", startX: 40, startY: 80, curX: 41, curY: 81 },
      page,
      scale: 1,
      annotDefaults,
      textDefaults,
      makeId: id,
    });
    const text = finishCreationDrag({
      drag: { kind: "text", startX: 20, startY: 30, curX: 21, curY: 31 },
      page,
      scale: 1,
      annotDefaults,
      textDefaults,
      makeId: id,
    });
    const note = finishCreationDrag({
      drag: { kind: "note", startX: 60, startY: 90, curX: 61, curY: 91 },
      page,
      scale: 1,
      annotDefaults,
      textDefaults,
      makeId: id,
    });

    expect(stamp.kind).toBe("overlay");
    expect(text.kind).toBe("overlay");
    expect(note.kind).toBe("overlay");
    if (
      stamp.kind !== "overlay" ||
      text.kind !== "overlay" ||
      note.kind !== "overlay"
    ) {
      return;
    }

    expect(stamp.overlay).toMatchObject({
      type: "stamp",
      id: "overlay-1",
      rect: {
        x: 40 - STAMP_DEFAULT_SIZE_PT / 2,
        y: 300 - 80 - STAMP_DEFAULT_SIZE_PT / 2,
        w: STAMP_DEFAULT_SIZE_PT,
        h: STAMP_DEFAULT_SIZE_PT,
      },
      kind: annotDefaults.stampKind,
    });
    expect(text).toMatchObject({
      kind: "overlay",
      edit: true,
      focus: true,
      clearEditingFirst: true,
    });
    expect(text.overlay).toMatchObject({
      type: "text",
      id: "overlay-2",
      rect: { x: 20, y: 228, w: 180, h: 42 },
      fontSize: textDefaults.fontSize,
      fontFamily: textDefaults.fontFamily,
    });
    expect(note).toMatchObject({
      kind: "overlay",
      edit: true,
      focus: true,
    });
    expect(note.overlay).toMatchObject({
      type: "note",
      id: "overlay-3",
      rect: { x: 60, y: 116, w: 168, h: 94 },
      color: annotDefaults.noteColor,
    });
    if (note.overlay.type !== "note") return;
    expect(note.overlay.createdAt).toEqual(expect.any(Number));
  });

  test("keeps the canonical PDF note size across zoom and page rotation", () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      for (const scale of [0.75, 1, 2]) {
        const result = finishCreationDrag({
          drag: { kind: "note", startX: 40, startY: 50, curX: 41, curY: 51 },
          page: { ...page, rotation },
          scale,
          annotDefaults,
          textDefaults,
          makeId: makeId(),
        });

        expect(result.kind).toBe("overlay");
        if (result.kind !== "overlay" || result.overlay.type !== "note") {
          continue;
        }
        expect(result.overlay.rect.w).toBeCloseTo(NOTE_DEFAULT_WIDTH_PT, 8);
        expect(result.overlay.rect.h).toBeCloseTo(NOTE_DEFAULT_HEIGHT_PT, 8);
      }
    }
  });
});

// Canvas places an armed tool from the keyboard by synthesising a drag whose
// start and end are the same point — the page centre. It relies on this
// function treating that as a tap and supplying the tool's default size, so
// that the keyboard and the mouse cannot drift apart on what "a new note"
// means. These pin that contract down from the keyboard's side.
describe("keyboard placement (zero-extent drag at a point)", () => {
  const CENTRE = { startX: 100, startY: 150, curX: 100, curY: 150 };

  test("every placeable tool yields an overlay rather than nothing", () => {
    for (const kind of ["note", "text", "stamp"] as const) {
      const result = finishCreationDrag({
        drag: { kind, ...CENTRE },
        page,
        scale: 1,
        annotDefaults,
        textDefaults,
        activeSignature: null,
        makeId: makeId(),
      });
      expect(result.kind).toBe("overlay");
    }
  });

  test("a placed note gets the canonical default size, not a zero-size rect", () => {
    const result = finishCreationDrag({
      drag: { kind: "note", ...CENTRE },
      page,
      scale: 1,
      annotDefaults,
      textDefaults,
      activeSignature: null,
      makeId: makeId(),
    });
    expect(result.kind).toBe("overlay");
    if (result.kind !== "overlay") return;
    expect(result.overlay.rect.w).toBeCloseTo(NOTE_DEFAULT_WIDTH_PT, 8);
    expect(result.overlay.rect.h).toBeCloseTo(NOTE_DEFAULT_HEIGHT_PT, 8);
  });

  test("a placed stamp gets the canonical default size", () => {
    const result = finishCreationDrag({
      drag: { kind: "stamp", ...CENTRE },
      page,
      scale: 1,
      annotDefaults,
      textDefaults,
      activeSignature: null,
      makeId: makeId(),
    });
    expect(result.kind).toBe("overlay");
    if (result.kind !== "overlay") return;
    expect(result.overlay.rect.w).toBeCloseTo(STAMP_DEFAULT_SIZE_PT, 8);
    expect(result.overlay.rect.h).toBeCloseTo(STAMP_DEFAULT_SIZE_PT, 8);
  });

  // Text and note open for editing on arrival; Canvas forwards that to
  // setEditingOverlayId so a placed text box is ready to type into.
  test("text and note ask to be opened for editing", () => {
    for (const kind of ["text", "note"] as const) {
      const result = finishCreationDrag({
        drag: { kind, ...CENTRE },
        page,
        scale: 1,
        annotDefaults,
        textDefaults,
        activeSignature: null,
        makeId: makeId(),
      });
      expect(result.kind).toBe("overlay");
      if (result.kind !== "overlay") continue;
      expect(result.edit).toBe(true);
    }
  });

  // Why Canvas has to give the rectangle an explicit extent instead of
  // reusing the zero-extent trick: a tap with the rectangle tool yields
  // nothing on purpose, so a stray click cannot leave a stray box behind.
  // If that ever changes, keyboard placement should drop its own constant.
  test("rectangle still refuses to appear from a tap", () => {
    const result = finishCreationDrag({
      drag: { kind: "rect", ...CENTRE },
      page,
      scale: 1,
      annotDefaults,
      textDefaults,
      activeSignature: null,
      makeId: makeId(),
    });
    expect(result.kind).toBe("none");
  });

  // Signature placement must not invent an overlay out of nothing.
  test("signature places nothing when none is active", () => {
    const result = finishCreationDrag({
      drag: { kind: "signature", ...CENTRE },
      page,
      scale: 1,
      annotDefaults,
      textDefaults,
      activeSignature: null,
      makeId: makeId(),
    });
    expect(result.kind).toBe("none");
  });
});
