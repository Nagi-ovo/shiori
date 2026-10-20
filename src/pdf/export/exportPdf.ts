import {
  BlendMode,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  LineCapStyle,
  LineJoinStyle,
  TextRenderingMode,
  appendBezierCurve,
  clip,
  beginText,
  degrees,
  endText,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  rectangle,
  setCharacterSpacing,
  setCharacterSqueeze,
  setFillingColor,
  setFontAndSize,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingColor,
  setTextMatrix,
  setTextRenderingMode,
  setTextRise,
  setWordSpacing,
  showText,
  stroke,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type PDFRef,
  type RGB,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type {
  CalloutOverlay,
  ContentTextOverlay,
  DocumentModel,
  HighlightOverlay,
  ImageOverlay,
  InkOverlay,
  NoteOverlay,
  Overlay,
  PageModel,
  RectOverlay,
  StampOverlay,
  StrikeOutOverlay,
  TextOverlay,
  UnderlineOverlay,
} from "../model/types";
import { isBlankPage } from "../model/types";
import {
  CALLOUT_LABEL_PADDING_X_PT,
  CALLOUT_LABEL_PADDING_Y_PT,
  CALLOUT_TARGET_OPACITY,
  calloutConnectorGeometry,
} from "../model/callout";
import { sourceLinePitchPt } from "../model/baselines";
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
  type SourceFontRef,
} from "./contentTextRedaction";
import { createSourceFontEncoder } from "./contentStreamEdit/sourceFontEncoder";
import { hasNonAscii } from "./textScripts";
import {
  annotationFonts,
  loadExportFonts,
  pickFont,
  pickPathFont,
  sanitizeFor,
  type FontSet,
} from "./exportFonts";
import { measureTextWidth, wrapText } from "./textWrap";
import {
  drawPathText,
  pathTextLostChars,
  type PathTextFont,
} from "./vectorText";
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

const SYNTHETIC_ITALIC_DEGREES = 12;

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

type EmbeddedImageCache = Map<string, PDFImage>;

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

