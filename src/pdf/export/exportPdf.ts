import { PDFDocument } from "pdf-lib";
import type { DocumentModel } from "../model/types";
import { deniedEdits } from "../security/permissions";
import {
  ExportEncryptedSourceError,
  ExportPermissionError,
  type ExportSourceEncryption,
} from "./encryptedSource";
import {
  ExportIntegrityError,
  assertDocumentFilesIntegrity,
  assertExportIntegrity,
} from "./exportIntegrity";
import {
  copyDocumentFiles,
  inspectDocumentFilesForPageSelection,
} from "./navigation";
import { rebuildPdf } from "./rebuildPdf";

export {
  refuseUnhandledEncryption,
  ExportEncryptedSourceError,
  ExportEncryptionUnsupportedError,
  ExportEncryptionVerifyError,
  ExportPermissionError,
} from "./encryptedSource";
export {
  ExportIntegrityError,
  ExportSignedSourceError,
  assertExportIntegrity,
} from "./exportIntegrity";

// "annotations" writes real /Annot objects so highlights, notes, shapes,
// ink, and text remain editable in Acrobat / Foxit / PDF Expert. "flatten"
// burns them into the page content stream — useful for signing, stamping,
// or protecting annotations from removal. "none" skips overlays entirely
// and just exports the original pages in the selected range.
export type ExportMode = "annotations" | "flatten" | "none";
export type ExportQuality = "original" | "standard" | "compact";
export type DocumentFilesPolicy = "auto" | "preserve" | "omit";

export type ExportOptions = {
  mode?: ExportMode;
  quality?: ExportQuality;
  // Document-level EmbeddedFiles are not page annotations. The default
  // preserves them only when the source page set is unchanged; callers that
  // know the user's intent (full document vs page/range sharing) should pass
  // an explicit policy. Page/range export must use "omit" to avoid disclosing
  // hidden source data alongside a small selection of visible pages.
  documentFiles?: DocumentFilesPolicy;
  // The app exports a complete overlay model, so its default is to replace
  // source annotations with the model's annotations. Append-only callers
  // such as the CLI do not own the source annotation set and must preserve it.
  preserveSourceAnnotations?: boolean;
  // An encrypted source's handler (./encryptedSource.ts). With it, edits
  // are rebuilt from the plaintext, checked against the source's
  // permissions first, and leave encrypted like the source; without it an
  // encrypted source can only come back untouched. pdf-lib itself never
  // sees a password and writes no encryption.
  sourceEncryption?: ExportSourceEncryption;
  // Simplified-Chinese CJK font. Used for any non-ASCII text unless
  // the overlay contains hiragana/katakana, in which case the JP font
  // below wins (see pickFont).
  unicodeFontUrl?: string;
  unicodeFontBytes?: Uint8Array;
  boldUnicodeFontUrl?: string;
  // Japanese CJK font. Required to export hiragana/katakana at all —
  // the SC subset does not include kana glyphs.
  unicodeJpFontUrl?: string;
  unicodeJpFontBytes?: Uint8Array;
  boldUnicodeJpFontUrl?: string;
  fontFetchTimeoutMs?: number;
  requireUnicodeFont?: boolean;
  unicodeFontErrorMessage?: string;
};

export type ExportResult = {
  bytes: Uint8Array;
  lostChars: number;
  // Original-text edits whose source glyphs could not all be removed from
  // the page content: the old text is painted over but still in the file,
  // so search and copy return it. Absent means none (a rasterized page
  // carries no source text).
  unexcisedEdits?: number;
};

/**
 * Serialize the open document as the byte-level base for an in-app page
 * merge (pasting an image, appending another PDF). Not a user-facing export.
 *
 * This exists so the merge path cannot reach for a user-facing ExportMode.
 * It once passed "none" — the "Original only" choice — which deletes /Annots
 * wholesale and took the document's links and filled form widgets with it on
 * every paste. Links never enter the overlay model, so that loss had no
 * in-app undo. The default mode is the correct one here: it strips only the
 * markup subtypes the overlay model already owns and re-attaches on export,
 * and leaves everything else (links, widgets, unknown subtypes) alone.
 *
 * Overlays are deliberately empty — the merge must not bake them into the
 * bytes; they stay in the model and are re-attached at the next real export.
 */
