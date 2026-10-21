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
// Every other route that writes a srcdoc (an HTML-parsing setter, an Attr
// node, a cloned template, a fragment, document.write) is caught by the
// mutation observer, which prefixes the frame before its srcdoc navigation
// runs; shadow roots get the observer as they are attached, and setHTMLUnsafe
// markup is prefixed before it is parsed, since its declarative shadow roots
// are never observed. Still open: a closed shadow root built by
// Document.parseHTMLUnsafe and then adopted. No engine is known to enforce
// `webrtc 'block'`, so nothing backs these up. Browser check: a run document
// that inserts a srcdoc frame through each route and opens a data channel
// against a STUN host from it; no server-reflexive candidate may come back. Like the other frame scripts, it must
// never contain the literal script-closing sequence.
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
  var elementProto = runWindow.Element && runWindow.Element.prototype;
  var nodeProto = runWindow.Node && runWindow.Node.prototype;
  var fragmentProto = runWindow.DocumentFragment && runWindow.DocumentFragment.prototype;
  var templateProto = runWindow.HTMLTemplateElement && runWindow.HTMLTemplateElement.prototype;
  var getAttr = elementProto && elementProto.getAttribute;
  var hasAttr = elementProto && elementProto.hasAttribute;
  var setAttr = elementProto && elementProto.setAttribute;
  var queryElement = elementProto && elementProto.querySelectorAll;
  var queryFragment = fragmentProto && fragmentProto.querySelectorAll;
  var createElement = runWindow.Document && runWindow.Document.prototype.createElement;
  var localNameOf = getterOf(elementProto, "localName");
  var nodeTypeOf = getterOf(nodeProto, "nodeType");
  var templateContentOf = getterOf(templateProto, "content");
  var innerHtml = elementProto && describe(elementProto, "innerHTML");
  var OBSERVED = { childList: true, subtree: true, attributes: true, attributeFilter: ["srcdoc"] };
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
  function getterOf(proto, name) {
    var d = proto && describe(proto, name);
    return d && d.get;
  }
  function isFrame(element) {
    try { return !!localNameOf && apply(localNameOf, element, []) === "iframe"; }
    catch (e) { return false; }
  }
  // Every route that puts a srcdoc frame into a document (an HTML-parsing
  // setter, an Attr node, a cloned template, a fragment) shows up as a
  // mutation record, and records are delivered at the next microtask, before
  // the frame's srcdoc navigation runs. Setting the attribute again starts a
  // new navigation that replaces the pending one.
  function prefixFrame(element) {
    if (!srcdocPrefix || !getAttr || !isFrame(element)) return;
    try {
      if (!apply(hasAttr, element, ["srcdoc"])) return;
      var value = apply(getAttr, element, ["srcdoc"]);
      var next = guardedSrcdoc(value);
      if (next !== value) apply(setAttr, element, ["srcdoc", next]);
    } catch (e) {}
  }
  function prefixWithin(node) {
    var type = 0;
    try { type = nodeTypeOf ? apply(nodeTypeOf, node, []) : 0; } catch (e) { return; }
    var query = type === 1 ? queryElement : type === 11 ? queryFragment : null;
    if (!query) return;
    if (type === 1) prefixFrame(node);
    var list;
    try { list = apply(query, node, ["iframe[srcdoc]"]); } catch (e) { return; }
    for (var i = 0; i < list.length; i++) prefixFrame(list[i]);
  }
  // Template content is inert, so its frames are caught once a clone is
  // inserted; but setHTMLUnsafe turns <template shadowrootmode> into a live
  // shadow root no observer is watching, so its markup is prefixed first.
  function prefixDeep(fragment) {
    prefixWithin(fragment);
    var templates;
    try { templates = apply(queryFragment, fragment, ["template"]); } catch (e) { return; }
    for (var i = 0; i < templates.length; i++) {
      try { prefixDeep(apply(templateContentOf, templates[i], [])); } catch (e) {}
    }
  }
  function prefixMarkup(self, args) {
    if (!args.length || !srcdocPrefix || !createElement || !innerHtml || !templateContentOf || !queryFragment) return;
    args[0] = "" + args[0];
    var template = apply(createElement, runDocument, ["template"]);
    apply(innerHtml.set, template, [args[0]]);
    prefixDeep(apply(templateContentOf, template, []));
    args[0] = apply(innerHtml.get, template, []);
  }
  function onRecords(records) {
    try {
      for (var r = 0; r < records.length; r++) {
        var record = records[r];
        if (record.type === "attributes") { prefixFrame(record.target); continue; }
        var added = record.addedNodes;
        for (var a = 0; a < added.length; a++) prefixWithin(added[a]);
      }
    } catch (e) {}
    sweep();
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
    if (srcdocPrefix) {
      var shadowProto = prototypeOf(w, "ShadowRoot");
      var hostProto = prototypeOf(w, "Element");
      try { if (hostProto) wrap(hostProto, "setHTMLUnsafe", "value", sweep, prefixMarkup); } catch (e) {}
      try { if (shadowProto) wrap(shadowProto, "setHTMLUnsafe", "value", sweep, prefixMarkup); } catch (e) {}
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
    var observer = null;
    var observe = null;
    try {
      observe = w.MutationObserver.prototype.observe;
      observer = new w.MutationObserver(onRecords);
      apply(observe, observer, [d, OBSERVED]);
    } catch (e) {}
    // A shadow root is outside the document's subtree, so each one the page
    // attaches gets the same observer.
    var elementType = prototypeOf(w, "Element");
    if (observer && elementType) {
      try {
        wrap(elementType, "attachShadow", "value", function (root) {
          if (root) apply(observe, observer, [root, OBSERVED]);
        });
      } catch (e) {}
    }
    try { d.addEventListener("load", sweep, true); } catch (e) {}
  }
  function hookSrcdoc(w) {
    var frameProto = prototypeOf(w, "HTMLIFrameElement");
    var elementProto = prototypeOf(w, "Element");
    var realmLocalName = getterOf(elementProto, "localName");
    function isFrameHere(element) {
      return !!realmLocalName && apply(realmLocalName, element, []) === "iframe";
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
      if (apply(toLower, args[0], []) === "srcdoc" && isFrameHere(self)) args[1] = guardedSrcdoc(args[1]);
    });
    wrap(elementProto, "setAttributeNS", "value", null, function (self, args) {
      if (args.length < 3) return;
      if (args[0] !== null && args[0] !== undefined) args[0] = "" + args[0];
      if (args[0] !== null && args[0] !== undefined && args[0] !== "") return;
      args[1] = "" + args[1];
      if (args[1] === "srcdoc" && isFrameHere(self)) args[2] = guardedSrcdoc(args[2]);
    });
  }
  harden(runWindow, runDocument);
})();`;
