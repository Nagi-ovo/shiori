import {
  createContext,
  useContext,
  useLayoutEffect,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  useDraftSync,
  type DraftSyncState,
} from "../../editor/hooks/useDraftSync";
import {
  StatusBar,
  type StatusBarProps,
} from "../../editor/components/StatusBar";
import { useDraftPersistence } from "../hooks/useDraftPersistence";
import { usePdfExportStatus } from "./PdfExportStatusContext";
import { useEditorStore } from "../../editor/store/store";
import type { DocumentModel } from "../../pdf/model/types";

export type PdfDraftControllerApi = Pick<
  DraftSyncState,
  "flushNow" | "flushNowOrThrow"
> & {
  completeNativeExitRequest: () => Promise<void>;
};

type Props = {
  hash: string | null;
  disabled: boolean;
  flushPendingTextSources: (tabId?: string) => Promise<void>;
  hasPendingTextSourceWrites: boolean;
  apiRef: MutableRefObject<PdfDraftControllerApi | null>;
  children: ReactNode;
};

const PdfDraftStateContext = createContext<DraftSyncState | null>(null);

/**
 * Owns the high-frequency model/history subscriptions used by draft autosave.
 * Its child element is passed through unchanged, so draft status updates reach
 * StatusBar through context without re-running the app controller or chrome.
 */
export function PdfDraftController({
  hash,
  disabled,
  flushPendingTextSources,
  hasPendingTextSourceWrites,
  apiRef,
  children,
}: Props) {
  const draftState = useDraftSync(hash, disabled);
  const { completeNativeExitRequest } = useDraftPersistence({
    draftState,
    flushPendingTextSources,
    hasPendingTextSourceWrites,
  });

  useLayoutEffect(() => {
    apiRef.current = {
      flushNow: draftState.flushNow,
      flushNowOrThrow: draftState.flushNowOrThrow,
      completeNativeExitRequest,
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, completeNativeExitRequest, draftState.flushNow, draftState.flushNowOrThrow]);

  return (
    <PdfDraftStateContext.Provider value={draftState}>
      {children}
    </PdfDraftStateContext.Provider>
  );
}

type PdfDraftStatusBarProps = Omit<
  StatusBarProps,
  "draft" | "exportStatus" | "restoredDraftAt"
> & {
  restoredDraft: {
    committedModel: DocumentModel;
    lastTouched: number;
  } | null;
};

export function PdfDraftStatusBar({
  restoredDraft,
  ...props
}: PdfDraftStatusBarProps) {
  const draftState = useContext(PdfDraftStateContext);
  const exportStatus = usePdfExportStatus();
  const restoredDraftAt = useEditorStore((state) =>
    restoredDraft && state.model === restoredDraft.committedModel
      ? restoredDraft.lastTouched
      : null,
  );
  if (!draftState) return null;
  return (
    <StatusBar
      {...props}
      draft={draftState}
      exportStatus={exportStatus}
      restoredDraftAt={restoredDraftAt}
    />
  );
}
