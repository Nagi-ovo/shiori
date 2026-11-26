import { PDFName, PDFRawStream, type PDFObject } from "pdf-lib";
import type { ContentOp } from "../contentStreamEdit/tokenizer";
import { pdfNumber } from "../contentStreamEdit/runEncoding";
import type { SourceImageOperation } from "./content";

export type Patch = { start: number; end: number; body: Uint8Array };
export type ImagePatch = { op: SourceImageOperation; body: Uint8Array };

export const encode = (value: string) => new TextEncoder().encode(value);

export function concatenate(chunks: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export function splice(bytes: Uint8Array, patches: Patch[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const { start, end, body } of patches.sort((a, b) => a.start - b.start)) {
    if (start < offset || end < start || end > bytes.length) throw Error("overlapping image patches");
    chunks.push(bytes.subarray(offset, start), body);
    offset = end;
  }
  chunks.push(bytes.subarray(offset));
  return concatenate(chunks);
}

const key = PDFName.of;
const streamEncoding = ["Filter", "DecodeParms", "Length", "DL"];

export function withContents(stream: PDFRawStream, bytes: Uint8Array): PDFRawStream {
  const dict = stream.dict.clone();
  for (const name of streamEncoding) dict.delete(key(name));
  return PDFRawStream.of(dict, bytes);
}

/** Patch only the stream parts containing selected operators. A Do may
 * straddle parts, but inline sample data is always in one part. */
export function patchPageContents(patches: ImagePatch[]): PDFObject {
  const owner = patches[0]!.op.owner;
  const byPart = new Map<number, Patch[]>();
  for (const { op, body } of patches) {
    if (!op.parts.length) throw Error("missing content stream range");
    for (const [i, { part, start, end }] of op.parts.entries()) {
      const group = byPart.get(part.index) ?? [];
      group.push({ start, end, body: i === 0 ? body : new Uint8Array() });
      byPart.set(part.index, group);
    }
  }
  const ctx = owner.dictionary.context;
  const entries = owner.parts.map(part => {
    const edits = byPart.get(part.index);
    return edits ? ctx.register(withContents(part.stream, splice(part.bytes, edits))) : part.entry;
  });
  return owner.parts.length === 1 && ctx.lookup(owner.entry) === owner.parts[0]!.stream ? entries[0]! : ctx.obj(entries);
}

const pathPaint = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*"]);
const show = new Set(["Tj", "TJ", "'", '"']);
const otherPaint = new Set(["BI", "Do", "sh"]);

/** Replay graphics and text state in an independent Form, suppressing paints
 * in the other segments. Boundaries are image or Form calls outside paths
 * and text objects. In particular, the quote operator also sets text spacing. */
export function withoutPaint(op: ContentOp): Uint8Array | undefined {
  if (pathPaint.has(op.operator)) return encode(["s", "b", "b*"].includes(op.operator) ? "\nh n\n" : "\nn\n");
  if (op.operator === '"') {
    const [word, char] = op.operands;
    if (word?.kind !== "number" || char?.kind !== "number") throw Error("invalid text spacing");
    return encode(`\n${pdfNumber(word.value)} Tw ${pdfNumber(char.value)} Tc\n`);
  }
  if (show.has(op.operator) || otherPaint.has(op.operator)) return encode("\n");
  return undefined;
}

export function hasPaint(op: ContentOp): boolean {
  return pathPaint.has(op.operator) || show.has(op.operator) || otherPaint.has(op.operator);
}
