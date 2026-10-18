import { describe, expect, test } from "bun:test";
import { PDFDict, PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import type { PdfEngine, PdfSecurity } from "../engine/types";
import type { DocumentModel } from "../model/types";
import { fakePdfDocument, fakePdfEngine } from "../../test/fakePdfEngine";
import { exportPrintablePdf } from "./printablePdf";

// What can go wrong building the PDF the print frame paints:
// - overlays are not drawn (they must be flattened: the browser's viewer
//   prints page content, not Shiori's model);
// - hidden document files ride along into the print copy;
// - an untouched unencrypted file is rebuilt for nothing;
// - an encrypted source whose password allows printing:
//   - refuses because the rebuild cannot decrypt it — with edits, with only
//     its own markup annotations, or with only attachments (the print copy
//     omits them), i.e. even when the reader changed nothing;
//   - is handed to the frame still encrypted (the frame's viewer would ask
//     for a password the reader already gave, or print blank);
//   - is re-encrypted, or its plaintext leaves through anything but the
//     result (it must be built in memory and returned, nothing else);
//   - leaves the engine's source open;
// - an encrypted source whose password refuses printing reaches the
//   plaintext at all;
// - security the engine cannot report, or an /Encrypt PDFium did not
//   apply, is treated as unencrypted — or reaches the reader as a generic
//   failure instead of saying so;
// - a signed source is rebuilt, or its refusal reaches the reader as a
//   generic failure;
// - any other failure is swallowed.

const ALL: PdfSecurity = { revision: 6, permissions: 0xfffffffc, userPermissions: 0xfffffffc };
const NO_PRINT: PdfSecurity = { revision: 6, permissions: 0xfffffffc & ~(1 << 2), userPermissions: 0xfffffff8 };

const page = { id: "p1", sourceIndex: 0, rotation: 0 as const, widthPt: 612, heightPt: 792 };
const plainModel = (): DocumentModel => ({ pages: [page], overlays: [] });
const highlighted = (): DocumentModel => ({
  pages: [page],
  overlays: [
    {
      id: "hl",
      type: "highlight",
      pageId: "p1",
      rects: [{ x: 72, y: 650, w: 120, h: 20 }],
      color: "#f4d674",
      opacity: 0.45,
    },
  ],
});

async function onePage(title?: string): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  if (title) doc.setTitle(title);
  return doc;
}

async function withAttachment(doc?: PDFDocument): Promise<Uint8Array> {
  const pdf = doc ?? (await onePage());
  await pdf.attach(new TextEncoder().encode("private"), "private.txt", { mimeType: "text/plain" });
  return pdf.save();
}

async function withSourceHighlight(title?: string): Promise<Uint8Array> {
  const doc = await onePage(title);
  const annotation = doc.context.obj({
    Type: "Annot",
    Subtype: "Highlight",
    Rect: [72, 650, 192, 670],
    QuadPoints: [72, 670, 192, 670, 72, 650, 192, 650],
    C: [1, 0.85, 0.3],
  });
  doc.getPage(0).node.addAnnot(doc.context.register(annotation));
  return doc.save();
}

/** pdf-lib's view of an encrypted file keys off the trailer's /Encrypt. */
async function encrypted(): Promise<Uint8Array> {
  const doc = await onePage("ciphertext");
  const encryptDict = PDFDict.withContext(doc.context);
  encryptDict.set(PDFName.of("Filter"), PDFName.of("Standard"));
  encryptDict.set(PDFName.of("V"), PDFNumber.of(5));
  encryptDict.set(PDFName.of("R"), PDFNumber.of(6));
  encryptDict.set(PDFName.of("P"), PDFNumber.of(-4));
  doc.context.trailerInfo.Encrypt = doc.context.register(encryptDict);
  return doc.save();
}

async function signed(): Promise<Uint8Array> {
  const doc = await onePage();
  doc.catalog.set(PDFName.of("Perms"), doc.context.obj({ DocMDP: doc.context.obj({ Type: "Sig" }) }));
  return doc.save();
}

async function contentStreams(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  if (!contents) return 0;
  return "size" in contents && typeof contents.size === "function" ? contents.size() : 1;
}

async function carriesEncrypt(bytes: Uint8Array): Promise<boolean> {
  return (await PDFDocument.load(bytes, { ignoreEncryption: true })).isEncrypted;
}

/**
 * An engine that opened `bytes` with a password: `security` is what that
 * password allows (or throws), `plaintext` the file in the clear.
 */
function engineFor(options: {
  security: PdfSecurity | null | "unreadable";
  plaintext?: Uint8Array;
}) {
  const calls = { plaintext: 0, encrypt: 0, opened: 0, closed: 0 };
  const engine: PdfEngine = fakePdfEngine({
    security: () => {
      if (options.security === "unreadable") throw new Error("no security");
      return options.security;
    },
    openEncryptedSource: async () => {
      calls.opened += 1;
      return {
        security: options.security as PdfSecurity,
        plaintext: async () => {
          calls.plaintext += 1;
          if (!options.plaintext) throw new Error("no plaintext");
          return options.plaintext;
        },
        encrypt: async () => {
          calls.encrypt += 1;
          throw new Error("the print copy must not be re-encrypted");
        },
        close: () => {
          calls.closed += 1;
        },
      };
    },
  });
  return { engine, calls };
}

