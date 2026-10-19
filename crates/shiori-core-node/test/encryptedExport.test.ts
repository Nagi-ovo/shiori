// Run by `bun run test:core` after the addon is built.
//
// An encrypted PDF exported with edits, end to end: the app's own export
// (exportPdf) on PDFium's plaintext, re-encrypted by shiori-core, then read
// back by PDFium and by qpdf (src/test/qpdf.ts). PDFium also did the
// decrypting and the encrypting, so qpdf is the reader that shares no code
// with the writer; its tests show as skipped where qpdf is not installed.
// The fixtures and their generator are in
// crates/shiori-core/tests/fixtures/encrypted/.
//
// What can go wrong:
// - the export leaves unencrypted, or encrypted under a new key or handler,
//   so the source's user and owner passwords stop working or any password does;
// - a reader other than PDFium cannot decrypt it (wrong /ID, /Length, crypt
//   filters, object streams or xref stream encrypted);
// - the edit, the source's note, text, Info, XMP or attachment is lost or
//   garbled by the round trip;
// - strings stay readable in the file;
// - an edit the permissions refuse is written anyway, or one they allow refused;
// - bytes PDFium never reads as the handler (a comment after %%EOF spelling
//   out the /Encrypt object) decide how the export is encrypted;
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { openCoreDocument, type CoreDocument } from "../../../cli/src/coreEngine";
import type { PdfDocument, PdfSecurity } from "../../../src/pdf/engine/types";
import {
  ExportPermissionError,
  exportPdf,
  type ExportMode,
  type ExportQuality,
} from "../../../src/pdf/export/exportPdf";
import { withSourceEncryption, type ExportSourceEncryption } from "../../../src/pdf/export/encryptedSource";
import { importFileAnnotations } from "../../../src/pdf/import/annotations";
import type { DocumentModel, Overlay, PageModel } from "../../../src/pdf/model/types";
import { fakePdfEngine } from "../../../src/test/fakePdfEngine";
import {
  QPDF,
  QpdfDocument,
  qpdfCheck,
  qpdfEncryption,
  qpdfRejectsPassword,
  qpdfTest,
} from "../../../src/test/qpdf";

const ROOT = join(import.meta.dir, "../../..");
const FIXTURES = join(ROOT, "crates/shiori-core/tests/fixtures/encrypted");
const UNICODE_FONT = readFileSync(join(ROOT, "src/assets/fonts/NotoSansSC-Regular.otf"));
const OWNER = "owner-pw";
const WRONG = "not-the-password";

/** name, user password, the user password allows annotating. */
const FIXTURE_TABLE: [string, string, boolean][] = [
  ["rc4-40", "user-pw", true],
  ["rc4-128", "user-pw", true],
  ["r4-rc4", "user-pw", true],
  ["aes-128", "user-pw", true],
  ["aes-128-nometa", "user-pw", true],
  ["aes-256-r5", "user-pw", true],
  ["aes-256", "user-pw", true],
  ["aes-256-nometa", "user-pw", true],
  ["restricted", "user-pw", false],
  ["annotate-only", "user-pw", true],
  ["empty-user", "", false],
  ["cjk-password", "密码パス", true],
  ["latin1-password", "café", true],
];

const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, `${name}.pdf`)));

function securityOf(core: CoreDocument): PdfSecurity | null {
  const report = core.security();
  if (report.revision == null) return null;
  return {
    revision: report.revision,
    permissions: report.permissions >>> 0,
    userPermissions: report.userPermissions >>> 0,
  };
}

/** The engine members the export path uses, over the native core. */
function nodeEngine() {
  const docs = new Map<PdfDocument, CoreDocument>();
  const open = (bytes: Uint8Array, password?: string) => {
    const core = openCoreDocument(bytes, password);
    const doc = Object.freeze({}) as unknown as PdfDocument;
    docs.set(doc, core);
    return doc;
  };
  const coreOf = (doc: PdfDocument) => docs.get(doc)!;
  const engine = fakePdfEngine({
    load: async (bytes, { password }) => ({ doc: open(bytes, password), bytes }),
    pageCount: (doc) => coreOf(doc).pageCount(),
    security: (doc) => securityOf(coreOf(doc)),
    destroy: async (doc) => {
      if (!doc) return;
      coreOf(doc).close();
      docs.delete(doc);
    },
    openEncryptedSource: async (bytes, password) => {
      const core = openCoreDocument(bytes, password);
      const security = securityOf(core);
      if (!security) throw new Error("re-encryption unsupported: the source is not encrypted");
      return {
        security,
        plaintext: async () => core.decryptedCopy(),
        encrypt: async (plain) => core.encryptLikeSource(plain),
        close: () => core.close(),
      };
    },
  });
  return { engine, open, coreOf };
}

