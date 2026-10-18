import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { IconBtn, MiniIconBtn } from "./ui";
import { Ic } from "./icons";
import { ShioriTile } from "../../brand/Mark";
import { InkDripStage } from "../../brand/InkDripStage";
import {
  canReopenRecent,
  forgetRecent,
  getRecent,
  hasRecentEntry,
  recentEntryKey,
  type RecentEntry,
} from "../recentDocs";
import {
  canUseWebFileHandles,
  forgetWebFileHandle,
} from "../../storage/recentFileHandles";
import { randomQuoteForLanguage } from "../quotes";
import { useNow } from "../hooks/useNow";
import {
  formatBytes,
  formatRelative,
  relativeLabelsFor,
} from "../../shared/format";
import { CAPABILITIES, IS_TAURI, openExternalUrl } from "../../platform";
import { WINDOW_CAPTION_HEIGHT } from "../../platform/windowCaption";
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from "../../pdf/openPolicy";
import { useAppStore } from "../store/store";
import { isShortcutsHotkey } from "../shortcuts/hotkeys";
import { appVersion } from "../../runtime/version";
import { changeLanguage, type SupportedLanguage } from "../../i18n";
import { resolveEffectiveTheme } from "../../design/theme";
import { useIsMobile } from "../hooks/useIsMobile";
import { toast } from "../toast";
import { FEEDBACK_URL } from "../../shared/links";

type Props = {
  onOpen: (file?: File) => void | Promise<void>;
  onReopen: (entry: RecentEntry) => Promise<boolean>;
  onOpenChangelog: () => void;
};

type TooltipPoint = { x: number; y: number };

