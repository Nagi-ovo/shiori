// Pure line breaking and line placement for linked text frames. Coordinates
// are PDF user space (fact 1); baselines run top to bottom.
import type {PdfRect} from '../../../model/types';

const cjk = /[\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\uff00-\uffef]/u;
// Closing punctuation stays with the character before it (no line may start with it).
const noLineStart = /[、。，．：；！？）」』】〉》〕｝’”・ー…,.:;!?)\]}]/u;

/** Greedy breaking: Latin at spaces, CJK between characters, never hyphenating.
 * `widths[i]` is the room on line i; null when the text cannot be set. */
export function breakLines(text: string, widths: readonly number[], measure: (s: string) => number): string[] | null {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  const lines: string[] = [];
  let start = 0;
  while (start < chars.length) {
    const room = widths[lines.length];
    if (room === undefined) return null;
    let lastBreak = -1, end = start;
    for (let i = start; i < chars.length; i++) {
      const candidate = chars.slice(start, i + 1).join('');
      if (i > start && breakableBefore(chars, i)) lastBreak = i;
      if (measure(candidate.trimEnd()) > room) break;
      end = i + 1;
    }
    if (end >= chars.length) { lines.push(chars.slice(start).join('').trim()); break; }
    if (chars[end] === ' ') lastBreak = end;
    else if (breakableBefore(chars, end) && end > start) lastBreak = end;
    if (lastBreak <= start) return null;
    lines.push(chars.slice(start, lastBreak).join('').trimEnd());
    start = lastBreak;
    while (chars[start] === ' ') start++;
  }
  return lines;
}

function breakableBefore(chars: readonly string[], i: number): boolean {
  const prev = chars[i - 1]!, cur = chars[i]!;
  if (cur === ' ') return false;
  if (prev === ' ') return true;
  if (noLineStart.test(cur)) return false;
  return cjk.test(cur) || cjk.test(prev);
}

/** `ascentEm` / `descentEm`: the story's real ink above and below its baseline, in em. */
export type FirstFrameGeometry = { rect: PdfRect; firstBaseline: number; pitch: number; size: number; descentEm: number; ascentEm?: number };
export type NextFrameGeometry = { rect: PdfRect; firstBaseline: number; size: number; descentEm: number; sourceBaselines: readonly number[] };
export type FlowPlacement = { ok: true; first: number[]; spilled: number[]; pushedBy: number } | { ok: false };

/** Baselines that fit `rect` at `pitch`, starting at `first`. */
export function frameBaselines(rect: PdfRect, first: number, pitch: number, size: number, descentEm: number): number[] {
  const out: number[] = [];
  for (let b = first; b - descentEm * size >= rect.y - 1e-6 && out.length < 1000; b -= pitch) out.push(b);
  return out;
}

/** Story lines fill the first frame, then continue at the next frame's first
 * source baseline at the first frame's pitch; the next frame's own lines move
 * down by the spilled lines and must stay inside their frame. */
export function placeFlow(lineCount: number, f0: FirstFrameGeometry, f1: NextFrameGeometry): FlowPlacement {
  const capacity = frameBaselines(f0.rect, f0.firstBaseline, f0.pitch, f0.size, f0.descentEm);
  const rise = (f0.ascentEm ?? 0) * f0.size, top = (r: PdfRect) => r.y + r.h + 1e-6;
  if (lineCount > 0 && f0.firstBaseline + rise > top(f0.rect)) return { ok: false };
  if (lineCount <= capacity.length) return { ok: true, first: capacity.slice(0, lineCount), spilled: [], pushedBy: 0 };
  const spillCount = lineCount - capacity.length;
  const spilled = Array.from({ length: spillCount }, (_, i) => f1.firstBaseline - i * f0.pitch);
  if (f1.firstBaseline + rise > top(f1.rect)) return { ok: false };
  // The next frame's own text follows the spill one first-frame pitch lower.
  if (f1.sourceBaselines.length && f0.pitch < .95 * Math.max(f0.size, f1.size)) return { ok: false };
  const pushedBy = spillCount * f0.pitch;
  const lowestSpill = spilled[spilled.length - 1]! - f0.descentEm * f0.size;
  const lowestOwn = f1.sourceBaselines.length ? Math.min(...f1.sourceBaselines) - pushedBy - f1.descentEm * f1.size : Infinity;
  if (Math.min(lowestSpill, lowestOwn) < f1.rect.y - 1e-6) return { ok: false };
  return { ok: true, first: capacity, spilled, pushedBy };
}
