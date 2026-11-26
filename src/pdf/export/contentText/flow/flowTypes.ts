import type {PdfRect} from '../../../model/types';
import type {AnchoredAnnotation} from '../../sourceAnnotationAnchors';

export const flowReasons = ['flow-ambiguous-frame','flow-cross-page-unsupported','flow-unsupported-text',
 'flow-destination-obstacle','flow-chain-exhausted','stale-source','semantic-dependency','annotation-anchor'] as const;
export type FlowReason = typeof flowReasons[number];
export type FlowRefusal = { ok: false; reason: FlowReason; detail?: string; anchoredAnnotations?: AnchoredAnnotation[]; blockingRect?: PdfRect; semanticChanges?: import('../../semanticGate').SemanticChange[] };
export type FlowMove = { pageId: string; frameId: string; kind: 'rewrite' | 'spill' | 'push'; beforeRect?: PdfRect; afterRect: PdfRect; glyphCount: number };
/** Change window of one accepted flow edit, reported on its outcome. */
export type FlowManifest = { chainId: string; framesChanged: string[]; pagesChanged: string[]; movedGlyphCount: number };
