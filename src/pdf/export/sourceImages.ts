import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFRawStream, type PDFObject } from "pdf-lib";
import type { PdfRect } from "../model/types";
import { assertPdfWithinFileLimit, assertPdfWithinPageLimit } from "../openPolicy";
import { sourcePageDicts } from "../import/sourcePages";
import { formPageBox } from "./contentText/retypesetForms";
import { tokenizeContentStream, type ContentOp, type InlineImageData } from "./contentStreamEdit/tokenizer";
import { operationLocation, streamOwner, type SourceImageMatrix, type SourceImageOperation, type SourceImageStreamOwner } from "./sourceImages/content";
import { discoverSourceImages } from "./sourceImages/discovery";
import { annotationPaints, trackExtraPaints } from "./sourceImages/indirectPaints";
import { inlineImageExtent, inlineImageProperties } from "./sourceImages/inline";
import { closePathClips, compose, updateGraphics, type Frame, type Graphics, type ImageClipState, type IndirectImageContext, type IndirectPaint } from "./sourceImages/graphics";
import { rememberImageClips } from "./sourceImages/clips";
import { hasPaint } from "./sourceImages/patches";
import {
  dictionaryEntry, dictionaryValue, fingerprintInline, fingerprintXObject, formBox, objectNumbers, pageImageEnvironment,
  resourceGroup, resourceKey, resourceScope, xObjectImageProperties,
  type SourceImageResourceGroup, type SourceImageResources,
} from "./sourceImages/objects";

export type SourceImageAddress = {
  pageIndex: number;
  /** Index in ordinary page paint order, including paints reached through Forms. */
  occurrence: number;
  kind: "xobject" | "inline";
  formPath: string[];
  name?: string;
  fingerprint: string;
};

export type SourceImageInfo = SourceImageAddress & {
  bbox: PdfRect;
  matrix: SourceImageMatrix;
  widthPx: number;
  heightPx: number;
  masked: boolean;
  shared: boolean;
};

export type SourceImageReason = "stale-source" | "target-not-found" | "unsupported-context" | "annotation-anchor";

/** Lists proven ordinary paints in content order. An unreadable page yields an empty list.
 * Document load failures, including encrypted input, and size limits still throw.
 */
export async function listSourceImages(bytes: Uint8Array, pageIndex: number): Promise<SourceImageInfo[]> {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) return [];
  assertPdfWithinFileLimit(bytes.length);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return inspectSourceImages(pdf, pageIndex).occurrences.map(({ info }) => info);
}

/** @internal The editor's opened bytes are immutable. Unreadable pages yield
 * an empty list. Document load failures and size limits still throw.
 */
export async function listImmutableSourceImages(bytes: Uint8Array, pageIndex: number): Promise<SourceImageInfo[]> {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) return [];
  assertPdfWithinFileLimit(bytes.length);
  return discoverSourceImages(bytes, pageIndex, () => new SourceImageWalk());
}

type XObjectBinding = SourceImageResourceGroup & {
  name: string;
  nameKey: PDFName;
  objectEntry: PDFObject;
  object: PDFRawStream;
};

export type SourceImageFormCall = SourceImageOperation & {
  binding: XObjectBinding;
  formMatrix: SourceImageMatrix;
  formToPage: SourceImageMatrix;
  bbox: PdfRect;
  textMode: number;
  inheritedClips?: Graphics["pathClips"];
};

type SourceImagePaint = SourceImageOperation & (
  | { kind: "xobject"; binding: XObjectBinding }
  | { kind: "inline"; data: InlineImageData }
);

export type SourceImageLocation = {
  info: SourceImageInfo;
  paint: SourceImagePaint;
  clips: ImageClipState;
  paintIndex: number;
  // Outermost calling Do first. Each call carries its own resource binding.
  forms: SourceImageFormCall[];
  unsafe?: string;
};

