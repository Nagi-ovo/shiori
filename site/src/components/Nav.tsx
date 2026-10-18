import { useEffect, useRef, useState } from "react";
import { useLang } from "../i18n/context";
import { useRelease } from "../release/context";
import { Brand } from "./Brand";

const RELEASES_URL = "https://github.com/Nagi-ovo/shiori-releases";

export function Nav() {
  const { t } = useLang();
  const release = useRelease();
  const [open, setOpen] = useState(false);

  const close = () => setOpen(false);
  const headerRef = useRef<HTMLElement>(null);

  // Dismiss on outside click and on Escape, the same treatment Chrome.tsx
  // gives its popover. Without it the mobile menu could only be closed by
  // pressing the burger again.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!headerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const versionLabel = release ? `V ${release.version} · BETA` : "BETA";

  return (
    <header className="nav" ref={headerRef}>
      <div className="wrap nav-row">
        <Brand />
        <nav id="nav-links" className={open ? "nav-links open" : "nav-links"}>
          <a href="#features" onClick={close}>
            {t.navFeatures}
          </a>
          <a href="#specs" onClick={close}>
            {t.navSpecs}
          </a>
          <a href="#download" onClick={close}>
            {t.navDownload}
          </a>
          <span className="ver">{versionLabel}</span>
          <a
            className="nav-icon-link"
            href={RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t.a11yGithubReleases}
            title={t.a11yGithubReleases}
            onClick={close}
          >
            <GitHubIcon />
          </a>
          <a className="nav-cta" href="#download" onClick={close}>
            <span>{t.navCta}</span>
          </a>
        </nav>
        <button
          type="button"
          className="nav-burger"
          // Without aria-expanded a screen reader announced "Menu, button"
          // whether the panel was open or closed — the state was never
          // conveyed. Chrome.tsx already does this for its own popover.
          aria-label={t.a11yMenu}
          aria-expanded={open}
          aria-controls="nav-links"
          onClick={() => setOpen((v) => !v)}
        >
          <span />
          <span />
          <span />
        </button>
      </div>
    </header>
  );
}

function GitHubIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 0C3.58 0 0 3.66 0 8.18c0 3.61 2.29 6.67 5.47 7.75.4.08.55-.18.55-.4v-1.4c-2.23.5-2.7-.98-2.7-.98-.36-.94-.89-1.19-.89-1.19-.73-.51.06-.5.06-.5.8.06 1.23.85 1.23.85.72 1.26 1.88.9 2.34.69.07-.53.28-.9.51-1.1-1.78-.2-3.64-.91-3.64-4.04 0-.9.31-1.62.83-2.2-.08-.2-.36-1.02.08-2.16 0 0 .68-.22 2.2.84A7.4 7.4 0 0 1 8 4.07c.68 0 1.36.09 2 .27 1.52-1.06 2.2-.84 2.2-.84.44 1.14.16 1.96.08 2.16.52.58.83 1.3.83 2.2 0 3.14-1.87 3.84-3.65 4.04.29.25.54.75.54 1.52v2.11c0 .22.15.48.55.4A8.1 8.1 0 0 0 16 8.18C16 3.66 12.42 0 8 0Z" />
    </svg>
  );
}
