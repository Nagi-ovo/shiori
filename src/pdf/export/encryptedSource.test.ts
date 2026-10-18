import { describe, expect, test } from "bun:test";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { fakePdfDocument, fakePdfEngine } from "../../test/fakePdfEngine";
import type { EncryptedPdfSource, PdfDocument, PdfSecurity } from "../engine/types";
import {
  ExportEncryptedSourceError,
  ExportEncryptionUnsupportedError,
  ExportEncryptionVerifyError,
  withSourceEncryption,
} from "./encryptedSource";

// What can go wrong between the open document and its re-encryption (the
// real handler is exercised in crates/shiori-core-node/test/encryptedExport.test.ts):
// - an unencrypted document gets a handler, or opens a source at all;
// - "security unknown" passes for unencrypted: the engine could not report
//   it, or reports none for bytes that carry an /Encrypt, and the export
//   runs without a handler, so a raster leaves in the clear;
// - the wrong password, or none for an empty user password, reaches the engine;
// - the source stays open after the export settles, either way;
// - an export that edits nothing still decrypts and encrypts;
// - a handler the core cannot reproduce surfaces as a generic failure;
// - the re-encrypted file is handed back without proof it reopens with the
//   same password, the same handler and the same pages;
// - the re-encrypted file is weaker than its source: it opens without a
//   password or with a wrong one where the source does not, or reports other
//   permissions (a handler other than the source's, say one that encrypts
//   nothing, chosen by the core from bytes PDFium never read);
// - a document opened only to check the result stays open;
// - the password leaks into an error message.

const SECURITY: PdfSecurity = { revision: 6, permissions: 0xfffffffc, userPermissions: 0xfffff0c4 };
const PASSWORD = "user-pw 密码";

type Load = { of: "source" | "export"; password: string };

function harness(options: {
  security?: PdfSecurity | null | "unknown";
  encrypt?: (plain: Uint8Array) => Promise<Uint8Array>;
  reopen?: { security: PdfSecurity | null; pages: number } | "fails";
  /** The password the document was opened with. */
  password?: string;
  /** Besides that password, what else opens the export, and the source. */
  exportOpensWith?: (password: string) => boolean;
  sourceOpensWith?: (password: string) => boolean;
} = {}) {
  const doc = fakePdfDocument();
  const opening = options.password ?? PASSWORD;
  const sourcePasswords: string[] = [];
  const loads: Load[] = [];
  let opens = 0;
  let closes = 0;
  const loaded: PdfDocument[] = [];
  const destroyed: PdfDocument[] = [];
  const reopened = fakePdfDocument();
  const reopen = options.reopen ?? { security: SECURITY, pages: 2 };
  const engine = fakePdfEngine({
    security: (d) => {
      if (d !== doc) return reopen === "fails" ? null : reopen.security;
      if (options.security === "unknown") throw new Error("PDFium could not report the document's security");
      return options.security === undefined ? SECURITY : options.security;
    },
    pageCount: () => (reopen === "fails" ? 0 : reopen.pages),
    openEncryptedSource: async (_bytes, password): Promise<EncryptedPdfSource> => {
      sourcePasswords.push(password);
      opens += 1;
      return {
        security: SECURITY,
        plaintext: async () => new Uint8Array([1]),
        encrypt: options.encrypt ?? (async (plain) => Uint8Array.of(0xe0, ...plain)),
        close: () => {
          closes += 1;
        },
      };
    },
    load: async (loadedBytes, { password = "" }) => {
      const of = loadedBytes === bytes ? "source" : "export";
      loads.push({ of, password });
      const opensWith = (of === "source" ? options.sourceOpensWith : options.exportOpensWith) ?? (() => false);
      if (of === "export" && password === opening && reopen !== "fails") {
        loaded.push(reopened);
        return { doc: reopened, bytes: loadedBytes };
      }
      if (password === opening || opensWith(password)) {
        const probe = fakePdfDocument();
        loaded.push(probe);
        return { doc: probe, bytes: loadedBytes };
      }
      throw new Error("PDFium: incorrect password");
    },
    destroy: async (d) => {
      if (d) destroyed.push(d);
    },
  });
  return {
    engine,
    doc,
    sourcePasswords,
    loads,
    loaded,
    destroyed,
    reopened,
    opens: () => opens,
    closes: () => closes,
  };
}

const bytes = new Uint8Array([9]);

async function pdfBytes(encrypt: boolean): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  if (encrypt) {
    const dict = PDFDict.withContext(pdf.context);
    dict.set(PDFName.of("Filter"), PDFName.of("Standard"));
    pdf.context.trailerInfo.Encrypt = pdf.context.register(dict);
  }
  return pdf.save();
}