export type SourceImageInspection = {
  page: PDFDict | null;
  pageBox?: PdfRect;
  occurrences: SourceImageLocation[];
  // A page-level ambiguity invalidates its occurrence numbering entirely.
  unsafe?: string;
  // False when a malformed stream or an opaque paint context prevents a
  // complete use count. The writer must isolate objects at the call site.
  sharingComplete: boolean;
};

type IndirectImage = { address: SourceImageAddress; location: SourceImageLocation; object?: PDFDict };

type Scope = ReturnType<typeof pageImageEnvironment>;
type Path = { call: SourceImageFormCall; parent?: Path };
type QueuePaint = (paint: IndirectPaint) => void;
const key = PDFName.of;
const operationLimit = 1_000_000;
const identity: SourceImageMatrix = [1, 0, 0, 1, 0, 0];
const unitSquare: PdfRect = { x: 0, y: 0, w: 1, h: 1 };
function names(op: ContentOp): string {
  const operand = op.operands[0];
  if (op.operands.length !== 1 || operand?.kind !== "name") throw Error(`invalid ${op.operator} operands`);
  return operand.value;
}

function xObject(resources: SourceImageResources, page: Scope, name: string): XObjectBinding {
  const group = resourceGroup(resources, page.resources, "XObject");
  const nameKey = group && resourceKey(group.dict, name);
  const objectEntry = nameKey && group?.dict.get(nameKey);
  const object = objectEntry && group?.dict.context.lookup(objectEntry);
  if (!group || !nameKey || !objectEntry || !(object instanceof PDFRawStream) || dictionaryEntry(object.dict, "F")) {
    throw Error(`unreadable XObject /${name}`);
  }
  return { ...group, name, nameKey, objectEntry, object };
}

class SourceImageWalk {
  sharingComplete = true;
  private readonly uses = new Map<PDFRawStream, number>();
  private readonly fingerprints = new WeakMap<PDFRawStream, string>();
  private readonly decoded = new WeakMap<PDFRawStream, Uint8Array>();
  private readonly parsed = new WeakMap<Uint8Array, Map<PDFDict | undefined, ContentOp[]>>();
  // A DAG can expand into exponentially many actual paints.
  private remainingOps = operationLimit;

  private readonly liveBindings?: Map<PDFDict, Set<PDFName>>;
  private readonly evidence: boolean;

  constructor(liveBindings?: Map<PDFDict, Set<PDFName>>, evidence = false) {
    this.liveBindings = liveBindings;
    this.evidence = evidence;
  }

  private enter(
    owner: SourceImageStreamOwner, scope: Scope, toPage: SourceImageMatrix,
    state?: Graphics, path?: Path,
  ): Frame<Path> {
    if (this.liveBindings) {
      try {
        const xobjects = resourceGroup(owner.resources, scope.resources, "XObject")?.dict;
        if (xobjects && !this.liveBindings.has(xobjects)) this.liveBindings.set(xobjects, new Set());
      } catch {
        this.sharingComplete = false;
      }
    }
    const colors = resourceGroup(owner.resources, scope.resources, "ColorSpace")?.dict;
    let parses = this.parsed.get(owner.bytes);
    if (!parses) {
      parses = new Map();
      this.parsed.set(owner.bytes, parses);
    }
    let ops = parses.get(colors);
    if (!ops) {
      ops = tokenizeContentStream(owner.bytes, (bytes, entries, afterId) =>
        inlineImageExtent(bytes, entries, afterId, name => {
          const nameKey = colors && resourceKey(colors, name);
          return nameKey && colors.lookup(nameKey);
        }));
      parses.set(colors, ops);
    }
    owner.ops = ops;
    return {
      owner, ops, next: 0, path, toPage, state: {
        ...state, matrix: identity, textMode: state?.textMode ?? 0,
      },
      stack: [], inText: false, pendingClip: false, pendingTextClip: false, marked: 0, compatibility: 0,
    };
  }

