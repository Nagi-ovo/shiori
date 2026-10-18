import type { CSSProperties } from "react";
import {
  liveRevealAnimationDelay,
  liveRevealAnimationDuration,
  type ActiveLiveOverlayReveal,
} from "../../../live/overlayReveal";
import {
  liveRevealTextTimeline,
  needsWholeTextReveal,
} from "./revealTextTiming";

export function LiveRevealText({
  text,
  reveal,
  shellRatio = 0.08,
}: {
  text: string;
  reveal: ActiveLiveOverlayReveal | null;
  shellRatio?: number;
}) {
  if (!reveal || text.length === 0) return text;
  if (needsWholeTextReveal(text)) {
    return (
      <span
        data-live-reveal-text=""
        data-live-reveal-mode="whole"
        dir="auto"
        style={{
          display: "inline-block",
          whiteSpace: "inherit",
          unicodeBidi: "plaintext",
          opacity: 0,
          animation: `shioriLiveTextFloat ${liveRevealAnimationDuration(reveal, 0.34)} cubic-bezier(.22,.8,.24,1) ${liveRevealAnimationDelay(reveal, Math.round(reveal.item.durationMs * 0.58))} both`,
        }}
      >
        {text}
      </span>
    );
  }
  const timeline = liveRevealTextTimeline(
    text,
    reveal.item.durationMs,
    shellRatio,
  );
  return (
    <span
      data-live-reveal-text=""
      aria-label={text}
      style={{ whiteSpace: "inherit" }}
    >
      {timeline.groups.map((group, index) => {
        const style: CSSProperties = {
          opacity: 0,
          animation: `shioriLiveTypeIn ${timeline.fadeMs}ms ease-out ${liveRevealAnimationDelay(
            reveal,
            timeline.shellMs + timeline.stepMs * index,
          )} both`,
        };
        return (
          <span key={index} aria-hidden="true" style={style}>
            {group}
          </span>
        );
      })}
    </span>
  );
}
