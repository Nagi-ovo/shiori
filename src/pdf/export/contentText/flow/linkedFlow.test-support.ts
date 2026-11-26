// First-party fixtures for linked-frame flow tests: two text frames in one
// column, each line written with a chosen show operator, plus page furniture
// outside the frames. Fonts are the bundled Liberation faces, read by the
// caller (`loadFont`) so this module stays free of Node APIs.
import fontkit from '@pdf-lib/fontkit';
import {PDFDocument,PDFName,type PDFFont} from 'pdf-lib';
import type {ContentTextOverlay,DocumentModel,PdfRect} from '../../../model/types';

export type ShowStyle = 'Tj' | 'TJ' | 'quote' | 'dquote' | 'words';
export type FlowFixture = { style?: ShowStyle; face?: 'Sans' | 'Serif' | 'Mono' | 'Sans-Bold'; size?: number; leading?: number; tc?: number; tz?: number;
  first: string[]; second: string[]; firstRows?: number; secondRows?: number; edit: string; rule?: PdfRect;
  /** Annotations whose Rect is given as a fraction-free page rect; `'second'` covers the second frame. */
  annots?: { subtype: string; rect: PdfRect | 'second' }[];
  /** Tf size of each first-frame line in the Tj style (default `size`). */
  firstLineSizes?: number[];
  /** A filled-square form XObject drawn at this rect, away from the text. */
  logoForm?: PdfRect;
  /** A full-page white fill painted before all text, or after it. */
  pageFill?: 'before' | 'after';
  /** Paint the second frame before the first. */
  secondFirst?: boolean;
  /** A foreign show painted between the two frames, outside both. */
  between?: string;
  /** Where (and how large) the `between` show is painted; default in the gap. */
  betweenAt?: { x: number; y: number; size: number };
  /** Marked content around the frames: a /Span with ActualText around each
   * frame (`true`), one around both, or a /P with only an MCID around both. */
  spans?: true | 'both' | 'mcid';
  /** A foreign show in the header face with its own render mode, painted
   * between the frames' text objects or after both. */
  extraShow?: { text: string; x: number; y: number; size: number; mode: number; at: 'between' | 'end' };
  /** Foreign text the ordinary placement walk cannot resolve. */
  unplacedShow?: { kind: 'type3' | 'extgstate' | 'unknown'; x: number; y: number; at?: 'between';
    proc?: string | null; procMatrix?: number[]; procFilter?: string; bbox?: number[] | null; matrix?: number[]; transform?: string; show?: string;
    gsFont?: boolean; textState?: string } };
export type BuiltFlow = { bytes: Uint8Array; model: DocumentModel; frames: [PdfRect, PdfRect]; firstLines: string[]; secondLines: string[] };

export const linkedFlowStory: FlowFixture = {
  first: ['Night porters walk the east corridor every hour,', 'checking that fire doors are shut and that exit', 'signs are lit along the full length of the hall.'],
  second: ['Keys for the plant room hang in the porters lodge.'],
  edit: 'Night porters walk the east corridor every hour, checking that fire doors are shut and that exit signs are lit along the full length of the hall. Any fault is written in the night log and reported to the duty manager before the shift ends.',
};
export const fontFile = (face: string) => `node_modules/@docx-editor.dev/fonts/assets/Liberation${face}-Regular.ttf`.replace('Sans-Bold-Regular', 'Sans-Bold');

