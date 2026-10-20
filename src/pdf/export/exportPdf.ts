import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  degrees,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { DocumentModel, Overlay, PageModel } from "../model/types";
import { isBlankPage } from "../model/types";
import {
  hasPageOrigin,
  overlayToPdfPageSpace,
  pageOrigin,
} from "../model/pageSpace";
import {
  attachAnnotationsToPage,
  stripAllAnnotationsFromPages,
  stripReplaceableAnnotationsFromPages,
} from "./annotations";
import {
  copyDocumentFiles,
  detachDirectLinkDestinations,
  documentFileInventoryMatches,
  hasPhysicalDocumentFiles,
  inspectDocumentFiles,
  inspectDocumentFilesForPageSelection,
  preserveNavigationCatalogEntries,
  reattachLinkDestinations,
  stripPageDocumentFiles,
  stripUnexportedPageDocumentFiles,
} from "./navigation";
import {
  redactContentTextCoverRects,
  type ContentTextRedaction,
} from "./contentTextRedaction";
import { annotationFonts, loadExportFonts } from "./exportFonts";
import {
  drawContentTextEditsForPage,
  drawImageOverlaysForPage,
  drawOverlaysForPage,
  type EmbeddedImageCache,
} from "./overlayDraw";
import { annotationTextLostChars } from "./textDraw";
import { pdfSignatureIssue } from "../signatures";
import { deniedEdits, type PdfEditKind } from "../security/permissions";
import {
  ExportEncryptedSourceError,
  ExportPermissionError,
  type ExportSourceEncryption,
} from "./encryptedSource";

export {
  refuseUnhandledEncryption,
  ExportEncryptedSourceError,
  ExportEncryptionUnsupportedError,
  ExportEncryptionVerifyError,
  ExportPermissionError,
} from "./encryptedSource";

// "annotations" writes real /Annot objects so highlights, notes, shapes,
// ink, and text remain editable in Acrobat / Foxit / PDF Expert. "flatten"
// burns them into the page content stream — useful for signing, stamping,
// or protecting annotations from removal. "none" skips overlays entirely
// and just exports the original pages in the selected range.
export type ExportMode = "annotations" | "flatten" | "none";
export type ExportQuality = "original" | "standard" | "compact";
export type DocumentFilesPolicy = "auto" | "preserve" | "omit";

export type ExportOptions = {
  mode?: ExportMode;
  quality?: ExportQuality;
  // Document-level EmbeddedFiles are not page annotations. The default
  // preserves them only when the source page set is unchanged; callers that
  // know the user's intent (full document vs page/range sharing) should pass
  // an explicit policy. Page/range export must use "omit" to avoid disclosing
  // hidden source data alongside a small selection of visible pages.
  documentFiles?: DocumentFilesPolicy;
  // The app exports a complete overlay model, so its default is to replace
  // source annotations with the model's annotations. Append-only callers
  // such as the CLI do not own the source annotation set and must preserve it.
  preserveSourceAnnotations?: boolean;
  // An encrypted source's handler (./encryptedSource.ts). With it, edits
  // are rebuilt from the plaintext, checked against the source's
  // permissions first, and leave encrypted like the source; without it an
  // encrypted source can only come back untouched. pdf-lib itself never
  // sees a password and writes no encryption.
  sourceEncryption?: ExportSourceEncryption;
  // Simplified-Chinese CJK font. Used for any non-ASCII text unless
  // the overlay contains hiragana/katakana, in which case the JP font
  // below wins (see pickFont).
  unicodeFontUrl?: string;
  unicodeFontBytes?: Uint8Array;
  boldUnicodeFontUrl?: string;
  // Japanese CJK font. Required to export hiragana/katakana at all —
  // the SC subset does not include kana glyphs.
  unicodeJpFontUrl?: string;
  unicodeJpFontBytes?: Uint8Array;
  boldUnicodeJpFontUrl?: string;
  fontFetchTimeoutMs?: number;
  requireUnicodeFont?: boolean;
  unicodeFontErrorMessage?: string;
};

export type ExportResult = {
  bytes: Uint8Array;
  lostChars: number;
};

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

