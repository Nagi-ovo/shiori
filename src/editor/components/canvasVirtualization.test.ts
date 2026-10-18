import { describe, expect, test } from "bun:test";
import { canvasVirtualizationProps } from "./canvasVirtualization";

describe("PDF canvas virtualization", () => {
  // A fit-width page is taller than the pixel lookahead, so without a
  // minimum item count the next page mounted only once it scrolled in.
  test("keeps one adjacent page mounted before it enters the viewport", () => {
    expect(canvasVirtualizationProps(false).minOverscanItemCount).toBe(1);
    expect(canvasVirtualizationProps(true).minOverscanItemCount).toBe(1);
  });
});
