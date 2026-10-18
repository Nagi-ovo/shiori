import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "framer-motion";
import { useLang } from "../i18n/context";
import { ProductWindow, type DemoStep } from "./ProductWindow";

// Browser app for the "try it without downloading" affordance — clicking
// the demo opens the live web build in a new tab. The same URL is used
// by the secondary CTA in Hero.tsx; if it ever moves, update both.
const TRY_URL = "https://app.shiori.nagi.fun";

// Scripted hero demo. The same Shiori chrome the user will install on
// their machine, with a 7-second loop that walks through the four
// annotation tools (highlight → note → ink → export). Pauses on hover,
// pauses when scrolled out of view, and respects prefers-reduced-motion
// by jumping to the "all annotations placed" final frame.
//
// Design budget:
// - Animations are isolated to the leaf ProductWindow tree (memoized).
// - The step machine triggers a single setState per tick (~600–1200ms).
// - No scroll listeners; visibility comes from useInView (Intersection-
//   Observer under the hood), so off-screen heroes cost nothing.

type Step = { step: DemoStep; hold: number };

// Total cycle ≈ 7s. Holds tuned so each tool change reads before the
// next animation starts.
const SCRIPT: ReadonlyArray<Step> = [
  { step: "idle", hold: 800 },
  { step: "tool-highlight", hold: 450 },
  { step: "highlight-drawn", hold: 950 },
  { step: "tool-note", hold: 450 },
  { step: "note-placed", hold: 1100 },
  { step: "tool-ink", hold: 450 },
  { step: "ink-drawn", hold: 1200 },
  { step: "export-pulse", hold: 950 },
  { step: "reset", hold: 600 },
];

export function HeroDemo() {
  const ref = useRef<HTMLAnchorElement>(null);
  const inView = useInView(ref, { amount: 0.35 });
  const reduce = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [idx, setIdx] = useState(0);
  const { t } = useLang();

  useEffect(() => {
    if (reduce || paused || !inView) return;
    const id = window.setTimeout(() => {
      setIdx((i) => (i + 1) % SCRIPT.length);
    }, SCRIPT[idx].hold);
    return () => window.clearTimeout(id);
  }, [idx, paused, inView, reduce]);

  // Reduced motion: skip the loop entirely; render the "all annotations
  // placed" frame so the user still understands the workflow visually.
  const step: DemoStep = reduce ? "ink-drawn" : SCRIPT[idx].step;

  return (
    <a
      ref={ref}
      className="hero-demo"
      href={TRY_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t.heroCtaSecondary}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <ProductWindow variant="hero" demoStep={step} />
    </a>
  );
}