/**
 * Serialize the open document as the byte-level base for an in-app page
 * merge (pasting an image, appending another PDF). Not a user-facing export.
 *
 * This exists so the merge path cannot reach for a user-facing ExportMode.
 * It once passed "none" — the "Original only" choice — which deletes /Annots
 * wholesale and took the document's links and filled form widgets with it on
 * every paste. Links never enter the overlay model, so that loss had no
 * in-app undo. The default mode is the correct one here: it strips only the
 * markup subtypes the overlay model already owns and re-attaches on export,
 * and leaves everything else (links, widgets, unknown subtypes) alone.
 *
 * Overlays are deliberately empty — the merge must not bake them into the
 * bytes; they stay in the model and are re-attached at the next real export.
 */
export type MergeBaseOptions = Pick<
  ExportOptions,
  "unicodeFontUrl" | "unicodeJpFontUrl" | "unicodeFontBytes" | "unicodeJpFontBytes"
> & {
  // Structural typing means a `Pick<>` parameter alone rejects only excess
  // properties on an object *literal*: a variable already typed as
  // ExportOptions is assignable to it and would smuggle a mode through.
  // `never` makes any present mode — literal or variable — a type error.
  mode?: never;
};

export async function exportMergeBase(
  originalBytes: Uint8Array,
  pages: DocumentModel["pages"],
  options: MergeBaseOptions = {},
): Promise<ExportResult> {
  // Projected field by field rather than forwarded wholesale. Types do not
  // survive to runtime, so spreading the caller's object would still hand
  // exportPdf whatever else it happens to carry.
  return exportPdf(
    originalBytes,
    { pages, overlays: [] },
    {
      documentFiles: "preserve",
      unicodeFontUrl: options.unicodeFontUrl,
      unicodeJpFontUrl: options.unicodeJpFontUrl,
      unicodeFontBytes: options.unicodeFontBytes,
      unicodeJpFontBytes: options.unicodeJpFontBytes,
    },
  );
}

export async function exportPdf(
  originalBytes: Uint8Array,
  model: DocumentModel,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const encryption = options.sourceEncryption;
  if (!encryption) {
    const { bytes, lostChars } = await rebuildPdf(originalBytes, model, options);
    return { bytes, lostChars };
  }
  // Every rebuild of an encrypted source starts from its plaintext, so the
  // permissions are checked before any work and the plaintext export goes
  // nowhere but into the source's own handler.
  const rebuilt = await rebuildPdf(
    await encryption.plaintext(),
    model,
    options,
    (edits) => {
      const denied = deniedEdits(encryption.security, edits);
      if (denied.length > 0) throw new ExportPermissionError(denied);
    },
  );
  if (rebuilt.unchanged) {
    return { bytes: new Uint8Array(originalBytes), lostChars: 0 };
  }
  return {
    bytes: await encryption.encrypt(rebuilt.bytes, rebuilt.pageCount),
    lostChars: rebuilt.lostChars,
  };
}

type RebuildResult = ExportResult & {
  /** Nothing to write: `bytes` are the input's, returned as is. */
  unchanged: boolean;
  pageCount: number;
};

/** What a rebuild changes, in the terms of src/pdf/security/permissions.ts. */
function editsOf(change: {
  mode: ExportMode;
  overlays: Overlay[];
  pagesUnchanged: boolean;
  removedAnnotations: boolean;
  removedDocumentFiles: boolean;
}): Set<PdfEditKind> {
  const edits = new Set<PdfEditKind>();
  if (!change.pagesUnchanged) edits.add("pages");
  if (change.removedAnnotations) edits.add("annotations");
  if (change.removedDocumentFiles) edits.add("content");
  if (change.mode === "flatten" && change.overlays.length > 0) edits.add("content");
  if (change.mode === "annotations") {
    for (const overlay of change.overlays) {
      // Placed images and original-text edits draw into the page content;
      // everything else is written as an annotation.
      edits.add(
        overlay.type === "image" || overlay.type === "contentText"
          ? "content"
          : "annotations",
      );
    }
  }
  return edits;
}

