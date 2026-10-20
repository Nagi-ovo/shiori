import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
  PDFStream,
} from "pdf-lib";
import {
  asArray,
  copyCatalogEntry,
  createCloneState,
  cloneObject,
  isName,
  lookupDict,
  resolveObject,
  seedObjectMapping,
  type CloneState,
} from "./pdfObjectClone";

export type PreserveCatalogOptions = {
  // True when the export keeps every source page, once, in source order.
  // Structures that address pages positionally (/PageLabels) or that mirror
  // the page tree (/StructTreeRoot) are only meaningful then; carrying them
  // across a reordered or partial export would mislabel pages and leave the
  // structure tree pointing at pages that are no longer there.
  pagesUnchanged: boolean;
  // Document-level attachments are independent of page geometry. Full
  // document exports preserve them; page/range exports omit them so sharing a
  // few pages cannot disclose a hidden spreadsheet or source-data payload.
  documentFiles: "preserve" | "omit";
};

const numericDestinationPageMaps = new WeakMap<
  PDFDocument,
  ReadonlyMap<number, number>
>();

export function preserveNavigationCatalogEntries(
  source: PDFDocument,
  dest: PDFDocument,
  pageRefMap: Map<string, PDFRef>,
  options: PreserveCatalogOptions,
) {
  const state = createCloneState(source, pageRefMap);
  seedCopiedDocumentFileMappings(source, dest, state);

  copyCatalogEntry(source, dest, state, "Outlines");
  copyCatalogEntry(source, dest, state, "Dests");
  copyNamesEntry(source, dest, state, "Dests");
  copyPageMode(source, dest, state, options.documentFiles);
  if (options.documentFiles === "preserve") {
    copyDocumentFileEntries(source, dest, state);
  }
  // Export rebuilds the catalog from scratch (PDFDocument.create), so anything
  // not copied here is silently dropped from the user's file. These are the
  // entries whose loss is user-visible: /Lang and the structure tree carry
  // accessibility, /OpenAction the initial view, /Metadata the XMP twin of the
  // Info dict, /PageLabels the front-matter numbering (i, ii, iii...).
  copyCatalogEntry(source, dest, state, "Lang");
  copyCatalogEntry(source, dest, state, "OpenAction");
  copyCatalogEntry(source, dest, state, "Metadata");
  if (options.pagesUnchanged) {
    copyCatalogEntry(source, dest, state, "PageLabels");
    // /MarkInfo without /StructTreeRoot advertises a tagged PDF that has no
    // tags, which is worse for assistive tech than an untagged file, so the
    // two move together.
    if (copyCatalogEntry(source, dest, state, "StructTreeRoot")) {
      copyCatalogEntry(source, dest, state, "MarkInfo");
    }
  }
  preserveAcroForm(source, dest, state);
  const destinationIndexByRef = new Map(
    dest.getPages().map((page, index) => [page.ref.toString(), index]),
  );
  const numericPageMap = new Map<number, number>();
  source.getPages().forEach((page, sourceIndex) => {
    const copiedRef = pageRefMap.get(page.ref.toString());
    const destinationIndex = copiedRef
      ? destinationIndexByRef.get(copiedRef.toString())
      : undefined;
    if (destinationIndex !== undefined) {
      numericPageMap.set(sourceIndex, destinationIndex);
    }
  });
  sanitizeNavigationCatalog(dest, numericPageMap);
}

/**
 * Copy only document-level file containers into an already-built PDF.
 *
 * Compact export creates raster pages outside exportPdf(), so it cannot reuse
 * the full catalog-preservation pass. This helper deliberately allowlists
 * EmbeddedFiles, AF, and Collection; cloning the whole /Names dictionary would
 * also copy active JavaScript and other unaudited name trees.
 *
 * Returns false when the source has no document-file structures, allowing the
 * caller to keep its original serialized bytes without an unnecessary rewrite.
 */
export function copyDocumentFiles(
  source: PDFDocument,
  dest: PDFDocument,
): boolean {
  const state = createCloneState(source, new Map());
  const copied = copyDocumentFileEntries(source, dest, state);
  if (copied) copyUseAttachmentsPageMode(source, dest, state);
  return copied;
}

export function hasDocumentFiles(source: PDFDocument): boolean {
  return inspectDocumentFiles(source).hasDocumentFiles;
}

/**
 * Raw payload inventory for every embedded-file stream in the PDF context.
 *
 * Embedded files can be reached from more than the familiar Catalog name
 * tree: PDF 2.0 also permits /AF on pages, structure elements, image XObjects,
 * and other objects, while Launch/GoToE actions can point at a FileSpec
 * directly. Looking for the stream type itself gives export's fail-closed
 * integrity guard a topology-independent view of the payloads at risk.
 */
export type DocumentFileInventory = {
  hasDocumentFiles: boolean;
  payloads: Uint8Array[];
  fileSpecs: DocumentFileSpecInventory[];
};

type DocumentFileSpecInventory = {
  signature: string;
  streams: Array<{
    key: string;
    signature: string;
    payload: Uint8Array;
  }>;
};

export function inspectDocumentFiles(
  source: PDFDocument,
): DocumentFileInventory {
  return inspectDocumentFilesFromObjects(source, reachableObjects(source));
}

/**
 * Inventory the document-file graph after a logical page selection without
 * treating removed pages as live roots.
 *
 * Walking the Catalog directly would descend through /Pages and count files
 * owned only by a deleted page. Instead, walk every non-/Pages Catalog entry,
 * the Info dictionary, and only the retained page leaves. References back to
 * an unexported page (for example from an outline destination) are ignored,
 * matching the export navigation sanitizer without hiding independent
 * Catalog/Info attachment topologies that still need fail-closed handling.
 */
