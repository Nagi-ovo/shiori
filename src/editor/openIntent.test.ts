import { describe, expect, test } from "bun:test";

import { documentOpenMayContinue } from "./openIntent";

describe("document open intent", () => {
  test("keeps a fresh open alive after it loses the foreground", () => {
    expect(documentOpenMayContinue(undefined, false)).toBe(true);
  });

  test("stops a stale restore from rebuilding its old tab", () => {
    expect(documentOpenMayContinue("tab-1", false)).toBe(false);
    expect(documentOpenMayContinue("tab-1", true)).toBe(true);
  });
});