async function rebuildPdf(
  originalBytes: Uint8Array,
  model: DocumentModel,
  options: ExportOptions,
  beforeRebuild?: (edits: Set<PdfEditKind>) => void,
): Promise<RebuildResult> {
  const mode: ExportMode = options.mode ?? "annotations";
  const quality: ExportQuality = options.quality ?? "original";
  const exportedPageIds = new Set(model.pages.map((page) => page.id));
  const exportedOverlays =
    mode === "none"
      ? []
      : model.overlays.filter((overlay) => exportedPageIds.has(overlay.pageId));
  // Clone the bytes to avoid detaching the caller's buffer. ignoreEncryption
  // lets pdf-lib parse PDFs the engine already decrypted at open time.
  const source = await PDFDocument.load(new Uint8Array(originalBytes), {
    ignoreEncryption: true,
  });
  const sourcePages = source.getPages();
  const sourceIndices = model.pages
    .filter((page) => !isBlankPage(page))
    .map((page) => page.sourceIndex);
  const pagesUnchanged = pagesMatchSource(model.pages, sourcePages);
  const documentFiles = resolveDocumentFilesPolicy(
    options.documentFiles,
    pagesUnchanged,
  );
  const sourceDocumentFiles = inspectDocumentFiles(source);
  const sourceHasDocumentFiles = sourceDocumentFiles.hasDocumentFiles;
  const mustRemoveDocumentFiles =
    documentFiles === "omit" &&
    (sourceHasDocumentFiles || hasPhysicalDocumentFiles(source));
  const removedPageDocumentFiles =
    documentFiles === "omit" ? stripPageDocumentFiles(source) : false;
  const removedSourceAnnotations =
    mode === "none"
      ? stripAllAnnotationsFromPages(sourcePages)
      : options.preserveSourceAnnotations
        ? false
        : stripReplaceableAnnotationsFromPages(sourcePages);
  const removedUnexportedPageDocumentFiles =
    documentFiles === "preserve" && !pagesUnchanged
      ? stripUnexportedPageDocumentFiles(source, new Set(sourceIndices))
      : false;
  if (
    exportedOverlays.length === 0 &&
    !removedPageDocumentFiles &&
    !removedSourceAnnotations &&
    !removedUnexportedPageDocumentFiles &&
    pagesUnchanged &&
    !mustRemoveDocumentFiles
  ) {
    return {
      bytes: new Uint8Array(originalBytes),
      lostChars: 0,
      unchanged: true,
      pageCount: sourcePages.length,
    };
  }
  beforeRebuild?.(
    editsOf({
      mode,
      overlays: exportedOverlays,
      pagesUnchanged,
      removedAnnotations: removedSourceAnnotations,
      removedDocumentFiles:
        mustRemoveDocumentFiles ||
        removedPageDocumentFiles ||
        removedUnexportedPageDocumentFiles,
    }),
  );
  // Past this point we rebuild the document, which requires readable content
  // streams. See ExportEncryptedSourceError — this must stay AFTER the
  // unmodified fast path (which hands back the original bytes untouched) and
  // BEFORE any work that would produce an unreadable output file.
  if (source.isEncrypted) {
    throw new ExportEncryptedSourceError();
  }
  const signatureIssue = pdfSignatureIssue(source);
  if (signatureIssue) {
    throw new ExportSignedSourceError(signatureIssue);
  }
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  copySourceDocumentInfo(source, out);
  // Must run before copyPages — see detachDirectLinkDestinations.
  const detachedLinks = detachDirectLinkDestinations(source);
  const copiedPageRefMap = new Map<string, PDFRef>();
  const exportedPageNodes: { sourceIndex: number; node: PDFDict }[] = [];

  const fonts = await loadExportFonts(out, exportedOverlays, mode, options);

  let totalLostChars = 0;
  const embeddedImages: EmbeddedImageCache = new Map();

  // One batched copyPages call for every non-blank model page (repeats
  // allowed, model order). pdf-lib creates a fresh object copier — and with
  // it a fresh dedup cache — per copyPages CALL, so copying page-by-page
  // duplicated every resource shared across pages: a ~670 KB embedded font
  // referenced by 59 pages was copied 59 times, turning a 3 MB source into
  // a 40 MB export. One call shares one cache; shared resources are copied
  // exactly once. Page leafs are still cloned per entry, so duplicated
  // model pages keep getting distinct page objects.
  const copiedPages = await out.copyPages(source, sourceIndices);
  const duplicatedSourceIndices = new Set(
    sourceIndices.filter(
      (index, position) => sourceIndices.indexOf(index) !== position,
    ),
  );
  let copiedCursor = 0;

  for (const page of model.pages) {
    let inserted: PDFPage;
    if (isBlankPage(page)) {
      inserted = out.addPage([page.widthPt, page.heightPt]);
    } else {
      const copied = copiedPages[copiedCursor];
      copiedCursor += 1;
      if (!copied) {
        throw new Error(`Failed to copy source page ${page.sourceIndex + 1}.`);
      }
      inserted = out.addPage(copied);
      if (duplicatedSourceIndices.has(page.sourceIndex)) {
        // Duplicate copies of one source page share the same copied /Annots
        // array object (PDFPageLeaf.normalize reuses it without cloning), so
        // an annotation added to one duplicate would leak onto the others.
        const annots = inserted.node.lookupMaybe(
          PDFName.of("Annots"),
          PDFArray,
        );
        if (annots) {
          inserted.node.set(PDFName.of("Annots"), annots.clone(out.context));
        }
      }
    }
    if (!isBlankPage(page)) {
      const sourceRef = sourcePages[page.sourceIndex]?.ref;
      if (sourceRef && !copiedPageRefMap.has(sourceRef.toString())) {
        copiedPageRefMap.set(sourceRef.toString(), inserted.ref);
      }
      exportedPageNodes.push({
        sourceIndex: page.sourceIndex,
        node: inserted.node,
      });
    }
    inserted.setRotation(degrees(page.rotation));
    const pageOverlays = overlaysForPdfPage(page, exportedOverlays);
    let contentTextRedaction: ContentTextRedaction | undefined;
    if (mode !== "none") {
      // Original-text edits: excise the covered source glyphs from the page
      // content so search/copy/screen readers see only the replacement text.
      // Best-effort — on any unsupported construct the page keeps its bytes
      // and the cover-and-redraw below still hides the old glyphs visually.
      contentTextRedaction = redactContentTextCoverRects(
        inserted,
        pageOverlays,
      );
    }
    if (mode === "flatten") {
      totalLostChars += await drawOverlaysForPage(
        inserted,
        pageOverlays,
        fonts,
        embeddedImages,
        contentTextRedaction,
      );
    } else if (mode === "annotations") {
      totalLostChars += drawContentTextEditsForPage(
        inserted,
        pageOverlays,
        fonts,
        contentTextRedaction,
      );
      totalLostChars += annotationTextLostChars(pageOverlays, fonts);
      await drawImageOverlaysForPage(inserted, pageOverlays, embeddedImages);
      attachAnnotationsToPage(
        inserted,
        page,
        pageOverlays,
        annotationFonts(fonts),
      );
    }
    // mode === "none": no overlays written.
  }

  reattachLinkDestinations(
    out,
    exportedPageNodes,
    detachedLinks,
    copiedPageRefMap,
  );
  preserveNavigationCatalogEntries(source, out, copiedPageRefMap, {
    pagesUnchanged,
    documentFiles,
  });
  // Page-owned files follow their page. The source was projected above by
  // removing only edges from pages that are no longer exported, so Catalog
  // attachments and files shared with retained pages remain in this expected
  // inventory while deleted-page-only payloads do not.
  const expectedDocumentFiles = inspectDocumentFilesForPageSelection(
    source,
    new Set(sourceIndices),
  );
  assertDocumentFilesIntegrity(expectedDocumentFiles, out, documentFiles);

  const bytes = await out.save({ useObjectStreams: quality !== "original" });
  // Round-trip guard: never hand back bytes pdf-lib can't re-parse or that
  // lost/gained pages. A corrupt export that reaches disk is worse than a
  // failed one the user can retry.
  await assertExportIntegrity(bytes, out.getPageCount());
  return {
    bytes,
    lostChars: totalLostChars,
    unchanged: false,
    pageCount: out.getPageCount(),
  };
}

