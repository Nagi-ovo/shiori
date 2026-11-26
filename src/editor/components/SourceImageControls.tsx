import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { SourceImageInfo } from "../../pdf/export/sourceImages";
import type { PageModel, PdfPoint, PdfRect, SourceImageEditOverlay } from "../../pdf/model/types";
import { assertPdfWithinFileLimit } from "../../pdf/openPolicy";
import { fullImage, type SourceImagePatch } from "../store/sourceImageEdits";
import { isEditableKeyboardTarget } from "./overlays/overlayPointer";
import {
  imageDisplayPoint, imageGesturePatch, imageMatrix, imagePagePoint, imageRectCorners, imageResizePoint, imageVisibleCrop, imageVisibleOutline, mapPoint, type ImageHandle,
} from "./sourceImageGeometry";
import "./sourceImageControls.css";

type Props = {
  image: SourceImageInfo;
  page: PageModel;
  scale: number;
  edit?: SourceImageEditOverlay;
  outline: PdfPoint[];
  pending?: boolean;
  onEdit: (patch: SourceImagePatch) => boolean;
  onReplace: (pending: Promise<NonNullable<SourceImageEditOverlay["replace"]>>, stillSelected: () => boolean) => Promise<boolean>;
  onDismiss: () => void;
};

type Drag = {
  pointerId: number;
  target: HTMLButtonElement;
  handle: ImageHandle;
  edit?: SourceImageEditOverlay;
  visibleCrop?: PdfRect;
  start: PdfPoint;
  client: PdfPoint;
};
const edge = (v: number, extent: number) => Math.max(12, Math.min(extent - 12, v));

