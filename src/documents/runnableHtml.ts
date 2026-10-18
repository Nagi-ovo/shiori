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
// A small bridge script is injected before user scripts to report content
// height back to the host, forward zoom gestures, and surface runtime errors
// and CSP violations (the host cannot read the cross-origin frame directly),
// so the frame still grows to fit without allowing injected link clicks to
// open external pages.

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
  // connect-src / form-action / base-uri / navigate-to stay 'none' regardless,
  // so even an approved remote script cannot phone home, and there is never a
  // blanket https: source.
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

// Installed before the bridge and every user script. Run mode executes in an
// opaque-origin sandbox (no allow-same-origin), where the real localStorage /
// sessionStorage / document.cookie throw "SecurityError: The operation is
// insecure." on first access — which hard-crashes any page that stores state
// (an extremely common pattern: a page doing `localStorage.getItem(...)` at
// top level never even starts). This replaces them with in-memory equivalents
// that live only in this frame's heap — data never persists, never reaches the
// user's real storage / cookies / files, and is gone on reload or close. That
// keeps Lock 1's guarantee intact ("nothing of the user's in the box, nothing
// leaves it") while turning a cryptic crash into expected ephemeral behavior.
// It installs only when the real API is genuinely unavailable, so it is inert
// in a normal same-origin context. Exported for unit tests. Like the bridge,
// it must never contain the literal script-closing sequence.
export const STORAGE_SHIM = `(function () {
  function makeStorage() {
    var data = Object.create(null);
    function keys() { return Object.keys(data); }
    var api = {
      getItem: function (k) { k = String(k); return k in data ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); },
      removeItem: function (k) { delete data[String(k)]; },
      clear: function () { var ks = keys(); for (var i = 0; i < ks.length; i++) delete data[ks[i]]; },
      key: function (i) { var ks = keys(); i = i >>> 0; return i < ks.length ? ks[i] : null; }
    };
    if (typeof Proxy !== "function") return api;
    return new Proxy(api, {
      get: function (t, p, r) {
        if (p === "length") return keys().length;
        if (typeof p === "symbol" || p in t) return Reflect.get(t, p, r);
        var k = String(p);
        return k in data ? data[k] : undefined;
      },
      set: function (t, p, v) {
        // Deliberate divergence from real Storage: writes that collide with an
        // API method name (setItem, getItem, ...) are silently dropped instead
        // of shadowing — and breaking — the method, so the shim stays usable.
        if (p === "length" || typeof p === "symbol" || p in t) return true;
        data[String(p)] = String(v);
        return true;
      },
      has: function (t, p) {
        if (p === "length" || p in t) return true;
        if (typeof p === "symbol") return false;
        return String(p) in data;
      },
      deleteProperty: function (t, p) { if (typeof p !== "symbol") delete data[String(p)]; return true; },
      ownKeys: function () { return keys(); },
      getOwnPropertyDescriptor: function (t, p) {
        if (typeof p === "symbol") return Reflect.getOwnPropertyDescriptor(t, p);
        var k = String(p);
        if (k in data) return { value: data[k], writable: true, enumerable: true, configurable: true };
        return undefined;
      }
    });
  }
  function unavailable(name) {
    try { var s = window[name]; if (!s) return true; s.getItem("shiori-probe"); return false; }
    catch (e) { return true; }
  }
  function install(name) {
    if (!unavailable(name)) return;
    try { Object.defineProperty(window, name, { value: makeStorage(), configurable: true }); }
    catch (e) {}
  }
  install("localStorage");
  install("sessionStorage");
  try { void document.cookie; }
  catch (cookieErr) {
    var jar = Object.create(null);
    try {
      Object.defineProperty(document, "cookie", {
        configurable: true,
        get: function () {
          var out = []; var ks = Object.keys(jar);
          for (var i = 0; i < ks.length; i++) out.push(ks[i] + "=" + jar[ks[i]]);
          return out.join("; ");
        },
        set: function (s) {
          var parts = String(s).split(";");
          var pair = parts[0]; var eq = pair.indexOf("=");
          // Real browsers store bare-name cookies ("flag"); the shim deliberately drops them.
          if (eq <= 0) return;
          var name = pair.slice(0, eq).trim();
          var maxAge = null; var expiresAt = null;
          for (var i = 1; i < parts.length; i++) {
            var attr = parts[i]; var aeq = attr.indexOf("=");
            var an = (aeq < 0 ? attr : attr.slice(0, aeq)).trim().toLowerCase();
            var av = aeq < 0 ? "" : attr.slice(aeq + 1).trim();
            if (an === "max-age") { var age = parseInt(av, 10); if (isFinite(age)) maxAge = age; }
            else if (an === "expires") { var when = Date.parse(av); if (isFinite(when)) expiresAt = when; }
          }
          // Max-Age wins over Expires (RFC 6265); either in the past deletes.
          if (maxAge !== null ? maxAge <= 0 : expiresAt !== null && expiresAt <= Date.now()) {
            delete jar[name];
            return;
          }
          jar[name] = pair.slice(eq + 1).trim();
        }
      });
    } catch (defineErr) {}
  }
})();`;

