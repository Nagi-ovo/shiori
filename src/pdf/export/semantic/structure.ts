import { PDFArray, PDFBool, PDFDict, PDFNull, PDFRef } from 'pdf-lib';
import type { PDFDocument, PDFObject } from 'pdf-lib';
import { asDict, asIndex, asName, entry, value } from './pdfValues';
import type { SemanticIssue } from './types';

export type Element = {
  dict: PDFDict;
  ref?: string;
  parent?: Element;
  page?: PDFObject;
  issue?: boolean;
};

export type StructureItem = {
  owner: Element;
  page?: PDFObject;
  mcid?: number;
  reference?: PDFDict;
  stream?: PDFObject;
  streamOwner?: PDFObject;
  object?: PDFObject;
  type: 'content' | 'object';
};

export function readStructure(doc: PDFDocument) {
  const root = asDict(value(doc.catalog, 'StructTreeRoot'));
  const markInfo = asDict(value(doc.catalog, 'MarkInfo'));
  const tagged = entry(doc.catalog, 'StructTreeRoot') !== undefined || !!markInfo && value(markInfo, 'Marked') === PDFBool.True;
  const issues: SemanticIssue[] = [];
  const elements = new Map<PDFDict, Element>();
  const items: StructureItem[] = [];
  // The forward /K tree and reverse number tree are independent witnesses.
  // Preserve both when malformed input makes them disagree.
  const active = new Set<PDFObject>();
  const scan = (raw: PDFObject | undefined, parent?: Element, depth = 0): void => {
    if (raw === undefined) return;
    const child = doc.context.lookup(raw);
    if (child === PDFNull) return;
    if (!child) {
      issues.push({ kind: 'structure-entry', reference: raw });
      return;
    }
    if (child === root || active.has(child) || depth >= 128) {
      issues.push({ kind: 'structure-cycle', reference: raw });
      return;
    }
    if (child instanceof PDFArray) {
      active.add(child);
      for (const kid of child.asArray()) scan(kid, parent, depth + 1);
      active.delete(child);
      return;
    }
    const mcid = asIndex(child);
    if (mcid !== undefined && parent) {
      items.push({ owner: parent, page: parent.page, mcid, type: 'content' });
      return;
    }
    if (!(child instanceof PDFDict)) {
      issues.push({ kind: 'structure-entry', reference: raw });
      return;
    }
    const type = asName(value(child, 'Type'));
    if (parent && (type === 'MCR' || type === 'OBJR')) {
      const page = entry(child, 'Pg') ?? parent.page;
      if (type === 'MCR') {
        items.push({ owner: parent, page, type: 'content', reference: child,
          mcid: asIndex(value(child, 'MCID')), stream: entry(child, 'Stm'), streamOwner: entry(child, 'StmOwn') });
      } else {
        items.push({ owner: parent, page, type: 'object', reference: child, object: entry(child, 'Obj') });
      }
      return;
    }

    if (!isElement(child)) {
      issues.push({ kind: 'structure-entry', reference: raw });
      return;
    }
    const earlier = elements.get(child);
    if (earlier) {
      earlier.issue = true;
      issues.push({ kind: 'structure-entry', reference: raw });
      return;
    }
    const declaredParent = value(child, 'P');
    const elem = {
      dict: child, ref: raw instanceof PDFRef ? raw.toString() : undefined,
      parent, page: entry(child, 'Pg') ?? parent?.page, issue: declaredParent !== (parent?.dict ?? root),
    };
    elements.set(child, elem);
    active.add(child);
    scan(entry(child, 'K'), elem, depth + 1);
    active.delete(child);
  };
  if (root) scan(entry(root, 'K'));
  const numberTree = readNumberTree(root && value(root, 'ParentTree'), doc, issues);

  return { tagged, hasRoot: !!root, issues, elements, items, numberTree };
}

export type Structure = ReturnType<typeof readStructure>;

export function isElement(dict: PDFDict): boolean {
  const type = asName(value(dict, 'Type'));
  return type === 'StructElem' || (type === undefined && asName(value(dict, 'S')) !== undefined);
}

function readNumberTree(root: PDFObject | undefined, doc: PDFDocument, issues: SemanticIssue[]) {
  const values = new Map<number, PDFObject>();
  const duplicates = new Set<number>();
  const active = new Set<PDFDict>();
  const seen = new Set<PDFDict>();
  const visit = (node: PDFObject | undefined, depth: number) => {
    if (!(node instanceof PDFDict)) {
      issues.push({ kind: 'number-tree-entry', reference: node });
      return;
    }
    if (active.has(node) || depth >= 128) {
      issues.push({ kind: 'number-tree-cycle', reference: node });
      return;
    }
    if (seen.has(node)) return;
    active.add(node);
    seen.add(node);
    const nums = value(node, 'Nums');
    if (nums instanceof PDFArray) {
      for (let i = 0; i < nums.size(); i += 2) {
        const key = asIndex(doc.context.lookup(nums.get(i)));
        const raw = nums.get(i + 1);
        if (key === undefined || !raw) {
          issues.push({ kind: 'number-tree-entry', parentKey: key, reference: node });
          continue;
        }
        if (values.has(key)) duplicates.add(key);
        else values.set(key, raw);
      }
    } else if (entry(node, 'Nums') !== undefined) issues.push({ kind: 'number-tree-entry', reference: node });
    const kids = value(node, 'Kids');
    if (kids instanceof PDFArray) {
      for (const kid of kids.asArray()) visit(doc.context.lookup(kid), depth + 1);
    } else if (entry(node, 'Kids') !== undefined) issues.push({ kind: 'number-tree-entry', reference: node });
    active.delete(node);
  };
  if (root !== undefined) visit(root, 0);
  return { values, duplicates };
}

export function readStructureEdges(doc: PDFDocument, structure = readStructure(doc)) {
  const objects = new Map<PDFObject, StructureItem[]>();
  const streams = new Map<PDFObject, StructureItem[]>();
  for (const item of structure.items) {
    const add = (map: typeof objects, raw: PDFObject | undefined) => {
      const object = doc.context.lookup(raw);
      if (!object) return;
      const edges = map.get(object);
      if (!edges) map.set(object, [item]);
      else if (edges.at(-1) !== item) edges.push(item);
    };
    if (item.type === 'object') add(objects, item.object);
    else {
      add(streams, item.stream);
      add(streams, item.streamOwner);
    }
  }
  return { objects, streams };
}

export type StructureEdges = ReturnType<typeof readStructureEdges>;
