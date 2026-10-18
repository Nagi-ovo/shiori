import { describe, expect, test } from "bun:test";
import { OpenHandoffQueue } from "./openHandoff";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("OpenHandoffQueue", () => {
  test("dedupes duplicate live/drain signals while a target is opening", async () => {
    const gate = deferred();
    const opened: string[] = [];
    const queue = new OpenHandoffQueue<string>({
      dedupeMs: 1000,
      open: async (target) => {
        opened.push(target);
        await gate.promise;
      },
    });

    queue.enqueue("paper.pdf");
    queue.enqueue("paper.pdf");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(opened).toEqual(["paper.pdf"]);
    gate.resolve();
    await queue.whenIdle();
  });

  test("allows the same target again after the dedupe window", async () => {
    let now = 10_000;
    const timers: Array<() => void> = [];
    const opened: string[] = [];
    const queue = new OpenHandoffQueue<string>({
      dedupeMs: 1000,
      now: () => now,
      setTimer: (callback) => {
        timers.push(callback);
        return 0;
      },
      open: (target) => {
        opened.push(target);
      },
    });

    queue.enqueue("paper.pdf");
    await queue.whenIdle();
    queue.enqueue("paper.pdf");
    await queue.whenIdle();
    expect(opened).toEqual(["paper.pdf"]);

    now += 1001;
    for (const callback of timers.splice(0)) callback();
    queue.enqueue("paper.pdf");
    await queue.whenIdle();

    expect(opened).toEqual(["paper.pdf", "paper.pdf"]);
  });

  test("opens distinct targets sequentially", async () => {
    const opened: string[] = [];
    const queue = new OpenHandoffQueue<string>({
      dedupeMs: 1000,
      open: async (target) => {
        opened.push(`start:${target}`);
        await Promise.resolve();
        opened.push(`end:${target}`);
      },
    });

    queue.enqueueAll(["a.pdf", "b.pdf"]);
    await queue.whenIdle();

    expect(opened).toEqual([
      "start:a.pdf",
      "end:a.pdf",
      "start:b.pdf",
      "end:b.pdf",
    ]);
  });

  test("reports failures and keeps later targets moving", async () => {
    const opened: string[] = [];
    const errors: string[] = [];
    const queue = new OpenHandoffQueue<string>({
      dedupeMs: 1000,
      onError: (_err, target) => {
        errors.push(target);
      },
      open: (target) => {
        opened.push(target);
        if (target === "bad.pdf") throw new Error("boom");
      },
    });

    queue.enqueueAll(["bad.pdf", "next.pdf"]);
    await queue.whenIdle();

    expect(opened).toEqual(["bad.pdf", "next.pdf"]);
    expect(errors).toEqual(["bad.pdf"]);
  });
});
