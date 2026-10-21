import type { TFunction } from "i18next";
import type { Overlay, OverlayType } from "../../../pdf/model/types";
import { isSignatureOverlay } from "./overlayGuards";

// How much annotation text goes into the accessible name before it is cut.
// Long enough to identify which annotation this is, short enough that a
// screen reader is not forced to read a whole paragraph just to move past it.
const NAME_TEXT_LIMIT = 80;

function trimForName(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= NAME_TEXT_LIMIT) return flat;
  return `${flat.slice(0, NAME_TEXT_LIMIT - 1)}…`;
}

// The `inspector.labels.*` key that names each overlay type. A Record, so a new
// type cannot ship without a name: the lookup used to fall back to the raw
// type, and rect / image / contentText were announced as those slugs.
const TYPE_LABEL: Record<OverlayType, string> = {
  highlight: "highlight",
  underline: "underline",
  strikethrough: "strikethrough",
  ink: "ink",
  image: "image",
  stamp: "stamp",
  rect: "rectangle",
  note: "note",
  text: "text",
  callout: "callout",
  contentText: "contentText",
};

/**
 * A one-line name for an annotation, in the reading order "what it is, what it
 * says, what state it is in".
 *
 * Every annotation used to reach assistive tech as an unlabelled <div> over an
 * unlabelled <svg> — `overlaySvg.tsx` contained no role or aria attribute at
 * all — so a marked-up page announced nothing whatsoever. Highlights, ink,
 * rectangles, stamps and signatures were simply absent; text-bearing ones read
 * as loose text with no indication they were annotations.
 *
 * Type names are reused from `inspector.labels.*` rather than duplicated, so
 * the name a screen reader hears matches the word the inspector shows.
 */
export function describeOverlay(overlay: Overlay, t: TFunction): string {
  const label = isSignatureOverlay(overlay)
    ? "signature"
    : TYPE_LABEL[overlay.type];
  const kind = t(`inspector.labels.${label}`);
  const parts: string[] = [kind];

  // Text-bearing annotations identify themselves by what they say.
  if (
    overlay.type === "note" ||
    overlay.type === "text" ||
    overlay.type === "callout"
  ) {
    const body = trimForName(overlay.text ?? "");
    parts.push(body || t("a11y.annotation.empty"));
  }

  // Text markup is anchored to the page rather than carrying its own words,
  // so say how much of the page it covers instead.
  if (
    overlay.type === "highlight" ||
    overlay.type === "underline" ||
    overlay.type === "strikethrough"
  ) {
    parts.push(t("a11y.annotation.marks", { count: overlay.rects.length }));
  }

  if (overlay.type === "callout" && overlay.thread?.length) {
    parts.push(
      t("a11y.annotation.replies", { count: overlay.thread.length }),
    );
  }

  if (overlay.locked) parts.push(t("a11y.annotation.locked"));

  return parts.join(", ");
}
