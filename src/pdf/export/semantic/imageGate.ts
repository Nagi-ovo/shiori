import type { PDFDocument, PDFObject, PDFPage } from 'pdf-lib';
import { isBlankPage, type DocumentModel, type Overlay, type SourceImageEditOverlay } from '../../model/types';
import type { SemanticChange, SemanticDependency, SemanticRefusalReason } from '../semanticGate';
import type { SourceImageLocation } from '../sourceImages';
import type { ImagePlan } from '../sourceImages/compile';
import type { SourceImageOperation } from '../sourceImages/content';
import { copiedSemanticObject, structureWasProjected } from '../structureCopy';
import { omittedStructureBindings } from './verifyEdit';
import { refusedRows, spanDependency } from './editIntent';
import { createSemanticInspector } from './inspection';
import { entry } from './pdfValues';
import { hasStructure, mayHaveMarks } from './probe';
import { readStructureEdges, type StructureEdges, type StructureItem } from './structure';
import type { SemanticOccurrence, SemanticPage, SemanticPaint, SemanticSpan } from './types';

type Decision = { dependencies: SemanticDependency[]; reason?: SemanticRefusalReason };
type Edit = Pick<SourceImageEditOverlay, 'delete' | 'replace'>;
const parentKeys = ['StructParent', 'StructParents'];

function locatePaint(owner: SemanticOccurrence, at: SourceImageOperation, object: PDFObject | undefined): SemanticPaint | undefined {
  if (owner.owner !== at.owner.dictionary) return;
  return owner.paints.find(paint => {
    const op = owner.ops[paint.opIndex]!;
    return op.start === at.start && op.end === at.end &&
      (object ? paint.object === object : op.operator === 'BI');
  });
}

