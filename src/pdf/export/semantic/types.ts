import type { PDFDict, PDFObject, PDFStream } from 'pdf-lib';
import type { PdfRect } from '../../model/types';
import type { ContentOp } from '../contentStreamEdit/tokenizer';
import type { GlyphPlacement } from '../contentStreamEdit/textState';
import type { SemanticDependency } from '../semanticGate';

export type SemanticIssueKind =
  | 'content-stream' | 'form-cycle' | 'form-limit' | 'xobject' | 'coverage'
  | 'marked-content' | 'property-name' | 'property-value' | 'duplicate-mcid'
  | 'number-tree-cycle' | 'number-tree-entry' | 'structure-cycle' | 'structure-entry'
  | 'parent-key' | 'parent-owner' | 'owner-mismatch' | 'stream-mismatch' | 'object-mismatch';

export type SemanticIssue = {
  kind: SemanticIssueKind;
  occurrence?: SemanticOccurrence;
  opIndex?: number;
  mcid?: number;
  parentKey?: number;
  reference?: PDFObject;
};

export type SemanticSpan = {
  occurrence: SemanticOccurrence;
  beginOp: number;
  part?: PDFStream;
  endOp?: number;
  tag?: string;
  mcid?: number;
  source: 'inline' | 'properties';
  propertyName?: string;
  properties?: PDFDict;
  replacement: ReplacementText[];
  ancestors: readonly SemanticSpan[];
  glyphs: SemanticGlyph[];
  paints: SemanticPaint[];
  bbox?: PdfRect;
  issues: SemanticIssue[];
};

export type ReplacementText = {
  key: 'ActualText' | 'Alt' | 'E';
  kind: 'actual-text' | 'alt' | 'expansion';
  text: string;
};

export type SemanticGlyph = {
  occurrence: SemanticOccurrence;
  placement: GlyphPlacement;
  unicode?: string;
  fontSizePt?: number;
  spans: readonly SemanticSpan[];
};

export type SemanticPaint = {
  occurrence: SemanticOccurrence;
  opIndex: number;
  spans: readonly SemanticSpan[];
  bbox?: PdfRect;
  object?: PDFObject;
  objectRef?: PDFObject;
  child?: SemanticOccurrence;
};

export type SemanticOccurrence = {
  address: string;
  stream?: string;
  raw?: PDFStream;
  owner: PDFDict;
  resources?: PDFDict;
  parts: PDFStream[];
  partStarts: number[];
  bytes?: Uint8Array;
  ops: ContentOp[];
  inheritedSpans: readonly SemanticSpan[];
  spans: SemanticSpan[];
  scopesByOp: (readonly SemanticSpan[])[];
  glyphs: SemanticGlyph[];
  paints: SemanticPaint[];
  issues: SemanticIssue[];
  invocation?: SemanticPaint;
};

export type SemanticObject = {
  object: PDFObject;
  reference?: PDFObject;
  issues: SemanticIssue[];
  paints: SemanticPaint[];
  bbox?: PdfRect;
};

export type SemanticBinding = {
  dependency: SemanticDependency;
  spans: SemanticSpan[];
  objects: SemanticObject[];
  owner?: PDFDict;
  reference?: PDFDict;
  unresolved?: true;
  replacementKey?: ReplacementText['key'];
};

export type SemanticPage = {
  tagged: boolean;
  hasStructureRoot: boolean;
  pageIndex: number;
  occurrences: SemanticOccurrence[];
  dependencies: SemanticBinding[];
  issues: SemanticIssue[];
  objects: Map<PDFObject, SemanticObject>;
};
