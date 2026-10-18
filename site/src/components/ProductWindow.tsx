import { memo, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useLang } from "../i18n/context";
import type { Dict } from "../i18n/dict";
import { BrandTile } from "./Brand";
import { Kbd } from "./Kbd";

type Props = {
  /** Force a dark Shiori chrome regardless of the page theme — used in
   *  the Preview section to showcase Night mode while the page may be
   *  light. */
  forceDark?: boolean;
  /** Hero shows page 1 of welcome.pdf (title + abstract). Preview shows
   *  page 2 (body text with annotations baked statically). */
  variant?: "hero" | "preview";
  /** When set, hero variant becomes a scripted demo: the toolbar's active
   *  tool, the status-bar text, and the page-1 annotation overlays are
   *  all driven by the current step. Driven by HeroDemo. */
  demoStep?: DemoStep;
};

// ───────── demo step machine ─────────

export type DemoStep =
  | "idle"
  | "tool-highlight"
  | "highlight-drawn"
  | "tool-note"
  | "note-placed"
  | "tool-ink"
  | "ink-drawn"
  | "export-pulse"
  | "reset";

type ToolKey =
  | "select"
  | "highlight"
  | "ink"
  | "stamp"
  | "rect"
  | "note"
  | "text";

const TOOL_FOR_STEP: Record<DemoStep, ToolKey> = {
  idle: "select",
  reset: "select",
  "tool-highlight": "highlight",
  "highlight-drawn": "highlight",
  "tool-note": "note",
  "note-placed": "note",
  "tool-ink": "ink",
  "ink-drawn": "ink",
  "export-pulse": "select",
};

function statusForStep(t: Dict, step: DemoStep): string {
  switch (step) {
    case "tool-highlight":
    case "highlight-drawn":
      return t.demoStatus1Highlight;
    case "tool-note":
    case "note-placed":
      return t.demoStatus2Note;
    case "tool-ink":
    case "ink-drawn":
      return t.demoStatus3Ink;
    case "export-pulse":
      return t.demoStatus4Export;
    case "idle":
    case "reset":
    default:
      return t.demoStatus0Reading;
  }
}

// Each annotation has its own "armed after this step" predicate so the
// same flag drives both the AnimatePresence mount and the highlight
// `animate` prop.
function showHighlightFor(step: DemoStep): boolean {
  return (
    step === "highlight-drawn" ||
    step === "tool-note" ||
    step === "note-placed" ||
    step === "tool-ink" ||
    step === "ink-drawn" ||
    step === "export-pulse"
  );
}
function showNoteFor(step: DemoStep): boolean {
  return (
    step === "note-placed" ||
    step === "tool-ink" ||
    step === "ink-drawn" ||
    step === "export-pulse"
  );
}
function showInkFor(step: DemoStep): boolean {
  return step === "ink-drawn" || step === "export-pulse";
}

// ───────── toolbar definition ─────────

type ToolDef = {
  key: ToolKey;
  icon: ReactNode;
  shortcut: string;
};

const TOOLS: ReadonlyArray<ToolDef> = [
  { key: "select", icon: "▷", shortcut: "V" },
  {
    key: "highlight",
    icon: <span className="swatch" style={{ background: "#f4d674" }} />,
    shortcut: "H",
  },
  { key: "ink", icon: "✎", shortcut: "I" },
  { key: "stamp", icon: "✓", shortcut: "S" },
  { key: "rect", icon: "▭", shortcut: "R" },
  { key: "note", icon: "☐", shortcut: "N" },
  { key: "text", icon: "T", shortcut: "T" },
];

function toolLabel(t: Dict, key: ToolKey): string {
  switch (key) {
    case "select":
      return t.toolSelect;
    case "highlight":
      return t.toolHighlight;
    case "ink":
      return t.toolInk;
    case "stamp":
      return t.toolStamp;
    case "rect":
      return t.toolRect;
    case "note":
      return t.toolNote;
    case "text":
      return t.toolText;
  }
}