export function inspectDocumentFilesForPageSelection(
  source: PDFDocument,
  retainedSourceIndices: ReadonlySet<number>,
): DocumentFileInventory {
  const pages = source.getPages();
  const skippedPageRefs = new Set(
    pages
      .filter((_, index) => !retainedSourceIndices.has(index))
      .map((page) => page.ref.toString()),
  );
  const roots: PDFObject[] = [];
  for (const [key, value] of source.catalog.entries()) {
    if (key.asString() !== "/Pages") roots.push(value);
  }
  pages.forEach((page, index) => {
    if (retainedSourceIndices.has(index)) roots.push(page.node);
  });
  const info = source.context.trailerInfo.Info;
  if (info) roots.push(info);
  return inspectDocumentFilesFromObjects(
    source,
    walkObjectGraph(source, roots, skippedPageRefs),
  );
}

function inspectDocumentFilesFromObjects(
  source: PDFDocument,
  objects: Iterable<PDFObject>,
): DocumentFileInventory {
  const payloadStreams = new Set<PDFStream>();
  const fileSpecs: DocumentFileSpecInventory[] = [];
  const names = lookupDict(source, source.catalog.get(PDFName.of("Names")));
  let hasStructures = Boolean(
    source.catalog.get(PDFName.of("AF")) ||
      source.catalog.get(PDFName.of("Collection")) ||
      names?.get(PDFName.of("EmbeddedFiles")),
  );
  for (const object of objects) {
    if (
      object instanceof PDFStream &&
      isName(source, object.dict.get(PDFName.of("Type")), "EmbeddedFile")
    ) {
      payloadStreams.add(object);
      hasStructures = true;
    }
    if (!(object instanceof PDFDict)) continue;
    if (
      object.get(PDFName.of("AF")) ||
      isName(source, object.get(SUBTYPE_KEY), "FileAttachment")
    ) {
      hasStructures = true;
    }
    const fileSpec = inspectEmbeddedFileSpec(source, object);
    if (fileSpec) {
      fileSpecs.push(fileSpec.inventory);
      for (const stream of fileSpec.streamObjects) payloadStreams.add(stream);
      hasStructures = true;
    }
  }
  return {
    hasDocumentFiles: hasStructures,
    payloads: [...payloadStreams].map((stream) => stream.getContents()),
    fileSpecs,
  };
}

export function embeddedFilePayloads(source: PDFDocument): Uint8Array[] {
  return inspectDocumentFiles(source).payloads;
}

/** Physical xref scan used only by the omit privacy boundary. */
export function hasPhysicalDocumentFiles(source: PDFDocument): boolean {
  const roots = source.context
    .enumerateIndirectObjects()
    .map(([, object]) => object);
  for (const object of walkObjectGraph(source, roots)) {
    if (
      object instanceof PDFStream &&
      isName(source, object.dict.get(PDFName.of("Type")), "EmbeddedFile")
    ) {
      return true;
    }
    if (
      object instanceof PDFDict &&
      (object.get(PDFName.of("AF")) ||
        isName(source, object.get(SUBTYPE_KEY), "FileAttachment") ||
        object.get(PDFName.of("EF")))
    ) {
      return true;
    }
  }
  return false;
}

export function documentFileInventoryMatches(
  expected: DocumentFileInventory,
  actualDocument: PDFDocument,
): boolean {
  const actual = inspectDocumentFiles(actualDocument);
  const unmatched = [...actual.payloads];
  if (unmatched.length !== expected.payloads.length) return false;
  for (const payload of expected.payloads) {
    const match = unmatched.findIndex((candidate) => bytesEqual(payload, candidate));
    if (match < 0) return false;
    unmatched.splice(match, 1);
  }
  const unmatchedSpecs = [...actual.fileSpecs];
  if (unmatchedSpecs.length !== expected.fileSpecs.length) return false;
  for (const fileSpec of expected.fileSpecs) {
    const match = unmatchedSpecs.findIndex((candidate) =>
      fileSpecInventoryEqual(fileSpec, candidate),
    );
    if (match < 0) return false;
    unmatchedSpecs.splice(match, 1);
  }
  return unmatchedSpecs.length === 0;
}

export function stripPageDocumentFiles(source: PDFDocument): boolean {
  let removedAny = false;
  const afKey = PDFName.of("AF");
  const parentKey = PDFName.of("Parent");
  const inReplyToKey = PDFName.of("IRT");
  const pageAnnotations: Array<{ page: PDFDict; annots: PDFArray }> = [];
  const removedRefs = new Set<string>();

  // /AF is legal on more than Catalog and Page. Remove it from every object
  // reachable in the parsed context before copyPages/catalog cloning so a
  // StructElem or image XObject cannot smuggle its payload into a range
  // export. Unknown attachment routes (for example Launch /F) are not guessed
  // at here; the post-build payload inventory rejects those exports instead.
  removedAny = stripAssociatedFileKeys(source, afKey) || removedAny;

  const names = lookupDict(source, source.catalog.get(PDFName.of("Names")));
  if (names?.get(PDFName.of("EmbeddedFiles"))) {
    names.delete(PDFName.of("EmbeddedFiles"));
    removedAny = true;
  }
  if (source.catalog.get(PDFName.of("Collection"))) {
    source.catalog.delete(PDFName.of("Collection"));
    removedAny = true;
  }

  // First remove every page-level attachment root and remember its object
  // identity. Replies and popups are allowed to live on a different page, so
  // collecting per page would let their cross-page reference pull the removed
  // FileSpec and EmbeddedFile stream back into a partial export.
  for (const page of source.getPages()) {
    if (page.node.get(afKey)) {
      page.node.delete(afKey);
      removedAny = true;
    }
    const annots = asArray(source, page.node.get(ANNOTS_KEY));
    if (!annots) continue;
    pageAnnotations.push({ page: page.node, annots });

    for (let i = annots.size() - 1; i >= 0; i -= 1) {
      const raw = annots.get(i);
      const annot = lookupDict(source, raw);
      if (!isName(source, annot?.get(SUBTYPE_KEY), "FileAttachment")) continue;
      if (raw instanceof PDFRef) removedRefs.add(raw.toString());
      annots.remove(i);
      removedAny = true;
    }
  }

  // A FileAttachment is a markup annotation and may own a Popup or reply
  // chain. Remove dependants transitively across the whole document so
  // omission never leaves a dangling /Parent or /IRT ref—or a path back to
  // the attachment payload—on a page that is still exported.
  let removedDependent = true;
  while (removedDependent && removedRefs.size > 0) {
    removedDependent = false;
    for (const { annots } of pageAnnotations) {
      for (let i = annots.size() - 1; i >= 0; i -= 1) {
        const raw = annots.get(i);
        const annot = lookupDict(source, raw);
        if (!annot) continue;
        const parent = annot.get(parentKey);
        const inReplyTo = annot.get(inReplyToKey);
        const dependsOnRemoved = [parent, inReplyTo].some(
          (value) =>
            value instanceof PDFRef && removedRefs.has(value.toString()),
        );
        if (!dependsOnRemoved) continue;
        if (raw instanceof PDFRef) removedRefs.add(raw.toString());
        annots.remove(i);
        removedAny = true;
        removedDependent = true;
      }
    }
  }

  for (const { page, annots } of pageAnnotations) {
    if (annots.size() === 0) page.delete(ANNOTS_KEY);
  }
  return removedAny;
}

