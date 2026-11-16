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
const nonnegative=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
function coverage(eligibleRows:number,measuredRows:number,count:number,unknownRows=0){
 const availability=measuredRows===0?'unavailable':measuredRows<eligibleRows||unknownRows>0?'partial':'available';
 return {availability,eligibleRows,measuredRows,unavailableRows:eligibleRows-measuredRows,count,
  rate:eligibleRows?count/eligibleRows:0,measuredRate:measuredRows?count/measuredRows:0};
}

/** Caller supplies headline rows. Missing values stay distinguishable from
 * measured zeros; rate uses all eligible rows, measuredRate only covered rows. */
export function summarizeQuality(rows:readonly CorpusRow[]){
 const retypeset=rows.filter(row=>row.outcome.mode==='retypeset');
 const drift=retypeset.flatMap(row=>{
  const q=row.outcome.retypeset?.quality;
  return nonnegative(q?.maxUnchangedLineStartXDriftPt)&&nonnegative(q?.maxUnchangedLineBaselineDriftPt)?
   [Math.max(q.maxUnchangedLineStartXDriftPt,q.maxUnchangedLineBaselineDriftPt)]:[];
 }).sort((a,b)=>a-b);
 const overflow=retypeset.filter(row=>row.outcome.retypeset?.overflowed===true);
 const unknownOverflowRows=retypeset.filter(row=>typeof row.outcome.retypeset?.overflowed!=='boolean').length;
 const overlap=overflow.flatMap(row=>{
  const q=row.outcome.retypeset?.quality,area=nonnegative(q?.overflowInkOverlapAreaPt2)?q.overflowInkOverlapAreaPt2:undefined;
  const flag=typeof q?.overflowInkOverlap==='boolean'?q.overflowInkOverlap:area!==undefined?area>0:undefined;
  // Contradictory telemetry cannot establish either success or a defect.
  return flag===undefined||(area!==undefined&&flag!==(area>0))?[]:[{flag,area}];
 });
 const areas=overlap.flatMap(q=>q.area===undefined?[]:[q.area]);
 return {scope:'headline' as const,retypesetRows:retypeset.length,
  note:'Optional producer diagnostics; missing/invalid fields are unavailable, not measured zero defects. Rates use eligible rows; measuredRate uses measured rows. No corpus-wide independent quality oracle is claimed.',
  unchangedLineDrift:{...coverage(retypeset.length,drift.length,drift.filter(d=>d>0).length),thresholdPt:0,
   maxPt:drift.at(-1)??0,p95Pt:drift[Math.ceil(.95*drift.length)-1]??0},
  overflowInkOverlap:{...coverage(overflow.length,overlap.length,overlap.filter(q=>q.flag).length,unknownOverflowRows),unknownOverflowRows,
   areaMeasuredRows:areas.length,totalAreaPt2:areas.reduce((a,b)=>a+b,0),maxAreaPt2:areas.reduce((a,b)=>Math.max(a,b),0)},
 };
}

export function qualityMarkdown(quality:ReturnType<typeof summarizeQuality>){
 const drift=quality.unchangedLineDrift,overlap=quality.overflowInkOverlap;
 const metric=(label:string,q:typeof drift|typeof overlap)=>`| ${label} | ${q.availability} | ${q.measuredRows}/${q.eligibleRows} | ${q.count} | ${(q.rate*100).toFixed(1)}% |`;
 return ['\n## Retypeset quality (headline rows)',
  `\n${quality.note}`,
  '\n| Metric | Availability | Measured / eligible | Defect rows | Rate / eligible |','|---|---|---:|---:|---:|',
  metric('Unchanged-line drift > 0 pt (push delta excluded)',drift),metric('Overflow ink overlaps unpushed other ink',overlap),
  `\nUnchanged-line residual drift: max ${drift.maxPt} pt; nearest-rank p95 ${drift.p95Pt} pt. Overflow state unavailable on ${overlap.unknownOverflowRows} retypeset rows. Overlap area supplied on ${overlap.areaMeasuredRows} rows: total ${overlap.totalAreaPt2} pt², max ${overlap.maxAreaPt2} pt².`];
}
