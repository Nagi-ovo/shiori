import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { renderFixtureRegion } from "../../../../../scripts/pdf-inplace/fixtureRaster.test-support";
import { buildContentTextPreview } from "../../../../editor/components/contentTextPreview";
import type { ContentTextOverlay, DocumentModel } from "../../../model/types";
import { pdfRectToPageLocal } from "../../../model/pageSpace";
import { exportPdf } from "../../exportPdf";
import { planLinkedFlow } from "./flowPlan";
import { buildFlow } from "./linkedFlow.test-support";

// A linked edit can be reported on the wrong output page after selection or
// reordering, escape strict acceptance, or lose its frames on a cropped page.
test.skipIf(!Bun.which("pdftoppm"))("a first-frame collision in linked text is reviewed and rolled back by strict export", async () => {
  const { bytes, model } = await buildFlow({
    first: ["I"], second: ["Use the east stair."], edit: "X", face: "Mono",
    rule: { x: 60.5, y: 466.5, w: 1.5, h: 1 },
  }, readFileSync);
  const page = model.pages[0]!;
  const edit = model.overlays[0] as ContentTextOverlay;
  const options = { renderContentText: renderFixtureRegion } as const;
  const reordered = { ...model, pages: [{ ...page, sourceIndex: -1, id: "blank" }, page] };
  const verdict = { kind: "new-collision", overlayId: edit.id, pageIndex: 1, region: expect.any(Object) };
  const review = await exportPdf(bytes, reordered, options);
  expect(review.contentTextOutcomes).toMatchObject([{ mode: "retypeset", pageIndex: 1, flow: { chainId: "chain-1" } }]);
  expect(review.acceptance.findings).toContainEqual(verdict);

  const strictOptions = { ...options, acceptance: "strict" } as const;
  const strict = await exportPdf(bytes, model, strictOptions);
  expect(strict.bytes).toEqual(bytes);
  expect(strict.contentTextOutcomes).toMatchObject([{ mode: "unsupported", reason: "acceptance-strict", pageIndex: 0 }]);
  expect(strict.acceptance.findings).toContainEqual({ ...verdict, pageIndex: 0 });

  const preview = await buildContentTextPreview(bytes, page, [edit], undefined, undefined, {
    ...strictOptions, flowChains: model.flowChains,
  });
  expect(preview.bytes).toBeNull();
  expect(preview.acceptance.findings).toEqual(strict.acceptance.findings);
});

test("linked flow agrees with its dry run on a page with an offset crop", async () => {
  const f = await buildFlow({
    first: ["The lift is out of service."], second: ["Use the east stair."], edit: "The lift is closed.",
  }, readFileSync);
  const pdf = await PDFDocument.load(f.bytes);
  pdf.getPage(0).setCropBox(40, 80, 350, 450);
  const bytes = await pdf.save();
  const page = { ...f.model.pages[0]!, originXPt: 40, originYPt: 80, widthPt: 350, heightPt: 450 };
  const edit = f.model.overlays[0] as ContentTextOverlay;
  const local = (rect: typeof edit.rect) => pdfRectToPageLocal(page, rect);
  const model: DocumentModel = {
    pages: [page],
    overlays: [{ ...edit, rect: local(edit.rect), coverRects: edit.coverRects.map(local),
      sourceBaselinesPt: edit.sourceBaselinesPt?.map(y => y - page.originYPt) }],
    flowChains: f.model.flowChains!.map(chain => ({
      ...chain, frames: chain.frames.map(frame => ({ ...frame, rect: local(frame.rect) })),
    })),
  };
  const plan = await planLinkedFlow(bytes, model, "chain-1");
  expect(plan).toMatchObject({ ok: true, moves: [{ kind: "rewrite" }] });
  if (!plan.ok) throw Error(plan.reason);
  expect(plan.moves[0]!.afterRect!.x).toBeLessThan(model.flowChains![0]!.frames[0]!.rect.x + 10);
  const exported = await exportPdf(bytes, model);
  expect(exported.contentTextOutcomes).toMatchObject([{ mode: "retypeset", flow: { framesChanged: ["frame-0"] } }]);
});
