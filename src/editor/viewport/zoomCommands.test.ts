import { describe, expect, test } from "bun:test";
import { MAX_ZOOM_SCALE, MIN_ZOOM_SCALE } from "../zoomLimits";
import { typedZoom, zoomStepDown, zoomStepUp } from "./zoomCommands";

// What can go wrong stepping and typing a zoom:
// - after a fit or a pinch the scale sits between stops; a step must land on
//   the neighbouring stop, not add a fixed amount and stay off the ladder
//   (100% unreachable by stepping back);
// - a scale a float rounding away from a stop is treated as below it, so
//   "up" lands on the stop it already shows;
// - stepping past the ends: up at the top, down at the floor;
// - a view whose floor is above the ladder's lowest stops (PDF) steps below
//   its floor; a view with a lower floor (text) cannot reach its stops;
// - a page fitted below the floor (a wide DOCX page on a phone) is enlarged
//   by "zoom out";
// - typed zoom: a percent sign, spaces, junk, zero, negatives, out of range.

describe("zoom steps", () => {
  test("an off-ladder scale steps to the neighbouring stops", () => {
    expect(zoomStepUp(1.497)).toBe(1.5);
    expect(zoomStepDown(1.497)).toBe(1.25);
    expect(zoomStepDown(1.05)).toBe(1);
  });

  test("a scale a rounding error off a stop counts as on it", () => {
    expect(zoomStepUp(1.25 - 1e-9)).toBe(1.5);
    expect(zoomStepDown(1.25 + 1e-9)).toBe(1.1);
  });

  test("the ends hold", () => {
    expect(zoomStepUp(MAX_ZOOM_SCALE)).toBe(MAX_ZOOM_SCALE);
    expect(zoomStepUp(7)).toBe(MAX_ZOOM_SCALE);
    expect(zoomStepDown(MIN_ZOOM_SCALE)).toBe(MIN_ZOOM_SCALE);
  });

  test("the PDF floor is the lowest stop it steps to", () => {
    expect(zoomStepDown(0.5)).toBe(MIN_ZOOM_SCALE);
    expect(zoomStepUp(0.1)).toBe(MIN_ZOOM_SCALE);
  });

  test("a lower floor reaches the stops below the PDF floor", () => {
    expect(zoomStepDown(0.35, 0.2)).toBe(0.3);
    expect(zoomStepDown(0.25, 0.2)).toBe(0.2);
    expect(zoomStepUp(0.2, 0.2)).toBe(0.25);
  });

  test("zoom out never enlarges a page fitted below the floor", () => {
    expect(zoomStepDown(0.12, 0.2)).toBe(0.12);
    expect(zoomStepUp(0.12, 0.2)).toBe(0.2);
  });
});

describe("typed zoom", () => {
  test("reads a percent, with or without the sign", () => {
    expect(typedZoom("150")).toBe(1.5);
    expect(typedZoom(" 75 % ")).toBe(0.75);
  });

  test("clamps to the floor and the top", () => {
    expect(typedZoom("10")).toBe(MIN_ZOOM_SCALE);
    expect(typedZoom("10", 0.2)).toBe(0.2);
    expect(typedZoom("5000")).toBe(MAX_ZOOM_SCALE);
  });

  test("ignores what is not a zoom", () => {
    expect(typedZoom("")).toBeNull();
    expect(typedZoom("abc")).toBeNull();
    expect(typedZoom("0")).toBeNull();
  });
});
