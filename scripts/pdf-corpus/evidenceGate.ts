import {streamReflowEvidence} from '../../src/pdf/export/contentText/reflowEvidence';

/** No classifier-specific geometry, ink or ownership rules. Use the exact
 * production producer, including its beforeFirst snapshots and CFF obstacles. */
export function explainEvidence(...args:Parameters<typeof streamReflowEvidence>){
 const result=streamReflowEvidence(...args);
 return result.ok?{gate:'region-proved'}:{gate:result.gate,blocker:result.blocker,detail:result.detail};
}