function annotationTextLostChars(
  overlays: readonly Overlay[],
  fonts: FontSet,
): number {
  let lostChars = 0;
  for (const overlay of overlays) {
    if (overlay.type !== "text" && overlay.type !== "callout") continue;
    const appearanceText = overlay.text.replace(/\r\n?|\n/g, "");
    const pathFont = pickPathFont(
      appearanceText,
      fonts,
      overlay.fontFamily,
    );
    if (pathFont) {
      lostChars += pathTextLostChars(pathFont, appearanceText);
      continue;
    }
    const font = pickFont(
      appearanceText,
      overlay.bold,
      Boolean(overlay.italic),
      fonts,
      overlay.fontFamily,
    );
    lostChars += sanitizeFor(font, appearanceText).lostChars;
  }
  return lostChars;
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

async function drawOverlaysForPage(
  out: PDFPage,
  pageOverlays: Overlay[],
  fonts: FontSet,
  embeddedImages: EmbeddedImageCache,
  contentTextRedaction?: ContentTextRedaction,
): Promise<number> {
  let lostChars = 0;
  for (const o of pageOverlays) {
    if (o.type === "contentText") {
      lostChars += drawContentText(
        out,
        o,
        fonts,
        contentTextRedaction?.get(o.id),
      );
    }
  }
  for (const o of pageOverlays) {
    if (o.type === "contentText") continue;
    if (o.type === "highlight") drawHighlight(out, o);
    else if (o.type === "underline") drawUnderline(out, o);
    else if (o.type === "strikethrough") drawStrikeOut(out, o);
    else if (o.type === "rect") drawRect(out, o);
    else if (o.type === "stamp") drawStamp(out, o);
    else if (o.type === "image") await drawImageOverlay(out, o, embeddedImages);
    else if (o.type === "ink") drawInk(out, o);
    else if (o.type === "note") lostChars += drawNote(out, o, fonts);
    else if (o.type === "text") lostChars += drawText(out, o, fonts);
    else if (o.type === "callout") lostChars += drawCallout(out, o, fonts);
  }
  return lostChars;
}

async function drawImageOverlaysForPage(
  out: PDFPage,
  pageOverlays: Overlay[],
  embeddedImages: EmbeddedImageCache,
): Promise<void> {
  for (const overlay of pageOverlays) {
    if (overlay.type === "image") {
      await drawImageOverlay(out, overlay, embeddedImages);
    }
  }
}

function drawContentTextEditsForPage(
  out: PDFPage,
  pageOverlays: Overlay[],
  fonts: FontSet,
  contentTextRedaction?: ContentTextRedaction,
): number {
  let lostChars = 0;
  for (const overlay of pageOverlays) {
    if (overlay.type !== "contentText") continue;
    lostChars += drawContentText(
      out,
      overlay,
      fonts,
      contentTextRedaction?.get(overlay.id),
    );
  }
  return lostChars;
}

function drawHighlight(out: PDFPage, o: HighlightOverlay) {
  const color = hexToRgb(o.color);
  for (const r of o.rects) {
    out.drawRectangle({
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
      color,
      opacity: o.opacity,
      blendMode: BlendMode.Multiply,
      borderWidth: 0,
    });
  }
}

function drawCallout(
  out: PDFPage,
  o: CalloutOverlay,
  fonts: FontSet,
): number {
  const color = hexToRgb(o.color);
  for (const target of o.targetRects) {
    out.drawRectangle({
      x: target.x,
      y: target.y,
      width: target.w,
      height: target.h,
      color,
      opacity: CALLOUT_TARGET_OPACITY,
      blendMode: BlendMode.Multiply,
      borderWidth: 0,
    });
  }

  const connector = calloutConnectorGeometry(o);
  const c1 = {
    x: connector.from.x + (connector.control.x - connector.from.x) * (2 / 3),
    y: connector.from.y + (connector.control.y - connector.from.y) * (2 / 3),
  };
  const c2 = {
    x: connector.to.x + (connector.control.x - connector.to.x) * (2 / 3),
    y: connector.to.y + (connector.control.y - connector.to.y) * (2 / 3),
  };
  const leaderOperators =
    connector.kind === "polyline"
      ? [
          lineTo(connector.control.x, connector.control.y),
          lineTo(connector.to.x, connector.to.y),
        ]
      : [
          appendBezierCurve(
            c1.x,
            c1.y,
            c2.x,
            c2.y,
            connector.to.x,
            connector.to.y,
          ),
        ];
  out.pushOperators(
    pushGraphicsState(),
    setStrokingColor(color),
    setLineWidth(1.25),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
    moveTo(connector.from.x, connector.from.y),
    ...leaderOperators,
    moveTo(connector.to.x, connector.to.y),
    lineTo(connector.arrowLeft.x, connector.arrowLeft.y),
    moveTo(connector.to.x, connector.to.y),
    lineTo(connector.arrowRight.x, connector.arrowRight.y),
    stroke(),
    popGraphicsState(),
  );
  out.drawRectangle({
    x: o.rect.x,
    y: o.rect.y,
    width: o.rect.w,
    height: o.rect.h,
    color: rgb(1, 0.992, 0.973),
    borderColor: color,
    borderWidth: 0.8,
  });
  out.pushOperators(
    pushGraphicsState(),
    rectangle(o.rect.x, o.rect.y, o.rect.w, o.rect.h),
    clip(),
    endPath(),
  );
  const lostChars = drawText(out, o, fonts);
  out.pushOperators(popGraphicsState());
  return lostChars;
}

function drawUnderline(out: PDFPage, o: UnderlineOverlay) {
  drawTextLineMarkup(out, o, underlinePdfY);
}

function drawStrikeOut(out: PDFPage, o: StrikeOutOverlay) {
  drawTextLineMarkup(out, o, strikethroughPdfY);
}

function drawTextLineMarkup(
  out: PDFPage,
  o: UnderlineOverlay | StrikeOutOverlay,
  lineY: (rect: { y: number; h: number }) => number,
) {
  const color = hexToRgb(o.color);
  const thickness = underlineStrokeWidth(o.rects);
  for (const r of o.rects) {
    const y = lineY(r);
    out.drawLine({
      start: { x: r.x, y },
      end: { x: r.x + r.w, y },
      thickness,
      color,
      opacity: o.opacity,
      lineCap: LineCapStyle.Round,
    });
  }
}

function underlineStrokeWidth(rects: Array<{ h: number }>): number {
  const minHeight = Math.min(...rects.map((r) => r.h).filter((h) => h > 0));
  if (!Number.isFinite(minHeight)) return 1;
  return Math.max(0.75, Math.min(2, minHeight * 0.08));
}

function underlinePdfY(rect: { y: number; h: number }): number {
  return rect.y + Math.max(0.75, Math.min(2, rect.h * 0.12));
}

function strikethroughPdfY(rect: { y: number; h: number }): number {
  return rect.y + rect.h * 0.45;
}

function drawRect(out: PDFPage, o: RectOverlay) {
  out.drawRectangle({
    x: o.rect.x,
    y: o.rect.y,
    width: o.rect.w,
    height: o.rect.h,
    borderColor: hexToRgb(o.color),
    borderWidth: o.strokeWidth,
    color: o.fill ? hexToRgb(o.fill) : undefined,
    opacity: o.fill ? 1 : 0,
  });
}

function drawStamp(out: PDFPage, o: StampOverlay) {
  const paths = stampPdfPaths(o);
  if (paths.length === 0) return;
  out.pushOperators(
    pushGraphicsState(),
    setStrokingColor(hexToRgb(o.color)),
    setLineWidth(o.strokeWidth),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
  );
  for (const path of paths) {
    const [first, ...rest] = path;
    if (!first) continue;
    out.pushOperators(moveTo(first.x, first.y));
    for (const point of rest) {
      out.pushOperators(lineTo(point.x, point.y));
    }
  }
  out.pushOperators(stroke(), popGraphicsState());
}

function drawInk(out: PDFPage, o: InkOverlay) {
  const color = hexToRgb(o.color);
  out.pushOperators(
    pushGraphicsState(),
    setStrokingColor(color),
    setLineWidth(o.width),
    setLineCap(LineCapStyle.Round),
    setLineJoin(LineJoinStyle.Round),
  );
  for (const path of o.paths) {
    const [first, ...rest] = path;
    if (!first) continue;
    out.pushOperators(moveTo(first.x, first.y));
    if (rest.length === 0) {
      out.pushOperators(lineTo(first.x, first.y));
      continue;
    }
    for (const point of rest) {
      out.pushOperators(lineTo(point.x, point.y));
    }
  }
  out.pushOperators(stroke(), popGraphicsState());
}

async function drawImageOverlay(
  out: PDFPage,
  o: ImageOverlay,
  embeddedImages: EmbeddedImageCache,
) {
  const bytes = imageDataUrlBytes(o.dataUrl);
  if (!bytes) return;
  const cacheKey = `${o.mimeType}\0${o.dataUrl}`;
  let image = embeddedImages.get(cacheKey);
  if (!image) {
    image =
      o.mimeType === "image/jpeg"
        ? await out.doc.embedJpg(bytes)
        : await out.doc.embedPng(bytes);
    embeddedImages.set(cacheKey, image);
  }
  out.drawImage(image, {
    x: o.rect.x,
    y: o.rect.y,
    width: o.rect.w,
    height: o.rect.h,
  });
}

function drawNote(out: PDFPage, o: NoteOverlay, fonts: FontSet): number {
  const color = hexToRgb(o.color);
  out.drawRectangle({
    x: o.rect.x,
    y: o.rect.y,
    width: o.rect.w,
    height: o.rect.h,
    color,
    opacity: 0.6,
    borderColor: rgb(0.1, 0.1, 0.1),
    borderWidth: 0.5,
  });
  if (o.text) {
    const size = 10;
    return drawText(
      out,
      {
        type: "text",
        id: o.id,
        pageId: o.pageId,
        rect: {
          x: o.rect.x + 4,
          y: o.rect.y + 4,
          w: Math.max(1, o.rect.w - 8),
          h: Math.max(1, o.rect.h - 8),
        },
        text: o.text,
        fontSize: size,
        color: "#1a1815",
        bold: false,
        align: "left",
        fontFamily: "sans",
      },
      fonts,
    );
  }
  return 0;
}

function drawContentText(
  out: PDFPage,
  o: ContentTextOverlay,
  fonts: FontSet,
  redaction?: { cleanRects: boolean[]; sourceFont: SourceFontRef | null },
): number {
  const cleanRects = redaction?.cleanRects;
  for (let index = 0; index < o.coverRects.length; index += 1) {
    if (cleanRects?.[index]) continue;
    const rect = o.coverRects[index]!;
    out.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      color: hexToRgb(o.backgroundColor),
      borderWidth: 0,
    });
  }
  // Same-font replacement: when the removed glyphs all came from one source
  // font whose subset can encode the whole replacement, reuse it — the edit
  // becomes visually indistinguishable from untouched text. Any doubt falls
  // through to the bundled-font path below.
  if (
    redaction?.sourceFont &&
    drawContentTextWithSourceFont(out, o, redaction.sourceFont)
  ) {
    return 0;
  }
  return drawText(out, o, fonts);
}