/**
 * Remove page-owned document-file edges from source pages that are not part
 * of this export while leaving document-level Catalog roots untouched.
 *
 * A FileAttachment annotation (or page /AF entry) follows the page that owns
 * it. The underlying FileSpec may also be reachable from the Catalog or a
 * retained page, so deleting the object globally would corrupt a valid
 * document-level attachment. We therefore remove only the page edge, then
 * prune Popup/IRT dependants whose attachment annotation no longer exists on
 * any retained page.
 */
export function stripUnexportedPageDocumentFiles(
  source: PDFDocument,
  retainedSourceIndices: ReadonlySet<number>,
): boolean {
  const pages = source.getPages();
  const parentKey = PDFName.of("Parent");
  const inReplyToKey = PDFName.of("IRT");
  const retainedAttachmentRefs = new Set<string>();
  const removedAttachmentRefs = new Set<string>();
  const pageAnnotations: Array<{
    retained: boolean;
    page: PDFDict;
    annots: PDFArray;
  }> = [];
  let removedAny = false;

  // First discover shared annotation refs before mutating any page. A single
  // indirect annotation can legally appear in more than one page's /Annots;
  // if a retained page still owns it, replies to it remain valid.
  pages.forEach((page, sourceIndex) => {
    const retained = retainedSourceIndices.has(sourceIndex);
    if (!retained && page.node.get(PDFName.of("AF"))) {
      page.node.delete(PDFName.of("AF"));
      removedAny = true;
    }
    const annots = asArray(source, page.node.get(ANNOTS_KEY));
    if (!annots) return;
    pageAnnotations.push({ retained, page: page.node, annots });
    for (let index = 0; index < annots.size(); index += 1) {
      const raw = annots.get(index);
      const annot = lookupDict(source, raw);
      if (!isName(source, annot?.get(SUBTYPE_KEY), "FileAttachment")) {
        continue;
      }
      if (!(raw instanceof PDFRef)) continue;
      const tag = raw.toString();
      if (retained) retainedAttachmentRefs.add(tag);
      else removedAttachmentRefs.add(tag);
    }
  });
  for (const tag of retainedAttachmentRefs) removedAttachmentRefs.delete(tag);

  for (const { retained, page, annots } of pageAnnotations) {
    if (retained) continue;
    for (let index = annots.size() - 1; index >= 0; index -= 1) {
      const annot = lookupDict(source, annots.get(index));
      if (!isName(source, annot?.get(SUBTYPE_KEY), "FileAttachment")) {
        continue;
      }
      annots.remove(index);
      removedAny = true;
    }
    if (annots.size() === 0) page.delete(ANNOTS_KEY);
  }

  // Replies and popups can live on another page. Removing them transitively
  // prevents a retained page from pulling a deleted annotation—and therefore
  // its FileSpec and payload—back into the output object graph.
  let removedDependent = true;
  while (removedDependent && removedAttachmentRefs.size > 0) {
    removedDependent = false;
    for (const { page, annots } of pageAnnotations) {
      for (let index = annots.size() - 1; index >= 0; index -= 1) {
        const raw = annots.get(index);
        const annot = lookupDict(source, raw);
        if (!annot) continue;
        const dependsOnRemoved = [
          annot.get(parentKey),
          annot.get(inReplyToKey),
        ].some(
          (value) =>
            value instanceof PDFRef &&
            removedAttachmentRefs.has(value.toString()),
        );
        if (!dependsOnRemoved) continue;
        if (raw instanceof PDFRef) {
          removedAttachmentRefs.add(raw.toString());
        }
        annots.remove(index);
        removedAny = true;
        removedDependent = true;
      }
      if (annots.size() === 0) page.delete(ANNOTS_KEY);
    }
  }

  return removedAny;
}

function stripAssociatedFileKeys(source: PDFDocument, afKey: PDFName): boolean {
  let removed = false;
  for (const object of reachableObjects(source)) {
    if (object instanceof PDFDict) {
      if (object.get(afKey)) {
        object.delete(afKey);
        removed = true;
      }
    }
  }
  return removed;
}

function* reachableObjects(source: PDFDocument): Generator<PDFObject> {
  const roots: PDFObject[] = [source.catalog];
  const info = source.context.trailerInfo.Info;
  if (info) roots.push(info);
  yield* walkObjectGraph(source, roots);
}

function* walkObjectGraph(
  source: PDFDocument,
  roots: readonly PDFObject[],
  skippedRefs: ReadonlySet<string> = new Set(),
): Generator<PDFObject> {
  const pending = [...roots];
  const seenObjects = new Set<PDFObject>();
  const seenRefs = new Set<string>();

  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (candidate instanceof PDFRef) {
      const tag = candidate.toString();
      if (skippedRefs.has(tag)) continue;
      if (seenRefs.has(tag)) continue;
      seenRefs.add(tag);
      const resolved = resolveObject(source, candidate);
      if (resolved) pending.push(resolved);
      continue;
    }
    if (seenObjects.has(candidate)) continue;
    seenObjects.add(candidate);
    yield candidate;

    if (candidate instanceof PDFStream) {
      pending.push(candidate.dict);
    } else if (candidate instanceof PDFDict) {
      for (const [, value] of candidate.entries()) pending.push(value);
    } else if (candidate instanceof PDFArray) {
      for (let i = 0; i < candidate.size(); i += 1) {
        const value = candidate.get(i);
        if (value) pending.push(value);
      }
    }
  }
}

