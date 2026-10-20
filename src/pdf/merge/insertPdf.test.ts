import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from "pdf-lib";
import { openCoreDocument, resolveCoreFiles } from "../../../cli/src/coreEngine";
import { inspectDocumentFiles } from "../export/navigation";
import { insertPdfPages, PdfPageInsertError } from "./insertPdf";

// Where a link lands is read by PDFium through the native addon, which a
// plain `bun run test` may not have; test:core builds it first.
const coreTest = test.skipIf(!existsSync(resolveCoreFiles().addon));

describe("insertPdfPages", () => {
  test("inserts at a page boundary and preserves only the base attachments", async () => {
    const base = await PDFDocument.create();
    base.addPage([300, 400]);
    base.addPage([400, 500]);
    await base.attach(new TextEncoder().encode("BASE-PAYLOAD"), "base.txt", {
      description: "Base attachment",
    });

    const incoming = await PDFDocument.create();
    incoming.addPage([200, 200]);
    incoming.addPage([210, 210]);
    await incoming.attach(
      new TextEncoder().encode("INCOMING-SECRET"),
      "incoming.txt",
    );

    const baseBytes = await base.save();
    const expectedBaseFiles = inspectDocumentFiles(
      await PDFDocument.load(baseBytes),
    );
    const result = await insertPdfPages(
      baseBytes,
      await incoming.save(),
      1,
      "chapters.pdf",
    );
    const loaded = await PDFDocument.load(result.bytes);
    const files = inspectDocumentFiles(loaded);

    expect(result.insertedPageCount).toBe(2);
    expect(loaded.getPages().map((page) => page.getWidth())).toEqual([
      300,
      200,
      210,
      400,
    ]);
    expect(files.fileSpecs).toHaveLength(1);
    expect(files.payloads).toHaveLength(1);
    expect(files.payloads[0]).toEqual(expectedBaseFiles.payloads[0]);
  });

  test("remaps direct links between inserted pages", async () => {
    const base = await onePagePdf(500);
    const incoming = await PDFDocument.create();
    const first = incoming.addPage([200, 200]);
    const second = incoming.addPage([210, 210]);
    addDirectLink(incoming, first.node, second.ref);

    const result = await insertPdfPages(
      await base.save(),
      await incoming.save(),
      0,
    );
    const loaded = await PDFDocument.load(result.bytes);
    const annot = firstAnnotation(loaded, 0);
    const destination = annot.lookup(PDFName.of("Dest"), PDFArray);

    expect(destination.get(0).toString()).toBe(loaded.getPage(1).ref.toString());
  });

  test("namespaces named destinations and keeps their inserted links working", async () => {
    const base = await onePagePdf(500);
    const incoming = await PDFDocument.create();
    const first = incoming.addPage([200, 200]);
    const second = incoming.addPage([210, 210]);
    addNamedDestination(incoming, "chapter-two", second.ref);
    addNamedLink(incoming, first.node, "chapter-two");

    const result = await insertPdfPages(
      await base.save(),
      await incoming.save(),
      1,
      "source.pdf",
    );
    const loaded = await PDFDocument.load(result.bytes);
    const annot = firstAnnotation(loaded, 1);
    const action = annot.lookup(PDFName.of("A"), PDFDict);
    const renamed = action.lookup(PDFName.of("D"), PDFName).decodeText();
    const destinations = loaded.catalog.lookup(PDFName.of("Dests"), PDFDict);
    const target = destinations.lookup(PDFName.of(renamed), PDFArray);

    expect(renamed).toStartWith("Shiori:");
    expect([...renamed].every((character) => character.codePointAt(0)! < 0x80)).toBe(
      true,
    );
    expect(target.get(0).toString()).toBe(loaded.getPage(2).ref.toString());
  });

  const repeatedUnicodeInsert = async () => {
    const base = await onePagePdf(500);
    const incomingBytes = await unicodeNamedDestinationPdf();
    const once = await insertPdfPages(await base.save(), incomingBytes, 1, "来源😀.pdf");
    return (await insertPdfPages(once.bytes, incomingBytes, 3, "来源😀.pdf")).bytes;
  };

  test("keeps repeated Unicode named destinations isolated under ASCII names", async () => {
    const twice = await PDFDocument.load(await repeatedUnicodeInsert());
    const first = linkDestinationName(twice, 1);
    const second = linkDestinationName(twice, 3);
    expect(first).not.toBe(second);
    for (const name of [first, second]) {
      expect([...name].every((character) => character.codePointAt(0)! < 0x80)).toBe(true);
    }
  });

  coreTest("each repeated Unicode named destination still lands on its own copy's page", async () => {
    const twice = await repeatedUnicodeInsert();
    // Pages: base, copy 1 (link, target), base... copy 2 (link, target).
    expect(coreLinkTargetPage(twice, 2)).toBe(3);
    expect(coreLinkTargetPage(twice, 4)).toBe(5);
  });

  const equivalentDestinationsInsert = async () => {
    const base = await onePagePdf(500);
    const incomingBytes = await duplicateNamedDestinationPdf(false);
    const result = await insertPdfPages(await base.save(), incomingBytes, 1, "duplicate-destinations.pdf");
    return { incomingBytes, merged: result.bytes };
  };

  test("accepts equivalent legacy and name-tree named destinations", async () => {
    const { merged } = await equivalentDestinationsInsert();
    expect(linkDestinationName(await PDFDocument.load(merged), 1)).toStartWith("Shiori:");
  });

  coreTest("an equivalent legacy and name-tree destination keeps landing on its page", async () => {
    const { incomingBytes, merged } = await equivalentDestinationsInsert();
    expect(coreLinkTargetPage(incomingBytes, 1)).toBe(2);
    expect(coreLinkTargetPage(merged, 2)).toBe(3);
  });

  coreTest("PDFium resolves the conflicting fixture's link through the name tree", async () => {
    // Readers give /Names/Dests precedence over the legacy Catalog /Dests,
    // so the original link targets source page 3, not the legacy page 2:
    // a merge that kept only one of them would move the link.
    expect(coreLinkTargetPage(await duplicateNamedDestinationPdf(true), 1)).toBe(3);
  });

  test("rejects conflicting legacy and name-tree named destinations", async () => {
    const base = await onePagePdf(500);
    const incomingBytes = await duplicateNamedDestinationPdf(true);
    const error = await insertPdfPages(
      await base.save(),
      incomingBytes,
      1,
      "conflicting-destinations.pdf",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PdfPageInsertError);
    expect((error as PdfPageInsertError).code).toBe("navigation");
  });

  test("shifts base page labels and numeric links around the inserted pages", async () => {
    const base = await PDFDocument.create();
    const baseFirst = base.addPage([500, 300]);
    base.addPage([510, 300]);
    addNumericLink(base, baseFirst.node, 1);
    const labels = base.context.obj({
      Nums: [
        0,
        base.context.obj({ S: "r" }),
        1,
        base.context.obj({ S: "D" }),
      ],
    });
    base.catalog.set(PDFName.of("PageLabels"), base.context.register(labels));

    const incoming = await PDFDocument.create();
    const incomingFirst = incoming.addPage([200, 300]);
    incoming.addPage([210, 300]);
    addNumericLink(incoming, incomingFirst.node, 1);

    const result = await insertPdfPages(
      await base.save(),
      await incoming.save(),
      1,
    );
    const loaded = await PDFDocument.load(result.bytes);
    const baseDestination = firstAnnotation(loaded, 0).lookup(
      PDFName.of("Dest"),
      PDFArray,
    );
    const insertedDestination = firstAnnotation(loaded, 1).lookup(
      PDFName.of("Dest"),
      PDFArray,
    );
    const pageLabels = loaded.catalog.lookup(PDFName.of("PageLabels"), PDFDict);
    const nums = pageLabels.lookup(PDFName.of("Nums"), PDFArray);

    expect(baseDestination.lookup(0, PDFNumber).asNumber()).toBe(3);
    expect(insertedDestination.lookup(0, PDFNumber).asNumber()).toBe(2);
    expect(nums.lookup(0, PDFNumber).asNumber()).toBe(0);
    expect(nums.lookup(2, PDFNumber).asNumber()).toBe(3);
  });

  test("remaps GoTo actions nested in base page and annotation additional actions", async () => {
    const base = await PDFDocument.create();
    const first = base.addPage([500, 300]);
    base.addPage([510, 300]);
    base.addPage([520, 300]);
    const pageAction = base.context.obj({ S: "GoTo", D: [2, PDFName.of("Fit")] });
    first.node.set(
      PDFName.of("AA"),
      base.context.obj({ O: base.context.register(pageAction) }),
    );
    const annotationAction = base.context.obj({
      S: "GoTo",
      D: [1, PDFName.of("Fit")],
    });
    const chainedAction = base.context.obj({
      S: "URI",
      URI: PDFString.of("https://example.com"),
      Next: base.context.obj({ S: "GoTo", D: [2, PDFName.of("Fit")] }),
    });
    const annotation = base.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 0, 100, 20],
      A: chainedAction,
      AA: { E: base.context.register(annotationAction) },
    });
    first.node.set(
      PDFName.of("Annots"),
      base.context.obj([base.context.register(annotation)]),
    );

    const incoming = await onePagePdf(200);
    const result = await insertPdfPages(
      await base.save(),
      await incoming.save(),
      1,
    );
    const loaded = await PDFDocument.load(result.bytes);
    const pageAA = loaded.getPage(0).node.lookup(PDFName.of("AA"), PDFDict);
    const remappedPageAction = pageAA.lookup(PDFName.of("O"), PDFDict);
    const loadedAnnot = firstAnnotation(loaded, 0);
    const annotAA = loadedAnnot.lookup(PDFName.of("AA"), PDFDict);
    const remappedAnnotAction = annotAA.lookup(PDFName.of("E"), PDFDict);
    const rootAction = loadedAnnot.lookup(PDFName.of("A"), PDFDict);
    const nextAction = rootAction.lookup(PDFName.of("Next"), PDFDict);

    expect(actionTargetIndex(remappedPageAction)).toBe(3);
    expect(actionTargetIndex(remappedAnnotAction)).toBe(2);
    expect(actionTargetIndex(nextAction)).toBe(3);
  });

  test("fails closed for an invalid base additional-action structure", async () => {
    const base = await onePagePdf(500);
    base.getPage(0).node.set(PDFName.of("AA"), PDFString.of("broken"));
    const incoming = await onePagePdf(200);

    const error = await insertPdfPages(
      await base.save(),
      await incoming.save(),
      0,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PdfPageInsertError);
    expect((error as PdfPageInsertError).code).toBe("navigation");
  });

  test("rejects imported additional actions and chained actions before copying", async () => {
    const base = await onePagePdf(500);
    const pageAA = await onePagePdf(200);
    pageAA.getPage(0).node.set(
      PDFName.of("AA"),
      pageAA.context.obj({
        O: pageAA.context.obj({ S: "GoTo", D: [0, PDFName.of("Fit")] }),
      }),
    );

    const annotationAA = await onePagePdf(200);
    const annotationWithAA = annotationAA.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 0, 100, 20],
      AA: {
        E: annotationAA.context.obj({
          S: "URI",
          URI: PDFString.of("javascript:alert(document.domain)"),
        }),
      },
    });
    annotationAA.getPage(0).node.set(
      PDFName.of("Annots"),
      annotationAA.context.obj([
        annotationAA.context.register(annotationWithAA),
      ]),
    );

    const chained = await onePagePdf(200);
    const rootAction = chained.context.obj({
      S: "GoTo",
      D: [0, PDFName.of("Fit")],
      Next: chained.context.obj({
        S: "URI",
        URI: PDFString.of("data:text/html,<script>alert(1)</script>"),
      }),
    });
    const annotationWithChain = chained.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [0, 0, 100, 20],
      A: rootAction,
    });
    chained.getPage(0).node.set(
      PDFName.of("Annots"),
      chained.context.obj([
        chained.context.register(annotationWithChain),
      ]),
    );

    for (const incoming of [pageAA, annotationAA, chained]) {
      const error = await insertPdfPages(
        await base.save(),
        await incoming.save(),
        1,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PdfPageInsertError);
      expect((error as PdfPageInsertError).code).toBe("interactive");
    }
  });

  test("rejects signed base PDFs through Perms and recursive signature fields", async () => {
    const withPerms = await onePagePdf(500);
    withPerms.catalog.set(
      PDFName.of("Perms"),
      withPerms.context.obj({ DocMDP: withPerms.context.obj({ Type: "Sig" }) }),
    );
    const withSignatureField = await onePagePdf(500);
    const signature = withSignatureField.context.register(
      withSignatureField.context.obj({ FT: "Sig" }),
    );
    const parent = withSignatureField.context.register(
      withSignatureField.context.obj({ Kids: [signature] }),
    );
    withSignatureField.catalog.set(
      PDFName.of("AcroForm"),
      withSignatureField.context.obj({ Fields: [parent] }),
    );
    const incoming = await onePagePdf(200);

    for (const base of [withPerms, withSignatureField]) {
      const error = await insertPdfPages(
        await base.save(),
        await incoming.save(),
        1,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PdfPageInsertError);
      expect((error as PdfPageInsertError).code).toBe("baseSigned");
    }
  });

  test("keeps ordinary unsigned base form fields intact", async () => {
    const base = await onePagePdf(500);
    const field = base.getForm().createTextField("reader");
    field.setText("Shiori");
    field.addToPage(base.getPage(0));
    const incoming = await onePagePdf(200);

    const result = await insertPdfPages(
      await base.save(),
      await incoming.save(),
      1,
    );
    const loaded = await PDFDocument.load(result.bytes);

    expect(loaded.getForm().getTextField("reader").getText()).toBe("Shiori");
  });

  test("preserves ordinary web links but rejects executable actions", async () => {
    const base = await onePagePdf(500);
    const linked = await onePagePdf(200);
    addActionLink(linked, "URI", { URI: PDFString.of("https://example.com") });

    const result = await insertPdfPages(
      await base.save(),
      await linked.save(),
      1,
    );
    const loaded = await PDFDocument.load(result.bytes);
    const action = firstAnnotation(loaded, 1).lookup(PDFName.of("A"), PDFDict);
    expect(action.lookup(PDFName.of("S"), PDFName).decodeText()).toBe("URI");
    expect(action.lookup(PDFName.of("URI"), PDFString).decodeText()).toBe(
      "https://example.com",
    );

    const executable = await onePagePdf(200);
    addActionLink(executable, "JavaScript", {
      JS: PDFString.of("app.alert('no')"),
    });
    const error = await insertPdfPages(
      await base.save(),
      await executable.save(),
      1,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PdfPageInsertError);
    expect((error as PdfPageInsertError).code).toBe("interactive");

    for (const unsafeUri of [
      "javascript:alert(document.domain)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
    ]) {
      const unsafe = await onePagePdf(200);
      addActionLink(unsafe, "URI", { URI: PDFString.of(unsafeUri) });
      const unsafeError = await insertPdfPages(
        await base.save(),
        await unsafe.save(),
        1,
      ).catch((caught: unknown) => caught);
      expect(unsafeError).toBeInstanceOf(PdfPageInsertError);
      expect((unsafeError as PdfPageInsertError).code).toBe("interactive");
    }

    const mail = await onePagePdf(200);
    addActionLink(mail, "URI", { URI: PDFString.of("mailto:reader@example.com") });
    await expect(insertPdfPages(await base.save(), await mail.save(), 1)).resolves.toMatchObject(
      { insertedPageCount: 1 },
    );
  });

  test("keeps indirect numeric destinations and fails for unknown direct targets", async () => {
    const base = await onePagePdf(500);
    const numeric = await onePagePdf(200);
    const numberRef = numeric.context.register(PDFNumber.of(0));
    addRawDestinationLink(numeric, numberRef);

    const result = await insertPdfPages(
      await base.save(),
      await numeric.save(),
      1,
    );
    const loaded = await PDFDocument.load(result.bytes);
    const destination = firstAnnotation(loaded, 1).lookup(
      PDFName.of("Dest"),
      PDFArray,
    );
    expect(destination.lookup(0, PDFNumber).asNumber()).toBe(1);

    const unknown = await onePagePdf(200);
    const orphan = unknown.context.register(unknown.context.obj({ Type: "NotAPage" }));
    addRawDestinationLink(unknown, orphan);
    const error = await insertPdfPages(
      await base.save(),
      await unknown.save(),
      1,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PdfPageInsertError);
    expect((error as PdfPageInsertError).code).toBe("navigation");
  });

  test("fails closed for cyclic and over-deep destination dictionaries", async () => {
    const incoming = await onePagePdf(200);

    const cyclic = await onePagePdf(500);
    const cycle = PDFDict.withContext(cyclic.context);
    const cycleRef = cyclic.context.register(cycle);
    cycle.set(PDFName.of("D"), cycleRef);
    const cyclicDests = PDFDict.withContext(cyclic.context);
    cyclicDests.set(PDFName.of("loop"), cycleRef);
    cyclic.catalog.set(PDFName.of("Dests"), cyclicDests);

    const deep = await onePagePdf(500);
    let destination: PDFDict | PDFArray = deep.context.obj([
      deep.getPage(0).ref,
      PDFName.of("Fit"),
    ]);
    for (let index = 0; index < 70; index += 1) {
      destination = deep.context.obj({ D: destination });
    }
    const deepDests = PDFDict.withContext(deep.context);
    deepDests.set(PDFName.of("deep"), destination);
    deep.catalog.set(PDFName.of("Dests"), deepDests);

    for (const base of [cyclic, deep]) {
      const error = await insertPdfPages(
        await base.save(),
        await incoming.save(),
        0,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PdfPageInsertError);
      expect((error as PdfPageInsertError).code).toBe("navigation");
    }
  });

  test("fails closed for an encrypted incoming PDF", async () => {
    const base = await onePagePdf(500);
    const incoming = await onePagePdf(200);
    const encrypt = PDFDict.withContext(incoming.context);
    encrypt.set(PDFName.of("Filter"), PDFName.of("Standard"));
    encrypt.set(PDFName.of("V"), PDFNumber.of(2));
    encrypt.set(PDFName.of("R"), PDFNumber.of(3));
    encrypt.set(PDFName.of("P"), PDFNumber.of(-1));
    incoming.context.trailerInfo.Encrypt = incoming.context.register(encrypt);

    const error = await insertPdfPages(
      await base.save(),
      await incoming.save(),
      1,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PdfPageInsertError);
    expect((error as PdfPageInsertError).code).toBe("encryptedIncoming");
  });

  test("rejects an out-of-range insertion position", async () => {
    const base = await onePagePdf(500);
    const incoming = await onePagePdf(200);

    const error = await insertPdfPages(
      await base.save(),
      await incoming.save(),
      2,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PdfPageInsertError);
    expect((error as PdfPageInsertError).code).toBe("invalidPosition");
  });
});