function inspectPaint(
  page: SemanticPage, graph: StructureEdges, location: SourceImageLocation, edit: Edit,
  removals: SourceImageOperation[], escapeFrom: number,
): Decision {
  const dependencies = new Set<SemanticDependency>();
  let unresolved = false;
  let changesReference = false;
  let replacement = false;
  const scopes = new Set<SemanticSpan>();
  let owner = page.occurrences[0]!;
  const clones = new Set<SemanticOccurrence>();
  const splitForms = new Set<SemanticOccurrence>();
  const { forms, paint } = location;
  const object = paint.kind === 'xobject' ? paint.binding.object : undefined;

  // Inspect graph edges by identity, including forward edges the structure
  // inspector could not bind to a span on this page.
  function references(items: StructureItem[] | undefined, kind: 'mcr-stm' | 'objr', stream?: string) {
    for (const item of items ?? []) {
      const bound = page.dependencies.find(binding => binding.reference === item.reference && binding.dependency.kind === kind);
      dependencies.add(bound?.dependency ?? {
        kind, source: 'struct-elem', pageIndex: page.pageIndex, structElem: item.owner.ref,
        ...(kind === 'mcr-stm' && { mcid: item.mcid, stream }),
      });
    }
  }
  const objectBindings = (target: PDFObject, changesObject: boolean) => {
    const record = page.objects.get(target);
    const refs = graph.objects.get(target);
    references(refs, 'objr');
    for (const binding of page.dependencies) {
      if (!record || !binding.objects.includes(record)) continue;
      dependencies.add(binding.dependency);
      replacement ||= !!binding.replacementKey;
    }
    unresolved ||= !!record?.issues.length || (!!refs?.length && !page.dependencies.some(binding =>
      binding.dependency.kind === 'objr' && binding.objects.includes(record!) && refs.some(item => item.reference === binding.reference)));
    changesReference ||= changesObject && !!refs?.length;
  };
  for (const [i, form] of forms.entries()) {
    const child = locatePaint(owner, form, form.binding.object)?.child;
    if (!child) {
      unresolved = true;
      break;
    }
    owner = child;
    clones.add(child);
    if (escapeFrom !== -1 && i >= escapeFrom) splitForms.add(child);
    const refs = graph.streams.get(child.raw!);
    references(refs, 'mcr-stm', child.stream);
    changesReference ||= !!refs?.length;
    objectBindings(child.raw!, true);
    for (const span of child.spans) {
      if (span.mcid !== undefined || span.issues.some(issue => issue.kind !== 'coverage')) {
        scopes.add(span);
      }
    }
    // Cloned Forms cannot keep the original marked-content owner keys.
    if (parentKeys.some(key => entry(child.owner, key) !== undefined)) {
      changesReference = true;
      if (!dependencies.size && !scopes.size) dependencies.add({
        kind: 'mcid', source: 'parent-tree', pageIndex: page.pageIndex, stream: child.stream,
      });
    }
  }
  const selected = locatePaint(owner, paint, object);
  unresolved ||= !selected;
  for (const span of selected?.spans ?? []) scopes.add(span);

  if (object) {
    objectBindings(object, !!(edit.delete || edit.replace));
    if (parentKeys.some(key => entry(object.dict, key) !== undefined) && ![...dependencies].some(dep => dep.kind === 'objr')) {
      dependencies.add({ kind: 'objr', source: 'parent-tree', pageIndex: page.pageIndex, stream: owner.stream });
      unresolved = true;
    }
  }
  // Page-stream copies retain page ownership for ordinary /K integers,
  // but an explicit /Stm refers to a specific physical stream object.
  for (const operation of [forms[0] ?? paint, ...removals]) {
    for (const { part } of operation.parts) {
      const refs = graph.streams.get(part.stream);
      references(refs, 'mcr-stm', operation.owner.dictionary === page.occurrences[0]!.owner ? 'page' : owner.stream);
      changesReference ||= !!refs?.length;
    }
  }
  for (const binding of page.dependencies) {
    const inScope = binding.spans.some(span => scopes.has(span));
    // Splitting a Form replays graphics state and can change the route to
    // child objects. Only split when that whole subtree is free of bindings.
    const splitSubtree = splitForms.size > 0 && [...binding.spans.map(span => span.occurrence),
      ...binding.objects.flatMap(obj => obj.paints.map(p => p.occurrence))].some(occurrence => {
      for (let ancestor: SemanticOccurrence | undefined = occurrence; ancestor; ancestor = ancestor.invocation?.occurrence) {
        if (splitForms.has(ancestor)) return true;
      }
      return false;
    });
    if (!inScope && !splitSubtree) continue;
    dependencies.add(binding.dependency);
    replacement ||= !!binding.replacementKey;
    changesReference ||= splitSubtree || binding.spans.some(span => span.mcid !== undefined && scopes.has(span) && clones.has(span.occurrence));
  }
  for (const span of scopes) {
    if (span.issues.some(issue => issue.kind !== 'coverage') || span.endOp === undefined) {
      unresolved = true;
      if (!page.dependencies.some(binding => binding.spans.includes(span))) dependencies.add(spanDependency(page, span));
    }
  }
  if (unresolved && !dependencies.size) dependencies.add({
    kind: 'mcid', source: 'inline', pageIndex: page.pageIndex, stream: owner.stream,
  });
  const reason = unresolved ? 'semantic-unresolved'
    : edit.replace && replacement ? 'semantic-replacement-text'
    : changesReference || (edit.delete && dependencies.size) ? 'semantic-structure-reference' : undefined;
  return { dependencies: [...dependencies], reason };
}

