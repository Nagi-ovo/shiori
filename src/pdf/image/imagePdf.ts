import { PDFDocument } from "pdf-lib";

export async function imageBytesToPdf(
  bytes: Uint8Array,
  mimeType: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const image = mimeType === "image/jpeg" || mimeType === "image/jpg"
    ? await doc.embedJpg(new Uint8Array(bytes))
    : await doc.embedPng(new Uint8Array(bytes));
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
  });
  return doc.save();
}
