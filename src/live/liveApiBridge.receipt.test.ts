import "../test/buildGlobals";
import { describe, expect, test } from "bun:test";
import type { Overlay, PageModel } from "../pdf/model/types";
import type { LiveApiAnnotationRequest } from "../platform/liveApi";
import {
  applyLiveAnnotationRequest,
  type ActiveLivePdf,
} from "./liveApiBridge";

const OPERATION_ID = "d".repeat(64);
const PAGE_TOPOLOGY_HASH = "e".repeat(64);
const pages: PageModel[] = [
  { id: "page-a", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
];
const callout: Overlay = {
  type: "callout",
  id: "c1",
  pageId: "page-a",
  targetRects: [{ x: 72, y: 650, w: 120, h: 20 }],
  rect: { x: 250, y: 620, w: 144, h: 54 },
  text: "Where do these bounds come from?",
  fontSize: 12,
  color: "#b13a2e",
  bold: false,
  align: "left",
  fontFamily: "sans",
};

function access(receipt: boolean, overlays: Overlay[]): ActiveLivePdf {
  const pdf = {
    documentId: "tab-a",
    sha256: "abc",
    pageTopologyHash: PAGE_TOPOLOGY_HASH,
    pages,
    overlays,
    commitOverlays: () => undefined,
    hasOperationReceipt: () => receipt,
    isCurrentSnapshot: () => true,
  } as unknown as ActiveLivePdf;
  pdf.prepareOverlayCommit = () => () => true;
  return pdf;
}

function request(spec: unknown): LiveApiAnnotationRequest {
  return {
    requestId: "request-1",
    operationId: OPERATION_ID,
    expiresAtMs: Date.now() + 30_000,
    target: {
      documentId: "tab-a",
      sha256: "abc",
      pageTopologyHash: PAGE_TOPOLOGY_HASH,
    },
    dryRun: false,
    spec,
  };
}

const noteSpec = {
  annotations: [
    { type: "note", page: 1, at: { x: 20, y: 30 }, text: "again", color: "#f6c744" },
  ],
};
const replySpec = {
  annotations: [{ type: "calloutReply", replyTo: "c1", text: "again" }],
};

// The operation id is a hash of the spec, and its receipt outlives Undo and a
// discarded draft so a lost-response retry can never resurrect work the user
// removed. The same spec sent again on purpose lands on that receipt too:
// nothing is added, and the result has to say why instead of reading like an
// ordinary "Applied 0".
describe("live annotate on an operation receipt", () => {
  test("flags an overlay spec the receipt suppressed", () => {
    const result = applyLiveAnnotationRequest(request(noteSpec), {
      getActivePdf: () => access(true, []),
    });
    expect(result).toMatchObject({
      ok: true,
      data: { added: 0, alreadyApplied: true },
    });
  });

  test("flags a reply spec the receipt suppressed", () => {
    const result = applyLiveAnnotationRequest(request(replySpec), {
      getActivePdf: () => access(true, [callout]),
    });
    expect(result).toMatchObject({
      ok: true,
      data: { added: 0, alreadyApplied: true },
    });
  });

  test("leaves a fresh operation unflagged", () => {
    for (const [spec, overlays] of [
      [noteSpec, []],
      [replySpec, [callout]],
    ] as const) {
      const result = applyLiveAnnotationRequest(request(spec), {
        getActivePdf: () => access(false, [...overlays]),
      });
      expect(result).toMatchObject({ ok: true, data: { added: 1 } });
      if (!result.ok) throw new Error("expected success");
      expect("alreadyApplied" in result.data).toBe(false);
    }
  });
});
