import { nanoid } from "nanoid";
import type { StoreApi } from "zustand";
import type {
  ContentTextOverlay,
  DocumentModel,
  PageModel,
  Rotation,
  TextFlowChain,
  TextFlowFrame,
} from "../../pdf/model/types";
import type { Store } from "./store";

export type FlowChainActions = {
  /** Links two text frames in reading order and returns the chain id. When
   * `editOverlayId` names the first frame's contentText edit, its overflow
   * continues in the second frame on export. */
  linkTextFrames: (
    first: Omit<TextFlowFrame, "id">,
    second: Omit<TextFlowFrame, "id">,
    editOverlayId?: string,
  ) => string;
  unlinkTextFrames: (chainId: string) => void;
};

type PageActionKeys = "movePage" | "deletePage" | "rotatePage" | "duplicatePage" | "insertBlankPage";

function normalizeRotation(r: number): Rotation {
  const mod = ((r % 360) + 360) % 360;
  return mod as Rotation;
}

/** Drops chains for which `keep` fails and clears their edits' chain ids. */
function withoutChains(model: DocumentModel, keep: (chain: TextFlowChain) => boolean): Partial<DocumentModel> {
  const chains = model.flowChains ?? [];
  const dropped = new Set(chains.filter((chain) => !keep(chain)).map((chain) => chain.id));
  if (!dropped.size) return {};
  return {
    flowChains: chains.filter((chain) => !dropped.has(chain.id)),
    overlays: model.overlays.map((o) => {
      if (o.type !== "contentText" || !o.flowChainId || !dropped.has(o.flowChainId)) return o;
      const rest: ContentTextOverlay = { ...o };
      delete rest.flowChainId;
      return rest;
    }),
  };
}

export function pageActions(
  set: StoreApi<Store>["setState"],
  get: StoreApi<Store>["getState"],
): Pick<Store, PageActionKeys> & FlowChainActions {
  return {
    movePage: (from, to) => {
      const m = get().model;
      if (from === to || from < 0 || to < 0 || from >= m.pages.length) return;
      const pages = [...m.pages];
      const [moved] = pages.splice(from, 1);
      if (!moved) return;
      pages.splice(to, 0, moved);
      get().commit({ pages });
    },

    deletePage: (id) => {
      const m = get().model;
      if (m.pages.length <= 1) return;
      const pages = m.pages.filter((p) => p.id !== id);
      const pruned = withoutChains(m, (chain) => chain.frames.every((frame) => frame.pageId !== id));
      const overlays = (pruned.overlays ?? m.overlays).filter((o) => o.pageId !== id);
      get().commit({ ...pruned, pages, overlays });
      if (get().activePageId === id) {
        set({ activePageId: pages[0]?.id ?? null });
      }
    },

    rotatePage: (id, delta) => {
      const m = get().model;
      const pages = m.pages.map((p) =>
        p.id === id
          ? { ...p, rotation: normalizeRotation(p.rotation + delta) }
          : p,
      );
      get().commit({ pages });
    },

    // The copy gets no chains: a chain names its frames' pages by id, so the
    // duplicate's text stays unlinked until the reader links it.
    duplicatePage: (id) => {
      const m = get().model;
      const idx = m.pages.findIndex((p) => p.id === id);
      if (idx < 0) return;
      const src = m.pages[idx]!;
      const newPage: PageModel = { ...src, id: nanoid() };
      const pages = [...m.pages];
      pages.splice(idx + 1, 0, newPage);
      get().commit({ pages });
    },

    insertBlankPage: (afterPageId) => {
      const m = get().model;
      const reference =
        m.pages.find((p) => p.id === afterPageId) ?? m.pages.at(-1);
      const blank: PageModel = {
        id: nanoid(),
        sourceIndex: -1,
        rotation: 0,
        widthPt: reference?.widthPt ?? 612,
        heightPt: reference?.heightPt ?? 792,
        blank: true,
      };
      const pages = [...m.pages];
      const idx = afterPageId
        ? pages.findIndex((p) => p.id === afterPageId)
        : pages.length - 1;
      pages.splice(idx >= 0 ? idx + 1 : pages.length, 0, blank);
      get().commit({ pages });
      set({ activePageId: blank.id });
    },

    linkTextFrames: (first, second, editOverlayId) => {
      const m = get().model;
      const chain: TextFlowChain = {
        id: nanoid(),
        frames: [first, second].map((frame) => ({ ...frame, rect: { ...frame.rect }, id: nanoid() })),
      };
      const overlays = editOverlayId
        ? m.overlays.map((o) => o.id === editOverlayId && o.type === "contentText" ? { ...o, flowChainId: chain.id } : o)
        : m.overlays;
      get().commit({ flowChains: [...(m.flowChains ?? []), chain], overlays });
      return chain.id;
    },

    unlinkTextFrames: (chainId) => {
      const m = get().model;
      const pruned = withoutChains(m, (chain) => chain.id !== chainId);
      if (pruned.flowChains) get().commit(pruned);
    },
  };
}