// ───────── component ─────────

// Mock of the Shiori editor chrome. When `demoStep` is provided (hero
// scripted demo), the toolbar / status-bar / page body all derive from
// the step; otherwise the static welcome.pdf imagery is rendered.
function ProductWindowInner({ forceDark, variant = "hero", demoStep }: Props) {
  const { t } = useLang();
  const isPreview = variant === "preview";
  const isDemo = !isPreview && !!demoStep;
  const activePage = isPreview ? 2 : 1;
  const isActive = (n: number) => n === activePage;

  const activeTool: ToolKey = isDemo
    ? TOOL_FOR_STEP[demoStep]
    : isPreview
      ? "select"
      : "select";
  const statusText: string = isDemo
    ? statusForStep(t, demoStep)
    : isPreview
      ? t.hintThumb
      : t.hintSelect;

  return (
    <div
      className={forceDark ? "win win-dark" : "win"}
      aria-label="Shiori app preview"
    >
      <div className="win-bar">
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
        <BrandTile small />
        <span className="win-name">Shiori</span>
        <span className="win-icons">▤ ☰</span>
        <span className="win-title">
          <b>welcome.pdf</b>
          <span className="meta">
            3 {t.metaPp} · 11 KB · {t.metaLocal}
          </span>
        </span>
        {!isPreview && !isDemo && <Kbd keys="⌘F" />}
        {isDemo ? (
          <motion.span
            className="win-export"
            animate={
              demoStep === "export-pulse"
                ? {
                    boxShadow: [
                      "0 0 0 0 rgba(51,136,187,0)",
                      "0 0 0 6px rgba(51,136,187,0.18)",
                      "0 0 0 0 rgba(51,136,187,0)",
                    ],
                    color: ["#b5bcc8", "#fff", "#b5bcc8"],
                    backgroundColor: [
                      "transparent",
                      "rgba(51,136,187,0.85)",
                      "transparent",
                    ],
                  }
                : {}
            }
            transition={{ duration: 0.85, ease: "easeOut" }}
          >
            {t.navExport} ↓
          </motion.span>
        ) : (
          <span className="win-export">{t.navExport} ↓</span>
        )}
      </div>

      <div className="win-toolbar">
        {TOOLS.map((tool) => {
          const isToolActive = tool.key === activeTool;
          // Static hero used a plain dark swatch on the Select tool;
          // preview + demo both show the accent-blue active state so the
          // animated tool change reads clearly.
          const className = !isToolActive
            ? "tool"
            : !isDemo && !isPreview
              ? "tool active"
              : "tool active accent";
          // The Select tool always shows its V chip (matches the original
          // static design); other tools' shortcuts only render in hero.
          const showShortcut = tool.key === "select" || !isPreview;
          return (
            <span key={tool.key} className={className}>
              {tool.icon} {toolLabel(t, tool.key)}
              {showShortcut && <Kbd keys={tool.shortcut} />}
            </span>
          );
        })}
        {!isPreview && (
          <>
            <span className="tool-divider" />
            <span className="tool tool-ic" aria-label="Undo">
              <UndoIcon />
            </span>
            <span className="tool tool-ic" aria-label="Redo">
              <RedoIcon />
            </span>
          </>
        )}
        <span className="zoom-meta">154%</span>
      </div>

      <div className="win-status">
        <b>{toolLabel(t, activeTool)}</b>
        {!isPreview && <span className="sep">·</span>}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={statusText}
            initial={isDemo ? { opacity: 0, y: 4 } : false}
            animate={{ opacity: 1, y: 0 }}
            exit={isDemo ? { opacity: 0, y: -4 } : undefined}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            {statusText}
          </motion.span>
        </AnimatePresence>
      </div>

      <div className="win-body">
        <aside className="pages-col">
          <div className="ph">
            <span>{t.thumbsHeader}</span>
            <span>
              {!isPreview && <b>+</b>} 3 {t.thumbsTotal}
            </span>
          </div>
          <Thumb num={1} active={isActive(1)} kind="title" />
          <Thumb num={2} active={isActive(2)} kind="body" />
          <Thumb num={3} active={isActive(3)} kind="body" />
        </aside>
        {isPreview ? (
          <WelcomePage2 />
        ) : isDemo ? (
          <WelcomePage1Demo step={demoStep} noteText={t.demoNoteText} />
        ) : (
          <WelcomePage1 />
        )}
      </div>
    </div>
  );
}

