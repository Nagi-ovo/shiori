// Pure URL classification for the embedded Browser panel. No platform /
// Tauri imports so it stays trivially unit-testable and reusable.

const WEB_URL_PATTERN = /^https?:\/\//i;
// A real scheme prefix ("mailto:", "file:", "tel:"). The negative
// lookahead keeps "host:port" forms (localhost:3000, example.com:8080)
// from being mistaken for a scheme — a colon followed by digits is a port.
const HAS_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
const LOOKS_LIKE_HOST_PATTERN = /^[^\s/]+\.[^\s]+/;
const LOCAL_WEB_HOST_PATTERN =
  /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i;

// http/https render inside the embedded panel; everything else
// (mailto:, tel:, downloads, unknown schemes) belongs to the OS.
export function isWebPanelUrl(url: string): boolean {
  return WEB_URL_PATTERN.test(url.trim());
}

// Turn raw address-bar text into a navigable target:
//   - an http(s) URL passes through unchanged;
//   - local dev hosts ("localhost:3000", "127.0.0.1:5173") default to http;
//   - a bare public host / path ("example.com", "github.com/x") defaults to https;
//   - any other explicit scheme (mailto:, file:, …) is rejected (null) —
//     those are not Browser-panel targets;
//   - free text falls back to a Google search.
export function resolveAddressBarInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (isWebPanelUrl(trimmed)) return trimmed;
  if (HAS_SCHEME_PATTERN.test(trimmed)) return null;
  if (LOCAL_WEB_HOST_PATTERN.test(trimmed)) return `http://${trimmed}`;
  if (LOOKS_LIKE_HOST_PATTERN.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

// Schemes a page in the Browser panel may hand to another app, and only once
// the user agrees (src/editor/components/browserExternalOpen.ts). Desktop
// reports only mailto:. The tablet plugins report tel: and their platform's
// own communication links: Android sms:/smsto:/geo:, iOS sms:/facetime:/
// facetime-audio:/maps:. src-tauri/capabilities/mobile.json scopes the opener
// to exactly these.
export const WEB_PANEL_HANDOFF_SCHEMES = [
  "mailto",
  "tel",
  "sms",
  "smsto",
  "geo",
  "facetime",
  "facetime-audio",
  "maps",
] as const;

const HANDOFF_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

export function isWebPanelHandoffUrl(url: string): boolean {
  const scheme = HANDOFF_SCHEME_PATTERN.exec(url)?.[1]?.toLowerCase();
  return !!scheme && (WEB_PANEL_HANDOFF_SCHEMES as readonly string[]).includes(scheme);
}
