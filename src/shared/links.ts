// Canonical outbound URLs. Every surface that links out (Landing footer,
// Settings → About, …) imports from here so the addresses can't drift
// between call sites. Always open these via `openExternalUrl` from
// src/platform — never window.open.

export const WEBSITE_URL = "https://shiori.nagi.fun";
export const RELEASES_URL = "https://github.com/Nagi-ovo/shiori";
// GitHub Pages for Nagi-ovo/shiori: the updater manifest and the per-version
// release notes. src-tauri/tauri.conf.json names it too (updater endpoint,
// CSP connect-src); src/shared/links.test.ts keeps them in step.
export const UPDATES_URL = "https://updates.shiori.nagi.fun";
// The Featurebase subdomain is the ORGANIZATION slug, and ours is
// `tryshiori` — `shiori.featurebase.app` resolves to a different, empty
// org, so it served a board with no posts instead of erroring. Verify
// against the dashboard URL, not intuition, if this ever changes again.
export const FEEDBACK_URL = "https://tryshiori.featurebase.app";
