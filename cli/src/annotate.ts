import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { EncryptedPDFError, PDFDocument } from "pdf-lib";
import { exportPdf } from "../../src/pdf/export/exportPdf";
import {
  hasCjkText,
  hasKana,
  hasNonAscii,
} from "../../src/pdf/export/textScripts";
import type {
  CalloutOverlay,
  DocumentModel,
  Overlay,
  OverlayTextAnchor,
  PageModel,
  Rotation,
  TextOverlay,
} from "../../src/pdf/model/types";
import { attachResolvedAnchors } from "../../src/pdf/annotations/resolveAnchors";
import { effectivePdfPageBox } from "../../src/pdf/model/pageBoxes";
import {
  AnnotationSpecError,
  parseAnnotationSpec,
} from "../../src/pdf/annotations/parseSpec";
import {
  MAX_PDF_BYTES,
  PdfOpenError,
  assertPdfPageDimensionsWithinLimit,
  assertPdfWithinFileLimit,
  assertPdfWithinPageLimit,
  classifyPdfOpenError,
  diagnosticCode,
  type PdfOpenErrorKind,
} from "../../src/pdf/openPolicy";
import { MAX_ANNOTATION_SPEC_BYTES } from "./annotationSpec";
import { BoundedFileError, readFileWithinLimit } from "./safeRead";
import { resolveCliRuntimeAssets } from "./runtimeAssets";
import {
  AtomicOutputExistsError,
  AtomicOutputPublishedOutcomeUnknownError,
  commitAtomicOutput,
  openAtomicOutputTemp,
  readAtomicOutputIdentity,
} from "./atomicOutput";
import {
  FileIdentityUnverifiableError,
  compareFileIdentities,
  readFileIdentity,
  type FileIdentity,
} from "./fileIdentity";

export type AnnotateCliErrorCode =
  | "ERR_FILE_UNAVAILABLE"
  | "ERR_SPEC_INVALID"
  | "ERR_OUTPUT_EXISTS"
  | "ERR_OUTPUT_CONFLICT"
  | "ERR_OUTPUT_OUTCOME_UNKNOWN"
  | "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED"
  | "ERR_CONFIRMATION_REQUIRED"
  | "ERR_WRITE_FAILED"
  | "ERR_EXPORT_FAILED"
  | "ERR_BASE_HASH_MISMATCH"
  | ReturnType<typeof diagnosticCode>;

export type CreateAnnotateError = (
  code: AnnotateCliErrorCode,
  message: string,
  detail?: string,
) => Error;

export type AnnotateInputFile = {
  path: string;
  sizeBytes: number;
};

export type AnnotateCommandOptions = {
  /** Absent only when preloadedSpec carries a synthesized (fileless) spec. */
  specPath?: string;
  outputPath: string;
  force?: boolean;
  inPlace?: boolean;
  dryRun?: boolean;
  baseSha256?: string;
  /** Exact source snapshot already used for anchor resolution. Supplying it
   * prevents coordinates from one file revision being written to another. */
  preloadedSourceBytes?: Uint8Array;
  /** Spec already read (and possibly anchor-resolved) by the caller. bytes
   * MUST be the original file bytes: patchSha256 and the annotation-id
   * namespace hash what the user wrote, not what resolution produced, so
   * ids stay stable however the resolver evolves. */
  preloadedSpec?: { value: unknown; bytes: Uint8Array };
  /** Anchor provenance from resolution, index-aligned with the resolved
   * spec's annotations; attached to the built overlays so the exported PDF
   * records where each anchored annotation textually landed. */
  resolvedAnchors?: ReadonlyMap<number, OverlayTextAnchor>;
};

export type AnnotateWriteResult = {
  command: "annotate";
  input: string;
  output: string;
  written: number;
  lostChars: number;
  inputSha256: string;
  patchSha256: string;
};

