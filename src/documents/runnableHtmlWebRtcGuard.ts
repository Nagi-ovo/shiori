// Removes WebRTC from the run frame and from every child frame it can reach.
// CSP does not govern WebRTC, so a peer connection's ICE gathering could reach
// a STUN host the document names with nothing approved. The run CSP also sends
// `webrtc 'block'`, which covers every inheriting child at once, but only where
// the engine implements that CSP3 directive (runnableHtml.ts).
//
// A fetched child frame is already blocked by the run CSP (default-src
// 'none'). An about:blank or srcdoc child is never fetched, and where the
// engine makes it same-origin with the run frame it hands the document a fresh
// realm with its own RTCPeerConnection. So the guard strips each such realm as
// it becomes reachable: on contentWindow / contentDocument, right after every
// DOM insertion method returns (frames[0] has no getter to patch), on mutation
// records (the parser delivers them before each script), and on a frame's load
// (a navigation swaps the realm behind the same WindowProxy). Each realm gets
// the same hooks, so grandchildren are covered too.
//
// A srcdoc child is a new opaque origin (it inherits the run frame's sandbox),
// so the parent cannot reach it, and its own scripts run before its load
// event. So the srcdoc itself gets the guard's own script tag in front:
// buildRunnableHtml prefixes every static srcdoc, and the guard prefixes one
// set through the srcdoc setter, setAttribute or setAttributeNS. The tag is
// derived from document.currentScript, so it carries itself to grandchildren
// and matches the run CSP (a data: URL on desktop, the nonce on web).
//
// Not covered: a srcdoc written by an HTML-parsing route (innerHTML,
// insertAdjacentHTML, document.write, setHTMLUnsafe, a template or a
// declarative shadow root) or through an Attr node; and a realm reached
// between a DOM call this list misses and the next mutation microtask. No
// engine is known to enforce `webrtc 'block'`, so nothing backs these up.
// None of it is browser-verified (probe: a run document that builds a nested about:blank
// frame and opens a data channel from it against its own STUN host, with the
// network panel open). Like the other frame scripts, it must never contain the
// literal script-closing sequence.
//
// The document's scripts run after the guard in the same realm, so every
// built-in the guard calls later (descriptor lookup and definition, function
// invocation, the WeakSet, the [Replaceable] window.length) is captured here
// first, and descriptors are null-prototype so an Object.prototype getter or
// value cannot corrupt them.
export const WEBRTC_GUARD = `(function () {
  var runWindow = window;
  var runDocument = document;
  var define = Object.defineProperty;
  var describe = Object.getOwnPropertyDescriptor;
  var apply = Reflect.apply;
  var lengthDescriptor = describe(runWindow, "length");
  var lengthOf = lengthDescriptor && lengthDescriptor.get;
  var copyArgs = Array.prototype.slice;
  var indexOf = String.prototype.indexOf;
  var toLower = String.prototype.toLowerCase;
  var srcdocPrefix = scriptTagOf(runDocument.currentScript);
  var RTC = ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection"];
  var FRAME_ELEMENTS = ["HTMLIFrameElement", "HTMLFrameElement", "HTMLObjectElement"];
  var INSERTS = [
    ["Node", ["appendChild", "insertBefore", "replaceChild"], []],
    ["Element", ["append", "prepend", "before", "after", "replaceWith", "replaceChildren",
      "insertAdjacentElement", "insertAdjacentHTML", "setHTMLUnsafe"], ["innerHTML", "outerHTML"]],
    ["CharacterData", ["before", "after", "replaceWith"], []],
    ["Document", ["write", "writeln", "append", "prepend", "replaceChildren"], []],
    ["ShadowRoot", ["setHTMLUnsafe"], ["innerHTML"]],
    ["Range", ["insertNode", "surroundContents"], []]
  ];
  var wrapped = typeof WeakSet === "function" ? new WeakSet() : null;
  var wrappedHas = wrapped && WeakSet.prototype.has;
  var wrappedAdd = wrapped && WeakSet.prototype.add;
  function scriptTagOf(script) {
    try {
      var close = "<" + "/script>";
      if (script.src) return '<script src="' + script.src.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '">' + close;
      var nonce = script.nonce ? ' nonce="' + script.nonce.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '"' : "";
      return "<script" + nonce + ">" + script.textContent + close;
    } catch (e) { return ""; }
  }
  function guardedSrcdoc(value) {
    var text = "" + value;
    return apply(indexOf, text, [srcdocPrefix]) === 0 ? text : srcdocPrefix + text;
  }
  function claimed(w) {
    var d = describe(w, RTC[0]);
    return !!d && d.value === undefined && d.writable === false;
  }
  function strip(w) {
    for (var i = 0; i < RTC.length; i++) {
      try { define(w, RTC[i], { __proto__: null, value: undefined, writable: false, configurable: false }); }
      catch (e) {
        // An engine may refuse non-configurable properties on a WindowProxy.
        try { define(w, RTC[i], { __proto__: null, value: undefined, writable: false, configurable: true }); }
        catch (e2) {}
      }
    }
  }
  function sweep() {
    try { harden(runWindow, runDocument); } catch (e) {}
  }
  function frameCount(w) {
    if (lengthOf) {
      try { return apply(lengthOf, w, []) >>> 0; } catch (e) {}
    }
    try { return w.length >>> 0; } catch (e) { return 0; }
  }
  function harden(w, d) {
    if (!w) return;
    var fresh = false;
    try { fresh = !claimed(w); if (fresh) strip(w); } catch (e) {}
    if (fresh) {
      try { hook(w, d || w.document); } catch (e) {}
    }
    var n = frameCount(w);
    for (var i = 0; i < n; i++) {
      var child = null;
      try { child = w[i]; } catch (e) {}
      if (child && child !== w) harden(child);
    }
  }
  function prototypeOf(w, name) {
    try { var ctor = w[name]; return ctor && ctor.prototype ? ctor.prototype : null; }
    catch (e) { return null; }
  }
  function wrap(proto, name, kind, after, before) {
    var desc = describe(proto, name);
    var original = desc && desc[kind];
    if (typeof original !== "function" || !desc.configurable) return;
    if (wrapped && apply(wrappedHas, wrapped, [original])) return;
    var replacement = function () {
      var args = arguments;
      if (before) {
        // Not caught: a value whose coercion throws fails the call, as the
        // native setter would, instead of reaching it uncoerced.
        args = apply(copyArgs, arguments, []);
        before(this, args);
      }
      var result;
      try { result = apply(original, this, args); }
      finally { if (after) { try { after(result); } catch (e) {} } }
      return result;
    };
    if (wrapped) apply(wrappedAdd, wrapped, [replacement]);
    var next = { __proto__: null, enumerable: desc.enumerable, configurable: true };
    if (kind === "value") { next.value = replacement; next.writable = desc.writable; }
    else { next.get = desc.get; next.set = desc.set; next[kind] = replacement; }
    define(proto, name, next);
  }
  function hardenView(doc) {
    if (doc) harden(doc.defaultView);
  }
  function hook(w, d) {
    for (var f = 0; f < FRAME_ELEMENTS.length; f++) {
      var frameProto = prototypeOf(w, FRAME_ELEMENTS[f]);
      if (!frameProto) continue;
      try { wrap(frameProto, "contentWindow", "get", harden); } catch (e) {}
      try { wrap(frameProto, "contentDocument", "get", hardenView); } catch (e) {}
    }
    if (srcdocPrefix) {
      try { hookSrcdoc(w); } catch (e) {}
    }
    var embedProto = prototypeOf(w, "HTMLEmbedElement");
    if (embedProto) {
      try { wrap(embedProto, "getSVGDocument", "value", hardenView); } catch (e) {}
    }
    for (var k = 0; k < INSERTS.length; k++) {
      var proto = prototypeOf(w, INSERTS[k][0]);
      if (!proto) continue;
      var methods = INSERTS[k][1];
      var setters = INSERTS[k][2];
      for (var m = 0; m < methods.length; m++) {
        try { wrap(proto, methods[m], "value", sweep); } catch (e) {}
      }
      for (var s = 0; s < setters.length; s++) {
        try { wrap(proto, setters[s], "set", sweep); } catch (e) {}
      }
    }
    try { new w.MutationObserver(sweep).observe(d, { childList: true, subtree: true }); } catch (e) {}
    try { d.addEventListener("load", sweep, true); } catch (e) {}
  }
  function hookSrcdoc(w) {
    var frameProto = prototypeOf(w, "HTMLIFrameElement");
    var elementProto = prototypeOf(w, "Element");
    var localName = elementProto && describe(elementProto, "localName");
    var localNameOf = localName && localName.get;
    function isFrame(element) {
      return !!localNameOf && apply(localNameOf, element, []) === "iframe";
    }
    if (frameProto) {
      wrap(frameProto, "srcdoc", "set", null, function (self, args) {
        if (args.length) args[0] = guardedSrcdoc(args[0]);
      });
    }
    if (!elementProto) return;
    // Each name is coerced once and passed on as that string, so an object
    // whose toString changes between calls cannot slip past the check.
    wrap(elementProto, "setAttribute", "value", null, function (self, args) {
      if (args.length < 2) return;
      args[0] = "" + args[0];
      if (apply(toLower, args[0], []) === "srcdoc" && isFrame(self)) args[1] = guardedSrcdoc(args[1]);
    });
    wrap(elementProto, "setAttributeNS", "value", null, function (self, args) {
      if (args.length < 3) return;
      if (args[0] !== null && args[0] !== undefined) args[0] = "" + args[0];
      if (args[0] !== null && args[0] !== undefined && args[0] !== "") return;
      args[1] = "" + args[1];
      if (args[1] === "srcdoc" && isFrame(self)) args[2] = guardedSrcdoc(args[2]);
    });
  }
  harden(runWindow, runDocument);
})();`;
