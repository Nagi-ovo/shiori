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

export type PdfPageInsertErrorCode =
  | "encryptedIncoming"
  | "baseEncryption"
  | "pagesPermission"
  | "interactive"
  | "navigation"
  | "empty"
  | "invalidPosition"
  | "documentFiles"
  | "baseDocumentFiles"
  | "baseSigned";

/** A page insertion that cannot be completed without silently losing meaning. */
export class PdfPageInsertError extends Error {
  readonly code: PdfPageInsertErrorCode;

  constructor(code: PdfPageInsertErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PdfPageInsertError";
    this.code = code;
  }
}

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
  shiftBasePositionalStructures(
    base,
    basePageNodes,
    insertionIndex,
    insertedPageCount,
  );
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

const MAX_DESTINATION_DEPTH = 64;

type DestinationRemapState = {
  mapIndex: (index: number) => number;
  pageRefTags: ReadonlySet<string>;
};

/** Keep the current document's position-based navigation attached to its pages. */
function shiftBasePositionalStructures(
  document: PDFDocument,
  basePageNodes: readonly PDFDict[],
  insertionIndex: number,
  insertedPageCount: number,
) {
  shiftPageLabelNumberTree(document, insertionIndex, insertedPageCount);
  const state: DestinationRemapState = {
    mapIndex: (index) => {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= basePageNodes.length
      ) {
        throw new PdfPageInsertError(
          "navigation",
          `Invalid numeric page destination: ${index}`,
        );
      }
      return index >= insertionIndex ? index + insertedPageCount : index;
    },
    pageRefTags: new Set(document.getPages().map((page) => page.ref.toString())),
  };

  for (const destination of collectNamedDestinations(document).values()) {
    remapDestination(document, destination, state, "named destination");
  }
  const openAction = document.catalog.get(PDFName.of("OpenAction"));
  if (openAction) remapOpenAction(document, openAction, state);
  remapOutlineDestinations(document, state);
  for (const page of basePageNodes) {
    remapAdditionalActions(document, page, state, "page");
    remapAnnotationDestinations(document, page, state);
  }
}

function shiftPageLabelNumberTree(
  document: PDFDocument,
  insertionIndex: number,
  insertedPageCount: number,
) {
  const rawRoot = document.catalog.get(PDFName.of("PageLabels"));
  if (!rawRoot) return;
  const root = lookupDict(document, rawRoot);
  if (!root) {
    throw new PdfPageInsertError(
      "navigation",
      "The current PDF has an invalid page-label number tree.",
    );
  }
  const pending = [root];
  const seen = new Set<PDFDict>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    const numsRaw = node.get(PDFName.of("Nums"));
    if (numsRaw) {
      const nums = lookupArray(document, numsRaw);
      if (!nums || nums.size() % 2 !== 0) {
        throw new PdfPageInsertError(
          "navigation",
          "The current PDF has invalid page-label entries.",
        );
      }
      for (let index = 0; index < nums.size(); index += 2) {
        const key = resolveObject(document, nums.get(index));
        if (!(key instanceof PDFNumber)) {
          throw new PdfPageInsertError(
            "navigation",
            "The current PDF has a non-numeric page-label key.",
          );
        }
        const value = key.asNumber();
        if (!Number.isInteger(value) || value < 0) {
          throw new PdfPageInsertError(
            "navigation",
            "The current PDF has an invalid page-label index.",
          );
        }
        nums.set(
          index,
          PDFNumber.of(
            value >= insertionIndex ? value + insertedPageCount : value,
          ),
        );
      }
    }
    const limitsRaw = node.get(PDFName.of("Limits"));
    if (limitsRaw) {
      const limits = lookupArray(document, limitsRaw);
      if (!limits || limits.size() !== 2) {
        throw new PdfPageInsertError(
          "navigation",
          "The current PDF has invalid page-label limits.",
        );
      }
      for (let index = 0; index < 2; index += 1) {
        const key = resolveObject(document, limits.get(index));
        if (!(key instanceof PDFNumber) || !Number.isInteger(key.asNumber())) {
          throw new PdfPageInsertError(
            "navigation",
            "The current PDF has non-numeric page-label limits.",
          );
        }
        const value = key.asNumber();
        limits.set(
          index,
          PDFNumber.of(
            value >= insertionIndex ? value + insertedPageCount : value,
          ),
        );
      }
    }
    const kidsRaw = node.get(PDFName.of("Kids"));
    if (!kidsRaw) continue;
    const kids = lookupArray(document, kidsRaw);
    if (!kids) {
      throw new PdfPageInsertError(
        "navigation",
        "The current PDF has invalid page-label children.",
      );
    }
    for (let index = 0; index < kids.size(); index += 1) {
      const child = lookupDict(document, kids.get(index));
      if (!child) {
        throw new PdfPageInsertError(
          "navigation",
          "The current PDF has an invalid page-label child.",
        );
      }
      pending.push(child);
    }
  }
}

