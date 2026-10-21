import { beforeAll, describe, expect, test } from "bun:test";
import Dexie from "dexie";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";

const globals = globalThis as typeof globalThis & {
  indexedDB: IDBFactory;
  IDBKeyRange: typeof IDBKeyRange;
};

beforeAll(() => {
  globals.indexedDB = fakeIndexedDB as unknown as IDBFactory;
  globals.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;
  Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
  Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;
});

describe("recent web file handles", () => {
  test("does not persist a one-off PDF insertion source handle", async () => {
    const { __recentFileHandlesTest } = await import("./recentFileHandles");
    await __recentFileHandlesTest.db.handles.clear();
    let excludeAcceptAllOption: boolean | undefined;
    const picker = async (options?: { excludeAcceptAllOption?: boolean }) => {
      excludeAcceptAllOption = options?.excludeAcceptAllOption;
      return [
        {
          name: "source.pdf",
          getFile: async () =>
            new File(
              [new Uint8Array([0x25, 0x50, 0x44, 0x46])],
              "source.pdf",
              { type: "application/pdf" },
            ),
        },
      ];
    };
    const picked = await __recentFileHandlesTest.openPdfWithWebFileHandlePickerUsing(
      picker as never,
      {
        persistHandle: false,
      },
    );
    expect(picked?.webFileHandleId).toBeUndefined();
    expect(await __recentFileHandlesTest.db.handles.count()).toBe(0);
    expect(excludeAcceptAllOption).toBe(true);
  });

  test("rejects a non-PDF before persisting or reading its bytes", async () => {
    const {
      __recentFileHandlesTest,
      isWebFileHandleOpenError,
    } = await import("./recentFileHandles");
    await __recentFileHandlesTest.db.handles.clear();
    let bytesRead = false;
    const picker = async () => [
      {
        name: "not-a-pdf.txt",
        getFile: async () =>
          ({
            name: "not-a-pdf.txt",
            size: 12,
            arrayBuffer: async () => {
              bytesRead = true;
              return new ArrayBuffer(12);
            },
          }) as File,
      },
    ];
    const error = await __recentFileHandlesTest
      .openPdfWithWebFileHandlePickerUsing(picker as never, {
        persistHandle: false,
      })
      .catch((caught) => caught);
    expect(isWebFileHandleOpenError(error)).toBe(true);
    if (isWebFileHandleOpenError(error)) expect(error.code).toBe("notPdf");
    expect(bytesRead).toBe(false);
    expect(await __recentFileHandlesTest.db.handles.count()).toBe(0);
  });

  test("reports a typed error when a persisted handle is missing", async () => {
    const {
      __recentFileHandlesTest,
      isWebFileHandleOpenError,
      readPdfFromWebFileHandle,
    } = await import("./recentFileHandles");
    await __recentFileHandlesTest.db.handles.clear();

    try {
      await readPdfFromWebFileHandle("missing-handle");
      throw new Error("readPdfFromWebFileHandle should have thrown");
    } catch (err) {
      expect(isWebFileHandleOpenError(err)).toBe(true);
      if (!isWebFileHandleOpenError(err)) return;
      expect(err.code).toBe("handleMissing");
    }
  });

  test("reports permission denial separately from missing handles", async () => {
    const { __recentFileHandlesTest, isWebFileHandleOpenError } =
      await import("./recentFileHandles");

    try {
      await __recentFileHandlesTest.readWebFileHandle(
        {
          name: "denied.pdf",
          getFile: async () => new File([], "denied.pdf"),
          queryPermission: async () => "denied",
          requestPermission: async () => "denied",
        },
        "denied-handle",
      );
      throw new Error("readWebFileHandle should have thrown");
    } catch (err) {
      expect(isWebFileHandleOpenError(err)).toBe(true);
      if (!isWebFileHandleOpenError(err)) return;
      expect(err.code).toBe("permissionDenied");
    }
  });

  test("reports unreadable saved files separately from permissions", async () => {
    const { __recentFileHandlesTest, isWebFileHandleOpenError } =
      await import("./recentFileHandles");

    try {
      await __recentFileHandlesTest.readWebFileHandle(
        {
          name: "gone.pdf",
          getFile: async () => {
            throw new DOMException("gone", "NotFoundError");
          },
          queryPermission: async () => "granted",
        },
        "gone-handle",
      );
      throw new Error("readWebFileHandle should have thrown");
    } catch (err) {
      expect(isWebFileHandleOpenError(err)).toBe(true);
      if (!isWebFileHandleOpenError(err)) return;
      expect(err.code).toBe("fileUnavailable");
    }
  });

  test("rejects an oversized DOCX before reading it into memory", async () => {
    const { MAX_DOCX_BYTES } = await import("../documents/openPolicy");
    const { __recentFileHandlesTest } = await import("./recentFileHandles");
    let read = false;

    await expect(
      __recentFileHandlesTest.readWebFileHandle(
        {
          name: "huge.docx",
          getFile: async () =>
            ({
              name: "huge.docx",
              size: MAX_DOCX_BYTES + 1,
              arrayBuffer: async () => {
                read = true;
                return new ArrayBuffer(0);
              },
            }) as File,
          queryPermission: async () => "granted",
        },
        "huge-docx",
      ),
    ).rejects.toThrow(/limit/);
    expect(read).toBe(false);
  });

  test("reports a missing handle rather than throwing on write", async () => {
    const { __recentFileHandlesTest, writeTextToWebFileHandle } =
      await import("./recentFileHandles");
    await __recentFileHandlesTest.db.handles.clear();
    expect(await writeTextToWebFileHandle("missing-handle", "hi")).toBe(
      "handleMissing",
    );
  });

  test("refreshes recency after a saved handle is used", async () => {
    const { __recentFileHandlesTest } = await import("./recentFileHandles");
    const id = "handle-to-touch";
    await __recentFileHandlesTest.db.handles.put({
      id,
      name: "note.md",
      handle: {} as never,
      savedAt: 1,
    });

    await __recentFileHandlesTest.touchWebFileHandle(id);

    expect((await __recentFileHandlesTest.db.handles.get(id))?.savedAt).toBeGreaterThan(
      1,
    );
  });
});

