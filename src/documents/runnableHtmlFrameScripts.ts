import { WEBRTC_GUARD } from "./runnableHtmlWebRtcGuard";

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
// The storage parts install only when the real API is genuinely unavailable,
// so they are inert in a normal same-origin context. WebRTC is removed first,
// unconditionally, here and in every child frame the document can reach (see
// runnableHtmlWebRtcGuard.ts). Exported for unit tests. Like the bridge, it
// must never contain the literal script-closing sequence.
export const STORAGE_SHIM = `${WEBRTC_GUARD}
(function () {
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