const FILE_SPEC_METADATA_KEYS = [
  "Type",
  "F",
  "UF",
  "DOS",
  "Mac",
  "Unix",
  "Desc",
  "AFRelationship",
  "V",
  "Volatile",
] as const;

const EMBEDDED_FILE_PARAM_KEYS = [
  "Size",
  "CheckSum",
  "CreationDate",
  "ModDate",
] as const;

function inspectEmbeddedFileSpec(
  source: PDFDocument,
  object: PDFDict,
): {
  inventory: DocumentFileSpecInventory;
  streamObjects: PDFStream[];
} | undefined {
  const efValue = object.get(PDFName.of("EF"));
  if (!efValue) return undefined;
  const ef = lookupDict(source, efValue);
  const streamObjects: PDFStream[] = [];
  const streams: DocumentFileSpecInventory["streams"] = [];
  const efShape: string[] = [];

  if (ef) {
    for (const [key, value] of ef.entries()) {
      const keyText = key.decodeText();
      const resolved = resolveObject(source, value);
      if (resolved instanceof PDFStream) {
        streamObjects.push(resolved);
        streams.push({
          key: keyText,
          signature: embeddedFileStreamSignature(source, resolved),
          payload: resolved.getContents(),
        });
        efShape.push(`${keyText}:stream`);
      } else {
        efShape.push(`${keyText}:${valueFingerprint(source, value)}`);
      }
    }
  } else {
    efShape.push(`invalid:${valueFingerprint(source, efValue)}`);
  }

  streams.sort((left, right) => left.key.localeCompare(right.key));
  efShape.sort();
  return {
    inventory: {
      signature: `${dictFieldSignature(
        source,
        object,
        FILE_SPEC_METADATA_KEYS,
      )}|EF=${efShape.join(",")}`,
      streams,
    },
    streamObjects,
  };
}

function embeddedFileStreamSignature(
  source: PDFDocument,
  stream: PDFStream,
): string {
  const params = lookupDict(source, stream.dict.get(PDFName.of("Params")));
  return [
    dictFieldSignature(source, stream.dict, ["Type", "Subtype"]),
    params
      ? dictFieldSignature(source, params, EMBEDDED_FILE_PARAM_KEYS)
      : "Params=",
  ].join("|");
}

function dictFieldSignature(
  source: PDFDocument,
  dict: PDFDict,
  keys: readonly string[],
): string {
  return keys
    .map((key) => {
      const value = dict.get(PDFName.of(key));
      return `${key}=${value ? valueFingerprint(source, value) : ""}`;
    })
    .join("|");
}

function valueFingerprint(source: PDFDocument, value: PDFObject): string {
  const resolved = resolveObject(source, value);
  if (!resolved) return "unresolved";
  if (resolved instanceof PDFName) return `name:${resolved.decodeText()}`;
  if (resolved instanceof PDFString || resolved instanceof PDFHexString) {
    return `${resolved.constructor.name}:${resolved.decodeText()}`;
  }
  return `${resolved.constructor.name}:${resolved.toString()}`;
}

function fileSpecInventoryEqual(
  left: DocumentFileSpecInventory,
  right: DocumentFileSpecInventory,
): boolean {
  if (left.signature !== right.signature) return false;
  if (left.streams.length !== right.streams.length) return false;
  return left.streams.every((stream, index) => {
    const candidate = right.streams[index];
    return (
      candidate !== undefined &&
      stream.key === candidate.key &&
      stream.signature === candidate.signature &&
      bytesEqual(stream.payload, candidate.payload)
    );
  });
}

type DestinationValidity = "valid" | "invalid" | "unknown";

type NameTreeSummary = {
  count: number;
  first: PDFObject | null;
  last: PDFObject | null;
};

type OutlineListSummary = {
  total: number;
  visible: number;
};

// Partial exports intentionally omit source pages. The generic catalog clone
// above remaps pages that survived, but it cannot decide what to do with the
// higher-level structures that addressed a removed page: their arrays contain
// `null` where the page ref used to be. Clean those structures as one unit so
// outlines, named destinations, OpenAction, and page links agree on which
// targets still exist.
function sanitizeNavigationCatalog(
  doc: PDFDocument,
  numericPageMap: ReadonlyMap<number, number>,
) {
  numericDestinationPageMaps.set(doc, numericPageMap);
  try {
    const pageRefs = new Set(doc.getPages().map((page) => page.ref.toString()));
    const validNames = pruneNamedDestinations(doc, pageRefs);
    pruneOutlines(doc, pageRefs, validNames);
    pruneOpenAction(doc, pageRefs, validNames);
    prunePageLinks(doc, pageRefs, validNames);
  } finally {
    numericDestinationPageMaps.delete(doc);
  }
}

function pruneNamedDestinations(
  doc: PDFDocument,
  pageRefs: Set<string>,
): Set<string> {
  const validNames = new Set<string>();
  const legacyDests = doc.catalog.lookupMaybe(DESTS_KEY, PDFDict);
  if (legacyDests) {
    for (const [key, value] of legacyDests.entries()) {
      if (destinationValidity(doc, value, pageRefs, validNames) === "invalid") {
        legacyDests.delete(key);
      } else {
        validNames.add(key.decodeText());
      }
    }
    if (legacyDests.keys().length === 0) doc.catalog.delete(DESTS_KEY);
  }

  const names = doc.catalog.lookupMaybe(NAMES_KEY, PDFDict);
  const destinationTree = names?.lookupMaybe(DESTS_KEY, PDFDict);
  if (names && destinationTree) {
    const summary = pruneDestinationNameTree(
      doc,
      destinationTree,
      pageRefs,
      validNames,
      new Set(),
    );
    if (summary.count === 0) names.delete(DESTS_KEY);
    if (names.keys().length === 0) doc.catalog.delete(NAMES_KEY);
  }
  return validNames;
}

