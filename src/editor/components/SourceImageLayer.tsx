import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { listImmutableSourceImages, type SourceImageInfo } from "../../pdf/export/sourceImages";
import type { PdfPoint } from "../../pdf/model/types";
import { canEditSourceImage, commitSourceImageEdit, findSourceImageEdit, replaceSourceImage, type SourceImagePatch } from "../store/sourceImageEdits";
import { useEditorStore, useEditorStoreApi, type OpenedPdf } from "../store/store";
import { OverlayLayer } from "./OverlayLayer";
import { SourceImageControls } from "./SourceImageControls";
import { useContentTextPreview } from "./contentTextPreviewContext";
import { hitSourceImage, imageVisibleOutline } from "./sourceImageGeometry";

type OverlayProps = ComponentProps<typeof OverlayLayer>;
type Props = OverlayProps & { opened: OpenedPdf; annotations: OverlayProps["overlays"] };
type Candidate = { image?: SourceImageInfo; opened: OpenedPdf; page: Props["page"] };

export function SourceImageLayer({ opened, annotations, ...props }: Props) {
  const { page, scale, overlays } = props;
  const store = useEditorStoreApi();
  const { t } = useTranslation();
  const { imageEdits, imageFailed, imagePending } = useContentTextPreview();
  const shown = useRef(imageEdits);
  useLayoutEffect(() => { shown.current = imageEdits; }, [imageEdits]);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const request = useRef(0);
  const active = useEditorStore(state => canEditSourceImage(state, opened, page) && !state.selectedIds.length);
  const clear = useCallback(() => {
    request.current += 1;
    setCandidate(null);
  }, []);

  useEffect(() => () => { request.current += 1; }, []);

  useEffect(() => {
    if (!candidate) return;
    const unsubscribe = store.subscribe((state, previous) => {
      if (!canEditSourceImage(state, candidate.opened, candidate.page) || state.selectedIds.length ||
          (!candidate.image && (state.model !== previous.model || state.scale !== previous.scale))) clear();
    });
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest("[data-source-image-controls]"))) clear();
    };
    const cancelPending = (event: KeyboardEvent) => {
      if (!candidate.image && event.key === "Escape") clear();
    };
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", cancelPending);
    return () => {
      unsubscribe();
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", cancelPending);
    };
  }, [candidate, clear, store]);

  const onPageTap = useCallback(async (point: PdfPoint) => {
    const before = store.getState();
    if (!canEditSourceImage(before, opened, page)) return;
    const ticket = ++request.current;
    const pending = { opened, page };
    setCandidate(pending);
    try {
      const images = await listImmutableSourceImages(opened.bytes, page.sourceIndex);
      const state = store.getState();
      if (ticket !== request.current) return;
      if (!canEditSourceImage(state, opened, page) || state.model !== before.model ||
          state.selectedIds.length || state.scale !== scale) {
        clear();
        return;
      }
      const image = hitSourceImage(images, shown.current ?? [], page, scale, point);
      setCandidate(image ? { ...pending, image } : null);
    } catch {
      if (ticket === request.current) setCandidate(null);
    }
  }, [clear, opened, page, scale, store]);

  const image = active && candidate?.opened === opened && candidate.page === page ? candidate.image : undefined;
  const edit = image && findSourceImageEdit(overlays, page.id, image);
  const rendered = image && findSourceImageEdit(imageEdits ?? [], page.id, image);
  const outline = image && imageVisibleOutline(image, rendered, page);
  // Keep the store target and history. A retry starts from the geometry and
  // other image properties of the settled frame.
  const retry: SourceImagePatch = edit && edit !== rendered ? {
    rect: rendered?.rect, angle: rendered?.angle, crop: rendered?.crop,
    replace: rendered?.replace, delete: rendered?.delete,
  } : {};
  return <>
    <OverlayLayer {...props} overlays={annotations} onPageTap={onPageTap} />
    {image && !!outline?.length && !edit?.locked && <SourceImageControls
      key={`${image.occurrence}:${scale}`} image={image} page={page} scale={scale} edit={rendered}
      outline={outline} pending={imagePending}
      onDismiss={clear}
      onEdit={patch => {
        const changed = !imagePending && Object.keys(patch).length > 0 && commitSourceImageEdit(store, opened, page, image, edit, { ...retry, ...patch });
        if (patch.delete && changed) clear();
        return changed;
      }}
      onReplace={(pending, stillSelected) => {
        const ticket = request.current;
        return replaceSourceImage(store, opened, page, image, edit, pending,
          () => ticket === request.current && stillSelected(), retry);
      }}
    />}
    {imageFailed && <div className="sourceImageNotice" role="status">{t("sourceImage.previewUnavailable")}</div>}
  </>;
}
