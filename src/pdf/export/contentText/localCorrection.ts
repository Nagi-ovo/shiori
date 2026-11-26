import { PDFDict, PDFName, type PDFPage } from 'pdf-lib';
import type { ContentTextOverlay, PdfRect } from '../../model/types';
import type { ResolvedRunFont } from '../contentStreamEdit/replaceRun';
import type { RunEnvironment } from '../contentStreamEdit/textSafety';
import { runContextSafety } from '../contentStreamEdit/replaceRun';
import { hex, pdfNumber } from '../contentStreamEdit/runEncoding';
import { quadIntersectsRect, removalsByRect, removeIdentifiedGlyphs } from '../contentStreamEdit/removeGlyphs';
import { walkTextPlacements, type GlyphPlacement, type ShowTextState } from '../contentStreamEdit/textState';
import { tokenizeContentStream, type ContentOp } from '../contentStreamEdit/tokenizer';
import { lineChanges } from './diff';
import { localOutlineProof } from './localGlyphProof';
import { localStandardFonts } from './localStandardFont';
import type { ContentTextOutcome } from './outcomes';
import { contains } from './regionProof/geometry';
import { retypesetScopes } from './retypesetScopes';

const isShow = (op: ContentOp) => op.operator === 'Tj' || op.operator === 'TJ';
const point = (g: GlyphPlacement) => g.coreQuad[0];
const stateKey = (g: { opIndex: number; arrayItemIndex: number }) => `${g.opIndex}:${g.arrayItemIndex}`;
type LocalCorrection = { outcome: ContentTextOutcome; bytes?: Uint8Array };
const tolerance = .05;
const close = (a: number, b: number) => Math.abs(a - b) <= tolerance;

function rewriteShows(
  bytes: Uint8Array, ops: ContentOp[], target: GlyphPlacement, code: number, end: GlyphPlacement, delta: number,
) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const index of new Set(delta ? [target.opIndex, end.opIndex] : [target.opIndex])) {
    const op = ops[index]!;
    const itemList = op.operator === 'TJ' && op.operands[0]?.kind === 'array' ? op.operands[0].items : op.operands;
    const rendered = itemList.flatMap((item, i) => {
      if (item.kind === 'number') return [pdfNumber(item.value)];
      if (item.kind !== 'string') throw new Error('Invalid text show');
      const itemIndex = op.operator === 'TJ' ? i : -1;
      const data = item.bytes.slice();
      if (index === target.opIndex && itemIndex === target.arrayItemIndex) {
        data.set(target.byteLength === 1 ? [code] : [code >> 8, code & 255], target.byteOffset);
      }
      if (!delta || index !== end.opIndex || itemIndex !== end.arrayItemIndex) return [hex(data)];
      const split = end.byteOffset + end.byteLength;
      return [hex(data.subarray(0, split)), pdfNumber(delta), ...(split < data.length ? [hex(data.subarray(split))] : [])];
    });
    chunks.push(bytes.subarray(cursor, op.start), encoder.encode(`[${rendered.join(' ')}] TJ`));
    cursor = op.end;
  }
  chunks.push(bytes.subarray(cursor));
  const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** A one-glyph correction can leave every byte of the retained text in its
 * original shows. The only repositioning is a proportional change inside
 * its continuous word, followed by a pen restore before independent text. */