function remapInsertedNumericLinks(
  document: PDFDocument,
  insertedPageNodes: readonly PDFDict[],
  insertionIndex: number,
  insertedPageCount: number,
) {
  const state: DestinationRemapState = {
    mapIndex: (index) => {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= insertedPageCount
      ) {
        throw new PdfPageInsertError(
          "navigation",
          `Incoming page link points outside the inserted PDF: ${index}`,
        );
      }
      return insertionIndex + index;
    },
    pageRefTags: new Set(document.getPages().map((page) => page.ref.toString())),
  };
  for (const page of insertedPageNodes) {
    remapAnnotationDestinations(document, page, state);
  }
}

function remapAnnotationDestinations(
  document: PDFDocument,
  page: PDFDict,
  state: DestinationRemapState,
) {
  const annots = lookupArray(document, page.get(PDFName.of("Annots")));
  if (!annots) return;
  for (let index = 0; index < annots.size(); index += 1) {
    const annot = lookupDict(document, annots.get(index));
    if (!annot) {
      throw new PdfPageInsertError(
        "navigation",
        "A page contains an invalid annotation reference.",
      );
    }
    remapOwnerDestination(document, annot, state, "annotation");
  }
}

function remapOutlineDestinations(
  document: PDFDocument,
  state: DestinationRemapState,
) {
  const root = lookupDict(
    document,
    document.catalog.get(PDFName.of("Outlines")),
  );
  if (!root) return;
  const pending: PDFObject[] = [];
  const first = root.get(PDFName.of("First"));
  if (first) pending.push(first);
  const seen = new Set<PDFDict>();
  while (pending.length > 0) {
    const item = lookupDict(document, pending.pop());
    if (!item || seen.has(item)) continue;
    seen.add(item);
    remapOwnerDestination(document, item, state, "outline item");
    const child = item.get(PDFName.of("First"));
    const next = item.get(PDFName.of("Next"));
    if (child) pending.push(child);
    if (next) pending.push(next);
  }
}

function remapOwnerDestination(
  document: PDFDocument,
  owner: PDFDict,
  state: DestinationRemapState,
  context: string,
) {
  const direct = owner.get(PDFName.of("Dest"));
  if (direct) remapDestination(document, direct, state, `${context} /Dest`);
  const action = owner.get(PDFName.of("A"));
  if (action) remapActionChain(document, action, state, `${context} /A`);
  remapAdditionalActions(document, owner, state, context);
}

function remapOpenAction(
  document: PDFDocument,
  raw: PDFObject,
  state: DestinationRemapState,
) {
  const resolved = resolveObject(document, raw);
  if (resolved instanceof PDFDict && resolved.get(PDFName.of("S"))) {
    remapActionChain(document, raw, state, "OpenAction");
    return;
  }
  remapDestination(document, raw, state, "OpenAction");
}

function remapAdditionalActions(
  document: PDFDocument,
  owner: PDFDict,
  state: DestinationRemapState,
  context: string,
) {
  const rawActions = owner.get(PDFName.of("AA"));
  if (!rawActions) return;
  const actions = lookupDict(document, rawActions);
  if (!actions) {
    throw new PdfPageInsertError(
      "navigation",
      `The ${context} has an invalid /AA dictionary.`,
    );
  }
  for (const [trigger, action] of actions.entries()) {
    remapActionChain(
      document,
      action,
      state,
      `${context} /AA /${trigger.decodeText()}`,
    );
  }
}

