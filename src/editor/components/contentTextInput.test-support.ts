// A first-party page for source-text input checks: two Courier lines over a
// two-tone background with a narrow contrasting stripe through the third
// glyph of each line. Courier advances are 600/1000 em, so at 10 pt every
// glyph cell is 6 pt wide: line 1 "ABCDE" spans x 50–80 on baseline 100,
// line 2 "FGHIJ" spans x 50–80 on baseline 88. The stripe (x 64–66) sits
// inside the "C" and "H" cells (x 62–68).
import { PDFDocument, PDFName } from 'pdf-lib';

export const STRIPE_PAGE = { widthPt: 300, heightPt: 200 } as const;
export const STRIPE = { x: 64, w: 2, rgb: [0.1, 0.35, 0.9] } as const;
export const LEFT_TONE = { x: 40, w: 25, rgb: [0.8, 0.92, 0.78] } as const;
export const RIGHT_TONE = { x: 65, w: 30, rgb: [1, 0.86, 0.7] } as const;
export const BAND = { y: 80, h: 32 } as const;
export const LINES = [
  { text: 'ABCDE', x: 50, baseline: 100 },
  { text: 'FGHIJ', x: 50, baseline: 88 },
] as const;
export const CELL_PT = 6;
export const FONT_PT = 10;

const rect = (r: { x: number; w: number; rgb: readonly number[] }) =>
  `${r.rgb.join(' ')} rg ${r.x} ${BAND.y} ${r.w} ${BAND.h} re f`;

export function stripeContent(): string {
  return [
    `q ${rect(LEFT_TONE)} ${rect(RIGHT_TONE)} ${rect(STRIPE)} Q`,
    `BT /F1 ${FONT_PT} Tf ${LINES[0].x} ${LINES[0].baseline} Td (${LINES[0].text}) Tj`,
    `0 ${LINES[1].baseline - LINES[0].baseline} Td (${LINES[1].text}) Tj ET`,
  ].join('\n');
}

export async function stripePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([STRIPE_PAGE.widthPt, STRIPE_PAGE.heightPt]);
  const enc = (s: string) => new TextEncoder().encode(s);
  const toUnicode = doc.context.register(doc.context.stream(enc('1 beginbfrange <20> <7e> <0020> endbfrange')));
  const font = doc.context.register(doc.context.obj({
    Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier', FirstChar: 32,
    Widths: Array(95).fill(600), Encoding: 'WinAnsiEncoding', ToUnicode: toUnicode,
  }));
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font } }));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(enc(stripeContent()))));
  return doc.save({ useObjectStreams: false });
}

// One Courier line whose extracted text holds grapheme clusters the glyphs
// do not line up with. Painted "AeXBx~yC" with X the spacing acute (0xB4):
// ToUnicode maps 0xB4 to U+0301, so "e" + acute extract as one cluster drawn
// as two glyphs, and "~" to the woman-technologist ZWJ sequence (five UTF-16
// units, one glyph). Extracted: "A" "é" "B" "x" "👩‍💻" "y" "C", UTF-16
// boundaries 0 1 3 4 5 10 11 12. Cells are 6 pt from x 50 on baseline 100,
// with a second plain line "FGHIJKLM" of equal width on baseline 88 (a
// narrower one leaves the block without a stable alignment edge).
export const GRAPHEME_LINE = { x: 50, baseline: 100, painted: 'AeXBx~yC' } as const;
export async function graphemePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([STRIPE_PAGE.widthPt, STRIPE_PAGE.heightPt]);
  const enc = (s: string) => new TextEncoder().encode(s);
  const cmap = [
    '1 beginbfrange <20> <7d> <0020> endbfrange',
    '2 beginbfchar <b4> <0301> <7e> <D83DDC69200DD83DDCBB> endbfchar',
  ].join('\n');
  const font = doc.context.register(doc.context.obj({
    Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier', FirstChar: 32,
    Widths: Array(224).fill(600), Encoding: 'WinAnsiEncoding',
    ToUnicode: doc.context.register(doc.context.stream(enc(cmap))),
  }));
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font } }));
  const content = `BT /F1 ${FONT_PT} Tf ${GRAPHEME_LINE.x} ${GRAPHEME_LINE.baseline} Td (Ae\\264Bx~yC) Tj 0 -12 Td (FGHIJKLM) Tj ET`;
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(enc(content))));
  return doc.save({ useObjectStreams: false });
}
