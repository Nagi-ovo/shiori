// Generate the DOCX fixtures the reader's Word regressions are checked against.
//
//   bun run scripts/fixtures/make-docx-fixtures.ts <output-dir>
//
// Every file is built from scratch with fflate — no Word installation, no
// binary fixtures in the repo — so the exact OOXML each case exercises is
// readable here:
//
//   cjk-yahei.docx           w:eastAsia="微软雅黑"  → in the sans substitution map
//   cjk-songti.docx          w:eastAsia="宋体"      → no substitute; browser-measured
//   cjk-noslot.docx          no eastAsia slot, no styles, no theme
//   cjk-theme-dengxian.docx  zh-CN Word template: theme a:ea = 等线
//   cjk-theme-empty-ea.docx  en-US Word template: theme a:ea = "" (overran the
//                            margin until upstream #787, fixed in the 2.21 line)
//   two-images.docx          two inline PNGs, the second past a page boundary
//                            (upstream #251: it used to stay on "Loading image")
//   long-latin.docx          220 Latin+CJK paragraphs for scroll / pinch checks
//
// RELEASE-CHECKS.md A0.9 and A0.11 open these in the app.

import { mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";

const outputDir = process.argv[2];
if (!outputDir) {
  console.error("usage: bun run scripts/fixtures/make-docx-fixtures.ts <output-dir>");
  process.exit(1);
}
mkdirSync(outputDir, { recursive: true });

const W = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(" ");
const A4 =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
const CJK =
  "天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。寒来暑往，秋收冬藏。闰余成岁，律吕调阳。云腾致雨，露结为霜。";
const LATIN =
  "The quick brown fox jumps over the lazy dog. Lorem ipsum dolor sit amet, consectetur adipiscing elit.";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function paragraph(text: string, rFonts = ""): string {
  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr>${rFonts}<w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function mixedParagraphs(rFonts: string, count = 40): string {
  return Array.from({ length: count }, (_, i) =>
    paragraph(`第 ${i + 1} 段 ${CJK} ${LATIN}`, rFonts),
  ).join("");
}

type Package = {
  body: string;
  parts?: Record<string, Uint8Array>;
  documentRels?: string;
  contentTypes?: string;
};

function pack(name: string, pkg: Package): void {
  const documentXml = `${XML_HEAD}<w:document ${W}><w:body>${pkg.body}${A4}</w:body></w:document>`;
  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${pkg.contentTypes ?? ""}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rootRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const documentRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${pkg.documentRels ?? ""}</Relationships>`;
  const zip = zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "word/document.xml": strToU8(documentXml),
    "word/_rels/document.xml.rels": strToU8(documentRels),
    ...(pkg.parts ?? {}),
  });
  const path = `${outputDir}/${name}`;
  void Bun.write(path, zip);
  console.log(`wrote ${path} (${zip.length} bytes)`);
}

// --- Font slot cases -------------------------------------------------------

pack("cjk-yahei.docx", {
  body: mixedParagraphs(
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑"/>',
  ),
});
pack("cjk-songti.docx", {
  body: mixedParagraphs(
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/>',
  ),
});
pack("cjk-noslot.docx", {
  body: mixedParagraphs('<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>'),
});

// A Word template: docDefaults point at the theme, the theme names (or leaves
// empty) the East Asian typeface. en-US Word writes an empty one.
function templateParts(eastAsianTypeface: string): Package {
  const styles = `${XML_HEAD}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const theme = `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface="${eastAsianTypeface}"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="${eastAsianTypeface}"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst><a:ln w="6350">${fill}</a:ln><a:ln w="12700">${fill}</a:ln><a:ln w="19050">${fill}</a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  return {
    body: mixedParagraphs(""),
    parts: {
      "word/styles.xml": strToU8(styles),
      "word/theme/theme1.xml": strToU8(theme),
    },
    documentRels:
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>',
    contentTypes:
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
  };
}
pack("cjk-theme-dengxian.docx", templateParts("等线"));
pack("cjk-theme-empty-ea.docx", templateParts(""));

// --- Inline images across a page boundary ----------------------------------

function png(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const be32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const chunk = (type: string, data: Uint8Array) => {
    const typeBytes = strToU8(type);
    const body = new Uint8Array(typeBytes.length + data.length);
    body.set(typeBytes);
    body.set(data, typeBytes.length);
    return [be32(data.length), body, be32(crc32(body))];
  };
  const row = new Uint8Array(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const raw = new Uint8Array(row.length * height);
  for (let y = 0; y < height; y += 1) raw.set(row, y * row.length);
  const ihdr = new Uint8Array([...be32(width), ...be32(height), 8, 2, 0, 0, 0]);
  const pieces = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", new Uint8Array(deflateSync(raw))),
    ...chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of pieces) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function inlineImage(relationshipId: string, id: number): string {
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1905000" cy="952500"/><wp:docPr id="${id}" name="Picture ${id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

pack("two-images.docx", {
  body:
    paragraph("Image one follows.") +
    inlineImage("rId2", 1) +
    Array.from({ length: 45 }, (_, i) => paragraph(`Filler paragraph ${i + 1}. ${LATIN}`)).join("") +
    paragraph("Image two follows, past the page boundary.") +
    inlineImage("rId3", 2) +
    paragraph("End."),
  parts: {
    "word/media/image1.png": png(200, 100, [200, 40, 40]),
    "word/media/image2.png": png(200, 100, [40, 80, 200]),
  },
  documentRels:
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/>',
  contentTypes: '<Default Extension="png" ContentType="image/png"/>',
});

// --- A long document for scroll and pinch checks ---------------------------

pack("long-latin.docx", {
  body: Array.from({ length: 220 }, (_, i) =>
    paragraph(`Paragraph ${i + 1}. Shiori 栞 mobile DOCX regression fixture. ${LATIN} ${CJK}`),
  ).join(""),
});