/** Text operators for one frame, starting at its first baseline. */
function frameOps(f: FlowFixture, font: PDFFont, x: number, top: number, lines: string[], sizes?: number[]) {
  const size = f.size ?? 10, leading = f.leading ?? 13, enc = (s: string) => font.encodeText(s).toString();
  const pre = `/F1 ${size} Tf ${f.tc ? `${f.tc} Tc ` : ''}${f.tz ? `${f.tz} Tz ` : ''}${leading} TL`;
  const first = top - .9 * size;
  switch (f.style ?? 'Tj') {
    case 'quote': return `BT ${pre} 1 0 0 1 ${x} ${first} Tm ${lines.map((l, i) => `${enc(l)} ${i ? "'" : 'Tj'}`).join(' ')} ET`;
    case 'dquote': return `BT ${pre} 1 0 0 1 ${x} ${first} Tm ${lines.map((l, i) => i ? `0 ${f.tc ?? 0} ${enc(l)} "` : `${enc(l)} Tj`).join(' ')} ET`;
    case 'TJ': return lines.map((l, i) => `BT ${pre} 1 0 0 1 ${x} ${first - i * leading} Tm [${l.split(' ').map(enc).join(` ${-font.widthOfTextAtSize(' ', 1000) + 20} `)}] TJ ET`).join('\n');
    case 'words': return lines.map((l, i) => `BT ${pre} 1 0 0 1 ${x} ${first - i * leading} Tm ${l.split(' ').map((w, k, all) => `${enc(k < all.length - 1 ? `${w} ` : w)} Tj`).join(' ')} ET`).join('\n');
    default: return lines.map((l, i) => `BT ${sizes?.[i] ? pre.replace(`/F1 ${size} Tf`, `/F1 ${sizes[i]} Tf`) : pre} 1 0 0 1 ${x} ${first - i * leading} Tm ${enc(l)} Tj ET`).join('\n');
  }
}