export function createImageSemanticGate(source: PDFDocument, model: DocumentModel, overlays: Overlay[], sourceGraph?: StructureEdges) {
  const editedPages = new Set(overlays.filter(overlay => overlay.type === 'sourceImageEdit').map(overlay => overlay.pageId));
  if (!editedPages.size) return;
  const pages = source.getPages();
  const tagged = hasStructure(source);
  const indices = model.pages.flatMap(page =>
    !isBlankPage(page) && editedPages.has(page.id) && pages[page.sourceIndex] &&
      (tagged || mayHaveMarks(pages[page.sourceIndex]!)) ? [page.sourceIndex] : []);
  if (!indices.length) return;
  const inspector = createSemanticInspector(source, { images: true });
  if (tagged) inspector.inspectDocument();
  const sourcePages = new Map(indices.map(index => [index, inspector.inspectPage(index)!]));
  const graph = sourceGraph ?? readStructureEdges(source);
  const rows: SemanticChange[] = [];
  let output: { inspector: ReturnType<typeof createSemanticInspector>; graph: StructureEdges } | undefined;
  const record = (id: string, dependencies: SemanticDependency[], reason?: SemanticRefusalReason) => {
    if (reason) rows.push(...refusedRows(id, dependencies, reason));
    else rows.push(...dependencies.map(dependency => ({ overlayId: id, dependency, action: 'preserved' as const })));
  };

  return {
    rows,
    covers: (index: number) => sourcePages.has(index),
    forPage(out: PDFPage, outputIndex: number, sourceIndex: number, textChanged: boolean) {
      const before = sourcePages.get(sourceIndex);
      if (!before) return;
      output ??= { inspector: createSemanticInspector(out.doc, { images: true }), graph: readStructureEdges(out.doc) };
      const current = output.inspector.inspectPage(outputIndex)!;
      const currentGraph = output.graph;
      const omitted = structureWasProjected(out.doc) &&
        omittedStructureBindings(before, current, object => copiedSemanticObject(out.doc, object));
      return {
        refuseUnverified(edit: SourceImageEditOverlay, original: SourceImageLocation) {
          const decision = inspectPaint(before, graph, original, edit, [], -1);
          record(edit.id, decision.dependencies, decision.reason ?? 'semantic-unresolved');
        },
        refuseIndirect(edit: SourceImageEditOverlay, location: SourceImageLocation, owner?: PDFObject) {
          const { paint, forms } = location;
          const targets = [owner, ...forms.map(form => form.binding.object),
            paint.kind === 'xobject' ? paint.binding.object : undefined];
          const dependencies = before.dependencies.filter(binding => binding.objects.some(object => targets.includes(object.object)))
            .map(binding => binding.dependency);
          for (const object of targets) {
            if (!object) continue;
            for (const item of graph.objects.get(object) ?? []) {
              if (dependencies.some(dep => dep.kind === 'objr' && dep.structElem === item.owner.ref)) continue;
              dependencies.push({ kind: 'objr', source: 'struct-elem', pageIndex: sourceIndex, structElem: item.owner.ref });
            }
          }
          const unresolved = targets.some(object => object && before.objects.get(object)?.issues.length);
          record(edit.id, dependencies, unresolved ? 'semantic-unresolved' : 'semantic-structure-reference');
        },
        check(edit: SourceImageEditOverlay, original: SourceImageLocation, plan: ImagePlan) {
          const originalOps = textChanged ? [] : originalClipOperations(original, plan);
          const decision = inspectPaint(before, graph, original, edit, originalOps, plan.escapeFrom);
          const compiled = inspectPaint(current, currentGraph, plan.location, edit, plan.removals, plan.escapeFrom);
          const lostOwner = omitted && [...omitted].some(binding => decision.dependencies.includes(binding.dependency));
          const reason = decision.reason ?? (lostOwner ? 'semantic-structure-reference' : compiled.reason) ??
            (decision.dependencies.length && before.hasStructureRoot && !current.hasStructureRoot
              ? 'semantic-structure-reference' : undefined);
          const dependencies = decision.dependencies.length ? decision.dependencies :
            compiled.dependencies.map(dep => ({ ...dep, pageIndex: sourceIndex }));
          if (reason) record(edit.id, dependencies, reason);
          return {
            reason,
            applied: () => record(edit.id, dependencies),
            refused: () => record(edit.id, dependencies, 'semantic-unresolved'),
          };
        },
      };
    },
  };
}

function originalClipOperations(original: SourceImageLocation, plan: ImagePlan) {
  const owners = [...original.forms, original.paint].map(op => op.owner);
  const compiled = [...plan.location.forms, plan.location.paint].map(op => op.owner);
  return plan.removals.flatMap(removal => {
    const owner = owners[compiled.indexOf(removal.owner)];
    if (!owner) return [];
    return [{ ...removal, owner, parts: removal.parts.flatMap(({ part, start, end }) => {
      const source = owner.parts[part.index];
      return source ? [{ part: source, start, end }] : [];
    }) }];
  });
}

export type ImageSemanticPageGate = NonNullable<ReturnType<NonNullable<ReturnType<typeof createImageSemanticGate>>['forPage']>>;
