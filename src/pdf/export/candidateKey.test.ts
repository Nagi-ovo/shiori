import { expect, test } from "bun:test";
import { exportCandidateKey } from "./candidateKey";
import { model, overlay } from "./contentText/fixtures.test-support";
import type { ReflowRequest } from "./contentText/reflowTypes";
import type { ExportOptions } from "./exportPdf";

const address: ReflowRequest["target"] = {
  streamHash: "source", opIndex: 3, itemIndex: 0, byteStart: 0, byteEnd: 1, fontObject: "5 0 R",
};
const box = { x: 1, y: 2, w: 3, h: 4 };
const request: ReflowRequest = {
  paragraph: {
    sourceHash: "source", dependencyHash: "proof", ops: [], lines: [],
    evidence: {
      sourceHash: "source", dependencyHash: "proof", obstacleProofHash: "obstacles",
      boundaryProofHash: "boundaries", scopeProofHash: "scope", completeScene: true,
      readingOrder: "proven", whitespace: "source-codes", structure: "body-text",
      columnBoundary: "proven", semantics: "plain", inlineFeatures: "plain-prose",
      crop: box, clip: box, obstacles: [],
    },
  },
  dependencyHash: "proof", target: address,
  sourceInk: [], replacementInk: [{ unicode: "X", code: Uint8Array.of(88), box, proofHash: "glyph" }],
  softBreaks: [],
};

test("equivalent model, byte views, and map copies share a default review key", () => {
  const doc = model([overlay()]);
  const bytes = Uint8Array.of(0, 1, 2, 0).subarray(1, 3);
  const font = Uint8Array.of(17, 18);
  const other = { ...request, dependencyHash: "other proof" };
  const options: ExportOptions = { unicodeFontBytes: font, reflowRequests: new Map([["edit", request], ["other", other]]) };
  expect(exportCandidateKey(bytes, doc, options)).toBe(exportCandidateKey(Uint8Array.of(1, 2), structuredClone(doc), {
    acceptance: "review", unicodeFontBytes: font.slice(),
    reflowRequests: new Map([["other", structuredClone(other)], ["edit", structuredClone(request)]]),
  }));
});

test("source, page order, overlays, effective settings, and supplied services invalidate candidates", () => {
  const doc = model([overlay(), overlay({ id: "second" })]);
  doc.pages.push({ ...doc.pages[0]!, id: "extra", sourceIndex: 1 });
  const bytes = Uint8Array.of(1, 2);
  const loadFont = async () => Uint8Array.of(2);
  const readSourceGlyphs = async () => [];
  const options: ExportOptions = {
    unicodeFontBytes: Uint8Array.of(17, 18),
    reflowRequests: new Map([["edit", request]]),
    inPlaceFallback: { loadFont }, readSourceGlyphs,
  };
  const key = exportCandidateKey(bytes, doc, options);
  expect(exportCandidateKey(bytes, doc, { ...options, inPlaceFallback: { loadFont } })).toBe(key);
  bytes[0] = 3;
  expect(exportCandidateKey(bytes, doc, options)).not.toBe(key);
  bytes[0] = 1;
  expect(exportCandidateKey(bytes, { ...doc, pages: doc.pages.toReversed() }, options)).not.toBe(key);
  expect(exportCandidateKey(bytes, { ...doc, overlays: doc.overlays.toReversed() }, options)).not.toBe(key);
  for (const patch of [{ text: "ABCDE" }, { fontSize: 11 }, { fontFamily: "sans" }] as const) {
    expect(exportCandidateKey(bytes, { ...doc, overlays: [overlay(patch), doc.overlays[1]!] }, options)).not.toBe(key);
  }
  for (const patch of [
    { acceptance: "strict" }, { stage5Reflow: false }, { stage5Substitute: false },
    { stage5Type1: { sourceReuse: false } }, { mode: "flatten" }, { quality: "standard" },
    { documentFiles: "omit" }, { preserveSourceAnnotations: true },
    { unicodeFontBytes: Uint8Array.of(17, 19) }, { unicodeFontUrl: "font.otf" },
    { inPlaceFallback: { loadFont: async () => Uint8Array.of(2) } },
    { readSourceGlyphs: async () => [] },
    { renderContentText: async () => { throw new Error("renderer"); } },
    { reflowRequests: new Map([["edit", { ...request, softBreaks: [1] }]]) },
    { reflowRequests: new Map([["second", request]]) },
  ] satisfies ExportOptions[]) {
    expect(exportCandidateKey(bytes, doc, { ...options, ...patch })).not.toBe(key);
  }
});

test("local font names and program contents determine export reuse", () => {
  const doc = model([overlay()]);
  const bytes = Uint8Array.of(1, 2);
  const key = (name: string, program: Uint8Array) => exportCandidateKey(bytes, doc, {
    inPlaceFallback: { localFonts: [{ name, bytes: program }] },
  });
  const program = Uint8Array.of(5, 6);
  const original = key("face.ttf", program);
  expect(key("face.ttf", program.slice())).toBe(original);
  expect(key("renamed.ttf", program)).not.toBe(original);
  program[1] = 7;
  expect(key("face.ttf", program)).not.toBe(original);
});
