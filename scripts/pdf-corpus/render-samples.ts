import assert from 'node:assert/strict';
import {readdir, readFile, access} from 'node:fs/promises';
import {join} from 'node:path';
import type {PdfRect} from '../../src/pdf/model/types';
import type {RetypesetManifest} from '../../src/pdf/export/contentText/retypesetTypes';

type EditRegion = {rect?: PdfRect; paragraphRect?: PdfRect; coverRects?: PdfRect[]};
export type EditMetadata = EditRegion & {
  overlay?: EditRegion;
  row?: {id?: string; category?: string; outcome?: {mode?: string; fidelity?: string;
    retypeset?: Pick<RetypesetManifest,'paragraphBox'|'lineCount'|'overflowed'>;
    reflow?: {region: {box: PdfRect;mask?:readonly PdfRect[]}}}};
};
export type RenderSample = {name: string; before: string; after: string; edit?: string; metadata: EditMetadata; smoke?: boolean};
const accepted = ['in-place', 'fallback-font', 'substituted', 'reflowed', 'retypeset'];
export const newMode = (sample: RenderSample) => ['substituted', 'reflowed', 'retypeset'].includes(sample.metadata.row?.outcome?.mode ?? '');
type CropGlyph={text:string;origin:readonly number[];box:readonly number[];inkBox?:readonly number[];fontHash?:string};

export function editRects(metadata: EditMetadata, native?: {before:readonly CropGlyph[];after:readonly CropGlyph[]}): PdfRect[] {
  const region = metadata.overlay ?? metadata;
  const outcome=metadata.row?.outcome,reflow=outcome?.reflow?.region;
  const retypeset=outcome?.mode==='retypeset'||outcome?.fidelity==='approximate';
  const rects = [region.rect, ...(region.coverRects ?? []), region.paragraphRect,...(reflow?.mask??(reflow?[reflow.box]:[])),
    ...(retypeset&&outcome?.retypeset?[outcome.retypeset.paragraphBox]:[])]
    .filter((r): r is PdfRect => r !== undefined);
  if(retypeset&&native){
    // Union new/moved output ink with the original covers. Matching consumes
    // occurrences, so a wrapped 'i' is still new when another 'i' survives on
    // the page. Unchanged output already lies within the original edit boxes.
    // Native ink determines the growth, rather than guessing pitch or adding
    // a large fixed margin when lineCount/overflowed says wrapping occurred.
    const available=new Map<string,CropGlyph[]>();
    for(const g of native.before){const glyphs=available.get(g.text)??[];glyphs.push(g);available.set(g.text,glyphs);}
    for(const g of native.after){
      if(!g.text.replace(/\s/gu,''))continue;
      const glyphs=available.get(g.text)??[];
      const at=glyphs.findIndex(old=>old.fontHash===g.fontHash&&Math.hypot(old.origin[0]!-g.origin[0]!,old.origin[1]!-g.origin[1]!)<=.01);
      if(at>=0){glyphs.splice(at,1);continue;}
      const [left,bottom,right,top]=g.inkBox??g.box;
      if(right!>left!&&top!>bottom!)rects.push({x:left!,y:bottom!,w:right!-left!,h:top!-bottom!});
    }
  }
  assert(rects.length, 'edit JSON must contain coverRects, rect or paragraphRect');
  return rects;
}

export async function readSamples(directory: string): Promise<RenderSample[]> {
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const samples: RenderSample[] = [];
  for (const file of files.filter(f => f.endsWith('.edit.json')).sort()) {
    const name = file.slice(0, -'.edit.json'.length), edit = join(directory, file);
    const before = join(directory, `${name}.before.pdf`), after = join(directory, `${name}.after.pdf`);
    await access(before); await access(after);
    const metadata: EditMetadata = JSON.parse(await readFile(edit, 'utf8'));
    samples.push({name, before, after, edit, metadata});
  }
  return samples;
}

/** Deterministic representatives. Generic tagged files are not Word evidence;
 * only the corpus's GSA tagged documents may fill that slot. */
export function selectSamples(samples: readonly RenderSample[]): RenderSample[] {
  const eligible = samples.filter(s => accepted.includes(s.metadata.row?.outcome?.mode ?? ''));
  const sorted = [...eligible].sort((a, b) => Number(newMode(b)) - Number(newMode(a)) || a.name.localeCompare(b.name));
  const chinese = sorted.find(s => s.metadata.row?.category === 'chinese');
  const latex = sorted.find(s => s.metadata.row?.category === 'latex');
  const word = sorted.find(s => s.metadata.row?.category === 'word') ?? sorted.find(s =>
    s.metadata.row?.category === 'tagged' && (s.metadata.row.id ?? s.name).startsWith('gsa-'));
  return [chinese, latex, word].filter((s): s is RenderSample => s !== undefined);
}
