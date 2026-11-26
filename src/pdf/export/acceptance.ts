import type { ExportResult } from "./exportPdf";

export type AcceptancePolicy = "strict" | "review";
export type AcceptanceFindingKind =
  | "new-collision"
  | "overflow-envelope"
  | "uncertain-contact"
  | "clipped-text"
  | "lost-text"
  | "unexcised-edit"
  | "stripped-equivalent";
export type AcceptanceFinding = {
  kind: AcceptanceFindingKind;
  overlayId?: string;
  /** Zero-based output page index. */
  pageIndex?: number;
  /** PDF user space in points. Required for measured new collisions. */
  region?: { x: number; y: number; w: number; h: number };
  count?: number;
};
export type AcceptanceNoteKind = "pre-existing-contact" | "substituted-face" | "spacing-adjusted" | "approximate-fidelity";
export type AcceptanceVerdict = {
  policy: AcceptancePolicy;
  status: "accepted" | "needs-review" | "refused";
  findings: AcceptanceFinding[];
  notes: { kind: AcceptanceNoteKind; overlayId?: string }[];
  key: string;
};

export function evaluateAcceptance(
  input: Pick<ExportResult, "lostChars" | "unexcisedEdits" | "clippedChars" | "contentTextOutcomes">,
  policy: AcceptancePolicy,
  key = "",
): Omit<AcceptanceVerdict, "key"> & { key: string } {
  const findings: AcceptanceFinding[] = [];
  const notes: AcceptanceVerdict["notes"] = [];
  const counters: [AcceptanceFindingKind, number | undefined][] = [
    ["clipped-text", input.clippedChars],
    ["lost-text", input.lostChars],
    ["unexcised-edit", input.unexcisedEdits],
  ];
  for (const [kind, count] of counters) {
    if (count !== undefined && count > 0) findings.push({ kind, count });
  }
  for (const outcome of input.contentTextOutcomes ?? []) {
    const { overlayId, pageIndex, contact, retypeset } = outcome;
    // Strict refusals retain the evidence measured on the discarded edit.
    if (outcome.mode === "unsupported" && outcome.reason !== "acceptance-strict") continue;
    const location = pageIndex === undefined ? { overlayId } : { overlayId, pageIndex };
    if (contact?.kind === "new-collision") {
      findings.push({ kind: "new-collision", ...location, region: { ...contact.region } });
    } else if (contact?.kind === "uncertain") {
      findings.push({ kind: "uncertain-contact", ...location, ...(contact.region && { region: { ...contact.region } }) });
    } else if (contact?.kind === "pre-existing-contact") {
      notes.push({ kind: "pre-existing-contact", overlayId });
    }
    if (retypeset?.overflowInkOverlap) findings.push({ kind: "overflow-envelope", ...location });
    if (outcome.strippedEquivalent) findings.push({ kind: "stripped-equivalent", ...location });
    if (outcome.mode === "unsupported") continue;
    if (outcome.mode === "substituted" || outcome.mode === "fallback-font" || outcome.faces?.length || retypeset?.substituteFont) {
      notes.push({ kind: "substituted-face", overlayId });
    }
    const fit = retypeset?.envelopeFit ?? retypeset?.frameFit;
    if (outcome.sourceSpacingAdjusted || outcome.reflow?.strategy === "spacing-only" || fit?.trackingEm || fit?.wordReductionEm) {
      notes.push({ kind: "spacing-adjusted", overlayId });
    }
    if (outcome.fidelity === "approximate") notes.push({ kind: "approximate-fidelity", overlayId });
  }
  const status = findings.length === 0 ? "accepted" : policy === "strict" ? "refused" : "needs-review";
  return { policy, status, findings, notes, key };
}
