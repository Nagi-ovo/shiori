import {streamReflowEvidence} from '../../src/pdf/export/contentText/reflowEvidence';

/** No classifier-specific geometry, ink or ownership rules. Use the exact
 * production producer, including stroke bounds, backdrop z proof, column
 * witnesses and all unresolved-font obstacles. Never infer a font blocker. */
export function explainEvidence(...args:Parameters<typeof streamReflowEvidence>){
 const result=streamReflowEvidence(...args);
 return result.ok?{gate:'region-proved',detail:result.visualGroup.columnEvidence?
  `column=${JSON.stringify(result.visualGroup.columnEvidence)}`:undefined}:
  {gate:result.gate,blocker:result.blocker,detail:result.detail};
}
