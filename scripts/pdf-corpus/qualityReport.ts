import type {CorpusRow} from './report';

/** Optional producer contract at outcome.retypeset.quality. All distances are
 * nonnegative absolute residuals in PDF points, AFTER subtracting the applied
 * push delta from the expected unchanged-line baseline/start-x. These are
 * producer diagnostics, not an independent corpus-wide ink oracle. */
export type RetypesetQualityMetrics={
 maxUnchangedLineStartXDriftPt?:number;
 maxUnchangedLineBaselineDriftPt?:number;
 /** New wrap/overflow ink intersecting OTHER ink that was not pushed. */
 overflowInkOverlap?:boolean;
 overflowInkOverlapAreaPt2?:number;
};
/** Residuals above this count as drift. The writer already verifies every
 * untargeted glyph to DRIFT_BOUND_PT (retypesetVerify), so an accepted row can
 * only show float noise here: the metric is an invariant check, not a defect
 * measurement independent of the writer. */
export const DRIFT_THRESHOLD_PT=.01,DRIFT_BOUND_PT=1e-4;
const nonnegative=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
function coverage(eligibleRows:number,measuredRows:number,count:number,unknownRows=0){
 const availability=measuredRows===0?'unavailable':measuredRows<eligibleRows||unknownRows>0?'partial':'available';
 return {availability,eligibleRows,measuredRows,unavailableRows:eligibleRows-measuredRows,count,
  rate:eligibleRows?count/eligibleRows:0,measuredRate:measuredRows?count/measuredRows:0};
}
const isRetypeset=(row:CorpusRow)=>row.outcome.mode==='retypeset';
const isVertical=(row:CorpusRow)=>row.category==='vertical';
const overflowed=(row:CorpusRow)=>row.outcome.retypeset?.overflowed===true;
/** Overflow/push pressure that a later fit may have removed: rows leave
 * `overflowed` once an envelope or frame fit stays inside the measure. */
const underPressure=(row:CorpusRow)=>overflowed(row)||['fit-envelope','tighten-frame'].includes(row.outcome.retypeset?.fitStrategy??'');
/** Boolean flag or area; contradictory telemetry cannot establish either. */
function overlapFlag(row:CorpusRow){
 const q=row.outcome.retypeset?.quality,area=nonnegative(q?.overflowInkOverlapAreaPt2)?q.overflowInkOverlapAreaPt2:undefined;
 const flag=typeof q?.overflowInkOverlap==='boolean'?q.overflowInkOverlap:area!==undefined?area>0:undefined;
 return flag===undefined||(area!==undefined&&flag!==(area>0))?undefined:{flag,area};
}
function overlapCoverage(rows:readonly CorpusRow[]){
 const measured=rows.flatMap(row=>{const o=overlapFlag(row);return o?[o]:[];});
 return coverage(rows.length,measured.length,measured.filter(o=>o.flag).length);
}
const flagged=(row:CorpusRow)=>isRetypeset(row)&&overlapFlag(row)?.flag===true;
const ratio=(count:number,rows:number)=>({count,rows,rate:rows?count/rows:0});
const editKey=(row:CorpusRow)=>JSON.stringify([row.id,row.page,row.text]);
/** One row per distinct (id, page, text) input; `overflow` and `overflow-2`
 * pick the same phrase on short lines. A distinct edit is flagged if any of
 * its rows is and succeeds only if all of them do. */
