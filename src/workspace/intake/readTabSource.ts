import { detectDocumentKind, type LoadedDocumentPayload } from "../../documents/types";
import { readDocumentBytesFromPlatformPath } from "../../platform";
import {
  isWebFileHandleOpenError,
  readDocumentFromWebFileHandle,
} from "../../storage/recentFileHandles";
import { getWorkspaceSource } from "../../storage/workspace";
import { documentSourcePayloadFields } from "../tabSources";
import type { WorkspaceRuntimeTab } from "../types";

export type TabSourceRead = {
  payload: LoadedDocumentPayload;
  workingCopyCacheId?: string;
};

/**
 * Reads a restored tab's bytes from wherever its source lives: a text
 * document's working copy first, then its path, web file handle or cache.
 * Throws an error whose message names the failure (describeRestoreError).
 */
export async function readTabSource(
  tab: WorkspaceRuntimeTab,
): Promise<TabSourceRead> {
  if (tab.kind !== "pdf" && tab.workingCopyCacheId) {
    const workingCopy = await getWorkspaceSource(tab.workingCopyCacheId);
    if (!workingCopy) throw new Error("workspace-working-copy-missing");
    if (workingCopy.kind !== tab.kind) {
      throw new Error("workspace-working-copy-kind-mismatch");
    }
    return {
      payload: {
        kind: workingCopy.kind,
        name: workingCopy.name,
        size: workingCopy.size,
        bytes: workingCopy.bytes,
        ...documentSourcePayloadFields(tab.source),
      },
      workingCopyCacheId: workingCopy.id,
    };
  }
  if (tab.source.type === "path") {
    const payload = await readDocumentBytesFromPlatformPath(tab.source.path);
    if (!payload) throw new Error("document-path-unavailable");
    return { payload };
  }
  if (tab.source.type === "webFileHandle") {
    let payload: Awaited<ReturnType<typeof readDocumentFromWebFileHandle>>;
    try {
      payload = await readDocumentFromWebFileHandle(tab.source.id);
    } catch (err) {
      if (isWebFileHandleOpenError(err)) {
        throw new Error(`webFileHandle:${err.code}`);
      }
      if (
        typeof DOMException !== "undefined" &&
        err instanceof DOMException &&
        err.name === "SecurityError"
      ) {
        throw new Error("webFileHandle:permissionDenied");
      }
      throw err;
    }
    const kind = detectDocumentKind(payload.name);
    if (!kind) throw new Error("unsupported-document");
    return {
      payload: { ...payload, kind, webFileHandleId: tab.source.id },
    };
  }
  if (tab.source.type === "cache") {
    const source = await getWorkspaceSource(tab.source.id);
    if (!source) throw new Error("workspace-cache-missing");
    return {
      payload: {
        kind: source.kind,
        name: source.name,
        size: source.size,
        bytes: source.bytes,
        cacheId: source.id,
      },
    };
  }
  throw new Error("workspace-source-ephemeral");
}
