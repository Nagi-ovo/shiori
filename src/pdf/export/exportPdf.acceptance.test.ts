import { expect, test } from "bun:test";
import { fixture, model, overlay } from "./contentText/fixtures.test-support";
import { exportPdf } from "./exportPdf";
import type { ExportSourceEncryption } from "./encryptedSource";
import type { DocumentModel, TextOverlay } from "../model/types";

const unencodableText: TextOverlay = {
  type: "text", id: "label", pageId: "p", rect: { x: 50, y: 60, w: 130, h: 30 },
  text: "Rain ☂", fontSize: 14, color: "#000000", bold: false, align: "left", fontFamily: "sans",
};

test("classifies the vector writer's actual lost characters under both policies", async () => {
  const { doc } = await fixture();
  const bytes = await doc.save();
  const edited: DocumentModel = { ...model([]), overlays: [unencodableText] };
  const options = { mode: "flatten", quality: "standard" } as const;
  const defaultResult = await exportPdf(bytes, edited, options);
  const review = await exportPdf(bytes.slice(), structuredClone(edited), { ...options, acceptance: "review" });
  const strict = await exportPdf(bytes, edited, { ...options, acceptance: "strict" });

  expect(review.lostChars).toBe(1);
  expect(review.acceptance).toMatchObject({
    policy: "review", status: "needs-review", findings: [{ kind: "lost-text", count: 1 }],
  });
  expect(defaultResult.acceptance).toEqual(review.acceptance);
  expect(strict.acceptance).toMatchObject({ policy: "strict", status: "refused", findings: review.acceptance.findings });
  expect(strict.acceptance.key).not.toBe(review.acceptance.key);
});

test("an unchanged export is accepted and returns the source bytes", async () => {
  const { doc } = await fixture();
  const bytes = await doc.save();
  const result = await exportPdf(bytes, model([]));
  expect(result.bytes).toEqual(bytes);
  expect(result.acceptance).toEqual({
    policy: "review", status: "accepted", findings: [], notes: [], key: expect.any(String),
  });
});

test("content text outcomes identify their output page after pages move", async () => {
  const { doc } = await fixture();
  const original = model([overlay()]);
  const result = await exportPdf(await doc.save(), {
    ...original,
    pages: [{ ...original.pages[0]!, id: "blank", sourceIndex: -1 }, ...original.pages],
  });
  expect(result.contentTextOutcomes).toMatchObject([{ overlayId: "edit", mode: "in-place", pageIndex: 1 }]);
  expect(result.acceptance.status).toBe("accepted");
});

test("an encrypted export classifies pass-through and rewritten bytes", async () => {
  const { doc } = await fixture();
  const plain = await doc.save();
  const source = Uint8Array.of(1, 2, 3);
  const ciphertext = Uint8Array.of(4, 5, 6);
  const encryption: ExportSourceEncryption = {
    security: null,
    plaintext: async () => plain,
    encrypt: async () => ciphertext,
  };
  const options = { sourceEncryption: encryption, mode: "flatten", quality: "standard" } as const;
  const unchanged = await exportPdf(source, model([]), options);
  expect(unchanged.bytes).toEqual(source);
  expect(unchanged.acceptance.status).toBe("accepted");
  const other = await exportPdf(Uint8Array.of(1, 2, 4), model([]), options);
  expect(other.acceptance.key).not.toBe(unchanged.acceptance.key);

  const rebuilt = await exportPdf(source, { ...model([]), overlays: [unencodableText] }, options);
  expect(rebuilt.bytes).toEqual(ciphertext);
  expect(rebuilt.acceptance).toMatchObject({
    status: "needs-review", findings: [{ kind: "lost-text", count: 1 }],
  });
});
