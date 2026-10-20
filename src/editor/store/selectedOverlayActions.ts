import { nanoid } from "nanoid";
import type { StoreApi } from "zustand";
import type { Overlay } from "../../pdf/model/types";
import {
  cloneOverlayWithId,
  translateCalloutWithTarget,
  translateOverlay,
} from "../overlays/geometry";
import { nudgeOverlays } from "../overlays/nudge";
import { noteTimestamps } from "../overlays/noteMetadata";
import type { Store } from "./store";

type SelectedOverlayActions = Pick<
  Store,
  | "removeSelected"
  | "duplicateSelected"
  | "nudgeSelected"
  | "nudgeSelectedNoHistory"
  | "setSelectedLocked"
>;

/** The editor store's edits to the selected overlays. */
export function selectedOverlayActions(
  set: StoreApi<Store>["setState"],
  get: StoreApi<Store>["getState"],
): SelectedOverlayActions {
  return {
    removeSelected: () => {
      const { selectedIds, model } = get();
      if (selectedIds.length === 0) return;
      const overlays = model.overlays.filter(
        (o) => !selectedIds.includes(o.id) || o.locked,
      );
      // Locked overlays stay. With nothing removed there is no edit, and an
      // undo step for it would also have cleared redo.
      if (overlays.length < model.overlays.length) get().commit({ overlays });
      set({ selectedIds: [], editingOverlayId: null });
    },

    duplicateSelected: () => {
      const { selectedIds, model } = get();
      if (selectedIds.length === 0) return;
      // contentText edits are excluded: they are pinned to the source glyphs
      // their covers redact, so a duplicate offset by (+12,−12) would excise
      // the wrong text and paint its replacement over unrelated content.
      const selected = model.overlays.filter(
        (o) => selectedIds.includes(o.id) && o.type !== "contentText",
      );
      if (selected.length === 0) return;
      // The same offset the clipboard paste applies (overlays/clipboard.ts),
      // from the same helpers: the hand-kept list of geometry fields here
      // missed ink paths, so a duplicated stroke or signature sat exactly
      // on its original.
      const newOnes = selected.map((o) => {
        const copy = cloneOverlayWithId(o, nanoid());
        const offset = {
          ...copy,
          ...(copy.type === "callout"
            ? translateCalloutWithTarget(copy, 12, -12)
            : translateOverlay(copy, 12, -12)),
        } as Overlay;
        if (offset.type === "note") Object.assign(offset, noteTimestamps());
        return offset;
      });
      get().commit({ overlays: [...model.overlays, ...newOnes] });
      set({ selectedIds: newOnes.map((o) => o.id) });
    },

    nudgeSelected: (dxDisplayPt, dyDisplayPt) => {
      const { selectedIds, model } = get();
      if (selectedIds.length === 0) return;
      get().commit({
        overlays: nudgeOverlays(
          model.overlays,
          selectedIds,
          model.pages,
          dxDisplayPt,
          dyDisplayPt,
        ),
      });
    },

    // Same move, no undo entry. Held arrow keys auto-repeat every ~15-33 ms, and
    // committing each repeat pushed a full model snapshot: a couple of seconds
    // of nudging filled the 100-entry undo stack and silently discarded every
    // real edit before it, leaving undo able to walk back 1pt at a time and
    // never reach the user's earlier work. The caller pushes ONE history step
    // when the key first goes down, matching how a pointer drag is one step for
    // the whole gesture.
    nudgeSelectedNoHistory: (dxDisplayPt, dyDisplayPt) => {
      const { selectedIds, model } = get();
      if (selectedIds.length === 0) return;
      set({
        model: {
          pages: model.pages,
          overlays: nudgeOverlays(
            model.overlays,
            selectedIds,
            model.pages,
            dxDisplayPt,
            dyDisplayPt,
          ),
        },
      });
    },

    setSelectedLocked: (locked) => {
      const { selectedIds, model } = get();
      if (selectedIds.length === 0) return;
      get().commit({
        overlays: model.overlays.map((overlay) =>
          selectedIds.includes(overlay.id)
            ? ({ ...overlay, locked } as Overlay)
            : overlay,
        ),
      });
    },
  };
}