function pruneDestinationNameTree(
  doc: PDFDocument,
  tree: PDFDict,
  pageRefs: Set<string>,
  validNames: Set<string>,
  visited: Set<PDFDict>,
): NameTreeSummary {
  if (visited.has(tree)) return { count: 0, first: null, last: null };
  visited.add(tree);

  let count = 0;
  let first: PDFObject | null = null;
  let last: PDFObject | null = null;
  const entries = tree.lookupMaybe(NAME_ENTRIES_KEY, PDFArray);
  if (entries) {
    const kept = PDFArray.withContext(doc.context);
    for (let index = 0; index + 1 < entries.size(); index += 2) {
      const key = entries.get(index);
      const value = entries.get(index + 1);
      if (destinationValidity(doc, value, pageRefs, validNames) === "invalid") {
        continue;
      }
      kept.push(key);
      kept.push(value);
      const decoded = destinationName(key);
      if (decoded) validNames.add(decoded);
      first ??= key;
      last = key;
      count += 1;
    }
    if (count > 0) tree.set(NAME_ENTRIES_KEY, kept);
    else tree.delete(NAME_ENTRIES_KEY);
  }

  const kids = tree.lookupMaybe(KIDS_KEY, PDFArray);
  if (kids) {
    const keptKids = PDFArray.withContext(doc.context);
    for (let index = 0; index < kids.size(); index += 1) {
      const kidObject = kids.get(index);
      const kid = lookupDict(doc, kidObject);
      if (!kid) continue;
      const summary = pruneDestinationNameTree(
        doc,
        kid,
        pageRefs,
        validNames,
        visited,
      );
      if (summary.count === 0) continue;
      keptKids.push(kidObject);
      first ??= summary.first;
      last = summary.last ?? last;
      count += summary.count;
    }
    if (keptKids.size() > 0) tree.set(KIDS_KEY, keptKids);
    else tree.delete(KIDS_KEY);
  }

  if (count > 0 && first && last) {
    const limits = PDFArray.withContext(doc.context);
    limits.push(first);
    limits.push(last);
    tree.set(LIMITS_KEY, limits);
  } else {
    tree.delete(LIMITS_KEY);
  }
  return { count, first, last };
}

function pruneOutlines(
  doc: PDFDocument,
  pageRefs: Set<string>,
  validNames: Set<string>,
) {
  const outlines = doc.catalog.lookupMaybe(OUTLINES_KEY, PDFDict);
  if (!outlines) return;
  const retained = pruneOutlineList(
    doc,
    outlines,
    pageRefs,
    validNames,
    new Set(),
    true,
  );
  if (retained.total > 0) return;

  doc.catalog.delete(OUTLINES_KEY);
  if (doc.catalog.get(PAGE_MODE_KEY)?.toString() === "/UseOutlines") {
    doc.catalog.delete(PAGE_MODE_KEY);
  }
}

function pruneOutlineList(
  doc: PDFDocument,
  parent: PDFDict,
  pageRefs: Set<string>,
  validNames: Set<string>,
  visited: Set<PDFDict>,
  root = false,
): OutlineListSummary {
  const kept: {
    object: PDFObject;
    dict: PDFDict;
    descendants: OutlineListSummary;
  }[] = [];
  const siblings = new Set<PDFDict>();
  let cursor = parent.get(FIRST_KEY);

  while (cursor) {
    const itemObject = cursor;
    const item = lookupDict(doc, itemObject);
    if (!item || siblings.has(item) || visited.has(item)) break;
    siblings.add(item);
    visited.add(item);
    const next = item.get(NEXT_KEY);
    const descendants = pruneOutlineList(
      doc,
      item,
      pageRefs,
      validNames,
      visited,
    );
    const removedTarget = stripInvalidInternalTargets(
      doc,
      item,
      pageRefs,
      validNames,
    );
    const hasRemainingTarget = item.has(DEST_KEY) || item.has(ACTION_KEY);
    if (!removedTarget || hasRemainingTarget || descendants.total > 0) {
      kept.push({ object: itemObject, dict: item, descendants });
    }
    cursor = next;
  }

  if (kept.length === 0) {
    parent.delete(FIRST_KEY);
    parent.delete(LAST_KEY);
    parent.delete(COUNT_KEY);
    return { total: 0, visible: 0 };
  }

  parent.set(FIRST_KEY, kept[0]!.object);
  parent.set(LAST_KEY, kept[kept.length - 1]!.object);
  kept.forEach(({ dict }, index) => {
    const previous = kept[index - 1]?.object;
    const next = kept[index + 1]?.object;
    if (previous) dict.set(PREV_KEY, previous);
    else dict.delete(PREV_KEY);
    if (next) dict.set(NEXT_KEY, next);
    else dict.delete(NEXT_KEY);
  });

  const total = kept.reduce(
    (sum, item) => sum + 1 + item.descendants.total,
    0,
  );
  const visible = kept.reduce((sum, item) => {
    const itemCount = item.dict.lookupMaybe(COUNT_KEY, PDFNumber)?.asNumber() ?? 0;
    return sum + 1 + (itemCount >= 0 ? item.descendants.visible : 0);
  }, 0);
  const previousCount = parent.lookupMaybe(COUNT_KEY, PDFNumber)?.asNumber() ?? 0;
  parent.set(
    COUNT_KEY,
    PDFNumber.of(root || previousCount >= 0 ? visible : -visible),
  );
  return { total, visible };
}

function pruneOpenAction(
  doc: PDFDocument,
  pageRefs: Set<string>,
  validNames: Set<string>,
) {
  const value = doc.catalog.get(OPEN_ACTION_KEY, true);
  if (!value) return;
  const action = lookupDict(doc, value);
  const invalid = action
    ? isInvalidGoToAction(doc, action, pageRefs, validNames)
    : destinationValidity(doc, value, pageRefs, validNames) === "invalid";
  if (invalid) doc.catalog.delete(OPEN_ACTION_KEY);
}

