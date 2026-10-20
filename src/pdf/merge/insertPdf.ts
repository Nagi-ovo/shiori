import {
  PDFDict,
  PDFDocument,
  PDFRef,
} from "pdf-lib";
import type { PageModel, Rotation } from "../model/types";
import {
  assertPdfPageDimensionsWithinLimit,
  assertPdfWithinPageLimit,
} from "../openPolicy";
import {
  assertExportIntegrity,
  exportPdf,
  ExportEncryptedSourceError,
  ExportIntegrityError,
} from "../export/exportPdf";
import {
  detachDirectLinkDestinations,
  documentFileInventoryMatches,
  inspectDocumentFiles,
  reattachLinkDestinations,
} from "../export/navigation";
import { pdfSignatureIssue } from "../signatures";
import type { ExportSourceEncryption } from "../export/encryptedSource";
import { deniedEdits } from "../security/permissions";
import { PdfPageInsertError } from "./insertErrors";
import { hasUnsupportedInteractiveContent } from "./interactiveContent";
import {
  assertIncomingLinkDestinations,
  remapInsertedNumericLinks,
  shiftBasePositionalStructures,
} from "./insertNavigation";
import { mergeReferencedNamedDestinations } from "./namedDestinations";

export { PdfPageInsertError, type PdfPageInsertErrorCode } from "./insertErrors";

export type InsertPdfPagesResult = {
  bytes: Uint8Array;
  insertedPageCount: number;
};

/**
 * Insert every page of `incomingBytes` into `baseBytes` at a zero-based page
 * boundary. This is deliberately a page operation, not a document merge:
 *
 * - the base document's attachments remain byte-for-byte represented;
 * - incoming document attachments are removed through export's fail-closed
 *   attachment boundary before any page reaches the base document;
 * - direct and named GoTo links between incoming pages are remapped;
 * - incoming forms/signatures are rejected because copying Widget pages
 *   without their document-level AcroForm would create a plausible-looking,
 *   broken form.
 */
export async function insertPdfPages(
  baseBytes: Uint8Array,
  incomingBytes: Uint8Array,
  insertionIndex: number,
  incomingName = "document.pdf",
  sourceEncryption?: ExportSourceEncryption,
): Promise<InsertPdfPagesResult> {
  return withPageInsertionEncryption(baseBytes, sourceEncryption, (plain) =>
    insertPlainPdfPages(plain, incomingBytes, insertionIndex, incomingName),
  );
}

/**
 * Plaintext exists only inside this operation. The returned bytes are encrypted
 * before any caller can reopen, cache or autosave the replacement document.
 * Shared with workspace ports so the lazy insertion writer stays injectable.
 */
export async function withPageInsertionEncryption(
  baseBytes: Uint8Array,
  encryption: ExportSourceEncryption | undefined,
  insert: (plain: Uint8Array) => Promise<InsertPdfPagesResult>,
): Promise<InsertPdfPagesResult> {
  if (!encryption) return insert(baseBytes);
  if (!encryption.security) {
    throw new PdfPageInsertError("baseEncryption", "The base PDF's security is unknown.");
  }
  if (deniedEdits(encryption.security, ["pages"]).length > 0) {
    throw new PdfPageInsertError("pagesPermission", "The opening password does not allow inserting pages.");
  }
  const plaintext = await baseEncryptionStep(() => encryption.plaintext());
  const result = await insert(plaintext);
  const plain = await PDFDocument.load(result.bytes);
  // encrypt also verifies reopening; both belong to the base handler. Keep
  // the incoming writer outside this boundary so its errors keep their meaning.
  const bytes = await baseEncryptionStep(() => encryption.encrypt(result.bytes, plain.getPageCount()));
  return { ...result, bytes };
}

async function baseEncryptionStep<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new PdfPageInsertError(
      "baseEncryption",
      "The base PDF's encryption handler failed.",
      { cause },
    );
  }
}

