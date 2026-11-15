import type {ContentTextOutcome} from '../../src/pdf/export/contentText/outcomes';
export type CorpusRow={id:string;category:string;page:number;kind:string;original:string;text:string;ms:number;outcome:ContentTextOutcome;error?:string;oracle?:unknown;fallbackFonts?:string[]};
export function summarize(rows:readonly CorpusRow[]){
 const counts={'in-place':0,'fallback-font':0,overlay:0},reasons:Record<string,number>={};let ms=0;
 for(const r of rows){counts[r.outcome.mode]++;ms+=r.ms;if(r.outcome.reason)reasons[r.outcome.reason]=(reasons[r.outcome.reason]??0)+1;}
 return {edits:rows.length,...counts,acceptedRate:rows.length?(counts['in-place']+counts['fallback-font'])/rows.length:0,refusalRate:rows.length?counts.overlay/rows.length:0,ms,reasons:Object.fromEntries(Object.entries(reasons).sort((a,b)=>b[1]-a[1]))};
}
export function markdownReport(report:{rows:CorpusRow[];files:number;elapsedMs:number;skips:unknown[];oracle:unknown[];categories?:string[]}){
 const overall=summarize(report.rows),categories=[...new Set(report.categories??report.rows.map(r=>r.category))].sort();
 return ['# Real PDF in-place editing corpus',`\nFiles: ${report.files}. Edits: ${report.rows.length}. Wall time: ${(report.elapsedMs/1000).toFixed(1)} s.`,
 '\n| Category | Edits | In place | Fallback font | Refused | Accepted |','|---|---:|---:|---:|---:|---:|',
 ...[...categories,'overall'].map(c=>{const s=c==='overall'?overall:summarize(report.rows.filter(r=>r.category===c));return `| ${c} | ${s.edits} | ${s['in-place']} | ${s['fallback-font']} | ${s.overlay} | ${(100*s.acceptedRate).toFixed(1)}% |`;}),
 `\nMean export time: ${(overall.ms/Math.max(1,overall.edits)).toFixed(1)} ms per edit.`,
 '\n## Refusal reasons',...Object.entries(overall.reasons).map(([r,n])=>`- ${r}: ${n}`),
 `\nSampling/skip records: ${report.skips.length}. Native oracle sample records: ${report.oracle.length}.`,
 '\n## Simplified Chinese',
 '| File | Edits | In place | Fallback font | Refused |', '|---|---:|---:|---:|---:|',
 ...[...new Set(report.rows.filter(r=>r.category==='chinese').map(r=>r.id))].sort().map(id=>{const s=summarize(report.rows.filter(r=>r.id===id));return `| ${id} | ${s.edits} | ${s['in-place']} | ${s['fallback-font']} | ${s.overlay} |`;}),
 `\nMissing-Han cases: ${report.rows.filter(r=>r.kind==='missing-han').length}; accepted with Noto Sans SC: ${report.rows.filter(r=>r.kind==='missing-han' && r.outcome.mode==='fallback-font' && r.fallbackFonts?.includes('NotoSansSC-Regular.otf')).length}.`,
 '\nSee report.json for every input, outcome, timing and native evidence. Rerun: `bun scripts/pdf-corpus/run.ts`. Licence/geometry limitations are in scripts/pdf-corpus/README.md.',''].join('\n');
}
