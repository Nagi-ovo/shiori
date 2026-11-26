import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { PDFArray, PDFName, PDFRawStream, PDFRef, PDFString, type PDFDocument, decodePDFRawStream } from "pdf-lib";
import type { DocumentModel } from "../model/types";
import { fixture, overlay } from "./contentText/fixtures.test-support";

export async function reachabilityFixture() {
  const { doc, page } = await fixture();
  const context = doc.context;
  const contentsKey = PDFName.of("Contents");
  const [obsolete] = pageStreamRefs(doc, 0);
  const resources = page.node.Resources()!;
  const shared = context.register(context.flateStream("BT /F1 10 Tf 50 140 Td (Shared line) Tj ET"));
  page.node.set(contentsKey, context.obj([obsolete!, shared]));
  const siblings = [doc.addPage([300, 200]), doc.addPage([300, 200])];
  for (const sibling of siblings) {
    sibling.node.set(contentsKey, shared);
    sibling.node.set(PDFName.of("Resources"), resources);
  }

  const paintedMark = context.register(context.flateStream("0 0 1 rg 0 0 25 12 re f", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 25, 12], Resources: {},
  }));
  const appearance = context.register(context.flateStream("/Mark Do", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 25, 12],
    Resources: { XObject: { Mark: paintedMark } },
  }));
  const annotation = context.register(context.obj({
    Type: "Annot", Subtype: "Stamp", Rect: [25, 25, 50, 37], AP: { N: appearance },
  }));
  siblings[0]!.node.set(PDFName.of("Annots"), context.obj([annotation]));

  const metadata = context.register(context.flateStream(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>', { Type: "Metadata", Subtype: "XML" },
  ));
  doc.catalog.set(PDFName.of("Metadata"), metadata);
  const structure = context.nextRef();
  const element = context.register(context.obj({
    Type: "StructElem", S: "Document", P: structure, T: PDFString.of("Document structure"),
  }));
  context.assign(structure, context.obj({ Type: "StructTreeRoot", K: [element] }));
  doc.catalog.set(PDFName.of("StructTreeRoot"), structure);
  doc.catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true }));
  doc.setTitle("Shared references fixture");
  await doc.attach(new TextEncoder().encode("First-party attachment\n"), "notes.txt", { mimeType: "text/plain" });

  const bytes = await doc.save({ useObjectStreams: true });
  const editModel: DocumentModel = {
    pages: doc.getPages().map((_, sourceIndex) => ({
      id: sourceIndex ? `p${sourceIndex}` : "p", sourceIndex, rotation: 0, widthPt: 300, heightPt: 200,
    })),
    overlays: [overlay(), {
      id: "label", pageId: "p", type: "text", rect: { x: 25, y: 37, w: 100, h: 18 },
      text: "Export label", fontSize: 11, color: "#000000", bold: false,
      align: "left", fontFamily: "sans",
    }],
  };
  return { bytes, editModel, obsolete: obsolete!, shared, appearance, paintedMark, metadata };
}

export function streamHash(stream: PDFRawStream): string {
  const decoded = stream.dict.has(PDFName.of("Filter")) ? decodePDFRawStream(stream).decode() : stream.getContents();
  return bytesToHex(sha256(decoded));
}

export function pageStreamRefs(doc: PDFDocument, pageIndex: number): PDFRef[] {
  const contents = doc.getPage(pageIndex).node.get(PDFName.of("Contents"));
  const resolved = doc.context.lookup(contents);
  const refs = resolved instanceof PDFArray ? resolved.asArray() : [contents];
  return refs.map((ref) => {
    if (!(ref instanceof PDFRef)) throw new Error("Expected an indirect page stream");
    return ref;
  });
}
