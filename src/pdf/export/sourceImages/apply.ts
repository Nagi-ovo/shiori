import { JpegEmbedder, PDFContext, PDFName, PDFRef, PngEmbedder, type PDFPage } from "pdf-lib";
import { isBlankPage, type Overlay, type PageModel, type SourceImageEditOverlay } from "../../model/types";
import {
  inspectSourceImagePage, type SourceImageAddress, type SourceImageLocation, type SourceImageReason,
} from "../sourceImages";
import type { ImageSemanticPageGate } from "../semantic/imageGate";
import { sameImageClips } from "./clips";
import { compileSourceImages, verifyImagePlan, type ImagePlan } from "./compile";
import { jpegEnd } from "./inline";
import { imageAffectedBoxes, imagePlacement } from "./placement";
import { annotationAnchorRefusal, readSourceAnnotationAnchors, type AnchoredAnnotation } from "../sourceAnnotationAnchors";

export type SourceImageOutcome = {
  overlayId: string;
  mode: "applied" | "unsupported";
  reason?: SourceImageReason;
  detail?: string;
  anchoredAnnotations?: AnchoredAnnotation[];
};

export function refuseImage(edit: SourceImageEditOverlay, reason: SourceImageReason, detail?: string): SourceImageOutcome {
  return { overlayId: edit.id, mode: "unsupported", reason, ...(detail && { detail }) };
}

const errorDetail = (error: unknown) => error instanceof Error ? error.message : String(error);
const equalPath = (a: string[], b: string[]) => a.length === b.length && a.every((name, i) => name === b[i]);

function equalSourceAddress(target: SourceImageAddress, info: SourceImageAddress): boolean {
  return target.pageIndex === info.pageIndex && target.occurrence === info.occurrence &&
    target.kind === info.kind && target.name === info.name &&
    Array.isArray(target.formPath) && equalPath(target.formPath, info.formPath);
}

async function loadReplacement(source: NonNullable<SourceImageEditOverlay["replace"]>) {
  const match = /^data:(image\/(?:png|jpeg|jpg));base64,([a-z0-9+/=\s]+)$/i.exec(source.dataUrl);
  if (!match || match[1]!.toLowerCase().replace(/\/jpg$/, "/jpeg") !== source.mimeType) {
    throw Error("invalid image replacement data URL");
  }
  const bytes = Uint8Array.from(atob(match[2]!), character => character.charCodeAt(0));
  if (source.mimeType === "image/jpeg") jpegEnd(bytes, 0);
  const embedder = source.mimeType === "image/jpeg" ? await JpegEmbedder.for(bytes) : await PngEmbedder.for(bytes);
  if (embedder.width <= 0 || embedder.height <= 0) throw Error("invalid image replacement dimensions");
  const context = PDFContext.create();
  return { context, ref: await embedder.embedIntoContext(context) };
}

function copiesSamePaints(
  before: SourceImageLocation[], after: SourceImageLocation[], textChanged: boolean,
): boolean {
  return before.length === after.length && before.every((location, i) => {
    const { info } = location;
    const copy = after[i]!;
    return info.kind === copy.info.kind && info.name === copy.info.name && info.fingerprint === copy.info.fingerprint &&
      (textChanged || equalPath(info.formPath, copy.info.formPath)) &&
      info.matrix.every((n, j) => n === copy.info.matrix[j]) && sameImageClips(location, copy);
  });
}

type SourceImagePageInspection = ReturnType<typeof inspectSourceImagePage>;

export function inspectImageEditSources(
  sourcePages: PDFPage[], pages: PageModel[], overlays: Overlay[],
): Map<number, SourceImagePageInspection> {
  const sources = new Map<number, SourceImagePageInspection>();
  const edited = new Set(overlays.filter(o => o.type === "sourceImageEdit").map(o => o.pageId));
  for (const page of pages) {
    if (!edited.has(page.id) || isBlankPage(page) || sources.has(page.sourceIndex)) continue;
    const original = sourcePages[page.sourceIndex];
    if (original) sources.set(page.sourceIndex, inspectSourceImagePage(original.node, page.sourceIndex, "original"));
  }
  return sources;
}

function matchingIndirectPaint(source: SourceImagePageInspection | undefined, target: SourceImageAddress | undefined) {
  if (!target || !Number.isInteger(target.occurrence) || target.occurrence < 0 || !source?.unsupported) return;
  for (const [context, addresses] of source.unsupported) {
    const match = addresses[target.occurrence];
    if (match && target.fingerprint === match.address.fingerprint && equalSourceAddress(target, match.address)) {
      return { context, ...match };
    }
  }
}