// Draw a contentText replacement with the source PDF's own font, via raw
// text operators against the font's existing resource name. Returns false —
// having drawn nothing — whenever the source font cannot express the text
// exactly: no usable /ToUnicode, a character outside the (possibly subset)
// font, styling the source run didn't have (bold/italic toggles), a line
// too wide for the edit rect (the bundled path wraps instead), or a legacy
// overlay without captured baselines.
function drawContentTextWithSourceFont(
  out: PDFPage,
  o: ContentTextOverlay,
  sourceFont: SourceFontRef,
): boolean {
  if (!o.text) return false;
  if (o.bold || o.italic) return false;
  const baselines = o.sourceBaselinesPt;
  if (!baselines || baselines.length === 0) return false;

  const encoder = createSourceFontEncoder(sourceFont.dict);
  if (!encoder) return false;

  const lines = o.text.split("\n");
  const encoded: Array<{ bytes: Uint8Array; widthPt: number }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const result = encoder.encodeLine(lines[i]!);
    if (!result) return false;
    const widthPt = result.widthEm * o.fontSize;
    // Wider than the available room means the bundled path would wrap the
    // line; this path draws single runs only, so let it handle the
    // overflow. Line 0 loses the mid-line-start indent.
    const room = o.rect.w - (i === 0 ? (o.firstLineIndentPt ?? 0) : 0);
    if (widthPt > room + 1) return false;
    encoded.push({ bytes: result.bytes, widthPt });
  }

  const color = hexToRgb(o.color);
  const lineHeight = o.fontSize;
  const operators = [
    pushGraphicsState(),
    beginText(),
    // The appended content stream inherits defaults (pdf-lib wraps the
    // original page content in q/Q), but earlier overlay draws share this
    // stream — pin every text-state parameter the run depends on.
    setCharacterSpacing(0),
    setWordSpacing(0),
    setCharacterSqueeze(100),
    setTextRise(0),
    setTextRenderingMode(TextRenderingMode.Fill),
    setFillingColor(color),
    setFontAndSize(sourceFont.name, o.fontSize),
  ];
  for (let i = 0; i < lines.length; i += 1) {
    const line = encoded[i]!;
    if (line.bytes.length === 0) continue;
    let x = o.rect.x;
    if (o.align === "center") x = o.rect.x + (o.rect.w - line.widthPt) / 2;
    else if (o.align === "right") x = o.rect.x + (o.rect.w - line.widthPt);
    // Mid-line selection start (matches the on-screen CSS text-indent).
    if (i === 0 && o.align === "left") x += o.firstLineIndentPt ?? 0;
    const y = contentTextSourceBaselineY(baselines, i, lineHeight);
    if (y < o.rect.y - lineHeight) break;
    operators.push(
      setTextMatrix(1, 0, 0, 1, x, y),
      showText(PDFHexString.of(bytesToHex(line.bytes))),
    );
  }
  operators.push(endText(), popGraphicsState());
  out.pushOperators(...operators);
  return true;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex.toUpperCase();
}

