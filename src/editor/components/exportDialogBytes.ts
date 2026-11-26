import { createContentTextRenderer } from '../../pdf/engine/contentTextRaster';
import { evaluateAcceptance, type AcceptancePolicy } from "../../pdf/export/acceptance";
import { exportCandidateKeyFromSourceKey } from "../../pdf/export/candidateKey";
import { snapshotKeyFromBytes } from "../../shared/snapshotKey";
import type {
  DocumentFilesPolicy,
  ExportMode,
  ExportOptions,
  ExportResult,
} from "../../pdf/export/exportPdf";
import type { QualityV } from "./exportPrefs";
import {
  cjkJpExportFontUrl,
  cjkScExportFontUrl,
} from "../../pdf/export/fontAssets";
import { appPdfEngine } from "../../pdf/engine/appEngine";
import type { PdfDocument } from "../../pdf/engine/types";
import { exportCompactRasterPdf } from "../export/compactRasterPdfAdapter";
import type { ExportSourceEncryption } from "../../pdf/export/encryptedSource";
import { deniedEdits } from "../../pdf/security/permissions";

// How the export dialog produces its bytes: one export per quality, the
// compact raster with its vector fallback, and the lazily loaded writer.

type ExportPdfModule = typeof import("../../pdf/export/exportPdf");
type ExportPdfFunction = ExportPdfModule["exportPdf"];

const renderContentText = createContentTextRenderer(appPdfEngine);
const glyphReaders = new WeakMap<PdfDocument, NonNullable<ExportOptions["readSourceGlyphs"]>>();

function sourceGlyphReader(doc: PdfDocument): NonNullable<ExportOptions["readSourceGlyphs"]> {
  let read = glyphReaders.get(doc);
  if (!read) {
    read = async (index) => (await appPdfEngine.pageText(doc, index)).glyphs;
    glyphReaders.set(doc, read);
  }
  return read;
}

export type ExportPreviewRequest = {
  doc: PdfDocument;
  originalBytes: Uint8Array;
  // In memory only, like `opened.password`: it opens the source again to
  // re-encrypt the export (src/pdf/export/encryptedSource.ts).
  password: string | undefined;
  model: Parameters<ExportPdfFunction>[1];
  mode: ExportMode;
  documentFiles: Exclude<DocumentFilesPolicy, "auto">;
  unicodeFontErrorMessage: string;
  acceptance?: AcceptancePolicy;
};

type ExportCandidateRequest = ExportPreviewRequest & { quality: QualityV };

// Reopening an encrypted source creates new callbacks every time. The opened
// reader and its credentials identify that source across those wrappers.
const sourceSessions = new WeakMap<PdfDocument, Map<string, number>>();
let nextSession = 0;

function sourceSession({ doc, password = "" }: ExportPreviewRequest): number {
  let sessions = sourceSessions.get(doc);
  if (!sessions) {
    sessions = new Map();
    sourceSessions.set(doc, sessions);
  }
  const existing = sessions.get(password);
  if (existing !== undefined) return existing;
  const id = ++nextSession;
  sessions.set(password, id);
  return id;
}

export function exportDialogCandidateKey(request: ExportCandidateRequest): string {
  const sourceKey = snapshotKeyFromBytes(request.originalBytes);
  return exportCandidateKeyFromSourceKey(
    `${sourceKey}:${sourceSession(request)}`,
    request.model,
    exportOptions(request),
    request.quality === "compact" ? request.doc : undefined,
  );
}

