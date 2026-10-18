import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useInView, useReducedMotion } from "framer-motion";
import {
  CLI_INSTALL_CURL,
  CLI_INSTALL_NPM,
  CLI_INSTALL_POWERSHELL,
} from "../content/cliInstall";
import {
  CLI_LOGO_CENTER_ROW,
  CLI_LOGO_COLUMNS,
  CLI_LOGO_ROWS,
  cliLogoCells,
} from "../content/cliLogo";
import { renderRich, useLang } from "../i18n/context";

// Timings, spinner frames, and trail rules deliberately mirror
// cli/installer/terminal-ui.sh. The website is a view of the real installer
// choreography; it must not grow a separate, made-up progress language.

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const PROGRESS_WIDTH = 28;
const PROGRESS_TRAIL = 8;

type Frame = {
  hold: number;
  radius: number;
  flash?: boolean;
  showName?: boolean;
  quoteStage?: 0 | 1 | 2;
  progressStage?: -1 | 0 | 1 | 2 | 3 | 4 | 5;
};

const SCRIPT: ReadonlyArray<Frame> = [
  ...Array.from({ length: 10 }, (_, radius) => ({ hold: 95, radius })),
  { hold: 200, radius: 9 },
  { hold: 100, radius: 9, flash: true },
  { hold: 100, radius: 9 },
  { hold: 100, radius: 9, flash: true },
  { hold: 350, radius: 9, showName: true },
  { hold: 300, radius: 9, showName: true, quoteStage: 1 },
  { hold: 840, radius: 9, showName: true, quoteStage: 2 },
  { hold: 550, radius: 9, showName: true, quoteStage: 2, progressStage: 0 },
  { hold: 550, radius: 9, showName: true, quoteStage: 2, progressStage: 1 },
  { hold: 550, radius: 9, showName: true, quoteStage: 2, progressStage: 2 },
  { hold: 550, radius: 9, showName: true, quoteStage: 2, progressStage: 3 },
  { hold: 550, radius: 9, showName: true, quoteStage: 2, progressStage: 4 },
  { hold: 1800, radius: 9, showName: true, quoteStage: 2, progressStage: 5 },
];

const FINAL_FRAME = SCRIPT.length - 1;