export function SourceImageControls({ image, page, scale, edit, outline: renderedOutline, pending, onEdit, onReplace, onDismiss }: Props) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<Drag | null>(null);
  const replacement = useRef(0);
  const [provisional, setProvisional] = useState<SourceImagePatch>();
  const [cropping, setCropping] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [failed, setFailed] = useState(false);

  const cancelDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    setProvisional(undefined);
  }, []);

  const local = useCallback((e: Pick<globalThis.PointerEvent, "clientX" | "clientY">) => {
    const bounds = root.current!.getBoundingClientRect();
    return imagePagePoint({ x: e.clientX - bounds.left, y: e.clientY - bounds.top }, page, scale);
  }, [page, scale]);

  useEffect(() => () => { replacement.current += 1; }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableKeyboardTarget(e.target) ||
          document.querySelector('[aria-modal="true"], [data-shiori-modal-open]')) return;
      if (e.key === "Escape") {
        if (drag.current) cancelDrag();
        else if (replacing) {
          replacement.current += 1;
          setReplacing(false);
        } else if (cropping) setCropping(false);
        else onDismiss();
      } else if (!pending && (e.key === "Delete" || e.key === "Backspace")) {
        cancelDrag();
        onEdit({ delete: true });
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onExtraPointer = (e: globalThis.PointerEvent) => {
      if (drag.current && drag.current.pointerId !== e.pointerId) cancelDrag();
    };
    const track = (e: globalThis.PointerEvent) => {
      const current = drag.current;
      if (!current || current.pointerId !== e.pointerId) return;
      if (pending || current.edit !== edit || e.type === "pointercancel") {
        cancelDrag();
        return;
      }
      const patch = Math.hypot(e.clientX - current.client.x, e.clientY - current.client.y) < 2 ? undefined :
        imageGesturePatch(image, edit, current.handle, current.start, local(e), e.shiftKey, current.visibleCrop);
      if (e.type === "pointerup") {
        cancelDrag();
        if (patch) onEdit(patch);
      } else setProvisional(patch);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointermove", track, true);
    window.addEventListener("pointerup", track, true);
    window.addEventListener("pointercancel", track, true);
    window.addEventListener("pointerdown", onExtraPointer, true);
    window.addEventListener("blur", cancelDrag);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointermove", track, true);
      window.removeEventListener("pointerup", track, true);
      window.removeEventListener("pointercancel", track, true);
      window.removeEventListener("pointerdown", onExtraPointer, true);
      window.removeEventListener("blur", cancelDrag);
    };
  }, [cancelDrag, cropping, edit, image, local, pending, replacing, onDismiss, onEdit]);
  const begin = (e: PointerEvent<HTMLButtonElement>, handle: ImageHandle) => {
    if (e.button !== 0 || !e.isPrimary || drag.current || replacing || pending) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId, target: e.currentTarget, handle, edit, start: local(e),
      client: { x: e.clientX, y: e.clientY },
      visibleCrop: cropping ? imageVisibleCrop(image, edit, renderedOutline) : undefined,
    };
  };
  const choose = async (file: File) => {
    const ticket = ++replacement.current;
    setReplacing(true);
    setFailed(false);
    try {
      await onReplace(readReplacement(file), () => ticket === replacement.current);
    } catch {
      if (ticket === replacement.current) setFailed(true);
    } finally {
      if (ticket === replacement.current) setReplacing(false);
    }
  };

  const shown = { ...edit, ...provisional };
  const unsavedOutline = provisional && imageVisibleOutline(image, shown, page);
  const matrix = imageMatrix(image, shown);
  const visible = shown.crop ?? fullImage;
  const project = (point: PdfPoint) => imageDisplayPoint(point, page, scale);
  const projectUnit = (point: PdfPoint) => project(mapPoint(matrix, point));
  const polygon = (points: PdfPoint[]) => points.map(p => `${p.x},${p.y}`).join(" ");
  const width = (page.rotation % 180 ? page.heightPt : page.widthPt) * scale;
  const height = (page.rotation % 180 ? page.widthPt : page.heightPt) * scale;
  const outline = (unsavedOutline?.length ? unsavedOutline : renderedOutline).map(project);
  const centre = outline.reduce(({ x, y }, p) => ({ x: x + p.x / outline.length, y: y + p.y / outline.length }),
    { x: 0, y: 0 });
  const closest = (point: PdfPoint) => {
    const distance = (p: PdfPoint) => Math.hypot(p.x - point.x, p.y - point.y);
    return outline.reduce((best, p) => distance(p) < distance(best) ? p : best);
  };
  const minY = Math.min(...outline.map(p => p.y));
  const maxY = Math.max(...outline.map(p => p.y));
  const resize = closest(project(imageResizePoint(image, shown)));
  const handle = (name: ImageHandle, point: PdfPoint, mark: string) => (
    <button type="button" className="sourceImageHandle" data-handle={name}
      aria-label={t(`sourceImage.${name}Handle`)} title={t(`sourceImage.${name}Handle`)}
      style={{ left: edge(point.x, width), top: edge(point.y, height) }}
      onPointerDown={e => begin(e, name)}
      onKeyDown={e => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (!delta || replacing || pending) return;
        e.preventDefault();
        e.stopPropagation();
        if (name === "rotate") {
          onEdit({ angle: (edit?.angle ?? 0) + (delta[0] || delta[1]!) * (e.shiftKey ? 15 : 1) });
        } else {
          const step = e.shiftKey ? 10 : 1;
          onEdit(imageGesturePatch(image, edit, name, imagePagePoint(point, page, scale),
            imagePagePoint({ x: point.x + delta[0]! * step, y: point.y + delta[1]! * step }, page, scale),
            false, cropping ? imageVisibleCrop(image, edit, renderedOutline) : undefined));
        }
      }}><span aria-hidden="true">{mark}</span></button>
  );

  return <div ref={root} className="sourceImageControls" data-source-image-controls="" role="group" aria-label={t("sourceImage.selected")}>
    <svg className="sourceImageOutline" aria-hidden="true" width={width} height={height}>
      {cropping && <polygon className="sourceImageFullOutline" points={polygon(imageRectCorners(fullImage).map(projectUnit))} />}
      <polygon points={polygon(outline)} />
    </svg>
    {cropping ? <>
      {handle("cropStart", closest(projectUnit(visible)), "⌜")}
      {handle("crop", resize, "⌟")}
    </> : <>
      {handle("move", centre, "✥")}
      {handle("resize", resize, "↗")}
      {handle("rotate", { x: centre.x, y: minY - 17 }, "⟳")}
    </>}
    <div className="sourceImageActions" style={{ top: maxY + 52 < height ? Math.max(4, maxY + 12) : Math.max(4, minY - 78) }}>
      <button type="button" aria-pressed={cropping} onClick={() => setCropping(!cropping)}>
        {t(cropping ? "sourceImage.done" : "sourceImage.crop")}
      </button>
      {edit?.crop && <button type="button" disabled={pending} onClick={() => onEdit({ crop: undefined })}>{t("sourceImage.restoreCrop")}</button>}
      <button type="button" disabled={replacing || pending} onClick={() => input.current?.click()}>{t("sourceImage.replace")}</button>
      <button type="button" disabled={pending} onClick={() => onEdit({ delete: true })}>{t("sourceImage.delete")}</button>
      <input ref={input} hidden type="file" accept="image/png,image/jpeg" aria-label={t("sourceImage.replace")} onChange={e => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = "";
        if (file) void choose(file);
      }} />
      {failed && <span role="status">{t("sourceImage.invalidReplacement")}</span>}
    </div>
  </div>;
}

async function readReplacement(file: File): Promise<NonNullable<SourceImageEditOverlay["replace"]>> {
  assertPdfWithinFileLimit(file.size);
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const mimeType = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => head[i] === byte) ? "image/png" :
    head[0] === 255 && head[1] === 216 && head[2] === 255 ? "image/jpeg" : null;
  if (!mimeType) throw Error("invalid source image replacement");
  const blob = new Blob([file], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const decoded = new Image();
    decoded.src = url;
    await decoded.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { mimeType, dataUrl };
}
