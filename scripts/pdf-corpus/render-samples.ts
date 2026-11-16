import assert from 'node:assert/strict';
import {readdir, readFile, access} from 'node:fs/promises';
import {join} from 'node:path';
import type {PdfRect} from '../../src/pdf/model/types';

type EditRegion = {rect?: PdfRect; paragraphRect?: PdfRect; coverRects?: PdfRect[]};
export type EditMetadata = EditRegion & {
  overlay?: EditRegion;
  row?: {id?: string; category?: string; outcome?: {mode?: string; reflow?: {region: {box: PdfRect;mask?:readonly PdfRect[]}}}};
};
export type RenderSample = {name: string; before: string; after: string; edit?: string; metadata: EditMetadata; smoke?: boolean};
const accepted = ['in-place', 'fallback-font', 'substituted', 'reflowed'];
export const newMode = (sample: RenderSample) => ['substituted', 'reflowed'].includes(sample.metadata.row?.outcome?.mode ?? '');

export function editRects(metadata: EditMetadata): PdfRect[] {
  const region = metadata.overlay ?? metadata;
  const reflow=metadata.row?.outcome?.reflow?.region;
  const rects = [region.rect, ...(region.coverRects ?? []), region.paragraphRect,...(reflow?.mask??(reflow?[reflow.box]:[]))]
    .filter((r): r is PdfRect => r !== undefined);
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
