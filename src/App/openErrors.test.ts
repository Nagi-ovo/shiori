import "../test/setupDom";
import { afterEach, describe, expect, test } from "bun:test";
import { subscribe, toast, type ToastItem } from "../editor/toast";
import { PlatformPdfOpenError } from "../platform/open";
import { showPlatformOpenError } from "./openErrors";

const t = (key: string) => key;

function shown(): ToastItem[] {
  let latest: ToastItem[] = [];
  subscribe((items) => {
    latest = items;
  })();
  return latest;
}

afterEach(() => {
  for (const item of shown()) toast.dismiss(item.id);
});

describe("showPlatformOpenError", () => {
  test("a file that is gone reads as moved or deleted, not a permission problem", () => {
    showPlatformOpenError(
      new PlatformPdfOpenError("unavailable", "document-path-unavailable"),
      "README.md",
      t,
      "C:\\notes\\README.md",
    );

    const last = shown().at(-1);
    expect(last?.message).toBe("toast.recentMissing");
    expect(last?.detail).toBe("README.md");
  });

  test("other read failures keep the OS explanation", () => {
    showPlatformOpenError(
      new PlatformPdfOpenError("unavailable", "Access is denied. (os error 5)"),
      "README.md",
      t,
    );

    const last = shown().at(-1);
    expect(last?.message).toBe("toast.openPermissionDenied");
    expect(last?.detail).toBe("Access is denied. (os error 5)");
  });
});
