import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, type PDFObject } from "pdf-lib";
import type { PdfRect } from "../../model/types";

const key = PDFName.of;
const textEncoder = new TextEncoder();

export function objectNumbers(value: PDFObject | undefined, size: number): number[] {
  if (!(value instanceof PDFArray) || value.size() !== size) throw Error("unexpected PDF number array");
  return Array.from({ length: size }, (_, i) => {
    const number = value.lookup(i);
    if (!(number instanceof PDFNumber) || !Number.isFinite(number.asNumber())) throw Error("invalid PDF number");
    return number.asNumber();
  });
}

function box(value: PDFObject | undefined): PdfRect | undefined {
  if (value === undefined) return undefined;
  const [x1, y1, x2, y2] = objectNumbers(value, 4) as [number, number, number, number];
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x1 - x2), h: Math.abs(y1 - y2) };
}

export function formBox(form: PDFDict): PdfRect {
  const rect = box(dictionaryValue(form, "BBox"));
  if (!rect?.w || !rect.h || !Number.isFinite(rect.w + rect.h)) throw Error("invalid Form BBox");
  return rect;
}

function pageParents(page: PDFDict): PDFDict[] {
  const parents = new Set<PDFDict>();
  let current = page;
  while (true) {
    if (parents.has(current)) throw Error("cyclic page parent chain");
    parents.add(current);
    const next = dictionaryValue(current, "Parent");
    if (next === undefined) return [...parents];
    if (!(next instanceof PDFDict)) throw Error("invalid page parent");
    current = next;
  }
}

export type SourceImageResources = {
  owner: PDFDict;
  entry?: PDFObject;
  dict?: PDFDict;
};

export function resourceScope(owner: PDFDict): SourceImageResources | undefined {
  const name = resourceKey(owner, "Resources");
  const entry = name && owner.get(name);
  if (!entry) return undefined;
  const dict = owner.context.lookup(entry);
  if (!(dict instanceof PDFDict)) throw Error("unreadable Resources dictionary");
  return { owner, entry, dict };
}