function distinctEdits(rows:readonly CorpusRow[]){
 const groups=new Map<string,CorpusRow[]>();
 for(const row of rows)groups.set(editKey(row),[...groups.get(editKey(row))??[],row]);
 const edits=[...groups.values()],count=(test:(row:CorpusRow)=>boolean,every=false)=>edits.filter(g=>every?g.every(test):g.some(test)).length;
 const allFlagged=count(flagged);
 return {rows:rows.length,edits:edits.length,duplicateRows:rows.length-edits.length,
  succeeded:count(row=>row.outcome.mode!=='unsupported',true),
  exactTier:count(row=>!['retypeset','unsupported'].includes(row.outcome.mode),true),
  overflowedRows:count(row=>isRetypeset(row)&&overflowed(row)),overflowedFlagged:count(row=>overflowed(row)&&flagged(row)),
  allFlagged,duplicateFlaggedRows:rows.filter(flagged).length-allFlagged};
}
function nonVerticalOverlap(rows:readonly CorpusRow[]){
 const retypeset=rows.filter(isRetypeset),accepted=rows.filter(row=>row.outcome.mode!=='unsupported');
 const overflowedOverlap=overlapCoverage(retypeset.filter(overflowed)),all=overlapCoverage(retypeset);
 const unmeasuredRows=retypeset.filter(row=>!overlapFlag(row)).length;
 return {headlineRows:rows.length,acceptedRows:accepted.length,retypesetRows:retypeset.length,
  overflowedOverlap,
  fixedCohortOverlap:overlapCoverage(retypeset.filter(underPressure)),
  perHeadlineOverlap:ratio(overflowedOverlap.count,rows.length),
  allFlaggedOverlap:{...all,nonOverflowedFlaggedRows:retypeset.filter(row=>!overflowed(row)&&flagged(row)).length,
   ratePerHeadline:rows.length?all.count/rows.length:0},
  acceptedOverlapFree:{count:accepted.length-all.count-unmeasuredRows,acceptedRows:accepted.length,flaggedRows:all.count,unmeasuredRows},
  distinct:distinctEdits(rows)};
}

/** Caller supplies headline rows. Missing values stay distinguishable from
 * measured zeros; rate uses all eligible rows, measuredRate only covered rows. */
export function summarizeQuality(rows:readonly CorpusRow[]){
 const retypeset=rows.filter(isRetypeset);
 const drift=retypeset.flatMap(row=>{
  const q=row.outcome.retypeset?.quality;
  return nonnegative(q?.maxUnchangedLineStartXDriftPt)&&nonnegative(q?.maxUnchangedLineBaselineDriftPt)?
   [Math.max(q.maxUnchangedLineStartXDriftPt,q.maxUnchangedLineBaselineDriftPt)]:[];
 }).sort((a,b)=>a-b);
 const overflow=retypeset.filter(overflowed);
 const unknownOverflowRows=retypeset.filter(row=>typeof row.outcome.retypeset?.overflowed!=='boolean').length;
 const overlap=overflow.flatMap(row=>{const o=overlapFlag(row);return o?[o]:[];});
 const areas=overlap.flatMap(q=>q.area===undefined?[]:[q.area]);
 const vertical=rows.filter(isVertical);
 return {scope:'headline' as const,retypesetRows:retypeset.length,
  note:'Optional producer diagnostics; missing/invalid fields are unavailable, not measured zero defects. Rates use eligible rows; measuredRate uses measured rows. No corpus-wide independent quality oracle is claimed.',
  unchangedLineDrift:{...coverage(retypeset.length,drift.length,drift.filter(d=>d>DRIFT_THRESHOLD_PT).length),thresholdPt:DRIFT_THRESHOLD_PT,boundPt:DRIFT_BOUND_PT,
   positiveRows:drift.filter(d=>d>0).length,maxPt:drift.at(-1)??0,p95Pt:drift[Math.ceil(.95*drift.length)-1]??0},
  /** Legacy: overflowed rows only, vertical pooled in. Kept for continuity. */
  overflowInkOverlap:{legacy:true as const,...coverage(overflow.length,overlap.length,overlap.filter(q=>q.flag).length,unknownOverflowRows),unknownOverflowRows,
   areaMeasuredRows:areas.length,totalAreaPt2:areas.reduce((a,b)=>a+b,0),maxAreaPt2:areas.reduce((a,b)=>Math.max(a,b),0)},
  nonVertical:nonVerticalOverlap(rows.filter(row=>!isVertical(row))),
  /** Vertical writers refuse on collision and stamp overflowInkOverlap:false,
   * so no vertical overlap is measured; producer flags are listed only. */
  vertical:{measured:false as const,note:'not measured; refuse-on-collision',headlineRows:vertical.length,
   retypesetRows:vertical.filter(isRetypeset).length,producerFlaggedRows:vertical.filter(flagged).length},
 };
}