async function onePagePdf(width: number): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  document.addPage([width, 300]);
  return document;
}

function addDirectLink(
  document: PDFDocument,
  page: PDFDict,
  target: ReturnType<PDFDocument["getPage"]>["ref"],
) {
  const destination = document.context.obj([
    target,
    PDFName.of("XYZ"),
    null,
    null,
    null,
  ]);
  const annotation = document.context.obj({
    Type: "Annot",
    // Legal but uncommon indirect name: the insertion path must use resolved
    // semantics, not `toString()` on the reference.
    Subtype: document.context.register(PDFName.of("Link")),
    Rect: [0, 0, 100, 20],
    Dest: destination,
  });
  page.set(
    PDFName.of("Annots"),
    document.context.obj([document.context.register(annotation)]),
  );
}

function addRawDestinationLink(
  document: PDFDocument,
  target: PDFRef,
) {
  const annotation = document.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [0, 0, 100, 20],
    Dest: [target, PDFName.of("Fit")],
  });
  document.getPage(0).node.set(
    PDFName.of("Annots"),
    document.context.obj([document.context.register(annotation)]),
  );
}

function addNamedDestination(
  document: PDFDocument,
  name: string,
  target: ReturnType<PDFDocument["getPage"]>["ref"],
) {
  const destinations = PDFDict.withContext(document.context);
  destinations.set(
    PDFName.of(name),
    document.context.obj([target, PDFName.of("Fit")]),
  );
  document.catalog.set(PDFName.of("Dests"), destinations);
}

