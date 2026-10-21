import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { T } from "../../design/tokens";
import { Ic } from "./icons";
import { MiniIconBtn } from "./ui";
import { useAppStore } from "../store/store";
import {
  hideWebPanel,
  openUrlInSystemBrowser,
  openUrlInWebPanel,
  resolveAddressBarInput,
  setWebPanelBounds,
  type WebPanelBounds,
  webPanelBack,
  webPanelForward,
  webPanelReload,
} from "../../platform";

// The last navigation request nonce the Browser panel acted on. Module-level
// (not a ref) so it survives the panel unmounting when the rail is closed:
// reopening the rail then re-shows the still-alive native webview via bounds
// instead of reloading the page. There is only ever one panel instance.
let servedWebPanelNonce = 0;

function sameWebPanelBounds(
  a: WebPanelBounds | null,
  b: WebPanelBounds,
): boolean {
  return (
    !!a &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

// Embedded Browser panel chrome. The web content itself is a native child
// webview owned by Rust that floats over `hostRef`; React only renders the
// address bar / nav controls and keeps the native webview's bounds synced
// to the host element. Switching away from the tab hides (but does not
// destroy) the webview, so the page survives tab switches.
export const BrowserPanel = memo(function BrowserPanel({
  active,
  obscured,
}: {
  active: boolean;
  obscured: boolean;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const url = useAppStore((s) => s.webPanel.url);
  const loading = useAppStore((s) => s.webPanel.loading);
  const canGoBack = useAppStore((s) => s.webPanel.canGoBack);
  const canGoForward = useAppStore((s) => s.webPanel.canGoForward);
  const error = useAppStore((s) => s.webPanel.error);
  const request = useAppStore((s) => s.webPanelRequest);
  const setWebPanel = useAppStore((s) => s.setWebPanel);
  const browserPersistSession = useAppStore((s) => s.prefs.browserPersistSession);
  const openBrowserPanel = useAppStore((s) => s.openBrowserPanel);
  const [copied, setCopied] = useState(false);

  // The native webview is an OS layer with no DOM clipping or stacking, so
  // it must be hidden whenever something should sit above it: a non-browser
  // tab, a rail resize drag (it would otherwise eat the mouse), or any modal
  // overlay (Settings, Export, …).
  const shouldShow = active && !obscured;
  const shouldShowRef = useRef(shouldShow);
  useLayoutEffect(() => {
    shouldShowRef.current = shouldShow;
  }, [shouldShow]);
  const lastReportedBoundsRef = useRef<WebPanelBounds | null>(null);
  const pendingBoundsRafRef = useRef<number | null>(null);

  // Host rect in rounded CSS px (logical), relative to the window content's
  // top-left — exactly what Rust feeds to the child webview's bounds.
  const measure = useCallback(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }, []);

  const flushBounds = useCallback(() => {
    pendingBoundsRafRef.current = null;
    if (!shouldShowRef.current) return;
    const bounds = measure();
    if (!bounds || sameWebPanelBounds(lastReportedBoundsRef.current, bounds)) return;
    lastReportedBoundsRef.current = bounds;
    void setWebPanelBounds(bounds).catch(() => undefined);
  }, [measure]);

  const reportBounds = useCallback(() => {
    if (!shouldShowRef.current || pendingBoundsRafRef.current !== null) return;
    pendingBoundsRafRef.current = requestAnimationFrame(flushBounds);
  }, [flushBounds]);

  // Serve the latest navigation request: create-or-navigate the native
  // webview to the requested URL. Keyed on nonce so Rust echoing the
  // committed URL back never re-navigates, and a tab switch (component stays
  // mounted) doesn't reload the page. We measure inside a rAF so the host
  // has a real rect before the webview is sized — otherwise it would be
  // created at a fallback size and overflow the rail.
  useEffect(() => {
    if (!shouldShow || !request) return;
    if (request.nonce === servedWebPanelNonce) return;
    servedWebPanelNonce = request.nonce;
    const raf = requestAnimationFrame(() => {
      void openUrlInWebPanel(
        request.url,
        measure(),
        browserPersistSession,
      ).catch((err: unknown) => {
        setWebPanel({
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [shouldShow, request, measure, browserPersistSession, setWebPanel]);

  // Pin the webview to the host rect while it should be visible; otherwise
  // hide it (keeping the page alive). Re-runs on each navigation request so
  // a freshly created webview is immediately re-hidden when obscured.
  useEffect(() => {
    if (!shouldShow) {
      lastReportedBoundsRef.current = null;
      if (pendingBoundsRafRef.current !== null) {
        cancelAnimationFrame(pendingBoundsRafRef.current);
        pendingBoundsRafRef.current = null;
      }
      void hideWebPanel().catch(() => undefined);
      return;
    }
    const handle = window.setTimeout(reportBounds, 0);
    const host = hostRef.current;
    let observer: ResizeObserver | null = null;
    if (host) {
      observer = new ResizeObserver(() => reportBounds());
      observer.observe(host);
    }
    const onReflow = () => reportBounds();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.clearTimeout(handle);
      observer?.disconnect();
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
      if (pendingBoundsRafRef.current !== null) {
        cancelAnimationFrame(pendingBoundsRafRef.current);
        pendingBoundsRafRef.current = null;
      }
    };
  }, [shouldShow, request?.nonce, reportBounds]);

  // Closing the rail entirely unmounts the panel — hide the webview so it
  // doesn't float over the canvas.
  useEffect(() => {
    return () => {
      if (pendingBoundsRafRef.current !== null) {
        cancelAnimationFrame(pendingBoundsRafRef.current);
        pendingBoundsRafRef.current = null;
      }
      void hideWebPanel().catch(() => undefined);
    };
  }, []);

  const submitAddress = (raw: string) => {
    const resolved = resolveAddressBarInput(raw);
    if (resolved) openBrowserPanel(resolved);
  };

  const copyLink = () => {
    if (!url) return;
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };

  return (
    <div
      style={{
        padding: "8px 0 0",
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 8px",
        }}
      >
        <span
          aria-hidden="true"
          title={t("browser.title")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            color: T.accent,
            flexShrink: 0,
          }}
        >
          <Ic.globe />
        </span>
        <MiniIconBtn
          title={t("browser.back")}
          disabled={!canGoBack}
          onClick={() => void webPanelBack().catch(() => undefined)}
        >
          <Ic.arrowLeft />
        </MiniIconBtn>
        <MiniIconBtn
          title={t("browser.forward")}
          disabled={!canGoForward}
          onClick={() => void webPanelForward().catch(() => undefined)}
        >
          <Ic.arrowRight />
        </MiniIconBtn>
        <MiniIconBtn
          title={t("browser.reload")}
          onClick={() => void webPanelReload().catch(() => undefined)}
        >
          <Ic.refresh />
        </MiniIconBtn>
        <input
          // Uncontrolled + keyed on the committed URL: the field only
          // resets when navigation commits a new URL (key change), so user
          // typing is never clobbered by nav-state echoes.
          key={url ?? ""}
          defaultValue={url ?? ""}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={t("browser.addressPlaceholder")}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitAddress(e.currentTarget.value);
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.currentTarget.value = url ?? "";
              e.currentTarget.blur();
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            height: 26,
            border: `1px solid ${T.rule}`,
            borderRadius: 6,
            background: T.surface,
            color: T.ink,
            padding: "0 9px",
            font: `12px/1.4 ${T.sans}`,
            outline: "none",
          }}
        />
        <MiniIconBtn
          title={copied ? t("browser.copied") : t("browser.copyLink")}
          disabled={!url}
          onClick={copyLink}
        >
          {copied ? <Ic.check /> : <Ic.copy />}
        </MiniIconBtn>
        <MiniIconBtn
          title={t("browser.openExternal")}
          disabled={!url}
          onClick={() => {
            if (url) void openUrlInSystemBrowser(url).catch(() => undefined);
          }}
        >
          <Ic.external />
        </MiniIconBtn>
      </div>
      <div
        style={{
          height: 2,
          borderRadius: 999,
          background: loading ? T.accent : "transparent",
          transition: "background 160ms ease",
          flex: "0 0 auto",
          margin: "0 8px",
        }}
      />
      <div
        ref={hostRef}
        aria-label={t("browser.title")}
        style={{
          flex: 1,
          minHeight: 240,
          // Full-bleed pane under the address bar — the page runs to the
          // rail's edges like a real browser pane. Only a hairline separates
          // it from the chrome above; the rounded bordered card it used to
          // be was another box inside the rail's box.
          borderTop: `1px solid ${T.rule}`,
          // The native webview floats over this box and paints its own page,
          // but this is what shows before anything loads — and a hardcoded
          // white slab was the one thing in the rail that ignored the theme.
          background: T.surface,
          overflow: "hidden",
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* The native webview floats over this box. The message only shows
            through before any page is loaded or when a load fails. */}
        {error ? (
          <div
            style={{
              padding: "0 24px",
              textAlign: "center",
              color: T.dim,
              font: `12.5px/1.5 ${T.sans}`,
            }}
          >
            {t("browser.loadFailed")}
          </div>
        ) : !url ? (
          <div
            style={{
              padding: "0 24px",
              textAlign: "center",
              color: T.dim,
              font: `12.5px/1.5 ${T.sans}`,
            }}
          >
            {t("browser.empty")}
          </div>
        ) : null}
      </div>
    </div>
  );
});
