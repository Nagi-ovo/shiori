import { useCallback, useRef } from "react";
import type { Overlay } from "../../pdf/model/types";
import { useEditorStoreApi } from "../store/store";

export type OverlayWrite = (id: string, patch: Partial<Overlay>) => void;

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
 */
export function useOverlayPreviewStep(): {
  preview: OverlayWrite;
  end: () => void;
} {
  const store = useEditorStoreApi();
  const step = useRef<{ id: string; top: unknown } | null>(null);
  const preview = useCallback<OverlayWrite>(
    (id, patch) => {
      const state = store.getState();
      const open = step.current;
      if (!open || open.id !== id || open.top !== state.undoStack.at(-1)) {
        state.beginHistoryStep();
        step.current = { id, top: store.getState().undoStack.at(-1) };
      }
      store.getState().updateOverlayNoHistory(id, patch);
    },
    [store],
  );
  const end = useCallback(() => {
    step.current = null;
  }, []);
  return { preview, end };
}