// Baseline for line i: the captured source baseline when the line existed in
// the source, continuing downward at the measured source pitch (lineHeight
// as fallback) when the edit has more lines. Mirrors contentTextBaselineY's
// preferred branch.
function contentTextSourceBaselineY(
  baselines: readonly number[],
  lineIndex: number,
  lineHeight: number,
): number {
  const exact = baselines[lineIndex];
  if (typeof exact === "number" && Number.isFinite(exact)) return exact;
  const pitch = sourceLinePitchPt(baselines) ?? lineHeight;
  const last = baselines[baselines.length - 1]!;
  return last - (lineIndex - (baselines.length - 1)) * pitch;
}

function drawText(
  out: PDFPage,
  o: TextOverlay | ContentTextOverlay | CalloutOverlay,
  fonts: FontSet,
): number {
  if (!o.text) return 0;
  const font = pickFont(o.text, o.bold, Boolean(o.italic), fonts, o.fontFamily);
  const pathFont = pickPathFont(o.text, fonts, o.fontFamily);
  const color = hexToRgb(o.color);
  const isContentEdit = o.type === "contentText";
  const textRect = o.type === "callout"
    ? {
        x: o.rect.x + CALLOUT_LABEL_PADDING_X_PT,
        y: o.rect.y + CALLOUT_LABEL_PADDING_Y_PT,
        w: Math.max(1, o.rect.w - CALLOUT_LABEL_PADDING_X_PT * 2),
        h: Math.max(1, o.rect.h - CALLOUT_LABEL_PADDING_Y_PT * 2),
      }
    : o.rect;
  const lineHeight = o.fontSize * (isContentEdit ? 1 : 1.2);
  // Wrapping, measuring and drawing must use ONE font. shouldDrawTextLineAsPath
  // switches to the path font for a Noto family regardless of the line's script,
  // so measurement has to do the same or ASCII lines are laid out on Helvetica
  // advances and drawn with Noto outlines. See measureTextWidth.
  const drawsWithPathFont =
    o.fontFamily === "notoSansSc" || o.fontFamily === "notoSansJp";
  const lines = wrapText(
    o.text,
    font,
    o.fontSize,
    textRect.w,
    pathFont,
    drawsWithPathFont,
  );
  let lostChars = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const textWidth = measureTextWidth(
      font,
      line,
      o.fontSize,
      pathFont,
      drawsWithPathFont,
    );
    let x = textRect.x;
    if (o.align === "center") x = textRect.x + (textRect.w - textWidth) / 2;
    else if (o.align === "right") x = textRect.x + (textRect.w - textWidth);
    // Mid-line selection start: the first covered line begins right of the
    // box edge (matches the on-screen CSS text-indent).
    if (i === 0 && o.type === "contentText" && o.align === "left") {
      x += o.firstLineIndentPt ?? 0;
    }
    const y = isContentEdit
      ? contentTextBaselineY(o, font, i, lineHeight)
      : textRect.y + textRect.h - (i + 1) * lineHeight +
        (lineHeight - o.fontSize) / 2;
    if (y < textRect.y - lineHeight) break;
    if (shouldDrawTextLineAsPath(o, line, pathFont)) {
      lostChars += pathTextLostChars(pathFont, line);
      out.pushOperators(
        ...drawPathText(
          pathFont,
          line,
          x,
          y,
          o.fontSize,
          [color.red, color.green, color.blue],
          usesSyntheticItalic(o, line),
        ),
      );
      continue;
    }
    const sanitized = sanitizeFor(font, line);
    lostChars += sanitized.lostChars;
    out.drawText(sanitized.text, {
      x,
      y,
      size: o.fontSize,
      font,
      color,
      ySkew: usesSyntheticItalic(o, line)
        ? degrees(SYNTHETIC_ITALIC_DEGREES)
        : undefined,
    });
  }
  return lostChars;
}