export type MergeBaseOptions = Pick<
  ExportOptions,
  "unicodeFontUrl" | "unicodeJpFontUrl" | "unicodeFontBytes" | "unicodeJpFontBytes"
> & {
  // Structural typing means a `Pick<>` parameter alone rejects only excess
  // properties on an object *literal*: a variable already typed as
  // ExportOptions is assignable to it and would smuggle a mode through.
  // `never` makes any present mode — literal or variable — a type error.
  mode?: never;
};

export async function exportMergeBase(
  originalBytes: Uint8Array,
  pages: DocumentModel["pages"],
  options: MergeBaseOptions = {},
): Promise<ExportResult> {
  // Projected field by field rather than forwarded wholesale. Types do not
  // survive to runtime, so spreading the caller's object would still hand
  // exportPdf whatever else it happens to carry.
  return exportPdf(
    originalBytes,
    { pages, overlays: [] },
    {
      documentFiles: "preserve",
      unicodeFontUrl: options.unicodeFontUrl,
      unicodeJpFontUrl: options.unicodeJpFontUrl,
      unicodeFontBytes: options.unicodeFontBytes,
      unicodeJpFontBytes: options.unicodeJpFontBytes,
    },
  );
}

export async function exportPdf(
  originalBytes: Uint8Array,
  model: DocumentModel,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const encryption = options.sourceEncryption;
  if (!encryption) {
    const { bytes, lostChars, unexcisedEdits } = await rebuildPdf(
      originalBytes,
      model,
      options,
    );
    return { bytes, lostChars, unexcisedEdits };
  }
  // Every rebuild of an encrypted source starts from its plaintext, so the
  // permissions are checked before any work and the plaintext export goes
  // nowhere but into the source's own handler.
  const rebuilt = await rebuildPdf(
    await encryption.plaintext(),
    model,
    options,
    (edits) => {
      const denied = deniedEdits(encryption.security, edits);
      if (denied.length > 0) throw new ExportPermissionError(denied);
    },
  );
  if (rebuilt.unchanged) {
    return {
      bytes: new Uint8Array(originalBytes),
      lostChars: 0,
      unexcisedEdits: 0,
    };
  }
  return {
    bytes: await encryption.encrypt(rebuilt.bytes, rebuilt.pageCount),
    lostChars: rebuilt.lostChars,
    unexcisedEdits: rebuilt.unexcisedEdits,
  };
}

/**
 * Add a source PDF's document-level files to an already serialized output.
 *
 * The compact raster path builds pages independently from exportPdf(). This
 * byte-level bridge lets it preserve EmbeddedFiles, /AF, and /Collection with
 * the same raw-object copier, without decoding or reattaching payloads and
 * without copying active /Names/JavaScript entries.
 */
export async function preserveDocumentFilesInPdf(
  sourceBytes: Uint8Array,
  outputBytes: Uint8Array,
): Promise<Uint8Array> {
  const source = await PDFDocument.load(new Uint8Array(sourceBytes), {
    ignoreEncryption: true,
  });
  // Raster pages cannot carry page annotations or page /AF associations.
  // Preserve only file structures rooted outside the page tree (Catalog and
  // Info). A page-only attachment follows the vector page/annotation path and
  // must not make compact export fail after the page was intentionally
  // rasterized.
  const sourceDocumentFiles = inspectDocumentFilesForPageSelection(
    source,
    new Set(),
  );
  // Before any early return: an encrypted source here means a raster is
  // being built without its handler, and must not leave at all. pdf-lib
  // parses it with ignoreEncryption but decrypts nothing, so its files would
  // be ciphertext under a normal EmbeddedFile wrapper anyway.
  if (source.isEncrypted) {
    throw new ExportEncryptedSourceError();
  }
  if (!sourceDocumentFiles.hasDocumentFiles) return outputBytes;
  const output = await PDFDocument.load(new Uint8Array(outputBytes));
  if (!copyDocumentFiles(source, output)) {
    throw new ExportIntegrityError("document-files-missing-after-copy");
  }
  assertDocumentFilesIntegrity(sourceDocumentFiles, output, "preserve");
  const bytes = await output.save({ useObjectStreams: true });
  await assertExportIntegrity(bytes, output.getPageCount());
  return bytes;
}


