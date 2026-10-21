// The rebuild behind every export that changes anything: copy the selected
// source pages into a fresh document, burn in or attach the overlays, carry
// the catalog structures that still apply, and check the result round-trips.
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
import { pdfSignatureIssue } from "../signatures";
import type { PdfEditKind } from "../security/permissions";
import {
  attachAnnotationsToPage,
  stripAllAnnotationsFromPages,
  stripReplaceableAnnotationsFromPages,
} from "./annotations";
import {
  redactContentTextCoverRects,
  unexcisedEditCount,
  type ContentTextRedaction,
} from "./contentTextRedaction";
import { copySourceDocumentInfo } from "./documentInfo";
import { ExportEncryptedSourceError } from "./encryptedSource";
import { annotationFonts, loadExportFonts } from "./exportFonts";
import {
  ExportSignedSourceError,
  assertDocumentFilesIntegrity,
  assertExportIntegrity,
  assertNoStrayPages,
} from "./exportIntegrity";
import type {
  DocumentFilesPolicy,
  ExportMode,
  ExportOptions,
  ExportQuality,
  ExportResult,
} from "./exportPdf";
import {
  detachDirectLinkDestinations,
  hasPhysicalDocumentFiles,
  inspectDocumentFiles,
  inspectDocumentFilesForPageSelection,
  preserveNavigationCatalogEntries,
  reattachLinkDestinations,
  stripPageDocumentFiles,
  stripUnexportedPageDocumentFiles,
} from "./navigation";
import { isolatePageReferences } from "./pageIsolation";
import { recordCopiedAnnotations } from "./catalogEntries";
import { alignPageTreeWithPdfium } from "./sourcePageTree";
import {
  drawContentTextEditsForPage,
  drawImageOverlaysForPage,
  drawOverlaysForPage,
  type EmbeddedImageCache,
} from "./overlayDraw";
import { annotationTextLostChars } from "./textDraw";

export type RebuildResult = ExportResult & {
  unexcisedEdits: number;
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

export async function rebuildPdf(
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
  // Every sourceIndex is PDFium's page number; see sourcePageTree.ts.
  alignPageTreeWithPdfium(source);
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
      unexcisedEdits: 0,
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
  let unexcisedEdits = 0;
  const embeddedImages: EmbeddedImageCache = new Map();

  // One batched copyPages call for every non-blank model page (repeats
  // allowed, model order). pdf-lib creates a fresh object copier — and with
  // it a fresh dedup cache — per copyPages CALL, so copying page-by-page
  // duplicated every resource shared across pages: a ~670 KB embedded font
  // referenced by 59 pages was copied 59 times, turning a 3 MB source into
  // a 40 MB export. One call shares one cache; shared resources are copied
  // exactly once. Page leafs are still cloned per entry, so duplicated
  // model pages keep getting distinct page objects.
  // Page references are cut first so the copier cannot follow one into a
  // page outside the selection (see pageIsolation.ts).
  const pageIsolation = isolatePageReferences(source, sourceIndices);
  const copiedPages = await out.copyPages(source, sourceIndices);
  pageIsolation.restoreSource();
  recordCopiedAnnotations(out, copiedPages);
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
      unexcisedEdits += unexcisedEditCount(contentTextRedaction);
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

  pageIsolation.resolve(out, copiedPageRefMap);
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
  assertNoStrayPages(out);

  const bytes = await out.save({ useObjectStreams: quality !== "original" });
  // Round-trip guard: never hand back bytes pdf-lib can't re-parse or that
  // lost/gained pages. A corrupt export that reaches disk is worse than a
  // failed one the user can retry.
  await assertExportIntegrity(bytes, out.getPageCount());
  return {
    bytes,
    lostChars: totalLostChars,
    unexcisedEdits,
    unchanged: false,
    pageCount: out.getPageCount(),
  };
}

function resolveDocumentFilesPolicy(
  policy: DocumentFilesPolicy | undefined,
  pagesUnchanged: boolean,
): "preserve" | "omit" {
  if (policy === "preserve" || policy === "omit") return policy;
  return pagesUnchanged ? "preserve" : "omit";
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