function shouldDrawTextLineAsPath(
  o: TextOverlay | ContentTextOverlay | CalloutOverlay,
  line: string,
  pathFont: PathTextFont | null,
): pathFont is PathTextFont {
  return Boolean(
    pathFont &&
      (hasNonAscii(line) ||
        o.fontFamily === "notoSansSc" ||
        o.fontFamily === "notoSansJp"),
  );
}

function contentTextBaselineY(
  o: ContentTextOverlay,
  font: PDFFont,
  lineIndex: number,
  lineHeight: number,
): number {
  // Preferred: the source line's own baseline, captured from the text at edit
  // time. drawText/drawPathText y IS the baseline, so the replacement font's
  // ascent no longer influences placement. Lines beyond the covered source
  // lines (edited text wrapped longer) continue downward at the measured
  // source pitch (falling back to lineHeight for single-baseline overlays).
  const baselines = o.sourceBaselinesPt;
  if (baselines && baselines.length > 0) {
    const exact = baselines[lineIndex];
    if (typeof exact === "number" && Number.isFinite(exact)) return exact;
    const pitch = sourceLinePitchPt(baselines) ?? lineHeight;
    const last = baselines[baselines.length - 1]!;
    return last - (lineIndex - (baselines.length - 1)) * pitch;
  }
  // Legacy overlays (pre-baseline capture): derive from the edit rect. The
  // 0.8 mirrors the cover-rect pad the edit rect was built with.
  const coverPadPt = 0.8;
  const sourceTop = o.rect.y + o.rect.h - coverPadPt;
  return sourceTop - font.heightAtSize(o.fontSize, { descender: false }) -
    lineIndex * lineHeight;
}

