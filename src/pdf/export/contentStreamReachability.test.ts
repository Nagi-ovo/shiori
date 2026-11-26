import { expect, test } from "bun:test";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, type PDFRef } from "pdf-lib";
import { pageStreamRefs, reachabilityFixture, streamHash } from "./contentStreamReachability.test-support";
import { exportPdf, type ExportMode, type ExportQuality } from "./exportPdf";
import { embeddedFilePayloads, hasPhysicalDocumentFiles } from "./navigation";
import { saveReachablePdf } from "./saveReachablePdf";

const modes = ["annotations", "flatten"] satisfies ExportMode[];
const qualities = ["original", "standard"] satisfies ExportQuality[];

function hashRef(doc: PDFDocument, ref: PDFRef): string {
  return streamHash(doc.context.lookup(ref, PDFRawStream));
}

for (const mode of modes) {
  for (const quality of qualities) {
    test(`${mode}/${quality} reclaims only unreferenced streams after a source-text edit`, async () => {
      const fixture = await reachabilityFixture();
      const source = await PDFDocument.load(fixture.bytes);
      const obsolete = hashRef(source, fixture.obsolete);
      const shared = hashRef(source, fixture.shared);
      const result = await exportPdf(fixture.bytes, fixture.editModel, {
        mode, quality, preserveSourceAnnotations: true,
      });
      expect(result.contentTextOutcomes).toMatchObject([{ mode: "in-place" }]);
      const output = await PDFDocument.load(result.bytes);
      expect(pageStreamRefs(output, 0).map((ref) => hashRef(output, ref))).not.toContain(obsolete);
      expect(output.getPage(0).node.Annots()?.size() ?? 0).toBe(mode === "annotations" ? 1 : 0);
      const fonts = output.getPage(0).node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
      for (const [, ref] of fonts.entries()) {
        expect(output.context.lookup(ref)).toBeInstanceOf(PDFDict);
      }

      const firstSibling = pageStreamRefs(output, 1);
      expect(pageStreamRefs(output, 2)).toEqual(firstSibling);
      expect(firstSibling.map((ref) => hashRef(output, ref))).toContain(shared);

      const names = (key: string) => PDFName.of(key);
      const stamp = output.getPage(1).node.lookup(names("Annots"), PDFArray).lookup(0, PDFDict);
      const form = stamp.lookup(names("AP"), PDFDict).lookup(names("N"), PDFRawStream);
      expect(streamHash(form)).toBe(hashRef(source, fixture.appearance));
      const mark = form.dict.lookup(names("Resources"), PDFDict).lookup(names("XObject"), PDFDict);
      expect(streamHash(mark.lookup(names("Mark"), PDFRawStream))).toBe(hashRef(source, fixture.paintedMark));
      expect(streamHash(output.catalog.lookup(names("Metadata"), PDFRawStream))).toBe(hashRef(source, fixture.metadata));
      const tags = output.catalog.lookup(names("StructTreeRoot"), PDFDict);
      expect(tags.lookup(names("K"), PDFArray).lookup(0, PDFDict).lookup(names("P"))).toBe(tags);
      expect(output.getTitle()).toBe(source.getTitle());
      expect(embeddedFilePayloads(output)).toEqual(embeddedFilePayloads(source));

      // The parser expands object streams and enumerates even unreferenced
      // indirect stream objects, including those outside every page tree.
      const hashes = output.context.enumerateIndirectObjects().flatMap(([, object]) =>
        object instanceof PDFRawStream ? [streamHash(object)] : [],
      );
      expect(hashes.filter((hash) => hash === shared)).toHaveLength(1);
      expect(hashes).not.toContain(obsolete);
    });
  }
}

test("source-text stream cleanup respects original-only and attachment policies", async () => {
  const fixture = await reachabilityFixture();
  const source = await PDFDocument.load(fixture.bytes);
  const original = await exportPdf(fixture.bytes, { ...fixture.editModel, overlays: [] }, {
    preserveSourceAnnotations: true,
  });
  expect(original.bytes).toEqual(fixture.bytes);

  const none = await exportPdf(fixture.bytes, fixture.editModel, { mode: "none" });
  const withoutAnnotations = await PDFDocument.load(none.bytes);
  expect(pageStreamRefs(withoutAnnotations, 0).map((ref) => hashRef(withoutAnnotations, ref)))
    .toContain(hashRef(source, fixture.obsolete));
  expect(withoutAnnotations.getPage(1).node.Annots()).toBeUndefined();
  expect(embeddedFilePayloads(withoutAnnotations)).toEqual(embeddedFilePayloads(source));

  const omitted = await exportPdf(fixture.bytes, fixture.editModel, { documentFiles: "omit" });
  expect(omitted.contentTextOutcomes).toMatchObject([{ mode: "in-place" }]);
  expect(hasPhysicalDocumentFiles(await PDFDocument.load(omitted.bytes))).toBe(false);
});

test.each(qualities)("%s retains only length objects with live references", async (quality) => {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const { context } = doc;
  const first = context.stream("q Q");
  const second = context.stream("\n");
  const orphanedLength = context.register(PDFNumber.of(first.getContentsSize()));
  const sharedLength = context.register(PDFNumber.of(second.getContentsSize()));
  first.dict.set(PDFName.Length, orphanedLength);
  second.dict.set(PDFName.Length, sharedLength);
  page.node.set(PDFName.of("Contents"), context.obj([context.register(first), context.register(second)]));
  doc.catalog.Pages().set(PDFName.of("Count"), sharedLength);

  const output = await PDFDocument.load(await saveReachablePdf(doc, quality === "standard"));
  expect(output.getPageCount()).toBe(1);
  expect(output.context.lookup(orphanedLength)).toBeUndefined();
  expect(output.catalog.Pages().get(PDFName.of("Count"))).toBe(sharedLength);
  const streams = pageStreamRefs(output, 0).map((ref) => output.context.lookup(ref, PDFRawStream));
  expect(streams.map((stream) => stream.dict.get(PDFName.Length))).toEqual([PDFNumber.of(3), PDFNumber.of(1)]);
  expect(streams.map(streamHash)).toEqual([first, second].map(streamHash));
});
