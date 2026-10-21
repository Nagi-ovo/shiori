// Prepares an HTML document for *sandboxed execution* — the opt-in "run
// interactive HTML" mode. Unlike renderSafeHtml (which strips all scripts for
// a safe static read), this keeps the document's own scripts so canvas /
// particle / mini-app artifacts actually run, and instead contains them with
// two independent locks:
//
//   Lock 1 — the iframe sandbox. The caller renders the returned document in
//   `<iframe sandbox="allow-scripts">` WITHOUT `allow-same-origin`, so the
//   frame is an opaque origin: its scripts cannot touch the app's DOM,
//   storage, cookies, or Tauri IPC, and cannot read the user's files. There
//   is nothing of the user's inside the box to read.
//
//   Lock 2 — the CSP injected below. `connect-src 'none'` blocks fetch / XHR /
//   WebSocket (no phoning home), remote script loads are denied (no downloads
//   of executable code), and `img/media/font` are limited to data:/blob: so
//   there's no remote-resource beacon channel. Tauri also applies the app's top
//   level CSP to iframe content, so desktop run mode can rewrite inline scripts
//   to generated data: URLs instead of relying on child-frame inline script
//   allowances that the parent CSP would still block.
//
//   Neither lock stops the frame navigating itself (`location.href = …`
//   beacons the open): no browser implements `navigate-to`. That is the
//   embedding page's `frame-src 'self' blob:`, in the desktop CSP
//   (src-tauri/tauri.conf.json) and the web app's headers (public/_headers).
//   A `<meta http-equiv="refresh">`, which needs no script, is removed here.
//
//   CSP fetch directives do not govern WebRTC either. The policy sends
//   `webrtc 'block'` for any engine that implements it (none is known to),
//   and the frame scripts remove the RTCPeerConnection constructors from the
//   run frame, every child frame it can reach, and every srcdoc child they
//   can prefix (runnableHtmlWebRtcGuard.ts).
//
// A small bridge script is injected before user scripts to report content
// height back to the host, forward zoom gestures, and surface runtime errors
// and CSP violations (the host cannot read the cross-origin frame directly),
// so the frame still grows to fit without allowing injected link clicks to
// open external pages.

import { BRIDGE_SCRIPT, STORAGE_SHIM } from "./runnableHtmlFrameScripts";

export { BRIDGE_SCRIPT, STORAGE_SHIM };

const RUN_NONCE_BYTES = 16;
const RUN_NONCE_PLACEHOLDER_ATTR = "data-shiori-run-nonce";

type RunnableHtmlOptions = {
  externalizeScript?: (source: string) => string;
  allowRemoteOrigins?: ApprovedRemoteOrigins;
};

// The only dependency kinds a user can consent to: each maps to exactly one
// resource-fetching CSP directive. There is deliberately no entry for frames,
// fonts, or — above all — connect/fetch, so consent can render remote content
// but never opens a phone-home channel.
export type ApprovableDependencyKind = Extract<
  RemoteDependencyKind,
  "script" | "stylesheet" | "image" | "media"
>;

export type ApprovedRemoteOrigins = Partial<
  Record<ApprovableDependencyKind, readonly string[]>
>;

export function isApprovableDependencyKind(
  kind: RemoteDependencyKind,
): kind is ApprovableDependencyKind {
  return (
    kind === "script" ||
    kind === "stylesheet" ||
    kind === "image" ||
    kind === "media"
  );
}

// "frame" / "font" / "connect" / "other" only ever come from runtime CSP
// violation reports; the static scanner emits the first five kinds.
export type RemoteDependencyKind =
  | "script"
  | "stylesheet"
  | "image"
  | "media"
  | "frame"
  | "font"
  | "connect"
  | "other";

export type RemoteDependency = {
  url: string;
  origin: string;
  kind: RemoteDependencyKind;
};

export type RunnableHtmlBuild = {
  html: string;
  remoteDependencies: RemoteDependency[];
};

// Stable identity for merging the static scan with runtime violation reports.
// The kind never contains "|", so the first separator is unambiguous even if
// the URL itself carries one.
export function remoteDependencyKey(dependency: RemoteDependency): string {
  return `${dependency.kind}|${dependency.url}`;
}

