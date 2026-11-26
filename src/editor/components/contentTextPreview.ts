import { PDFDocument } from 'pdf-lib';
import { createContentTextRenderer } from '../../pdf/engine/contentTextRaster';
import type { PdfDocument } from '../../pdf/engine/types';
import { evaluateAcceptance, type AcceptanceVerdict } from '../../pdf/export/acceptance';
import { exportCandidateKeyFromSourceKey } from '../../pdf/export/candidateKey';
import type { ContactRenderer } from '../../pdf/export/contentText/contentTextRaster';
import type { ContentTextOutcome } from '../../pdf/export/contentText/outcomes';
import type { ExportOptions, ExportResult } from '../../pdf/export/exportPdf';
import { cjkJpExportFontUrl, cjkScExportFontUrl } from '../../pdf/export/fontAssets';
import { hasStructure } from '../../pdf/export/semantic/probe';
import { alignPageTreeWithPdfium } from '../../pdf/export/sourcePageTree';
import { rebuildPdf } from '../../pdf/export/rebuildPdf';
import { isBlankPage, type ContentTextOverlay, type PageModel, type SourceImageEditOverlay, type TextFlowChain } from '../../pdf/model/types';
import { snapshotKeyFromBytes } from '../../shared/snapshotKey';

export type PageContentEdit = ContentTextOverlay | SourceImageEditOverlay;

export type ContentTextPreview = {
  imageOutcomes?: ExportResult["sourceImageOutcomes"];
  bytes: Uint8Array | null;
  pageIndex?: number;
  outcomes: ContentTextOutcome[];
  semanticChanges?: import('../../pdf/export/semanticGate').SemanticChange[];
  acceptance: AcceptanceVerdict;
};

export type ContentTextPreviewOptions = Omit<ExportOptions, 'sourceEncryption'> & {
  flowChains?: readonly TextFlowChain[];
};

const cache = new Map<string, Promise<ContentTextPreview>>();
const openedSourceKeys = new WeakMap<Uint8Array, string>();
const glyphReaders = new WeakMap<PdfDocument, NonNullable<ExportOptions['readSourceGlyphs']>>();
let appRenderer: ContactRenderer | undefined;

const renderWithAppEngine: ContactRenderer = async (...args) => {
  if (!appRenderer) {
    const { appPdfEngine } = await import('../../pdf/engine/appEngine');
    appRenderer ??= createContentTextRenderer(appPdfEngine);
  }
  return appRenderer(...args);
};

function sourceGlyphReader(doc: PdfDocument): NonNullable<ExportOptions['readSourceGlyphs']> {
  let read = glyphReaders.get(doc);
  if (!read) {
    read = async index => {
      const { appPdfEngine } = await import('../../pdf/engine/appEngine');
      return (await appPdfEngine.pageText(doc, index)).glyphs;
    };
    glyphReaders.set(doc, read);
  }
  return read;
}

/** Prepare a request for immutable opened PDF bytes so typing only hashes the edit. */
export function prepareContentTextPreview(
  bytes: Uint8Array,
  page: PageModel,
  overlays: readonly PageContentEdit[],
  sourceDoc?: PdfDocument,
  options?: ContentTextPreviewOptions,
) {
  let sourceKey = openedSourceKeys.get(bytes);
  if (!sourceKey) {
    sourceKey = snapshotKeyFromBytes(bytes);
    openedSourceKeys.set(bytes, sourceKey);
  }
  return previewRequest(bytes, sourceKey, page, overlays, sourceDoc, undefined, options);
}

export function contentTextPreviewKey(
  bytes: Uint8Array,
  page: PageModel,
  overlays: readonly PageContentEdit[],
  sourceDoc?: PdfDocument,
  options?: ContentTextPreviewOptions,
) {
  return prepareContentTextPreview(bytes, page, overlays, sourceDoc, options).key;
}