/** The document as the app holds it after opening `name`: pages and imported annotations. */
async function openAsApp(name: string, password: string, bytes = fixture(name)) {
  const { engine, open, coreOf } = nodeEngine();
  const doc = open(bytes, password);
  const core = coreOf(doc);
  const pages: PageModel[] = Array.from({ length: core.pageCount() }, (_, index) => {
    const geometry = core.pageGeometry(index);
    return { id: `p${index}`, sourceIndex: index, rotation: 0, widthPt: geometry.width, heightPt: geometry.height };
  });
  const imported = await importFileAnnotations(pages, bytes, 0, {
    decryptedBytes: async () => core.decryptedCopy(),
  });
  return { bytes, doc, engine, pages, imported, close: () => engine.destroy(doc) };
}

const highlight = (pageId: string): Overlay => ({
  id: "added-highlight",
  type: "highlight",
  pageId,
  rects: [{ x: 72, y: 690, w: 160, h: 18 }],
  color: "#f4d674",
  opacity: 0.45,
});

type ExportRun = { bytes: Uint8Array; plaintext: Uint8Array | null };

/** Exports `model` as the export dialog does, keeping the plaintext the handler was given. */
async function exportAsApp(
  opened: Awaited<ReturnType<typeof openAsApp>>,
  password: string,
  model: DocumentModel,
  options: { mode?: ExportMode; quality?: ExportQuality } = {},
): Promise<ExportRun> {
  let plaintext: Uint8Array | null = null;
  const { bytes } = await withSourceEncryption(
    opened.engine,
    { doc: opened.doc, bytes: opened.bytes, password },
    async (encryption) => {
      expect(encryption).toBeDefined();
      const capturing: ExportSourceEncryption = {
        ...encryption!,
        encrypt: (plain, pageCount) => {
          plaintext = plain;
          return encryption!.encrypt(plain, pageCount);
        },
      };
      return exportPdf(opened.bytes, model, {
        mode: options.mode ?? "annotations",
        quality: options.quality ?? "original",
        documentFiles: "preserve",
        unicodeFontBytes: UNICODE_FONT,
        sourceEncryption: capturing,
      });
    },
  );
  return { bytes, plaintext };
}

/** What qpdf reads from a document: the parts an edit and a round trip must keep. */
function qpdfReading(bytes: Uint8Array, password?: string) {
  const doc = QpdfDocument.open(bytes, password);
  const xmp = doc.xmp();
  return {
    pages: doc.pages().map((_, index) =>
      doc.annotations(index).map((annotation) => ({
        subtype: String(annotation["/Subtype"]).slice(1),
        contents: doc.text(annotation["/Contents"]) ?? "",
        author: doc.text(annotation["/T"]) ?? "",
      })),
    ),
    title: doc.text(doc.info["/Title"]),
    xmpTitle: xmp === null ? null : (/<dc:title>[\s\S]*?<rdf:li[^>]*>([^<]*)</.exec(xmp)?.[1] ?? null),
    attachments: Object.fromEntries(
      Object.entries(doc.attachments()).map(([name, data]) => [name, new TextDecoder().decode(data)]),
    ),
  };
}

function coreOpens(
  bytes: Uint8Array,
  password?: string,
): { revision: number | null; text: string; pages: string[] } | "password" {
  let core: CoreDocument;
  try {
    core = openCoreDocument(bytes, password);
  } catch (error) {
    expect(String(error)).toContain("password");
    return "password";
  }
  try {
    const pages = Array.from({ length: core.pageCount() }, (_, index) =>
      core.glyphs(index).map((g) => g.text).join(""),
    );
    return { revision: core.security().revision ?? null, text: pages[0] ?? "", pages };
  } finally {
    core.close();
  }
}

/** Every check an exported encrypted file must pass, against the plaintext it was made from. */
async function expectEncryptedLikeSource(name: string, userPassword: string, run: ExportRun) {
  const { bytes, plaintext } = run;
  expect(plaintext).not.toBeNull();
  const source = fixture(name);
  const sourceRevision = coreOpens(source, OWNER);
  if (sourceRevision === "password") throw new Error("fixture does not open");

  // Still encrypted: pdf-lib, which cannot decrypt, sees an /Encrypt.
  const raw = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  expect(raw.isEncrypted).toBe(true);
  // No string the edit or the source wrote is readable in the file.
  const latin1 = new TextDecoder("latin1").decode(bytes).toLowerCase();
  for (const clear of ["Reviewer", "Secret page", "notes.txt"]) {
    expect(latin1).not.toContain(clear.toLowerCase());
    expect(latin1).not.toContain(Buffer.from(clear).toString("hex"));
  }

  // PDFium: both passwords, with the source's handler; nothing else.
  for (const password of [userPassword, OWNER]) {
    const opened = coreOpens(bytes, password);
    expect(opened).toMatchObject({ revision: sourceRevision.revision, text: expect.stringContaining("Secret page one") });
  }
  expect(coreOpens(bytes, WRONG)).toBe("password");
  if (userPassword !== "") expect(coreOpens(bytes, undefined)).toBe("password");

  // The XMP stream, decrypted by PDFium, is the plaintext's.
  const XMP = "Locked title XMP";
  expect(new TextDecoder("latin1").decode(plaintext!)).toContain(XMP);
  const decrypted = openCoreDocument(bytes, OWNER);
  try {
    expect(new TextDecoder("latin1").decode(decrypted.decryptedCopy())).toContain(XMP);
  } finally {
    decrypted.close();
  }

  return opened(bytes, userPassword);
}

