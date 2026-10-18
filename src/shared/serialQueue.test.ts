import { describe, expect, test } from "bun:test";
import { createSerialQueue } from "./serialQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("createSerialQueue", () => {
  test("does not start a task until the previous one has settled", async () => {
    const enqueue = createSerialQueue();
    const first = deferred<string>();
    const started: string[] = [];

    const a = enqueue(async () => {
      started.push("a");
      return first.promise;
    });
    const b = enqueue(async () => {
      started.push("b");
      return "b-done";
    });

    // Give the microtask queue a chance to run b if it were going to.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["a"]);

    first.resolve("a-done");
    expect(await a).toBe("a-done");
    expect(await b).toBe("b-done");
    expect(started).toEqual(["a", "b"]);
  });

  test("keeps call order across three tasks", async () => {
    const enqueue = createSerialQueue();
    const order: number[] = [];
    const task = (id: number, delay: number) => async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      order.push(id);
      return id;
    };

    // The first task is the slowest: without serialisation it would finish
    // last and the order would come out reversed.
    const all = Promise.all([
      enqueue(task(1, 20)),
      enqueue(task(2, 5)),
      enqueue(task(3, 0)),
    ]);

    expect(await all).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("a failing task does not stall the queue", async () => {
    const enqueue = createSerialQueue();
    const failing = enqueue(async () => {
      throw new Error("merge blew up");
    });

    await expect(failing).rejects.toThrow("merge blew up");
    expect(await enqueue(async () => "still running")).toBe("still running");
  });

  test("a rejection reaches only its own caller", async () => {
    const enqueue = createSerialQueue();
    const failing = enqueue(async () => {
      throw new Error("first");
    });
    const following = enqueue(async () => "second");

    // If the queue re-threw the first failure into the chain, this would
    // reject instead of resolving.
    expect(await following).toBe("second");
    await expect(failing).rejects.toThrow("first");
  });
});
