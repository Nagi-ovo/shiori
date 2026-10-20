// Fail-closed checks every rebuilt export passes before it is handed back,
// and the errors that refuse an export instead of writing a broken or
// misleading file.
import { PDFDocument } from "pdf-lib";
import {
  documentFileInventoryMatches,
  hasPhysicalDocumentFiles,
  inspectDocumentFiles,
} from "./navigation";

// Thrown when the freshly serialized PDF fails to round-trip (won't re-parse,
// or lost/gained pages). The export caller catches this to show an error and
// keep the user's source intact, rather than writing a broken file to disk.
export class ExportIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportIntegrityError";
  }
}

// Rebuilding a signed PDF rewrites object offsets and byte ranges, invalidating
// its certification even when every visible page looks unchanged. Never emit a
// file that still contains signature chrome but no longer carries that trust.
export class ExportSignedSourceError extends Error {
  constructor(reason: string) {
    super(`Cannot rebuild a signed PDF safely. ${reason}`);
    this.name = "ExportSignedSourceError";
  }
}

export function assertDocumentFilesIntegrity(
  expected: ReturnType<typeof inspectDocumentFiles>,
  output: PDFDocument,
  policy: "preserve" | "omit",
) {
  if (policy === "omit") {
    if (hasPhysicalDocumentFiles(output)) {
      throw new ExportIntegrityError("document-files-remain-after-omit");
    }
    return;
  }
  if (!documentFileInventoryMatches(expected, output)) {
    throw new ExportIntegrityError("document-files-mismatch-after-copy");
  }
}

// Re-parse the freshly serialized PDF and confirm it round-trips: it loads,
// has exactly the page count we built, and every page exposes readable
// geometry. Throws ExportIntegrityError so the caller can surface the failure
// instead of saving a broken file. The unchanged-source fast path above is not
// checked — those bytes are the user's original, already parsed at open time.
export async function assertExportIntegrity(
  bytes: Uint8Array,
  expectedPageCount: number,
): Promise<void> {
  let reloaded: PDFDocument;
  try {
    reloaded = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (err) {
    throw new ExportIntegrityError(
      `reload-failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const actual = reloaded.getPageCount();
  if (actual !== expectedPageCount) {
    throw new ExportIntegrityError(
      `page-count-mismatch: expected ${expectedPageCount}, got ${actual}`,
    );
  }
  try {
    for (const page of reloaded.getPages()) {
      page.getSize();
    }
  } catch (err) {
    throw new ExportIntegrityError(
      `page-geometry-invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