/** The export's pages as PDFium reads them with `password`. */
function opened(bytes: Uint8Array, password: string): string[] {
  const reading = coreOpens(bytes, password);
  if (reading === "password") throw new Error("the export does not open");
  return reading.pages;
}

/**
 * The same checks through qpdf: it opens the export with both passwords and
 * nothing else, finds the source's security handler, finds no structural
 * error, and reads exactly what the plaintext export holds.
 */
function expectQpdfReadsLikePlaintext(name: string, userPassword: string, run: ExportRun) {
  const { bytes, plaintext } = run;
  const source = fixture(name);
  expect(qpdfRejectsPassword(bytes, WRONG)).toBe(true);
  if (userPassword !== "") expect(qpdfRejectsPassword(bytes, undefined)).toBe(true);
  const expected = qpdfReading(plaintext!);
  for (const password of [userPassword, OWNER]) {
    const check = qpdfCheck(bytes, password);
    expect({ code: check.code, stderr: check.stderr }).toEqual({ code: 0, stderr: "" });
    expect(qpdfEncryption(bytes, password)).toBe(qpdfEncryption(source, password));
    expect(qpdfReading(bytes, password)).toEqual(expected);
  }
  return expected;
}

/** Opens fixture `name` as the app does, adds a highlight and exports it. */
async function exportFixture(
  name: string,
  password: string,
  options: { mode?: ExportMode; quality?: ExportQuality } = {},
): Promise<ExportRun> {
  const opened = await openAsApp(name, password);
  try {
    const model = { pages: opened.pages, overlays: [...opened.imported, highlight("p0")] };
    return await exportAsApp(opened, password, model, options);
  } finally {
    await opened.close();
  }
}

/** The user password where it allows annotating, else the owner's. */
const editingPassword = (userPassword: string, userMayAnnotate: boolean) => (userMayAnnotate ? userPassword : OWNER);

const OBJECT_STREAM_FIXTURES = ["aes-256", "rc4-128", "aes-128-nometa"];

