import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { OverlayDom } from "../../editor/components/overlays/OverlayDom";
import i18n from "../../i18n";
import { annotationToOverlay } from "../import/annotations";
import type { PageModel, TextOverlay } from "../model/types";
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
    const [annotation] = await exportAndReadAnnotations([sourceOverlay]);
    expect((annotation!.richText as { str?: string } | null)?.str).toBe(text);
    const appearance = annotation!.defaultAppearanceData as {
      fontSize: number;
      fontColor: ArrayLike<number>;
    };
    expect(appearance.fontSize).toBe(12);
    expect(Array.from(appearance.fontColor)).toEqual([58, 53, 45]);

    const overlay = annotationToOverlay(annotation!, pageModel, () => "round-trip");
    expect(overlay).toMatchObject({
      type: "text",
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
    const annotations = await exportAndReadAnnotations(overlays);
    const imported = annotations.map((annotation, index) =>
      annotationToOverlay(annotation, pageModel, () => `round-trip-${index}`),
    );

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

  test("keeps control characters in Contents while making AP text safe", async () => {
    const text = "中文\n\t\u0001";
    const [annotation] = await exportAndReadAnnotations([
      {
        id: "control-text",
        type: "text",
        pageId: pageModel.id,
        rect: { x: 72, y: 650, w: 220, h: 60 },
        text,
        fontSize: 12,
        color: "#3a352d",
        bold: false,
        align: "left",
        fontFamily: "sans",
      },
    ]);

    expect((annotation!.contentsObj as { str?: string }).str).toBe(text);
    expect((annotation!.richText as { str?: string } | null)?.str).toBe(
      "中文\n\t�",
    );
  });
});

async function exportAndReadAnnotations(
  overlays: TextOverlay[],
): Promise<Array<Record<string, unknown>>> {
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
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  }).promise;
  try {
    const pdfPage = await doc.getPage(1);
    return (await pdfPage.getAnnotations()) as unknown as Array<
      Record<string, unknown>
    >;
  } finally {
    await doc.destroy();
  }
}
