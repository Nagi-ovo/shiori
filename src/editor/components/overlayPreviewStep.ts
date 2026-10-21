import { useCallback, useRef } from "react";
import type { Overlay } from "../../pdf/model/types";
import { useEditorStoreApi } from "../store/store";

export type OverlayWrite = (id: string, patch: Partial<Overlay>) => void;
type SessionWrite = (session: string, id: string, patch: Partial<Overlay>) => void;

/**
 * Live edits to one overlay that land as a single undo step, such as a drag
 * through the native colour well, which fires an input event per tick. The
 * first preview opens the step with beginHistoryStep and the rest write
 * without history, the same pattern as an overlay drag.
 *
 * A new step opens when the overlay changes, or when anything else moved the
 * undo stack in between (an Undo mid-drag, a commit from the Live API), so a
 * preview never lands where Undo cannot reach it. `end` closes the step; the
 * next preview opens a fresh one.
 *
 * `session` names the control streaming the edit. A rectangle's stroke and
 * fill popovers can be open together (the backdrop stops a pointer, not Tab),
 * so a preview from another session opens its own step, and one session's
 * `end` leaves the other's step alone.
 */
export function useOverlayPreviewStep(): {
  preview: SessionWrite;
  end: (session: string) => void;
} {
  const store = useEditorStoreApi();
  const step = useRef<{ session: string; id: string; top: unknown } | null>(
    null,
  );
  const preview = useCallback<SessionWrite>(
    (session, id, patch) => {
      const state = store.getState();
      const open = step.current;
      if (
        !open ||
        open.session !== session ||
        open.id !== id ||
        open.top !== state.undoStack.at(-1)
      ) {
        state.beginHistoryStep();
        step.current = { session, id, top: store.getState().undoStack.at(-1) };
      }
      store.getState().updateOverlayNoHistory(id, patch);
    },
    [store],
  );
  const end = useCallback((session: string) => {
    if (step.current?.session === session) step.current = null;
  }, []);
  return { preview, end };
}