function remapActionChain(
  document: PDFDocument,
  raw: PDFObject,
  state: DestinationRemapState,
  context: string,
  seen = new Set<PDFDict>(),
  depth = 0,
) {
  if (depth > MAX_DESTINATION_DEPTH) {
    throw new PdfPageInsertError(
      "navigation",
      `The ${context} action chain is too deep.`,
    );
  }
  const action = lookupDict(document, raw);
  if (!action) {
    throw new PdfPageInsertError(
      "navigation",
      `The ${context} action is not a dictionary.`,
    );
  }
  if (seen.has(action)) {
    throw new PdfPageInsertError(
      "navigation",
      `The ${context} action chain contains a cycle.`,
    );
  }
  seen.add(action);
  const actionType = resolveObject(document, action.get(PDFName.of("S")));
  if (!(actionType instanceof PDFName)) {
    throw new PdfPageInsertError(
      "navigation",
      `The ${context} action has no valid /S type.`,
    );
  }
  if (actionType.decodeText() === "GoTo") {
    const destination = action.get(PDFName.of("D"));
    if (!destination) {
      throw new PdfPageInsertError(
        "navigation",
        `The ${context} GoTo action has no /D destination.`,
      );
    }
    remapDestination(document, destination, state, `${context} /D`);
  }

  const rawNext = action.get(PDFName.of("Next"));
  if (!rawNext) {
    seen.delete(action);
    return;
  }
  const next = resolveObject(document, rawNext);
  if (next instanceof PDFArray) {
    for (let index = 0; index < next.size(); index += 1) {
      const child = next.get(index);
      if (!child) {
        throw new PdfPageInsertError(
          "navigation",
          `The ${context} /Next array contains an empty action.`,
        );
      }
      remapActionChain(
        document,
        child,
        state,
        `${context} /Next[${index}]`,
        seen,
        depth + 1,
      );
    }
    seen.delete(action);
    return;
  }
  if (next instanceof PDFDict) {
    remapActionChain(
      document,
      rawNext,
      state,
      `${context} /Next`,
      seen,
      depth + 1,
    );
    seen.delete(action);
    return;
  }
  throw new PdfPageInsertError(
    "navigation",
    `The ${context} /Next entry has an unsupported shape.`,
  );
}

function remapDestination(
  document: PDFDocument,
  raw: PDFObject,
  state: DestinationRemapState,
  context: string,
  seen = new Set<PDFDict>(),
  depth = 0,
) {
  if (depth > MAX_DESTINATION_DEPTH) {
    throw new PdfPageInsertError(
      "navigation",
      `The ${context} is too deeply nested.`,
    );
  }
  const destination = resolveObject(document, raw);
  if (
    destination instanceof PDFName ||
    destination instanceof PDFString ||
    destination instanceof PDFHexString
  ) {
    return;
  }
  if (destination instanceof PDFDict) {
    if (seen.has(destination)) {
      throw new PdfPageInsertError(
        "navigation",
        `The ${context} contains a cycle.`,
      );
    }
    seen.add(destination);
    const nested = destination.get(PDFName.of("D"));
    if (!nested) {
      throw new PdfPageInsertError(
        "navigation",
        `The ${context} dictionary has no /D destination.`,
      );
    }
    remapDestination(document, nested, state, context, seen, depth + 1);
    return;
  }
  if (!(destination instanceof PDFArray) || destination.size() === 0) {
    throw new PdfPageInsertError(
      "navigation",
      `The ${context} has an unsupported destination shape.`,
    );
  }
  const rawTarget = destination.get(0);
  if (
    rawTarget instanceof PDFRef &&
    state.pageRefTags.has(rawTarget.toString())
  ) {
    return;
  }
  const target = resolveObject(document, rawTarget);
  if (!(target instanceof PDFNumber)) {
    throw new PdfPageInsertError(
      "navigation",
      `The ${context} does not point to a page in this PDF.`,
    );
  }
  destination.set(0, PDFNumber.of(state.mapIndex(target.asNumber())));
}

const INTERACTIVE_ANNOTATION_SUBTYPES = new Set([
  "Widget",
  "Screen",
  "Movie",
  "Sound",
  "RichMedia",
  "3D",
]);
const SAFE_URI_SCHEME = /^(?:https?|mailto):/i;

function assertBaseIsNotSigned(document: PDFDocument) {
  const issue = pdfSignatureIssue(document);
  if (issue) throw new PdfPageInsertError("baseSigned", issue);
}

