// Settle linked edits before the per-page writers so a refused chain never
// reaches a single-frame writer.
import { PDFName, type PDFPage } from "pdf-lib";
import { hasPageOrigin, overlayToPdfPageSpace, pageOrigin, pdfRectToPageLocal } from "../../../model/pageSpace";
import { isBlankPage, type ContentTextOverlay, type DocumentModel, type Overlay, type PageModel, type PdfRect, type TextFlowChain } from "../../../model/types";
import type { ContentTextOutcome } from "../outcomes";
import type { FlowFootprint } from "../../semantic/editIntent";
import { planFlowOnPage, type CheckFlowSemantics, type FlowPagePlan } from "./flowEngine";
import type { FlowRefusal } from "./flowTypes";
import type { AnchoredAnnotation } from '../../sourceAnnotationAnchors';

export function applyLinkedFlows(
  model: DocumentModel,
  overlays: readonly Overlay[],
  copiedPages: readonly PDFPage[],
  checkFlow?: (overlay: ContentTextOverlay, footprint: FlowFootprint) => ContentTextOutcome | undefined,
  anchorsBySource?: readonly (readonly AnchoredAnnotation[])[],
): { outcomes: ContentTextOutcome[]; settled: Set<string> } {
  const outcomes: ContentTextOutcome[] = [];
  const settled = new Set<string>();
  const linked = overlays.filter((overlay): overlay is ContentTextOverlay & { flowChainId: string } =>
    overlay.type === "contentText" && !!overlay.flowChainId,
  );
  if (!linked.length) return { outcomes, settled };

  let cursor = 0;
  const pages = new Map(model.pages.map((page, index) => [
    page.id, { index, copied: isBlankPage(page) ? undefined : copiedPages[cursor++] },
  ]));
  for (const overlay of linked) {
    settled.add(overlay.id);
    const location = { overlayId: overlay.id, pageIndex: pages.get(overlay.pageId)?.index };
    const refuse = ({ reason, detail, anchoredAnnotations }: Pick<FlowRefusal, 'reason' | 'detail' | 'anchoredAnnotations'>) => {
      outcomes.push({ ...location, mode: "unsupported", reason, ...(detail && { detail }), ...(anchoredAnnotations && { anchoredAnnotations }) });
    };
    const edit = chainEdit({ ...model, overlays: [overlay] }, overlay.flowChainId);
    if ("ok" in edit) {
      refuse(edit);
      continue;
    }
    const page = pages.get(edit.page.id)?.copied;
    if (!page) {
      refuse({ reason: "flow-ambiguous-frame", detail: "the first frame is not exported" });
      continue;
    }
    const plan = planFlowForModelPage(page, edit.page, edit.chain, overlay, footprint =>
      checkFlow?.(overlay, footprint) ? { ok: false, reason: 'semantic-dependency' } : undefined,
    anchorsBySource?.[edit.page.sourceIndex]);
    if (!plan.ok) {
      refuse(plan);
      continue;
    }
    page.node.set(PDFName.of("Contents"), page.doc.context.register(page.doc.context.flateStream(plan.bytes)));
    outcomes.push({ ...location, mode: "retypeset", fidelity: "exact", flow: plan.manifest });
  }
  return { outcomes, settled };
}

/** The chain and its edited first-frame overlay, or a refusal naming why not. */
export function chainEdit(model: DocumentModel, chainId: string): { chain: TextFlowChain; overlay: ContentTextOverlay; page: PageModel } | FlowRefusal {
  const chain = model.flowChains?.find(c => c.id === chainId);
  if (!chain) return { ok: false, reason: 'flow-ambiguous-frame', detail: 'unknown chain' };
  const overlay = model.overlays.find((o): o is ContentTextOverlay => o.type === 'contentText' && o.flowChainId === chainId);
  if (!overlay) return { ok: false, reason: 'flow-ambiguous-frame', detail: 'the chain has no edit' };
  const page = model.pages.find(p => p.id === chain.frames[0]?.pageId);
  if (!page || isBlankPage(page)) return { ok: false, reason: 'flow-ambiguous-frame', detail: 'the first frame has no source page' };
  return { chain, overlay, page };
}

/** Translate from the model's crop-local coordinates before reading the
 * stream, and return move and refusal bounds in the model's coordinates. */
export function planFlowForModelPage(
  page: PDFPage, model: PageModel, chain: TextFlowChain, overlay: ContentTextOverlay, checkSemantics?: CheckFlowSemantics,
  anchors?: readonly AnchoredAnnotation[],
): FlowPagePlan {
  if (!hasPageOrigin(model)) return planFlowOnPage(page, chain, overlay, checkSemantics, anchors);
  const { x, y } = pageOrigin(model);
  const translated = {
    ...chain,
    frames: chain.frames.map(frame => frame.pageId === model.id
      ? { ...frame, rect: { ...frame.rect, x: frame.rect.x + x, y: frame.rect.y + y } }
      : frame),
  };
  const plan = planFlowOnPage(page, translated, overlayToPdfPageSpace(model, overlay), checkSemantics, anchors);
  const local = (rect: PdfRect) => pdfRectToPageLocal(model, rect);
  if (!plan.ok) return plan.blockingRect ? { ...plan, blockingRect: local(plan.blockingRect) } : plan;
  return { ...plan, moves: plan.moves.map(move => ({
    ...move,
    ...(move.beforeRect ? { beforeRect: local(move.beforeRect) } : {}),
    ...(move.afterRect ? { afterRect: local(move.afterRect) } : {}),
  })) };
}
