import type {ContentTextOutcome} from '../../src/pdf/export/contentText/outcomes';
// Keep report readers compatible while the sibling compiler adds these modes.
type CorpusOutcome=Omit<ContentTextOutcome,'mode'>&{mode:ContentTextOutcome['mode']|'substituted'|'reflowed'};
export type CorpusRow={id:string;category:string;page:number;kind:string;original:string;text:string;ms:number;outcome:CorpusOutcome;error?:string;oracle?:unknown;fallbackFonts?:string[]};
export function summarize(rows:readonly CorpusRow[]){
 const counts={'in-place':0,'fallback-font':0,substituted:0,reflowed:0,overlay:0},reasons:Record<string,number>={};let ms=0;
 for(const r of rows){counts[r.outcome.mode]++;ms+=r.ms;if(r.outcome.reason)reasons[r.outcome.reason]=(reasons[r.outcome.reason]??0)+1;}
 return {edits:rows.length,...counts,acceptedRate:rows.length?(counts['in-place']+counts['fallback-font']+counts.substituted+counts.reflowed)/rows.length:0,refusalRate:rows.length?counts.overlay/rows.length:0,ms,reasons:Object.fromEntries(Object.entries(reasons).sort((a,b)=>b[1]-a[1]))};
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
 return `| ${label} | ${s.edits} | ${s['in-place']} | ${s['fallback-font']} | ${s.substituted} | ${s.reflowed} | ${s.overlay} | ${(100*s.acceptedRate).toFixed(1)}% |`;
}
export function markdownReport(report:{rows:CorpusRow[];files:number;elapsedMs:number;skips:unknown[];oracle:unknown[];categories?:string[]}){
 const rows=report.rows.filter(r=>isHeadlineKind(r.kind));
 const {headline:overall,unbreakableOverflow,oldDefinition}=summarizeReport(report.rows);
 const categories=[...new Set(report.categories??rows.map(r=>r.category))].sort();
 return ['# Real PDF in-place editing corpus',`\nFiles: ${report.files}. Edits: ${overall.edits}. Accepted: ${(100*overall.acceptedRate).toFixed(1)}%. Wall time: ${(report.elapsedMs/1000).toFixed(1)} s.`,
 '\nHeadline counts and accepted rate exclude only `overflow-unbreakable`.',
 '\n| Category | Edits | In place | Fallback font | Substituted | Reflowed | Refused | Accepted |','|---|---:|---:|---:|---:|---:|---:|---:|',
 ...[...categories,'overall'].map(c=>summaryRow(c,c==='overall'?overall:summarize(rows.filter(r=>r.category===c)))),
 `\nMean export time: ${(overall.ms/Math.max(1,overall.edits)).toFixed(1)} ms per edit.`,
 '\n## Refusal reasons',...Object.entries(overall.reasons).map(([r,n])=>`- ${r}: ${n}`),
 `\nSampling/skip records: ${report.skips.length}. Native oracle sample records: ${report.oracle.length}.`,
 '\n## Simplified Chinese',
 '| File | Edits | In place | Fallback font | Substituted | Reflowed | Refused |', '|---|---:|---:|---:|---:|---:|---:|',
 ...[...new Set(rows.filter(r=>r.category==='chinese').map(r=>r.id))].sort().map(id=>{const s=summarize(rows.filter(r=>r.id===id));return `| ${id} | ${s.edits} | ${s['in-place']} | ${s['fallback-font']} | ${s.substituted} | ${s.reflowed} | ${s.overlay} |`;}),
 `\nMissing-Han cases: ${rows.filter(r=>r.kind==='missing-han').length}; accepted with Noto Sans SC: ${rows.filter(r=>r.kind==='missing-han' && r.outcome.mode==='fallback-font' && r.fallbackFonts?.includes('NotoSansSC-Regular.otf')).length}.`,
 '\n## Unbreakable overflow stress case',
 '\nThese rows retain the legacy first-word repeat and are excluded from the headline.',
 '\n| Kind | Edits | In place | Fallback font | Substituted | Reflowed | Refused | Accepted |','|---|---:|---:|---:|---:|---:|---:|---:|',
 summaryRow('overflow-unbreakable',unbreakableOverflow),
 '\n## Old-definition comparison',
 '\nAll kinds except realistic `overflow` and `overflow-2`, including `overflow-unbreakable` in the old overflow slot. Compare this rate with r18: 48.6% (645/1328).',
 '\n| Definition | Edits | In place | Fallback font | Substituted | Reflowed | Refused | Accepted |','|---|---:|---:|---:|---:|---:|---:|---:|',
 summaryRow('old-definition',oldDefinition),
 '\nSee report.json for every input, outcome, timing and native evidence. Rerun: `bun scripts/pdf-corpus/run.ts`. Licence/geometry limitations are in scripts/pdf-corpus/README.md.',''].join('\n');
}
