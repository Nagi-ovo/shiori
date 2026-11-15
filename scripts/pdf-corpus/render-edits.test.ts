import {expect, test} from 'bun:test';
import {existsSync} from 'node:fs';
import {mkdir, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {inflateSync} from 'node:zlib';
import {cropPage, encodePng, pairImages} from './render-images';
import {editRects, selectSamples, type RenderSample} from './render-samples';

test('crop maps bottom-left PDF coordinates to raster rows, with margin and edge clamping', () => {
  const pixels = Buffer.alloc(4 * 4 * 4, 255);
  // Bottom-left pixel is blue in native BGRA.
  pixels.set([255, 0, 0, 255], 3 * 4 * 4);
  const crop = cropPage({width: 2, height: 2, pixels}, [{x: 0, y: 0, w: 0.5, h: 0.5}], 0, 0);
  expect(crop).toMatchObject({width: 1, height: 1});
  expect([...crop.rgba]).toEqual([0, 0, 255, 255]);
  expect(cropPage({width: 2, height: 2, pixels}, [{x: 0, y: 0, w: 1, h: 1}], 0, 8)).toMatchObject({width: 4, height: 4});
  expect(cropPage({width: 2, height: 2, pixels}, [{x: 0, y: 0, w: 0.5, h: 0.5}], 90, 0)).toMatchObject({width: 1, height: 1});
  expect(() => cropPage({width: 2, height: 2, pixels}, [{x: 10, y: 10, w: 1, h: 1}], 0, 0)).toThrow('outside');
  expect(() => cropPage({width: 2, height: 2, pixels}, [{x: NaN, y: 0, w: 1, h: 1}], 0, 0)).toThrow('rect');
});

test('PNG and side-by-side pixels preserve channels, dimensions and before/after ordering', () => {
  const before = {width: 1, height: 1, rgba: Buffer.from([255, 0, 0, 255])};
  const after = {width: 1, height: 1, rgba: Buffer.from([0, 0, 255, 255])};
  const pair = pairImages(before, after);
  expect([...pair.rgba.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
  expect([...pair.rgba.subarray(-4)]).toEqual([0, 0, 255, 255]);
  const png = encodePng(pair);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(png.readUInt32BE(16)).toBe(pair.width);
  expect(png.readUInt32BE(20)).toBe(1);
  const length = png.readUInt32BE(33);
  expect(png.toString('ascii', 37, 41)).toBe('IDAT');
  expect(inflateSync(png.subarray(41, 41 + length))).toEqual(Buffer.concat([Buffer.of(0), pair.rgba]));
});

const sample = (name: string, category: string, mode: string): RenderSample => ({
  name, before: 'before.pdf', after: 'after.pdf', metadata: {row: {category, outcome: {mode}}, overlay: {rect: {x: 0, y: 0, w: 10, h: 10}}},
});
test('selection prioritizes new Chinese modes and Word, with tagged as the Word alternative', () => {
  const samples = [sample('zh-old', 'chinese', 'fallback-font'), sample('zh-new', 'chinese', 'substituted'),
    sample('latex', 'latex', 'in-place'), sample('gsa-tagged', 'tagged', 'reflowed'), sample('word', 'word', 'fallback-font'), sample('refused', 'chinese', 'overlay')];
  expect(selectSamples(samples).map(s => s.name)).toEqual(['zh-new', 'latex', 'word']);
  expect(selectSamples(samples.filter(s => s.name !== 'word')).map(s => s.name)).toEqual(['zh-new', 'latex', 'gsa-tagged']);
  expect(selectSamples([])).toEqual([]);
});

test('crop includes original cover, paragraph rect and the full downward reflow region', () => {
  expect(editRects({overlay: {rect: {x: 1, y: 10, w: 20, h: 10}, coverRects: [{x: 2, y: 11, w: 18, h: 8}]},
    row: {outcome: {mode: 'reflowed', reflow: {region: {box: {x: 1, y: 0, w: 20, h: 20}}}}}})).toEqual([
    {x: 1, y: 10, w: 20, h: 10}, {x: 2, y: 11, w: 18, h: 8}, {x: 1, y: 0, w: 20, h: 20},
  ]);
});

const library = resolve(process.env.SHIORI_PDFIUM_DIR ?? 'vendor/pdfium/linux-x64/lib', 'libpdfium.so');
test.skipIf(!existsSync(library))('CLI renders a native smoke pair without corpus files and replays explicit saved inputs', async () => {
  const out = resolve('test-artifacts/pdf-corpus/renders/smoke-test');
  await mkdir(`${out}/empty`, {recursive: true});
  const run = (args: string[]) => {
    const result = spawnSync('bun', ['scripts/pdf-corpus/render-edits.ts', ...args], {encoding: 'utf8', timeout: 30000});
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  expect(run(['--samples', `${out}/empty`, '--out', out])).toContain('no samples yet');
  const manifest = JSON.parse(await readFile(`${out}/manifest.json`, 'utf8'));
  expect(manifest.renders).toHaveLength(1);
  expect(manifest.renders[0]).toMatchObject({smoke: true, mode: 'in-place'});
  const rendered = manifest.renders[0];
  const before = await readFile(rendered.files.before), after = await readFile(rendered.files.after);
  expect(before.equals(after)).toBe(false);
  expect(before.subarray(1, 4).toString()).toBe('PNG');
  run(['--before', rendered.before, '--after', rendered.after, '--edit', rendered.edit, '--out', `${out}/explicit`]);
  const explicit = JSON.parse(await readFile(`${out}/explicit/manifest.json`, 'utf8'));
  expect(explicit.renders[0].crop).toEqual(rendered.crop);
  expect(await readFile(explicit.renders[0].files.before)).toEqual(before);
});
