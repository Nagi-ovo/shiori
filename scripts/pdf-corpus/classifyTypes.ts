import type {CorpusRow} from './report';

export type OverflowClassification=Pick<CorpusRow,'id'|'category'|'page'|'kind'>&{
 detail?:string;gate:string;gateDetail?:string;
};
export type EvidenceClassification=OverflowClassification&{
 evidenceGate:string;evidenceBlocker?:string;evidenceDetail?:string;
};
