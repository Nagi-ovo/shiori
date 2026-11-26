import { spawn } from 'node:child_process';
import { once } from 'node:events';

// An independent PDF renderer supplies pixels for the production diagnostic
// and for reviewing the raw pairs. No editor layout or ink masks are mocked.
export async function renderFixtureRegion(bytes: Uint8Array, index: number, region: { x: number; y: number; width: number; height: number }, scale: number) {
  const proc = spawn('pdftoppm', ['-f', String(index + 1), '-l', String(index + 1), '-singlefile',
    '-r', String(scale * 72), '-x', String(region.x), '-y', String(region.y),
    '-W', String(region.width), '-H', String(region.height)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exit = once(proc, 'close');
  proc.stdin.end(bytes);
  const pieces: Buffer[] = [];
  for await (const chunk of proc.stdout) pieces.push(chunk as Buffer);
  const [code] = await exit;
  if (code !== 0) throw Error('Fixture rendering failed');
  const rgb = Buffer.concat(pieces);
  const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/u.exec(new TextDecoder().decode(rgb.subarray(0, 100)));
  if (!header) throw Error('Missing raster header');
  const width = Number(header[1]), height = Number(header[2]);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = header[0].length, p = 0; i < rgb.length; i += 3, p += 4) {
    data.set([rgb[i]!, rgb[i + 1]!, rgb[i + 2]!, 255], p);
  }
  return { width, height, data };
}