// Collects every external http(s) resource the document references, so the
// host can disclose what the run-mode CSP is about to block instead of letting
// scripts die with an unexplained "Can't find variable" error. Relative URLs
// never reach the network from the opaque frame, and data:/blob: are already
// covered by the CSP, so neither counts as a remote dependency.
export function scanRemoteDependencies(doc: Document): RemoteDependency[] {
  const found = new Map<string, RemoteDependency>();
  const add = (raw: string | null, kind: RemoteDependencyKind) => {
    const parsed = parseRemoteUrl(raw);
    if (!parsed) return;
    const entry = { url: parsed.href, origin: parsed.origin, kind };
    const key = remoteDependencyKey(entry);
    if (!found.has(key)) found.set(key, entry);
  };
  for (const script of Array.from(doc.querySelectorAll("script[src]"))) {
    add(script.getAttribute("src"), "script");
  }
  for (const link of Array.from(doc.querySelectorAll("link[href]"))) {
    if (!/(^|\s)stylesheet(\s|$)/i.test(link.getAttribute("rel") ?? "")) {
      continue;
    }
    add(link.getAttribute("href"), "stylesheet");
  }
  for (const image of Array.from(doc.querySelectorAll("img[src]"))) {
    add(image.getAttribute("src"), "image");
  }
  for (const frame of Array.from(doc.querySelectorAll("iframe[src]"))) {
    add(frame.getAttribute("src"), "frame");
  }
  for (const media of Array.from(
    doc.querySelectorAll("video[src], audio[src], source[src]"),
  )) {
    add(media.getAttribute("src"), "media");
  }
  return [...found.values()];
}

// Maps a SecurityPolicyViolationEvent relayed by the bridge onto the same
// shape as the static scan so both lists merge cleanly. Non-network blocked
// URIs ("inline", "eval", "data", …) are not remote dependencies.
export function remoteDependencyFromViolation(
  blockedUri: string,
  violatedDirective: string,
): RemoteDependency | null {
  const parsed = parseRemoteUrl(blockedUri);
  if (!parsed) return null;
  return {
    url: parsed.href,
    origin: parsed.origin,
    kind: violationKind(violatedDirective),
  };
}

function violationKind(directive: string): RemoteDependencyKind {
  const name = directive.trim().toLowerCase();
  if (name.startsWith("script-src")) return "script";
  if (name.startsWith("style-src")) return "stylesheet";
  if (name === "img-src") return "image";
  if (name === "media-src") return "media";
  if (name === "frame-src" || name === "child-src") return "frame";
  if (name === "font-src") return "font";
  if (name === "connect-src") return "connect";
  return "other";
}

function parseRemoteUrl(raw: string | null): URL | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  // Protocol-relative ("//cdn…") references are remote too; treat them as
  // https, which is what they would resolve to anywhere they could load.
  const candidate = value.startsWith("//") ? `https:${value}` : value;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed;
}