function prunePageLinks(
  doc: PDFDocument,
  pageRefs: Set<string>,
  validNames: Set<string>,
) {
  for (const page of doc.getPages()) {
    const annots = asArray(doc, page.node.get(ANNOTS_KEY));
    if (!annots) continue;
    const drop: number[] = [];
    for (let index = 0; index < annots.size(); index += 1) {
      const annot = lookupDict(doc, annots.get(index));
      if (!annot || annot.get(SUBTYPE_KEY)?.toString() !== "/Link") continue;
      const removedTarget = stripInvalidInternalTargets(
        doc,
        annot,
        pageRefs,
        validNames,
      );
      if (
        removedTarget &&
        !annot.has(DEST_KEY) &&
        !annot.has(ACTION_KEY)
      ) {
        drop.push(index);
      }
    }
    for (const index of drop.reverse()) annots.remove(index);
    if (annots.size() === 0) page.node.delete(ANNOTS_KEY);
  }
}

function stripInvalidInternalTargets(
  doc: PDFDocument,
  owner: PDFDict,
  pageRefs: Set<string>,
  validNames: Set<string>,
): boolean {
  let removed = false;
  const destination = owner.get(DEST_KEY, true);
  if (
    destination &&
    destinationValidity(doc, destination, pageRefs, validNames) === "invalid"
  ) {
    owner.delete(DEST_KEY);
    removed = true;
  }

  const action = lookupDict(doc, owner.get(ACTION_KEY));
  if (action && isInvalidGoToAction(doc, action, pageRefs, validNames)) {
    owner.delete(ACTION_KEY);
    removed = true;
  }
  return removed;
}

function isInvalidGoToAction(
  doc: PDFDocument,
  action: PDFDict,
  pageRefs: Set<string>,
  validNames: Set<string>,
): boolean {
  if (action.get(ACTION_TYPE_KEY)?.toString() !== "/GoTo") return false;
  return (
    destinationValidity(
      doc,
      action.get(ACTION_DEST_KEY, true),
      pageRefs,
      validNames,
    ) === "invalid"
  );
}

function destinationValidity(
  doc: PDFDocument,
  value: PDFObject | undefined,
  pageRefs: Set<string>,
  validNames: Set<string>,
): DestinationValidity {
  if (!value || value === PDFNull) return "invalid";
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (!resolved || resolved === PDFNull) return "invalid";
  if (resolved instanceof PDFArray) {
    if (resolved.size() === 0) return "invalid";
    const target = resolved.get(0);
    if (!target || target === PDFNull) return "invalid";
    if (target instanceof PDFRef) {
      return pageRefs.has(target.toString()) ? "valid" : "invalid";
    }
    if (target instanceof PDFNumber) {
      const sourcePageIndex = target.asNumber();
      const destinationPageIndex = Number.isInteger(sourcePageIndex)
        ? numericDestinationPageMaps.get(doc)?.get(sourcePageIndex)
        : undefined;
      if (destinationPageIndex === undefined) return "invalid";
      resolved.set(0, PDFNumber.of(destinationPageIndex));
      return "valid";
    }
    return "unknown";
  }
  if (resolved instanceof PDFDict) {
    const nested = resolved.get(ACTION_DEST_KEY, true);
    return nested
      ? destinationValidity(doc, nested, pageRefs, validNames)
      : "invalid";
  }
  const name = destinationName(resolved);
  if (name) return validNames.has(name) ? "valid" : "invalid";
  return "unknown";
}

function destinationName(value: PDFObject): string | null {
  if (
    value instanceof PDFName ||
    value instanceof PDFString ||
    value instanceof PDFHexString
  ) {
    return value.decodeText();
  }
  return null;
}

// /AcroForm cannot go through cloneObject: its /Fields point at the widget
// annotations pdf-lib already copied with the pages, so a fresh deep clone
// would produce a second, disconnected copy of every field — the page would
// show one widget while the form dictionary described another. Instead keep
// the form's own settings (/DA, /DR, /NeedAppearances, /SigFlags, /Q) and
// rebuild /Fields from the widgets that actually landed on exported pages.
// Fields whose widgets were not exported drop out, which is the correct
// outcome for a partial export.
function preserveAcroForm(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
) {
  const acroFormKey = PDFName.of("AcroForm");
  const sourceForm = lookupDict(source, source.catalog.get(acroFormKey));
  if (!sourceForm) return;

  const fields = collectFieldRootsFromPages(dest);
  if (fields.length === 0) return;

  const clonedForm = PDFDict.withContext(dest.context);
  for (const [key, value] of sourceForm.entries()) {
    if (key.asString() === "/Fields") continue;
    const cloned = cloneObject(source, dest, state, value);
    if (cloned) clonedForm.set(key, cloned);
  }

  const fieldArray = PDFArray.withContext(dest.context);
  for (const ref of fields) fieldArray.push(ref);
  clonedForm.set(PDFName.of("Fields"), fieldArray);
  dest.catalog.set(acroFormKey, clonedForm);
}

// Walks every exported page's /Annots for widget annotations and returns the
// root of each one's field hierarchy (a widget merged with its field is its
// own root). Order follows page order so the rebuilt /Fields reads naturally.
function collectFieldRootsFromPages(dest: PDFDocument): PDFRef[] {
  const roots: PDFRef[] = [];
  const seen = new Set<string>();
  const parentKey = PDFName.of("Parent");
  const subtypeKey = PDFName.of("Subtype");

  for (const page of dest.getPages()) {
    const annots = asArray(dest, page.node.get(ANNOTS_KEY));
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const element = annots.get(i);
      if (!(element instanceof PDFRef)) continue;
      const annot = lookupDict(dest, element);
      if (!annot) continue;
      if (annot.get(subtypeKey)?.toString() !== "/Widget") continue;

      let rootRef: PDFRef = element;
      let current = annot;
      // Bounded walk: a malformed file can point /Parent back at itself.
      const visited = new Set<string>([element.toString()]);
      for (let depth = 0; depth < 32; depth++) {
        const parent = current.get(parentKey);
        if (!(parent instanceof PDFRef)) break;
        const tag = parent.toString();
        if (visited.has(tag)) break;
        visited.add(tag);
        const parentDict = lookupDict(dest, parent);
        if (!parentDict) break;
        rootRef = parent;
        current = parentDict;
      }

      const rootTag = rootRef.toString();
      if (seen.has(rootTag)) continue;
      seen.add(rootTag);
      roots.push(rootRef);
    }
  }

  return roots;
}