// Memo the inner so the parent step machine in HeroDemo can re-render
// cheaply on each step tick — only the props that actually change drive
// re-paints inside the chrome.
export const ProductWindow = memo(ProductWindowInner);

// ───────── document pages ─────────

// Page 1 (static): title block + Abstract paragraph with one baked
// highlight. Used when the hero variant is rendered without a demoStep
// (defensive — site/Hero.tsx now always wraps in HeroDemo).
function WelcomePage1() {
  return (
    <article className="doc doc-welcome">
      <span className="doc-side">[cs.HC] · welcome.pdf</span>
      <div className="doc-arxiv-head">
        [cs.HC] · current beta · Shiori
      </div>
      <div className="doc-shiori-rule" />
      <h2 className="doc-shiori-title">Shiori</h2>
      <div className="doc-shiori-sub">
        A Local-First Document Reader and PDF Editor
      </div>
      <div className="doc-shiori-rule thin" />
      <div className="doc-shiori-author">Maintained quietly</div>
      <div className="doc-shiori-affil">shiori.nagi.fun · 2026</div>

      <div className="doc-section-head">Abstract</div>
      <p className="doc-abstract">
        Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do
        eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut
        enim ad{" "}
        <mark>minim veniam, quis nostrud exercitation ullamco laboris</mark>{" "}
        nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in
        reprehenderit in voluptate velit esse cillum dolore eu fugiat
        nulla pariatur.
      </p>
    </article>
  );
}

// Page 1 (animated): same chrome as WelcomePage1 but the three demo
// annotations are mounted/animated based on the current step.
//
// - Highlight: a <motion.mark> whose linear-gradient bg-size animates
//   width from 0% → 100% to "draw" the yellow band.
// - Sticky note: an <AnimatePresence> aside that pops in with spring
//   overshoot at the right margin.
// - Ink: an SVG wavy underline whose stroke pathLength animates 0 → 1.
function WelcomePage1Demo({
  step,
  noteText,
}: {
  step: DemoStep;
  noteText: string;
}) {
  const showHl = showHighlightFor(step);
  const showNote = showNoteFor(step);
  const showInk = showInkFor(step);
  const reduce = useReducedMotion();

  return (
    <article className="doc doc-welcome doc-welcome-demo">
      <span className="doc-side">[cs.HC] · welcome.pdf</span>
      <div className="doc-arxiv-head">
        [cs.HC] · current beta · Shiori
      </div>
      <div className="doc-shiori-rule" />
      <h2 className="doc-shiori-title">Shiori</h2>
      <div className="doc-shiori-sub">
        A Local-First Document Reader and PDF Editor
      </div>
      <div className="doc-shiori-rule thin" />
      <div className="doc-shiori-author">Maintained quietly</div>
      <div className="doc-shiori-affil">shiori.nagi.fun · 2026</div>

      <div className="doc-section-head">Abstract</div>
      <p className="doc-abstract">
        Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do
        eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut
        enim ad{" "}
        <span className="doc-mark-anim">
          <motion.span
            className="doc-mark-fill"
            aria-hidden
            initial={reduce ? false : { scaleX: 0 }}
            animate={{ scaleX: showHl ? 1 : 0 }}
            transition={{ duration: reduce ? 0 : 0.6, ease: [0.65, 0, 0.35, 1] }}
          />
          <span className="doc-mark-text">
            minim veniam, quis nostrud exercitation ullamco laboris
          </span>
        </span>{" "}
        nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in
        reprehenderit in voluptate velit{" "}
        <span className="doc-anno-ink-host">
          esse cillum dolore
          <svg
            className="doc-anno-ink-svg"
            viewBox="0 0 100 8"
            preserveAspectRatio="none"
            aria-hidden
          >
            <motion.path
              d="M1 5 Q 8 1.5 16 5 T 32 5 T 48 5 T 64 5 T 80 5 T 99 5"
              stroke="#3388bb"
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              initial={reduce ? false : { pathLength: 0, opacity: 0 }}
              animate={{
                pathLength: showInk ? 1 : 0,
                opacity: showInk ? 1 : 0,
              }}
              transition={{
                pathLength: { duration: reduce ? 0 : 0.85, ease: "easeInOut" },
                opacity: { duration: reduce ? 0 : 0.18 },
              }}
            />
          </svg>
        </span>{" "}
        eu fugiat nulla pariatur.
      </p>

      <AnimatePresence>
        {showNote && (
          <motion.aside
            className="doc-anno-note doc-anno-note-p1"
            aria-label="Sticky note"
            initial={reduce ? false : { opacity: 0, scale: 0.82, x: 14, rotate: 1.5 }}
            animate={{ opacity: 1, scale: 1, x: 0, rotate: 0 }}
            exit={{ opacity: 0, scale: 0.9, x: 8, transition: { duration: reduce ? 0 : 0.2 } }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 280, damping: 17 }
            }
          >
            <span>{noteText}</span>
          </motion.aside>
        )}
      </AnimatePresence>
    </article>
  );
}