export type AnnotatePlanResult = {
  command: "annotate";
  dryRun: true;
  operation: "annotations.apply";
  input: {
    path: string;
    sha256: string;
    pageCount: number;
  };
  output: {
    path: string;
    exists: boolean;
    sameAsInput: boolean;
    symlink: boolean;
    replacementSupported: false;
    requiresNewPath: boolean;
  };
  writes: Array<{ path: string; kind: "pdf" }>;
  patch: {
    sha256: string;
    ops: number;
  };
};

export type AnnotateResult = AnnotateWriteResult | AnnotatePlanResult;

type SpecFile = {
  /** null for synthesized specs that never lived on disk. */
  path: string | null;
  value: unknown;
  bytes: Uint8Array;
};

export type OutputPolicy = {
  exists: boolean;
  isSymlink: boolean;
  sameAsInput: boolean;
};

export async function annotateDocument(
  inputFile: AnnotateInputFile,
  options: AnnotateCommandOptions,
  createError: CreateAnnotateError,
): Promise<AnnotateResult> {
  const input = resolve(inputFile.path);
  const output = resolve(options.outputPath);
  if (!options.preloadedSpec && options.specPath == null) {
    throw createError("ERR_FILE_UNAVAILABLE", "Annotation spec is required");
  }
  const spec: SpecFile = options.preloadedSpec
    ? {
        path: options.specPath == null ? null : resolve(options.specPath),
        value: options.preloadedSpec.value,
        bytes: options.preloadedSpec.bytes,
      }
    : await readSpecJson(options.specPath!, createError);
  const sourceBytes =
    options.preloadedSourceBytes ??
    (await readAnnotateSourcePdf(inputFile, createError));
  try {
    assertPdfWithinFileLimit(sourceBytes.byteLength);
  } catch (err) {
    throw cliErrorForPdfOpenError(err, createError);
  }
  const inputSha256 = sha256(sourceBytes);
  const patchSha256 = sha256(spec.bytes);
  const annotationNamespace = createHash("sha256")
    .update(inputSha256)
    .update(patchSha256)
    .digest("hex")
    .slice(0, 16);
  assertBaseHash(inputSha256, options.baseSha256, createError);
  const pages = await readPageModels(sourceBytes, sourceBytes.byteLength, createError);
  let overlays: Overlay[];
  try {
    overlays = attachResolvedAnchors(
      parseAnnotationSpec(spec.value, pages, {
        namespace: annotationNamespace,
        idPrefix: "cli",
      }),
      options.resolvedAnchors,
    );
  } catch (err) {
    if (err instanceof AnnotationSpecError) {
      throw createError("ERR_SPEC_INVALID", err.message);
    }
    throw err;
  }
  const outputPolicy = await inspectOutputPolicy(
    input,
    spec.path,
    output,
    options,
    createError,
  );

  if (options.dryRun) {
    return {
      command: "annotate",
      dryRun: true,
      operation: "annotations.apply",
      input: {
        path: input,
        sha256: inputSha256,
        pageCount: pages.length,
      },
      output: {
        path: output,
        exists: outputPolicy.exists,
        sameAsInput: outputPolicy.sameAsInput,
        symlink: outputPolicy.isSymlink,
        replacementSupported: false,
        requiresNewPath: outputPolicy.exists,
      },
      writes: [{ path: output, kind: "pdf" }],
      patch: { sha256: patchSha256, ops: overlays.length },
    };
  }

  const model: DocumentModel = { pages, overlays };
  const fontOptions = await loadCliFontOptions(overlays, createError);
  let result: Awaited<ReturnType<typeof exportPdf>>;
  try {
    result = await exportPdf(sourceBytes, model, {
      mode: "annotations",
      // `readPageModels` normalizes pathological CropBoxes, so geometry alone
      // cannot reliably prove this is a whole-document export. Annotate always
      // includes every source page and must state that intent explicitly.
      documentFiles: "preserve",
      preserveSourceAnnotations: true,
      ...fontOptions,
    });
  } catch (err) {
    throw createError(
      "ERR_EXPORT_FAILED",
      "Could not create the annotated PDF safely",
      err instanceof Error ? err.message : String(err),
    );
  }
  await atomicWritePdf(
    output,
    result.bytes,
    createError,
  );

  return {
    command: "annotate",
    input,
    output,
    written: overlays.length,
    lostChars: result.lostChars,
    inputSha256,
    patchSha256,
  };
}

