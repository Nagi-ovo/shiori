// The rebuild behind every export that changes anything: copy the selected
// source pages into a fresh document, burn in or attach the overlays, carry
// the catalog structures that still apply, and check the result round-trips.
import {
  PDFDocument,
  degrees,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { observeSourceGlyphs, type SourceGlyph } from "../model/sourceGlyphs";
import type { DocumentModel, Overlay, PageModel, SourceImageEditOverlay } from "../model/types";
import { isBlankPage } from "../model/types";
import { pdfSignatureIssue } from "../signatures";
import type { PdfEditKind } from "../security/permissions";
import { rebuildForAcceptance } from "./rebuildAcceptance";
import { readSourceAnnotationAnchors } from "./sourceAnnotationAnchors";
import { prepareRebuildImages } from "./rebuildImages";
import { readStructureEdges } from "./semantic/structure";
import { hasStructure } from "./semantic/probe";
import { createRebuildSemanticGate } from "./semantic/rebuildGate";
import { rebuildWithSemanticGate, type SemanticCandidate } from "./semantic/retryEdits";
import {
  attachAnnotationsToPage,
  retainedAnnotationRefs,
  stripAllAnnotationsFromPages,
  stripReplaceableAnnotationsFromPages,
} from "./annotations";
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
import { separateCopiedAnnotations } from "./keptAnnotationLinks";
import { isolatePageReferences } from "./pageIsolation";
import { prepareStructureNavigation, recordCopiedStructureObjects, structureWasProjected } from "./structureCopy";
import { observeAnnotationRemoval } from "./structureProjection";
import { recordCopiedAnnotations } from "./catalogEntries";
import { alignPageTreeWithPdfium } from "./sourcePageTree";
import { overlaysForPdfPage, pagesMatchSource } from "./sourcePageLayout";
import { saveReachablePdf } from "./saveReachablePdf";
import { preserveSourceFontPage } from "./fonts/sourceFontContext";
import { withCachedLocalFonts } from "./fonts/fontService";
import {
  drawImageOverlaysForPage,
  drawOverlaysForPage,
  type EmbeddedImageCache,
} from "./overlayDraw";
import { applyContentTextEdits } from './contentText/apply';
import { applyLinkedFlows } from './contentText/flow/flowApply';
import type { ContentTextOutcome } from './contentText/outcomes';
import { annotationTextLostChars } from "./textDraw";
import { measureContentTextContact } from "./measureContentTextContact";

const isSourceEdit = (o: Overlay) => o.type === "contentText" || o.type === "sourceImageEdit";

export type RebuildResult = Omit<ExportResult, "acceptance"> & {
  unexcisedEdits: number;
  clippedChars: number;
  /** Nothing to write: `bytes` are the input's, returned as is. */
  unchanged: boolean;
  pageCount: number;
};

/** What a rebuild changes, in the terms of src/pdf/security/permissions.ts. */
function editsOf(change: {
  mode: ExportMode;
  overlays: Overlay[];
  pagesUnchanged: boolean;
  changedAnnotations: boolean;
  removedDocumentFiles: boolean;
}): Set<PdfEditKind> {
  const edits = new Set<PdfEditKind>();
  if (!change.pagesUnchanged) edits.add("pages");
  if (change.changedAnnotations) edits.add("annotations");
  if (change.removedDocumentFiles) edits.add("content");
  if (change.mode === "flatten" && change.overlays.length > 0) edits.add("content");
  if (change.mode === "annotations") {
    for (const overlay of change.overlays) {
      // Placed images and edits to source content write to the page streams;
      // everything else is written as an annotation.
      edits.add(
        overlay.type === "image" || isSourceEdit(overlay)
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
  const sourceGlyphs = new Map<number, readonly SourceGlyph[] | null>();
  const rebuild = async (candidateModel: DocumentModel) => {
    const result = await rebuildWithSemanticGate(candidateModel, (requested, checkTextAnchors) =>
      rebuildCandidate(originalBytes, requested, options, sourceGlyphs, checkTextAnchors, beforeRebuild));
    await measureContentTextContact(originalBytes, candidateModel, options.renderContentText, result);
    return result;
  };
  return rebuildForAcceptance(model, options, rebuild);
}

async function rebuildCandidate(
  originalBytes: Uint8Array,
  model: DocumentModel,
  options: ExportOptions,
  sourceGlyphs: Map<number, readonly SourceGlyph[] | null>,
  checkTextAnchors: boolean,
  beforeRebuild?: (edits: Set<PdfEditKind>) => void,
): Promise<SemanticCandidate> {
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
  const anchors = exportedOverlays.some(isSourceEdit) ? sourcePages.map(readSourceAnnotationAnchors) : [];
  const textAnchors = checkTextAnchors ? anchors : sourcePages.map(() => []);
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
  const structureEdges = mode !== "none" && hasStructure(source) ? readStructureEdges(source) : undefined;
  const protectedObjects = structureEdges?.objects;
  const retainedRefs = (page: PageModel, copy?: PDFPage) => {
    if (!protectedObjects?.size || isBlankPage(page)) return;
    const original = sourcePages[page.sourceIndex];
    if (original) return retainedAnnotationRefs(original, copy ?? original, page.sourceIndex, protectedObjects);
  };
  const images = prepareRebuildImages(source, model, exportedOverlays, structureEdges);
  const semanticGate = createRebuildSemanticGate(source, model, exportedOverlays, textAnchors);
  const removedAnnotationKids = mode === "none" ? observeAnnotationRemoval(source) : undefined;
  const removedPageDocumentFiles =
    documentFiles === "omit" ? stripPageDocumentFiles(source) : false;
  const removedSourceAnnotations =
    mode === "none"
      ? stripAllAnnotationsFromPages(sourcePages)
      : options.preserveSourceAnnotations
        ? false
        : stripReplaceableAnnotationsFromPages(sourcePages, protectedObjects);
  const removedUnexportedPageDocumentFiles =
    documentFiles === "preserve" && !pagesUnchanged
      ? stripUnexportedPageDocumentFiles(source, new Set(sourceIndices))
      : false;
  const sourceStructureUnchanged = !removedPageDocumentFiles &&
    !removedSourceAnnotations &&
    !removedUnexportedPageDocumentFiles &&
    pagesUnchanged &&
    !mustRemoveDocumentFiles;
  const originalResult = () => ({
    bytes: new Uint8Array(originalBytes),
    lostChars: 0,
    unexcisedEdits: 0,
    clippedChars: 0,
    unchanged: true,
    pageCount: sourcePages.length,
    ...(images && { sourceImageOutcomes: images.outcomes() }),
  });
  if (exportedOverlays.length === 0 && sourceStructureUnchanged) return originalResult();
  beforeRebuild?.(
    editsOf({
      mode,
      overlays: exportedOverlays,
      pagesUnchanged,
      changedAnnotations: removedSourceAnnotations || (mode === "flatten" && model.pages.some(page => {
        const retained = retainedRefs(page);
        return retained?.size && exportedOverlays.some(o =>
          o.pageId === page.id && o.localActivityAt !== undefined && retained.has(o.id));
      })),
      removedDocumentFiles:
        mustRemoveDocumentFiles ||
        removedPageDocumentFiles ||
        removedUnexportedPageDocumentFiles,
    }),
  );
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
  const pageNodes: Parameters<typeof reattachLinkDestinations>[1] = [];

  const fonts = await loadExportFonts(out, exportedOverlays.filter(o => !isSourceEdit(o)), mode, options);

  const contentTextOutcomes: ContentTextOutcome[] = [];
  let totalLostChars = 0;
  let clippedChars = 0;
  let unexcisedEdits = 0;
  const embeddedImages: EmbeddedImageCache = new Map();

  // Batch copyPages to share resources across pages while copying a page
  // leaf for each model entry, including repeated source pages.
  // Page references are cut first so the copier cannot follow one into a
  // page outside the selection (see pageIsolation.ts).
  const pageIsolation = isolatePageReferences(source, sourceIndices);
  const copiedPages = await out.copyPages(source, sourceIndices);
  pageIsolation.restoreSource();
  // Copies of one source page share its copied /Annots and every annotation
  // object in it (PDFPageLeaf.normalize reuses them without cloning): each
  // later copy gets its own before any attach writes to one.
  const copiedOnce = new Set<number>();
  copiedPages.forEach((copied, position) => {
    const sourceIndex = sourceIndices[position]!;
    if (copiedOnce.has(sourceIndex)) separateCopiedAnnotations(copied);
    else copiedOnce.add(sourceIndex);
  });
  recordCopiedAnnotations(out, copiedPages);
  const placePage = (page: PageModel) => {
    if (isBlankPage(page)) return out.addPage([page.widthPt, page.heightPt]);
    const copied = copiedPages[pageNodes.length];
    if (!copied) throw new Error(`Failed to copy source page ${page.sourceIndex + 1}.`);
    const inserted = out.addPage(copied);
    const sourceRef = sourcePages[page.sourceIndex]!.ref.toString();
    if (!copiedPageRefMap.has(sourceRef)) copiedPageRefMap.set(sourceRef, inserted.ref);
    pageNodes.push({ sourceIndex: page.sourceIndex, node: inserted.node });
    return inserted;
  };
  const preserveNavigation = () => {
    pageIsolation.resolve(out, copiedPageRefMap);
    reattachLinkDestinations(out, pageNodes, detachedLinks, copiedPageRefMap);
    preserveNavigationCatalogEntries(source, out, copiedPageRefMap, { pagesUnchanged, documentFiles });
  };
  const settled = recordCopiedStructureObjects(source, out, sourceIndices, copiedPages,
    mode === "none" && removedSourceAnnotations,
    () => prepareStructureNavigation(model.pages, placePage, retainedRefs, preserveNavigation), removedAnnotationKids);
  semanticGate?.recordPages(sourceIndices, copiedPages);
  // Settle linked edits before the single-frame writers.
  const linkedFlows = applyLinkedFlows(model, exportedOverlays, copiedPages, semanticGate?.checkFlow, textAnchors);
  contentTextOutcomes.push(...linkedFlows.outcomes);
  unexcisedEdits += linkedFlows.outcomes.filter(o => o.mode === 'unsupported').length;
  const pendingImages: Array<() => Promise<void>> = [];
  const writeOverlays = async (inserted: PDFPage, page: PageModel, pageOverlays: Overlay[], retained?: ReadonlyMap<string, PDFRef>) => {
    if (mode === "flatten") {
      const loss = await drawOverlaysForPage(
        inserted,
        pageOverlays.filter(overlay => !retained?.has(overlay.id)),
        fonts,
        embeddedImages,
      );
      totalLostChars += loss.lostChars;
      clippedChars += loss.clippedChars;
      const revised = pageOverlays.filter(o => retained?.has(o.id) && o.localActivityAt !== undefined);
      if (revised.length) {
        totalLostChars += annotationTextLostChars(revised, fonts);
        attachAnnotationsToPage(inserted, page, revised, annotationFonts(fonts), retained);
      }
    } else if (mode === "annotations") {
      totalLostChars += annotationTextLostChars(pageOverlays, fonts);
      await drawImageOverlaysForPage(inserted, pageOverlays, embeddedImages);
      attachAnnotationsToPage(
        inserted,
        page,
        pageOverlays,
        annotationFonts(fonts),
        retained,
      );
    }
  };
  const contentTextOptions = withCachedLocalFonts({
    ...options.inPlaceFallback,
    stage5Type1: options.stage5Type1,
    stage5Substitute: options.stage5Substitute,
    stage5Reflow: options.stage5Reflow ?? true,
    reflowRequests: options.reflowRequests,
    renderContentText: options.renderContentText,
  });

  for (const [pageIndex, page] of model.pages.entries()) {
    const placed = settled?.placed[pageIndex];
    const inserted = placed?.inserted ?? placePage(page);
    if (!isBlankPage(page)) {
      const sourcePage = sourcePages[page.sourceIndex];
      if (sourcePage) preserveSourceFontPage(inserted, sourcePage);
    }
    const retained = placed ? placed.retained : retainedRefs(page, inserted);
    inserted.setRotation(degrees(page.rotation));
    let pageOverlays = overlaysForPdfPage(page, exportedOverlays).filter(o => !linkedFlows.settled.has(o.id));
    const imageEdits = pageOverlays.filter((o): o is SourceImageEditOverlay => o.type === "sourceImageEdit");
    if (imageEdits.length) pageOverlays = pageOverlays.filter(o => o.type !== "sourceImageEdit");
    if (mode !== "none") {
      if (!isBlankPage(page) && options.readSourceGlyphs &&
          pageOverlays.some(o => o.type === 'contentText' && !o.sourceGlyphs?.length && o.sourceStyle)) {
        if (!sourceGlyphs.has(page.sourceIndex)) {
          let measured: readonly SourceGlyph[] | null = null;
          try { measured = await options.readSourceGlyphs(page.sourceIndex); }
          catch { /* A closed or unavailable reader supplies no placement proof. */ }
          sourceGlyphs.set(page.sourceIndex, measured);
        }
        const measured = sourceGlyphs.get(page.sourceIndex);
        if (measured) pageOverlays = pageOverlays.map(o => o.type === 'contentText' && !o.sourceGlyphs?.length && o.sourceStyle
          ? { ...o, sourceGlyphs: observeSourceGlyphs(measured, o.coverRects, o.sourceStyle.fontSize) }
          : o);
      }
      const refused = semanticGate?.refusals;
      const edits = await applyContentTextEdits(inserted, pageOverlays.filter(o => !refused?.has(o.id)), contentTextOptions, textAnchors[page.sourceIndex]);
      semanticGate?.recordColumnEdits(edits.outcomes);
      const moved = semanticGate?.writePermutations(inserted, pageOverlays, options.stage5Type1, options.reflowRequests) ?? [];
      const byId = new Map([...edits.outcomes, ...moved].map(outcome => [outcome.overlayId, outcome]));
      for (const overlay of pageOverlays) {
        const outcome = byId.get(overlay.id) ?? refused?.get(overlay.id);
        if (outcome) contentTextOutcomes.push({ ...outcome, pageIndex });
      }
      pageOverlays = [...edits.remaining, ...pageOverlays.filter(o => refused?.has(o.id))];
    }
    // Unsupported source edits remain unchanged. Only the content-stream
    // writers above may render original-text replacements.
    if(mode !== 'none')unexcisedEdits += pageOverlays.filter(o => o.type === 'contentText').length;
    pageOverlays = pageOverlays.filter(o => o.type !== 'contentText');
    const write = async () => {
      if (images && imageEdits.length) {
        const textChanged = contentTextOutcomes.some(outcome => outcome.pageIndex === pageIndex && outcome.mode !== "unsupported");
        unexcisedEdits += await images.write(inserted, page, pageIndex, imageEdits, textChanged, anchors[page.sourceIndex]);
      }
      await writeOverlays(inserted, page, pageOverlays, retained);
    };
    if (imageEdits.length && images?.gate?.covers(page.sourceIndex)) pendingImages.push(write);
    else await write();
  }

  if (settled) settled.finish();
  else preserveNavigation();
  // Page-owned files follow their page. The source was projected above by
  // removing only edges from pages that are no longer exported, so Catalog
  // attachments and files shared with retained pages remain in this expected
  // inventory while deleted-page-only payloads do not.
  const expectedDocumentFiles = inspectDocumentFilesForPageSelection(
    source,
    new Set(sourceIndices),
  );
  // Verify text against its source paints before independently changing images.
  const proof = semanticGate?.verify(out, contentTextOutcomes);
  for (const write of pendingImages) await write();
  assertDocumentFilesIntegrity(expectedDocumentFiles, out, documentFiles);
  assertNoStrayPages(out);
  const sourceImageOutcomes = images?.outcomes();
  const imageApplied = sourceImageOutcomes?.some(({ mode }) => mode === "applied");
  const semanticChanges = [...(proof?.rows ?? []), ...(images?.gate?.rows ?? [])];
  const onlySourceEdits = exportedOverlays.every(isSourceEdit);
  const canKeepSource = pagesUnchanged && !mustRemoveDocumentFiles && !removedPageDocumentFiles && onlySourceEdits;
  const installed = imageApplied || contentTextOutcomes.some(({ mode }) => mode !== "unsupported");
  const anchorRefused = contentTextOutcomes.some(o => o.reason === "annotation-anchor");
  const unchanged = !installed && onlySourceEdits && (
    (canKeepSource && semanticChanges.length > 0) ||
    (sourceStructureUnchanged && (!!sourceImageOutcomes?.length || anchorRefused)));
  const useObjectStreams = quality !== "original";
  const bytes = unchanged || proof?.conflicts.length ? new Uint8Array(originalBytes) : installed || structureWasProjected(out)
    ? await saveReachablePdf(out, useObjectStreams)
    : await out.save({ useObjectStreams });
  if (!proof?.conflicts.length) await assertExportIntegrity(bytes, out.getPageCount());
  return {
    bytes,
    lostChars: totalLostChars,
    contentTextOutcomes,
    ...(sourceImageOutcomes && { sourceImageOutcomes }),
    ...(semanticChanges.length && { semanticChanges }),
    ...(proof?.conflicts.length && { conflicts: proof.conflicts, canKeepSourceOnRefusal: canKeepSource }),
    anchorRefusalsNeedSemanticProof: anchorRefused && semanticGate?.checksSource,
    unexcisedEdits,
    clippedChars,
    unchanged,
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
