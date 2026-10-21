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
// Not covered, where the engine ignores `webrtc 'block'`: a srcdoc child whose
// own scripts run before its load event, and a realm reached between a DOM
// call this list misses and the next mutation microtask. None of it is
// browser-verified (probe: a run document that builds a nested about:blank
// frame and opens a data channel from it against its own STUN host, with the
// network panel open). Like the other frame scripts, it must never contain the
// literal script-closing sequence.
export const WEBRTC_GUARD = `(function () {
  var runWindow = window;
  var runDocument = document;
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
  function claimed(w) {
    var d = Object.getOwnPropertyDescriptor(w, RTC[0]);
    return !!d && d.value === undefined && d.writable === false;
  }
  function strip(w) {
    for (var i = 0; i < RTC.length; i++) {
      try { Object.defineProperty(w, RTC[i], { value: undefined, writable: false, configurable: false }); }
      catch (e) {
        // An engine may refuse non-configurable properties on a WindowProxy.
        try { Object.defineProperty(w, RTC[i], { value: undefined, writable: false, configurable: true }); }
        catch (e2) {}
      }
    }
  }
  function sweep() {
    try { harden(runWindow, runDocument); } catch (e) {}
  }
  function harden(w, d) {
    if (!w) return;
    var fresh = false;
    try { fresh = !claimed(w); if (fresh) strip(w); } catch (e) {}
    if (fresh) {
      try { hook(w, d || w.document); } catch (e) {}
    }
    var n = 0;
    try { n = w.length >>> 0; } catch (e) {}
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
  function wrap(proto, name, kind, after) {
    var desc = Object.getOwnPropertyDescriptor(proto, name);
    var original = desc && desc[kind];
    if (typeof original !== "function" || !desc.configurable) return;
    if (wrapped && wrapped.has(original)) return;
    var replacement = function () {
      var result;
      try { result = original.apply(this, arguments); }
      finally { try { after(result); } catch (e) {} }
      return result;
    };
    if (wrapped) wrapped.add(replacement);
    desc[kind] = replacement;
    Object.defineProperty(proto, name, desc);
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
  harden(runWindow, runDocument);
})();`;
