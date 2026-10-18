/**
 * The ordered steps that make a workspace tab the visible one.
 *
 * Switching tabs, closing the active tab, and closing the last tab all end in
 * the same ritual: settle the draft notices, move the editor onto the right
 * store, publish the active tab id, and reset the export markers. The order is
 * load-bearing. For a PDF whose editor store was suspended, the previous
 * document must be detached BEFORE the new id is published: the cold-load
 * pipeline reads the id, and seeing the new id beside the old `opened`
 * state lets it persist one tab's state into another.
 *
 * A tab that holds no document yet (never opened this session, or suspended)
 * is loaded as the last step, once it is on screen.
 *
 * The planner returns the steps as data so that order is testable; App applies
 * them. It never serializes or hydrates an editor session — a resident tab's
 * store is re-attached as is.
 */

export type ActivationTarget<TDraft, TNotice, TExport> = {
  id: string;
  kind: string;
  status?: string;
  hash?: string;
  exportBaselineSnapshot?: string | null;
  lastExport?: TExport | null;
  draftRestore?: { mode: "pending" | "deferred"; draft: TDraft };
  restoredDraft?: TNotice;
};

export type ActivationStep<TDraft, TNotice, TExport> =
  | {
      kind: "setDraftNotices";
      pending: TDraft | null;
      deferred: TDraft | null;
      restored: TNotice | null;
    }
  /** Close the shared empty store's document and make it the editor store. */
  | { kind: "detachEditor" }
  /** Phones start a re-attached PDF with the thumbnail rail closed. */
  | { kind: "hideThumbs"; tabId: string }
  | { kind: "publishActiveTab"; tabId: string | null }
  /** Mark the resident store most recently used. */
  | { kind: "touchResident"; tabId: string }
  | { kind: "attachResident"; tabId: string }
  | {
      kind: "setExportState";
      hash: string | null;
      baseline: string | null;
      lastExport: TExport | null;
    }
  /** Read the tab's bytes back and open them (intake/coldLoad). */
  | { kind: "loadDocument"; tabId: string };

export type ActivationContext = {
  /**
   * The target's resident editor store, if it has one. `baseline` is only
   * called when the tab carries no export baseline of its own.
   */
  resident: { baseline: () => string } | null;
  isMobile: boolean;
};

export function planTabActivation<TDraft, TNotice, TExport>(
  target: ActivationTarget<TDraft, TNotice, TExport> | null,
  context: ActivationContext,
): ActivationStep<TDraft, TNotice, TExport>[] {
  const steps = planSwap(target, context);
  if (target?.status === "unloaded" || target?.status === "suspended") {
    steps.push({ kind: "loadDocument", tabId: target.id });
  }
  return steps;
}

function planSwap<TDraft, TNotice, TExport>(
  target: ActivationTarget<TDraft, TNotice, TExport> | null,
  context: ActivationContext,
): ActivationStep<TDraft, TNotice, TExport>[] {
  const restore = target?.draftRestore;
  const steps: ActivationStep<TDraft, TNotice, TExport>[] = [
    {
      kind: "setDraftNotices",
      pending: restore?.mode === "pending" ? restore.draft : null,
      deferred: restore?.mode === "deferred" ? restore.draft : null,
      restored: target?.restoredDraft ?? null,
    },
  ];
  const cleared = {
    kind: "setExportState",
    hash: null,
    baseline: null,
    lastExport: null,
  } as const;

  if (!target) {
    steps.push(
      { kind: "detachEditor" },
      { kind: "publishActiveTab", tabId: null },
      cleared,
    );
    return steps;
  }

  if (target.kind !== "pdf") {
    steps.push(
      { kind: "publishActiveTab", tabId: target.id },
      { kind: "detachEditor" },
      cleared,
    );
    return steps;
  }

  if (!context.resident) {
    // Suspended or never loaded: detach first, then publish (see above).
    steps.push(
      { kind: "detachEditor" },
      { kind: "publishActiveTab", tabId: target.id },
      cleared,
    );
    return steps;
  }

  if (context.isMobile) steps.push({ kind: "hideThumbs", tabId: target.id });
  steps.push(
    { kind: "publishActiveTab", tabId: target.id },
    { kind: "touchResident", tabId: target.id },
    { kind: "attachResident", tabId: target.id },
    {
      kind: "setExportState",
      hash: target.hash ?? null,
      baseline: target.exportBaselineSnapshot ?? context.resident.baseline(),
      lastExport: target.lastExport ?? null,
    },
  );
  return steps;
}
