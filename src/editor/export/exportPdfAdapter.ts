import { appPdfEngine } from "../../pdf/engine/appEngine";
import {
  withSourceEncryption,
  type ExportSourceEncryption,
  type OpenedEncryptedPdf,
} from "../../pdf/export/encryptedSource";

/**
 * Test seam for the export dialog's lazy-loaded writer. Keeping the adapter in
 * the editor layer prevents dialog tests from replacing the shared PDF export
 * module for every other test file in Bun's process.
 */
export function loadExportPdfModule(): Promise<
  typeof import("../../pdf/export/exportPdf")
> {
  return import("../../pdf/export/exportPdf");
}

/** The open document's encryption handler for one export, through the app's engine. */
export function withExportEncryption<T>(
  opened: OpenedEncryptedPdf,
  run: (encryption: ExportSourceEncryption | undefined) => Promise<T>,
): Promise<T> {
  return withSourceEncryption(appPdfEngine, opened, run);
}
