import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useAppStore,
  useEditorStore,
  useEditorStoreApi,
} from "../../editor/store/store";
import {
  exportSnapshotKey,
} from "../../editor/export/exportStatus";
import {
  buildLiveApiContext,
  createLivePageTextContentReader,
  serializeLivePageTopology,
  type ActiveLivePdf,
} from "../../live/liveApiBridge";
import {
  buildLiveAnnotationDigest,
  type LiveAnnotationDigestResult,
} from "../../live/annotationDigest";
import {
  prefersReducedLiveOverlayMotion,
  prepareLiveOverlayCommitPresentation,
} from "../../live/overlayReveal";
import { sha256Hex } from "../../storage/hash";
import { useLiveBridge } from "../hooks/useLiveBridge";
import type { PdfDocument } from "../../pdf/engine/types";

type ActiveTab = {
  id: string;
  title: string;
  status: "loaded" | "unloaded" | "loading" | "suspended" | "unavailable";
  hash: string | null;
  sourcePath: string | null;
  sessionDoc: PdfDocument | null;
};

type Props = {
  activeTab: ActiveTab | null;
  activeHash: string | null;
  transitioning: boolean;
  restoreDecisionPending: boolean;
  exportBaselineSnapshot: string | null;
};

/** Keeps Live API projection churn below App and shared chrome. */
export function PdfLiveBridge({
  activeTab,
  activeHash,
  transitioning,
  restoreDecisionPending,
  exportBaselineSnapshot,
}: Props) {
  const editorStore = useEditorStoreApi();
  const opened = useEditorStore((state) => state.opened);
  const model = useEditorStore((state) => state.model);
  const activePageId = useEditorStore((state) => state.activePageId);
  const pages = model.pages;
  const livePageTopologySource = useMemo(
    () => serializeLivePageTopology(pages),
    [pages],
  );
  const [livePageTopology, setLivePageTopology] = useState<{
    source: string;
    hash: string;
  } | null>(null);
  const [liveBridgeReady, setLiveBridgeReady] = useState(false);
  const latestRef = useRef({
    activeTab,
    activeHash,
    transitioning,
    restoreDecisionPending,
  });
  const livePageTopologyRef = useRef<{
    source: string;
    hash: string | null;
  }>({ source: livePageTopologySource, hash: null });

  useLayoutEffect(() => {
    latestRef.current = {
      activeTab,
      activeHash,
      transitioning,
      restoreDecisionPending,
    };
  }, [activeHash, activeTab, restoreDecisionPending, transitioning]);

  useEffect(() => {
    const source = livePageTopologySource;
    let cancelled = false;
    livePageTopologyRef.current = { source, hash: null };
    void sha256Hex(new TextEncoder().encode(source))
      .then((hash) => {
        if (cancelled || livePageTopologyRef.current.source !== source) return;
        livePageTopologyRef.current = { source, hash };
        setLivePageTopology({ source, hash });
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Failed to fingerprint Live API page topology", error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [livePageTopologySource]);

  const getActiveLivePdf = useCallback((): ActiveLivePdf | null => {
    const latest = latestRef.current;
    if (latest.transitioning || latest.restoreDecisionPending) return null;
    const tab = latest.activeTab;
    const sha256 = latest.activeHash;
    const state = editorStore.getState();
    const topology = livePageTopologyRef.current;
    const currentTopologySource = serializeLivePageTopology(state.model.pages);
    if (
      !tab ||
      !sha256 ||
      tab.status !== "loaded" ||
      tab.hash !== sha256 ||
      !tab.sessionDoc ||
      !state.opened ||
      tab.sessionDoc !== state.opened.doc ||
      topology.source !== currentTopologySource ||
      !topology.hash
    ) {
      return null;
    }
    const liveDocument = state.opened.doc;
    const livePages = state.model.pages;
    const liveOverlays = state.model.overlays;
    const liveOperationReceipts = state.completedLiveOperationIds;
    const liveTopologyHash = topology.hash;
    return {
      documentId: tab.id,
      sha256,
      pageTopologyHash: liveTopologyHash,
      pages: livePages,
      overlays: liveOverlays,
      commitOverlays: (overlays) => {
        editorStore.getState().commit({ overlays });
      },
      prepareOverlayCommit: (overlays, ui) => {
        const current = editorStore.getState();
        if (
          current.model.pages !== livePages ||
          current.model.overlays !== liveOverlays ||
          current.opened?.doc !== liveDocument
        ) {
          return null;
        }
        const prepared = current.prepareCommit({ overlays });
        const presentation = ui
          ? prepareLiveOverlayCommitPresentation({
              enabled: useAppStore.getState().prefs.annotationAnimations,
              reducedMotion: prefersReducedLiveOverlayMotion(),
              batchId: ui.batchId,
              addedOverlays: ui.addedOverlays,
              selectedIds: ui.selectedIds,
            })
          : null;
        return () => {
          const liveState = editorStore.getState();
          const reveal =
            presentation?.reveal &&
            useAppStore.getState().prefs.annotationAnimations &&
            !prefersReducedLiveOverlayMotion()
              ? presentation.reveal
              : null;
          return liveState.commitPrepared(prepared, {
            liveOverlayReveal: reveal,
            selectedIds: presentation?.selectedIds,
          });
        };
      },
      hasOperationReceipt: (operationId) =>
        liveOperationReceipts.has(operationId),
      prepareOverlayBatchCommit: (overlays, operationId, ui) => {
        const current = editorStore.getState();
        if (
          current.model.pages !== livePages ||
          current.model.overlays !== liveOverlays ||
          current.opened?.doc !== liveDocument ||
          current.completedLiveOperationIds !== liveOperationReceipts
        ) {
          return null;
        }
        const prepared = current.prepareOverlayBatchCommit(
          overlays,
          operationId,
        );
        const presentation = ui
          ? prepareLiveOverlayCommitPresentation({
              enabled: useAppStore.getState().prefs.annotationAnimations,
              reducedMotion: prefersReducedLiveOverlayMotion(),
              batchId: ui.batchId,
              addedOverlays: ui.addedOverlays,
              selectedIds: ui.selectedIds,
            })
          : null;
        return () => {
          const liveState = editorStore.getState();
          const reveal =
            presentation?.reveal &&
            useAppStore.getState().prefs.annotationAnimations &&
            !prefersReducedLiveOverlayMotion()
              ? presentation.reveal
              : null;
          return liveState.commitPreparedOverlayBatch(prepared, {
            liveOverlayReveal: reveal,
            selectedIds: presentation?.selectedIds,
          });
        };
      },
      commitsSelectionAtomically: true,
      isCurrentSnapshot: () => {
        const current = editorStore.getState();
        const nextLatest = latestRef.current;
        return (
          !nextLatest.transitioning &&
          !nextLatest.restoreDecisionPending &&
          nextLatest.activeTab?.id === tab.id &&
          nextLatest.activeHash === sha256 &&
          livePageTopologyRef.current.hash === liveTopologyHash &&
          current.opened?.doc === liveDocument &&
          current.model.pages === livePages &&
          current.model.overlays === liveOverlays
        );
      },
      selectOverlays: (ids) => {
        editorStore.setState({ selectedIds: ids });
      },
      getPageTextContent: createLivePageTextContentReader(liveDocument),
    };
  }, [editorStore]);

  const livePageTopologyHash =
    livePageTopology?.source === livePageTopologySource
      ? livePageTopology.hash
      : null;
  const exportSnapshot = useMemo(() => exportSnapshotKey(model), [model]);
  const hasExportableChanges = Boolean(
    opened &&
      exportBaselineSnapshot &&
      exportSnapshot !== exportBaselineSnapshot,
  );
  const liveAnnotationDigestJson = useMemo(
    () =>
      JSON.stringify(buildLiveAnnotationDigest(model.overlays, model.pages)),
    [model.overlays, model.pages],
  );
  const liveAnnotationDigest = useMemo(
    () => JSON.parse(liveAnnotationDigestJson) as LiveAnnotationDigestResult,
    [liveAnnotationDigestJson],
  );
  const liveContext = useMemo(
    () =>
      buildLiveApiContext({
        ready: Boolean(
          liveBridgeReady &&
            !transitioning &&
            !restoreDecisionPending &&
            activeTab &&
            activeTab.status === "loaded" &&
            activeTab.hash === activeHash &&
            activeTab.sessionDoc &&
            opened &&
            activeTab.sessionDoc === opened.doc &&
            livePageTopologyHash,
        ),
        documentId: activeTab?.id ?? null,
        name: activeTab?.title ?? null,
        path: activeTab?.sourcePath ?? opened?.path,
        sha256: activeHash,
        pageTopologyHash: livePageTopologyHash,
        pages,
        activePageId,
        annotationCount: model.overlays.length,
        dirty: hasExportableChanges,
        annotations: liveAnnotationDigest.annotations,
        annotationsTruncated: liveAnnotationDigest.truncated,
      }),
    [
      activeHash,
      activePageId,
      activeTab,
      hasExportableChanges,
      liveAnnotationDigest,
      liveBridgeReady,
      livePageTopologyHash,
      model.overlays.length,
      opened,
      pages,
      restoreDecisionPending,
      transitioning,
    ],
  );

  useLiveBridge(liveContext, getActiveLivePdf, setLiveBridgeReady);

  return null;
}
