import { nanoid } from "nanoid";
import { isBlankPage, type Overlay, type PageModel, type SourceImageEditOverlay } from "../../pdf/model/types";
import type { SourceImageAddress, SourceImageInfo } from "../../pdf/export/sourceImages";
import type { OpenedPdf, PdfEditorStoreApi, Store } from "./store";

export type SourceImagePatch = Partial<Pick<SourceImageEditOverlay, "rect" | "angle" | "crop" | "replace" | "delete">>;
export const fullImage = { x: 0, y: 0, w: 1, h: 1 };

export function sourceImageAddress({ pageIndex, occurrence, kind, formPath, name, fingerprint }: SourceImageInfo): SourceImageAddress {
  return { pageIndex, occurrence, kind, formPath: [...formPath], ...(name !== undefined && { name }), fingerprint };
}

export function findSourceImageEdit(overlays: readonly Overlay[], pageId: string, image: SourceImageInfo) {
  return overlays.find((edit): edit is SourceImageEditOverlay => {
    if (edit.type !== "sourceImageEdit" || edit.pageId !== pageId) return false;
    const { target } = edit;
    return target.pageIndex === image.pageIndex && target.occurrence === image.occurrence &&
      target.kind === image.kind && target.name === image.name && target.fingerprint === image.fingerprint &&
      target.formPath.length === image.formPath.length && target.formPath.every((name, i) => name === image.formPath[i]);
  });
}

export function canEditSourceImage(state: Store, opened: OpenedPdf, page: PageModel) {
  return state.opened === opened && !opened.encrypted && !state.readerMode &&
    state.tool === "select" && !state.editingOverlayId && state.activePageId === page.id &&
    !isBlankPage(page) && state.model.pages.includes(page);
}

function sameRect(a: SourceImageEditOverlay["rect"], b: SourceImageEditOverlay["rect"]) {
  return a === b || Boolean(a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
}

export function commitSourceImageEdit(
  store: PdfEditorStoreApi, opened: OpenedPdf, page: PageModel, image: SourceImageInfo,
  expected: SourceImageEditOverlay | undefined, patch: SourceImagePatch,
): boolean {
  const state = store.getState();
  if (!Object.keys(patch).length || !canEditSourceImage(state, opened, page) || image.pageIndex !== page.sourceIndex || expected?.locked) return false;
  const current = findSourceImageEdit(state.model.overlays, page.id, image);
  if (current !== expected) return false;
  const next: SourceImageEditOverlay = {
    ...(current ?? { type: "sourceImageEdit", id: nanoid(), pageId: page.id, target: sourceImageAddress(image) }),
    ...patch,
  };
  const [a, b, c, d] = image.matrix;
  if (a > 0 && d > 0 && b === 0 && c === 0 && sameRect(next.rect, image.bbox)) delete next.rect;
  if (sameRect(next.crop, fullImage)) delete next.crop;
  if (next.angle !== undefined) next.angle = ((next.angle % 360) + 360) % 360;
  if (!next.angle) delete next.angle;
  if (next.rect === undefined) delete next.rect;
  if (next.crop === undefined) delete next.crop;
  if (!next.rect && !next.crop && !next.angle && !next.replace && !next.delete) {
    if (!current) return false;
    state.commit({ overlays: state.model.overlays.filter(o => o !== current) });
    return true;
  }
  if (current && sameRect(current.rect, next.rect) && sameRect(current.crop, next.crop) &&
      current.angle === next.angle && current.delete === next.delete &&
      current.replace?.dataUrl === next.replace?.dataUrl) return false;
  const overlays = current
    ? state.model.overlays.map(o => o === current ? next : o)
    : [...state.model.overlays, next];
  state.commit({ overlays });
  return true;
}

export async function replaceSourceImage(
  store: PdfEditorStoreApi, opened: OpenedPdf, page: PageModel, image: SourceImageInfo,
  expected: SourceImageEditOverlay | undefined,
  pending: Promise<NonNullable<SourceImageEditOverlay["replace"]>>,
  stillSelected: () => boolean, base?: SourceImagePatch,
): Promise<boolean> {
  const replace = await pending;
  return stillSelected() && commitSourceImageEdit(store, opened, page, image, expected, { ...base, replace });
}