/**
 * Add a source PDF's document-level files to an already serialized output.
 *
 * The compact raster path builds pages independently from exportPdf(). This
 * byte-level bridge lets it preserve EmbeddedFiles, /AF, and /Collection with
 * the same raw-object copier, without decoding or reattaching payloads and
 * without copying active /Names/JavaScript entries.
 */
export async function preserveDocumentFilesInPdf(
  sourceBytes: Uint8Array,
  outputBytes: Uint8Array,
): Promise<Uint8Array> {
  const source = await PDFDocument.load(new Uint8Array(sourceBytes), {
    ignoreEncryption: true,
  });
  // Raster pages cannot carry page annotations or page /AF associations.
  // Preserve only file structures rooted outside the page tree (Catalog and
  // Info). A page-only attachment follows the vector page/annotation path and
  // must not make compact export fail after the page was intentionally
  // rasterized.
  const sourceDocumentFiles = inspectDocumentFilesForPageSelection(
    source,
    new Set(),
  );
  // Before any early return: an encrypted source here means a raster is
  // being built without its handler, and must not leave at all. pdf-lib
  // parses it with ignoreEncryption but decrypts nothing, so its files would
  // be ciphertext under a normal EmbeddedFile wrapper anyway.
  if (source.isEncrypted) {
    throw new ExportEncryptedSourceError();
  }
  if (!sourceDocumentFiles.hasDocumentFiles) return outputBytes;
  const output = await PDFDocument.load(new Uint8Array(outputBytes));
  if (!copyDocumentFiles(source, output)) {
    throw new ExportIntegrityError("document-files-missing-after-copy");
  }
  assertDocumentFilesIntegrity(sourceDocumentFiles, output, "preserve");
  const bytes = await output.save({ useObjectStreams: true });
  await assertExportIntegrity(bytes, output.getPageCount());
  return bytes;
}

