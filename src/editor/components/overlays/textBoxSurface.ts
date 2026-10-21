// The frame, background and text colour of a text box, callout or original-
// text edit on the page. Split out of ./OverlayDom.

import { T } from "../../../design/tokens";
import type {
  CalloutOverlay,
  ContentTextOverlay,
  TextOverlay,
} from "../../../pdf/model/types";

export function textBoxSurface(
  overlay: TextOverlay | ContentTextOverlay | CalloutOverlay,
  { selected, collapsed }: { selected: boolean; collapsed: boolean; scale: number },
): { border: string; backgroundColor: string; color: string } {
  const isCallout = overlay.type === "callout";
  // contentText and callouts frame with `outline` (see ./OverlayDom).
  const border = overlay.type === "contentText" || isCallout
    ? "none"
    : `1px dashed ${selected ? T.ink : "rgba(26,24,21,0.18)"}`;
  const backgroundColor = isCallout
    ? collapsed
      ? overlay.color
      : "rgba(255,253,247,0.96)"
    : selected
      ? "rgba(26,24,21,0.02)"
      : "transparent";
  return { border, backgroundColor, color: overlay.color };
}