function assertIncomingLinkDestinations(document: PDFDocument) {
  const pageRefTags = new Set(
    document.getPages().map((page) => page.ref.toString()),
  );
  const state: DestinationRemapState = {
    pageRefTags,
    mapIndex: (index) => {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= document.getPageCount()
      ) {
        throw new PdfPageInsertError(
          "navigation",
          `Incoming page link points outside the selected PDF: ${index}`,
        );
      }
      return index;
    },
  };
  for (const page of document.getPages()) {
    const annots = lookupArray(document, page.node.get(PDFName.of("Annots")));
    if (!annots) continue;
    for (let index = 0; index < annots.size(); index += 1) {
      const annot = lookupDict(document, annots.get(index));
      if (!annot) {
        throw new PdfPageInsertError(
          "navigation",
          "The selected PDF contains an invalid annotation reference.",
        );
      }
      if (isName(document, annot.get(PDFName.of("Subtype")), "Link")) {
        remapOwnerDestination(document, annot, state, "incoming link");
      }
    }
  }
}

/**
 * Page insertion must not turn content that Shiori only rendered inertly into
 * active content in somebody else's PDF viewer. Catalog JavaScript is already
 * excluded by exportPdf(), but page and annotation actions are reachable from
 * copyPages(). Keep ordinary internal and web links; fail closed for forms,
 * media, launch/JavaScript actions and additional-action triggers.
 */
