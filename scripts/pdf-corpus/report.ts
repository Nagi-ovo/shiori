import type {ContentTextOutcome} from '../../src/pdf/export/contentText/outcomes';
type CorpusOutcome=ContentTextOutcome;
export type CorpusRow={id:string;category:string;page:number;kind:string;original:string;text:string;ms:number;outcome:CorpusOutcome;error?:string;oracle?:unknown;fallbackFonts?:string[]};
export function summarize(rows:readonly CorpusRow[]){
 const counts={'in-place':0,'fallback-font':0,substituted:0,reflowed:0,retypeset:0,unsupported:0},reasons:Record<string,number>={};let ms=0;
 for(const r of rows){counts[r.outcome.mode]++;ms+=r.ms;if(r.outcome.reason)reasons[r.outcome.reason]=(reasons[r.outcome.reason]??0)+1;}
 const exactTier=counts['in-place']+counts['fallback-font']+counts.substituted+counts.reflowed,succeededWithoutOverlay=exactTier+counts.retypeset;
 const succeededWithoutOverlayRate=rows.length?succeededWithoutOverlay/rows.length:0,exactTierRate=rows.length?exactTier/rows.length:0;
 return {edits:rows.length,...counts,succeededWithoutOverlay,succeededWithoutOverlayRate,exactTier,exactTierRate,
  acceptedRate:succeededWithoutOverlayRate,refusalRate:rows.length?counts.unsupported/rows.length:0,ms,reasons:Object.fromEntries(Object.entries(reasons).sort((a,b)=>b[1]-a[1]))};
}
export function isHeadlineKind(kind:string){return kind!=='overflow-unbreakable';}
export function summarizeReport(rows:readonly CorpusRow[]){
 return {
  summary:summarize(rows),
  headline:summarize(rows.filter(r=>isHeadlineKind(r.kind))),
  unbreakableOverflow:summarize(rows.filter(r=>r.kind==='overflow-unbreakable')),
  // The legacy overflow construction now occupies the unbreakable slot.
  oldDefinition:summarize(rows.filter(r=>r.kind!=='overflow'&&r.kind!=='overflow-2')),
 };
}
function summaryRow(label:string,s:ReturnType<typeof summarize>){
 return `| ${label} | ${s.edits} | ${s['in-place']} | ${s['fallback-font']} | ${s.substituted} | ${s.reflowed} | ${s.retypeset} | ${s.unsupported} | ${percent(s.succeededWithoutOverlayRate)} | ${percent(s.exactTierRate)} |`;
}
const percent=(rate:number)=>`${(100*rate).toFixed(1)}%`;
const table=(label:string)=>[`\n| ${label} | Edits | In place | Fallback font | Substituted | Reflowed | Retypeset | Unsupported | Succeeded without overlay | Exact-tier rate |`,'|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
export function markdownReport(report:{rows:CorpusRow[];files:number;elapsedMs:number;skips:unknown[];oracle:unknown[];categories?:string[]}){
 const rows=report.rows.filter(r=>isHeadlineKind(r.kind));
 const {headline:overall,unbreakableOverflow,oldDefinition}=summarizeReport(report.rows);
 const categories=[...new Set(report.categories??rows.map(r=>r.category))].sort();
 const oraclePassed=report.oracle.filter(o=>o!==null&&typeof o==='object'&&'passed' in o&&o.passed===true).length;
 return ['# Real PDF editing corpus',`\nFiles: ${report.files}. Edits: ${overall.edits}. Wall time: ${(report.elapsedMs/1000).toFixed(1)} s.`,
 '\n| Succeeded without overlay | Exact-tier rate | Old-definition exact-tier rate |','|---:|---:|---:|',
 `| ${percent(overall.succeededWithoutOverlayRate)} (${overall.succeededWithoutOverlay}/${overall.edits}) | ${percent(overall.exactTierRate)} (${overall.exactTier}/${overall.edits}) | ${percent(oldDefinition.exactTierRate)} (${oldDefinition.exactTier}/${oldDefinition.edits}) |`,
 '\nHeadline counts and rates exclude only `overflow-unbreakable`. Succeeded without overlay counts in-place + fallback-font + substituted + reflowed + retypeset. Exact-tier counts only the first four modes (r19 headline: 43.5%). Unsupported remains in the denominator.',
 ...table('Category'),
 ...[...categories,'overall'].map(c=>summaryRow(c,c==='overall'?overall:summarize(rows.filter(r=>r.category===c)))),
 `\nMean export time: ${(overall.ms/Math.max(1,overall.edits)).toFixed(1)} ms per edit.`,
 '\n## Refusal reasons',...Object.entries(overall.reasons).map(([r,n])=>`- ${r}: ${n}`),
 `\nSampling/skip records: ${report.skips.length}. Official saved-sample oracle: ${oraclePassed}/${report.oracle.length} passed. No per-row corpus-wide raster oracle is inferred from these samples; outcome rates above are reported separately.`,
 '\n## Simplified Chinese',
 ...table('File'),
 ...[...new Set(rows.filter(r=>r.category==='chinese').map(r=>r.id))].sort().map(id=>summaryRow(id,summarize(rows.filter(r=>r.id===id)))),
 `\nMissing-Han cases: ${rows.filter(r=>r.kind==='missing-han').length}; accepted with Noto Sans SC: ${rows.filter(r=>r.kind==='missing-han' && r.outcome.mode==='fallback-font' && r.fallbackFonts?.includes('NotoSansSC-Regular.otf')).length}.`,
 '\n## Unbreakable overflow stress case',
 '\nThese rows retain the legacy first-word repeat and are excluded from the headline.',
 ...table('Kind'),
 summaryRow('overflow-unbreakable',unbreakableOverflow),
 '\n## Old-definition comparison',
 '\nAll kinds except realistic `overflow` and `overflow-2`, including `overflow-unbreakable` in the old overflow slot. Compare the exact-tier rate with r19 / r18: 48.6% (645/1328).',
 ...table('Definition'),
 summaryRow('old-definition',oldDefinition),
 '\nSee report.json for every input, outcome, timing and native evidence. Rerun: `bun scripts/pdf-corpus/run.ts`. Licence/geometry limitations are in scripts/pdf-corpus/README.md.',''].join('\n');
}
