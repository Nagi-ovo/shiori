import { describe, expect, test } from "bun:test";

import { subscribeNativeDocumentDrops } from "./nativeEvents";

describe("subscribeNativeDocumentDrops", () => {
  test("subscribes only to the drop event and releases it once", async () => {
    const subscriptions: string[] = [];
    const delivered: string[][] = [];
    let listener: ((event: { payload: { paths: string[] } }) => void) | null =
      null;
    let releaseCount = 0;

    const dispose = await subscribeNativeDocumentDrops(
      {
        listen: async (event, handler) => {
          subscriptions.push(event);
          listener = handler;
          return async () => {
            releaseCount += 1;
            throw new Error("listener registry already cleared");
          };
        },
      },
      (paths) => delivered.push(paths),
    );

    expect(subscriptions).toEqual(["tauri://drag-drop"]);
    expect(listener).not.toBeNull();
    listener?.({ payload: { paths: ["a.pdf", "b.md"] } });
    expect(delivered).toEqual([["a.pdf", "b.md"]]);

    dispose();
    dispose();
    await Promise.resolve();
    expect(releaseCount).toBe(1);
  });
});
