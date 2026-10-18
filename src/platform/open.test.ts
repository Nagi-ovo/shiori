import { beforeAll, describe, expect, test } from "bun:test";
import Dexie from "dexie";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";

let mobileDocumentPayloadFromBytes: typeof import("./open").mobileDocumentPayloadFromBytes;
let readSelectedDocuments: typeof import("./open").readSelectedDocuments;

beforeAll(async () => {
  Object.defineProperties(globalThis, {
    indexedDB: { configurable: true, writable: true, value: fakeIndexedDB },
    IDBKeyRange: {
      configurable: true,
      writable: true,
      value: FakeIDBKeyRange,
    },
  });
  Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
  Dexie.dependencies.IDBKeyRange =
    FakeIDBKeyRange as unknown as typeof IDBKeyRange;
  Object.defineProperties(globalThis, {
    __APP_VERSION__: { configurable: true, value: "0.0.0-test" },
    __BUILD_TIMESTAMP__: { configurable: true, value: 0 },
    __BUILD_EXPIRY_DAYS__: { configurable: true, value: 0 },
  });
  ({ mobileDocumentPayloadFromBytes, readSelectedDocuments } = await import("./open"));
});

describe("readSelectedDocuments", () => {
  test("reports one failed selection and continues in order", async () => {
    const failures: Array<{ message: string; name?: string }> = [];
    const loaded = await readSelectedDocuments(
      ["first.pdf", "broken.pdf", "last.pdf"],
      async (name) => {
        if (name === "broken.pdf") throw new Error("unavailable");
        return name.toUpperCase();
      },
      (error, name) => failures.push({ message: error.message, name }),
      (name) => name,
    );

    expect(loaded).toEqual(["FIRST.PDF", "LAST.PDF"]);
    expect(failures).toEqual([
      { message: "unavailable", name: "broken.pdf" },
    ]);
  });

  test("preserves fail-fast behaviour when no failure handler is supplied", async () => {
    await expect(
      readSelectedDocuments(["broken.pdf"], async () => {
        throw new Error("unavailable");
      }),
    ).rejects.toThrow("unavailable");
  });
});

describe("mobile document payloads", () => {
  test("detects PDF, Markdown, and HTML from picked file names", () => {
    const bytes = new Uint8Array([1, 2, 3]);

    expect(mobileDocumentPayloadFromBytes("file:///tmp/paper.pdf", bytes)).toMatchObject({
      kind: "pdf",
      name: "paper.pdf",
      size: 3,
    });
    expect(
      mobileDocumentPayloadFromBytes("file:///tmp/notes.md", bytes),
    ).toMatchObject({
      kind: "markdown",
      name: "notes.md",
      size: 3,
    });
    expect(
      mobileDocumentPayloadFromBytes("file:///tmp/export.HTML", bytes),
    ).toMatchObject({
      kind: "html",
      name: "export.HTML",
      size: 3,
    });
  });

  test("preserves filenames inside decoded Android content URLs", () => {
    const payload = mobileDocumentPayloadFromBytes(
      "content://downloads/document/primary%3ADownload%2Fbrief.markdown",
      new Uint8Array([7]),
    );

    expect(payload.kind).toBe("markdown");
    expect(payload.name).toBe("brief.markdown");
  });

  test("uses Android provider display names when content URLs are opaque", () => {
    const payload = mobileDocumentPayloadFromBytes(
      {
        uri: "content://com.android.providers.downloads.documents/document/msf%3A42",
        name: "real-paper.pdf",
      },
      new TextEncoder().encode("%PDF-1.7\nbody"),
    );

    expect(payload.kind).toBe("pdf");
    expect(payload.name).toBe("real-paper.pdf");
  });

  test("sniffs document kind when Android content URLs omit filenames", () => {
    expect(
      mobileDocumentPayloadFromBytes(
        "content://provider/document/42",
        new TextEncoder().encode("%PDF-1.7\nbody"),
      ),
    ).toMatchObject({
      kind: "pdf",
      name: "document.pdf",
    });
    expect(
      mobileDocumentPayloadFromBytes(
        "content://provider/document/43",
        new TextEncoder().encode("<!doctype html><html><body>Hello</body></html>"),
      ),
    ).toMatchObject({
      kind: "html",
      name: "document.html",
    });
    expect(
      mobileDocumentPayloadFromBytes(
        "content://provider/document/44",
        new TextEncoder().encode("---\ntitle: Notes\n---\n# Hello"),
      ),
    ).toMatchObject({
      kind: "markdown",
      name: "document.md",
    });
    expect(
      mobileDocumentPayloadFromBytes(
        "content://provider/document/45",
        minimalDocxDirectory(),
      ),
    ).toMatchObject({
      kind: "docx",
      name: "document.docx",
    });
  });

  test("rejects unknown extensions instead of treating them as PDF", () => {
    expect(() =>
      mobileDocumentPayloadFromBytes("file:///tmp/readme.txt", new Uint8Array()),
    ).toThrow("unsupported-document");
    expect(() =>
      mobileDocumentPayloadFromBytes(
        "content://provider/document/42",
        new Uint8Array([0xff, 0x00, 0x81, 0x00]),
      ),
    ).toThrow("unsupported-document");
  });
});

function minimalDocxDirectory(): Uint8Array {
  const encoder = new TextEncoder();
  const names = ["[Content_Types].xml", "word/document.xml"].map((name) =>
    encoder.encode(name),
  );
  const centralSize = names.reduce((sum, name) => sum + 46 + name.length, 0);
  const bytes = new Uint8Array(centralSize + 22);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  names.forEach((name) => {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 10, 8, true);
    view.setUint32(offset + 20, 10, true);
    view.setUint32(offset + 24, 20, true);
    view.setUint16(offset + 28, name.length, true);
    bytes.set(name, offset + 46);
    offset += 46 + name.length;
  });
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, names.length, true);
  view.setUint16(offset + 10, names.length, true);
  view.setUint32(offset + 12, centralSize, true);
  return bytes;
}
