import { CAPABILITIES } from "./index";
import { writeTextToWebFileHandle } from "../storage/recentFileHandles";

/**
 * Writing an edited text document back over the file it came from.
 *
 * This is "Save", not "Export": no dialog, no new file, the same bytes-in-place
 * semantics every text editor has. Only ever reachable for a document Shiori
 * opened from a real location the user chose — a desktop path or a browser file
 * handle. A document that arrived from the workspace cache, a share sheet or a
 * drop with no handle has no origin to write to, and `writeBackTarget` returns
 * null so the caller offers Save As instead.
 */

// Mirrors the DocumentSource shape in storage/workspace without importing it:
// this layer only cares about the two variants that name a writable origin.
export type WriteBackSource =
  | { type: "path"; path: string }
  | { type: "webFileHandle"; id: string }
  | { type: string };

export type WriteBackTarget =
  | { kind: "desktopPath"; path: string }
  | { kind: "webFileHandle"; id: string };

export type WriteBackResult =
  | { status: "written" }
  // The origin exists but this runtime cannot write to it — Safari and Firefox
  // implement only the read half of the File System Access API. Distinct from
  // an error: the caller should quietly fall back to Save As.
  | { status: "unsupported" }
  | { status: "permissionDenied" }
  | { status: "missing" }
  // The file no longer holds what the caller last read or wrote (`unchanged`
  // said no), so nothing was written.
  | { status: "changed" }
  // `unchanged` could not read the file, so nothing was written.
  | { status: "unverified" };

/**
 * The writable origin of a document, or null when there is none.
 *
 * Deliberately capability-gated rather than shape-gated: a tab restored from a
 * desktop session still carries `{ type: "path" }` when the same workspace is
 * opened on the web build, where that path means nothing.
 */
export function writeBackTarget(
  source: WriteBackSource | undefined,
): WriteBackTarget | null {
  if (!source) return null;
  if (source.type === "path" && CAPABILITIES.nativePaths) {
    const path = (source as { path?: unknown }).path;
    if (typeof path === "string" && path.length > 0) {
      return { kind: "desktopPath", path };
    }
  }
  if (source.type === "webFileHandle" && !CAPABILITIES.nativePaths) {
    const id = (source as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) {
      return { kind: "webFileHandle", id };
    }
  }
  return null;
}

/**
 * Writes `text` to the document's origin.
 *
 * Must be called synchronously enough from the user's keypress or click that
 * the browser still counts it as a user gesture — the web branch may need to
 * request the readwrite permission, which is only granted during one.
 *
 * Throws only on a genuine I/O failure (disk full, read-only volume, the file
 * vanished). Everything a caller can reasonably recover from is a status.
 */
export async function writeTextDocumentBack(
  target: WriteBackTarget,
  text: string,
  unchanged?: (current: Uint8Array) => Promise<boolean>,
): Promise<WriteBackResult> {
  if (target.kind === "desktopPath") {
    if (unchanged) {
      // A check that cannot read the file vouches for nothing: the atomic
      // write can still replace an unreadable one. Only a file that is gone
      // is left to the write, which reports it as missing.
      const { readDocumentBytesFromPlatformPath } = await import("./open");
      let current: Uint8Array | null = null;
      try {
        current = (await readDocumentBytesFromPlatformPath(target.path))?.bytes ?? null;
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err);
        if (!message.includes("document-path-unavailable")) return { status: "unverified" };
      }
      if (current && !(await unchanged(current))) return { status: "changed" };
    }
    const { commands, unwrapCommand } = await import("./ipc");
    try {
      unwrapCommand(
        await commands.writeTextDocumentAtPath(target.path, text),
      );
    } catch (err) {
      // The Rust command answers with a small set of error strings; the two
      // that mean "the origin is gone" become a status so the caller can offer
      // Save As rather than showing a raw failure.
      const message = String(err);
      if (
        message.includes("document-unavailable") ||
        message.includes("document-not-file")
      ) {
        return { status: "missing" };
      }
      throw err;
    }
    return { status: "written" };
  }

  const outcome = await writeTextToWebFileHandle(target.id, text, unchanged);
  if (outcome === "written") return { status: "written" };
  if (outcome === "changed") return { status: "changed" };
  if (outcome === "unverified") return { status: "unverified" };
  if (outcome === "unsupported") return { status: "unsupported" };
  if (outcome === "permissionDenied") return { status: "permissionDenied" };
  return { status: "missing" };
}
