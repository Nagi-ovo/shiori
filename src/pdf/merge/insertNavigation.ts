import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { PdfPageInsertError } from "./insertErrors";
import { collectNamedDestinations } from "./namedDestinations";
import {
  MAX_DESTINATION_DEPTH,
  isName,
  lookupArray,
  lookupDict,
  resolveObject,
} from "./pdfObjects";

type DestinationRemapState = {
  mapIndex: (index: number) => number;
  pageRefTags: ReadonlySet<string>;
};

/** Keep the current document's position-based navigation attached to its pages. */
export function shiftBasePositionalStructures(
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

export function remapInsertedNumericLinks(
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

export function assertIncomingLinkDestinations(document: PDFDocument) {
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
