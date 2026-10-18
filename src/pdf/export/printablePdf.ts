import type { PdfEngine } from "../engine/types";
import type { DocumentModel } from "../model/types";
import { mayPrint } from "../security/permissions";
import {
  ExportEncryptedSourceError,
  withSourceEncryption,
  type OpenedEncryptedPdf,
} from "./encryptedSource";
import { exportPdf, ExportSignedSourceError, type ExportOptions } from "./exportPdf";

/** What the print frame gets, or why the source cannot give it. */
export type PrintableResult =
  | { kind: "ready"; bytes: Uint8Array; lostChars: number }
  | { kind: "refused"; reason: PrintRefusal };

/**
 * - permission: the password that opened the file does not allow printing;
 * - securityUnknown: the engine could not report the file's security, or
 *   the file carries an /Encrypt the engine did not apply;
 * - signed: the print copy would be a rebuild of a signed or certified file.
 */
export type PrintRefusal = "permission" | "securityUnknown" | "signed";

export type PrintableFonts = Pick<ExportOptions, "unicodeFontUrl" | "unicodeJpFontUrl">;

/**
 * The PDF the browser's print frame paints: overlays flattened into the page
 * content (the frame's viewer prints pages, not Shiori's model) and document
 * files left out (a print copy has no use for hidden payloads, and carrying
 * them costs memory). An untouched unencrypted file comes back as it is.
 *
 * An encrypted file is printed from the engine's plaintext once the password
 * that opened it allows printing: the frame's viewer cannot decrypt it (it
 * would ask again for the password or print nothing), and the rebuild only
 * reads the clear text. The result is the plaintext copy; the caller hands
 * it to the print frame alone and never writes, caches or re-encrypts it.
 */
export async function exportPrintablePdf(
  engine: PdfEngine,
  opened: OpenedEncryptedPdf,
  model: DocumentModel,
  fonts: PrintableFonts = {},
): Promise<PrintableResult> {
  try {
    return await withSourceEncryption(engine, opened, async (encryption) => {
      if (encryption && !mayPrint(encryption.security)) {
        return { kind: "refused", reason: "permission" } as const;
      }
      const source = encryption ? await encryption.plaintext() : opened.bytes;
      const result = await exportPdf(source, model, {
        mode: "flatten",
        quality: "standard",
        documentFiles: "omit",
        unicodeFontUrl: fonts.unicodeFontUrl,
        unicodeJpFontUrl: fonts.unicodeJpFontUrl,
      });
      return { kind: "ready", bytes: result.bytes, lostChars: result.lostChars } as const;
    });
  } catch (error) {
    if (error instanceof ExportSignedSourceError) return { kind: "refused", reason: "signed" };
    if (error instanceof ExportEncryptedSourceError) {
      return { kind: "refused", reason: "securityUnknown" };
    }
    throw error;
  }
}
