import { describe, expect, test } from "bun:test";
import { drainPendingWrites } from "./textSourceSaveQueue";

describe("drainPendingWrites", () => {
  test("drains a newer write that arrives while persistence is in flight", async () => {
    const pending = new Map([["tab", { seq: 1, text: "first" }]]);
    const persisted: string[] = [];
    const cleared: string[] = [];

    await drainPendingWrites({
      pending,
      clearTimer: (id) => cleared.push(id),
      persist: async (_id, write) => {
        persisted.push(write.text);
        if (write.seq === 1) {
          await Promise.resolve();
          pending.set("tab", { seq: 2, text: "latest" });
        }
      },
      id: "tab",
    });

    expect(persisted).toEqual(["first", "latest"]);
    expect(cleared).toEqual(["tab", "tab"]);
    expect(pending.size).toBe(0);
  });

  test("keeps a failed write available for a later retry", async () => {
    const write = { seq: 1, text: "keep me" };
    const pending = new Map([["tab", write]]);

    await expect(
      drainPendingWrites({
        pending,
        clearTimer: () => undefined,
        persist: async () => {
          throw new Error("storage unavailable");
        },
      }),
    ).rejects.toThrow("storage unavailable");
    expect(pending.get("tab")).toBe(write);
  });
});
