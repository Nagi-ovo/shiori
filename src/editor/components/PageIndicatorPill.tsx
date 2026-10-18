import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { useEditorStore } from "../store/store";
import { useIsMobile } from "../hooks/useIsMobile";
import {
  getFloatingInspectorBottomInset,
  pagePillBottom,
  subscribeFloatingInspectorBottomInset,
} from "./floatingInspectorLayout";

/**
 * The phone stand-in for the status bar's page readout.
 *
 * "Page 04 / 11" is the one item of the old bar that is genuinely standing
 * state, but it is only wanted while the reader is moving through the
 * document — so it floats over the page during a scroll and gets out of the
 * way again, instead of holding a permanent 28px row open for it.
 */

// How long the pill lingers after the last scroll tick. Long enough to read
// once a flick has settled, short enough that it never becomes furniture.
export const PAGE_PILL_LINGER_MS = 1200;
const PAGE_PILL_FADE_MS = 200;

export function PageIndicatorPill() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const pages = useEditorStore((s) => s.model.pages);
  const activePageId = useEditorStore((s) => s.activePageId);
  const [visible, setVisible] = useState(false);
  // The floating inspector takes the same bottom edge when it is showing.
  // It is the interactive one, so the pill rides above it rather than
  // covering its controls.
  const inspectorInset = useSyncExternalStore(
    subscribeFloatingInspectorBottomInset,
    getFloatingInspectorBottomInset,
  );

  useEffect(() => {
    if (!isMobile) return;
    let timer: number | null = null;
    const onScroll = (event: Event) => {
      const target = event.target;
      // Only the document's own scroller. Scroll events do not bubble, but
      // they do capture — so a window listener otherwise also hears the
      // thumbnail rail, the outline panel and any open dialog, none of
      // which turn a page.
      if (!(target instanceof HTMLElement)) return;
      if (!target.hasAttribute("data-shiori-pdf-scroller")) return;
      // React bails out when the value is unchanged, so a fling costs one
      // commit at its start and one at its end, not one per frame.
      setVisible(true);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setVisible(false), PAGE_PILL_LINGER_MS);
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [isMobile]);

  if (!isMobile || pages.length === 0) return null;

  const pageIdx = Math.max(
    0,
    pages.findIndex((page) => page.id === activePageId),
  );

  return (
    <div
      className="shioriPrintHide"
      data-shiori-page-pill
      // Transient, duplicated by the page folio in the document itself, and
      // it would re-announce on every flick. Nothing here for a reader.
      aria-hidden
      style={{
        position: "fixed",
        left: "50%",
        bottom: pagePillBottom(inspectorInset),
        transform: "translateX(-50%)",
        // Under the floating inspector (43) — a transient readout must never
        // land on top of live controls — and under the mobile drawer scrim
        // (44) so an open navigator dims it with the rest of the document.
        zIndex: 42,
        pointerEvents: "none",
        padding: "6px 12px",
        borderRadius: 999,
        background: T.cream,
        border: `1px solid ${T.rule}`,
        color: T.ink2,
        boxShadow: "0 6px 18px rgba(20,16,10,0.16)",
        font: `500 11px/1 ${T.mono}`,
        letterSpacing: ".04em",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        opacity: visible ? 1 : 0,
        // app.css snaps every transition under prefers-reduced-motion.
        transition: `opacity ${PAGE_PILL_FADE_MS}ms ease`,
      }}
    >
      {t("meta.pageOfTotal", {
        page: String(pageIdx + 1).padStart(2, "0"),
        total: String(pages.length).padStart(2, "0"),
      })}
    </div>
  );
}
