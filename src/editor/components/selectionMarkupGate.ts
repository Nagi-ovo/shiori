import type { ToolId } from "../../pdf/model/types";

/**
 * Whether selecting text offers the markup popover.
 *
 * Only under the select tool: the markup tools already commit on pointer-up,
 * so a popover there would be redundant and could double-apply.
 *
 * This is the reason a phone's reading mode pins the tool back to `select`
 * when it leaves annotation mode (see the store's setAnnotationMode).
 * Select-text-then-mark is the most common thing a reader does, and it has
 * to work without stepping into annotation mode first — a reading mode that
 * left a markup tool armed would silently take it away, with no tool grid on
 * screen to change it back from.
 */
export function selectionMarkupPopupEnabled(tool: ToolId): boolean {
  return tool === "select";
}