async function unicodeNamedDestinationPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const first = document.addPage([200, 200]);
  const second = document.addPage([210, 210]);
  const name = "章节二😀";
  const destinationTree = document.context.obj({
    Names: [
      PDFHexString.fromText(name),
      document.context.obj([second.ref, PDFName.of("Fit")]),
    ],
  });
  document.catalog.set(
    PDFName.of("Names"),
    document.context.obj({ Dests: document.context.register(destinationTree) }),
  );
  addNamedLink(document, first.node, name, true);
  return document.save();
}

async function duplicateNamedDestinationPdf(
  conflicting: boolean,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const first = document.addPage([200, 200]);
  const legacyTarget = document.addPage([210, 210]);
  const nameTreeTarget = conflicting
    ? document.addPage([220, 220])
    : legacyTarget;
  const name = "shared-target";

  const legacy = PDFDict.withContext(document.context);
  legacy.set(
    PDFName.of(name),
    document.context.obj([legacyTarget.ref, PDFName.of("Fit")]),
  );
  document.catalog.set(PDFName.of("Dests"), legacy);

  const destinationTree = document.context.obj({
    Names: [
      PDFString.of(name),
      document.context.obj([nameTreeTarget.ref, PDFName.of("Fit")]),
    ],
  });
  document.catalog.set(
    PDFName.of("Names"),
    document.context.obj({ Dests: document.context.register(destinationTree) }),
  );
  addNamedLink(document, first.node, name);
  return document.save();
}

