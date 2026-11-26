import type { DocumentModel, Overlay, TextFlowChain } from "../../pdf/model/types";

function cloneChains(chains: readonly TextFlowChain[]): TextFlowChain[] {
  return chains.map((chain) => ({
    ...chain,
    frames: chain.frames.map((frame) => ({ ...frame, rect: { ...frame.rect } })),
  }));
}

/** Deep enough for history snapshots: overlays and chains are copied, pages shared. */
export function cloneModel(m: DocumentModel): DocumentModel {
  return {
    pages: m.pages, // immutable; shared
    overlays: m.overlays.map((o) => ({
      ...o,
      ...("rect" in o ? { rect: { ...o.rect } } : null),
      ...("rects" in o ? { rects: o.rects.map((r) => ({ ...r })) } : null),
      ...("targetRects" in o
        ? { targetRects: o.targetRects.map((r) => ({ ...r })) }
        : null),
      ...("leader" in o && o.leader
        ? { leader: o.leader.map((point) => ({ ...point })) }
        : null),
      ...("coverRects" in o
        ? { coverRects: o.coverRects.map((r) => ({ ...r })) }
        : null),
      ...("paths" in o
        ? { paths: o.paths.map((path) => path.map((pt) => ({ ...pt }))) }
        : null),
      ...("thread" in o && o.thread
        ? { thread: o.thread.map((entry) => ({ ...entry })) }
        : null),
    })) as Overlay[],
    ...(m.flowChains ? { flowChains: cloneChains(m.flowChains) } : null),
  };
}

/** A commit patch over the current model; keys the patch omits carry over. */
export function mergeModel(prev: DocumentModel, next: Partial<DocumentModel>): DocumentModel {
  const flowChains = next.flowChains ?? prev.flowChains;
  return {
    pages: next.pages ?? prev.pages,
    overlays: next.overlays ?? prev.overlays,
    ...(flowChains ? { flowChains } : null),
  };
}
