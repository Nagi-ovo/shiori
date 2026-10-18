import { PDFDocument } from "pdf-lib";
import type { EncryptedPdfSource, PdfDocument, PdfEngine, PdfSecurity } from "../engine/types";
import type { PdfEditKind } from "../security/permissions";

/**
 * How exportPdf reaches an encrypted source's handler: the file in the clear
 * to rebuild from, and the way back under its own /Encrypt and file key
 * (crates/shiori-core/src/encryption.rs). Whatever goes into `encrypt` is the
 * plaintext export; only its result may leave exportPdf.
 */
export type ExportSourceEncryption = {
  /** What the password that opened the file allows; null when unrestricted. */
  security: PdfSecurity | null;
  plaintext: () => Promise<Uint8Array>;
  /** Encrypts like the source, and rejects unless the result reopens with `pageCount` pages. */
  encrypt: (plain: Uint8Array, pageCount: number) => Promise<Uint8Array>;
};

/** The source's permissions (/P) refuse an edit this export would write. */
export class ExportPermissionError extends Error {
  readonly denied: PdfEditKind[];
  constructor(denied: PdfEditKind[]) {
    super(`The PDF's permissions do not allow these edits: ${denied.join(", ")}.`);
    this.name = "ExportPermissionError";
    this.denied = denied;
  }
}

/** The source's encryption cannot be reproduced faithfully, so nothing was written. */
export class ExportEncryptionUnsupportedError extends Error {
  constructor(detail: string) {
    super(`Cannot re-encrypt the export like its source: ${detail}`);
    this.name = "ExportEncryptionUnsupportedError";
  }
}

/** The re-encrypted export did not reopen with the source's password. */
export class ExportEncryptionVerifyError extends Error {
  constructor(detail: string) {
    super(`The re-encrypted export failed verification: ${detail}`);
    this.name = "ExportEncryptionVerifyError";
  }
}

// Thrown when the source PDF is encrypted and the export has no handler for
// it (`sourceEncryption`): the CLI, a file whose /Encrypt PDFium did not
// apply, or one whose security the engine could not report. With the
// handler, edits are made on the plaintext and leave re-encrypted like the
// source instead (printing rebuilds from the plaintext and keeps the copy in
// memory for the print frame: src/pdf/export/printablePdf.ts). pdf-lib's
// `ignoreEncryption` suppresses the parse error but does NOT decrypt:
// content streams and strings stay ciphertext, and a copy
// with no /Encrypt is structurally valid (assertExportIntegrity passes) yet
// renders blank or garbled. A raster drawn from the decrypted pages would
// instead leave in the clear. Failing loudly beats either. exportPdf's
// unmodified fast path still returns the original bytes untouched.
export class ExportEncryptedSourceError extends Error {
  constructor() {
    super(
      "Cannot export an encrypted PDF: pdf-lib can parse it but not decrypt " +
        "it, so the exported file would be unreadable.",
    );
    this.name = "ExportEncryptedSourceError";
  }
}

export type OpenedEncryptedPdf = {
  doc: PdfDocument;
  bytes: Uint8Array;
  password?: string;
  encrypted?: boolean;
};

const UNSUPPORTED = "re-encryption unsupported";

const carriesEncrypt = new WeakMap<Uint8Array, Promise<boolean>>();

/**
 * Refuses `bytes` when pdf-lib finds an /Encrypt in their trailer: an
 * export without the source's handler must not run on them. Read once per
 * buffer, since every size preview asks again.
 */
export async function refuseUnhandledEncryption(bytes: Uint8Array): Promise<void> {
  let encrypted = carriesEncrypt.get(bytes);
  if (!encrypted) {
    encrypted = PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }).then(
      (pdf) => pdf.isEncrypted,
    );
    carriesEncrypt.set(bytes, encrypted);
  }
  if (await encrypted) throw new ExportEncryptedSourceError();
}

/**
 * Runs `run` with the open document's encryption handler, or with undefined
 * when the document is not encrypted. The password stays in this call: the
 * engine sees it when the source opens again and when the output is checked,
 * and nothing it returns or throws carries it. The source opens on first use
 * and closes when `run` settles.
 */
