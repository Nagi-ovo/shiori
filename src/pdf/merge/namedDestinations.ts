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
import { PdfPageInsertError } from "./insertErrors";
import {
  MAX_DESTINATION_DEPTH,
  destinationName,
  isName,
  lookupArray,
  lookupDict,
  resolveObject,
} from "./pdfObjects";

type NamedDestination = { name: string; value: PDFObject };

export function mergeReferencedNamedDestinations(
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

export function collectNamedDestinations(document: PDFDocument): Map<string, PDFObject> {
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