describe("writing back through a web file handle", () => {
  function stubHandle(overrides: Record<string, unknown> = {}) {
    const written: string[] = [];
    let closed = false;
    let aborted = false;
    const handle = {
      name: "note.md",
      getFile: async () => new File([], "note.md"),
      queryPermission: async () => "granted",
      requestPermission: async () => "granted",
      createWritable: async () => ({
        write: async (data: string) => {
          written.push(data);
        },
        close: async () => {
          closed = true;
        },
        abort: async () => {
          aborted = true;
        },
      }),
      ...overrides,
    };
    return {
      handle,
      written,
      state: () => ({ closed, aborted }),
    };
  }

  test("writes the text and closes the stream", async () => {
    const { __recentFileHandlesTest } = await import("./recentFileHandles");
    const stub = stubHandle();
    expect(
      await __recentFileHandlesTest.writeTextToHandle(
        stub.handle as never,
        "# hello",
      ),
    ).toBe("written");
    expect(stub.written).toEqual(["# hello"]);
    expect(stub.state().closed).toBe(true);
  });

  test("checks the file after the write grant and leaves a changed one alone", async () => {
    const { __recentFileHandlesTest } = await import("./recentFileHandles");
    const order: string[] = [];
    const stub = stubHandle({
      queryPermission: async () => "prompt",
      requestPermission: async () => {
        order.push("grant");
        return "granted";
      },
      getFile: async () => {
        order.push("read");
        return new File(["theirs"], "note.md");
      },
    });
    const seen: string[] = [];

    expect(
      await __recentFileHandlesTest.writeTextToHandle(stub.handle as never, "mine", async (bytes) => {
        seen.push(new TextDecoder().decode(bytes));
        return false;
      }),
    ).toBe("changed");
    expect(order).toEqual(["grant", "read"]);
    expect(seen).toEqual(["theirs"]);
    expect(stub.written).toEqual([]);
  });

  test("a file the check cannot read is left alone, unless it is gone", async () => {
    const { __recentFileHandlesTest } = await import("./recentFileHandles");
    const failingRead = (name: string) =>
      stubHandle({
        queryPermission: async () => "granted",
        getFile: async () => {
          throw new DOMException("read failed", name);
        },
      });
    const unreadable = failingRead("NotReadableError");
    const gone = failingRead("NotFoundError");
    const unchanged = async () => true;

    expect(
      await __recentFileHandlesTest.writeTextToHandle(unreadable.handle as never, "mine", unchanged),
    ).toBe("unverified");
    expect(unreadable.written).toEqual([]);
    // A deleted file is the write's to report, as before.
    expect(
      await __recentFileHandlesTest.writeTextToHandle(gone.handle as never, "mine", unchanged),
    ).toBe("written");
  });

  // Safari and Firefox ship the read half of the File System Access API only.
  // That is an ordinary outcome, not an error: the caller downloads instead.
  test("reports unsupported when the browser has no writable handles", async () => {
    const { __recentFileHandlesTest } = await import("./recentFileHandles");
    const stub = stubHandle({ createWritable: undefined });
    expect(
      await __recentFileHandlesTest.writeTextToHandle(stub.handle as never, "x"),
    ).toBe("unsupported");
  });

  // Write permission is a separate grant from the read permission taken at
  // open, so a handle Shiori can read may still refuse a write.
  test("reports a denied readwrite grant without writing", async () => {
    const { __recentFileHandlesTest } = await import("./recentFileHandles");
    const stub = stubHandle({
      queryPermission: async () => "prompt",
      requestPermission: async () => "denied",
    });
    expect(
      await __recentFileHandlesTest.writeTextToHandle(stub.handle as never, "x"),
    ).toBe("permissionDenied");
    expect(stub.written).toEqual([]);
  });

  // A half-written document must never land on top of the original.
  test("aborts the staged write when writing fails", async () => {
    const { __recentFileHandlesTest } = await import("./recentFileHandles");
    let aborted = false;
    let closed = false;
    const handle = {
      name: "note.md",
      getFile: async () => new File([], "note.md"),
      queryPermission: async () => "granted",
      createWritable: async () => ({
        write: async () => {
          throw new Error("disk full");
        },
        close: async () => {
          closed = true;
        },
        abort: async () => {
          aborted = true;
        },
      }),
    };
    await expect(
      __recentFileHandlesTest.writeTextToHandle(handle as never, "x"),
    ).rejects.toThrow("disk full");
    expect(aborted).toBe(true);
    expect(closed).toBe(false);
  });
});
