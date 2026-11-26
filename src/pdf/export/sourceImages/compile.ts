import {
  PDFDict, PDFName, PDFObjectCopier, PDFRef, type PDFContext, type PDFObject, PDFRawStream,
} from "pdf-lib";
import type { PdfRect } from "../../model/types";
import { inspectSourceImagePage, type SourceImageFormCall, type SourceImageLocation } from "../sourceImages";
import type { SourceImageStreamOwner } from "./content";
import { resourceGroup, type SourceImageResources } from "./objects";
import { dropUnusedImageBindings, verifyReplacedImages } from "./reachableBindings";
import { boundsUnion, clipInForm, type imagePlacement } from "./placement";
import { concatenate, encode, hasPaint, patchPageContents, splice, withContents, withoutPaint, type ImagePatch } from "./patches";

export type ImagePlan = ReturnType<typeof imagePlacement> & {
  location: SourceImageLocation;
  delete?: boolean;
  replacement?: { context: PDFContext; ref: PDFRef };
};

type Invocation = {
  owner: SourceImageStreamOwner;
  form?: SourceImageFormCall;
  images: ImagePlan[];
  children: Map<number, Invocation>;
  expanded?: PdfRect;
  escapes: Set<number>;
  clipPatches: ImagePatch[];
  formerClips: SourceImageFormCall[];
};

const key = PDFName.of;
const xObjects = key("XObject");

function nodeFor(owner: SourceImageStreamOwner, form?: SourceImageFormCall): Invocation {
  return { owner, form, images: [], children: new Map(), escapes: new Set(), clipPatches: [], formerClips: [] };
}

function invocationTree(plans: ImagePlan[]) {
  const first = plans[0]!.location;
  const root = nodeFor((first.forms[0] ?? first.paint).owner);
  for (const plan of plans) {
    const { forms, paint } = plan.location;
    let current = root;
    const path = [root];
    for (const [i, call] of forms.entries()) {
      let child = current.children.get(call.start);
      const downstream = forms[i + 1] ?? paint;
      if (!child) {
        child = nodeFor(downstream.owner, call);
        current.children.set(call.start, child);
      }
      if (plan.escapeFrom !== -1 && plan.escapeFrom <= i) {
        child.expanded = boundsUnion(child.expanded ?? call.bbox, plan.formBounds[i]!);
        child.escapes.add(downstream.start);
      }
      current = child;
      path.push(child);
    }
    current.images.push(plan);
    for (const op of plan.removals) {
      const node = path.find(node => node.owner === op.owner);
      if (!node) throw Error("missing image clip owner");
      node.clipPatches.push({ op, body: encode("\n") });
    }
  }
  const nodes = [root];
  for (const node of nodes) {
    for (const [at, child] of node.children) {
      if (node.form && node.escapes.has(at)) child.formerClips = [...node.formerClips, node.form];
      nodes.push(child);
    }
  }
  return nodes.reverse();
}

function replacementPaint(plan: ImagePlan, objects: PDFDict, cursor: { next: number }): Uint8Array {
  const replacement = plan.replacement!;
  const { context } = objects;
  const ref = PDFObjectCopier.for(replacement.context, context).copy(replacement.ref);
  const { paint } = plan.location;
  if (paint.kind === "xobject") {
    const visibility = paint.binding.object.dict.get(key("OC"));
    if (visibility) {
      const image = context.lookup(ref);
      if (!(image instanceof PDFRawStream)) throw Error("unreadable replacement Image XObject");
      image.dict.set(key("OC"), visibility);
    }
  }
  return encode(addObject(objects, ref, cursor));
}

function boxNumbers({ x, y, w, h }: PdfRect): number[] {
  return [x, y, x + w, y + h];
}

function formCanSplit(call: SourceImageFormCall, owner: SourceImageStreamOwner): void {
  const ops = owner.ops!;
  // Separate Form invocations must not replay structural tags or depend on
  // invisible text shows to reconstruct a text clipping path.
  const structural = ["BMC", "BDC", "MP", "DP", "d0", "d1"];
  if (ops.some(op => structural.includes(op.operator) || (op.operator === "Tr" &&
      op.operands[0]?.kind === "number" && op.operands[0].value >= 4)) ||
    (call.textMode >= 4 && ops.some(op => ["Tj", "TJ", "'", '"'].includes(op.operator)))) {
    throw Error("cannot isolate this Form's clip");
  }
}

export function verifyImagePlan(plan: ImagePlan): void {
  const { forms, paint } = plan.location;
  if (forms.some(({ binding: { object: { dict } } }) => dict.has(key("StructParent")) || dict.has(key("StructParents")))) {
    throw Error("cannot isolate a tagged Form occurrence");
  }
  if (plan.escapeFrom === -1) return;
  for (let i = plan.escapeFrom; i < forms.length; i += 1) {
    const owner = (forms[i + 1] ?? paint).owner;
    formCanSplit(forms[i]!, owner);
    // Validate clip reprojection before any PDF object is allocated.
    for (let j = plan.escapeFrom; j < i; j += 1) {
      clipInForm(forms[j]!.formToPage, forms[i]!.formToPage, forms[j]!.bbox);
    }
  }
}

function addObject(objects: PDFDict, ref: PDFObject, cursor: { next: number }): string {
  let name: string;
  do name = `ShioriImg${cursor.next++}`; while (objects.has(key(name)));
  objects.set(key(name), ref);
  return `/${name} Do`;
}

/** Put regular paint intervals in Forms with the original box. Individual
 * escaping calls get their own interval, replaying the surrounding state
 * without re-emitting paints. The outer Form retains its original Matrix,
 * transparency group and dictionary, and invokes intervals in paint order. */
