import { PDFDocument } from 'pdf-lib';
import { alignPageTreeWithPdfium } from './sourcePageTree';
import { createSemanticInspector } from './semantic/inspection';

export type SemanticDependencyKind = 'mcid' | 'mcr-stm' | 'objr' | 'actual-text' | 'alt' | 'expansion';
export type SemanticDependency = {
  kind: SemanticDependencyKind;
  pageIndex: number;
  mcid?: number;
  stream?: string;
  structElem?: string;
  source: 'inline' | 'properties' | 'struct-elem' | 'parent-tree';
  text?: string;
  bbox?: { x: number; y: number; w: number; h: number };
};

export async function inventorySemantics(bytes: Uint8Array, pageIndex: number): Promise<SemanticDependency[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  alignPageTreeWithPdfium(doc);
  return createSemanticInspector(doc, { images: true }).inspectPage(pageIndex)?.dependencies.map(binding => binding.dependency) ?? [];
}

export type SemanticAction = 'preserved' | 'updated' | 'stripped' | 'refused';
export type SemanticRefusalReason = 'semantic-partial-span' | 'semantic-replacement-text' | 'semantic-structure-reference' | 'semantic-unresolved';
export type SemanticChange = {
  overlayId: string;
  dependency: SemanticDependency;
  action: SemanticAction;
  reason?: SemanticRefusalReason;
};