function usesSyntheticItalic(
  o: TextOverlay | ContentTextOverlay | CalloutOverlay,
  line: string,
): boolean {
  return (
    Boolean(o.italic) &&
    (o.fontFamily === "notoSansSc" ||
      o.fontFamily === "notoSansJp" ||
      hasNonAscii(line))
  );
}

function stampPdfPaths(o: StampOverlay): PdfPath[] {
  const { rect } = o;
  const pt = (rx: number, ry: number) => ({
    x: rect.x + rect.w * rx,
    y: rect.y + rect.h * ry,
  });
  if (o.kind === "cross") {
    return [
      [pt(0.18, 0.18), pt(0.82, 0.82)],
      [pt(0.82, 0.18), pt(0.18, 0.82)],
    ];
  }
  return [[pt(0.15, 0.52), pt(0.42, 0.28), pt(0.85, 0.76)]];
}

type PdfPath = Array<{ x: number; y: number }>;

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h.split("").map((c) => c + c).join("")
      : h.length === 6
        ? h
        : "000000";
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}

function imageDataUrlBytes(dataUrl: string): Uint8Array | null {
  const match = /^data:image\/(?:png|jpe?g);base64,([a-z0-9+/=\s]+)$/i.exec(
    dataUrl,
  );
  if (!match) return null;
  const binary = globalThis.atob(match[1]!.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
