import { describe, expect, test } from "bun:test";
import type { PageModel } from "../model/types";
import {
  AnnotationSpecError,
  parseAnnotationSpec,
} from "./parseSpec";
import {
  NOTE_DEFAULT_COLOR,
  NOTE_DEFAULT_HEIGHT_PT,
  NOTE_DEFAULT_WIDTH_PT,
} from "../model/note";

const pages: PageModel[] = [
  {
    id: "page-a",
    sourceIndex: 0,
    rotation: 0,
    widthPt: 612,
    heightPt: 792,
  },
  {
    id: "page-b",
    sourceIndex: 1,
    rotation: 90,
    widthPt: 792,
    heightPt: 612,
  },
];

describe("portable annotation spec parser", () => {
  test("uses canonical note presentation defaults and one batch timestamp", () => {
    const overlays = parseAnnotationSpec(
      {
        annotations: [
          { type: "note", page: 1, at: { x: 10, y: 20 }, text: "first" },
          { type: "note", page: 1, at: { x: 30, y: 40 }, text: "second" },
        ],
      },
      pages,
      { namespace: "note-defaults", now: 1234 },
    );

    expect(overlays).toHaveLength(2);
    for (const overlay of overlays) {
      expect(overlay).toMatchObject({
        type: "note",
        color: NOTE_DEFAULT_COLOR,
        rect: {
          w: NOTE_DEFAULT_WIDTH_PT,
          h: NOTE_DEFAULT_HEIGHT_PT,
        },
        createdAt: 1234,
        updatedAt: 1234,
      });
    }
  });

  test("strictly parses all nine types with request-namespaced ids", () => {
    const overlays = parseAnnotationSpec(
      {
        schema: "shiori.annotations/v1",
        annotations: [
          {
            type: "highlight",
            page: 1,
            rects: [{ x: 10, y: 20, w: 30, h: 8 }],
            color: "#f6c744",
            opacity: 0.35,
            quote: "informational",
          },
          {
            type: "underline",
            page: 1,
            rects: [{ x: 10, y: 40, w: 30, h: 8 }],
            color: "#336699",
            opacity: 1,
          },
          {
            type: "strikethrough",
            page: 1,
            rects: [{ x: 10, y: 60, w: 30, h: 8 }],
            color: "#993333",
            opacity: 1,
          },
          {
            type: "note",
            page: 2,
            at: { x: 50, y: 60 },
            text: "Review",
            color: "#f6c744",
          },
          {
            type: "callout",
            page: 1,
            targetRects: [{ x: 80, y: 540, w: 90, h: 14 }],
            rect: { x: 210, y: 520, w: 144, h: 54 },
            leader: [
              { x: 170, y: 547 },
              { x: 190, y: 560 },
              { x: 210, y: 547 },
            ],
            leaderKind: "polyline",
            text: "Explain this",
            fontSize: 12,
            color: "#b13a2e",
            align: "right",
          },
          {
            type: "ink",
            page: 2,
            paths: [[{ x: 1, y: 2 }, { x: 3, y: 4 }]],
            color: "#111111",
            width: 2,
          },
          {
            type: "rect",
            page: 2,
            rect: { x: 10, y: 10, w: 40, h: 50 },
            color: "#222222",
            strokeWidth: 2,
            fill: null,
          },
          {
            type: "stamp",
            page: 2,
            kind: "check",
            rect: { x: 70, y: 70, w: 20, h: 20 },
            color: "#228844",
            strokeWidth: 2,
          },
          {
            type: "text",
            page: 1,
            rect: { x: 90, y: 90, w: 120, h: 30 },
            text: "hello",
            fontSize: 14,
            color: "#1a1815",
            bold: false,
            align: "left",
            fontFamily: "sans",
          },
        ],
      },
      pages,
      { namespace: "request-42", idPrefix: "live" },
    );

    expect(overlays.map((overlay) => overlay.type)).toEqual([
      "highlight",
      "underline",
      "strikethrough",
      "note",
      "callout",
      "ink",
      "rect",
      "stamp",
      "text",
    ]);
    expect(overlays.map((overlay) => overlay.id)).toEqual([
      "live-highlight-request-42-1",
      "live-underline-request-42-2",
      "live-strikethrough-request-42-3",
      "live-note-request-42-4",
      "live-callout-request-42-5",
      "live-ink-request-42-6",
      "live-rect-request-42-7",
      "live-stamp-request-42-8",
      "live-text-request-42-9",
    ]);
    expect(overlays[3]).toMatchObject({
      pageId: "page-b",
      rect: { x: 50, y: 60, w: 168, h: 94 },
    });
    expect(overlays[4]).toMatchObject({
      type: "callout",
      leaderKind: "polyline",
      align: "right",
    });
  });

  test("auto-places same-page callout labels without stacking them", () => {
    const overlays = parseAnnotationSpec(
      {
        annotations: [
          {
            type: "callout",
            page: 1,
            targetRects: [{ x: 250, y: 380, w: 80, h: 14 }],
            text: "First",
          },
          {
            type: "callout",
            page: 1,
            targetRects: [{ x: 250, y: 380, w: 80, h: 14 }],
            text: "Second",
          },
        ],
      },
      pages,
      { namespace: "placement" },
    );
    expect(overlays[0]?.type).toBe("callout");
    expect(overlays[1]?.type).toBe("callout");
    if (overlays[0]?.type !== "callout" || overlays[1]?.type !== "callout") {
      throw new Error("missing callouts");
    }
    expect(overlays[1].rect).not.toEqual(overlays[0].rect);
  });

  test("keeps quote informational and rejects quote-only anchoring", () => {
    expect(() =>
      parseAnnotationSpec(
        {
          schema: "shiori.annotations/v1",
          annotations: [
            {
              type: "highlight",
              page: 1,
              quote: "find me",
              color: "#f6c744",
              opacity: 0.35,
            },
          ],
        },
        pages,
        { namespace: "request-quote" },
      ),
    ).toThrow("rects are required; quote-only anchoring is not supported");
  });

  test("rejects unknown fields, unsupported types, and out-of-range pages", () => {
    const cases = [
      {
        schema: "shiori.annotations/v1",
        annotations: [{ type: "note", page: 1, at: { x: 1, y: 2 }, text: "x", color: "#ffffff", locked: true }],
      },
      {
        schema: "shiori.annotations/v1",
        annotations: [{ type: "image", page: 1 }],
      },
      {
        schema: "shiori.annotations/v1",
        annotations: [{ type: "note", page: 9, at: { x: 1, y: 2 }, text: "x", color: "#ffffff" }],
      },
    ];
    for (const spec of cases) {
      expect(() =>
        parseAnnotationSpec(spec, pages, { namespace: "strict" }),
      ).toThrow(AnnotationSpecError);
    }
  });

  test("bounds errors derived from attacker-controlled JSON keys", () => {
    const hugeKey = "🧪".repeat(100_000);
    let error: unknown;
    try {
      parseAnnotationSpec(
        {
          schema: "shiori.annotations/v1",
          annotations: [
            {
              type: "note",
              page: 1,
              at: { x: 1, y: 2 },
              text: "x",
              color: "#ffffff",
              [hugeKey]: true,
            },
          ],
        },
        pages,
        { namespace: "bounded-error" },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AnnotationSpecError);
    expect(new TextEncoder().encode((error as Error).message).length).toBeLessThanOrEqual(
      2_048,
    );
  });
});