  walkPage(page: PDFDict, pageIndex: number, collect: boolean) {
    const scope = pageImageEnvironment(page);
    const annots = page.lookup(key("Annots"));
    const indirect: (IndirectPaint & { object?: PDFDict })[] = [];
    const queued = new Map<PDFRawStream, Map<PDFDict | undefined, number>>();
    // Each indirect context has its own paint order. Its program root has no
    // Form resource name. Nested Do operators supply the path as usual.
    const unsupported = new Map<IndirectImageContext, IndirectImage[]>();
    const unreadable = new Set<IndirectImageContext>();
    const conservative = !!this.liveBindings && !this.evidence;
    const enqueue = (paint: IndirectPaint & { object?: PDFDict }) => {
      try {
        const resources = resourceScope(paint.stream.dict) ?? paint.resources;
        if (this.evidence) {
          // Each actual invocation has its own indices. The ordinary sharing
          // and cleanup passes only need proof of at least two uses.
          if (indirect.length >= operationLimit) throw Error("indirect paint discovery limit exceeded");
          indirect.push({ ...paint, resources });
          return;
        }
        let counts = queued.get(paint.stream);
        if (!counts) {
          counts = new Map();
          queued.set(paint.stream, counts);
        }
        const count = counts.get(resources.dict) ?? 0;
        if (count === 2) return;
        counts.set(resources.dict, count + 1);
        indirect.push({ ...paint, resources });
      } catch {
        this.sharingComplete = false;
        unreadable.add(paint.context);
      }
    };
    if (annots instanceof PDFArray) {
      for (const entry of annots.asArray()) {
        try {
          const annot = page.context.lookup(entry);
          if (!(annot instanceof PDFDict)) throw Error("unreadable annotation");
          for (const paint of annotationPaints(annot, scope.resources, conservative)) enqueue({ ...paint, object: annot });
        } catch {
          this.sharingComplete = false;
          unreadable.add("annotation appearance");
        }
      }
    }
    const owner = streamOwner(page, scope.resources, this.decoded);
    const occurrences = this.walk(owner, scope, pageIndex, collect, enqueue);
    for (const paint of indirect) {
      try {
        const owner = streamOwner(paint.stream.dict, paint.resources, this.decoded, paint);
        // An appearance or mask can invoke a Form directly, without a Do.
        if (!this.liveBindings && dictionaryValue(paint.stream.dict, "Subtype") === key("Form")) {
          this.countUse(paint.stream);
        }
        const locations = this.walk(owner, scope, pageIndex, this.evidence, enqueue);
        if (locations.length && !unreadable.has(paint.context)) {
          const addresses = unsupported.get(paint.context) ?? [];
          for (const location of locations) {
            const { kind, name, formPath, fingerprint } = location.info;
            const address = { pageIndex, occurrence: addresses.length, kind, name, formPath, fingerprint };
            addresses.push({ address, location, object: paint.object });
          }
          unsupported.set(paint.context, addresses);
        }
      } catch {
        this.sharingComplete = false;
        unreadable.add(paint.context);
      }
    }
    for (const context of unreadable) unsupported.delete(context);
    return { pageBox: scope.pageBox, occurrences, unsupported };
  }