async function insertPlainPdfPages(
  baseBytes: Uint8Array,
  incomingBytes: Uint8Array,
  insertionIndex: number,
  incomingName: string,
): Promise<InsertPdfPagesResult> {
  const base = await PDFDocument.load(new Uint8Array(baseBytes), {
    ignoreEncryption: true,
  });
  if (base.isEncrypted) {
    throw new PdfPageInsertError(
      "baseEncryption",
      "The current encrypted PDF cannot be rewritten safely.",
    );
  }
  assertBaseIsNotSigned(base);
  if (
    !Number.isInteger(insertionIndex) ||
    insertionIndex < 0 ||
    insertionIndex > base.getPageCount()
  ) {
    throw new PdfPageInsertError(
      "invalidPosition",
      `Invalid PDF insertion position: ${insertionIndex}`,
    );
  }

  const parsedIncoming = await PDFDocument.load(new Uint8Array(incomingBytes), {
    ignoreEncryption: true,
  });
  if (parsedIncoming.isEncrypted) {
    throw new PdfPageInsertError(
      "encryptedIncoming",
      "Password-protected PDFs cannot be inserted safely.",
    );
  }
  if (parsedIncoming.getPageCount() === 0) {
    throw new PdfPageInsertError("empty", "The selected PDF has no pages.");
  }
  if (hasUnsupportedInteractiveContent(parsedIncoming)) {
    throw new PdfPageInsertError(
      "interactive",
      "The selected PDF contains forms or signature structures.",
    );
  }
  assertIncomingLinkDestinations(parsedIncoming);
  assertPdfWithinPageLimit(
    base.getPageCount() + parsedIncoming.getPageCount(),
  );

  // Run the source through the same audited omission boundary used by partial
  // exports. It strips Catalog, page, annotation, structure-tree and action
  // attachment routes, then refuses to serialize if any physical embedded
  // file remains. A bespoke `copyPages()` filter would inevitably miss one of
  // those legal PDF topologies.
  const sanitized = await exportPdf(
    incomingBytes,
    { pages: pageModelsFor(parsedIncoming), overlays: [] },
    {
      mode: "annotations",
      preserveSourceAnnotations: true,
      documentFiles: "omit",
    },
  ).catch((error: unknown) => {
    if (error instanceof ExportEncryptedSourceError) {
      throw new PdfPageInsertError("encryptedIncoming", error.message);
    }
    if (error instanceof ExportIntegrityError) {
      throw new PdfPageInsertError(
        "documentFiles",
        "The selected PDF's embedded files cannot be omitted safely.",
      );
    }
    throw error;
  });
  const incoming = await PDFDocument.load(new Uint8Array(sanitized.bytes));
  const insertedPageCount = incoming.getPageCount();
  if (insertedPageCount === 0) {
    throw new PdfPageInsertError("empty", "The selected PDF has no pages.");
  }
  assertIncomingLinkDestinations(incoming);

  const baseDocumentFiles = inspectDocumentFiles(base);
  const basePageNodes = base.getPages().map((page) => page.node);
  // Appending moves no base page, so its navigation needs no remap; walking
  // it anyway would refuse files whose stale links stay as they were.
  if (insertionIndex < basePageNodes.length) {
    shiftBasePositionalStructures(
      base,
      basePageNodes,
      insertionIndex,
      insertedPageCount,
    );
  }
  const detachedLinks = detachDirectLinkDestinations(incoming);
  const sourcePages = incoming.getPages();
  const copiedPages = await base.copyPages(
    incoming,
    incoming.getPageIndices(),
  );
  const pageRefMap = new Map<string, PDFRef>();
  const insertedNodes: { sourceIndex: number; node: PDFDict }[] = [];
  copiedPages.forEach((page, sourceIndex) => {
    base.insertPage(insertionIndex + sourceIndex, page);
    const sourcePage = sourcePages[sourceIndex];
    if (!sourcePage) {
      throw new PdfPageInsertError(
        "navigation",
        `Missing source page ${sourceIndex + 1} during insertion.`,
      );
    }
    pageRefMap.set(sourcePage.ref.toString(), page.ref);
    insertedNodes.push({ sourceIndex, node: page.node });
  });

  const reattached = reattachLinkDestinations(
    base,
    insertedNodes,
    detachedLinks,
    pageRefMap,
  );
  if (reattached.dropped > 0 || reattached.unresolved > 0) {
    throw new PdfPageInsertError(
      "navigation",
      "A direct page link could not be remapped into the inserted page set.",
    );
  }
  remapInsertedNumericLinks(
    base,
    copiedPages.map((page) => page.node),
    insertionIndex,
    insertedPageCount,
  );
  mergeReferencedNamedDestinations(
    incoming,
    base,
    copiedPages.map((page) => page.node),
    pageRefMap,
    incomingName,
  );

  const bytes = await base.save();
  await assertExportIntegrity(bytes, base.getPageCount());
  const roundTripped = await PDFDocument.load(bytes);
  // This exact inventory comparison serves both sides of the privacy
  // boundary: no base attachment may disappear, and no incoming attachment
  // may hitch a ride through an unanticipated page object route.
  if (!documentFileInventoryMatches(baseDocumentFiles, roundTripped)) {
    throw new PdfPageInsertError(
      "baseDocumentFiles",
      "Document attachment inventory changed during page insertion.",
    );
  }
  return { bytes, insertedPageCount };
}

/** Existing image-paste callers append at the final page boundary. */
export async function appendPdfBytes(
  baseBytes: Uint8Array,
  appendBytes: Uint8Array,
): Promise<Uint8Array> {
  const base = await PDFDocument.load(new Uint8Array(baseBytes), {
    ignoreEncryption: true,
  });
  return (
    await insertPdfPages(
      baseBytes,
      appendBytes,
      base.getPageCount(),
      "pasted-image.pdf",
    )
  ).bytes;
}

function pageModelsFor(document: PDFDocument): PageModel[] {
  return document.getPages().map((page, sourceIndex) => {
    const crop = page.getCropBox();
    assertPdfPageDimensionsWithinLimit(crop.width, crop.height, sourceIndex + 1);
    return {
      id: `insert-source-${sourceIndex}`,
      sourceIndex,
      rotation: normalizeRotation(page.getRotation().angle),
      originXPt: crop.x,
      originYPt: crop.y,
      widthPt: crop.width,
      heightPt: crop.height,
    };
  });
}

function normalizeRotation(value: number): Rotation {
  const normalized = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
  return normalized as Rotation;
}

function assertBaseIsNotSigned(document: PDFDocument) {
  const issue = pdfSignatureIssue(document);
  if (issue) throw new PdfPageInsertError("baseSigned", issue);
}
