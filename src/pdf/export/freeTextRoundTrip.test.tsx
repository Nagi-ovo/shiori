import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { OverlayDom } from "../../editor/components/overlays/OverlayDom";
import i18n from "../../i18n";
import { QpdfDocument, qpdfTest } from "../../test/qpdf";
import { importFileAnnotations } from "../import/annotations";
import type { Overlay, PageModel, TextOverlay } from "../model/types";
import { exportPdf } from "./exportPdf";

const unicodeFontUrl = new URL(
  "../../assets/fonts/NotoSansSC-Regular.otf",
  import.meta.url,
).href;
const pageModel: PageModel = {
  id: "p1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
};

afterEach(cleanup);

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("FreeText export round trip", () => {
  test("preserves CJK rich text, appearance style, and rendered style", async () => {
    const text = "中文批注 & <ok>";
    const sourceOverlay: TextOverlay = {
      id: "free-text",
      type: "text",
      pageId: pageModel.id,
      rect: { x: 72, y: 650, w: 220, h: 60 },
      text,
      fontSize: 12,
      color: "#3a352d",
      bold: true,
      italic: true,
      align: "right",
      fontFamily: "notoSansSc",
    };
    const [overlay] = await exportAndImport([sourceOverlay]);
    expect(overlay).toMatchObject({
      type: "text",
      rect: sourceOverlay.rect,
      text,
      fontSize: 12,
      color: "#3a352d",
      bold: true,
      italic: true,
      align: "right",
      fontFamily: "notoSansSc",
    });
    if (!overlay || overlay.type !== "text") {
      throw new Error("expected imported FreeText overlay");
    }

    const view = render(
      <OverlayDom
        overlay={overlay}
        page={pageModel}
        scale={1}
        selected={false}
        editing={false}
        interactivePointerEvents="auto"
        onStartEdit={() => undefined}
        onCommitEdit={() => undefined}
        onPointerDown={() => undefined}
        onHandlePointerDown={() => undefined}
        onRotateHandlePointerDown={() => undefined}
        onMaybeSuppressEditDragBlur={() => false}
        now={2_000}
      />,
    );
    const renderedText = view.getByText(text) as HTMLElement;
    expect(renderedText.style.fontSize).toBe("12px");
    expect(renderedText.style.color).toBe("#3a352d");
    expect(renderedText.style.textAlign).toBe("right");
  });

  test("preserves ASCII center and right alignment with serif and mono", async () => {
    const overlays: TextOverlay[] = [
      {
        id: "serif-center",
        type: "text",
        pageId: pageModel.id,
        rect: { x: 72, y: 650, w: 220, h: 60 },
        text: "Centered serif",
        fontSize: 14,
        color: "#123456",
        bold: false,
        align: "center",
        fontFamily: "serif",
      },
      {
        id: "mono-right",
        type: "text",
        pageId: pageModel.id,
        rect: { x: 72, y: 560, w: 220, h: 60 },
        text: "Right mono",
        fontSize: 11,
        color: "#654321",
        bold: true,
        align: "right",
        fontFamily: "mono",
      },
    ];
    const imported = await exportAndImport(overlays);

    expect(imported[0]).toMatchObject({
      type: "text",
      text: "Centered serif",
      bold: false,
      align: "center",
      fontFamily: "serif",
    });
    expect(imported[1]).toMatchObject({
      type: "text",
      text: "Right mono",
      bold: true,
      align: "right",
      fontFamily: "mono",
    });
  });

  test("keeps control characters in the text it imports back", async () => {
    const [overlay] = await exportAndImport([controlTextOverlay]);
    expect(overlay).toMatchObject({ type: "text", text: controlTextOverlay.text });
  });
});

const controlTextOverlay: TextOverlay = {
  id: "control-text",
  type: "text",
  pageId: pageModel.id,
  rect: { x: 72, y: 560, w: 220, h: 60 },
  text: "中文\n\t\u0001",
  fontSize: 12,
  color: "#3a352d",
  bold: false,
  align: "left",
  fontFamily: "sans",
};

// What the exported dictionaries say, read by qpdf rather than by Shiori's
// own importer: another viewer gets the text from /Contents and /RC, the
// size and colour from /DA, the alignment from /Q and the box from /Rect.
describe("FreeText export, read by qpdf", () => {
  qpdfTest("writes the text, rich text, appearance string, alignment and box", async () => {
    const text = "中文批注 & <ok>";
    const doc = QpdfDocument.open(
      await exportFreeText([
        {
          id: "free-text",
          type: "text",
          pageId: pageModel.id,
          rect: { x: 72, y: 650, w: 220, h: 60 },
          text,
          fontSize: 12,
          color: "#3a352d",
          bold: true,
          italic: true,
          align: "right",
          fontFamily: "notoSansSc",
        },
        controlTextOverlay,
      ]),
    );
    const [styled, control] = doc.annotations(0);
    expect(styled!["/Subtype"]).toBe("/FreeText");
    expect(styled!["/Rect"]).toEqual([72, 650, 292, 710]);
    expect(styled!["/Q"]).toBe(2);
    expect(doc.text(styled!["/Contents"])).toBe(text);
    expect(richTextOf(doc.text(styled!["/RC"]))).toBe(text);
    expect(appearanceOf(doc.text(styled!["/DA"]))).toEqual({ fontSize: 12, color: [58, 53, 45] });

    // Contents keeps control characters; the rich text, which an XML
    // parser must accept, replaces them.
    expect(control!["/Rect"]).toEqual([72, 560, 292, 620]);
    expect(control!["/Q"]).toBe(0);
    expect(doc.text(control!["/Contents"])).toBe("中文\n\t\u0001");
    expect(richTextOf(doc.text(control!["/RC"]))).toBe("中文\n\t\uFFFD");
  });
});

/** The character data of an /RC XHTML body, parsed as XML. */
function richTextOf(rc: string | null): string | null {
  if (rc === null) return null;
  const parsed = new window.DOMParser().parseFromString(rc, "application/xml");
  return parsed.documentElement.textContent;
}

/** Font size and RGB fill (0-255) from a /DA string such as "/F 12 Tf 0.2 0.2 0.2 rg". */
function appearanceOf(da: string | null) {
  const size = /([\d.]+)\s+Tf/.exec(da ?? "");
  const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da ?? "");
  return {
    fontSize: size ? Number(size[1]) : null,
    color: rgb ? rgb.slice(1, 4).map((value) => Math.round(Number(value) * 255)) : null,
  };
}

async function exportFreeText(overlays: TextOverlay[]): Promise<Uint8Array> {
  const source = await PDFDocument.create();
  source.addPage([pageModel.widthPt, pageModel.heightPt]);
  const original = await source.save();
  const { bytes } = await exportPdf(
    original,
    { pages: [pageModel], overlays },
    {
      mode: "annotations",
      quality: "standard",
      unicodeFontUrl,
      requireUnicodeFont: true,
    },
  );
  return bytes;
}

/** Exports `overlays`, then imports the file back as the app opens it. */
async function exportAndImport(overlays: TextOverlay[]): Promise<Overlay[]> {
  return importFileAnnotations([pageModel], await exportFreeText(overlays));
}