async function exportCompactPdf(
  doc: PdfDocument,
  originalBytes: Uint8Array,
  model: Parameters<ExportPdfFunction>[1],
  options: ExportOptions & { mode: ExportMode; quality: "compact" },
): Promise<ExportResult> {
  const {
    assertExportIntegrity,
    exportPdf,
    preserveDocumentFilesInPdf,
    preserveDocumentInfoInPdf,
    refuseUnhandledEncryption,
  } = await loadExportPdfModule();
  const encryption = options.sourceEncryption;
  // A raster is drawn from the decrypted pages; without the source's
  // handler it would leave in the clear, so an encrypted source stops here.
  if (!encryption) await refuseUnhandledEncryption(originalBytes);
  // An encrypted source's vector export leaves exportPdf encrypted; the
  // plaintext it encrypted is what the raster copies attachments from.
  let vectorPlain: Uint8Array | null = null;
  const capturing: ExportSourceEncryption | undefined = encryption && {
    ...encryption,
    encrypt: (plain, pageCount) => {
      vectorPlain = plain;
      return encryption.encrypt(plain, pageCount);
    },
  };
  // Carry the vector path's full result: when compact falls back to the
  // standard bytes, its lostChars must reach the caller's warning toast —
  // dropping them silently exported "?" glyphs with no notice.
  const vector = await exportPdf(originalBytes, model, {
    ...options,
    sourceEncryption: capturing,
    quality: "standard",
  });
  // Keep the validated vector result with rewritten source paints and any
  // refusals. Compact rasterization draws from the open source pages.
  if (vector.contentTextOutcomes?.length || vector.sourceImageOutcomes?.length) return vector;
  // A raster copy replaces every page's content and its annotations.
  if (
    encryption &&
    deniedEdits(encryption.security, ["content", "annotations"]).length > 0
  ) {
    return vector;
  }
  // The validated vector result already reflects logical page deletion and
  // annotation mode, and carries the source's Info. Using the untouched
  // source here would resurrect files owned only by pages the user removed
  // from the document. An unchanged encrypted vector is the source itself,
  // so its plaintext carries exactly the source's files and Info.
  let plainVector: Uint8Array | null = null;
  const vectorPlaintext = async () =>
    (plainVector ??= encryption
      ? (vectorPlain ?? (await encryption.plaintext()))
      : vector.bytes);
  let rasterBytes: Uint8Array;
  try {
    rasterBytes = await exportCompactRasterPdf(doc, model, {
      mode: options.mode,
    });
    // Title, Author and the rest, whatever the attachment policy. Should
    // they fail to copy, the vector, which has them, is the better file.
    rasterBytes = await preserveDocumentInfoInPdf(
      await vectorPlaintext(),
      rasterBytes,
    );
  } catch (err) {
    console.warn("Compact raster export failed; using standard PDF.", err);
    return vector;
  }
  // Attachment preservation is a data-integrity boundary, not a quality
  // optimization. Keep it outside the raster fallback: if raw copying or its
  // round-trip check fails, the export must fail loudly instead of silently
  // changing the user's selected result.
  if (options.documentFiles === "preserve") {
    rasterBytes = await preserveDocumentFilesInPdf(
      await vectorPlaintext(),
      rasterBytes,
    );
  }
  // Both sides compared as they would be saved: encryption adds a little.
  if (rasterBytes.byteLength >= vector.bytes.byteLength) return vector;
  let bytes: Uint8Array;
  try {
    // The raster path builds its own PDF outside exportPdf(), so it never ran
    // the round-trip guard. Validate it here and fall back to the (already
    // validated) vector bytes if the raster output doesn't hold up.
    await assertExportIntegrity(rasterBytes, model.pages.length);
    // Rasterized pages carry text as pixels — nothing is lost to font
    // fallback on this path. An encrypted source's raster leaves encrypted
    // like the source, or not at all.
    bytes = encryption
      ? await encryption.encrypt(rasterBytes, model.pages.length)
      : rasterBytes;
  } catch (err) {
    console.warn("Compact raster integrity check failed; using standard PDF.", err);
    return vector;
  }
  const candidate = { bytes, lostChars: 0 };
  return {
    ...candidate,
    ...(vector.sourceImageOutcomes && { sourceImageOutcomes: vector.sourceImageOutcomes }),
    acceptance: evaluateAcceptance(candidate, options.acceptance ?? "review"),
  };
}

export async function exportBytesForQuality(
  request: ExportCandidateRequest,
  key = exportDialogCandidateKey(request),
): Promise<ExportResult> {
  const { doc, originalBytes, password, model, quality } = request;
  const result = await withExportEncryption(
    { doc, bytes: originalBytes, password },
    async (sourceEncryption) => {
      const options = { ...exportOptions(request), sourceEncryption };
      if (quality === "compact") {
        return exportCompactPdf(doc, originalBytes, model, { ...options, quality });
      }
      const { exportPdf } = await loadExportPdfModule();
      return exportPdf(originalBytes, model, options);
    },
  );
  // Both compact paths and the vector writer report on their selected bytes.
  // Bind the verdict to the dialog request that produced those bytes.
  return { ...result, acceptance: { ...result.acceptance, key } };
}

function exportOptions({
  acceptance, doc, mode, quality, documentFiles, unicodeFontErrorMessage,
}: ExportCandidateRequest): ExportOptions & { mode: ExportMode } {
  return {
    acceptance,
    mode,
    quality,
    documentFiles,
    unicodeFontUrl: cjkScExportFontUrl,
    unicodeJpFontUrl: cjkJpExportFontUrl,
    requireUnicodeFont: true,
    unicodeFontErrorMessage,
    renderContentText,
    readSourceGlyphs: sourceGlyphReader(doc),
  };
}

export function loadExportPdfModule(): Promise<ExportPdfModule> {
  return import("../export/exportPdfAdapter").then((adapter) =>
    adapter.loadExportPdfModule(),
  );
}

function withExportEncryption<T>(
  ...args: Parameters<
    typeof import("../export/exportPdfAdapter").withExportEncryption<T>
  >
): Promise<T> {
  return import("../export/exportPdfAdapter").then((adapter) =>
    adapter.withExportEncryption(...args),
  );
}
