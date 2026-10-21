import { nanoid } from "nanoid";
import {
  isTextDocumentKind,
  sourceForPayload,
  type LoadedDocumentPayload,
} from "../../documents/types";
import {
  assertDocumentWithinFileLimit,
  assertSafeDocxPackage,
} from "../../documents/openPolicy";
import { findTextWorkingCopyRecent } from "../../editor/textWorkingCopy";
import { replaceOrAppendWorkspaceTab } from "../../editor/workspaceTabs";
import { sha256Hex } from "../../storage/hash";
import { patchWorkspaceTextView } from "../../storage/workspace";
import { textReopenCacheId } from "../tabSources";
import { decodeTextDocument } from "../textSources/textEncoding";
import type { WorkspaceRuntimeTab } from "../types";
import { openPdf } from "./openPdf";
import { abandonOpen, findExistingTab, openClaim } from "./shared";
import type {
  DocumentOpenOptions,
  IntakePorts,
  NonPdfPayload,
  TextOpenOptions,
} from "./types";

/** Opens any supported document as a tab, or restores it into one. */
export async function openDocument(
  payload: LoadedDocumentPayload,
  options: DocumentOpenOptions,
  ports: IntakePorts,
): Promise<void> {
  if (payload.kind === "pdf") {
    await openPdf(
      {
        name: payload.name,
        size: payload.size,
        bytes: payload.bytes,
        path: payload.path,
        webFileHandleId: payload.webFileHandleId,
        cacheId: payload.cacheId,
        password: options.pdfPassword,
      },
      {
        tabId: options.tabId,
        pdfView: options.pdfView,
        runtimeSnapshot: options.runtimeSnapshot,
        password: options.pdfPassword,
        skipDuplicateCheck: options.skipDuplicateCheck,
        shouldActivate: options.shouldActivate,
        foregroundIntent: options.foregroundIntent,
      },
      ports,
    );
    return;
  }
  await openNonPdf({ ...payload, kind: payload.kind }, options, ports);
}

/** Word, Markdown and HTML. They are not queued: they hold no resident slot. */
export async function openNonPdf(
  payload: NonPdfPayload,
  options: TextOpenOptions,
  ports: IntakePorts,
): Promise<void> {
  const { store } = ports;
  try {
    assertDocumentWithinFileLimit(payload.kind, payload.size);
    if (payload.kind === "docx") assertSafeDocxPackage(payload.bytes);
  } catch (err) {
    if (ports.ui.reportDocumentPolicyError(err, payload.name, payload.kind)) {
      if (options.tabId) {
        store.getState().updateTab(options.tabId, (tab) => ({
          ...tab,
          status: "unavailable",
          unavailableDetail: `document-policy:${String(
            (err as { kind?: unknown }).kind ?? "invalid",
          )}`,
          updatedAt: Date.now(),
        }));
      }
      return;
    }
    throw err;
  }
  const { shouldActivate, shouldContinue } = openClaim(ports, options);
  let pendingCacheId = payload.cacheId;
  const abandon = () => abandonOpen(ports, options.tabId, pendingCacheId);
  if (!(await ports.persistActive())) return;
  if (!shouldContinue()) return abandon();
  let sourcePayload = await ports.sources.ensure(payload);
  pendingCacheId = sourcePayload.cacheId;
  // Working copies exist only for kinds the editor can edit. A binary
  // document is read straight from its source, so there is nothing to
  // recover and nothing to prefer over `sourcePayload`.
  const textKind = isTextDocumentKind(payload.kind) ? payload.kind : null;
  // What the file on disk holds, for the save's "changed since?" check. A
  // restore of unsaved edits reads only their working copy, so it is unknown.
  let sourceHash: string | undefined;
  let unknownSource = false;
  const restoresEdits =
    Boolean(options.workingCopyCacheId) &&
    store.getState().tabs.find((tab) => tab.id === options.tabId)?.textDirty === true;
  const recoveryEntry =
    options.workingCopyCacheId || !textKind
      ? null
      : findTextWorkingCopyRecent(textKind, sourcePayload, ports.recents.list());
  if (recoveryEntry?.cacheId) {
    const workingCopy = await ports.sources.get(recoveryEntry.cacheId);
    if (workingCopy?.kind !== payload.kind) {
      // The optional recovery copy is stale, but the source itself loaded;
      // carry on with it so the tab still reaches `loaded`.
      ports.recents.forget(recoveryEntry);
      ports.ui.reportWorkingCopyMissing(payload.name);
    } else {
      // The edits began from some earlier file, not necessarily this one, so
      // the disk vouches for them only when the copy still matches it.
      const diskHash = await sha256Hex(sourcePayload.bytes);
      if (diskHash === (await sha256Hex(workingCopy.bytes))) sourceHash = diskHash;
      else unknownSource = true;
      sourcePayload = {
        ...sourcePayload,
        size: workingCopy.size,
        bytes: workingCopy.bytes,
        cacheId: workingCopy.id,
      };
    }
  }
  const tabSource = sourceForPayload(sourcePayload);
  const workingCopyCacheId =
    options.workingCopyCacheId ??
    (tabSource.type !== "cache" ? sourcePayload.cacheId : undefined);
  const contentHash = await sha256Hex(sourcePayload.bytes);
  if (textKind && !restoresEdits && !unknownSource) sourceHash ??= contentHash;
  const existing = options.skipDuplicateCheck
    ? null
    : await findExistingTab(ports, payload.kind, tabSource, contentHash);
  if (existing && existing.id !== options.tabId) {
    if (
      sourcePayload.cacheId &&
      sourcePayload.cacheId !== textReopenCacheId(existing)
    ) {
      ports.sources.removeIfUnreferenced(sourcePayload.cacheId);
    }
    if (!shouldActivate()) {
      if (options.tabId) abandon();
      return;
    }
    await ports.activateLoadedTab(existing.id);
    return;
  }
  if (!shouldContinue()) return abandon();

  const tabId = options.tabId ?? nanoid();
  // A .docx is a zip, not text: decoding it would produce mojibake that the
  // Markdown/HTML path would happily render. Binary kinds keep their bytes.
  const isBinary = payload.kind === "docx";
  const decoded = isBinary ? null : decodeTextDocument(sourcePayload.bytes);
  const nextTab: WorkspaceRuntimeTab = {
    id: tabId,
    kind: payload.kind,
    title: payload.name,
    size: payload.size,
    source: tabSource,
    workingCopyCacheId,
    hash: contentHash,
    text: decoded?.text,
    ...(decoded?.lossy ? { textLossy: true } : {}),
    ...(decoded?.bom ? { textBom: true } : {}),
    ...(sourceHash ? { sourceHash } : {}),
    bytes: isBinary ? sourcePayload.bytes : undefined,
    textView: options.textView ?? patchWorkspaceTextView(undefined, {}),
    status: "loaded",
    updatedAt: Date.now(),
  };
  store.setState({
    tabs: replaceOrAppendWorkspaceTab(store.getState().tabs, nextTab),
  });
  if (shouldActivate()) {
    ports.editors.detach();
    store.getState().setSession({
      activeHash: null,
      exportBaselineSnapshot: null,
      lastExport: null,
      pendingRestore: null,
      deferredDraft: null,
      restoredDraft: null,
    });
    ports.ui.setError(null);
    store.getState().setActiveTab(tabId);
  }
  // Recorded like PDFs, so a closed Markdown/HTML tab is still reachable
  // from the landing.
  ports.recents.recordText(nextTab);
}
