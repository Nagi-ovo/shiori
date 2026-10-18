import type { PdfNamedAction } from "./types";

const NAMED_ACTIONS = new Set<string>(["FirstPage", "LastPage", "NextPage", "PrevPage"]);

/** Whether a PDF Named action's /N is one Shiori's link layer follows. */
export function isNamedAction(value: unknown): value is PdfNamedAction {
  return typeof value === "string" && NAMED_ACTIONS.has(value);
}
