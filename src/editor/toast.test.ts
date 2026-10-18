import "../test/setupDom";
import { describe, expect, test } from "bun:test";
import { subscribe, toast, type ToastItem } from "./toast";

function captureItems(): { items: () => ToastItem[]; stop: () => void } {
  let latest: ToastItem[] = [];
  const stop = subscribe((items) => {
    latest = items;
  });
  return { items: () => latest, stop };
}

describe("toast.showSaved", () => {
  test("desktop save stores a structured savedTo payload, not English copy", () => {
    const { items, stop } = captureItems();
    try {
      toast.showSaved("desktop", "/tmp/report.pdf");
      const item = items().at(-1);
      expect(item?.message).toEqual({ kind: "savedTo", path: "/tmp/report.pdf" });
      if (item) toast.dismiss(item.id);
    } finally {
      stop();
    }
  });

  test("mobile share stores a structured sharedAs payload, not English copy", () => {
    const { items, stop } = captureItems();
    try {
      toast.showSaved("mobile", "report.pdf");
      const item = items().at(-1);
      expect(item?.message).toEqual({ kind: "sharedAs", path: "report.pdf" });
      if (item) toast.dismiss(item.id);
    } finally {
      stop();
    }
  });

  test("web save stores a structured savedAs payload without a baked-in detail", () => {
    const { items, stop } = captureItems();
    try {
      toast.showSaved("web", "report.pdf");
      const item = items().at(-1);
      expect(item?.message).toEqual({ kind: "savedAs", path: "report.pdf" });
      // The localized hint is attached by ToastHost at render time.
      expect(item?.detail).toBeUndefined();
      if (item) toast.dismiss(item.id);
    } finally {
      stop();
    }
  });
});

describe("toast queue", () => {
  test("deduplicates identical passive messages", () => {
    const { items, stop } = captureItems();
    try {
      toast.error("Unsupported", "notes.txt");
      toast.error("Unsupported", "notes.txt");
      expect(
        items().filter(
          (item) => item.message === "Unsupported" && item.detail === "notes.txt",
        ),
      ).toHaveLength(1);
    } finally {
      for (const item of items()) toast.dismiss(item.id);
      stop();
    }
  });

  test("caps the visible queue while preserving the newest messages", () => {
    const { items, stop } = captureItems();
    try {
      for (let index = 0; index < 6; index += 1) {
        toast.show(`message-${index}`);
      }
      expect(items()).toHaveLength(4);
      expect(items().map((item) => item.message)).toEqual([
        "message-2",
        "message-3",
        "message-4",
        "message-5",
      ]);
    } finally {
      for (const item of items()) toast.dismiss(item.id);
      stop();
    }
  });
});
