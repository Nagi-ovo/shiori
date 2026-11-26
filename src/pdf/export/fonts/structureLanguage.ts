import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString, hasUtf16BOM, pdfDocEncodingDecode, utf16Decode,
  type PDFObject, type PDFPage, type PDFStream,
} from 'pdf-lib';

const name = PDFName.of;
export function dict(value: PDFObject | undefined): PDFDict | undefined {
  return value instanceof PDFDict ? value : undefined;
}
export function number(value: PDFObject | undefined): number | undefined {
  return value instanceof PDFNumber ? value.asNumber() : undefined;
}
export function decodePdfText(bytes: Uint8Array): string | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(bytes).trim() || undefined;
  return (hasUtf16BOM(bytes) ? utf16Decode(bytes) : pdfDocEncodingDecode(bytes)).trim() || undefined;
}
export function text(value: PDFObject | undefined): string | undefined {
  if (value instanceof PDFName) return value.decodeText().trim() || undefined;
  if (value instanceof PDFString || value instanceof PDFHexString) return decodePdfText(value.asBytes());
}

function parentTreeEntry(root: PDFDict | undefined, key: number | undefined): PDFArray | undefined {
  const tree = dict(root?.lookup(name('ParentTree')));
  if (!tree || key === undefined) return;
  const pending = [tree], seen = new Set<PDFDict>();
  while (pending.length) {
    const node = pending.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    const limits = node.lookup(name('Limits'));
    if (limits instanceof PDFArray) {
      const first = number(limits.lookup(0)), last = number(limits.lookup(1));
      if (first !== undefined && last !== undefined && (key < first || key > last)) continue;
    }
    const nums = node.lookup(name('Nums'));
    if (nums instanceof PDFArray) {
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        if (number(nums.lookup(i)) !== key) continue;
        const entry = nums.lookup(i + 1);
        return entry instanceof PDFArray ? entry : undefined;
      }
    }
    const kids = node.lookup(name('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) {
      const child = dict(kids.lookup(i));
      if (child) pending.push(child);
    }
  }
}

function ancestorLanguage(root: PDFDict | undefined, element: PDFDict | undefined): string | undefined {
  const seen = new Set<PDFDict>();
  while (element && element !== root && !seen.has(element)) {
    const lang = text(element.lookup(name('Lang')));
    if (lang) return lang;
    seen.add(element);
    element = dict(element.lookup(name('P')));
  }
}

/** Index /K when the parent number tree is absent or incomplete. A bare
 * integer belongs to page content, while an MCR can name a separate stream. */
function childLanguages(root: PDFDict, page: PDFPage, form?: PDFStream): Map<number, string> {
  type Child = { value: PDFObject | undefined; ownerPage?: PDFObject; lang?: string };
  const pending: Child[] = [{ value: root.lookup(name('K')) }];
  const found = new Map<number, string>(), seen = new Set<PDFObject>();
  while (pending.length) {
    const { value, ownerPage, lang } = pending.pop()!;
    if (value instanceof PDFNumber) {
      const id = value.asNumber();
      if (lang && !form && ownerPage === page.node && !found.has(id)) found.set(id, lang);
      continue;
    }
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof PDFArray) {
      for (let i = value.size() - 1; i >= 0; i--) pending.push({ value: value.lookup(i), ownerPage, lang });
    } else if (value instanceof PDFDict) {
      const pg = value.lookup(name('Pg')) ?? ownerPage;
      const id = number(value.lookup(name('MCID')));
      if (id !== undefined) {
        const stream = value.lookup(name('Stm'));
        const matches = form ? stream === form && (!pg || pg === page.node) : !value.has(name('Stm')) && pg === page.node;
        if (lang && matches && !found.has(id)) found.set(id, lang);
      } else if (value.has(name('S')) && value.has(name('K'))) {
        pending.push({ value: value.lookup(name('K')), ownerPage: pg, lang: text(value.lookup(name('Lang'))) ?? lang });
      }
    }
  }
  return found;
}

export function structureLanguageReader(page: PDFPage, form?: PDFStream) {
  const root = dict(page.doc.catalog.lookup(name('StructTreeRoot')));
  const owner = form?.dict ?? page.node;
  const parents = parentTreeEntry(root, number(owner.lookup(name('StructParents'))));
  const cache = new Map<number, string | undefined>();
  let children: Map<number, string> | undefined;
  return (mcid: number): string | undefined => {
    if (!Number.isSafeInteger(mcid) || mcid < 0 || !root) return;
    if (!cache.has(mcid)) {
      const element = parents && mcid < parents.size() ? dict(parents.lookup(mcid)) : undefined;
      const lang = ancestorLanguage(root, element) ?? (children ??= childLanguages(root, page, form)).get(mcid);
      cache.set(mcid, lang);
    }
    return cache.get(mcid);
  };
}