function partitionForm(node: Invocation, resources: PDFDict, patches: ImagePatch[]): PDFRawStream {
  const form = node.form!;
  const ctx = node.owner.dictionary.context;
  const source = node.owner.bytes;
  const ops = node.owner.ops!;
  const parts = ctx.obj({});
  const cursor = { next: 1 };
  const oldClips = node.formerClips.map(clip => clipInForm(clip.formToPage, form.formToPage, clip.bbox)).join("");
  const staged = new Map(patches.map(({ op, body }) => [op.start, body]));
  // Each removable clip covers exactly one paint. Suppressed paint intervals
  // can therefore replay the same stream with that clip removed.
  const clipPatches = node.clipPatches.map(({ op, body }) => ({ ...op, body }));
  const silent = ops.flatMap(op => {
    const body = withoutPaint(op);
    return body ? [{ op, body }] : [];
  });
  const calls: string[] = [];
  const segments: { start: number; end: number; escapes: boolean }[] = [];
  let start = 0;
  for (const op of ops) {
    if (!node.escapes.has(op.start)) continue;
    segments.push({ start, end: op.start, escapes: false }, { start: op.start, end: op.end, escapes: true });
    start = op.end;
  }
  segments.push({ start, end: source.length, escapes: false });
  const paintAt = ops.filter(hasPaint);
  let paintIndex = 0;
  const active = segments.filter(({ start, end }) => {
    while (paintAt[paintIndex] && paintAt[paintIndex]!.start < start) paintIndex += 1;
    return paintAt[paintIndex] !== undefined && paintAt[paintIndex]!.end <= end;
  });
  // The replay keeps state between original paint intervals. Bound its
  // aggregate size for pages with large streams and many escaping edits.
  if (active.length * source.length > 64 * 1024 * 1024) throw Error("Form clip isolation exceeds the content limit");
  for (const { start, end, escapes } of active) {
    const edits = silent.flatMap(({ op, body }) => {
      const inside = op.start >= start && op.end <= end;
      const replacement = inside ? staged.get(op.start) : body;
      return replacement ? [{ start: op.start, end: op.end, body: replacement }] : [];
    });
    const content = splice(source, [...edits, ...clipPatches]);
    const stream = ctx.flateStream(escapes || !oldClips ? content : concatenate([encode(oldClips), content]), {
      Type: "XObject", Subtype: "Form", BBox: boxNumbers(escapes ? node.expanded! : form.bbox), Resources: resources,
    });
    calls.push(addObject(parts, ctx.register(stream), cursor));
  }
  const wrapper = withContents(form.binding.object, encode(calls.join("\n")));
  wrapper.dict.set(key("BBox"), ctx.obj(boxNumbers(node.expanded!)));
  wrapper.dict.set(key("Resources"), ctx.obj({ XObject: parts }));
  return wrapper;
}

function compiledResources(owner: SourceImageStreamOwner, pageResources: SourceImageResources) {
  const ctx = owner.dictionary.context;
  const resources = owner.resources.dict?.clone() ?? ctx.obj({});
  const original = resourceGroup(owner.resources, pageResources, "XObject")?.dict;
  const objects = original?.clone() ?? ctx.obj({});
  resources.set(xObjects, objects);
  return { resources, objects };
}

/** Every write is to a detached version. The caller installs the page
 * dictionary entries only once compilation and resource validation finish. */
export function compileSourceImages(page: PDFDict, pageResources: SourceImageResources, plans: ImagePlan[]): PDFDict {
  const ctx = page.context;
  const originalObjects = new Set<PDFRawStream>();
  const replacedImages = new Set<PDFRawStream>();
  const compiled = new Map<Invocation, PDFRef>();
  for (const node of invocationTree(plans)) {
    const { resources, objects } = compiledResources(node.owner, pageResources);
    const cursor = { next: 1 };
    const patches: ImagePatch[] = [];
    for (const child of node.children.values()) {
      const op = child.form!;
      originalObjects.add(op.binding.object);
      const body = encode(`\n${addObject(objects, compiled.get(child)!, cursor)}\n`);
      patches.push({ op, body });
    }
    for (const plan of node.images) {
      const { paint } = plan.location;
      let body: Uint8Array;
      if (!plan.delete) {
        const source = plan.replacement ? replacementPaint(plan, objects, cursor)
          : paint.owner.bytes.subarray(paint.start, paint.end);
        body = plan.commands ? concatenate([encode(`\nq\n${plan.commands}`), source, encode("\nQ\n")])
          : concatenate([encode("\n"), source, encode("\n")]);
      } else {
        body = encode("\n");
      }
      if (paint.kind === "xobject" && (plan.delete || plan.replacement)) {
        originalObjects.add(paint.binding.object);
        if (plan.replacement) replacedImages.add(paint.binding.object);
      }
      patches.push({ op: paint, body });
    }
    if (node.form) {
      const stream = node.expanded ? partitionForm(node, resources, patches)
        : withContents(node.form.binding.object, splice(node.owner.bytes, [...patches, ...node.clipPatches].map(({ op, body }) => ({ ...op, body }))));
      if (!node.expanded) stream.dict.set(key("Resources"), resources);
      compiled.set(node, ctx.register(stream));
    } else {
      const candidate = page.clone();
      candidate.set(key("Resources"), resources);
      candidate.set(key("Contents"), patchPageContents([...patches, ...node.clipPatches]));
      const proof = inspectSourceImagePage(candidate, 0);
      if (proof.unsafe) throw Error(proof.unsafe);
      if (proof.sharingComplete) {
        candidate.set(key("Resources"), dropUnusedImageBindings(resources, proof.liveBindings, originalObjects));
      }
      verifyReplacedImages(candidate, proof.liveBindings, replacedImages);
      return candidate;
    }
  }
  throw Error("missing image page");
}
