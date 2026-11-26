import {
  PDFArray, PDFDict, PDFName, PDFStream, type PDFPage,
} from 'pdf-lib';
import type { ContentOp } from '../contentStreamEdit/tokenizer';
import { sourceFontTraits, type FontRequest } from './fontService';
import { decodePdfText, dict, number, structureLanguageReader, text } from './structureLanguage';

export type SourceFontContext = Pick<FontRequest, 'baseFont' | 'flags' | 'weight' | 'cidOrdering' | 'lang'>;

const name = PDFName.of;
const resourceName = (decoded: string) => name(decoded.replaceAll('#', '#23'));
const sourcePages = new WeakMap<PDFPage, { page: PDFPage; scope?: StreamScope }>();

/** Keep document-level lookup on the original page and object graph while
 * editing a copy. The destination catalog is rebuilt after content edits. */
export function preserveSourceFontPage(copy: PDFPage, source: PDFPage, scope?: StreamScope): void {
  const original = sourcePages.get(source);
  sourcePages.set(copy, { page: original?.page ?? source, scope: scope ?? original?.scope });
}

type StreamScope = {
  /** XObject resource names along the actual Do invocation path from the page. */
  formPath?: readonly string[];
  /** Effective resources when the caller already resolved the stream's scope. */
  resources?: PDFDict;
  /** Language in force at the parent Do of this occurrence. */
  invocationLang?: string;
};

function streamScope(page: PDFPage, path: readonly string[]) {
  let resources = page.node.Resources();
  let form: PDFStream | undefined;
  for (const key of path) {
    const object = dict(resources?.lookup(name('XObject')))?.lookup(resourceName(key));
    if (!(object instanceof PDFStream)) return {};
    form = object;
    resources = dict(form.dict.lookup(name('Resources'))) ?? resources;
  }
  return { resources, form };
}

function fontMetadata(font: PDFDict | undefined): Omit<SourceFontContext, 'lang'> {
  const descendants = font?.lookup(name('DescendantFonts'));
  const descendant = descendants instanceof PDFArray ? dict(descendants.lookup(0)) : undefined;
  const descriptor = dict((descendant ?? font)?.lookup(name('FontDescriptor')));
  const baseFont = text(font?.lookup(name('BaseFont'))) ?? text(descendant?.lookup(name('BaseFont'))) ?? '';
  const hints = [text(descendant?.lookup(name('BaseFont'))),
    text(descriptor?.lookup(name('FontName'))), text(descriptor?.lookup(name('FontFamily')))];
  return {
    baseFont,
    ...sourceFontTraits(baseFont, number(descriptor?.lookup(name('Flags'))) ?? 0, hints),
    weight: number(descriptor?.lookup(name('FontWeight'))),
    cidOrdering: text(dict(descendant?.lookup(name('CIDSystemInfo')))?.lookup(name('Ordering'))),
  };
}

type Mark = { parent?: Mark; lang?: string; mcid?: number };

function markedScopes(ops: readonly ContentOp[], resources?: PDFDict): (Mark | undefined)[] {
  const properties = dict(resources?.lookup(name('Properties')));
  let active: Mark | undefined;
  return ops.map(op => {
    if (op.operator === 'BMC') active = { parent: active };
    if (op.operator === 'BDC') {
      const property = op.operands[1];
      let lang: string | undefined, mcid: number | undefined;
      if (property?.kind === 'name') {
        const entry = dict(properties?.lookup(resourceName(property.value)));
        lang = text(entry?.lookup(name('Lang')));
        mcid = number(entry?.lookup(name('MCID')));
      } else if (property?.kind === 'dict') {
        const language = property.entries.find(entry => entry.key === 'Lang')?.stringBytes;
        lang = language && decodePdfText(language);
        mcid = property.entries.find(entry => entry.key === 'MCID')?.numberValue;
      }
      active = { parent: active, lang, mcid };
    }
    if (op.operator === 'EMC') active = active?.parent;
    return active;
  });
}

/** Read the source font and language of a specific show in the supplied
 * page or Form operation list. Reuse the reader across a stream's edits. */
export function sourceFontReader(page: PDFPage, ops: readonly ContentOp[], scope?: StreamScope) {
  const original = sourcePages.get(page);
  const source = original?.page ?? page;
  scope ??= original?.scope ?? {};
  const path = scope.formPath ?? [];
  const resources = scope.resources ?? streamScope(page, path).resources;
  const originalForm = path.length ? streamScope(source, path).form : undefined;
  const catalogLang = text(source.doc.catalog.lookup(name('Lang')));
  const structure = originalForm || !path.length ? structureLanguageReader(source, originalForm) : undefined;
  const fonts = dict(resources?.lookup(name('Font')));
  const metadata = new Map<string, Omit<SourceFontContext, 'lang'>>();
  const languages = new Map<Mark, string | undefined>();
  const marks = markedScopes(ops, resources);

  const language = (mark: Mark): string | undefined => {
    if (!languages.has(mark)) {
      let lang: string | undefined;
      for (let at: Mark | undefined = mark; at && !lang; at = at.parent) lang = at.lang;
      if (!lang && structure) {
        for (let at: Mark | undefined = mark; at && !lang; at = at.parent) {
          if (at.mcid !== undefined) lang = structure(at.mcid);
        }
      }
      languages.set(mark, lang);
    }
    return languages.get(mark);
  };
  const enclosingLanguage = scope.invocationLang ?? catalogLang;
  const languageAt = (opIndex: number) => {
    const mark = marks[opIndex];
    return (mark && language(mark)) ?? enclosingLanguage;
  };
  const read = (resource: string, opIndex: number): SourceFontContext => {
    if (!metadata.has(resource)) metadata.set(resource, fontMetadata(dict(fonts?.lookup(resourceName(resource)))));
    return { ...metadata.get(resource)!, lang: languageAt(opIndex) };
  };
  return Object.assign(read, { languageAt });
}