describe("withSourceEncryption", () => {
  test("hands an unencrypted document no handler and opens nothing", async () => {
    const h = harness({ security: null });
    const plain = await pdfBytes(false);
    const seen = await withSourceEncryption(h.engine, { doc: h.doc, bytes: plain, password: PASSWORD }, async (e) => e);
    expect(seen).toBeUndefined();
    expect(h.opens()).toBe(0);
  });

  test("refuses to export when nobody can say whether the document is encrypted", async () => {
    for (const [security, source] of [
      ["unknown", await pdfBytes(false)],
      [null, await pdfBytes(true)],
    ] as const) {
      const h = harness({ security });
      let ran = false;
      const error = await withSourceEncryption(h.engine, { doc: h.doc, bytes: source, password: PASSWORD }, async () => {
        ran = true;
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExportEncryptedSourceError);
      expect(ran).toBe(false);
      expect(h.opens()).toBe(0);
    }
  });

  test("opens no source for an export that never needs one", async () => {
    const h = harness();
    await withSourceEncryption(h.engine, { doc: h.doc, bytes }, async (e) => e?.security);
    expect(h.opens()).toBe(0);
  });

  test("re-encrypts with the opening password, checks the result reopens with it, and closes the source", async () => {
    const h = harness();
    const out = await withSourceEncryption(h.engine, { doc: h.doc, bytes, password: PASSWORD }, async (e) => {
      const plain = await e!.plaintext();
      return e!.encrypt(plain, 2);
    });
    expect(Array.from(out)).toEqual([0xe0, 1]);
    expect(h.sourcePasswords).toEqual([PASSWORD]);
    expect(h.loads[0]).toEqual({ of: "export", password: PASSWORD });
    expect(h.opens()).toBe(1);
    expect(h.closes()).toBe(1);
    expect(h.destroyed).toEqual(h.loaded);
    expect(h.destroyed).toContain(h.reopened);
  });

  test("an absent password is the empty user password", async () => {
    const h = harness({ password: "" });
    await withSourceEncryption(h.engine, { doc: h.doc, bytes }, async (e) => e!.encrypt(await e!.plaintext(), 2));
    expect(h.sourcePasswords).toEqual([""]);
    expect(h.loads[0]).toEqual({ of: "export", password: "" });
  });

  test("closes the source when the export fails", async () => {
    const h = harness();
    const failure = withSourceEncryption(h.engine, { doc: h.doc, bytes, password: PASSWORD }, async (e) => {
      await e!.plaintext();
      throw new Error("pdf-lib failed");
    });
    await expect(failure).rejects.toThrow("pdf-lib failed");
    expect(h.closes()).toBe(1);
  });

  test("a handler the core cannot reproduce is reported as such", async () => {
    const h = harness({
      encrypt: async () => {
        throw new Error("re-encryption unsupported: crypt filters differ for strings and streams");
      },
    });
    const error = await withSourceEncryption(h.engine, { doc: h.doc, bytes, password: PASSWORD }, async (e) =>
      e!.encrypt(new Uint8Array([1]), 2),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExportEncryptionUnsupportedError);
    expect((error as Error).message).toContain("crypt filters differ");
    expect((error as Error).message).not.toContain(PASSWORD);
  });

  test("refuses a result that does not reopen exactly like the source", async () => {
    for (const reopen of [
      "fails" as const,
      { security: null, pages: 2 },
      { security: { ...SECURITY, revision: 4 }, pages: 2 },
      { security: SECURITY, pages: 1 },
      // Other permissions under the same password: /P or the password's rank.
      { security: { ...SECURITY, userPermissions: 0xfffffffc }, pages: 2 },
      { security: { ...SECURITY, permissions: SECURITY.userPermissions }, pages: 2 },
    ]) {
      const h = harness({ reopen });
      const error = await withSourceEncryption(h.engine, { doc: h.doc, bytes, password: PASSWORD }, async (e) =>
        e!.encrypt(new Uint8Array([1]), 2),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExportEncryptionVerifyError);
      expect((error as Error).message).not.toContain(PASSWORD);
      expect(h.closes()).toBe(1);
    }
  });

  const verify = (h: ReturnType<typeof harness>, password = PASSWORD) =>
    withSourceEncryption(h.engine, { doc: h.doc, bytes, password }, async (e) => e!.encrypt(new Uint8Array([1]), 2)).catch(
      (e: unknown) => e,
    );

  test("refuses a result that opens without the password its source needs", async () => {
    const h = harness({ exportOpensWith: (password) => password === "" });
    const error = await verify(h);
    expect(error).toBeInstanceOf(ExportEncryptionVerifyError);
    expect((error as Error).message).not.toContain(PASSWORD);
    expect(h.destroyed).toEqual(h.loaded);
  });

  test("refuses a result that opens with a wrong password", async () => {
    const h = harness({ exportOpensWith: () => true });
    const error = await verify(h);
    expect(error).toBeInstanceOf(ExportEncryptionVerifyError);
    expect(h.destroyed).toEqual(h.loaded);
  });

  test("lets a result open without a password when its source does too", async () => {
    // An empty user password, the document opened with the owner's.
    const h = harness({
      exportOpensWith: (password) => password === "",
      sourceOpensWith: (password) => password === "",
    });
    const out = await verify(h);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(h.loads).toContainEqual({ of: "export", password: "" });
    expect(h.destroyed).toEqual(h.loaded);
  });
});
