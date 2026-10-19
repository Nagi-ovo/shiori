import { lstat, open, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertCanvasPixelBudget,
  assertPdfPageDimensionsWithinLimit,
  clampScaleToCanvasBudget,
} from "../../src/pdf/openPolicy";
import {
  AtomicOutputExistsError,
  commitAtomicOutput,
  openAtomicOutputTemp,
  readAtomicOutputIdentity,
} from "./atomicOutput";
import type { CoreDocument } from "./coreEngine";
import { encodePng } from "./png";
import {
  FileIdentityUnverifiableError,
  compareFileIdentities,
  readFileIdentity,
} from "./fileIdentity";

export type RenderPageResult = {
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
  /** May be lower than requested after the canvas pixel-budget clamp. */
  scale: number;
};

export class RenderOutputConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderOutputConflictError";
  }
}

export class RenderOutputExistsError extends Error {
  constructor() {
    super("Output already exists");
    this.name = "RenderOutputExistsError";
  }
}

/**
 * Rasterize one page with shiori-core: PDFium draws it, annotations and form
 * fields included, the pixels the desktop app shows, within Shiori's page
 * and canvas limits; the page's own /Rotate applies.
 */
export function renderCorePageToPng(
  core: CoreDocument,
  pageNumber: number,
  requestedScale: number,
): RenderPageResult {
  const index = pageNumber - 1;
  const geometry = core.pageGeometry(index);
  const turned = geometry.rotation === 90 || geometry.rotation === 270;
  const width = turned ? geometry.height : geometry.width;
  const height = turned ? geometry.width : geometry.height;
  assertPdfPageDimensionsWithinLimit(width, height, pageNumber);
  const scale = clampScaleToCanvasBudget(requestedScale, width, height, 1);
  const widthPx = Math.max(1, Math.floor(width * scale));
  const heightPx = Math.max(1, Math.floor(height * scale));
  assertCanvasPixelBudget(widthPx, heightPx);
  const rgba = core.render(index, geometry.rotation, scale, 0, 0, widthPx, heightPx);
  return { png: encodePng(rgba, widthPx, heightPx), widthPx, heightPx, scale };
}

/**
 * Reject output aliases of the input, including symlinks and hard links.
 * This check is intentionally repeated immediately before commit by the
 * writer below: rendering may be slow enough for the output path to change.
 */
export async function assertRenderOutputIsDistinct(
  input: string,
  output: string,
): Promise<void> {
  if (input === output) {
    throw new RenderOutputConflictError(
      "Render output must not replace the input PDF",
    );
  }
  const inputIdentity = await readFileIdentity(input);
  let outputIdentity: Awaited<ReturnType<typeof readFileIdentity>>;
  try {
    outputIdentity = await readFileIdentity(output);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    // realpath() also reports ENOENT for a broken symlink. An existing output
    // entry whose target cannot be identified is not safe to treat as absent.
    try {
      await lstat(output);
    } catch (entryError) {
      if (isMissingPathError(entryError)) return;
      throw entryError;
    }
    throw new RenderOutputConflictError(
      "Could not prove render output is distinct from the input PDF",
    );
  }
  try {
    if (compareFileIdentities(inputIdentity, outputIdentity) === "same") {
      throw new RenderOutputConflictError(
        "Render output must not alias the input PDF",
      );
    }
  } catch (error) {
    if (error instanceof FileIdentityUnverifiableError) {
      throw new RenderOutputConflictError(
        "Could not prove render output is distinct from the input PDF",
      );
    }
    throw error;
  }
}

/** Atomic same-directory write with an atomic no-replace commit by default. */
export async function atomicWriteNewFile(
  input: string,
  output: string,
  bytes: Uint8Array,
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

    await assertRenderOutputIsDistinct(input, output);
    // A same-directory hard link publishes the fully-written inode in one
    // operation and fails with EEXIST instead of replacing a path that
    // appeared after the caller's initial check. The portable CLI exposes no
    // path-based replacement primitive at this layer.
    try {
      await commitAtomicOutput(tempPath, output, tempIdentity);
    } catch (error) {
      if (error instanceof AtomicOutputExistsError) {
        throw new RenderOutputExistsError();
      }
      throw error;
    }
    // Publication has already been independently synced and verified.
    await handle.close().catch(() => undefined);
    handle = null;
    await syncDirectoryEntry(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

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
    // The rendered bytes are fsynced already; directory fsync is best-effort.
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
