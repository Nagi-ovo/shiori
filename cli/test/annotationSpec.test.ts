import { describe, expect, test } from "bun:test";
import {
  MAX_ANNOTATIONS_PER_SPEC,
  MAX_POINTS_PER_ANNOTATION,
  MAX_RECTS_PER_ANNOTATION,
  MAX_TEXT_CHARACTERS,
  MAX_TOTAL_TEXT_CHARACTERS,
  annotationSpec,
  annotationSpecByteLength,
  annotationSpecViolation,
} from "../src/annotationSpec";

describe("annotation spec limits", () => {
  test("measures the exact compact redirected output including newline", () => {
    const spec = annotationSpec([]);
    expect(annotationSpecByteLength(spec)).toBe(
      new TextEncoder().encode(`${JSON.stringify(spec)}\n`).byteLength,
    );
  });

  test("shares annotate limits with extract --as-spec", () => {
    expect(
      annotationSpecViolation(
        Array.from({ length: MAX_ANNOTATIONS_PER_SPEC + 1 }, () => ({})),
      ),
    ).toContain(`${MAX_ANNOTATIONS_PER_SPEC}`);
    expect(
      annotationSpecViolation([
        { type: "note", text: "x".repeat(MAX_TEXT_CHARACTERS + 1) },
      ]),
    ).toContain(`${MAX_TEXT_CHARACTERS}`);
    expect(
      annotationSpecViolation(
        Array.from({ length: 9 }, () => ({
          type: "note",
          text: "x".repeat(MAX_TEXT_CHARACTERS),
        })),
      ),
    ).toContain(`${MAX_TOTAL_TEXT_CHARACTERS}`);
    expect(
      annotationSpecViolation([
        {
          type: "ink",
          paths: [
            Array.from({ length: MAX_POINTS_PER_ANNOTATION + 1 }, () => ({
              x: 1,
              y: 1,
            })),
          ],
        },
      ]),
    ).toContain(`${MAX_POINTS_PER_ANNOTATION}`);
    expect(
      annotationSpecViolation([
        {
          type: "highlight",
          rects: Array.from({ length: MAX_RECTS_PER_ANNOTATION + 1 }, () => ({
            x: 1,
            y: 1,
            w: 1,
            h: 1,
          })),
        },
      ]),
    ).toContain(`${MAX_RECTS_PER_ANNOTATION}`);
    expect(
      annotationSpecViolation([
        { type: "note", at: { x: Number.POSITIVE_INFINITY, y: 1 } },
      ]),
    ).toContain("finite number");
    expect(
      annotationSpecViolation([
        { type: "rect", rect: { x: 1, y: 1, w: 0, h: 1 } },
      ]),
    ).toContain("must be positive");
    expect(
      annotationSpecViolation([{ type: "ink", width: 0 }]),
    ).toContain("must be positive");
  });
});