function addNumericLink(
  document: PDFDocument,
  page: PDFDict,
  targetIndex: number,
) {
  const annotation = document.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [0, 0, 100, 20],
    Dest: [targetIndex, PDFName.of("Fit")],
  });
  page.set(
    PDFName.of("Annots"),
    document.context.obj([document.context.register(annotation)]),
  );
}

function addNamedLink(
  document: PDFDocument,
  page: PDFDict,
  name: string,
  unicode = false,
) {
  const action = document.context.obj({
    S: "GoTo",
    D: unicode ? PDFHexString.fromText(name) : PDFString.of(name),
  });
  const annotation = document.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [0, 0, 100, 20],
    A: action,
  });
  page.set(
    PDFName.of("Annots"),
    document.context.obj([document.context.register(annotation)]),
  );
}

function actionTargetIndex(action: PDFDict): number {
  return action
    .lookup(PDFName.of("D"), PDFArray)
    .lookup(0, PDFNumber)
    .asNumber();
}

/** The named destination the first link on page `pageIndex` (0-based) goes to, read with pdf-lib. */
function linkDestinationName(document: PDFDocument, pageIndex: number): string {
  const annotation = firstAnnotation(document, pageIndex);
  const action = annotation.lookup(PDFName.of("A"));
  const name = action instanceof PDFDict ? action.lookup(PDFName.of("D")) : annotation.lookup(PDFName.of("Dest"));
  // A name object, as the merge writes it, or a string, as files often do.
  if (!(name instanceof PDFName || name instanceof PDFString || name instanceof PDFHexString)) {
    throw new Error(`Page ${pageIndex + 1} has no named link destination`);
  }
  return name.decodeText();
}

/** The page (1-based) PDFium resolves the first link on page `pageNumber` to. */
function coreLinkTargetPage(bytes: Uint8Array, pageNumber: number): number {
  const core = openCoreDocument(bytes);
  try {
    const destination = core.links(pageNumber - 1)[0]?.destination;
    if (!destination) throw new Error(`Page ${pageNumber} has no link to a page`);
    return destination.pageIndex + 1;
  } finally {
    core.close();
  }
}

function addActionLink(
  document: PDFDocument,
  actionType: string,
  entries: Record<string, PDFString>,
) {
  const action = document.context.obj({ S: actionType, ...entries });
  const annotation = document.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [0, 0, 100, 20],
    A: action,
  });
  document.getPage(0).node.set(
    PDFName.of("Annots"),
    document.context.obj([document.context.register(annotation)]),
  );
}

function firstAnnotation(document: PDFDocument, pageIndex: number): PDFDict {
  const annots = document
    .getPage(pageIndex)
    .node.lookup(PDFName.of("Annots"), PDFArray);
  return annots.lookup(0, PDFDict);
}