  private walk(
    owner: SourceImageStreamOwner, scope: Scope, pageIndex: number, collect: boolean, enqueue: QueuePaint,
  ): SourceImageLocation[] {
    const { pageBox } = scope;
    const frames = [this.enter(owner, scope, identity)];
    const active = new Set<PDFRawStream>();
    const occurrences: SourceImageLocation[] = [];
    let paints = 0;
    while (frames.length) {
      const frame = frames[frames.length - 1]!;
      const op = frame.ops[frame.next++];
      if (!op) {
        if (frame.stack.length || frame.inText || frame.pathStart !== undefined || frame.pendingClip || frame.marked || frame.compatibility) {
          throw Error("unbalanced content stream");
        }
        closePathClips(frame.state.pathClips, frame.path?.call.inheritedClips, paints);
        if (frame.path) active.delete(frame.path.call.binding.object);
        frames.pop();
        continue;
      }
      if (--this.remainingOps < 0) throw Error("image discovery operation limit exceeded");
      if (op.operator !== "Do" && !op.inlineImage) {
        try { trackExtraPaints(frame, op, scope.resources, enqueue, !!this.liveBindings && !this.evidence, this.evidence); }
        catch { this.sharingComplete = false; }
        if (hasPaint(op)) paints += 1;
        updateGraphics(frame, op, paints);
        continue;
      }
      if (frame.inText || frame.pathStart !== undefined || frame.pendingClip) throw Error("image or Form paint inside an open graphics operation");
      const binding = op.operator === "Do" ? xObject(frame.owner.resources, scope, names(op)) : undefined;
      const subtype = binding && dictionaryValue(binding.object.dict, "Subtype");
      if (binding) {
        this.countUse(binding.object);
        if (this.liveBindings) {
          const names = this.liveBindings.get(binding.dict) ?? new Set();
          names.add(binding.nameKey);
          this.liveBindings.set(binding.dict, names);
        }
      }
      const matrix = compose(frame.toPage, frame.state.matrix);
      const location = operationLocation(frame.owner, op, frame.state.matrix, matrix);
      if (subtype === key("Form") && binding) {
        const { object, objectEntry } = binding;
        if (active.has(object)) throw Error("cyclic Form XObject");
        if (dictionaryEntry(object.dict, "Ref")) throw Error("external Form XObject");
        const transform = dictionaryValue(object.dict, "Matrix");
        const formMatrix = transform === undefined ? identity : objectNumbers(transform, 6) as SourceImageMatrix;
        const formToPage = compose(matrix, formMatrix);
        const call = { ...location, binding, formMatrix, formToPage, bbox: formBox(object.dict),
          textMode: frame.state.textMode, inheritedClips: frame.state.pathClips };
        const resources = resourceScope(object.dict) ?? frame.owner.resources;
        const owner = streamOwner(object.dict, resources, this.decoded, { entry: objectEntry, stream: object });
        active.add(object);
        let state = frame.state;
        if (state.softMask) {
          const group = object.dict.lookup(key("Group"));
          if (group instanceof PDFDict && group.lookup(key("S")) === key("Transparency")) {
            enqueue(state.softMask);
            state = { ...state, softMask: undefined };
          }
        }
        frames.push(this.enter(owner, scope, formToPage, state, { call, parent: frame.path }));
        continue;
      }
      const paint = op.inlineImage ? { ...location, kind: "inline" as const, data: op.inlineImage }
        : subtype === key("Image") && binding ? { ...location, kind: "xobject" as const, binding }
        : undefined;
      if (!paint) throw Error("unsupported XObject subtype");
      if (frame.state.softMask) enqueue(frame.state.softMask);
      if (frame.state.fillPattern && isStencil(paint)) enqueue(frame.state.fillPattern);
      if (collect) occurrences.push(this.imageLocation(paint, frame.path, pageBox, pageIndex, occurrences.length,
        frame.state, paints));
      paints += 1;
    }
    return occurrences;
  }

  private countUse(stream: PDFRawStream): void {
    this.uses.set(stream, Math.min(2, (this.uses.get(stream) ?? 0) + 1));
  }