describe("an encrypted PDF exported with edits", () => {
  for (const [name, userPassword, userMayAnnotate] of FIXTURE_TABLE) {
    test(`${name}: keeps its encryption, both passwords and its text (PDFium)`, async () => {
      const run = await exportFixture(name, editingPassword(userPassword, userMayAnnotate));
      const pages = await expectEncryptedLikeSource(name, userPassword, run);
      expect(pages[0]).toContain("Secret page one");
      expect(pages[1]).toContain("Secret page two");
    });

    qpdfTest(`${name}: qpdf opens it with both passwords only and reads everything it held`, async () => {
      const run = await exportFixture(name, editingPassword(userPassword, userMayAnnotate));
      const reading = expectQpdfReadsLikePlaintext(name, userPassword, run);
      expect(reading.pages[0]).toEqual(
        expect.arrayContaining([
          { subtype: "Text", contents: "Encrypted note 加密", author: "Reviewer" },
          expect.objectContaining({ subtype: "Highlight" }),
        ]),
      );
      expect(reading.title).toBe("Locked title 秘密");
      expect(reading.xmpTitle).toBe("Locked title XMP");
      expect(reading.attachments).toEqual({ "notes.txt": "attached notes 附件" });
    });
  }

  test("object streams and an xref stream (Standard quality) stay readable by PDFium", async () => {
    for (const name of OBJECT_STREAM_FIXTURES) {
      const run = await exportFixture(name, "user-pw", { quality: "standard" });
      // pdf-lib wrote object streams into the plaintext.
      expect(new TextDecoder("latin1").decode(run.plaintext!)).toContain("/ObjStm");
      expect((await expectEncryptedLikeSource(name, "user-pw", run))[0]).toContain("Secret page one");
    }
  });

  qpdfTest("object streams and an xref stream (Standard quality) stay readable by qpdf", async () => {
    for (const name of OBJECT_STREAM_FIXTURES) {
      const run = await exportFixture(name, "user-pw", { quality: "standard" });
      expect(new TextDecoder("latin1").decode(run.plaintext!)).toContain("/ObjStm");
      const reading = expectQpdfReadsLikePlaintext(name, "user-pw", run);
      expect(reading.pages[0]!.map((a) => a.subtype)).toContain("Highlight");
    }
  });

  test("a flattened export keeps the encryption too", async () => {
    const run = await exportFixture("aes-128", "user-pw", { mode: "flatten" });
    expect((await expectEncryptedLikeSource("aes-128", "user-pw", run))[0]).toContain("Secret page one");
  });

  qpdfTest("a flattened export keeps the encryption and no annotations, read by qpdf", async () => {
    const run = await exportFixture("aes-128", "user-pw", { mode: "flatten" });
    expect(expectQpdfReadsLikePlaintext("aes-128", "user-pw", run).pages[0]).toEqual([]);
  });

  test("the permissions the user password grants decide what may be exported", async () => {
    const refused = async (name: string, password: string, model: (pages: PageModel[], imported: Overlay[]) => DocumentModel, mode?: ExportMode) => {
      const opened = await openAsApp(name, password);
      try {
        const outcome = await exportAsApp(opened, password, model(opened.pages, opened.imported), { mode }).catch(
          (error: unknown) => error,
        );
        if (outcome instanceof ExportPermissionError) return outcome.denied;
        if (outcome instanceof Error) throw outcome;
        return "exported";
      } finally {
        await opened.close();
      }
    };
    const annotate = (pages: PageModel[], imported: Overlay[]) => ({ pages, overlays: [...imported, highlight("p0")] });
    const rotate = (pages: PageModel[], imported: Overlay[]) => ({
      pages: pages.map((page, index) => (index === 0 ? { ...page, rotation: 90 as const } : page)),
      overlays: imported,
    });
    // Print only: no annotating, under a real or an empty user password.
    expect(await refused("restricted", "user-pw", annotate)).toEqual(["annotations"]);
    expect(await refused("empty-user", "", annotate)).toEqual(["annotations"]);
    // Print and annotate: a highlight, not a flattened one or a rotated page.
    expect(await refused("annotate-only", "user-pw", annotate)).toBe("exported");
    expect(await refused("annotate-only", "user-pw", annotate, "flatten")).toEqual(["content"]);
    expect(await refused("annotate-only", "user-pw", rotate)).toEqual(["pages"]);
    // The owner password allows all of it.
    expect(await refused("annotate-only", OWNER, annotate, "flatten")).toBe("exported");
    expect(await refused("restricted", OWNER, rotate)).toBe("exported");
  });

  test("an /Encrypt object spelled out in a comment after %%EOF does not weaken the export", async () => {
    const source = fixture("aes-128");
    const text = new TextDecoder("latin1").decode(source);
    const num = /\/Encrypt (\d+) 0 R/.exec(text)![1];
    const start = text.indexOf(`\n${num} 0 obj\n`) + `\n${num} 0 obj\n`.length;
    const dict = text.slice(start, text.indexOf("\nendobj", start));
    const open = dict.replaceAll("/StdCF", "/Identity").replace(/\/Identity <</, "/StdCF <<").replace(/[\r\n]/g, " ");
    expect(open).toContain("/StmF /Identity");
    const hostile = new Uint8Array([...source, ...new TextEncoder().encode(`\n% ${num} 0 obj ${open} endobj\n`)]);
    // PDFium still asks for the password.
    expect(coreOpens(hostile, undefined)).toBe("password");

    const opened = await openAsApp("aes-128", "user-pw", hostile);
    try {
      const model = { pages: opened.pages, overlays: [...opened.imported, highlight("p0")] };
      const outcome = await exportAsApp(opened, "user-pw", model).catch((error: unknown) => error);
      if (outcome instanceof Error) {
        // Refusing is safe; anything else must be as locked as the source.
        expect(outcome.name).toMatch(/^ExportEncryption/);
        return;
      }
      const { bytes } = outcome as ExportRun;
      expect(coreOpens(bytes, undefined)).toBe("password");
      expect(coreOpens(bytes, WRONG)).toBe("password");
      expect(coreOpens(bytes, "user-pw")).toMatchObject({ revision: 4, text: expect.stringContaining("Secret page one") });
      // qpdf, which does not share PDFium's reading of the file, agrees.
      if (QPDF) {
        expect(qpdfRejectsPassword(bytes, undefined)).toBe(true);
        expect(qpdfEncryption(bytes, "user-pw")).toBe(qpdfEncryption(source, "user-pw"));
      }
    } finally {
      await opened.close();
    }
  });
});