const pct=(rate:number)=>`${(rate*100).toFixed(1)}%`;
export function qualityMarkdown(quality:ReturnType<typeof summarizeQuality>){
 const drift=quality.unchangedLineDrift,overlap=quality.overflowInkOverlap,nv=quality.nonVertical,d=nv.distinct,v=quality.vertical;
 const metric=(label:string,q:typeof drift|typeof overlap)=>`| ${label} | ${q.availability} | ${q.measuredRows}/${q.eligibleRows} | ${q.count} | ${pct(q.rate)} |`;
 const line=(label:string,count:number,rows:number)=>`| ${label} | ${count}/${rows} | ${pct(rows?count/rows:0)} |`;
 return ['\n## Retypeset quality (headline rows)',
  `\n${quality.note}`,
  '\n| Metric | Availability | Measured / eligible | Defect rows | Rate / eligible |','|---|---|---:|---:|---:|',
  metric(`Unchanged-line drift > ${drift.thresholdPt} pt (writer-invariant residual, bounded by retypesetVerify ${drift.boundPt} pt)`,drift),
  metric('Legacy pooled overflow overlap (all headline rows, vertical included)',overlap),
  `\nUnchanged-line residual drift: max ${drift.maxPt} pt; nearest-rank p95 ${drift.p95Pt} pt; ${drift.positiveRows} rows > 0 pt (float noise below the threshold). The writer refuses any untargeted glyph moved by more than ${drift.boundPt} pt, so this is an invariant check, not independent evidence. Overflow state unavailable on ${overlap.unknownOverflowRows} retypeset rows. Overlap area supplied on ${overlap.areaMeasuredRows} rows: total ${overlap.totalAreaPt2} pt², max ${overlap.maxAreaPt2} pt².`,
  '\n### Overflow ink overlap, non-vertical',
  `\nNon-vertical headline rows: ${nv.headlineRows}; accepted ${nv.acceptedRows}; retypeset ${nv.retypesetRows}. Flags are the producer's \`overflowInkOverlap\`; the horizontal writer installs the stream whatever the flag says, so flagged rows still count as accepted.`,
  '\n| Measure | Flagged / rows | Rate |','|---|---:|---:|',
  line('Non-vertical: overlap / overflowed rows (legacy definition)',nv.overflowedOverlap.count,nv.overflowedOverlap.eligibleRows),
  line('Non-vertical: overlap / fixed pressure cohort (overflowed or fit-envelope or tighten-frame)',nv.fixedCohortOverlap.count,nv.fixedCohortOverlap.eligibleRows),
  line('Non-vertical: overflowed-row overlap / all headline rows',nv.perHeadlineOverlap.count,nv.perHeadlineOverlap.rows),
  line('Non-vertical: any flagged overlap / retypeset rows',nv.allFlaggedOverlap.count,nv.allFlaggedOverlap.eligibleRows),
  line('Non-vertical: any flagged overlap / all headline rows',nv.allFlaggedOverlap.count,nv.headlineRows),
  line('Non-vertical: accepted and overlap-free / all headline rows',nv.acceptedOverlapFree.count,nv.headlineRows),
  `\nAny flagged overlap includes ${nv.allFlaggedOverlap.nonOverflowedFlaggedRows} rows that never overflowed. Overlap flag unavailable on ${nv.acceptedOverlapFree.unmeasuredRows} retypeset rows (excluded from overlap-free). The fixed cohort still depends on mode routing: an exact-tier gain removes rows from it. The per-headline rates are routing-invariant.`,
  '\n### Distinct edits, non-vertical',
  `\nRows with the same (file, page, text) count once; \`overflow\` and \`overflow-2\` pick the same phrase on short lines. Rows ${d.rows}; distinct edits ${d.edits}; duplicate rows ${d.duplicateRows}; flagged rows counted twice ${d.duplicateFlaggedRows}.`,
  '\n| Measure | Count / distinct edits | Rate |','|---|---:|---:|',
  line('Succeeded without overlay',d.succeeded,d.edits),line('Exact tier',d.exactTier,d.edits),
  line('Overlap / overflowed (legacy definition)',d.overflowedFlagged,d.overflowedRows),line('Any flagged overlap',d.allFlagged,d.edits),
  '\n### Vertical overlap',
  `\nVertical: ${v.note}. The vertical writers refuse on collision and always stamp \`overflowInkOverlap:false\`, so a vertical rate would not be a measurement of the same defect; vertical rows stay out of the non-vertical rates above. ${v.headlineRows} headline rows, ${v.retypesetRows} retypeset; ${v.producerFlaggedRows} carry a flag, which only the horizontal retypeset path can set (horizontally extracted text on a vertical-category page). Listed for continuity only.`];
}
