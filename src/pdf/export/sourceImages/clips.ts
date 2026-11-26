import type { PdfRect } from "../../model/types";
import type { SourceImageFormCall, SourceImageInfo, SourceImageLocation } from "../sourceImages";
import { operationLocation, type SourceImageMatrix } from "./content";
import type { SourceClip } from "./graphics";
import { shapeCorners, type ImageClip } from "./clipShape";

const imageClips = new WeakMap<SourceImageInfo, {
  first?: SourceClip;
  forms: SourceImageFormCall[];
  pageBox: PdfRect;
}>();

export function rememberImageClips(
  image: SourceImageInfo, first: SourceClip | undefined, forms: SourceImageFormCall[], pageBox: PdfRect,
) {
  if (first || forms.length) imageClips.set(image, { first, forms, pageBox });
}

export function* sourceImageClips(image: SourceImageInfo): Iterable<ImageClip> {
  const clips = imageClips.get(image);
  if (!clips) return;
  const localMatrix = ([a, b, c, d, e, f]: SourceImageMatrix): SourceImageMatrix =>
    [a, b, c, d, e - clips.pageBox.x, f - clips.pageBox.y];
  for (let clip = clips.first; clip; clip = clip.parent) {
    const matrix = localMatrix(clip.matrix);
    yield "box" in clip ? { matrix, box: clip.box } : { matrix, points: clip.points };
  }
  for (const form of clips.forms) yield { matrix: localMatrix(form.formToPage), box: form.bbox };
}

export function clipRemovals(
  location: SourceImageLocation, sourceContains: (clip: ImageClip) => boolean, destinationContains: (clip: ImageClip) => boolean,
) {
  const { clips, paintIndex, info } = location;
  if (clips.opaqueClip) throw Error("cannot prove image placement inside the source clip");
  const removals = [];
  for (let clip = clips.pathClips; clip; clip = clip.parent) {
    if (!sourceContains(clip)) throw Error("image placement would reveal samples outside the original clip");
    if (destinationContains(clip)) continue;
    if (!clip.removal || clip.firstPaint !== paintIndex || clip.endPaint !== paintIndex + 1) {
      throw Error("cannot isolate the image from this clipping path");
    }
    const { owner, op } = clip.removal;
    removals.push(operationLocation(owner, op, info.matrix, info.matrix));
  }
  return removals;
}

function sameClip(a: ImageClip, b: ImageClip): boolean {
  const aa = shapeCorners(a), bb = shapeCorners(b);
  return aa.length === bb.length && aa.every(({ x, y }, i) => x === bb[i]!.x && y === bb[i]!.y) &&
    a.matrix.every((value, i) => value === b.matrix[i]);
}

export function sameImageClips(before: SourceImageLocation, after: SourceImageLocation): boolean {
  if (before.clips.opaqueClip !== after.clips.opaqueClip) return false;
  let a = before.clips.pathClips, b = after.clips.pathClips;
  while (a && b) {
    if (!sameClip(a, b)) return false;
    a = a.parent;
    b = b.parent;
  }
  return !a && !b && before.forms.length === after.forms.length && before.forms.every((form, i) => {
    const copy = after.forms[i]!;
    return sameClip({ matrix: form.formToPage, box: form.bbox }, { matrix: copy.formToPage, box: copy.bbox });
  });
}