async function loadCliFontOptions(
  overlays: Overlay[],
  createError: CreateAnnotateError,
): Promise<{
  unicodeFontBytes?: Uint8Array;
  unicodeJpFontBytes?: Uint8Array;
  requireUnicodeFont?: boolean;
  unicodeFontErrorMessage?: string;
}> {
  const textOverlays = overlays.filter(
    (overlay): overlay is TextOverlay | CalloutOverlay =>
      overlay.type === "text" || overlay.type === "callout",
  );
  const needsCjkFallbackPair = textOverlays.some((overlay) =>
    hasCjkText(overlay.text)
  );
  const needsSc = needsCjkFallbackPair || textOverlays.some(
    (overlay) =>
      overlay.fontFamily === "notoSansSc" ||
      (overlay.fontFamily !== "notoSansJp" &&
        hasNonAscii(overlay.text) &&
        !hasKana(overlay.text)),
  );
  const needsJp = needsCjkFallbackPair || textOverlays.some(
    (overlay) =>
      overlay.fontFamily === "notoSansJp" ||
      (overlay.fontFamily !== "notoSansSc" &&
        hasKana(overlay.text)),
  );
  if (!needsSc && !needsJp) return {};

  try {
    const assets = resolveCliRuntimeAssets();
    const [sc, jp] = await Promise.all([
      needsSc ? readFile(assets.notoSansSc) : Promise.resolve(null),
      needsJp ? readFile(assets.notoSansJp) : Promise.resolve(null),
    ]);
    return {
      ...(sc ? { unicodeFontBytes: new Uint8Array(sc) } : {}),
      ...(jp ? { unicodeJpFontBytes: new Uint8Array(jp) } : {}),
      requireUnicodeFont: true,
      unicodeFontErrorMessage: "Required Shiori CLI CJK font is unavailable",
    };
  } catch (err) {
    throw createError(
      "ERR_FILE_UNAVAILABLE",
      "Required Shiori CLI CJK font is unavailable",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function readSpecJson(
  specPathInput: string,
  createError: CreateAnnotateError,
): Promise<SpecFile> {
  const specPath = resolve(specPathInput);
  let bytes: Buffer;
  try {
    bytes = await readFileWithinLimit(specPath, MAX_ANNOTATION_SPEC_BYTES);
  } catch (err) {
    if (err instanceof BoundedFileError && err.reason === "not-a-file") {
      throw createError("ERR_FILE_UNAVAILABLE", "Path is not a file", specPath);
    }
    if (err instanceof BoundedFileError && err.reason === "too-large") {
      throw createError(
        "ERR_SPEC_INVALID",
        "Annotation spec exceeds the input limit",
        `${specPath}: ${err.sizeBytes ?? 0} bytes`,
      );
    }
    throw createError("ERR_FILE_UNAVAILABLE", "Could not read file", specPath);
  }

  try {
    return {
      path: specPath,
      value: JSON.parse(bytes.toString("utf8")),
      bytes: new Uint8Array(bytes),
    };
  } catch (err) {
    throw createError(
      "ERR_SPEC_INVALID",
      "Spec JSON is malformed",
      err instanceof Error ? err.message : undefined,
    );
  }
}

export async function readAnnotateSourcePdf(
  inputFile: AnnotateInputFile,
  createError: CreateAnnotateError,
): Promise<Uint8Array> {
  const input = resolve(inputFile.path);
  try {
    assertPdfWithinFileLimit(inputFile.sizeBytes);
  } catch (err) {
    throw cliErrorForPdfOpenError(err, createError);
  }

  try {
    return new Uint8Array(await readFileWithinLimit(input, MAX_PDF_BYTES));
  } catch (err) {
    if (err instanceof BoundedFileError && err.reason === "too-large") {
      throw cliErrorForPdfOpenError(
        new PdfOpenError("tooLarge", `PDF is ${err.sizeBytes ?? 0} bytes`),
        createError,
      );
    }
    throw createError("ERR_FILE_UNAVAILABLE", "Could not read file", input);
  }
}

async function readPageModels(
  sourceBytes: Uint8Array,
  sizeBytes: number,
  createError: CreateAnnotateError,
): Promise<PageModel[]> {
  try {
    assertPdfWithinFileLimit(sizeBytes);
    // pdf-lib cannot decrypt an encrypted input with a supplied password, and
    // exporting bytes loaded via `ignoreEncryption` can produce a structurally
    // valid but unreadable PDF. Always fail closed before export instead.
    const pdf = await PDFDocument.load(sourceBytes);
    const sourcePages = pdf.getPages();
    assertPdfWithinPageLimit(sourcePages.length);
    return sourcePages.map((page, index) => {
      const { x, y, width, height } = effectivePdfPageBox(
        page.getMediaBox(),
        page.getCropBox(),
      );
      assertPdfPageDimensionsWithinLimit(width, height, index + 1);
      return {
        id: `page-${index + 1}`,
        sourceIndex: index,
        rotation: normalizeRotation(page.getRotation().angle),
        originXPt: x,
        originYPt: y,
        widthPt: width,
        heightPt: height,
      };
    });
  } catch (err) {
    if (isCliErrorLike(err)) throw err;
    if (
      err instanceof EncryptedPDFError ||
      classifyPdfOpenError(err) === "password"
    ) {
      throw createError(
        diagnosticCode("password"),
        "Encrypted PDFs cannot be modified safely",
        "Password-based PDF decryption is not supported for annotate",
      );
    }
    throw cliErrorForPdfOpenError(err, createError);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertBaseHash(
  actual: string,
  expectedInput: string | undefined,
  createError: CreateAnnotateError,
): void {
  if (!expectedInput) return;
  const expected = expectedInput.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected) || expected !== actual) {
    throw createError(
      "ERR_BASE_HASH_MISMATCH",
      "Input PDF does not match --base-sha256",
      `expected ${expected || "<empty>"}, got ${actual}`,
    );
  }
}

export async function inspectOutputPolicy(
  input: string,
  spec: string | null,
  output: string,
  options: AnnotateCommandOptions,
  createError: CreateAnnotateError,
): Promise<OutputPolicy> {
  let inputIdentity: FileIdentity;
  let specIdentity: FileIdentity | null;
  let outputEntry: Awaited<ReturnType<typeof lstat>> | null;
  let outputIdentity: FileIdentity | null;
  try {
    [inputIdentity, specIdentity, outputEntry, outputIdentity] = await Promise.all([
      readFileIdentity(input),
      spec == null ? Promise.resolve(null) : readFileIdentity(spec),
      lstatIfExists(output),
      identityIfExists(output),
    ]);
  } catch (err) {
    throw createError(
      "ERR_WRITE_FAILED",
      "Could not inspect output path",
      err instanceof Error ? `${output}: ${err.message}` : output,
    );
  }

  let sameAsSpec: boolean;
  let sameAsInput: boolean;
  try {
    if (outputEntry !== null && outputIdentity === null) {
      throw new FileIdentityUnverifiableError();
    }
    sameAsSpec =
      spec != null &&
      (output === spec ||
        (specIdentity != null && sameIdentity(outputIdentity, specIdentity)));
    sameAsInput =
      output === input || sameIdentity(outputIdentity, inputIdentity);
  } catch (err) {
    throw createError(
      "ERR_WRITE_FAILED",
      "Could not prove output path is distinct from protected inputs",
      err instanceof Error ? `${output}: ${err.message}` : output,
    );
  }
  if (sameAsSpec) {
    throw createError(
      "ERR_OUTPUT_CONFLICT",
      "Output path must not replace the annotation spec",
      output,
    );
  }

  const exists = outputEntry !== null;
  if (!options.dryRun && sameAsInput && !options.inPlace) {
    throw createError(
      "ERR_CONFIRMATION_REQUIRED",
      "Refusing to replace the input PDF without --in-place",
      output,
    );
  }
  if (!options.dryRun && exists && !sameAsInput && !options.force) {
    throw createError(
      "ERR_OUTPUT_EXISTS",
      "Output already exists; choose a new output path",
      output,
    );
  }
  if (
    !options.dryRun &&
    exists &&
    (Boolean(options.force) || (sameAsInput && Boolean(options.inPlace)))
  ) {
    throw createError(
      "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED",
      "This CLI build cannot safely replace an existing output",
      `${output}: choose a new output path`,
    );
  }

  return {
    exists,
    isSymlink: outputEntry?.isSymbolicLink() ?? false,
    sameAsInput,
  };
}

async function identityIfExists(path: string): Promise<FileIdentity | null> {
  try {
    return await readFileIdentity(path);
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  }
}

async function lstatIfExists(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  }
}

function sameIdentity(a: FileIdentity | null, b: FileIdentity): boolean {
  return a !== null && compareFileIdentities(a, b) === "same";
}

function isMissingPathError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function atomicWritePdf(
  output: string,
  bytes: Uint8Array,
  createError: CreateAnnotateError,
): Promise<void> {
  const directory = dirname(output);
  const tempPath = join(
    directory,
    `.${basename(output)}.shiori-tmp-${process.pid}-${randomUUID()}`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await openAtomicOutputTemp(tempPath);
    await handle.writeFile(bytes);
    await handle.sync();
    const tempIdentity = await readAtomicOutputIdentity(handle);

    try {
      await commitAtomicOutput(tempPath, output, tempIdentity);
    } catch (error) {
      if (error instanceof AtomicOutputExistsError) {
        throw createError(
          "ERR_OUTPUT_EXISTS",
          "Output appeared while writing; refusing to replace it",
          output,
        );
      }
      throw error;
    }
    // commitAtomicOutput already authenticated and synced the published inode;
    // a late close failure on this redundant writer descriptor cannot undo it.
    await handle.close().catch(() => undefined);
    handle = null;
    await syncDirectoryEntry(directory);
  } catch (err) {
    if (isCliErrorLike(err)) throw err;
    if (err instanceof AtomicOutputPublishedOutcomeUnknownError) {
      throw createError(
        "ERR_OUTPUT_OUTCOME_UNKNOWN",
        "Output may already exist; inspect it before retrying",
        err.outputPath,
      );
    }
    throw createError(
      "ERR_WRITE_FAILED",
      "Could not write output file",
      err instanceof Error ? `${output}: ${err.message}` : output,
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/** Best-effort fsync of the directory so a crash right after rename() cannot
 * lose the new entry on filesystems that defer directory updates. */
async function syncDirectoryEntry(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The data write itself was already fsynced; entry durability is advisory.
  }
}

function isCliErrorLike(err: unknown): err is Error {
  return err instanceof Error && err.name === "CliError";
}

function cliErrorForPdfOpenError(
  err: unknown,
  createError: CreateAnnotateError,
): Error {
  const kind = classifyPdfOpenError(err);
  return createError(
    diagnosticCode(kind),
    errorMessageForPdfKind(kind),
    err instanceof Error ? err.message : String(err),
  );
}

export function errorMessageForPdfKind(kind: PdfOpenErrorKind): string {
  if (kind === "password") return "PDF requires a password";
  if (kind === "damaged") return "PDF appears damaged or unsupported";
  if (kind === "tooLarge") return "PDF exceeds Shiori's file limit";
  if (kind === "tooManyPages") return "PDF exceeds Shiori's page limit";
  if (kind === "pageTooLarge") return "PDF page dimensions are too large";
  if (kind === "renderTooLarge") return "PDF render target is too large";
  return "Could not open PDF";
}

function normalizeRotation(angle: number): Rotation {
  return ((((angle % 360) + 360) % 360) as Rotation);
}
