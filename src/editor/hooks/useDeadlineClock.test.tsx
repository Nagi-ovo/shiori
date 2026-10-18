import "../../test/setupDom";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useDeadlineClock } from "./useDeadlineClock";

afterEach(() => {
  cleanup();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useDeadlineClock", () => {
  test("ticks exactly once when the deadline passes", async () => {
    let renders = 0;
    const deadline = Date.now() + 30;
    const view = renderHook(() => {
      renders += 1;
      // After the deadline there is nothing further to wait for.
      return useDeadlineClock((now) => (now < deadline ? deadline : null));
    });
    const before = view.result.current;
    expect(renders).toBe(1);
    await wait(80);
    expect(renders).toBe(2);
    // setTimeout may fire a millisecond early; only the refresh matters.
    expect(view.result.current).toBeGreaterThan(before);
    await wait(80);
    expect(renders).toBe(2);
  });

  test("schedules nothing for a null deadline", async () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useDeadlineClock(() => null);
    });
    await wait(40);
    expect(renders).toBe(1);
  });

  // A deadline behind the stored clock means the clock is stale: refresh it
  // at once rather than leaving a label frozen on old time.
  test("refreshes a stale clock immediately", async () => {
    let renders = 0;
    let calls = 0;
    renderHook(() => {
      renders += 1;
      return useDeadlineClock((now) => (calls++ === 0 ? now - 1 : null));
    });
    await wait(20);
    expect(renders).toBe(2);
  });

  test("drops the timer while hidden and catches up on return", async () => {
    let renders = 0;
    const deadline = Date.now() + 30;
    renderHook(() => {
      renders += 1;
      return useDeadlineClock((now) => (now < deadline ? deadline : null));
    });
    setHidden(true);
    await wait(80);
    expect(renders).toBe(1);
    setHidden(false);
    await wait(10);
    expect(renders).toBe(2);
  });
});
