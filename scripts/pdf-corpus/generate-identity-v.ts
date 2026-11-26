/** First-party Identity-V / WMode 1 fixtures for the vertical corpus. */
import {PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber} from 'pdf-lib';
import {prepareRetypesetFallback} from '../../src/pdf/export/contentText/retypesetFallback';
import {hex} from '../../src/pdf/export/contentStreamEdit/runEncoding';
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const FONT = resolve(import.meta.dir, '../../src/assets/fonts/NotoSansJP-Regular.otf');

async function verticalFont(doc: PDFDocument, resource: string, chars: string[], metrics = true) {
  const fontData = new Uint8Array(readFileSync(FONT));
  const prepared = await prepareRetypesetFallback(doc, resource, 'NotoSansJP-Regular.otf', chars, {
    loadFont: async () => fontData,
  });
  const raw = doc.context.lookup(prepared.ref, PDFDict);
  const child = raw.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
  raw.set(PDFName.of('Encoding'), PDFName.of('Identity-V'));
  child.set(PDFName.of('WMode'), PDFNumber.of(1));
  if (metrics) {
    child.set(PDFName.of('DW2'), doc.context.obj([880, -1000]));
  }
  const code = (value: string) => {
    const e = prepared.resolved.canEncode!(value);
    if (!e.ok) throw Error(e.reason);
    return hex(e.bytes);
  };
  return {ref: prepared.ref, code};
}

async function horizontalFont(doc: PDFDocument, resource: string, chars: string[]) {
  const fontData = new Uint8Array(readFileSync(FONT));
  const prepared = await prepareRetypesetFallback(doc, resource, 'NotoSansJP-Regular.otf', chars, {
    loadFont: async () => fontData,
  });
  const raw = doc.context.lookup(prepared.ref, PDFDict);
  raw.set(PDFName.of('Encoding'), PDFName.of('Identity-H'));
  const code = (value: string) => {
    const e = prepared.resolved.canEncode!(value);
    if (!e.ok) throw Error(e.reason);
    return hex(e.bytes);
  };
  return {ref: prepared.ref, code};
}

function columns(text: string, charsPerCol: number, colCount: number) {
  const cleaned = text.replace(/\s+/g, '');
  const cols: string[] = [];
  let i = 0;
  while (i < cleaned.length && cols.length < colCount) {
    cols.push(cleaned.slice(i, i + charsPerCol));
    i += charsPerCol;
  }
  return cols;
}

async function writeKumo() {
  const title = '蜘蛛の糸';
  const author = '芥川龍之介';
  const body =
    'ある日の事でございます。御釈迦様は極楽の蓮池のふちを、独りでぶらぶら御歩きになっていらっしゃいました。池の中に咲いている蓮の花は、みんな玉のようにまっ白で、そのまん中にある金色の蕊からは、何とも云えない好い匂が、絶間なくあたりへ溢れて居ります。極楽は丁度朝なのでございましょう。やがて御釈迦様はその池のふちに御佇みになって、水の面を蔽っている蓮の葉の間から、ふと下の容子を御覧になりました。';
  const colophon = '本文は著作権保護期間の満了した作品である。青空文庫の本文を利用した。';
  const all = title + author + body + colophon;
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const {ref, code} = await verticalFont(doc, 'V1', Array.from(new Set(all)));
  const cols = [title, author, ...columns(body + colophon, 28, 8)];
  const parts: string[] = [];
  let x = 520;
  for (const col of cols) {
    parts.push(`BT /V1 14 Tf 1 0 0 1 ${x.toFixed(2)} 800 Tm ${code(col)} Tj ET`);
    x -= 28;
  }
  page.node.set(PDFName.of('Resources'), doc.context.obj({Font: {V1: ref}}));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(parts.join('\n'))));
  return doc;
}

async function writeTcy() {
  const frontCjk = '本書の組版見本は令和八年';
  const midCjk = '月';
  const mid2 = '日に作成した。第';
  const mid3 = '回の試験では';
  const mid4 = '案と';
  const mid5 = '活字を用い、幅は二欄とする。';
  const body = 'ある日の事でございます。御釈迦様は極楽の蓮池のふちを、独りでぶらぶら御歩きになっていらっしゃいました。';
  const cjk = frontCjk + midCjk + mid2 + mid3 + mid4 + mid5 + body + '蜘蛛の糸芥川龍之介';
  const latin = '111712ABC12pt';
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const v = await verticalFont(doc, 'V1', Array.from(new Set(cjk)));
  const h = await horizontalFont(doc, 'H1', Array.from(new Set(latin)));
  // One vertical column with Identity-H tate-chu-yoko inserts (rotated 90° into the column).
  const x = 420;
  const y0 = 800;
  const em = 14;
  const chunks: {kind: 'v' | 'h'; text: string}[] = [
    {kind: 'v', text: frontCjk},
    {kind: 'h', text: '11'},
    {kind: 'v', text: midCjk},
    {kind: 'h', text: '17'},
    {kind: 'v', text: mid2},
    {kind: 'h', text: '12'},
    {kind: 'v', text: mid3},
    {kind: 'h', text: 'ABC'},
    {kind: 'v', text: mid4},
    {kind: 'h', text: '12pt'},
    {kind: 'v', text: mid5 + body},
  ];
  const parts: string[] = [];
  let y = y0;
  for (const ch of chunks) {
    if (ch.kind === 'v') {
      parts.push(`BT /V1 ${em} Tf 1 0 0 1 ${x} ${y} Tm ${v.code(ch.text)} Tj ET`);
      y -= em * ch.text.length;
    } else {
      // horizontal run sitting in the column: rotate and center
      const w = em * ch.text.length * 0.55;
      parts.push(`BT /H1 ${em * 0.75} Tf 1 0 0 1 ${x - 6} ${y - 10} Tm ${h.code(ch.text)} Tj ET`);
      y -= em * 1.15;
    }
  }
  page.node.set(PDFName.of('Resources'), doc.context.obj({Font: {V1: v.ref, H1: h.ref}}));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(parts.join('\n'))));
  return doc;
}

const outDir = resolve(import.meta.dir, 'fixtures/vertical');
const cacheDir = resolve(import.meta.dir, '../../test-artifacts/pdf-corpus/cache');
const files = [
  ['vert-identityv-jp-kumo', writeKumo],
  ['vert-identityv-jp-tcy', writeTcy],
] as const;
for (const [id, fn] of files) {
  const doc = await fn();
  const bytes = await doc.save();
  const dest = resolve(outDir, `${id}.pdf`);
  writeFileSync(dest, bytes);
  writeFileSync(resolve(cacheDir, `${id}.pdf`), bytes);
  const {createHash} = await import('node:crypto');
  const sha = createHash('sha256').update(bytes).digest('hex');
  console.log(id, bytes.length, sha);
}
