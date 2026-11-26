import { PDFArray, PDFContentStream, PDFName, PDFPage, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from 'pdf-lib';
import type { PDFDict } from 'pdf-lib';
import { effectivePdfPageBox } from '../../model/pageBoxes';
import { coalesceContentStreams, tokenizeContentStream } from '../contentStreamEdit/tokenizer';
import { inlineImageExtent } from '../sourceImages/inline';
import { resourceKey } from '../sourceImages/objects';
import type { ContentOp } from '../contentStreamEdit/tokenizer';
import { walkTextPlacements } from '../contentStreamEdit/textState';
import type { TextGraphicsState } from '../contentStreamEdit/textGraphicsState';
import { substituteSourceFonts } from '../contentStreamEdit/substituteSource';
import { verticalWritingReason } from '../contentStreamEdit/verticalWriting';
import { readVerticalFont } from '../contentText/verticalFont';
import { contentFontInfo } from '../contentStreamEdit/glyphWidths';
import type { ContentFontInfo, UnsupportedFont } from '../contentStreamEdit/glyphWidths';
import { box, composeFormMatrix, identity, tracePaint, transformedBox, union } from './geometry';
import { asDict, asName, entry, numberArray, value } from './pdfValues';
import { readMarkedContent, reportIssue } from './markedContent';
import type { SemanticOccurrence, SemanticPage, SemanticPaint } from './types';

type Parsed = { bytes: Uint8Array; ops: ContentOp[]; partStarts: number[] };
type Initial = {
  matrix?: readonly number[];
  state?: TextGraphicsState;
  font?: ContentFontInfo | UnsupportedFont;
};

const textShows = new Set(['Tj', 'TJ', "'", '"']);
const noMetrics = { ok: false, reason: 'Unresolved font metrics' } as const;

export function decodedContent(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFContentStream) return stream.getUnencodedContents();
  if (stream instanceof PDFRawStream) return entry(stream.dict, 'Filter') ? decodePDFRawStream(stream).decode() : stream.getContents();
  throw Error('Unsupported content stream');
}

export function contentParts(owner: PDFDict): PDFStream[] | undefined {
  const raw = value(owner, 'Contents');
  if (!raw && entry(owner, 'Contents') === undefined) return [];
  const parts = raw instanceof PDFArray ? raw.asArray().map((_, index) => raw.lookup(index)) : [raw];
  if (parts.every(part => part instanceof PDFStream)) return parts;
}