  private imageLocation(
    paint: SourceImagePaint, path: Path | undefined, pageBox: PdfRect, pageIndex: number, occurrence: number,
    { pathClips, opaqueClip }: ImageClipState, paintIndex: number,
  ): SourceImageLocation {
    const forms: SourceImageFormCall[] = [];
    for (let item = path; item; item = item.parent) forms.push(item.call);
    forms.reverse();
    const properties = paint.kind === "xobject" ? xObjectImageProperties(paint.binding.object.dict)
      : inlineImageProperties(paint.data.entries);
    let fingerprint: string;
    if (paint.kind === "xobject") {
      const image = paint.binding.object;
      fingerprint = this.fingerprints.get(image) ?? fingerprintXObject(image);
      this.fingerprints.set(image, fingerprint);
    } else {
      const { dictionaryStart, dictionaryEnd, dataStart, dataEnd } = paint.data;
      const bytes = paint.owner.bytes;
      fingerprint = fingerprintInline(bytes.subarray(dictionaryStart, dictionaryEnd), bytes.subarray(dataStart, dataEnd));
    }
    const { matrix } = paint;
    const box = formPageBox(matrix, unitSquare);
    const bbox = { ...box, x: box.x - pageBox.x, y: box.y - pageBox.y };
    if (!Object.values(bbox).every(Number.isFinite)) throw Error("non-finite image bounds");
    const [a, b, c, d] = matrix;
    const determinant = a * d - b * c;
    const unsafe = !Number.isFinite(determinant) || determinant === 0 ? "singular image transform" : undefined;
    const info: SourceImageInfo = {
      pageIndex, occurrence, kind: paint.kind, formPath: forms.map(form => form.binding.name),
      ...(paint.kind === "xobject" && { name: paint.binding.name }),
      fingerprint, bbox, matrix, ...properties, shared: false,
    };
    rememberImageClips(info, pathClips, forms, pageBox);
    return { info, paint, forms, clips: { pathClips, opaqueClip }, paintIndex, unsafe };
  }

  isShared({ paint, forms }: SourceImageLocation): boolean {
    const repeated = (stream: PDFRawStream) => this.uses.get(stream) === 2;
    return (paint.kind === "xobject" && repeated(paint.binding.object))
      || forms.some(call => repeated(call.binding.object));
  }
}

function isStencil(paint: SourceImagePaint): boolean {
  if (paint.kind === "xobject") return paint.binding.object.dict.lookup(key("ImageMask")) === PDFBool.True;
  const mask = paint.data.entries.get("IM") ?? paint.data.entries.get("ImageMask");
  return mask?.kind === "boolean" && mask.value;
}

/** Inspect original objects in the writer's PDF context before making any edits. */
export function inspectSourceImages(pdf: PDFDocument, pageIndex: number): SourceImageInspection {
  const result: SourceImageInspection = { page: null, occurrences: [], sharingComplete: true };
  if (!Number.isInteger(pageIndex) || pageIndex < 0) return result;
  if (pdf.isEncrypted) return { ...result, unsafe: "encrypted source", sharingComplete: false };
  const pages = sourcePageDicts(pdf);
  assertPdfWithinPageLimit(pages.length);
  if (pageIndex >= pages.length) return result;
  result.page = pages[pageIndex] ?? null;
  const walk = new SourceImageWalk();
  for (const [index, page] of pages.entries()) {
    try {
      if (!page) throw Error("unreadable source page");
      const located = walk.walkPage(page, index, index === pageIndex);
      if (index === pageIndex) Object.assign(result, located);
    } catch (error) {
      result.sharingComplete = false;
      if (index === pageIndex) result.unsafe = error instanceof Error ? error.message : String(error);
    }
  }
  result.sharingComplete &&= walk.sharingComplete;
  for (const occurrence of result.occurrences) occurrence.info.shared = walk.isShared(occurrence);
  return result;
}

/** Read a single page. Collect refusal evidence only from the original page.
 * Candidate inspections instead record conservative resource use for cleanup.
 */
export function inspectSourceImagePage(page: PDFDict, pageIndex: number, mode: "original" | "candidate" = "candidate") {
  const evidence = mode === "original";
  const liveBindings = new Map<PDFDict, Set<PDFName>>();
  const walk = new SourceImageWalk(evidence ? undefined : liveBindings, evidence);
  try {
    return { ...walk.walkPage(page, pageIndex, true), liveBindings, sharingComplete: walk.sharingComplete, unsafe: undefined };
  } catch (error) {
    return { occurrences: [], pageBox: undefined, liveBindings, unsupported: undefined, sharingComplete: false,
      unsafe: error instanceof Error ? error.message : String(error) };
  }
}
