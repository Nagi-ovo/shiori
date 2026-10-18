import { describe, expect, test } from "bun:test";
import {
  createTrailingTerminalResize,
  type TerminalResizeTimers,
} from "./embeddedTerminalRuntime";

function manualTimers() {
  let callback: (() => void) | null = null;
  let delayMs: number | null = null;
  let clearCount = 0;
  const timers: TerminalResizeTimers = {
    set(next, delay) {
      callback = next;
      delayMs = delay;
      return next;
    },
    clear() {
      clearCount += 1;
      callback = null;
    },
  };
  return {
    timers,
    get delayMs() {
      return delayMs;
    },
    get clearCount() {
      return clearCount;
    },
    flush() {
      const next = callback;
      callback = null;
      next?.();
    },
  };
}

describe("embedded terminal resize", () => {
  test("delivers only the trailing dimensions during a drag", () => {
    const clock = manualTimers();
    const delivered: Array<[number, number]> = [];
    const scheduler = createTrailingTerminalResize(
      ({ cols, rows }) => delivered.push([cols, rows]),
      180,
      clock.timers,
    );

    scheduler.markDelivered({ sessionId: "s", cols: 80, rows: 24 });
    scheduler.schedule({ sessionId: "s", cols: 81, rows: 24 });
    scheduler.schedule({ sessionId: "s", cols: 96, rows: 30 });
    scheduler.schedule({ sessionId: "s", cols: 112, rows: 36 });

    expect(delivered).toEqual([]);
    expect(clock.delayMs).toBe(180);
    expect(clock.clearCount).toBe(2);
    clock.flush();
    expect(delivered).toEqual([[112, 36]]);
  });

  test("deduplicates unchanged sizes and cancels a drag returning to the current size", () => {
    const clock = manualTimers();
    const delivered: Array<[number, number]> = [];
    const scheduler = createTrailingTerminalResize(
      ({ cols, rows }) => delivered.push([cols, rows]),
      180,
      clock.timers,
    );

    scheduler.markDelivered({ sessionId: "s", cols: 100, rows: 30 });
    scheduler.schedule({ sessionId: "s", cols: 101, rows: 30 });
    scheduler.schedule({ sessionId: "s", cols: 100, rows: 30 });
    clock.flush();
    scheduler.schedule({ sessionId: "s", cols: 100, rows: 30 });
    clock.flush();

    expect(delivered).toEqual([]);
  });

  test("deduplicates dimensions that normalize to the same PTY size", () => {
    const clock = manualTimers();
    const delivered: Array<[number, number]> = [];
    const scheduler = createTrailingTerminalResize(
      ({ cols, rows }) => delivered.push([cols, rows]),
      180,
      clock.timers,
    );

    scheduler.markDelivered({ sessionId: "s", cols: 400, rows: 200 });
    scheduler.schedule({ sessionId: "s", cols: 900.5, rows: 300.2 });
    clock.flush();

    expect(delivered).toEqual([]);
  });
});
