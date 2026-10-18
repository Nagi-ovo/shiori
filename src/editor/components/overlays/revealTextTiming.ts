import { splitRevealGraphemes } from "./revealTextSegmentation";

const MAX_ANIMATED_TEXT_GROUPS = 60;

// Splitting these scripts into separately animated inline spans can break
// contextual shaping, joining, reordering, or consonant clusters even when
// the textContent stays correct. Keep one text node and float it in instead.
const WHOLE_TEXT_REVEAL_SCRIPT =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export function needsWholeTextReveal(text: string): boolean {
  return WHOLE_TEXT_REVEAL_SCRIPT.test(text);
}

function revealGroups(text: string): string[] {
  const graphemes = splitRevealGraphemes(text);
  if (graphemes.length <= MAX_ANIMATED_TEXT_GROUPS) return graphemes;
  const groupSize = Math.ceil(graphemes.length / MAX_ANIMATED_TEXT_GROUPS);
  const groups: string[] = [];
  for (let index = 0; index < graphemes.length; index += groupSize) {
    groups.push(graphemes.slice(index, index + groupSize).join(""));
  }
  return groups;
}

export type LiveRevealTextTimeline = {
  groups: string[];
  shellMs: number;
  stepMs: number;
  fadeMs: number;
  lastEndMs: number;
};

/** Fits every glyph-group fade inside the parent annotation's time budget. */
export function liveRevealTextTimeline(
  text: string,
  itemDurationMs: number,
  shellRatio = 0.08,
): LiveRevealTextTimeline {
  const groups = revealGroups(text);
  const durationMs = Math.max(1, Math.floor(itemDurationMs));
  const shellMs = Math.min(
    durationMs - 1,
    220,
    Math.max(0, Math.round(durationMs * shellRatio)),
  );
  const typingMs = Math.max(1, durationMs - shellMs);
  // Reserve enough room for the final fade before spacing the preceding
  // groups. Flooring the step keeps rounding from leaking past itemEnd.
  const reservedFadeMs = Math.min(60, typingMs);
  const stepMs = groups.length > 1
    ? Math.min(
        28,
        Math.max(
          0,
          Math.floor((typingMs - reservedFadeMs) / (groups.length - 1)),
        ),
      )
    : 0;
  const remainingForLastFade = Math.max(
    1,
    typingMs - stepMs * Math.max(0, groups.length - 1),
  );
  const fadeMs = Math.max(
    1,
    Math.min(110, stepMs + 44, remainingForLastFade),
  );
  return {
    groups,
    shellMs,
    stepMs,
    fadeMs,
    lastEndMs:
      shellMs + stepMs * Math.max(0, groups.length - 1) + fadeMs,
  };
}