function copyNamesEntry(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
  entryName: "Dests" | "EmbeddedFiles",
): boolean {
  const namesKey = PDFName.of("Names");
  const entryKey = PDFName.of(entryName);
  const rawSourceNames = source.catalog.get(namesKey);
  if (!rawSourceNames) return false;
  const sourceNames = lookupDict(source, rawSourceNames);
  if (!sourceNames) {
    if (entryName === "EmbeddedFiles") {
      throw new Error("Invalid PDF attachment catalog: /Names is not a dictionary.");
    }
    return false;
  }
  const sourceEntry = sourceNames.get(entryKey);
  if (!sourceEntry) return false;
  if (entryName === "EmbeddedFiles" && !lookupDict(source, sourceEntry)) {
    throw new Error(
      "Invalid PDF attachment catalog: /Names/EmbeddedFiles is not a dictionary.",
    );
  }
  const clonedEntry = cloneObject(source, dest, state, sourceEntry);
  if (!clonedEntry) {
    throw new Error(`Unable to preserve PDF catalog /Names/${entryName}.`);
  }
  const rawDestNames = dest.catalog.get(namesKey);
  let destNames = rawDestNames ? lookupDict(dest, rawDestNames) : undefined;
  if (rawDestNames && !destNames) {
    throw new Error("Invalid output PDF catalog: /Names is not a dictionary.");
  }
  if (!destNames) {
    destNames = PDFDict.withContext(dest.context);
    dest.catalog.set(namesKey, destNames);
  }
  destNames.set(entryKey, clonedEntry);
  return true;
}

function copyDocumentFileEntries(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
): boolean {
  let copied = copyNamesEntry(source, dest, state, "EmbeddedFiles");
  copied = copyCatalogEntry(source, dest, state, "AF") || copied;
  copied = copyCatalogEntry(source, dest, state, "Collection") || copied;
  return copied;
}

function copyPageMode(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
  documentFiles: "preserve" | "omit",
) {
  const pageMode = source.catalog.get(PDFName.of("PageMode"));
  if (
    documentFiles === "omit" &&
    isName(source, pageMode, "UseAttachments")
  ) {
    return;
  }
  copyCatalogEntry(source, dest, state, "PageMode");
}

function copyUseAttachmentsPageMode(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
) {
  const pageMode = source.catalog.get(PDFName.of("PageMode"));
  if (isName(source, pageMode, "UseAttachments")) {
    copyCatalogEntry(source, dest, state, "PageMode");
  }
}

// copyPages() owns a separate object copier, so a FileSpec referenced both
// from a page and from Catalog /AF would otherwise be cloned twice. Pair the
// source and copied page entries first and seed this catalog clone's cache;
// /Names/EmbeddedFiles and /AF will then reuse the exact FileSpec ref that the
// page's /AF or FileAttachment annotation already points at.
function seedCopiedDocumentFileMappings(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
) {
  if (state.pageRefMap.size === 0) return;
  const afKey = PDFName.of("AF");
  const fsKey = PDFName.of("FS");
  const subtypeKey = PDFName.of("Subtype");

  for (const sourcePage of source.getPages()) {
    const destPageRef = state.pageRefMap.get(sourcePage.ref.toString());
    if (!destPageRef) continue;
    const destPage = lookupDict(dest, destPageRef);
    if (!destPage) continue;

    seedArrayEntryMappings(
      source,
      dest,
      state,
      asArray(source, sourcePage.node.get(afKey)),
      asArray(dest, destPage.get(afKey)),
    );

    const sourceSpecs = fileAttachmentSpecs(
      source,
      asArray(source, sourcePage.node.get(ANNOTS_KEY)),
      subtypeKey,
      fsKey,
    );
    const destSpecs = fileAttachmentSpecs(
      dest,
      asArray(dest, destPage.get(ANNOTS_KEY)),
      subtypeKey,
      fsKey,
    );
    const pairedCount = Math.min(sourceSpecs.length, destSpecs.length);
    for (let i = 0; i < pairedCount; i += 1) {
      seedObjectMapping(
        source,
        dest,
        state,
        sourceSpecs[i],
        destSpecs[i],
      );
    }
  }
}

function fileAttachmentSpecs(
  doc: PDFDocument,
  annots: PDFArray | undefined,
  subtypeKey: PDFName,
  fsKey: PDFName,
): PDFObject[] {
  const specs: PDFObject[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i += 1) {
    const annot = lookupDict(doc, annots!.get(i));
    if (!annot || !isName(doc, annot.get(subtypeKey), "FileAttachment")) continue;
    const fileSpec = annot.get(fsKey);
    if (fileSpec) specs.push(fileSpec);
  }
  return specs;
}

function seedArrayEntryMappings(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
  sourceArray: PDFArray | undefined,
  destArray: PDFArray | undefined,
) {
  const pairedCount = Math.min(sourceArray?.size() ?? 0, destArray?.size() ?? 0);
  for (let i = 0; i < pairedCount; i += 1) {
    seedObjectMapping(
      source,
      dest,
      state,
      sourceArray!.get(i),
      destArray!.get(i),
    );
  }
}

// One internal Link annotation whose destination array names a page directly
// (`[<page ref> /XYZ left top zoom]`) rather than via a named destination.
export type DetachedLinkDestination = {
  sourcePageIndex: number;
  annotIndex: number;
  // Which array held the page ref: /Dest on the annotation, or /D on its
  // /A GoTo action. Both forms are common in the wild.
  via: "Dest" | "Action";
  targetTag: string;
};

export type ReattachedLinkDestinations = {
  dropped: number;
  unresolved: number;
};