export async function withSourceEncryption<T>(
  engine: PdfEngine,
  opened: OpenedEncryptedPdf,
  run: (encryption: ExportSourceEncryption | undefined) => Promise<T>,
): Promise<T> {
  // Security unknown is never "unencrypted": an engine that cannot tell,
  // or that reports none for bytes carrying an /Encrypt (one PDFium did not
  // apply), stops every route here, before a raster can leave in the clear.
  let security: PdfSecurity | null;
  try {
    security = engine.security(opened.doc);
  } catch {
    throw new ExportEncryptedSourceError();
  }
  if (!security) {
    await refuseUnhandledEncryption(opened.bytes);
    return run(undefined);
  }
  const password = opened.password ?? "";
  const opening: { source: Promise<EncryptedPdfSource> | null } = { source: null };
  const sourceOnce = () => (opening.source ??= engine.openEncryptedSource(opened.bytes, password));
  const encryption: ExportSourceEncryption = {
    security,
    plaintext: async () => (await sourceOnce()).plaintext(),
    encrypt: async (plain, pageCount) => {
      let encrypted: Uint8Array;
      try {
        encrypted = await (await sourceOnce()).encrypt(plain);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith(UNSUPPORTED)) {
          throw new ExportEncryptionUnsupportedError(message.slice(UNSUPPORTED.length).replace(/^:\s*/, ""));
        }
        throw error;
      }
      await verifyReopens(engine, encrypted, opened.bytes, password, security, pageCount);
      return encrypted;
    },
  };
  try {
    return await run(encryption);
  } finally {
    await opening.source?.then(
      (source) => source.close(),
      () => undefined,
    );
  }
}

/**
 * Whether `bytes` open with `password`. Only a refusal counts as no: the
 * engine rejects a wrong or missing password with an error.
 */
async function opensWith(engine: PdfEngine, bytes: Uint8Array, password: string): Promise<boolean> {
  let doc: PdfDocument;
  try {
    ({ doc } = await engine.load(bytes, { password }));
  } catch {
    return false;
  }
  await engine.destroy(doc);
  return true;
}

/** A password no source has: its first character is a control character. */
function wrongPassword(password: string): string {
  return password.startsWith("\u0001") ? "\u0002shiori-wrong-password" : "\u0001shiori-wrong-password";
}

/**
 * The re-encrypted export must be exactly as locked as its source, as
 * PDFium reads both: the same password opens it to the same handler
 * revision, /P and permissions and the same pages, and no password or a
 * wrong one opens it unless it opens the source too. The core picks the
 * handler from the source's bytes; this check does not trust that it picked
 * the one PDFium applied.
 */
async function verifyReopens(
  engine: PdfEngine,
  encrypted: Uint8Array,
  source: Uint8Array,
  password: string,
  security: PdfSecurity,
  pageCount: number,
): Promise<void> {
  let doc: PdfDocument;
  try {
    ({ doc } = await engine.load(encrypted, { password }));
  } catch {
    throw new ExportEncryptionVerifyError("it does not open with the source's password");
  }
  try {
    const reopened = engine.security(doc);
    if (reopened?.revision !== security.revision) {
      throw new ExportEncryptionVerifyError("its security handler differs from the source's");
    }
    if (
      reopened.userPermissions >>> 0 !== security.userPermissions >>> 0 ||
      reopened.permissions >>> 0 !== security.permissions >>> 0
    ) {
      throw new ExportEncryptionVerifyError("its permissions differ from the source's");
    }
    if (engine.pageCount(doc) !== pageCount) {
      throw new ExportEncryptionVerifyError(`expected ${pageCount} pages, found ${engine.pageCount(doc)}`);
    }
  } finally {
    await engine.destroy(doc);
  }
  for (const probe of ["", wrongPassword(password)]) {
    if (probe === password) continue;
    if ((await opensWith(engine, encrypted, probe)) && !(await opensWith(engine, source, probe))) {
      throw new ExportEncryptionVerifyError(
        probe === "" ? "it opens without a password" : "it opens with a wrong password",
      );
    }
  }
}
