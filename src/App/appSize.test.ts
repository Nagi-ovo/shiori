import { describe, expect, test } from "bun:test";

/**
 * A ratchet on App.tsx, which has no test harness of its own.
 *
 * A refactor cut it from 5009 to 4346 lines in July 2026; by September it
 * was back to 5962, and every line in it is wiring that only a live app can
 * check. Logic belongs in a seam with a behaviour test (src/App/*.ts).
 *
 * When an extraction shrinks the file, lower MAX_LINES to the new count in the
 * same change. Raising it needs a reason in the commit message.
 */
const MAX_LINES = 450;

describe("App.tsx size ratchet", () => {
  test(`stays at or under ${MAX_LINES} lines`, async () => {
    const source = await Bun.file("src/App.tsx").text();
    const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
    expect(lines).toBeLessThanOrEqual(MAX_LINES);
  });
});