// Page 2 (static): section heading, body paragraph with ink underline +
// sticky note in the right margin + dashed connector. Stamp + rectangle
// + block quote demo the rest of the toolset. Used for the Preview
// section only.
function WelcomePage2() {
  return (
    <article className="doc doc-welcome doc-welcome-p2">
      <span className="doc-side">[cs.HC] · welcome.pdf</span>

      <div className="doc-section-head left">2. The Quiet Tool</div>

      <span className="doc-anno-stamp" aria-hidden>
        <CheckIcon />
      </span>

      <p className="doc-body doc-body-narrow">
        At vero eos et accusamus et iusto odio dignissimos qui blanditiis{" "}
        <span className="doc-anno-ink">praesentium voluptatum</span> deleniti
        atque corrupti quos dolores et quas molestias excepturi sint
        occaecati cupiditate non provident.
      </p>

      <aside className="doc-anno-note" aria-label="Sticky note">
        <span>follow-up: revisit — the framing matters more than the example</span>
      </aside>

      <div className="doc-anno-rect">
        <p>
          Annotation should feel like writing in the margin of a borrowed
          book — careful, considered, yours alone.
        </p>
      </div>

      <blockquote className="doc-quote">
        <p>
          "Of making many books there is no end; and much study is a
          weariness of the flesh."
        </p>
        <span className="src">— Ecclesiastes 12:12</span>
      </blockquote>
    </article>
  );
}

// ───────── thumbnail mini-renders ─────────

type ThumbProps = {
  num: number;
  active: boolean;
  kind: "title" | "body";
};

function Thumb({ num, active, kind }: ThumbProps) {
  return (
    <div className={active ? "thumb active" : "thumb"}>
      {kind === "title" ? <span className="thumb-title-block" /> : null}
      <span className="num">{String(num).padStart(2, "0")}</span>
    </div>
  );
}

// ───────── icons ─────────

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8.5 L7 12 L13 4" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 5 H 10 A 3.5 3.5 0 1 1 6.5 11.5" />
      <path d="M5 2.5 L 2.5 5 L 5 7.5" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 5 H 6 A 3.5 3.5 0 1 0 9.5 11.5" />
      <path d="M11 2.5 L 13.5 5 L 11 7.5" />
    </svg>
  );
}
