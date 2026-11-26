import { PDFDocument, PDFName } from 'pdf-lib';
import type { ContentTextOverlay, DocumentModel } from '../../model/types';
export const bytes = (s: string) => new TextEncoder().encode(s);
export async function fixture(stream = 'BT /F1 10 Tf 50 100 Td (ABCDE) Tj ET') {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier',
    FirstChar: 32, Widths: Array(95).fill(600), Encoding: 'WinAnsiEncoding',
    ToUnicode: doc.context.register(doc.context.stream(bytes('1 beginbfrange <20> <7e> <0020> endbfrange'))) }));
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font } }));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(bytes(stream))));
  return { doc, page, source: bytes(stream) };
}
export function overlay(patch: Partial<ContentTextOverlay> = {}): ContentTextOverlay {
  const value:ContentTextOverlay = { id: 'edit', type: 'contentText', pageId: 'p', rect: { x: 49, y: 98, w: 32, h: 13 },
    coverRects: [{ x: 49, y: 98, w: 32, h: 13 }], originalText: 'ABCDE', text: 'AXCDE',
    fontSize: 10, color: '#000000', bold: false, align: 'left', fontFamily: 'mono', backgroundColor: '#ffffff', ...patch };
  return {...value,sourceStyle:{fontSize:value.fontSize,color:value.color,bold:value.bold,italic:value.italic,align:value.align,fontFamily:value.fontFamily,backgroundColor:value.backgroundColor},...patch};
}
export const model = (overlays: ContentTextOverlay[]): DocumentModel => ({
  pages: [{ id: 'p', sourceIndex: 0, widthPt: 300, heightPt: 200, rotation: 0 }], overlays,
});