export function makeContentReader(images = false) {
  const specialFonts = new WeakMap<PDFDict, ReadonlyMap<string, ContentFontInfo & {
    unicodeByCode?: ReadonlyMap<number, string>;
  }>>();
  const specialMetrics = (page: PDFPage, resources: PDFDict | undefined) => {
    if (!resources) return;
    const cached = specialFonts.get(resources);
    if (cached) return cached;
    const fonts = asDict(value(resources, 'Font'));
    const entries = fonts?.entries().flatMap(([name, ref]) => {
      const font = asDict(fonts.context.lookup(ref));
      return font ? [{ name: name.decodeText(), font }] : [];
    }) ?? [];
    const metrics = new Map<string, ContentFontInfo & { unicodeByCode?: ReadonlyMap<number, string> }>();
    if (entries.some(({ font }) => asName(value(font, 'Subtype')) === 'Type3')) {
      const node = page.node.clone();
      node.set(PDFResources, resources);
      try {
        for (const font of substituteSourceFonts(PDFPage.of(node, page.ref, page.doc), { flippedType3: true })) {
          metrics.set(font.resourceName, { ...font, ok: true, appliesWordSpacing: font.bytesPerCode === 1 });
        }
      } catch { /* Missing Type3 metrics leave the shows unresolved. */ }
    }
    for (const { name, font } of entries) {
      if (!verticalWritingReason(font)) continue;
      try {
        const vertical = readVerticalFont(font, name);
        const unicodeByCode = new Map([...vertical.labels].map(([code, text]) => [parseInt(code, 16), text]));
        metrics.set(name, { ...vertical, unicodeByCode });
      } catch { /* Missing vertical metrics leave the shows unresolved. */ }
    }
    specialFonts.set(resources, metrics);
    return metrics;
  };
  const decodedParts = new WeakMap<PDFStream, Uint8Array>();
  const parsedStreams = new WeakMap<PDFStream, Parsed | null>();
  const parse = (parts: PDFStream[], readInlineData?: Parameters<typeof tokenizeContentStream>[1]): Parsed | null => {
    const single = !readInlineData && parts.length === 1 ? parts[0] : undefined;
    if (single && parsedStreams.has(single)) return parsedStreams.get(single)!;
    let result: Parsed | null = null;
    try {
      const partStarts: number[] = [];
      let offset = 0;
      const chunks = parts.map(part => {
        let data = decodedParts.get(part);
        if (!data) {
          data = decodedContent(part);
          decodedParts.set(part, data);
        }
        partStarts.push(offset);
        offset += data.length + 1; // coalesceContentStreams inserts one space.
        return data;
      });
      const bytes = chunks.length ? coalesceContentStreams(chunks) : new Uint8Array();
      result = { bytes, ops: tokenizeContentStream(bytes, readInlineData), partStarts };
    } catch { /* An undecodable stream has no trustworthy operator addresses. */ }
    if (single) parsedStreams.set(single, result);
    return result;
  };

  return (page: PDFPage, inspection: SemanticPage) => {
    const crop = effectivePdfPageBox(page.getMediaBox(), page.getCropBox());
    const origin = [1, 0, 0, 1, -crop.x, -crop.y];
    const ancestors = new Set<PDFStream>();
    const pageResources = asDict(page.doc.context.lookup(page.node.getInheritableAttribute(PDFResources)));
    const visit = (occurrence: SemanticOccurrence, initial: Initial, unreadable = false): void => {
      inspection.occurrences.push(occurrence);
      const group = (kind: string) => {
        const resources = occurrence.resources;
        return (resources && asDict(value(resources, kind))) ?? (images && pageResources ? asDict(value(pageResources, kind)) : undefined);
      };
      const colors = images ? group('ColorSpace') : undefined;
      const parsed = unreadable ? null : parse(occurrence.parts, images ? (bytes, entries, afterId) =>
        inlineImageExtent(bytes, entries, afterId, name => {
          const key = colors && resourceKey(colors, name);
          return key && colors.lookup(key);
        }) : undefined);
      if (!parsed) {
        reportIssue(inspection, 'content-stream', { occurrence }, occurrence.inheritedSpans);
        return;
      }
      occurrence.bytes = parsed.bytes;
      occurrence.ops = parsed.ops;
      occurrence.partStarts = parsed.partStarts;
      readMarkedContent(inspection, occurrence);
      const inheritedStates = measureText(inspection, occurrence, initial, specialMetrics(page, occurrence.resources));
      tracePaint(parsed.ops, initial.matrix, (index, matrix, bounds) => {
        const op = parsed.ops[index]!;
        const spans = occurrence.scopesByOp[index]!;
        const paint: SemanticPaint = { occurrence, opIndex: index, spans, bbox: bounds };
        occurrence.paints.push(paint);
        for (const span of spans) span.paints.push(paint);
        if (op.operator === 'Do') {
          followXObject(paint, matrix, inheritedStates.get(index));
        } else if (!bounds && spans.length) {
          reportIssue(inspection, 'coverage', { occurrence, opIndex: index }, spans);
        }
        // The child placements supply a caller span's actual coverage.
        // A Form paint retains its own BBox for object-level dependencies.
        if (!paint.child) for (const span of spans) span.bbox = union(span.bbox, paint.bbox);
      });
    };

    const followXObject = (paint: SemanticPaint, matrix: readonly number[] | undefined, inherited: Pick<Initial, 'state' | 'font'> | undefined) => {
      const parent = paint.occurrence;
      const at = { occurrence: parent, opIndex: paint.opIndex };
      const op = parent.ops[paint.opIndex]!;
      const operand = op.operands[0];
      const objects = (parent.resources && asDict(value(parent.resources, 'XObject'))) ??
        (images && pageResources ? asDict(value(pageResources, 'XObject')) : undefined);
      const named = operand?.kind === 'name' && objects?.entries().find(([key]) => key.decodeText() === operand.value);
      const reference = named ? named[1] : undefined;
      const target = page.doc.context.lookup(reference);
      if (!(target instanceof PDFStream)) {
        reportIssue(inspection, 'xobject', { ...at, reference }, paint.spans);
        return;
      }
      paint.object = target;
      paint.objectRef = reference;
      const subtype = asName(value(target.dict, 'Subtype'));
      if (subtype === 'Image' && matrix) paint.bbox = transformedBox(matrix, [0, 0, 1, 1]);
      if (subtype === 'Form') {
        const local = entry(target.dict, 'Matrix') ? numberArray(value(target.dict, 'Matrix'), 6) : identity;
        const transform = matrix && local && composeFormMatrix(matrix, local);
        const bounds = numberArray(value(target.dict, 'BBox'), 4);
        if (transform && bounds) paint.bbox = transformedBox(transform, bounds);
        if (ancestors.has(target) || ancestors.size >= 64 || inspection.occurrences.length >= 4096) {
          reportIssue(inspection, ancestors.has(target) ? 'form-cycle' : 'form-limit', at, paint.spans);
          recordObject(inspection, paint);
          return;
        }
        const resources = entry(target.dict, 'Resources') === undefined
          ? parent.resources : asDict(value(target.dict, 'Resources'));
        const child = makeOccurrence(
          `${parent.address}/${paint.opIndex}`, reference instanceof PDFRef ? reference.toString() : undefined,
          target.dict, [target], resources, paint,
        );
        child.raw = target;
        if (!transform || !bounds) reportIssue(inspection, 'coverage', { occurrence: child }, paint.spans);
        if (!child.stream) reportIssue(inspection, 'xobject', { occurrence: child }, paint.spans);
        paint.child = child;
        ancestors.add(target);
        visit(child, { matrix: transform, ...inherited });
        ancestors.delete(target);
      } else if (!paint.bbox) {
        reportIssue(inspection, 'coverage', at, paint.spans);
      }
      recordObject(inspection, paint);
    };

    const parts = contentParts(page.node);
    visit(makeOccurrence('page', 'page', page.node, parts ?? [], pageResources), { matrix: origin }, !parts);
    const annotations = value(page.node, 'Annots');
    if (annotations instanceof PDFArray) {
      for (const raw of annotations.asArray()) {
        const annot = asDict(page.doc.context.lookup(raw));
        if (!annot) continue;
        const rect = numberArray(value(annot, 'Rect'), 4);
        inspection.objects.set(annot, { object: annot, reference: raw, paints: [], issues: [], bbox: rect && transformedBox(origin, rect) });
      }
    }
  };
}