export function CliPreview() {
  const { t } = useLang();
  const stageRef = useRef<HTMLDivElement>(null);
  const wasInView = useRef(false);
  const inView = useInView(stageRef, { amount: 0.4 });
  const reduce = useReducedMotion();
  const [frameIndex, setFrameIndex] = useState(0);
  const [spinnerStep, setSpinnerStep] = useState(0);

  const frame = reduce ? SCRIPT[FINAL_FRAME] : SCRIPT[frameIndex];
  const progressStage = frame.progressStage ?? -1;
  const progressLabels = [
    t.cliPhaseResolving,
    t.cliPhaseDownloading,
    t.cliPhaseVerifying,
    t.cliPhaseExtracting,
    t.cliPhaseLinking,
  ];

  useEffect(() => {
    if (inView && !wasInView.current && !reduce) {
      setFrameIndex(0);
      setSpinnerStep(0);
    }
    wasInView.current = inView;
  }, [inView, reduce]);

  useEffect(() => {
    if (reduce || !inView || frameIndex >= FINAL_FRAME) return;
    const id = window.setTimeout(() => {
      setFrameIndex((current) => Math.min(current + 1, FINAL_FRAME));
    }, SCRIPT[frameIndex].hold);
    return () => window.clearTimeout(id);
  }, [frameIndex, inView, reduce]);

  useEffect(() => {
    if (reduce || !inView || progressStage < 0 || progressStage >= 5) return;
    const id = window.setInterval(() => {
      setSpinnerStep((current) => current + 1);
    }, 80);
    return () => window.clearInterval(id);
  }, [inView, progressStage, reduce]);

  const progressHead = spinnerStep % (PROGRESS_WIDTH + PROGRESS_TRAIL);

  return (
    <section className="section cli-preview" id="cli-preview">
      <div className="wrap cli-preview-grid">
        <div className="cli-preview-copy">
          <div className="mono label cli-preview-kicker">
            {t.cliPreviewKicker}
          </div>
          <h2>{renderRich(t.cliPreviewTitle)}</h2>
          <p>{t.cliPreviewBody}</p>
          <InstallBlock />
        </div>

        <div ref={stageRef} className="cli-terminal">
          <div className="cli-terminal-bar">
            <span className="cli-terminal-dots" aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="cli-terminal-title">{t.cliTerminalTitle}</span>
          </div>

          <div className="cli-terminal-body" aria-hidden="true">
            <div className="cli-logo-frame">
              <div
                className="cli-logo"
                style={{ "--cli-logo-cols": CLI_LOGO_COLUMNS } as CSSProperties}
              >
                {CLI_LOGO_ROWS.map((row, index) => {
                  const distance = Math.abs(index - CLI_LOGO_CENTER_ROW);
                  const visible = distance <= frame.radius;
                  const active = visible && distance === frame.radius;
                  const className = [
                    "cli-logo-row",
                    visible ? "is-visible" : "",
                    active ? "is-active" : "",
                    frame.flash ? "is-flash" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <div className={className} key={index}>
                      {cliLogoCells(row).map((cell, column) => (
                        <i data-cell={cell} key={column} />
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>

            <div
              className="cli-logo-name"
              data-visible={frame.showName ? "true" : undefined}
            >
              Shiori CLI
            </div>

            <div className="cli-lyric">
              <div data-visible={(frame.quoteStage ?? 0) >= 1 ? "true" : undefined}>
                <span className="cli-lyric-rule" />
                <span>{t.cliQuoteLine1}</span>
              </div>
              <div data-visible={(frame.quoteStage ?? 0) >= 2 ? "true" : undefined}>
                <span className="cli-lyric-rule" />
                <strong>{t.cliQuoteLine2}</strong>
              </div>
            </div>

            <div
              className="cli-terminal-tagline"
              data-visible={(frame.quoteStage ?? 0) >= 2 ? "true" : undefined}
            >
              {t.cliTerminalTagline}
            </div>

            <div
              className="cli-install-output"
              data-visible={progressStage >= 0 ? "true" : undefined}
            >
              {progressStage === 5 ? (
                <>
                  <div className="cli-installer-complete">
                    <CompleteGlyph />
                    <strong>{t.cliProgressLabel}</strong>
                    <span>{t.cliPhaseComplete}</span>
                  </div>
                  <div className="cli-run-hint">
                    {t.cliRunHint} <strong>shiori --help</strong>
                  </div>
                </>
              ) : (
                <div className="cli-installer-line">
                  <span className="cli-installer-spinner">
                    {SPINNER_FRAMES[spinnerStep % SPINNER_FRAMES.length]}
                  </span>
                  <span className="cli-installer-track">
                    {Array.from({ length: PROGRESS_WIDTH }, (_, index) => {
                      const age = progressHead - index;
                      const active = age >= 0 && age < PROGRESS_TRAIL;
                      const tone = !active
                        ? "empty"
                        : age === 0
                          ? "head"
                          : age <= 2
                            ? "bright"
                            : age <= 5
                              ? "blue"
                              : "dim";
                      return (
                        <i data-tone={tone} key={index}>
                          {active ? "█" : "░"}
                        </i>
                      );
                    })}
                  </span>
                  <strong>{t.cliProgressLabel}</strong>
                  <span className="cli-installer-phase">
                    {progressStage >= 0 ? progressLabels[progressStage] : ""}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// One command, for the machine the reader is on. Listing every platform at
// once was the mistake here: a visitor has one OS, and three stacked boxes
// make them read all three to find theirs. Platform is detected, never asked;
// the choice that remains is HOW to install on that platform, which is what
// the tabs are for. npm is offered on every platform, so a wrong guess still
// leaves a working command on screen.
type InstallMethod = {
  id: string;
  label: string;
  command: string;
  ariaLabel: string;
};

function detectInstallPlatform(): "windows" | "unix" {
  if (typeof navigator === "undefined") return "unix";
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData;
  const platform = (data?.platform ?? navigator.platform ?? "").toLowerCase();
  const agent = navigator.userAgent.toLowerCase();
  if (platform.includes("win") || agent.includes("windows")) return "windows";
  return "unix";
}

function InstallBlock() {
  const { t } = useLang();
  // Read once, on mount. Re-detecting on every render would let a resize or
  // a re-render silently move the reader's selection out from under them.
  const [platform] = useState(detectInstallPlatform);
  const [activeIndex, setActiveIndex] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const shell: InstallMethod =
    platform === "windows"
      ? {
          id: "powershell",
          label: t.cliMethodPowershell,
          command: CLI_INSTALL_POWERSHELL,
          ariaLabel: t.a11yCopyWindowsInstall,
        }
      : {
          id: "curl",
          label: t.cliMethodCurl,
          command: CLI_INSTALL_CURL,
          ariaLabel: t.a11yCopyUnixInstall,
        };
  const methods: InstallMethod[] = [
    shell,
    {
      id: "npm",
      label: t.cliMethodNpm,
      command: CLI_INSTALL_NPM,
      ariaLabel: t.a11yCopyNpmInstall,
    },
  ];
  const platformLabel =
    platform === "windows" ? t.cliInstallWindowsLabel : t.cliInstallUnixLabel;

  // APG tabs: Tab reaches the tablist once, arrows move within it.
  const onTabKeyDown = (event: React.KeyboardEvent) => {
    const last = methods.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = activeIndex === last ? 0 : activeIndex + 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = activeIndex === 0 ? last : activeIndex - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = last;
    }
    if (next === null) return;
    event.preventDefault();
    setActiveIndex(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="cli-install">
      <div
        className="cli-install-tabs"
        role="tablist"
        aria-label={t.a11yInstallMethods}
      >
        <span className="cli-install-kicker">{platformLabel}</span>
        {methods.map((method, index) => (
          <button
            key={method.id}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`cli-install-tab-${method.id}`}
            aria-controls={`cli-install-panel-${method.id}`}
            aria-selected={index === activeIndex}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => setActiveIndex(index)}
            onKeyDown={onTabKeyDown}
          >
            {method.label}
          </button>
        ))}
      </div>
      {/* Every panel is rendered and the inactive ones are `hidden`. Only
          the active one used to exist, which left the other tab's
          aria-controls pointing at an id that was not in the document. */}
      {methods.map((method, index) => (
        <InstallCommand
          key={method.id}
          id={`cli-install-panel-${method.id}`}
          labelledBy={`cli-install-tab-${method.id}`}
          hidden={index !== activeIndex}
          command={method.command}
          copyLabel={t.cliCopy}
          copiedLabel={t.cliCopied}
          failedLabel={t.cliCopyFailed}
          ariaLabel={method.ariaLabel}
        />
      ))}
    </div>
  );
}

function InstallCommand({
  id,
  labelledBy,
  hidden,
  command,
  copyLabel,
  copiedLabel,
  failedLabel,
  ariaLabel,
}: {
  id: string;
  labelledBy: string;
  hidden: boolean;
  command: string;
  copyLabel: string;
  copiedLabel: string;
  failedLabel: string;
  ariaLabel: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2400);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <div
      className="cli-install-command"
      role="tabpanel"
      id={id}
      aria-labelledby={labelledBy}
      hidden={hidden}
    >
      <code>{command}</code>
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setState("copied");
          } catch {
            // Silence here left a reader who denied clipboard access with a
            // button that looked like it had done nothing at all.
            setState("failed");
          }
        }}
      >
        {state === "copied" ? copiedLabel : state === "failed" ? failedLabel : copyLabel}
      </button>
      {/* Rendered empty and always present: a status region inserted at the
          same moment as its text is announced inconsistently. */}
      <span className="sr-only" role="status">
        {state === "copied" ? copiedLabel : state === "failed" ? failedLabel : ""}
      </span>
    </div>
  );
}

function CompleteGlyph() {
  return (
    <svg className="cli-complete" viewBox="0 0 20 20" aria-hidden>
      <path d="m4.5 10.2 3.2 3.2 7.8-7.8" />
    </svg>
  );
}