export async function buildFlow(f: FlowFixture, loadFont: (path: string) => Uint8Array): Promise<BuiltFlow> {
  const doc = await PDFDocument.create(); doc.registerFontkit(fontkit);
  const font = await doc.embedFont(loadFont(fontFile(f.face ?? 'Sans')), { subset: false });
  const meta = await doc.embedFont(loadFont(fontFile('Sans')), { subset: false });
  const page = doc.addPage([420, 560]), size = f.size ?? 10, leading = f.leading ?? 13;
  const x = 60, top0 = 470, h0 = (f.firstRows ?? f.first.length) * leading - leading + 1.15 * size + 3;
  const top1 = top0 - h0 - 12, h1 = (f.secondRows ?? Math.max(1, f.second.length) + 4) * leading;
  const span = (label: string, ops: string) => f.spans === true ? `/Span <</ActualText (${label})>> BDC ${ops} EMC` : ops;
  const firstOps = span('FIRST ONLY', frameOps(f, font, x, top0, f.first, f.firstLineSizes));
  const secondOps = f.second.length ? [span('SECOND ONLY', frameOps(f, font, x, top1, f.second))] : [];
  const at = f.betweenAt ?? { x, y: top0 - h0 - 6, size: 8 };
  const between = f.between ? [`BT /F9 ${at.size} Tf 1 0 0 1 ${at.x} ${at.y} Tm ${meta.encodeText(f.between).toString()} Tj ET`] : [];
  const e = f.extraShow, extra = e ? [`BT /F9 ${e.size} Tf ${e.mode} Tr 1 0 0 1 ${e.x} ${e.y} Tm ${meta.encodeText(e.text).toString()} Tj 0 Tr ET`] : [];
  const u = f.unplacedShow;
  const usesGs = u?.kind === 'extgstate' || u?.gsFont;
  const unplaced = u ? [`q ${u.transform ?? ''} ${usesGs ? '/GS1 gs BT' : `BT /${u.kind === 'type3' ? 'F3' : 'Missing'} 48 Tf`} ${u.textState ?? ''} 1 0 0 1 ${u.x} ${u.y} Tm ${u.show ?? (u.kind === 'extgstate' ? `${meta.encodeText('H')} Tj` : '(A) Tj')} ET Q`] : [];
  const middle = [...between, ...(e?.at === 'between' ? extra : []), ...(u?.at === 'between' ? unplaced : [])], end = e?.at === 'end' ? extra : [];
  const ordered = f.secondFirst ? [...secondOps, ...middle, firstOps, ...end] : [firstOps, ...middle, ...secondOps, ...end];
  const wrapped = f.spans === 'both' ? `/Span <</ActualText (OLD STORY)>> BDC ${ordered.join('\n')} EMC` : f.spans === 'mcid' ? `/P <</MCID 7>> BDC ${ordered.join('\n')} EMC` : null;
  const frameText = wrapped ? [wrapped] : ordered;
  const fill = '1 g 0 0 420 560 re f 0 g';
  const ops = [...(f.pageFill === 'before' ? [fill] : []), `BT /F9 8 Tf 1 0 0 1 60 530 Tm ${meta.encodeText('Header outside the frames').toString()} Tj ET`,
    ...frameText, `BT /F9 8 Tf 1 0 0 1 60 24 Tm ${meta.encodeText('Footer outside the frames').toString()} Tj ET`,
    ...(f.pageFill === 'after' ? [fill] : [])];
  if (u?.at !== 'between') ops.push(...unplaced);
  if (f.rule) ops.push(`q 0 G 1 w ${f.rule.x} ${f.rule.y} m ${f.rule.x + f.rule.w} ${f.rule.y} l S Q`);
  const xobjects: Record<string, ReturnType<typeof doc.context.register>> = {};
  if (f.logoForm) {
    const r = f.logoForm;
    xobjects.Logo = doc.context.register(doc.context.flateStream('0 0 1 1 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] }));
    ops.push(`q ${r.w} 0 0 ${r.h} ${r.x} ${r.y} cm /Logo Do Q`);
  }
  const proc = u?.kind === 'type3' && u.proc !== null ? doc.context.flateStream(u.proc ?? '1000 0 d0 0 0 1000 1000 re f',
    u.procMatrix ? { Matrix: u.procMatrix } : {}) : undefined;
  if (proc && u?.procFilter) proc.dict.set(PDFName.of('Filter'), PDFName.of(u.procFilter));
  const type3 = u?.kind === 'type3' ? doc.context.register(doc.context.obj({
    Type: 'Font', Subtype: 'Type3', FontMatrix: u.matrix ?? [.001, 0, 0, .001, 0, 0],
    ...(u.bbox === null ? {} : { FontBBox: u.bbox ?? [0, 0, 1000, 1000] }),
    Encoding: { Type: 'Encoding', Differences: [65, PDFName.of('A')] }, FirstChar: 65, LastChar: 65, Widths: [1000],
    CharProcs: proc ? { A: doc.context.register(proc) } : {},
  })) : undefined;
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref, F9: meta.ref, ...(type3 ? { F3: type3 } : {}) },
    ...(usesGs ? { ExtGState: { GS1: { Font: [type3 ?? meta.ref, 48] } } } : {}),
    ...(f.logoForm ? { XObject: xobjects } : {}) }));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(ops.join('\n'))));
  const frames: [PdfRect, PdfRect] = [{ x: x - 2, y: top0 - h0, w: 304, h: h0 }, { x: x - 2, y: top1 - h1, w: 304, h: h1 }];
  if (f.annots?.length) page.node.set(PDFName.of('Annots'), doc.context.obj(f.annots.map(a => {
    const r = a.rect === 'second' ? frames[1] : a.rect;
    return doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: a.subtype, Rect: [r.x, r.y, r.x + r.w, r.y + r.h], ...(a.subtype === 'Highlight' ? { QuadPoints: [r.x, r.y + r.h, r.x + r.w, r.y + r.h, r.x, r.y, r.x + r.w, r.y], C: [1, 1, 0] } : { Border: [0, 0, 0] }) }));
  })));
  const bytes = await doc.save({ useObjectStreams: false });
  const baselines = f.first.map((_, i) => top0 - .9 * size - i * leading);
  const covers = f.first.map((l, i) => ({ x, y: baselines[i]! - .25 * size, w: font.widthOfTextAtSize(l, size), h: 1.15 * size }));
  const style = { fontSize: size, color: '#000000', bold: false, align: 'left' as const, fontFamily: 'sans' as const, backgroundColor: '#ffffff' };
  const overlay: ContentTextOverlay = { id: 'flow-edit', type: 'contentText', pageId: 'p1', flowChainId: 'chain-1', rect: frames[0], coverRects: covers,
    sourceBaselinesPt: baselines, originalText: f.first.join('\n'), text: f.edit, ...style, sourceStyle: style };
  const model: DocumentModel = { pages: [{ id: 'p1', sourceIndex: 0, widthPt: 420, heightPt: 560, rotation: 0 }], overlays: [overlay],
    flowChains: [{ id: 'chain-1', frames: [{ id: 'frame-0', pageId: 'p1', rect: frames[0] }, { id: 'frame-1', pageId: 'p1', rect: frames[1] }] }] };
  return { bytes, model, frames, firstLines: f.first, secondLines: f.second };
}