export async function applySourceImageEdits(
  page: PDFPage,
  modelPage: PageModel,
  source: SourceImagePageInspection | undefined,
  edits: SourceImageEditOverlay[],
  textChanged: boolean,
  semantic?: ImageSemanticPageGate,
  anchors: readonly AnchoredAnnotation[] = readSourceAnnotationAnchors(page),
): Promise<SourceImageOutcome[]> {
  if (!edits.length) return [];
  const copy = inspectSourceImagePage(page.node, modelPage.sourceIndex);
  const verified = copy.pageBox && !copy.unsafe && source &&
    copiesSamePaints(source.occurrences, copy.occurrences, textChanged);
  const outcomes = new Map<SourceImageEditOverlay, SourceImageOutcome>();
  const plans = new Map<SourceImageEditOverlay, ImagePlan>();
  const dispositions = new Map<SourceImageEditOverlay, { applied(): void; refused(): void }>();
  const count = new Map<number, number>();

  for (const edit of edits) {
    const { target } = edit;
    const location = source && target && Number.isInteger(target.occurrence) && target.occurrence >= 0
      ? source.occurrences[target.occurrence] : undefined;
    const ordinary = location && equalSourceAddress(target, location.info);
    // Public addresses resolve to the ordinary paint first if the full address matches.
    const indirect = ordinary && target.fingerprint === location.info.fingerprint
      ? undefined : matchingIndirectPaint(source, target);
    if (!target || isBlankPage(modelPage) || target.pageIndex !== modelPage.sourceIndex) {
      outcomes.set(edit, refuseImage(edit, "target-not-found"));
    } else if (source?.unsafe) {
      outcomes.set(edit, refuseImage(edit, "unsupported-context", source.unsafe));
    } else if (indirect) {
      semantic?.refuseIndirect(edit, indirect.location, indirect.object);
      outcomes.set(edit, refuseImage(edit, "unsupported-context", indirect.context));
    } else if (!location || !ordinary) {
      outcomes.set(edit, refuseImage(edit, "target-not-found"));
    } else if (target.fingerprint !== location.info.fingerprint) {
      outcomes.set(edit, refuseImage(edit, "stale-source"));
    } else if (!verified || location.unsafe) {
      semantic?.refuseUnverified(edit, location);
      outcomes.set(edit, refuseImage(edit, "unsupported-context", location.unsafe ?? copy.unsafe ?? "image paint changed during rebuild"));
    } else {
      try {
        const copiedLocation = copy.occurrences[target.occurrence]!;
        const plan: ImagePlan = edit.delete
          ? { location: copiedLocation, delete: true, commands: "", formBounds: [], escapeFrom: -1, removals: [] }
          : {
            location: copiedLocation,
            ...imagePlacement(edit, copiedLocation, copy.pageBox!),
            replacement: edit.replace && await loadReplacement(edit.replace),
          };
        const verdict = semantic?.check(edit, location, plan);
        if (verdict?.reason) {
          outcomes.set(edit, refuseImage(edit, "unsupported-context", verdict.reason));
          continue;
        }
        if (verdict) dispositions.set(edit, verdict);
        verifyImagePlan(plan);
        plans.set(edit, plan);
        count.set(target.occurrence, (count.get(target.occurrence) ?? 0) + 1);
      } catch (error) {
        const disposition = dispositions.get(edit);
        if (disposition) disposition.refused();
        else semantic?.refuseUnverified(edit, location);
        outcomes.set(edit, refuseImage(edit, "unsupported-context", errorDetail(error)));
      }
    }
  }
  for (const [edit, plan] of plans) {
    if (count.get(plan.location.info.occurrence) === 1) continue;
    outcomes.set(edit, refuseImage(edit, "unsupported-context", "several edits address the same image paint"));
    dispositions.get(edit)?.refused();
    plans.delete(edit);
  }

  while (plans.size) {
    const { context } = page.doc;
    const checkpoint = context.largestObjectNumber;
    const discard = () => {
      // Discard detached streams and resources from an abandoned candidate.
      for (let number = checkpoint + 1; number <= context.largestObjectNumber; number += 1) {
        context.delete(PDFRef.of(number));
      }
      context.largestObjectNumber = checkpoint;
    };
    try {
      const { location } = plans.values().next().value!;
      const root = (location.forms[0] ?? location.paint).owner;
      const candidate = compileSourceImages(page.node, root.resources, [...plans.values()]);
      let refused = false;
      if (anchors.length) for (const [edit, plan] of plans) {
        if (!plan.placement) continue;
        const affectedBoxes = imageAffectedBoxes(plan.location, copy.pageBox!, plan.placement);
        if (!affectedBoxes.length) continue;
        const anchor = annotationAnchorRefusal(anchors, affectedBoxes);
        if (!anchor) continue;
        outcomes.set(edit, { overlayId: edit.id, mode: "unsupported", ...anchor });
        plans.delete(edit);
        refused = true;
      }
      if (refused) {
        discard();
        continue;
      }
      for (const name of ["Resources", "Contents"].map(PDFName.of)) page.node.set(name, candidate.get(name)!);
      for (const edit of plans.keys()) dispositions.get(edit)?.applied();
    } catch (error) {
      discard();
      for (const edit of plans.keys()) {
        dispositions.get(edit)?.refused();
        outcomes.set(edit, refuseImage(edit, "unsupported-context", errorDetail(error)));
      }
    }
    break;
  }
  return edits.map(edit => outcomes.get(edit) ?? { overlayId: edit.id, mode: "applied" });
}
