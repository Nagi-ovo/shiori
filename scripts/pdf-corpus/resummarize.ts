// Re-summarize a sealed corpus report.json through the current summarizer,
// without re-running the corpus. Usage:
//   bun scripts/pdf-corpus/resummarize.ts <report.json> [out.md] [out.json]
// Prints the headline and quality summaries as JSON; writes the markdown
// report and the full summaries only to the paths given (never next to the
// sealed input).
import {readFile,writeFile} from 'node:fs/promises';
import {markdownReport,summarizeReport} from './report';
const [input,markdownOut,jsonOut]=process.argv.slice(2);
if(!input)throw Error('usage: bun scripts/pdf-corpus/resummarize.ts <report.json> [out.md] [out.json]');
const report=JSON.parse(await readFile(input,'utf8'));
const summaries=summarizeReport(report.rows);
if(markdownOut)await writeFile(markdownOut,markdownReport(report));
if(jsonOut)await writeFile(jsonOut,JSON.stringify(summaries,null,2));
console.log(JSON.stringify({headline:summaries.headline,quality:summaries.quality},null,1));
