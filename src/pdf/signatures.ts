import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
} from "pdf-lib";

/**
 * Return why rebuilding this document would invalidate or misrepresent a
 * digital signature. Malformed signature structures also fail closed: export
 * must never turn an uninspectable signed file into an apparently valid one.
 */
export function pdfSignatureIssue(document: PDFDocument): string | null {
  if (document.catalog.get(PDFName.of("Perms"))) {
    return "The PDF has a certification or usage-rights signature.";
  }
  const rawAcroForm = document.catalog.get(PDFName.of("AcroForm"));
  if (!rawAcroForm) return null;
  const acroForm = lookupDict(document, rawAcroForm);
  if (!acroForm) {
    return "The PDF has an AcroForm that cannot be inspected safely.";
  }
  const rawSigFlags = acroForm.get(PDFName.of("SigFlags"));
  const sigFlags = resolveObject(document, rawSigFlags);
  if (rawSigFlags && !(sigFlags instanceof PDFNumber)) {
    return "The PDF has invalid signature flags.";
  }
  if (sigFlags instanceof PDFNumber && sigFlags.asNumber() !== 0) {
    return "The PDF declares signature fields.";
  }
  const rawFields = acroForm.get(PDFName.of("Fields"));
  if (!rawFields) return null;
  const fields = lookupArray(document, rawFields);
  if (!fields) {
    return "The PDF has an invalid signature field tree.";
  }

  const pending: PDFObject[] = [];
  for (let index = 0; index < fields.size(); index += 1) {
    const raw = fields.get(index);
    if (raw) pending.push(raw);
  }
  const seen = new Set<PDFDict>();
  while (pending.length > 0) {
    const raw = pending.pop()!;
    const field = lookupDict(document, raw);
    if (!field || seen.has(field)) {
      return "The PDF has an invalid or cyclic signature field tree.";
    }
    seen.add(field);
    const ownType = resolveObject(document, field.get(PDFName.of("FT")));
    if (
      (ownType instanceof PDFName && ownType.decodeText() === "Sig") ||
      isSignatureValue(document, field.get(PDFName.of("V")))
    ) {
      return "The PDF contains a signature field.";
    }
    const rawKids = field.get(PDFName.of("Kids"));
    if (!rawKids) continue;
    const kids = lookupArray(document, rawKids);
    if (!kids) {
      return "The PDF has an invalid signature field tree.";
    }
    for (let index = 0; index < kids.size(); index += 1) {
      const child = kids.get(index);
      if (child) pending.push(child);
    }
  }
  return null;
}

function isSignatureValue(
  document: PDFDocument,
  raw: PDFObject | undefined,
): boolean {
  if (!raw) return false;
  const value = lookupDict(document, raw);
  if (!value) return false;
  const type = resolveObject(document, value.get(PDFName.of("Type")));
  return Boolean(
    (type instanceof PDFName && type.decodeText() === "Sig") ||
      value.get(PDFName.of("ByteRange")) ||
      value.get(PDFName.of("Contents")),
  );
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