export function pageImageEnvironment(page: PDFDict) {
  const parents = pageParents(page);
  const attribute = (name: string) => {
    for (const parent of parents) {
      const value = dictionaryValue(parent, name);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const mediaBox = box(attribute("MediaBox"));
  const media = mediaBox?.w && mediaBox.h ? mediaBox : { x: 0, y: 0, w: 612, h: 792 };
  const crop = box(attribute("CropBox")) ?? media;
  const x = Math.max(media.x, crop.x);
  const y = Math.max(media.y, crop.y);
  const w = Math.min(media.x + media.w, crop.x + crop.w) - x;
  const h = Math.min(media.y + media.h, crop.y + crop.h) - y;
  const originBox = w > 0 && h > 0 ? { x, y, w, h } : media;
  if (!Object.values(originBox).every(Number.isFinite)) throw Error("invalid page box");

  let resources: SourceImageResources | undefined;
  for (const parent of parents) {
    resources = resourceScope(parent);
    if (resources) break;
  }
  return { pageBox: originBox, resources: resources ?? { owner: page } };
}

export type SourceImageResourceGroup = {
  owner: PDFDict;
  resources: PDFDict;
  entry: PDFObject;
  dict: PDFDict;
};

export function resourceGroup(
  current: SourceImageResources, page: SourceImageResources, name: string,
): SourceImageResourceGroup | undefined {
  const currentKey = current.dict && resourceKey(current.dict, name);
  const scope = currentKey && current.dict?.has(currentKey) ? current : page;
  const resources = scope.dict;
  const groupKey = resources && resourceKey(resources, name);
  const entry = groupKey && resources?.get(groupKey);
  if (!resources || !entry) return undefined;
  const dict = resources.context.lookup(entry);
  if (!(dict instanceof PDFDict)) throw Error(`unreadable /${name} resource group`);
  return { owner: scope.owner, resources, entry, dict };
}

// PDFName.of decodes its argument. Compare byte names as decoded by the
// tokenizer so a literal '#41' embedded in a name is never decoded twice.
const resourceNames = new WeakMap<PDFDict, {
  keys: Map<string, PDFName>;
  ambiguous: Set<string>;
}>();

export function resourceKey(dict: PDFDict, name: string): PDFName | undefined {
  let index = resourceNames.get(dict);
  if (!index) {
    index = { keys: new Map(), ambiguous: new Set() };
    for (const nameKey of dict.keys()) {
      const decoded = nameKey.decodeText();
      index.keys.set(decoded, nameKey);
      // The object parser preserves lowercase hex escapes as literal bytes.
      // When this loses the lexical distinction, either spelling can alias
      // the same parsed key. Refuse to bind through such an ambiguous key.
      const alternate = decoded.replace(/#([\da-fA-F]{2})/g, (match: string, hex: string) =>
        /[a-f]/.test(hex) ? String.fromCharCode(parseInt(hex, 16)) : match);
      if (alternate !== decoded) {
        index.ambiguous.add(decoded);
        index.ambiguous.add(alternate);
      }
    }
    resourceNames.set(dict, index);
  }
  if (index.ambiguous.has(name)) throw Error(`ambiguous encoded resource name /${name}`);
  return index.keys.get(name);
}

export function dictionaryEntry(dict: PDFDict, name: string): PDFObject | undefined {
  const matched = resourceKey(dict, name);
  return matched && dict.get(matched);
}

export function dictionaryValue(dict: PDFDict, name: string): PDFObject | undefined {
  const entry = dictionaryEntry(dict, name);
  const value = dict.context.lookup(entry);
  if (entry && !value) throw Error(`unresolved PDF /${name} entry`);
  return value;
}

export function xObjectImageProperties(dict: PDFDict) {
  const dimension = (name: string) => {
    const value = dict.lookup(key(name));
    if (value instanceof PDFNumber) {
      const n = value.asNumber();
      if (Number.isSafeInteger(n) && n > 0) return n;
    }
    throw Error(`invalid Image XObject /${name}`);
  };
  return {
    widthPx: dimension("Width"),
    heightPx: dimension("Height"),
    masked: ["SMask", "Mask", "ImageMask"].some(name => dict.get(key(name), true) !== undefined),
  };
}

// Canonical dictionary order and dereferenced values keep the fingerprint
// stable across copies that assign new object numbers. Nested streams
// contribute their raw data as well, including an image's referenced mask.
export function fingerprintXObject(image: PDFRawStream): string {
  const hash = sha256.create();
  const frame = (value: Uint8Array) => {
    hash.update(textEncoder.encode(`${value.length}:`)).update(value);
  };
  const token = (value: string) => frame(textEncoder.encode(value));
  const active = new Set<PDFObject>();
  let remaining = 100_000;

  function visit(value: PDFObject | undefined): void {
    if (!value || active.has(value) || active.size >= 128 || --remaining < 0) {
      throw Error("unreadable Image XObject dictionary");
    }
    active.add(value);
    if (value instanceof PDFRawStream) {
      token("stream");
      visit(value.dict);
      frame(value.getContents());
    } else if (value instanceof PDFDict) {
      token("dict");
      const entries = value.entries().sort(([a], [b]) =>
        a.asString() < b.asString() ? -1 : a.asString() > b.asString() ? 1 : 0);
      token(String(entries.length));
      for (const [name, child] of entries) {
        frame(name.asBytes());
        visit(value.context.lookup(child));
      }
    } else if (value instanceof PDFArray) {
      token("array");
      token(String(value.size()));
      for (let i = 0; i < value.size(); i += 1) visit(value.lookup(i));
    } else {
      token("value");
      token(value.toString());
    }
    active.delete(value);
  }

  visit(image);
  return bytesToHex(hash.digest());
}

export function fingerprintInline(dictionary: Uint8Array, data: Uint8Array): string {
  const hash = sha256.create();
  hash.update(textEncoder.encode(`inline:${dictionary.length}:`)).update(dictionary).update(data);
  return bytesToHex(hash.digest());
}
