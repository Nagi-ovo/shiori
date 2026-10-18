export type DocumentPreviewData = {
  imageUrl?: string;
  pageNumber?: number;
  scale?: number;
  textPreview?: string;
  htmlPreview?: string;
};

export function hasDocumentPreviewVisual(
  preview: DocumentPreviewData | null | undefined,
): preview is DocumentPreviewData {
  return Boolean(
    preview?.imageUrl || preview?.htmlPreview || preview?.textPreview,
  );
}
