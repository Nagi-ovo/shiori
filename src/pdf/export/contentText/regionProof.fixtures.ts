import { tokenizeContentStream } from '../contentStreamEdit/tokenizer';
import type { ParagraphInput, TextTrace } from './regionProof';

/** Numeric source/operator fixture: no DOM, font library or renderer guesses. */
export function paragraph(lefts = [50, 50, 50], rights = [150, 150, 115]): ParagraphInput {
  const ys = lefts.map((_, i) => 700 - i * 14);
  const source = `BT /F 10 Tf 14 TL ${lefts.map((x, i) =>
    `1 0 0 1 ${x} ${ys[i]} Tm (abc) Tj`).join(' ')} ET`;
  const ops = tokenizeContentStream(new TextEncoder().encode(source));
  const trace = (opIndex: number, x: number, y: number, left: number): TextTrace => ({
    bt: 0, opIndex, ctm: [1, 0, 0, 1, 0, 0], tm: [1, 0, 0, 1, x, y],
    tlm: [1, 0, 0, 1, left, y], fontObject: '7 0 R', size: 10, tc: 0,
    tw: 0, tz: 100, leading: 14, rise: 0, renderMode: 0, safetyHash: 'plain-scope',
  });
  return {
    sourceHash: 'stream', dependencyHash: 'deps', ops,
    lines: lefts.map((left, i) => {
      const y = ys[i]!, right = rights[i] ?? 115, anchorIndex = 3 + i * 2;
      return { anchor: trace(anchorIndex, left, y, left),
        shows: [{ source: { streamHash: 'stream', opIndex: anchorIndex + 1,
          itemIndex: -1, byteStart: 0, byteEnd: 3, fontObject: '7 0 R' },
        unicode: '甲乙丙', before: trace(anchorIndex + 1, left, y, left),
        after: trace(anchorIndex + 1, right, y, left) }],
        ink: { x: left, y: y - 2, w: right - left, h: 10 } };
    }),
    evidence: {
      sourceHash: 'stream', dependencyHash: 'deps', obstacleProofHash: 'scene',
      boundaryProofHash: 'body-boundary', scopeProofHash: 'plain-scope',
      completeScene: true, readingOrder: 'proven', whitespace: 'source-codes',
      structure: 'body-text', columnBoundary: 'proven', semantics: 'plain', inlineFeatures: 'plain-prose',
      crop: { x: 0, y: 0, w: 600, h: 800 },
      clip: { x: 0, y: 0, w: 600, h: 800 }, obstacles: [],
    }, rasterGuardPt: 0,
  };
}

export function moveLine(input: ParagraphInput, row: number, dx: number, dy = 0): void {
  const line = input.lines[row]!;
  for (const t of [line.anchor, ...line.shows.flatMap(s => [s.before, s.after])]) {
    t.tm = [...t.tm.slice(0, 4), t.tm[4]! + dx, t.tm[5]! + dy];
    t.tlm = [...t.tlm.slice(0, 4), t.tlm[4]! + dx, t.tlm[5]! + dy];
  }
  const op = input.ops[line.anchor.opIndex]!;
  op.operands[4] = { kind: 'number', value: line.anchor.tm[4]! };
  op.operands[5] = { kind: 'number', value: line.anchor.tm[5]! };
  if (line.ink) { line.ink.x += dx; line.ink.y += dy; }
}
