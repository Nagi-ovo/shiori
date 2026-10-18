import { describe, expect, test } from "bun:test";
import { diagnosticErrorMessage } from "./diagnostics";

describe("diagnosticErrorMessage", () => {
  test("keeps string rejections from Tauri commands", () => {
    expect(diagnosticErrorMessage("runtime-expired")).toBe("runtime-expired");
  });
});
