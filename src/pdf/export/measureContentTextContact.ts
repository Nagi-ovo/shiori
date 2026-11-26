import { PDFDocument, type PDFPage } from "pdf-lib";
import type { ContentTextOverlay, DocumentModel } from "../model/types";
import { assessContentTextPageContact } from "./contentText/contact";
import { retypesetSizeRequest } from "./contentText/retypesetPlan";
import type { ExportOptions } from "./exportPdf";
import type { RebuildResult } from "./rebuildPdf";
import { alignPageTreeWithPdfium } from "./sourcePageTree";

export async function measureContentTextContact(
  originalBytes: Uint8Array,
  model: DocumentModel,
  render: ExportOptions["renderContentText"],
  result: RebuildResult,
) {
  if (!render || !result.contentTextOutcomes?.length) return;
  const edits = new Map<string, ContentTextOverlay>();
  for (const overlay of model.overlays) {
    if (overlay.type === "contentText") edits.set(overlay.id, overlay);
  }
  // Contact probes can allocate temporary forms. Read serialized bytes into
  // disposable documents so those objects never reach the saved candidate.
  let pages: { source: PDFPage[]; output: PDFPage[] } | undefined;
  for (const outcome of result.contentTextOutcomes) {
    const edit = edits.get(outcome.overlayId);
    const pageIndex = outcome.pageIndex;
    if (outcome.mode === "unsupported" || !edit || pageIndex === undefined) continue;
    if (edit.text === edit.originalText && retypesetSizeRequest(edit) === 1 && !outcome.reflow && !outcome.flow) continue;
    if (!pages) {
      const source = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
      alignPageTreeWithPdfium(source);
      const output = await PDFDocument.load(result.bytes);
      pages = { source: source.getPages(), output: output.getPages() };
    }
    const original = pages.source[model.pages[pageIndex]!.sourceIndex];
    outcome.contact = original
      ? await assessContentTextPageContact(original, pages.output[pageIndex]!, edit, render)
      : { kind: "uncertain" };
  }
}