export function Landing({ onOpen, onReopen, onOpenChangelog }: Props) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const captionBand = CAPABILITIES.customWindowCaption && !isMobile;
  const [dragging, setDragging] = useState(false);
  const logoRef = useRef<HTMLSpanElement>(null);
  // Subtle opacity mask around the language swap. WebKit on Tauri
  // leaves one-frame glyph residue when a big serif <h1> swaps text;
  // fading the whole Landing out first hides the repaint transition.
  const [langSwapping, setLangSwapping] = useState(false);
  const setShowShortcuts = useAppStore((s) => s.setShowShortcuts);
  const canShowWebHandleRecents = !IS_TAURI && canUseWebFileHandles();
  const canShowCachedRecents = CAPABILITIES.workspaceSourceCache;
  const canShowRecents = CAPABILITIES.nativePaths || canShowWebHandleRecents;

  const switchLanguage = (lng: SupportedLanguage) => {
    if (langSwapping) return;
    if (lng === (i18n.resolvedLanguage ?? i18n.language).slice(0, 2)) return;
    setLangSwapping(true);
    // Let the fade-out paint finish before we mutate the text content.
    window.setTimeout(() => {
      void changeLanguage(lng);
      // Give WebKit one more frame to lay out the new glyphs before
      // we fade back in.
      window.setTimeout(() => setLangSwapping(false), 140);
    }, 140);
  };
  // Read once per mount — Landing unmounts as soon as a file opens, so the
  // next time it appears (via Home) a fresh read picks up the new entry.
  // Drop entries this runtime cannot reopen. Desktop needs a native path;
  // web needs a persisted File System Access handle; mobile can reopen an
  // app-local cache copy. Plain <input> files without those anchors are a trap.
  const [recent, setRecent] = useState<RecentEntry[]>(() => {
    const all = getRecent();
    return all.filter((r) => {
      if (r.path) return canReopenRecent(r, CAPABILITIES.nativePaths);
      if (r.webFileHandleId) {
        return (
          canShowWebHandleRecents &&
          canReopenRecent(r, CAPABILITIES.nativePaths)
        );
      }
      if (r.cacheId) {
        return canReopenRecent(r, false, canShowCachedRecents);
      }
      return false;
    });
  });
  const [recentAccessNeeded, setRecentAccessNeeded] = useState<Set<string>>(
    () => new Set(),
  );
  const now = useNow(60_000);
  const relativeLabels = relativeLabelsFor(i18n.resolvedLanguage ?? i18n.language);
  const quoteLanguage = i18n.resolvedLanguage ?? i18n.language;
  const landingQuote = useMemo(
    () => randomQuoteForLanguage(quoteLanguage),
    [quoteLanguage],
  );

  const openPicker = () => onOpen();
  const removeRecentRow = (entry: RecentEntry) => {
    const key = recentEntryKey(entry);
    setRecent((items) => items.filter((item) => recentEntryKey(item) !== key));
    setRecentAccessNeeded((items) => removeSetItem(items, key));
  };
  const handleReopen = (entry: RecentEntry) => {
    const key = recentEntryKey(entry);
    setRecentAccessNeeded((items) => removeSetItem(items, key));
    void onReopen(entry).then((opened) => {
      if (opened) return;
      if (!hasRecentEntry(entry)) {
        removeRecentRow(entry);
        return;
      }
      if (!IS_TAURI) {
        setRecentAccessNeeded((items) => addSetItem(items, key));
      }
    });
  };
  const openFeedback = () => {
    void openExternalUrl(FEEDBACK_URL).catch(() => {
      toast.error(t("toast.linkOpenFailed"));
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (inInput || !isShortcutsHotkey(e)) return;
      e.preventDefault();
      setShowShortcuts(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setShowShortcuts]);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        // Mobile stacks hero on top, recent list below; desktop keeps
        // the long-standing 60/40 left/right split.
        flexDirection: isMobile ? "column" : "row",
        background: T.paper,
        minHeight: 0,
        // Mobile lets the whole page scroll. Desktop gives each column its
        // own scrollport so a short window or 200% zoom never clips the CTA.
        overflowY: isMobile ? "auto" : "hidden",
        overflowX: "hidden",
        WebkitOverflowScrolling: "touch",
        position: "relative",
        opacity: langSwapping ? 0 : 1,
        transition: "opacity 140ms ease",
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        // This is the handler that actually runs when files are dropped on the
        // home screen, so it has to accept a multi-file drop like the others.
        // Serially: opening claims a generation and the newest claim wins, so
        // firing all of them at once means only the last file survives.
        // A dropped folder shows up as an entry with no file behind it, so
        // the loop below silently did nothing at all — no page, no error, no
        // explanation. There is already a translated string for this; it had
        // never been rendered anywhere.
        const droppedFolder = Array.from(e.dataTransfer?.items ?? []).some(
          (item) =>
            item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory,
        );
        const dropped = Array.from(e.dataTransfer?.files ?? []);
        void (async () => {
          for (const file of dropped) {
            // Per file: one unreadable document must not abandon the rest of
            // the drop. This was the only multi-file entry point without it.
            try {
              await onOpen(file);
            } catch (err) {
              toast.error(
                t("error.unknown.title"),
                `${file.name} · ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          if (droppedFolder && !CAPABILITIES.nativePaths) {
            toast.error(t("documentTree.mountUnsupported"));
          }
        })();
      }}
    >
      {/* A thin invisible strip at the top of the Landing that the OS can
          use as a window drag handle. Without it, Tauri's Overlay title
          bar has nothing draggable and the user can't move the window
          from the home screen. Non-interactive → clicks pass through. */}
      <div
        data-tauri-drag-region
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 36,
          zIndex: 1,
          pointerEvents: "auto",
        }}
      />
      <section
        data-landing-hero
        data-landing-safe-area={isMobile ? "top inline" : undefined}
        style={{
          flex: isMobile ? "0 0 auto" : "1 1 60%",
          // Single `padding` shorthand on both branches. An earlier
          // version layered `paddingTop: undefined` on top of the
          // shorthand for the desktop case, which React serializes by
          // clearing the longhand to 0 — that pushed the brand mark
          // flush against the window's top edge / Tauri title bar.
          padding: isMobile
            ? "calc(32px + var(--shiori-safe-top, 0px)) calc(22px + var(--shiori-safe-right, 0px)) 28px calc(22px + var(--shiori-safe-left, 0px))"
            : "clamp(40px, 6vw, 112px) clamp(32px, 5vw, 96px)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          minWidth: 0,
          position: "relative",
          minHeight: 0,
          // The root already clips horizontal decoration on mobile. Keeping
          // this axis visible avoids CSS coercing overflow-y:visible to auto
          // and accidentally creating a nested phone scrollport.
          overflowX: isMobile ? "visible" : "hidden",
          overflowY: isMobile ? "visible" : "auto",
          overscrollBehavior: isMobile ? "auto" : "contain",
          scrollbarGutter: isMobile ? "auto" : "stable",
          // The column divider moves here when the recent panel carries the
          // caption band (below): a 1px left border meeting a 48px top
          // border would miter into a fading diagonal.
          borderRight: captionBand ? `1px solid ${T.rule}` : undefined,
        }}
      >
        <InkDripStage sourceRef={logoRef} />
        <div style={{ position: "relative", zIndex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              marginBottom: 4,
            }}
          >
            <span ref={logoRef} style={{ display: "inline-flex" }}>
              <ShioriTile size={36} radius={0.22} />
            </span>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 12,
              }}
            >
              <span
                style={{
                  fontFamily: T.klee,
                  fontWeight: 600,
                  fontSize: 28,
                  lineHeight: 1,
                  color: T.ink,
                }}
              >
                Shiori
              </span>
              <span
                style={{
                  fontFamily: T.mono,
                  fontWeight: 500,
                  fontSize: 12,
                  lineHeight: 1,
                  color: T.dim,
                  letterSpacing: ".22em",
                  textTransform: "lowercase",
                }}
              >
                しおり
              </span>
            </div>
          </div>
          {/* No eyebrow line — the headline carries the message on its own.
              The top gap that separated it from the logo row lives on the
              <h1> directly. */}
          <h1
            style={{
              font: `${T.displayStyle} ${
                isMobile
                  ? "clamp(34px, 9vw, 44px)"
                  : "clamp(44px, 5.5vw, 80px)"
              }/0.98 ${T.serif}`,
              color: T.ink,
              letterSpacing: "-.025em",
              margin: isMobile
                ? "28px 0 18px"
                : "clamp(44px, 5.5vw, 72px) 0 clamp(22px, 2.2vw, 28px)",
              maxWidth: "22ch",
            }}
          >
            {t("landing.heroLine1")}
            <br />
            {/* The whole second line is the accent clause; it wraps naturally
                within the headline's max width. */}
            <span style={{ color: T.accentText }}>
              {t("landing.heroAccent")}
            </span>
          </h1>
          <div
            data-landing-open-zone
            onClick={openPicker}
            style={{
              position: "relative",
              marginTop: 36,
              padding: "28px 30px",
              border: `1.5px dashed ${dragging ? T.ink : T.soft}`,
              background: dragging ? T.cream : "transparent",
              borderRadius: 4,
              cursor: "pointer",
              transition:
                "background-color 150ms ease, border-color 150ms ease",
              display: "flex",
              alignItems: "center",
              gap: 22,
              maxWidth: 640,
              flexWrap: "wrap",
            }}
          >
            {/* 栞 mark: a page with a bookmark ribbon tucked over its top
                edge. Reads as "document" for any of PDF / Markdown / HTML —
                no format label baked in — while the accent ribbon nods to
                the name (栞 = bookmark). Line-art to match the rest of the
                icon set (round joins, ink stroke), accent spent only on the
                ribbon. */}
            <svg
              width="50"
              height="57"
              viewBox="0 0 56 64"
              fill="none"
              aria-hidden="true"
              style={{ display: "block", flex: "0 0 auto" }}
            >
              <path
                d="M8 9 H48 V55 H8 Z"
                fill={T.surface}
                stroke={T.ink}
                strokeWidth={1.8}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <g stroke={T.soft} strokeWidth={1.6} strokeLinecap="round">
                <line x1="15" y1="35" x2="37" y2="35" />
                <line x1="15" y1="41" x2="37" y2="41" />
                <line x1="15" y1="47" x2="30" y2="47" />
              </g>
              <path
                d="M33 5 H41 V27 L37 22.5 L33 27 Z"
                fill={T.accent}
                stroke={T.accent}
                strokeWidth={1.2}
                strokeLinejoin="round"
              />
            </svg>
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <div style={{ font: `${T.displayStyle} 20px/1.2 ${T.serif}`, color: T.ink }}>
                {dragging
                  ? t("landing.dropTitleActive")
                  : t("landing.dropTitleIdle")}
              </div>
              <div
                style={{
                  font: `13px/1.5 ${T.sans}`,
                  color: T.dim,
                  marginTop: 2,
                }}
              >
                {t("landing.dropHint", {
                  maxSize: formatBytes(MAX_PDF_BYTES),
                  maxPages: MAX_PDF_PAGES,
                })}
              </div>
            </div>
            <IconBtn tone="primary">{t("landing.openFile")}</IconBtn>
          </div>
          {recent[0] ? (
            <div style={{ marginTop: 12 }}>
              <IconBtn
                tone="outline"
                onClick={() => handleReopen(recent[0]!)}
              >
                {t("landing.continueLast")}
              </IconBtn>
            </div>
          ) : null}
          {/* Value props — four short trust signals (`landing.valueProps.*`),
              authored long ago but never rendered. A quiet reinforcement
              strip under the CTA rather than another paragraph of prose. */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "10px 22px",
              marginTop: 30,
            }}
          >
            {(["offline", "noSignin", "keyboard", "oss"] as const).map(
              (key) => (
                <span
                  key={key}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    font: `500 13px/1 ${T.sans}`,
                    color: T.ink2,
                  }}
                >
                  <Ic.check
                    width={13}
                    height={13}
                    style={{ color: T.accent, flex: "0 0 auto" }}
                  />
                  {t(`landing.valueProps.${key}`)}
                </span>
              ),
            )}
          </div>
        </div>
      </section>

      <section
        data-landing-recent-panel
        data-landing-safe-area={isMobile ? "inline bottom" : undefined}
        aria-labelledby="landing-recent-heading"
        style={{
          flex: isMobile ? "0 0 auto" : "1 1 40%",
          background: T.cream,
          // Border flips from the left edge (desktop column divider)
          // to the top edge (mobile horizontal divider) so the recent
          // section reads as a separate band stacked under the hero.
          borderLeft: isMobile || captionBand ? "none" : `1px solid ${T.rule}`,
          // Windows caption buttons sit over this panel's top-right corner.
          // A top border is outside the scrollport, so a band in the panel's
          // own colour keeps both the recent list and its scrollbar from
          // sliding under the buttons, and still reads as one surface.
          borderTop: isMobile
            ? `1px solid ${T.rule}`
            : captionBand
              ? `${WINDOW_CAPTION_HEIGHT}px solid ${T.cream}`
              : "none",
          padding: isMobile
            ? "26px calc(22px + var(--shiori-safe-right, 0px)) calc(28px + var(--shiori-safe-bottom, 0px)) calc(22px + var(--shiori-safe-left, 0px))"
            : captionBand
              ? // The top padding gives back what the caption band above
                // already spends, keeping at least a little air under it.
                `max(12px, calc(clamp(40px, 6vw, 112px) - ${WINDOW_CAPTION_HEIGHT}px)) clamp(32px, 4vw, 80px) clamp(40px, 6vw, 112px)`
              : "clamp(40px, 6vw, 112px) clamp(32px, 4vw, 80px)",
          minWidth: 0,
          minHeight: 0,
          // Mobile lets the outer container handle scroll — leaving an
          // inner scroll region here would trap the locale quote off-
          // screen on phones.
          overflowY: isMobile ? "visible" : "auto",
          overflowX: isMobile ? "visible" : "hidden",
          overscrollBehavior: isMobile ? "auto" : "contain",
          scrollbarGutter: isMobile ? "auto" : "stable",
          WebkitOverflowScrolling: "touch",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div data-landing-recent-list>
          <h2
            id="landing-recent-heading"
            style={{
              font: `500 11px/1 ${T.mono}`,
              color: T.dim,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              margin: "0 0 20px",
            }}
          >
            {t("landing.recentHeader")}
          </h2>
          {recent.length === 0 ? (
            <div
              style={{
                font: `15px/1.55 ${T.bodySerif}`,
                color: T.dim,
                padding: "18px 0",
                borderTop: `1px solid ${T.rule}`,
                borderBottom: `1px solid ${T.rule}`,
              }}
            >
              {t(
                !IS_TAURI && !canShowRecents
                  ? "landing.recentUnsupported"
                  : "landing.recentEmpty",
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {recent.map((r, i) => (
                <RecentRow
                  key={`${r.name}-${r.savedAt}`}
                  entry={r}
                  first={i === 0}
                  now={now}
                  labels={relativeLabels}
                  needsAccess={recentAccessNeeded.has(recentEntryKey(r))}
                  onClick={() => handleReopen(r)}
                  onForget={() => {
                    forgetRecent(r);
                    void forgetWebFileHandle(r.webFileHandleId);
                    removeRecentRow(r);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Quote and utility controls are one normal-flow metadata block.
            `marginTop:auto` keeps it at the bottom when the recent list is
            short; when the window is short or the list is long it scrolls
            naturally after the documents instead of covering them. */}
        <div
          data-landing-metadata
          style={{
            marginTop: "auto",
            paddingTop: "clamp(26px, 5vh, 52px)",
          }}
        >
          <blockquote
            data-landing-quote
            style={{
              font: `14.5px/1.55 ${T.bodySerif}`,
              color: T.dim,
              margin: 0,
              borderLeft: `2px solid ${T.soft}`,
              paddingLeft: 14,
            }}
          >
            <p style={{ margin: 0 }}>{landingQuote.text}</p>
            <cite
              style={{
                display: "block",
                marginTop: 6,
                font: `500 11.5px/1.35 ${T.mono}`,
                color: T.dim2,
                letterSpacing: ".03em",
                fontStyle: "normal",
              }}
            >
              — {landingQuote.attribution}
            </cite>
          </blockquote>

          <footer
            data-landing-footer
            style={{
              marginTop: 22,
              paddingTop: 14,
              borderTop: `1px solid ${T.rule}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "10px 16px",
              minWidth: 0,
              font: `500 11px/1 ${T.mono}`,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: T.dim,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flex: "0 0 auto",
              }}
            >
              <ThemeToggle touchSized={isMobile} />
              <LanguagePicker
                onSwitch={switchLanguage}
                touchSized={isMobile}
              />
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: isMobile ? "flex-start" : "flex-end",
                flexWrap: "wrap",
                gap: "2px 8px",
                flex: "1 1 220px",
                minWidth: 0,
              }}
            >
              {!isMobile ? (
                <LandingFooterAction
                  onClick={() => setShowShortcuts(true)}
                  title={t("landing.footer.shortcuts")}
                  touchSized={false}
                >
                  {t("landing.footer.shortcuts")}
                </LandingFooterAction>
              ) : null}
              <LandingFooterAction
                onClick={openFeedback}
                title={t("landing.footer.feedbackTitle")}
                touchSized={isMobile}
              >
                {t("landing.footer.feedback")}
              </LandingFooterAction>
              <LandingFooterAction
                onClick={onOpenChangelog}
                touchSized={isMobile}
              >
                {t("landing.footer.version", { version: appVersion })}
              </LandingFooterAction>
            </div>
          </footer>
        </div>
      </section>
    </div>
  );
}

function LandingFooterAction({
  children,
  onClick,
  title,
  touchSized,
}: {
  children: string;
  onClick: () => void;
  title?: string;
  touchSized: boolean;
}) {
  return (
    <button
      className="shioriLandingFooterAction"
      type="button"
      onClick={onClick}
      title={title}
      style={{
        minHeight: touchSized ? 44 : 32,
        border: "none",
        background: "transparent",
        padding: "0 7px",
        borderRadius: 6,
        color: "inherit",
        font: "inherit",
        letterSpacing: "inherit",
        textTransform: "inherit",
        whiteSpace: "nowrap",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// Language picker — one compact Lucide control. Clicking toggles a
// small popover with the three language names (English / 简体中文 /
// 日本語). Menu dismisses on outside click or ESC. The active row
// highlights in accent. Collapsing three inline glyphs into one icon
// cleans up the landing footer and leaves the row uncluttered.
function LanguagePicker({
  onSwitch,
  touchSized,
}: {
  onSwitch: (lng: SupportedLanguage) => void;
  touchSized: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerPointerDownRef = useRef(false);
  const active = (i18n.resolvedLanguage ?? i18n.language ?? "en")
    .toLowerCase()
    .slice(0, 2) as SupportedLanguage;

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
    };
  }, [open]);

  // Clamp the popover to the viewport. The launcher sits in the middle of a
  // right-anchored footer pill, so a naive right:0 popover can run off the
  // LEFT edge on a narrow phone. Measure after it opens and nudge it via an
  // imperative transform (no extra render) so neither edge clips. Runs in a
  // layout effect so there's no visible jump.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!open || !el) return;
    el.style.transform = "";
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    let dx = 0;
    if (rect.left < margin) dx = margin - rect.left;
    else if (rect.right > viewportWidth - margin)
      dx = viewportWidth - margin - rect.right;
    if (dx) el.style.transform = `translateX(${dx}px)`;
    el.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  const restoreTriggerFocus = () => {
    triggerRef.current?.focus({ preventScroll: true });
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      restoreTriggerFocus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]',
      ) ?? [],
    );
    if (!items.length) return;
    const current = Math.max(
      0,
      items.indexOf(document.activeElement as HTMLButtonElement),
    );
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    for (const [index, item] of items.entries()) {
      item.tabIndex = index === next ? 0 : -1;
    }
    items[next]?.focus();
  };

  const entries: Array<{
    lng: SupportedLanguage;
    label: string;
    tag: string;
  }> = [
    { lng: "en", label: "English", tag: "EN" },
    { lng: "zh", label: "简体中文", tag: "ZH" },
    { lng: "ja", label: "日本語", tag: "JA" },
  ];

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={triggerRef}
        className="shioriLandingSystemButton"
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("settings.language")}
        aria-label={t("settings.language")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "landing-language-menu" : undefined}
        onPointerDown={() => {
          triggerPointerDownRef.current = true;
        }}
        onPointerUp={() => {
          triggerPointerDownRef.current = false;
        }}
        onPointerCancel={() => {
          triggerPointerDownRef.current = false;
        }}
        onBlur={() => {
          triggerPointerDownRef.current = false;
        }}
        style={{
          width: touchSized ? 44 : 32,
          height: touchSized ? 44 : 32,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: `1px solid ${open ? T.accent : T.rule}`,
          background: open ? T.accentGhost : T.surface,
          borderRadius: 8,
          color: open ? T.accentText : T.dim,
          cursor: "pointer",
          padding: 0,
        }}
      >
        <Ic.language width={16} height={16} />
      </button>
      {open ? (
        <div
          id="landing-language-menu"
          ref={menuRef}
          role="menu"
          aria-label={t("settings.language")}
          onKeyDown={onMenuKeyDown}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (
              next instanceof window.Node &&
              event.currentTarget.contains(next)
            ) {
              return;
            }
            // Pointer focus reaches the trigger before its click. Keep the
            // menu mounted for that click to toggle closed; keyboard focus
            // leaving the composite closes immediately.
            if (
              next === triggerRef.current &&
              triggerPointerDownRef.current
            ) {
              return;
            }
            setOpen(false);
          }}
          style={{
            position: "absolute",
            right: 0,
            bottom: "calc(100% + 8px)",
            minWidth: 160,
            maxWidth: "calc(100vw - 16px)",
            boxSizing: "border-box",
            background: T.surface,
            border: `1px solid ${T.rule}`,
            borderRadius: 10,
            boxShadow:
              "0 10px 30px -8px rgba(10,14,24,0.18), 0 2px 6px rgba(10,14,24,0.05)",
            padding: 6,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            zIndex: 40,
          }}
        >
          {entries.map((e) => {
            const isActive = e.lng === active;
            return (
              <button
                key={e.lng}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                tabIndex={isActive ? 0 : -1}
                onClick={() => {
                  onSwitch(e.lng);
                  setOpen(false);
                  restoreTriggerFocus();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  border: "none",
                  background: isActive ? T.accentGhost : "transparent",
                  padding: "8px 10px",
                  minHeight: touchSized ? 44 : 32,
                  borderRadius: 6,
                  font: `500 13px/1 ${T.sans}`,
                  color: isActive ? T.accentText : T.ink,
                  letterSpacing: 0,
                  textTransform: "none",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(ev) => {
                  if (!isActive) {
                    ev.currentTarget.style.background = T.hoverTint;
                  }
                }}
                onMouseLeave={(ev) => {
                  if (!isActive) {
                    ev.currentTarget.style.background = "transparent";
                  }
                }}
              >
                <span>{e.label}</span>
                <span
                  style={{
                    font: `500 10.5px/1 ${T.mono}`,
                    color: isActive ? T.accentText : T.dim,
                    letterSpacing: ".06em",
                  }}
                >
                  {e.tag}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// Light / dark toggle. Click switches explicitly between Light and
// Dark — if the user is on Auto, we flip to the opposite of whatever
// the system is resolving to right now (so the click always feels
// like it "did something"). A user who wants Auto back can set it in
// Settings; this button is the quick one-tap for people who know
// which mode they want. The Lucide icon previews the mode the action will
// switch to, matching the localized accessible name.
function ThemeToggle({ touchSized }: { touchSized: boolean }) {
  const { t } = useTranslation();
  const colorMode = useAppStore((s) => s.prefs.colorMode);
  const setPrefs = useAppStore((s) => s.setPrefs);
  const effective = resolveEffectiveTheme(colorMode);
  const toggle = () => {
    const next = effective === "dark" ? "Light" : "Dark";
    // Flip the transient transition class on <html> so every element
    // that uses a theme token transitions its colour for ~320ms around
    // the swap. Removed after the transition completes so normal hover
    // transitions stay snappy.
    const root = document.documentElement;
    root.classList.add("theme-transitioning");
    setPrefs({ colorMode: next });
    window.setTimeout(() => {
      root.classList.remove("theme-transitioning");
    }, 360);
  };
  const isDark = effective === "dark";
  return (
    <button
      className="shioriLandingSystemButton"
      type="button"
      onClick={toggle}
      // Landing is the first screen the app opens on, and this literal was
      // also the aria-label — so zh/ja users heard an English button name.
      title={
        isDark ? t("landing.themeToggleToLight") : t("landing.themeToggleToDark")
      }
      aria-label={
        isDark ? t("landing.themeToggleToLight") : t("landing.themeToggleToDark")
      }
      style={{
        width: touchSized ? 44 : 32,
        height: touchSized ? 44 : 32,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1px solid ${T.rule}`,
        background: T.surface,
        borderRadius: 8,
        color: T.dim,
        cursor: "pointer",
        padding: 0,
      }}
    >
      {isDark ? (
        <Ic.sun width={16} height={16} />
      ) : (
        <Ic.moon width={16} height={16} />
      )}
    </button>
  );
}

// Recent-document thumbnail. 60×78 mini page with a title bar, a
// few content lines, one highlight band. Just enough signal to read
// as a preview; not a real PDF render. Once real thumbnail capture
// lands (pdf.js offscreen canvas → IndexedDB), this becomes the
// fallback for documents without a captured thumbnail.
function RecentThumb() {
  return (
    <div
      style={{
        width: 76,
        height: 98,
        background: `linear-gradient(180deg, ${T.surface} 0%, ${T.cream} 100%)`,
        border: `1px solid ${T.ruleSoft}`,
        borderRadius: 4,
        padding: "8px 9px",
        display: "flex",
        flexDirection: "column",
        gap: 2.5,
        overflow: "hidden",
        flex: "0 0 auto",
        boxShadow: "0 1px 2px rgba(10,14,24,0.04)",
      }}
    >
      <div
        style={{
          height: 3.5,
          width: "65%",
          background: T.ink2,
          borderRadius: 1,
          marginBottom: 4,
        }}
      />
      {[92, 80, 86, 72].map((w, i) => (
        <div
          key={`a${i}`}
          style={{
            height: 1.6,
            width: `${w}%`,
            background: T.soft,
            borderRadius: 1,
          }}
        />
      ))}
      <div
        style={{
          height: 3.5,
          width: "55%",
          background: T.highlightSoft,
          borderRadius: 1,
        }}
      />
      {[68, 76, 60].map((w, i) => (
        <div
          key={`b${i}`}
          style={{
            height: 1.6,
            width: `${w}%`,
            background: T.soft,
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}

// Recents thumbnail stand-in for text documents, which have no page render.
// HTML renders its stored markup in a scaled, sandboxed, remote-blocked
// iframe so the thumbnail looks like the rendered page; Markdown shows a tiny
// Finder-style text excerpt. Both carry a small kind tag, and fall back to
// just the tag when nothing was stored (older entries).
function KindThumb({
  kind,
  preview,
  htmlPreview,
}: {
  kind: "markdown" | "html";
  preview?: string;
  htmlPreview?: string;
}) {
  return (
    <div
      style={{
        width: 76,
        height: 98,
        background:
          kind === "html" && htmlPreview
            ? "#fff"
            : `linear-gradient(180deg, ${T.surface} 0%, ${T.cream} 100%)`,
        border: `1px solid ${T.ruleSoft}`,
        borderRadius: 4,
        flex: "0 0 auto",
        boxShadow: "0 1px 2px rgba(10,14,24,0.04)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {kind === "html" && htmlPreview ? (
        <iframe
          aria-hidden
          title=""
          tabIndex={-1}
          scrolling="no"
          // sandbox="" = no scripts, no same-origin; the embedded CSP blocks
          // every remote load so the preview is static and private.
          sandbox=""
          srcDoc={`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline' data:; font-src data:;"><base target="_blank">${htmlPreview}`}
          style={{
            width: 600,
            height: 774,
            border: 0,
            transform: "scale(0.1267)",
            transformOrigin: "top left",
            pointerEvents: "none",
            background: "#fff",
          }}
        />
      ) : preview ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            padding: "7px 7px 14px",
            font: `5px/1.65 ${T.mono}`,
            color: T.ink2,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflow: "hidden",
          }}
        >
          {preview}
        </div>
      ) : null}
      <span
        style={{
          position: "absolute",
          bottom: 4,
          right: 4,
          font: `700 7px/1 ${T.mono}`,
          color: T.dim,
          background: T.surface,
          border: `1px solid ${T.ruleSoft}`,
          borderRadius: 2,
          padding: "1px 3px",
          letterSpacing: ".06em",
        }}
      >
        {kind === "markdown" ? "MD" : "HTML"}
      </span>
    </div>
  );
}

// PDFs only — the extension is redundant and makes long names fight
// for column width. Strip a trailing `.pdf` (case-insensitive) before
// rendering; RecentRow provides a full-name hover tooltip for disambiguation.
function FilenameLine({ name }: { name: string }) {
  const display = name.replace(/\.pdf$/i, "");
  return (
    <div
      style={{
        font: `500 15.5px/1.3 ${T.sans}`,
        color: T.ink,
        letterSpacing: "-.005em",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {display}
    </div>
  );
}

function RecentRow({
  entry,
  first,
  now,
  labels,
  needsAccess,
  onClick,
  onForget,
}: {
  entry: RecentEntry;
  first: boolean;
  now: number;
  labels: import("../../shared/format").RelativeLabels;
  needsAccess: boolean;
  onClick: () => void;
  onForget: () => void;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const [tooltipAt, setTooltipAt] = useState<TooltipPoint | null>(null);
  const tooltipPosition = tooltipAt ? placeTooltip(tooltipAt) : null;
  // Rules live on the outer shell, the hover wash lives on an inset
  // inner block with rounded corners. Without the split, hover draws a
  // rectangle edge-to-edge with the rules and reads as a hard chopped
  // slab instead of a soft highlight.
  return (
    <div
      style={{
        borderTop: first ? `1px solid ${T.rule}` : "none",
        borderBottom: `1px solid ${T.rule}`,
        padding: "4px 0",
      }}
    >
      <div
        onMouseEnter={(e) => {
          setHover(true);
          setTooltipAt({ x: e.clientX, y: e.clientY });
        }}
        onMouseMove={(e) => setTooltipAt({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => {
          setHover(false);
          setTooltipAt(null);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "8px 10px",
          margin: "0 -10px",
          borderRadius: 8,
          cursor: "pointer",
          background: hover ? T.hoverTint : "transparent",
          transition: "background .12s",
        }}
      >
        <button
          type="button"
          onClick={onClick}
          aria-label={entry.name}
          style={{
            appearance: "none",
            border: "none",
            padding: 0,
            margin: 0,
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 14,
            flex: 1,
            minWidth: 0,
            textAlign: "left",
          }}
        >
          {tooltipPosition ? (
            <div
              style={{
                position: "fixed",
                left: tooltipPosition.left,
                top: tooltipPosition.top,
                maxWidth: tooltipPosition.maxWidth,
                zIndex: 100,
                padding: "7px 9px",
                borderRadius: 4,
                background: T.ink,
                color: T.paper,
                boxShadow: "0 10px 24px rgba(20,16,10,0.18)",
                font: `500 12.5px/1.35 ${T.sans}`,
                overflowWrap: "anywhere",
                pointerEvents: "none",
                boxSizing: "border-box",
              }}
            >
              {entry.name}
            </div>
          ) : null}
          {entry.thumb ? (
            <img
              src={entry.thumb}
              alt=""
              loading="lazy"
              draggable={false}
              style={{
                width: 76,
                height: 98,
                objectFit: "cover",
                objectPosition: "top",
                border: `1px solid ${T.ruleSoft}`,
                borderRadius: 4,
                background: T.surface,
                flex: "0 0 auto",
                boxShadow: "0 1px 2px rgba(10,14,24,0.04)",
                userSelect: "none",
              }}
            />
          ) : entry.kind === "markdown" || entry.kind === "html" ? (
            <KindThumb
              kind={entry.kind}
              preview={entry.textPreview}
              htmlPreview={entry.htmlPreview}
            />
          ) : (
            <RecentThumb />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <FilenameLine name={entry.name} />
            <div
              style={{
                font: `12.5px/1.4 ${T.mono}`,
                color: T.dim,
                letterSpacing: ".02em",
                marginTop: 5,
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span>
                {entry.kind === "markdown"
                  ? "Markdown"
                  : entry.kind === "html"
                    ? "HTML"
                    : t("landing.recentPages", { count: entry.pages })}{" "}
                · {formatBytes(entry.size)}
              </span>
              {needsAccess ? (
                <span
                  title={t("landing.recentNeedsAccessHint")}
                  style={{
                    color: T.accentText,
                    background: T.accentGhost,
                    border: `1px solid ${T.accentSoft}`,
                    borderRadius: 999,
                    padding: "1px 6px",
                    lineHeight: 1.3,
                  }}
                >
                  {t("landing.recentNeedsAccess")}
                </span>
              ) : null}
            </div>
          </div>
          <div
            style={{
              textAlign: "right",
              font: `500 12px/1.4 ${T.mono}`,
              color: T.dim,
              letterSpacing: ".02em",
              fontVariantNumeric: "tabular-nums",
              flex: "0 0 auto",
              // Fixed column so "刚刚" / "2 min ago" / "3 小时前" all
              // right-align at the same x across every row — gives the
              // list the grid feel it was missing.
              width: 88,
            }}
          >
            {formatRelative(entry.savedAt, now, labels)}
          </div>
        </button>
        <MiniIconBtn
          title={t("landing.forgetRecent")}
          onClick={(e) => {
            e.stopPropagation();
            onForget();
          }}
        >
          <Ic.x />
        </MiniIconBtn>
      </div>
    </div>
  );
}

function placeTooltip(point: TooltipPoint) {
  const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
  const maxWidth = Math.min(420, Math.max(220, viewportWidth - 32));
  return {
    left: Math.max(16, Math.min(point.x + 14, viewportWidth - maxWidth - 16)),
    top: Math.max(16, Math.min(point.y + 16, viewportHeight - 96)),
    maxWidth,
  };
}

function addSetItem(items: Set<string>, key: string): Set<string> {
  if (items.has(key)) return items;
  const next = new Set(items);
  next.add(key);
  return next;
}

function removeSetItem(items: Set<string>, key: string): Set<string> {
  if (!items.has(key)) return items;
  const next = new Set(items);
  next.delete(key);
  return next;
}