const PDFResources = PDFName.of('Resources');

function makeOccurrence(
  address: string, stream: string | undefined, owner: PDFDict, parts: PDFStream[], resources?: PDFDict, invocation?: SemanticPaint,
): SemanticOccurrence {
  return {
    address, stream, owner, parts, resources, invocation, ops: [], partStarts: [],
    inheritedSpans: invocation?.spans ?? [], spans: [], scopesByOp: [], glyphs: [], paints: [], issues: [],
  };
}

function recordObject(page: SemanticPage, paint: SemanticPaint): void {
  const object = paint.object!;
  const record = page.objects.get(object);
  if (record) {
    record.paints.push(paint);
    record.bbox = union(record.bbox, paint.bbox);
  } else page.objects.set(object, { object, reference: paint.objectRef, paints: [paint], issues: [], bbox: paint.bbox });
}

function resourceDictionary(resources: PDFDict | undefined, kind: string) {
  return resources && asDict(value(resources, kind));
}

function measureText(
  inspection: SemanticPage, occurrence: SemanticOccurrence, initial: Initial,
  special: ReadonlyMap<string, ContentFontInfo & { unicodeByCode?: ReadonlyMap<number, string> }> | undefined,
) {
  const invocations = new Map<number, Pick<Initial, 'state' | 'font'>>();
  const measured = new Set<number>();
  const unavailable = new Set<number>();
  let fontSizePt: number | undefined;
  const fonts = resourceDictionary(occurrence.resources, 'Font');
  const states = resourceDictionary(occurrence.resources, 'ExtGState');
  const byFont = new Map(fonts?.entries().map(([key, ref]) => [key.decodeText(), asDict(fonts.context.lookup(ref))]));
  const byState = new Map(states?.entries().map(([key, ref]) => [key.decodeText(), asDict(states.context.lookup(ref))]));
  if (initial.matrix) walkTextPlacements(occurrence.ops, {
    initialState: {
      charSpacing: 0, wordSpacing: 0, horizontalScale: 1, leading: 0, rise: 0, renderMode: 0,
      fontName: null, fontSize: 0, fontTainted: false,
      ...initial.state, ctm: [...initial.matrix] as TextGraphicsState['ctm'],
    },
    includeStroked: true,
    onShow: state => { fontSizePt = state.fontSizePt; },
    inspection: {
      inheritedFont: initial.font,
      onForm: (use, state, font) => invocations.set(use.opIndex, { state, font: font ?? noMetrics }),
      onGlyph: placement => {
        const spans = occurrence.scopesByOp[placement.opIndex]!;
        const glyph = { placement, spans, occurrence, fontSizePt, unicode: special?.get(placement.fontName)?.unicodeByCode?.get(placement.code) };
        occurrence.glyphs.push(glyph);
        const bounds = box(placement.quad);
        for (const span of spans) {
          span.glyphs.push(glyph);
          span.bbox = union(span.bbox, bounds);
        }
      },
    },
    onTextOpEnd: index => measured.add(index),
    resolveFont: name => {
      const metrics = special?.get(name);
      if (metrics) return metrics;
      const font = byFont.get(name);
      if (font) {
        try { return contentFontInfo(font, { sourceReuse: false, standard14Afm: true }); }
        catch { /* The font has no usable local metrics. */ }
      }
      return noMetrics;
    },
    extGStateSetsFont: name => byState.get(name)?.has(PDFName.of('Font')) ?? null,
    onUnplaced: show => unavailable.add(show.opIndex),
  });
  for (const [opIndex, op] of occurrence.ops.entries()) {
    if (textShows.has(op.operator) && (!measured.has(opIndex) || unavailable.has(opIndex))) {
      reportIssue(inspection, 'coverage', { occurrence, opIndex }, occurrence.scopesByOp[opIndex]);
    }
  }
  return invocations;
}