export function compileLocalCorrection(
  page: PDFPage, bytes: Uint8Array, ops: ContentOp[], originalFonts: ResolvedRunFont[],
  overlay: ContentTextOverlay, environment: RunEnvironment, otherCovers: readonly PdfRect[],
): LocalCorrection | undefined {
  const { originalText, text, sourceStyle, coverRects, sourceGlyphs, sourceBaselinesPt } = overlay;
  if ((!sourceGlyphs?.length && !sourceBaselinesPt?.length) || !sourceStyle || overlay.angle || coverRects.length !== 1 ||
      Object.keys(sourceStyle).some(key => sourceStyle[key as keyof typeof sourceStyle] !== overlay[key as keyof typeof sourceStyle])) return;
  const changes = lineChanges(originalText, text);
  const change = changes[0];
  const clear = text === '';
  if (!clear && (changes.length !== 1 || !change ||
      !/^[\p{L}\p{N}]$/u.test(change.replacement) || !/^[\p{L}\p{N}]$/u.test(originalText.slice(change.start, change.end)))) return;

  const dictionary = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const standards = localStandardFonts(dictionary);
  const fonts = new Map(originalFonts.map(f => [f.resourceName, f]));
  for (const [name, info] of standards) if (info.font) fonts.set(name, info.font);
  const states = new Map<string, ShowTextState>();
  const refuse = (detail: string): LocalCorrection =>
    ({ outcome: { overlayId: overlay.id, mode: 'unsupported', reason: 'unsupported-unverified-text', detail } });
  const corrupt = new Set<string>();
  const callbacks = {
    resolveFont: (name: string) => {
      const f = fonts.get(name);
      return f ? { ...f, ok: true as const, appliesWordSpacing: f.bytesPerCode === 1 } : { ok: false as const, reason: 'unknown font' };
    },
    extGStateSetsFont: (name: string) => environment.extGStates?.get(name)?.setsFont ?? null,
    onShow: (s: ShowTextState) => states.set(stateKey(s), s),
    onUnplaced: (s: { fontName?: string; origin: { x: number; y: number } | null }) => {
      const name = s.fontName;
      if (name && standards.get(name)?.reason && s.origin && sourceGlyphs?.some(g =>
        close(g.y, s.origin!.y) && close(g.x, s.origin!.x))) corrupt.add(name);
    },
  };
  const before = walkTextPlacements(ops, callbacks);
  if (!before.ok) return;
  const selected = [...removalsByRect(before.glyphs, coverRects)[0]!]
    .sort((a, b) => point(a).x - point(b).x);
  for (const glyph of selected) if (standards.get(glyph.fontName)?.reason) corrupt.add(glyph.fontName);
  const rejectedFont = corrupt.values().next().value;
  if (rejectedFont) return refuse(standards.get(rejectedFont)!.reason!);
  // A legacy selection can identify conflicting source metrics, but that
  // evidence alone cannot certify the positions for a write.
  if (!sourceGlyphs?.length) return;

  const compact = (s: string) => s.replace(/\s/gu, '');
  const label = (g: GlyphPlacement) => fonts.get(g.fontName)?.unicodeByCode.get(g.code) ?? '\ufffd';
  const addressable = selected.filter(g => compact(label(g)));
  if (addressable.map(label).join('') !== compact(originalText)) return;
  const observed = (g: GlyphPlacement) => sourceGlyphs.some(o => o.text === label(g) &&
    close(o.x, point(g).x) && close(o.y, point(g).y) && close(o.advance, g.coreQuad[1].x - point(g).x));
  const prefix = clear ? '' : compact(originalText.slice(0, change!.start));
  let offset = 0;
  const target = addressable.find(g => {
    const startsAt = offset === prefix.length;
    offset += label(g).length;
    return startsAt;
  });
  if (!target) return;
  const standard = standards.get(target.fontName);
  const standardMode = !!standard?.font;
  if (standardMode && addressable.some(g => g.fontName !== target.fontName || !observed(g))) {
    return refuse('standard font advances disagree with the reader');
  }
  if (!observed(target)) return;
  const state = states.get(stateKey(target))!;
  if (state.renderMode !== 0 || Math.abs((state.fontSizePt ?? state.fontSize) - overlay.fontSize) > .01 ||
      state.advanceVector.x <= 0 || Math.abs(state.advanceVector.y) > 1e-8 || Math.abs(state.rise ?? 0) > 1e-8 ||
      !isShow(ops[target.opIndex]!)) return;

  // Ignore only the path clip operator in the dependency check. The clip
  // itself stays in the stream and replacement ink must fit its proved box.
  const safety = runContextSafety(ops.map(op => op.operator === 'W' || op.operator === 'W*'
    ? { ...op, operator: 'n' } : op), environment);
  if (!safety.ok || safety.unsafe.has(target.opIndex)) return;
  const scopes = retypesetScopes(ops);
  const clip = scopes.get(target.opIndex)?.clip;
  if (clip === null) return;
  const result = (output: Uint8Array): LocalCorrection => ({
    bytes: output,
    outcome: { overlayId: overlay.id, mode: 'in-place', fidelity: standardMode ? 'approximate' : 'exact',
      ...(standardMode ? { standardFontMetrics: true } : {}) },
  });
  if (clear) {
    if (!standardMode || clip || selected.some(g => safety.unsafe.has(g.opIndex) || !isShow(ops[g.opIndex]!) ||
        scopes.get(g.opIndex)?.clip !== undefined || states.get(stateKey(g))?.renderMode !== 0 || g.fontName !== target.fontName)) return;
    const removed = removeIdentifiedGlyphs(bytes, ops, selected, undefined, pdfNumber);
    if (removed.changed) return result(removed.bytes);
    return;
  }

  if (label(target) !== originalText.slice(change!.start, change!.end)) return;
  const font = fonts.get(target.fontName)!;
  const raw = dictionary?.lookup(PDFName.of(target.fontName));
  if (!(raw instanceof PDFDict)) return;
  const proof = standardMode ? undefined : localOutlineProof(raw, font);
  if (!standardMode && !proof?.outline(target.code, label(target), true)) return;
  const replacement = change!.replacement;
  const shown = before.glyphs.filter(g => g.fontName === target.fontName && label(g) === replacement && observed(g));
  const candidates = standardMode ? [...font.unicodeByCode].filter(([, value]) => value === replacement).map(([c]) => c)
    : [...shown.map(g => g.code), ...proof!.candidates(replacement)];
  const code = candidates.find(c => Number.isFinite(font.widthOf(c)) && font.widthOf(c) > 0 &&
    (standardMode ? font.widthOf(c) === standard.afm?.widthOf(c) : proof!.outline(c, replacement, shown.some(g => g.code === c))));
  if (code === undefined) return;

  const delta = font.widthOf(code) - font.widthOf(target.code);
  const factor = state.fontSize * state.advanceVector.x / 1000;
  const shift = delta * factor;
  const advanceEnd = (g: GlyphPlacement) => point(g).x + g.tjCompensation * factor;
  const suffix: GlyphPlacement[] = [];
  const startIndex = before.glyphs.indexOf(target);
  if (delta) {
    let previous = target;
    for (const g of before.glyphs.slice(startIndex + 1)) {
      if (g.fontName !== target.fontName || !close(point(g).y, point(target).y) || !compact(label(g)) ||
          Math.abs(point(g).x - advanceEnd(previous)) > (state.fontSizePt ?? state.fontSize) * .2 ||
          ops.slice(previous.opIndex, g.opIndex + 1).some(o => !isShow(o)) || safety.unsafe.has(g.opIndex)) break;
      if (!observed(g) || g.coreQuad[1].x - point(g).x <= 0 || otherCovers.some(r =>
        quadIntersectsRect(g.coreQuad, r) || quadIntersectsRect(g.coreQuad.map(p => ({ x: p.x + shift, y: p.y })) as GlyphPlacement['coreQuad'], r))) return;
      suffix.push(g);
      previous = g;
    }
  }
  const end = suffix.at(-1) ?? target;
  const right = advanceEnd(end);
  const stationary = before.glyphs.filter(g => g !== target && !suffix.includes(g));
  const next = stationary.filter(g => close(point(g).y, point(target).y) && point(g).x >= right - .01)
    .reduce((left, g) => Math.min(left, point(g).x), Infinity);
  if (shift > 0 && right + shift > Math.min(next, page.getCropBox().x + page.getCropBox().width) + .01) return;

  if (clip) {
    if (standardMode) return;
    for (const g of [target, ...suffix]) {
      const changed = g === target;
      const box = proof!.outline(changed ? code : g.code, changed ? replacement : label(g), changed ? shown.some(o => o.code === code) : true);
      const size = states.get(stateKey(g))?.fontSizePt ?? state.fontSize;
      if (!box) return;
      const bounds = { x: point(g).x + (changed ? 0 : shift) + box.x * factor * 1000,
        y: point(g).y + box.y * size, w: box.w * factor * 1000, h: box.h * size };
      if (!contains(clip, bounds)) return;
    }
  }
  const output = rewriteShows(bytes, ops, target, code, end, delta);
  const beforeStates = new Map(states);
  const after = walkTextPlacements(tokenizeContentStream(output), callbacks);
  if (!after.ok || after.glyphs.length !== before.glyphs.length || after.unplacedText !== before.unplacedText) return;
  const moving = new Set(suffix);
  for (const [i, old] of before.glyphs.entries()) {
    const newGlyph = after.glyphs[i]!;
    const dx = moving.has(old) ? shift : 0;
    if (newGlyph.fontName !== old.fontName || newGlyph.code !== (old === target ? code : old.code) ||
        Math.abs(point(newGlyph).x - point(old).x - dx) > .0001 ||
        Math.abs(point(newGlyph).y - point(old).y) > .0001 ||
        Math.abs(states.get(stateKey(newGlyph))!.fontSizePt! - beforeStates.get(stateKey(old))!.fontSizePt!) > .0001) return;
  }
  return result(output);
}