function hasUnsupportedInteractiveContent(document: PDFDocument): boolean {
  if (
    document.catalog.get(PDFName.of("AcroForm")) ||
    document.catalog.get(PDFName.of("Perms"))
  ) {
    return true;
  }
  for (const page of document.getPages()) {
    if (page.node.get(PDFName.of("AA"))) return true;
    const annots = lookupArray(document, page.node.get(PDFName.of("Annots")));
    if (!annots) continue;
    for (let index = 0; index < annots.size(); index += 1) {
      const annot = lookupDict(document, annots.get(index));
      if (!annot) continue;
      const subtype = resolveObject(document, annot.get(PDFName.of("Subtype")));
      if (
        subtype instanceof PDFName &&
        INTERACTIVE_ANNOTATION_SUBTYPES.has(subtype.decodeText())
      ) {
        return true;
      }
      if (annot.get(PDFName.of("AA"))) return true;
      const rawAction = annot.get(PDFName.of("A"));
      if (!rawAction) continue;
      // Only Link annotations have action semantics that this feature
      // intentionally preserves and remaps.
      if (!(subtype instanceof PDFName) || subtype.decodeText() !== "Link") {
        return true;
      }
      const action = lookupDict(document, rawAction);
      if (!action || action.get(PDFName.of("Next"))) return true;
      const actionType = resolveObject(document, action.get(PDFName.of("S")));
      if (!(actionType instanceof PDFName)) return true;
      const type = actionType.decodeText();
      if (type !== "GoTo" && type !== "URI") return true;
      if (type === "URI") {
        const uri = resolveObject(document, action.get(PDFName.of("URI")));
        if (
          !(uri instanceof PDFString || uri instanceof PDFHexString) ||
          !SAFE_URI_SCHEME.test(uri.decodeText().trim())
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

type NamedDestination = { name: string; value: PDFObject };

function mergeReferencedNamedDestinations(
  source: PDFDocument,
  destination: PDFDocument,
  copiedPageNodes: PDFDict[],
  pageRefMap: ReadonlyMap<string, PDFRef>,
  incomingName: string,
) {
  const referencedNames = namedLinkReferences(source);
  if (referencedNames.size === 0) return;
  const destinations = collectNamedDestinations(source);
  const legacyDestsKey = PDFName.of("Dests");
  const existing = lookupDict(destination, destination.catalog.get(legacyDestsKey));
  if (destination.catalog.get(legacyDestsKey) && !existing) {
    throw new PdfPageInsertError(
      "navigation",
      "The current PDF has an invalid named-destination dictionary.",
    );
  }
  const outputDests = existing ?? PDFDict.withContext(destination.context);
  if (!existing) destination.catalog.set(legacyDestsKey, outputDests);
  const reservedNames = {
    semantic: new Set(collectNamedDestinations(destination).keys()),
    encoded: new Set(outputDests.keys().map((key) => key.toString())),
  };

  const renamed = new Map<string, string>();
  for (const name of referencedNames) {
    const sourceDestination = destinations.get(name);
    if (!sourceDestination) {
      throw new PdfPageInsertError(
        "navigation",
        `Named destination ${name} is missing from the selected PDF.`,
      );
    }
    const outputName = uniqueDestinationName(
      reservedNames,
      incomingName,
      name,
    );
    const outputKey = PDFName.of(outputName);
    outputDests.set(
      outputKey,
      cloneDestination(source, destination, sourceDestination, pageRefMap),
    );
    reservedNames.semantic.add(outputName);
    reservedNames.encoded.add(outputKey.toString());
    renamed.set(name, outputName);
  }
  rewriteNamedLinks(destination, copiedPageNodes, renamed);
}

function namedLinkReferences(document: PDFDocument): Set<string> {
  const names = new Set<string>();
  for (const page of document.getPages()) {
    const annots = lookupArray(document, page.node.get(PDFName.of("Annots")));
    if (!annots) continue;
    for (let index = 0; index < annots.size(); index += 1) {
      const annot = lookupDict(document, annots.get(index));
      if (!annot || !isName(document, annot.get(PDFName.of("Subtype")), "Link")) {
        continue;
      }
      const direct = destinationName(document, annot.get(PDFName.of("Dest")));
      if (direct) names.add(direct);
      const action = lookupDict(document, annot.get(PDFName.of("A")));
      if (!action || !isName(document, action.get(PDFName.of("S")), "GoTo")) {
        continue;
      }
      const actionName = destinationName(document, action.get(PDFName.of("D")));
      if (actionName) names.add(actionName);
    }
  }
  return names;
}

function collectNamedDestinations(document: PDFDocument): Map<string, PDFObject> {
  const found = new Map<string, PDFObject>();
  const pageIndexByRef = new Map(
    document
      .getPages()
      .map((page, index) => [page.ref.toString(), index] as const),
  );

  // Match pdf.js' precedence: the name tree is authoritative when both the
  // modern and legacy structures define a name. A conflicting duplicate is
  // rejected below rather than silently changing where the link goes.
  const names = lookupDict(document, document.catalog.get(PDFName.of("Names")));
  const root = lookupDict(document, names?.get(PDFName.of("Dests")));
  if (root) {
    const pending = [root];
    const seen = new Set<PDFDict>();
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      const entries = lookupArray(document, node.get(PDFName.of("Names")));
      if (entries) {
        for (let index = 0; index + 1 < entries.size(); index += 2) {
          const key = destinationName(document, entries.get(index));
          const value = entries.get(index + 1);
          if (key && value) {
            addNamedDestination(
              document,
              found,
              { name: key, value },
              pageIndexByRef,
            );
          }
        }
      }
      const kids = lookupArray(document, node.get(PDFName.of("Kids")));
      if (!kids) continue;
      for (let index = 0; index < kids.size(); index += 1) {
        const kid = lookupDict(document, kids.get(index));
        if (kid) pending.push(kid);
      }
    }
  }

  const legacy = lookupDict(document, document.catalog.get(PDFName.of("Dests")));
  if (legacy) {
    for (const [key, value] of legacy.entries()) {
      addNamedDestination(
        document,
        found,
        { name: key.decodeText(), value },
        pageIndexByRef,
      );
    }
  }
  return found;
}

function addNamedDestination(
  document: PDFDocument,
  destinations: Map<string, PDFObject>,
  candidate: NamedDestination,
  pageIndexByRef: ReadonlyMap<string, number>,
) {
  const existing = destinations.get(candidate.name);
  if (!existing) {
    destinations.set(candidate.name, candidate.value);
    return;
  }
  if (
    destinationSemanticKey(document, existing, pageIndexByRef) !==
    destinationSemanticKey(document, candidate.value, pageIndexByRef)
  ) {
    throw new PdfPageInsertError(
      "navigation",
      `Named destination ${candidate.name} has conflicting definitions.`,
    );
  }
}

function destinationSemanticKey(
  document: PDFDocument,
  raw: PDFObject,
  pageIndexByRef: ReadonlyMap<string, number>,
  seen = new Set<PDFDict>(),
  depth = 0,
): string {
  if (depth > MAX_DESTINATION_DEPTH) {
    throw new PdfPageInsertError(
      "navigation",
      "A duplicate named destination is too deeply nested.",
    );
  }
  const destination = resolveObject(document, raw);
  if (destination instanceof PDFDict) {
    if (seen.has(destination)) {
      throw new PdfPageInsertError(
        "navigation",
        "A duplicate named destination contains a cycle.",
      );
    }
    seen.add(destination);
    const nested = destination.get(PDFName.of("D"));
    if (!nested) {
      throw new PdfPageInsertError(
        "navigation",
        "A duplicate named destination dictionary has no /D target.",
      );
    }
    return destinationSemanticKey(
      document,
      nested,
      pageIndexByRef,
      seen,
      depth + 1,
    );
  }
  if (!(destination instanceof PDFArray) || destination.size() === 0) {
    throw new PdfPageInsertError(
      "navigation",
      "A duplicate named destination has an unsupported shape.",
    );
  }

  const target = destination.get(0);
  let targetPage =
    target instanceof PDFRef ? pageIndexByRef.get(target.toString()) : undefined;
  if (targetPage === undefined) {
    const resolvedTarget = resolveObject(document, target);
    if (resolvedTarget instanceof PDFNumber) {
      const index = resolvedTarget.asNumber();
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < document.getPageCount()
      ) {
        targetPage = index;
      }
    }
  }
  if (targetPage === undefined) {
    throw new PdfPageInsertError(
      "navigation",
      "A duplicate named destination does not point to a page in this PDF.",
    );
  }

  const values: (string | number | null)[][] = [["page", targetPage]];
  for (let index = 1; index < destination.size(); index += 1) {
    const value = resolveObject(document, destination.get(index));
    if (value instanceof PDFNumber) {
      values.push(["number", value.asNumber()]);
    } else if (value instanceof PDFName) {
      values.push(["name", value.decodeText()]);
    } else if (value instanceof PDFString || value instanceof PDFHexString) {
      values.push(["string", value.decodeText()]);
    } else if (value === PDFNull) {
      values.push(["null", null]);
    } else {
      throw new PdfPageInsertError(
        "navigation",
        "A duplicate named destination contains an unsupported value.",
      );
    }
  }
  return JSON.stringify(values);
}

function cloneDestination(
  source: PDFDocument,
  destination: PDFDocument,
  raw: PDFObject,
  pageRefMap: ReadonlyMap<string, PDFRef>,
  seen = new Set<PDFDict>(),
  depth = 0,
): PDFObject {
  if (depth > MAX_DESTINATION_DEPTH) {
    throw new PdfPageInsertError(
      "navigation",
      "A named destination is too deeply nested.",
    );
  }
  const value = resolveObject(source, raw);
  if (value instanceof PDFDict) {
    if (seen.has(value)) {
      throw new PdfPageInsertError(
        "navigation",
        "A named destination contains a cycle.",
      );
    }
    seen.add(value);
    const nested = value.get(PDFName.of("D"));
    if (!nested) {
      throw new PdfPageInsertError(
        "navigation",
        "A named destination dictionary has no /D target.",
      );
    }
    const cloned = PDFDict.withContext(destination.context);
    cloned.set(
      PDFName.of("D"),
      cloneDestination(
        source,
        destination,
        nested,
        pageRefMap,
        seen,
        depth + 1,
      ),
    );
    return cloned;
  }
  if (!(value instanceof PDFArray) || value.size() === 0) {
    throw new PdfPageInsertError(
      "navigation",
      "A named destination does not contain a page destination array.",
    );
  }
  const cloned = PDFArray.withContext(destination.context);
  for (let index = 0; index < value.size(); index += 1) {
    const item = value.get(index);
    if (index === 0) {
      const mapped = mappedDestinationPage(source, item, pageRefMap);
      if (!mapped) {
        throw new PdfPageInsertError(
          "navigation",
          "A named destination points outside the inserted page set.",
        );
      }
      cloned.push(mapped);
      continue;
    }
    const resolved = resolveObject(source, item);
    if (
      resolved instanceof PDFNumber ||
      resolved instanceof PDFName ||
      resolved instanceof PDFString ||
      resolved instanceof PDFHexString ||
      resolved === PDFNull
    ) {
      cloned.push(resolved.clone());
      continue;
    }
    throw new PdfPageInsertError(
      "navigation",
      "A named destination contains an unsupported coordinate value.",
    );
  }
  return cloned;
}

function mappedDestinationPage(
  source: PDFDocument,
  raw: PDFObject,
  pageRefMap: ReadonlyMap<string, PDFRef>,
): PDFRef | undefined {
  if (raw instanceof PDFRef) {
    const mapped = pageRefMap.get(raw.toString());
    if (mapped) return mapped;
  }
  const resolved = resolveObject(source, raw);
  if (resolved instanceof PDFNumber) {
    const index = resolved.asNumber();
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= source.getPageCount()
    ) {
      return undefined;
    }
    const page = source.getPage(index);
    return page ? pageRefMap.get(page.ref.toString()) : undefined;
  }
  return undefined;
}

function uniqueDestinationName(
  reservedNames: {
    semantic: ReadonlySet<string>;
    encoded: ReadonlySet<string>;
  },
  incomingName: string,
  originalName: string,
): string {
  const source = asciiDestinationToken(
    incomingName.replace(/\.pdf$/i, ""),
    32,
    "PDF",
  );
  const original = asciiDestinationToken(
    originalName,
    48,
    "destination",
  );
  const base = `Shiori:${source}:${original}`;
  let candidate = base;
  let suffix = 2;
  while (
    reservedNames.semantic.has(candidate) ||
    reservedNames.encoded.has(PDFName.of(candidate).toString())
  ) {
    candidate = `${base}:${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function asciiDestinationToken(
  value: string,
  maxBytes: number,
  fallback: string,
): string {
  const bytes = new TextEncoder().encode(value).slice(0, maxBytes);
  if (bytes.length === 0) return fallback;
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function rewriteNamedLinks(
  document: PDFDocument,
  pageNodes: readonly PDFDict[],
  renamed: ReadonlyMap<string, string>,
) {
  for (const page of pageNodes) {
    const annots = lookupArray(document, page.get(PDFName.of("Annots")));
    if (!annots) continue;
    for (let index = 0; index < annots.size(); index += 1) {
      const annot = lookupDict(document, annots.get(index));
      if (!annot || !isName(document, annot.get(PDFName.of("Subtype")), "Link")) {
        continue;
      }
      const directName = destinationName(document, annot.get(PDFName.of("Dest")));
      if (directName) {
        const next = renamed.get(directName);
        if (!next) {
          throw new PdfPageInsertError(
            "navigation",
            `Unable to remap named destination ${directName}.`,
          );
        }
        annot.set(PDFName.of("Dest"), PDFName.of(next));
      }
      const action = lookupDict(document, annot.get(PDFName.of("A")));
      if (!action || !isName(document, action.get(PDFName.of("S")), "GoTo")) {
        continue;
      }
      const actionName = destinationName(document, action.get(PDFName.of("D")));
      if (!actionName) continue;
      const next = renamed.get(actionName);
      if (!next) {
        throw new PdfPageInsertError(
          "navigation",
          `Unable to remap named destination ${actionName}.`,
        );
      }
      action.set(PDFName.of("D"), PDFName.of(next));
    }
  }
}

function destinationName(
  document: PDFDocument,
  raw: PDFObject | undefined,
): string | undefined {
  const value = resolveObject(document, raw);
  return value instanceof PDFName ||
    value instanceof PDFString ||
    value instanceof PDFHexString
    ? value.decodeText()
    : undefined;
}

function lookupArray(
  document: PDFDocument,
  raw: PDFObject | undefined,
): PDFArray | undefined {
  const value = resolveObject(document, raw);
  return value instanceof PDFArray ? value : undefined;
}

function lookupDict(
  document: PDFDocument,
  raw: PDFObject | undefined,
): PDFDict | undefined {
  const value = resolveObject(document, raw);
  return value instanceof PDFDict ? value : undefined;
}

function resolveObject(
  document: PDFDocument,
  raw: PDFObject | undefined,
): PDFObject | undefined {
  if (!raw || !(raw instanceof PDFRef)) return raw;
  try {
    return document.context.lookup(raw);
  } catch {
    return undefined;
  }
}

function isName(
  document: PDFDocument,
  raw: PDFObject | undefined,
  expected: string,
): boolean {
  const value = resolveObject(document, raw);
  return value instanceof PDFName && value.decodeText() === expected;
}
