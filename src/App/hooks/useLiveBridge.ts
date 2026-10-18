import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { toast } from "../../editor/toast";
import {
  authorizeLiveApiMutation,
  completeLiveApiRequest,
  listenLiveApiAnnotationRequests,
  updateLiveApiContext,
} from "../../platform";
import {
  connectLiveApiBridge,
  createLiveContextPublisher,
  type ActiveLivePdf,
} from "../../live/liveApiBridge";
import type { LiveApiContext } from "../../platform/liveApi";
import { safeUnlisten } from "../../platform/ipc";
import drafts from "../../storage/drafts";

/**
 * Live API bridge connection lifecycle: owns the
 * context publisher and the three connection effects — publish the current
 * context on change, connect the annotation-request bridge (flipping
 * liveBridgeReady once listening), and clear native state on teardown.
 * Extracted verbatim from the App God-component.
 *
 * The context itself (liveContext) and the active-PDF accessor
 * (getActiveLivePdf) are computed from App's document state and stay there —
 * they are passed in. setLiveBridgeReady is injected because liveBridgeReady
 * is read by the liveContext memo upstream in App, so its state must live in
 * App while this hook flips it true on connect.
 */
export function useLiveBridge(
  liveContext: LiveApiContext | null,
  getActiveLivePdf: () => ActiveLivePdf | null,
  setLiveBridgeReady: Dispatch<SetStateAction<boolean>>,
): void {
  const [liveContextPublisher] = useState(() =>
    createLiveContextPublisher(updateLiveApiContext, (error) => {
      console.warn("Failed to update Live API context", error);
    }),
  );

  useEffect(() => {
    liveContextPublisher.publish(liveContext);
  }, [liveContext, liveContextPublisher]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void connectLiveApiBridge(
      {
        getActivePdf: getActiveLivePdf,
        onRemoteWrite: (added) => toast.showLiveAnnotations(added),
        onOperationCommitted: (sha256, operationId) => {
          // The callback only runs after native authorization and a successful
          // synchronous store commit. IndexedDB must not extend that critical
          // section, so durability continues without an await.
          void drafts
            .putLiveOperationReceipt(sha256, operationId)
            .catch((error) => {
              console.error("Failed to persist Live operation receipt", error);
            });
        },
      },
      {
        listen: listenLiveApiAnnotationRequests,
        authorizeMutation: authorizeLiveApiMutation,
        complete: completeLiveApiRequest,
        onError: (error) => {
          console.warn("Live API annotation request failed", error);
        },
      },
    )
      .then((dispose) => {
        if (cancelled) safeUnlisten(dispose);
        else {
          unlisten = dispose;
          setLiveBridgeReady(true);
        }
      })
      .catch((error) => {
        console.warn("Failed to start Live API bridge", error);
      });
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, [getActiveLivePdf, setLiveBridgeReady]);

  useEffect(
    () => () => {
      // Clear native state on app teardown so the HTTP endpoint never exposes
      // a document after the main webview can no longer service requests.
      liveContextPublisher.publish(null);
    },
    [liveContextPublisher],
  );
}
