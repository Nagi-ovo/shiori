import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream, type PDFObject,
} from "pdf-lib";
import { coalesceContentStreams, type ContentOp } from "../contentStreamEdit/tokenizer";
import { dictionaryEntry, dictionaryValue, type SourceImageResources } from "./objects";

export type SourceImageMatrix = [number, number, number, number, number, number];

export type SourceImageStreamPart = {
  stream: PDFRawStream;
  entry: PDFObject;
  index: number;
  offset: number;
  bytes: Uint8Array;
};

export type SourceImageStreamOwner = {
  dictionary: PDFDict;
  // A page's original /Contents value or the calling entry of a Form.
  entry?: PDFObject;
  resources: SourceImageResources;
  bytes: Uint8Array;
  parts: SourceImageStreamPart[];
  ops?: ContentOp[];
};

export type SourceImageOperation = {
  owner: SourceImageStreamOwner;
  // Half-open window in owner.bytes (the joined decoded content).
  start: number;
  end: number;
  // The corresponding half-open windows in original decoded stream parts.
  parts: Array<{ part: SourceImageStreamPart; start: number; end: number }>;
  localMatrix: SourceImageMatrix;
  matrix: SourceImageMatrix;
};

function contentBytes(stream: PDFRawStream): Uint8Array {
  const { dict } = stream;
  const filter = dictionaryValue(dict, "Filter");
  if (filter === undefined) return stream.getContents();
  if (!(filter instanceof PDFName) && !(filter instanceof PDFArray)) throw Error("invalid content stream filter");
  const params = dictionaryValue(dict, "DecodeParms");
  const stages = params instanceof PDFArray ? params.asArray().map(entry => dict.context.lookup(entry)) : [params];
  for (const stage of stages) {
    if (!(stage instanceof PDFDict)) continue;
    const predictor = dictionaryValue(stage, "Predictor");
    if (predictor === undefined) continue;
    if (!(predictor instanceof PDFNumber) || predictor.asNumber() !== 1) {
      throw Error("unsupported content stream predictor");
    }
  }
  return decodePDFRawStream(stream).decode();
}

export function streamOwner(
  dictionary: PDFDict, resources: SourceImageResources,
  decoded: WeakMap<PDFRawStream, Uint8Array>,
  form?: { entry: PDFObject; stream: PDFRawStream },
): SourceImageStreamOwner {
  const entry = form?.entry ?? dictionaryEntry(dictionary, "Contents");
  const content = form?.stream ?? dictionary.context.lookup(entry);
  if (entry && !content) throw Error("unreadable page Contents");
  const parts: SourceImageStreamPart[] = [];
  let offset = 0;
  const size = content instanceof PDFArray ? content.size() : content ? 1 : 0;
  for (let index = 0; index < size; index += 1) {
    const streamEntry = content instanceof PDFArray ? content.get(index) : entry!;
    const stream = content instanceof PDFArray ? content.lookup(index) : content;
    if (!(stream instanceof PDFRawStream) || dictionaryEntry(stream.dict, "F")) {
      throw Error("unreadable PDF content stream");
    }
    let bytes = decoded.get(stream);
    if (!bytes) {
      bytes = contentBytes(stream);
      decoded.set(stream, bytes);
    }
    parts.push({ stream, entry: streamEntry, index, offset, bytes });
    offset += bytes.length + 1;
  }
  const bytes = parts.length ? coalesceContentStreams(parts.map(part => part.bytes)) : new Uint8Array();
  return { dictionary, entry, resources, bytes, parts };
}

export function operationLocation(
  owner: SourceImageStreamOwner, op: ContentOp,
  localMatrix: SourceImageMatrix, matrix: SourceImageMatrix,
): SourceImageOperation {
  const { start, end } = op;
  const parts: SourceImageOperation["parts"] = [];
  let lo = 0;
  let hi = owner.parts.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const part = owner.parts[mid]!;
    if (part.offset + part.bytes.length <= start) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < owner.parts.length; i += 1) {
    const part = owner.parts[i]!;
    if (end <= part.offset) break;
    const partStart = Math.max(0, start - part.offset);
    const partEnd = Math.min(part.bytes.length, end - part.offset);
    if (partEnd > partStart) parts.push({ part, start: partStart, end: partEnd });
  }
  if (op.inlineImage && parts.length !== 1) throw Error("inline image crosses content streams");
  return { owner, start, end, parts, localMatrix, matrix };
}