const unencrypted = engineFor({ security: null }).engine;
const opened = (bytes: Uint8Array, password?: string) => ({
  doc: fakePdfDocument(),
  bytes,
  password,
});

describe("exportPrintablePdf", () => {
  test("hands back an untouched file as it is", async () => {
    const source = await (await onePage()).save();
    const result = await exportPrintablePdf(unencrypted, opened(source), plainModel());
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.bytes).toEqual(source);
    expect(result.lostChars).toBe(0);
  });

  test("draws the overlays into the page content", async () => {
    const source = await (await onePage()).save();
    const result = await exportPrintablePdf(unencrypted, opened(source), highlighted());
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    const printed = await PDFDocument.load(result.bytes);
    expect(printed.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    expect(await contentStreams(result.bytes)).toBeGreaterThan(await contentStreams(source));
  });

  test("leaves document files out of the print copy", async () => {
    const result = await exportPrintablePdf(unencrypted, opened(await withAttachment()), plainModel());
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    const printed = await PDFDocument.load(result.bytes);
    const names = printed.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
    expect(names?.get(PDFName.of("EmbeddedFiles"))).toBeUndefined();
  });

  describe("an encrypted source whose password allows printing", () => {
    test("prints the reader's edits from the plaintext, never re-encrypted", async () => {
      const plaintext = await (await onePage("in the clear")).save();
      const { engine, calls } = engineFor({ security: ALL, plaintext });
      const result = await exportPrintablePdf(engine, opened(await encrypted(), "user-pw"), highlighted());
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") return;
      expect(await carriesEncrypt(result.bytes)).toBe(false);
      const printed = await PDFDocument.load(result.bytes);
      expect(printed.getTitle()).toBe("in the clear");
      expect(await contentStreams(result.bytes)).toBeGreaterThan(await contentStreams(plaintext));
      expect(calls.encrypt).toBe(0);
      expect(calls.closed).toBe(calls.opened);
    });

    test("prints a file carrying its own annotations when the reader changed nothing", async () => {
      const plaintext = await withSourceHighlight("in the clear");
      const { engine, calls } = engineFor({ security: ALL, plaintext });
      const result = await exportPrintablePdf(engine, opened(await encrypted(), "user-pw"), plainModel());
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") return;
      expect(await carriesEncrypt(result.bytes)).toBe(false);
      expect((await PDFDocument.load(result.bytes)).getTitle()).toBe("in the clear");
      expect(calls.encrypt).toBe(0);
      expect(calls.closed).toBe(calls.opened);
    });

    test("prints a file carrying attachments, without them", async () => {
      const plaintext = await withAttachment(await onePage("in the clear"));
      const { engine } = engineFor({ security: ALL, plaintext });
      const result = await exportPrintablePdf(engine, opened(await encrypted(), "user-pw"), plainModel());
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") return;
      const printed = await PDFDocument.load(result.bytes);
      const names = printed.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
      expect(names?.get(PDFName.of("EmbeddedFiles"))).toBeUndefined();
      expect(await carriesEncrypt(result.bytes)).toBe(false);
    });

    test("hands an untouched file to the frame in the clear, not encrypted", async () => {
      const plaintext = await (await onePage("in the clear")).save();
      const { engine, calls } = engineFor({ security: ALL, plaintext });
      const result = await exportPrintablePdf(engine, opened(await encrypted(), "user-pw"), plainModel());
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") return;
      expect(result.bytes).toEqual(plaintext);
      expect(calls.closed).toBe(calls.opened);
    });
  });

  test("never reaches the plaintext when the password refuses printing", async () => {
    const { engine, calls } = engineFor({ security: NO_PRINT, plaintext: await (await onePage()).save() });
    expect(await exportPrintablePdf(engine, opened(await encrypted(), "user-pw"), highlighted())).toEqual({
      kind: "refused",
      reason: "permission",
    });
    expect(calls.plaintext).toBe(0);
  });

  test("refuses, saying the security is unknown, when the engine cannot report it", async () => {
    const { engine, calls } = engineFor({ security: "unreadable", plaintext: await (await onePage()).save() });
    expect(await exportPrintablePdf(engine, opened(await encrypted(), "user-pw"), plainModel())).toEqual({
      kind: "refused",
      reason: "securityUnknown",
    });
    expect(calls.plaintext).toBe(0);
  });

  test("refuses, saying the security is unknown, for an /Encrypt the engine did not apply", async () => {
    expect(await exportPrintablePdf(unencrypted, opened(await encrypted()), highlighted())).toEqual({
      kind: "refused",
      reason: "securityUnknown",
    });
  });

  test("refuses a signed source that would need a rebuild", async () => {
    expect(await exportPrintablePdf(unencrypted, opened(await signed()), highlighted())).toEqual({
      kind: "refused",
      reason: "signed",
    });
  });

  test("lets any other failure through", async () => {
    await expect(
      exportPrintablePdf(unencrypted, opened(new Uint8Array([1, 2, 3])), highlighted()),
    ).rejects.toBeDefined();
  });
});
