// Object-graph helpers shared by the export passes that rebuild catalog
// structures in a fresh document: a page-aware deep clone (cloneObject), the
// cache seeding that lets it reuse objects copyPages already copied, and the
// tolerant lookups every pass narrows untrusted PDF values with.
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from "pdf-lib";

export type CloneState = {
  clonedObjects: Map<PDFObject, PDFObject>;
  clonedRefs: Map<string, PDFRef>;
  sourcePageRefTags: Set<string>;
  pageRefMap: Map<string, PDFRef>;
};

export function createCloneState(
  source: PDFDocument,
  pageRefMap: Map<string, PDFRef>,
): CloneState {
  return {
    clonedObjects: new Map(),
    clonedRefs: new Map(),
    sourcePageRefTags: new Set(
      source.getPages().map((page) => page.ref.toString()),
    ),
    pageRefMap,
  };
}

export function copyCatalogEntry(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
  key: string,
): boolean {
  const name = PDFName.of(key);
  const original = source.catalog.get(name);
  const cloned = cloneObject(source, dest, state, original);
  if (!cloned) return false;
  dest.catalog.set(name, cloned);
  return true;
}

export function seedObjectMapping(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
  sourceValue: PDFObject | undefined,
  destValue: PDFObject | undefined,
) {
  const seen = new Set<PDFObject>();
  const seed = (
    nextSource: PDFObject | undefined,
    nextDest: PDFObject | undefined,
  ) => {
    if (!nextSource || !nextDest) return;
    if (nextSource instanceof PDFRef && nextDest instanceof PDFRef) {
      if (!state.clonedRefs.has(nextSource.toString())) {
        state.clonedRefs.set(nextSource.toString(), nextDest);
      }
    }
    const sourceObject = resolveObject(source, nextSource);
    const destObject = resolveObject(dest, nextDest);
    if (!sourceObject || !destObject) return;

    const sameContainerType =
      (sourceObject instanceof PDFStream && destObject instanceof PDFStream) ||
      (sourceObject instanceof PDFDict && destObject instanceof PDFDict) ||
      (sourceObject instanceof PDFArray && destObject instanceof PDFArray);
    if (!sameContainerType) return;
    const existing = state.clonedObjects.get(sourceObject);
    if (existing && existing !== destObject) return;
    if (!existing) state.clonedObjects.set(sourceObject, destObject);
    if (seen.has(sourceObject)) return;
    seen.add(sourceObject);

    if (sourceObject instanceof PDFStream && destObject instanceof PDFStream) {
      seed(sourceObject.dict, destObject.dict);
      return;
    }
    if (sourceObject instanceof PDFDict && destObject instanceof PDFDict) {
      for (const [key, value] of sourceObject.entries()) {
        seed(value, destObject.get(key));
      }
      return;
    }
    if (sourceObject instanceof PDFArray && destObject instanceof PDFArray) {
      const count = Math.min(sourceObject.size(), destObject.size());
      for (let i = 0; i < count; i += 1) {
        seed(sourceObject.get(i), destObject.get(i));
      }
    }
  };
  seed(sourceValue, destValue);
}

export function asArray(
  doc: PDFDocument,
  value: PDFObject | undefined,
): PDFArray | undefined {
  if (!value) return undefined;
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return resolved instanceof PDFArray ? resolved : undefined;
}

export function lookupDict(
  doc: PDFDocument,
  value: PDFObject | undefined,
): PDFDict | undefined {
  const resolved = resolveObject(doc, value);
  return resolved instanceof PDFDict ? resolved : undefined;
}

export function resolveObject(
  doc: PDFDocument,
  value: PDFObject | undefined,
): PDFObject | undefined {
  if (!value) return undefined;
  if (!(value instanceof PDFRef)) return value;
  try {
    return doc.context.lookup(value);
  } catch {
    return undefined;
  }
}

export function isName(
  doc: PDFDocument,
  value: PDFObject | undefined,
  expected: string,
): boolean {
  const resolved = resolveObject(doc, value);
  return resolved instanceof PDFName && resolved.decodeText() === expected;
}

export function cloneObject(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
  object: PDFObject | undefined,
): PDFObject | undefined {
  if (!object) return undefined;
  if (object instanceof PDFRef) {
    return cloneRef(source, dest, state, object);
  }
  if (object instanceof PDFDict) {
    const cached = state.clonedObjects.get(object);
    if (cached) return cached;
    const cloned = PDFDict.withContext(dest.context);
    state.clonedObjects.set(object, cloned);
    for (const [key, value] of object.entries()) {
      const next = cloneObject(source, dest, state, value);
      if (next) cloned.set(key, next);
    }
    return cloned;
  }
  if (object instanceof PDFArray) {
    const cached = state.clonedObjects.get(object);
    if (cached) return cached;
    const cloned = PDFArray.withContext(dest.context);
    state.clonedObjects.set(object, cloned);
    for (let i = 0; i < object.size(); i++) {
      const next = cloneObject(source, dest, state, object.get(i));
      cloned.push(next ?? dest.context.obj(null));
    }
    return cloned;
  }
  if (object instanceof PDFStream) {
    const cached = state.clonedObjects.get(object);
    if (cached) return cached;
    const clonedDict = PDFDict.withContext(dest.context);
    const cloned = PDFRawStream.of(clonedDict, new Uint8Array(object.getContents()));
    state.clonedObjects.set(object, cloned);
    for (const [key, value] of object.dict.entries()) {
      const next = cloneObject(source, dest, state, value);
      if (next) clonedDict.set(key, next);
    }
    return cloned;
  }
  return object.clone();
}

function cloneRef(
  source: PDFDocument,
  dest: PDFDocument,
  state: CloneState,
  ref: PDFRef,
): PDFObject {
  const tag = ref.toString();
  const mappedPageRef = state.pageRefMap.get(tag);
  if (mappedPageRef) return mappedPageRef;
  if (state.sourcePageRefTags.has(tag)) return dest.context.obj(null);
  const cached = state.clonedRefs.get(tag);
  if (cached) return cached;
  const dereferenced = source.context.lookup(ref);
  if (!dereferenced) return dest.context.obj(null);
  // A page object outside the source page tree (a stray copy left by some
  // earlier writer) is not a page of this export either.
  if (dereferenced instanceof PDFDict && isPageNode(dereferenced)) {
    return dest.context.obj(null);
  }
  const clonedRef = dest.context.nextRef();
  state.clonedRefs.set(tag, clonedRef);
  const clonedObject = cloneObject(source, dest, state, dereferenced);
  if (!clonedObject) return dest.context.obj(null);
  dest.context.assign(clonedRef, clonedObject);
  return clonedRef;
}

function isPageNode(dict: PDFDict): boolean {
  const type = dict.get(PDFName.of("Type"));
  return type === PDFName.of("Page") || type === PDFName.of("Pages");
}