export function buildContentTextPreview(
  bytes: Uint8Array,
  page: PageModel,
  overlays: readonly PageContentEdit[],
  sourceDoc?: PdfDocument,
  renderContact?: ContactRenderer,
  options?: ContentTextPreviewOptions,
): Promise<ContentTextPreview> {
  return previewRequest(bytes, snapshotKeyFromBytes(bytes), page, overlays, sourceDoc, renderContact, options).build();
}

function previewRequest(
  bytes: Uint8Array,
  sourceKey: string,
  page: PageModel,
  overlays: readonly PageContentEdit[],
  sourceDoc?: PdfDocument,
  renderContact?: ContactRenderer,
  options?: ContentTextPreviewOptions,
) {
  const { flowChains, ...writerOptions } = options ?? {};
  const linkedIds = new Set(overlays.flatMap(overlay => overlay.type === 'contentText' && overlay.flowChainId ? [overlay.flowChainId] : []));
  // Keep the complete referenced chains so the writer can explain a cross-page refusal.
  const referenced = flowChains?.filter(chain => linkedIds.has(chain.id));
  const model = { pages: [page], overlays: [...overlays], ...(referenced?.length ? { flowChains: referenced } : {}) };
  const effective: ExportOptions = {
    unicodeFontUrl: cjkScExportFontUrl,
    unicodeJpFontUrl: cjkJpExportFontUrl,
    ...writerOptions,
    mode: options?.mode ?? 'flatten',
    sourceEncryption: undefined,
    renderContentText: options?.renderContentText ?? renderContact ?? (sourceDoc ? renderWithAppEngine : undefined),
    readSourceGlyphs: options?.readSourceGlyphs ?? (sourceDoc ? sourceGlyphReader(sourceDoc) : undefined),
  };
  const policy = effective.acceptance ?? 'review';
  const key = exportCandidateKeyFromSourceKey(sourceKey, model, effective);
  return {
    key,
    build: () => {
      const existing = cache.get(key);
      if (existing) return existing;
      const work = (async (): Promise<ContentTextPreview> => {
        if (!overlays.length) {
          return { bytes: null, outcomes: [], acceptance: evaluateAcceptance({ lostChars: 0 }, policy, key) };
        }
        const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
        if (source.isEncrypted) throw Error('encrypted preview unavailable');
        // Keeping the other pages lets the writer verify the copied structure
        // and shared Forms for the page that will actually be displayed.
        let pageIndex = 0;
        let previewModel = model;
        if (!isBlankPage(page)) alignPageTreeWithPdfium(source);
        if (!isBlankPage(page) && hasStructure(source)) {
          pageIndex = page.sourceIndex;
          previewModel = { ...model, pages: source.getPages().map((original, index) => {
            const crop = original.getCropBox();
            const rotation = (((original.getRotation().angle % 360) + 360) % 360) as PageModel['rotation'];
            return index === pageIndex ? { ...page, rotation } : {
              id: `${page.id}:source-page:${index}`, sourceIndex: index, widthPt: crop.width, heightPt: crop.height,
              rotation, originXPt: crop.x, originYPt: crop.y,
            };
          }) };
        }
        const result = await rebuildPdf(bytes, previewModel, effective);
        const outcomes = result.contentTextOutcomes ?? [];
        const imageOutcomes = result.sourceImageOutcomes;
        const drawn = !isBlankPage(page) && (outcomes.some(outcome => outcome.mode !== 'unsupported') ||
          imageOutcomes?.some(outcome => outcome.mode === 'applied'));
        return {
          bytes: drawn ? result.bytes : null,
          ...(pageIndex !== 0 && { pageIndex }),
          outcomes,
          ...(imageOutcomes && { imageOutcomes }),
          ...(result.semanticChanges?.length && { semanticChanges: result.semanticChanges }),
          acceptance: evaluateAcceptance(result, policy, key),
        };
      })().catch(error => {
        if (cache.get(key) === work) cache.delete(key);
        throw error;
      });
      cache.set(key, work);
      if (cache.size > 8) cache.delete(cache.keys().next().value!);
      return work;
    },
  };
}
