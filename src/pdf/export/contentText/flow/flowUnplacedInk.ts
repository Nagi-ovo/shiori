// Measurement only: unresolved shows never become editable story glyphs.
// Reuse the placement walker with local font metrics and resolved gs fonts;
// neither the source operators nor the page's resources are changed.
import {PDFArray,PDFDict,PDFName,PDFNumber,PDFPage} from 'pdf-lib';
import type {PdfRect} from '../../../model/types';
import {contentFontInfo} from '../../contentStreamEdit/glyphWidths';
import type {ResolvedRunFont} from '../../contentStreamEdit/replaceRun';
import type {ContentOp} from '../../contentStreamEdit/tokenizer';
import {walkTextPlacements} from '../../contentStreamEdit/walkTextPlacements';
import type {ShowTextState,UnplacedShow} from '../../contentStreamEdit/textStateTypes';
import {retypesetInk,retypesetPaintedInk} from '../retypesetInk';
import {type3Ink,type3Metrics} from './flowType3Ink';

export type FlowUnplacedInk = { op: number; box: PdfRect };

/** null means at least one show has no finite ink/position proof, anywhere
 * on the page. An empty list proves there is no additional painted ink. */
export function boundFlowUnplaced(page: PDFPage, ops: ContentOp[], unplaced: readonly UnplacedShow[]): FlowUnplacedInk[] | null {
  if (!unplaced.length) return [];
  try { return measure(page, ops, unplaced); } catch { return null; }
}

function measure(page: PDFPage, ops: ContentOp[], unplaced: readonly UnplacedShow[]): FlowUnplacedInk[] | null {
  const resources = page.node.Resources()?.clone() ?? page.doc.context.obj({});
  const fontDict = resources.lookupMaybe(PDFName.of('Font'), PDFDict)?.clone() ?? page.doc.context.obj({});
  resources.set(PDFName.of('Font'), fontDict);
  const states = resources.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  const measuredOps = ops.map(op => {
    if (op.operator !== 'gs' || op.operands[0]?.kind !== 'name') return op;
    const state = states?.lookupMaybe(PDFName.of(op.operands[0].value), PDFDict);
    const entry = state?.lookupMaybe(PDFName.of('Font'), PDFArray);
    if (!entry || entry.size() !== 2) return op;
    const raw = entry.lookup(0), size = entry.lookup(1);
    const font = raw instanceof PDFName ? fontDict.lookupMaybe(raw, PDFDict) : raw;
    if (!(font instanceof PDFDict) || !(size instanceof PDFNumber) || !Number.isFinite(size.asNumber())) return op;
    let alias = 'FlowMeasureFont';
    while (fontDict.has(PDFName.of(alias))) alias += '_';
    fontDict.set(PDFName.of(alias), font);
    return { ...op, operator: 'Tf', operands: [{ kind: 'name', value: alias }, { kind: 'number', value: size.asNumber() }] } as ContentOp;
  });
  const node = page.node.clone(); node.set(PDFName.of('Resources'), resources);
  const measuredPage = PDFPage.of(node, page.ref, page.doc);
  const fonts: ResolvedRunFont[] = [], type3 = new Map<string, NonNullable<ReturnType<typeof type3Metrics>>>();
  for (const [name, ref] of fontDict.entries()) {
    const raw = fontDict.context.lookup(ref);
    if (!(raw instanceof PDFDict)) continue;
    const isType3 = raw.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Type3';
    const t3 = isType3 ? type3Metrics(raw) : undefined;
    const info = isType3 ? t3?.metrics : contentFontInfo(raw, { sourceReuse: false, standard14Afm: true });
    if (!info?.ok) continue;
    const resourceName = name.decodeText();
    fonts.push({ ...info, resourceName, objectId: resourceName, unicodeByCode: new Map() });
    if (t3) type3.set(resourceName, t3);
  }
  const target = new Set(unplaced.map(s => `${s.opIndex}:${s.arrayItemIndex}`));
  const shows = new Map<string, ShowTextState>();
  const walk = walkTextPlacements(measuredOps, { includeStroked: true,
    resolveFont: name => {
      const f = fonts.find(f => f.resourceName === name);
      return f ? { ...f, ok: true, appliesWordSpacing: f.bytesPerCode === 1 } : { ok: false, reason: 'unboundable font' };
    },
    extGStateSetsFont: name => {
      const state = states?.lookupMaybe(PDFName.of(name), PDFDict);
      return state ? state.has(PDFName.of('Font')) : null;
    },
    onShow: s => shows.set(`${s.opIndex}:${s.arrayItemIndex}`, s),
  });
  if (!walk.ok || [...target].some(key => !shows.has(key))) return null;
  const ink = retypesetInk(measuredPage, fonts, ops), paintedInk = retypesetPaintedInk(measuredPage, fonts);
  const result: FlowUnplacedInk[] = [];
  for (const g of walk.glyphs) {
    const key = `${g.opIndex}:${g.arrayItemIndex}`;
    if (!target.has(key)) continue;
    const s = shows.get(key)!, font = fonts.find(f => f.resourceName === g.fontName)!, p = g.coreQuad[0];
    const t3 = type3.get(g.fontName);
    let box: PdfRect | null | undefined;
    if (t3) box = type3Ink(t3, g.code, s, p);
    else {
      let r = ink(font, g.code, s, p.x, p.y);
      if (!r.known) r = paintedInk(font, g.code, { ...s, rise: 0 }, p.x, p.y) ?? r;
      if (r.known) box = r.box;
    }
    if (box === null) continue;
    if (!box || !Object.values(box).every(Number.isFinite)) return null;
    if (box.w > 0 || box.h > 0) result.push({ op: g.opIndex, box });
  }
  return result;
}
