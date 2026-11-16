import type {CorpusRow} from './report';

/** Bounded r22 allow-list: retain one retypeset success on this known Form
 * page even after an earlier page consumed the file's first retypeset slot.
 * Page numbers are zero-based, as in the corpus row IDs. No per-row PDF walk
 * or production refusal-code inference is needed. */
const formRetypesetPages=[{id:'arxiv-2611.17052',page:22}];
export function shouldSaveCorpusSample(row:CorpusRow,previous:readonly CorpusRow[]){
 if(row.outcome.mode==='unsupported')return false;
 if(row.kind==='missing-han'||!previous.some(r=>r.id===row.id&&r.outcome.mode===row.outcome.mode))return true;
 return row.outcome.mode==='retypeset'&&formRetypesetPages.some(p=>p.id===row.id&&p.page===row.page)&&
  !previous.some(r=>r.id===row.id&&r.page===row.page&&r.outcome.mode==='retypeset');
}