const DEST_KEY = PDFName.of("Dest");
const DESTS_KEY = PDFName.of("Dests");
const ACTION_KEY = PDFName.of("A");
const ACTION_DEST_KEY = PDFName.of("D");
const ACTION_TYPE_KEY = PDFName.of("S");
const SUBTYPE_KEY = PDFName.of("Subtype");
const ANNOTS_KEY = PDFName.of("Annots");
const OUTLINES_KEY = PDFName.of("Outlines");
const FIRST_KEY = PDFName.of("First");
const LAST_KEY = PDFName.of("Last");
const NEXT_KEY = PDFName.of("Next");
const PREV_KEY = PDFName.of("Prev");
const COUNT_KEY = PDFName.of("Count");
const NAMES_KEY = PDFName.of("Names");
const NAME_ENTRIES_KEY = PDFName.of("Names");
const KIDS_KEY = PDFName.of("Kids");
const LIMITS_KEY = PDFName.of("Limits");
const PAGE_MODE_KEY = PDFName.of("PageMode");
const OPEN_ACTION_KEY = PDFName.of("OpenAction");

// Temporarily removes direct page references from internal links BEFORE the
// pages are copied, and returns what was removed so it can be reattached
// afterwards.
//
// Without this, pdf-lib's object copier follows the destination ref and copies
// the WHOLE target page as an ordinary object. That copy is never inserted
// into /Pages, so the link resolves to a page the viewer cannot reach — every
// table-of-contents jump, "see figure 3", and citation back-link stops working
// — and the export carries a duplicate of each linked page for nothing.
// Nulling the slot first means the copier has no ref to chase, so no orphan is
// produced and the file does not grow.
//
// This mutates `source`, which is a throwaway parse of the caller's bytes (the
// export already strips replaceable annotations from it the same way).
export function detachDirectLinkDestinations(
  source: PDFDocument,
): DetachedLinkDestination[] {
  const detached: DetachedLinkDestination[] = [];
  const pages = source.getPages();

  pages.forEach((page, sourcePageIndex) => {
    const annots = asArray(source, page.node.get(ANNOTS_KEY));
    if (!annots) return;
    for (let annotIndex = 0; annotIndex < annots.size(); annotIndex++) {
      const annot = lookupDict(source, annots.get(annotIndex));
      if (!annot) continue;
      if (!isName(source, annot.get(SUBTYPE_KEY), "Link")) continue;

      for (const via of ["Dest", "Action"] as const) {
        const array = destinationArray(source, annot, via);
        if (!array || array.size() === 0) continue;
        const target = array.get(0);
        // An indirect PDFNumber is still a numeric destination, not a page
        // reference. Leave that scalar in place so copyPages can preserve it;
        // keep the existing fail-closed detach/drop behavior for every other
        // indirect target (including malformed and out-of-document refs).
        if (!(target instanceof PDFRef)) continue;
        if (resolveObject(source, target) instanceof PDFNumber) continue;
        detached.push({
          sourcePageIndex,
          annotIndex,
          via,
          targetTag: target.toString(),
        });
        array.set(0, source.context.obj(null));
      }
    }
  });

  return detached;
}

// Rewrites each detached link to point at the page that was actually inserted
// into the exported document, and removes links whose target page is not part
// of this export (a dangling GoTo is worse than no link).
export function reattachLinkDestinations(
  dest: PDFDocument,
  exportedPages: { sourceIndex: number; node: PDFDict }[],
  detached: DetachedLinkDestination[],
  pageRefMap: Map<string, PDFRef>,
): ReattachedLinkDestinations {
  if (detached.length === 0) return { dropped: 0, unresolved: 0 };

  let dropped = 0;
  let unresolved = 0;
  let processed = 0;

  const bySourceIndex = new Map<number, DetachedLinkDestination[]>();
  for (const entry of detached) {
    const list = bySourceIndex.get(entry.sourcePageIndex);
    if (list) list.push(entry);
    else bySourceIndex.set(entry.sourcePageIndex, [entry]);
  }

  for (const { sourceIndex, node } of exportedPages) {
    const entries = bySourceIndex.get(sourceIndex);
    if (!entries) continue;
    const annots = asArray(dest, node.get(ANNOTS_KEY));
    if (!annots) continue;

    // Copied annotations keep source order, and overlay annotations are only
    // ever appended, so index i still addresses the same annotation. Dropped
    // links are collected and removed after the pass so indices stay stable.
    const drop = new Set<number>();
    for (const entry of entries) {
      processed += 1;
      if (entry.annotIndex >= annots.size()) {
        unresolved += 1;
        continue;
      }
      const annot = lookupDict(dest, annots.get(entry.annotIndex));
      if (!annot || !isName(dest, annot.get(SUBTYPE_KEY), "Link")) {
        unresolved += 1;
        continue;
      }
      const array = destinationArray(dest, annot, entry.via);
      if (!array || array.size() === 0) {
        unresolved += 1;
        continue;
      }

      const mapped = pageRefMap.get(entry.targetTag);
      if (mapped) array.set(0, mapped);
      else {
        drop.add(entry.annotIndex);
        dropped += 1;
      }
    }

    for (const index of [...drop].sort((a, b) => b - a)) annots.remove(index);
  }
  return {
    dropped,
    unresolved: unresolved + Math.max(0, detached.length - processed),
  };
}

// A /Dest may legitimately be a name or string (a NAMED destination, resolved
// through /Names /Dests, which preserveNavigationCatalogEntries already remaps)
// rather than an array. pdf-lib's lookupMaybe THROWS on a type mismatch instead
// of returning undefined, so every lookup here is untyped and narrowed by hand.
function destinationArray(
  doc: PDFDocument,
  annot: PDFDict,
  via: "Dest" | "Action",
): PDFArray | undefined {
  if (via === "Dest") {
    return asArray(doc, annot.get(DEST_KEY));
  }
  const action = lookupDict(doc, annot.get(ACTION_KEY));
  if (!action) return undefined;
  return asArray(doc, action.get(ACTION_DEST_KEY));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}