function runCsp(
  mode: { nonce: string } | { externalScripts: true },
  approvedOrigins: ApprovedRemoteOrigins = {},
): string {
  const scriptSource =
    "externalScripts" in mode
      ? "data:"
      : `'nonce-${mode.nonce}' 'unsafe-inline' 'unsafe-eval'`;
  const scriptElementSource =
    "externalScripts" in mode ? "data:" : "'unsafe-inline'";

  // User-approved origins widen exactly one resource-fetching directive each.
  // connect-src / form-action / base-uri stay 'none' regardless, so even an
  // approved remote script cannot fetch or post anywhere, and there is never
  // a blanket https: source. navigate-to is kept but enforced nowhere (see the
  // header for what stops navigation).
  return [
    "default-src 'none'",
    `script-src ${scriptSource}`,
    // Modern CSP engines use this for script elements. It preserves run mode's
    // script behavior without adding any URL source for remote scripts beyond
    // the explicitly approved origins.
    `script-src-elem ${scriptElementSource}${cspOriginSuffix(approvedOrigins.script)}`,
    "script-src-attr 'unsafe-inline'",
    `style-src 'unsafe-inline'${cspOriginSuffix(approvedOrigins.stylesheet)}`,
    `img-src data: blob:${cspOriginSuffix(approvedOrigins.image)}`,
    "font-src data:",
    `media-src data: blob:${cspOriginSuffix(approvedOrigins.media)}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "navigate-to 'none'",
    // CSP3, inherited by about:blank / srcdoc children, but no engine is
    // known to enforce it; the WebRTC guard in the frame scripts does the work.
    "webrtc 'block'",
  ].join("; ");
}

// Every approved origin must round-trip through the URL parser to a bare
// http(s) origin; anything else is dropped rather than risking a policy
// injection from a crafted string. Returns " origin…" ready to append to a
// directive, or "" when nothing valid was approved.
function cspOriginSuffix(origins: readonly string[] | undefined): string {
  if (!origins?.length) return "";
  const safe = new Set<string>();
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      continue;
    }
    const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
    if (!isHttp || parsed.origin !== origin) continue;
    safe.add(parsed.origin);
  }
  return [...safe].map((origin) => ` ${origin}`).join("");
}

export function buildRunnableHtml(
  rawHtml: string,
  options: RunnableHtmlOptions = {},
): RunnableHtmlBuild {
  const parsed = new window.DOMParser().parseFromString(rawHtml, "text/html");
  const nonce = createRunNonce();

  // Scan before injecting anything so the report reflects only the document's
  // own references, never the shim/bridge scripts added below.
  const remoteDependencies = scanRemoteDependencies(parsed);

  removeCspAndRefreshMetas(parsed);

  // The CSP must be the very first thing the parser sees so it governs every
  // script that follows. Prepending to <head> guarantees that. Existing CSP
  // metas are removed because multiple policies intersect; a stricter document
  // policy can accidentally block Shiori's sizing bridge while adding no extra
  // protection outside this already opaque, run-mode sandbox.
  const csp = parsed.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute(
    "content",
    options.externalizeScript
      ? runCsp({ externalScripts: true }, options.allowRemoteOrigins)
      : runCsp({ nonce }, options.allowRemoteOrigins),
  );
  parsed.head.prepend(csp);

  // Order in <head>: CSP meta, storage shim, host bridge, then the document's
  // own scripts. The shim must run before any user script so a top-level
  // `localStorage.getItem(...)` finds the in-memory replacement, not the
  // throwing real one. Both injected scripts are picked up by the same
  // nonce/externalize pass below as `script:not([src])`.
  const storageShim = parsed.createElement("script");
  storageShim.textContent = STORAGE_SHIM;
  parsed.head.insertBefore(storageShim, csp.nextSibling);

  const bridge = parsed.createElement("script");
  bridge.textContent = BRIDGE_SCRIPT;
  parsed.head.insertBefore(bridge, storageShim.nextSibling);

  // A srcdoc child is its own opaque origin, out of the run frame's reach, so
  // it runs the shim (and its WebRTC guard) itself, ahead of its own scripts.
  const { externalizeScript } = options;
  let srcdocTag: string | undefined;
  prefixSrcdocFrames(parsed, () =>
    (srcdocTag ??= externalizeScript
      ? `<script src="${escapeAttribute(externalizeScript(STORAGE_SHIM))}"></script>`
      : `<script nonce="${nonce}">${STORAGE_SHIM}</script>`),
  );

  if (options.externalizeScript) {
    externalizeInlineScripts(parsed, options.externalizeScript);
    return { html: serializeRunnableDocument(parsed), remoteDependencies };
  }

  nonceInlineScripts(parsed, nonce);
  return { html: serializeRunnableDocument(parsed, nonce), remoteDependencies };
}

function createRunNonce(): string {
  const bytes = new Uint8Array(RUN_NONCE_BYTES);
  const cryptoLike = globalThis.crypto ?? window.crypto;
  if (cryptoLike?.getRandomValues) {
    cryptoLike.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

// Template contents count too: the browser's parser turns
// <template shadowrootmode> into a live shadow root (DOMParser does not), and
// a page can clone any template into the document. So does a srcdoc inside a
// srcdoc: the child's own parser inserts it, out of the child's reach.
function prefixSrcdocFrames(root: ParentNode, scriptTag: () => string) {
  for (const template of Array.from(root.querySelectorAll("template"))) {
    prefixSrcdocFrames((template as HTMLTemplateElement).content, scriptTag);
  }
  for (const frame of Array.from(root.querySelectorAll("iframe[srcdoc]"))) {
    const srcdoc = prefixNestedSrcdoc(frame.getAttribute("srcdoc") ?? "", scriptTag);
    frame.setAttribute("srcdoc", scriptTag() + srcdoc);
  }
}

function prefixNestedSrcdoc(srcdoc: string, scriptTag: () => string): string {
  // Only an <iframe or <template tag can open a frame; others stay verbatim.
  if (!/<(iframe|template)/i.test(srcdoc)) return srcdoc;
  const doc = new window.DOMParser().parseFromString(srcdoc, "text/html");
  prefixSrcdocFrames(doc, scriptTag);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function removeCspAndRefreshMetas(doc: Document) {
  for (const meta of Array.from(doc.querySelectorAll("meta[http-equiv]"))) {
    const header = meta.getAttribute("http-equiv")?.trim().toLowerCase();
    if (header === "content-security-policy" || header === "refresh") meta.remove();
  }
}

function nonceInlineScripts(doc: Document, nonce: string) {
  for (const script of Array.from(
    doc.querySelectorAll<HTMLScriptElement>("script:not([src])"),
  )) {
    script.setAttribute(RUN_NONCE_PLACEHOLDER_ATTR, nonce);
  }
}

function externalizeInlineScripts(
  doc: Document,
  externalizeScript: (source: string) => string,
) {
  for (const script of Array.from(
    doc.querySelectorAll<HTMLScriptElement>("script:not([src])"),
  )) {
    const source = script.textContent ?? "";
    script.textContent = "";
    script.removeAttribute(RUN_NONCE_PLACEHOLDER_ATTR);
    script.setAttribute("src", externalizeScript(source));
  }
}

function serializeRunnableDocument(doc: Document, nonce?: string): string {
  const serialized = `<!doctype html>${doc.documentElement.outerHTML}`;
  if (!nonce) return serialized;
  return serialized.replaceAll(
    ` ${RUN_NONCE_PLACEHOLDER_ATTR}="${nonce}"`,
    ` nonce="${nonce}"`,
  );
}
