import { describe, expect, test } from "bun:test";
import type { DocumentModel } from "../pdf/model/types";
import {
  clearAllOperationLogs,
  clearOperationLog,
  MAX_ORPHAN_OPERATION_LOGS,
  pruneOperationLogs,
  OPERATION_LOG_MAX_CHARS,
  readOperationLog,
  writeOperationLog,
} from "./operationLog";

describe("operation log", () => {
  test("round-trips the latest model by document hash", () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
    try {
      writeOperationLog("hash", sampleModel(), 1234);
      expect(readOperationLog("hash")?.lastTouched).toBe(1234);
      expect(readOperationLog("hash")?.model.pages[0]?.id).toBe("p");
      expect(readOperationLog("other")).toBeNull();
      clearOperationLog("hash");
      expect(readOperationLog("hash")).toBeNull();
      writeOperationLog("keep", sampleModel(), 2000);
      expect(readOperationLog("keep")?.lastTouched).toBe(2000);
      clearAllOperationLogs();
      expect(readOperationLog("keep")).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });

  // The crash this second tier exists for: an edit writes the op-log at 250 ms
  // and the IndexedDB draft only at 800 ms. Kill the app in between and the log
  // is the ONLY copy. Startup used to delete every log without a draft row,
  // destroying that copy at exactly the moment it was needed.
  test("keeps a log whose draft never made it to IndexedDB", () => {
    withMemoryStorage(() => {
      writeOperationLog("crashed", sampleModel(), 5000);
      // No draft row for "crashed" — the write never happened.
      pruneOperationLogs(new Set<string>());
      expect(readOperationLog("crashed")?.lastTouched).toBe(5000);
    });
  });

  test("keeps logs that belong to a live draft", () => {
    withMemoryStorage(() => {
      writeOperationLog("live", sampleModel(), 1000);
      pruneOperationLogs(new Set(["live"]));
      expect(readOperationLog("live")).not.toBeNull();
    });
  });

  test("bounds orphan logs, dropping the oldest first", () => {
    withMemoryStorage(() => {
      const total = MAX_ORPHAN_OPERATION_LOGS + 3;
      for (let i = 0; i < total; i++) {
        // Ascending timestamps: id-0 is the oldest.
        writeOperationLog(`id-${i}`, sampleModel(), 1000 + i);
      }
      expect(pruneOperationLogs(new Set<string>())).toBe(true);

      const kept: string[] = [];
      for (let i = 0; i < total; i++) {
        if (readOperationLog(`id-${i}`)) kept.push(`id-${i}`);
      }
      expect(kept.length).toBe(MAX_ORPHAN_OPERATION_LOGS);
      // The newest survive; the three oldest are the ones dropped.
      expect(kept).not.toContain("id-0");
      expect(kept).toContain(`id-${total - 1}`);
    });
  });

  test("skips oversized models but keeps the existing snapshot", () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
    try {
      // A small write lands normally...
      expect(writeOperationLog("big", sampleModel(), 1000)).toBe("written");
      expect(readOperationLog("big")?.lastTouched).toBe(1000);
      // ...then the model grows past the localStorage budget, so the write is
      // skipped.
      expect(writeOperationLog("big", oversizedModel(), 2000)).toBe(
        "skipped-too-large",
      );
      // The prior valid snapshot is preserved — recovery picks the newer of
      // op-log and IndexedDB by timestamp, so keeping it never loses fresher
      // work but can still beat an even-older autosave after a crash.
      expect(readOperationLog("big")?.lastTouched).toBe(1000);
    } finally {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: original,
      });
    }
  });
});

function oversizedModel(): DocumentModel {
  return {
    pages: [
      {
        id: "x".repeat(OPERATION_LOG_MAX_CHARS + 1000),
        sourceIndex: 0,
        rotation: 0,
        widthPt: 100,
        heightPt: 100,
      },
    ],
    overlays: [],
  };
}

function sampleModel(): DocumentModel {
  return {
    pages: [
      { id: "p", sourceIndex: 0, rotation: 0, widthPt: 100, heightPt: 100 },
    ],
    overlays: [],
  };
}

function withMemoryStorage(body: () => void): void {
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
  try {
    body();
  } finally {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: original,
    });
  }
}

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}