function assertDocumentFilesIntegrity(
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

function resolveDocumentFilesPolicy(
  policy: DocumentFilesPolicy | undefined,
  pagesUnchanged: boolean,
): "preserve" | "omit" {
  if (policy === "preserve" || policy === "omit") return policy;
  return pagesUnchanged ? "preserve" : "omit";
}

// Export builds a brand-new document, whose Info dict starts empty — so every
// export used to strip Title/Author/Subject/Keywords and stamp pdf-lib as the
// Producer. A paper annotated in Shiori then showed up untitled and authorless
// in Finder, Zotero, Calibre and Mendeley, usually noticed weeks later.
//
// Producer and ModificationDate are deliberately NOT carried over: pdf-lib
// sets those on save, and they should describe the tool that wrote this file.
// CreationDate is, because it describes the document, not the write.
function copySourceDocumentInfo(source: PDFDocument, dest: PDFDocument) {
  const title = safeInfoRead(() => source.getTitle());
  if (title) dest.setTitle(title);
  const author = safeInfoRead(() => source.getAuthor());
  if (author) dest.setAuthor(author);
  const subject = safeInfoRead(() => source.getSubject());
  if (subject) dest.setSubject(subject);
  const keywords = safeInfoRead(() => source.getKeywords());
  if (keywords) dest.setKeywords([keywords]);
  const creator = safeInfoRead(() => source.getCreator());
  if (creator) dest.setCreator(creator);
  const creationDate = safeInfoRead(() => source.getCreationDate());
  if (creationDate) dest.setCreationDate(creationDate);
}

// Info entries come from arbitrary files and pdf-lib throws when one holds an
// unexpected type (a date that will not parse, a name where a string belongs).
// Losing one field is not a reason to fail an export.
function safeInfoRead<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
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

function pagesMatchSource(modelPages: PageModel[], sourcePages: PDFPage[]): boolean {
  if (modelPages.length !== sourcePages.length) return false;
  return modelPages.every((page, index) => {
    if (isBlankPage(page)) return false;
    if (page.sourceIndex !== index) return false;
    const sourcePage = sourcePages[index]!;
    const sourceBox = sourcePage.getCropBox();
    const origin = pageOrigin(page);
    return (
      page.rotation === normalizeRotation(sourcePage.getRotation().angle) &&
      nearlyEqual(page.widthPt, sourceBox.width) &&
      nearlyEqual(page.heightPt, sourceBox.height) &&
      nearlyEqual(origin.x, sourceBox.x) &&
      nearlyEqual(origin.y, sourceBox.y)
    );
  });
}

function overlaysForPdfPage(page: PageModel, overlays: Overlay[]): Overlay[] {
  const pageOverlays = overlays.filter((overlay) => overlay.pageId === page.id);
  if (!hasPageOrigin(page)) return pageOverlays;
  return pageOverlays.map((overlay) => overlayToPdfPageSpace(page, overlay));
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01;
}

function normalizeRotation(angle: number): PageModel["rotation"] {
  return ((((angle % 360) + 360) % 360) as PageModel["rotation"]);
}