// Runs inside the sandbox. Reports height (so the host can size the frame) and
// neutralizes link clicks so they cannot navigate the frame or ask the host to
// open an external page. Must never contain the literal `</script>` so it
// survives serialization. Exported for unit tests.
export const BRIDGE_SCRIPT = `(function () {
  var wheelDeltaLimit = 40;
  var wheelZoomSensitivity = 0.005;
  var gestureBaseScale = 1;
  var observer = null;
  function post(type, value, extra) {
    var payload = { source: "shiori-run-frame", type: type, value: value };
    if (extra) {
      for (var key in extra) payload[key] = extra[key];
    }
    try {
      parent.postMessage(payload, "*");
    } catch (e) {}
  }
  function postHeight() {
    var d = document.documentElement;
    var b = document.body;
    var h = Math.max(
      window.innerHeight || 0,
      d ? d.clientHeight : 0,
      d ? d.scrollHeight : 0,
      b ? b.clientHeight : 0,
      b ? b.scrollHeight : 0
    );
    post("height", h);
  }
  function nudgeResize() {
    try {
      window.dispatchEvent(new Event("resize"));
    } catch (e) {}
  }
  function eventPoint(e) {
    return typeof e.clientX === "number" && typeof e.clientY === "number"
      ? { clientX: e.clientX, clientY: e.clientY }
      : { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 };
  }
  function postZoom(factor, e) {
    if (!isFinite(factor) || factor <= 0) return;
    post("zoom", factor, eventPoint(e || {}));
  }
  function reportError(value) {
    post("error", String(value || "Script error"));
  }
  function applyHostZoom(value) {
    if (typeof value !== "number" || !isFinite(value) || value <= 0) return;
    if (document.documentElement) {
      document.documentElement.style.zoom = value === 1 ? "" : String(value);
    }
    postHeight();
    setTimeout(postHeight, 60);
  }
  function observeBody() {
    if (observer && document.body) observer.observe(document.body);
  }
  document.addEventListener(
    "click",
    function (e) {
      var node = e.target;
      var anchor = node && node.closest ? node.closest("a[href]") : null;
      if (anchor && anchor.href) {
        e.preventDefault();
      }
    },
    true
  );
  window.addEventListener("error", function (e) {
    reportError(e && e.message ? e.message : "Script error");
  });
  window.addEventListener("unhandledrejection", function (e) {
    var reason = e && e.reason;
    reportError(reason && reason.message ? reason.message : reason);
  });
  document.addEventListener("securitypolicyviolation", function (e) {
    var blocked = e && e.blockedURI ? String(e.blockedURI) : "";
    post("cspViolation", blocked, {
      blockedURI: blocked,
      violatedDirective:
        e && e.violatedDirective ? String(e.violatedDirective) : ""
    });
  }, true);
  window.addEventListener("wheel", function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    var delta = Math.max(-wheelDeltaLimit, Math.min(wheelDeltaLimit, -e.deltaY));
    postZoom(Math.exp(delta * wheelZoomSensitivity), e);
  }, { passive: false });
  window.addEventListener("gesturestart", function (e) {
    e.preventDefault();
    gestureBaseScale = 1;
  }, { passive: false });
  window.addEventListener("gesturechange", function (e) {
    var scale = e && typeof e.scale === "number" ? e.scale : null;
    if (!scale) return;
    e.preventDefault();
    postZoom(scale / gestureBaseScale, e);
    gestureBaseScale = scale;
  }, { passive: false });
  window.addEventListener("gestureend", function (e) {
    e.preventDefault();
    gestureBaseScale = 1;
  }, { passive: false });
  window.addEventListener("message", function (e) {
    var data = e && e.data;
    if (!data || data.source !== "shiori-host-frame") return;
    if (data.type === "zoom") applyHostZoom(data.value);
  });
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(postHeight);
    if (document.documentElement) observer.observe(document.documentElement);
    observeBody();
  }
  document.addEventListener("DOMContentLoaded", function () {
    observeBody();
    nudgeResize();
    postHeight();
    requestAnimationFrame(function () {
      nudgeResize();
      postHeight();
    });
  });
  window.addEventListener("load", function () {
    nudgeResize();
    postHeight();
    setTimeout(nudgeResize, 60);
  });
  postHeight();
  setTimeout(postHeight, 120);
  setTimeout(postHeight, 480);
})();`;

export function buildRunnableHtml(
  rawHtml: string,
  options: RunnableHtmlOptions = {},
): RunnableHtmlBuild {
  const parsed = new window.DOMParser().parseFromString(rawHtml, "text/html");
  const nonce = createRunNonce();

  // Scan before injecting anything so the report reflects only the document's
  // own references, never the shim/bridge scripts added below.
  const remoteDependencies = scanRemoteDependencies(parsed);

  removeDocumentCspMetas(parsed);

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

function removeDocumentCspMetas(doc: Document) {
  for (const meta of Array.from(doc.querySelectorAll("meta[http-equiv]"))) {
    const header = meta.getAttribute("http-equiv")?.trim().toLowerCase();
    if (header === "content-security-policy") meta.remove();
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
