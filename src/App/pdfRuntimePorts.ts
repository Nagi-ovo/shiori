import { emptyPdfEditorStore, type PdfEditorStoreApi } from "../editor/store/store";
import { capturePdfTabPreview } from "../editor/tabPreview";
import { appPdfEngine } from "../pdf/engine/appEngine";
import {
  putRuntimeSession,
  rememberRuntimeCredential,
  removeRuntimeSession,
} from "../storage/runtimeSessions";
import { putTabPreview, removeTabPreview } from "../storage/tabPreviews";
import { workspaceStore } from "../workspace/appWorkspace";
import { createPdfRuntime, type PdfRuntime } from "../workspace/pdfRuntime";
import type { WorkspaceRuntimeTab } from "../workspace/types";

type Live = {
  activeEditor: () => PdfEditorStoreApi;
  flushDraft: () => Promise<void>;
  onFlushFailed: (tab: WorkspaceRuntimeTab, error: unknown) => void;
};

let runtime: (PdfRuntime & { connect(next: Partial<Live>): void }) | null = null;

/**
 * The window's PDF runtime on the real engine and storage. One per window,
 * like the workspace store; App connects the editor on screen and the draft
 * flush from an effect.
 */
export function appPdfRuntime() {
  if (!runtime) {
    const live: Live = {
      activeEditor: () => emptyPdfEditorStore,
      flushDraft: async () => {},
      onFlushFailed: () => {},
    };
    runtime = {
      ...createPdfRuntime({
        store: workspaceStore(),
        engine: appPdfEngine,
        sessions: {
          put: putRuntimeSession,
          remove: removeRuntimeSession,
          rememberCredential: rememberRuntimeCredential,
        },
        previews: {
          capture: capturePdfTabPreview,
          put: putTabPreview,
          remove: removeTabPreview,
        },
        activeEditor: () => live.activeEditor(),
        flushDraft: () => live.flushDraft(),
        onFlushFailed: (tab, error) => live.onFlushFailed(tab, error),
      }),
      connect(next) {
        Object.assign(live, next);
      },
    };
  }
  return runtime;
}
