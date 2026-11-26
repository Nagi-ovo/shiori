import type { PDFDocument, PDFPage } from 'pdf-lib';
import { makeContentReader } from './content';
import { bindStructure } from './structureBindings';
import { readStructure } from './structure';
import { checkDocumentParentKeys } from './documentKeys';
import type { SemanticPage } from './types';

/** Inspect an already loaded document. Create a new inspector after mutating
 * the source or candidate; repeated reads within one snapshot reuse parsing. */
export function createSemanticInspector(doc: PDFDocument, options?: { images?: boolean; pages?: readonly PDFPage[] }) {
  const pages = options?.pages ?? doc.getPages();
  const structure = readStructure(doc);
  const readContent = makeContentReader(options?.images);
  const cache = new Map<number, SemanticPage>();
  const inspectPage = (pageIndex: number): SemanticPage | undefined => {
    const page = pages[pageIndex];
    if (!page) return undefined;
    const cached = cache.get(pageIndex);
    if (cached) return cached;
    const result: SemanticPage = {
      tagged: structure.tagged, hasStructureRoot: structure.hasRoot, pageIndex, occurrences: [],
      objects: new Map(), dependencies: [], issues: [...structure.issues],
    };
    readContent(page, result);
    bindStructure(page, result, structure);
    cache.set(pageIndex, result);
    return result;
  };
  let all: SemanticPage[] | undefined;
  return {
    structure,
    inspectPage,
    inspectDocument() {
      if (!all) {
        all = pages.map((_, index) => inspectPage(index)!);
        checkDocumentParentKeys(all);
      }
      return all;
    },
  };
}
