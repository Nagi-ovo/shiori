// Interpolated inside WEBRTC_GUARD: shares its captured natives and wrappers.
// All additional natives here are captured before the first hook/page script.
export const WEBRTC_MARKUP_GUARD = `
  var removeAttr = elementProto && elementProto.removeAttribute;
  var attrNames = elementProto && elementProto.getAttributeNames;
  var sliceText = String.prototype.slice;
  var parentOf = getterOf(nodeProto, "parentNode");
  var documentProto = runWindow.Document && runWindow.Document.prototype;
  var currentScriptOf = getterOf(documentProto, "currentScript");
  var documentElementOf = getterOf(documentProto, "documentElement");
  var doctypeOf = getterOf(documentProto, "doctype");
  var outerHtmlOf = getterOf(elementProto, "outerHTML");
  var Parser = runWindow.DOMParser;
  var parseDocument = Parser && Parser.prototype.parseFromString;
  var parser = Parser && new Parser();
  var Serializer = runWindow.XMLSerializer;
  var serialize = Serializer && Serializer.prototype.serializeToString;
  var serializer = Serializer && new Serializer();
  var GuardError = Error;
  // A page's default Trusted Types policy must not transform filtered markup
  // back into DSD at a native sink (or during our inert preprocessing).
  var trustedFactory = runWindow.trustedTypes;
  var trustedPolicy = null;
  try {
    trustedPolicy = trustedFactory && apply(trustedFactory.createPolicy, trustedFactory,
      ["shiori-run-markup", { __proto__: null, createHTML: function (text) { return text; } }]);
  } catch (e) {
    // A child may inherit trusted-types 'none'. Still install RTC protection;
    // parsing sinks fail closed if we cannot bypass a page's default policy.
  }
  var createTrustedHtml = trustedPolicy && trustedPolicy.createHTML;
  function trustedMarkup(text) {
    if (trustedFactory && !createTrustedHtml) throw new GuardError("Run-mode HTML policy is unavailable");
    return createTrustedHtml ? apply(createTrustedHtml, trustedPolicy, [text]) : text;
  }
  function stripShadowAttributes(template) {
    var names = apply(attrNames, template, []);
    for (var i = 0; i < names.length; i++) {
      if (apply(indexOf, names[i], ["shadowroot"]) === 0) apply(removeAttr, template, [names[i]]);
    }
  }
  function prefixDeep(fragment) {
    prefixWithin(fragment);
    var type = apply(nodeTypeOf, fragment, []);
    var query = type === 1 ? queryElement : type === 9 ? queryDocument : queryFragment;
    var templates = apply(query, fragment, ["template"]);
    for (var i = 0, count = listLength(templates); i < count; i++) {
      var template = itemAt(templates, i);
      // SVG/MathML elements named template are not HTML templates.
      if (apply(namespaceOf, template, []) !== "http://www.w3.org/1999/xhtml") continue;
      stripShadowAttributes(template);
      prefixDeep(apply(templateContentOf, template, []));
    }
  }
  function documentMarkup(value) {
    var text = "" + value;
    var lower = apply(toLower, text, []);
    if (apply(indexOf, lower, ["shadowroot"]) < 0 && apply(indexOf, lower, ["srcdoc"]) < 0) return text;
    // DOMParser disables DSD and preserves full-document parsing context.
    var doc = apply(parseDocument, parser, [trustedMarkup(text), "text/html"]);
    prefixDeep(doc);
    var doctype = apply(doctypeOf, doc, []);
    return (doctype ? apply(serialize, serializer, [doctype]) : "") +
      apply(outerHtmlOf, apply(documentElementOf, doc, []), []);
  }
  function prefixMarkup(self, args, complete) {
    if (!args.length) return;
    args[0] = "" + args[0];
    var lower = apply(toLower, args[0], []);
    if (!complete && apply(indexOf, lower, ["srcdoc"]) < 0 && apply(indexOf, lower, ["shadowroot"]) < 0) return;
    // Range keeps namespace and ancestor context; shadow roots use the host.
    // Unlike setHTMLUnsafe it leaves declarative templates inert for stripping.
    var context = apply(nodeTypeOf, self, []) === 11 ? apply(shadowHostOf, self, []) : self;
    var htmlContext = apply(localNameOf, context, []) === "html" &&
      apply(namespaceOf, context, []) === "http://www.w3.org/1999/xhtml";
    var container = apply(createElement, runDocument, [htmlContext ? "html" : "template"]);
    var content = htmlContext ? container : apply(templateContentOf, container, []);
    if (htmlContext) apply(innerHtml.set, container, [trustedMarkup(args[0])]);
    else {
      var range = apply(createRange, runDocument, []);
      apply(selectContents, range, [context]);
      apply(appendChild, content, [apply(parseFragment, range, [trustedMarkup(args[0])])]);
    }
    // Do not serialize raw-text contexts through an HTML template: escaping
    // their text would change script/style contents in the destination.
    var query = htmlContext ? queryElement : queryFragment;
    if (!complete && !listLength(apply(query, content, ["iframe[srcdoc], template"]))) return;
    prefixDeep(content);
    args[0] = apply(innerHtml.get, container, []);
  }
  function prefixUnsafe(self, args) {
    prefixMarkup(self, args);
    if (args.length) args[0] = trustedMarkup(args[0]);
  }
  function prefixSibling(self, args) {
    var parent = apply(parentOf, self, []);
    if (parent) prefixMarkup(parent, args);
  }
  function prefixUnsafeSibling(self, args) {
    prefixSibling(self, args);
    if (args.length) args[0] = trustedMarkup(args[0]);
  }
  function prefixWrite(self, args) {
    // Normalize each call to a complete inert fragment, closing partial tokens
    // so separate writes/source continuation cannot assemble a shadow attribute.
    // Native incremental-token semantics are deliberately unavailable in run mode.
    var text = "";
    for (var i = 0; i < args.length; i++) text += "" + args[i];
    var script = apply(currentScriptOf, self, []);
    var context = script && apply(parentOf, script, []);
    if (!context) context = apply(documentElementOf, self, []);
    // The active parser insertion point is hidden, and currentScript can move.
    // Neutralize the enabling token even in text/foreign markup which could be
    // reinterpreted as an HTML attribute there. This also rewrites literal
    // shadowrootmode references in document.write text/scripts, intentionally.
    var result = "";
    var start = 0;
    // Compare fixed slices: Unicode case folding can expand text, so offsets
    // in a lowercased copy cannot safely index the original string.
    for (var at = 0; at + 14 <= text.length; at++) {
      if (apply(toLower, apply(sliceText, text, [at, at + 14]), []) !== "shadowroot" + "mode") continue;
      result += apply(sliceText, text, [start, at]) + "data-shiori-shadow-mode";
      start = at + 14;
      at = start - 1;
    }
    args.length = 1;
    args[0] = result + apply(sliceText, text, [start]);
    prefixMarkup(context, args, true);
    args[0] = trustedMarkup(args[0]);
  }
  function blockStream() {
    // A WritableStream exposes parser state across chunks; an unfiltered native
    // stream would recreate the hole. No stream is returned to page code.
    throw new GuardError("Streaming HTML parsing is unavailable in run mode");
  }
  function hookMarkup(w) {
    var targets = ["Element", "ShadowRoot", "CharacterData"];
    var inside = ["setHTML", "appendHTML", "prependHTML"];
    var siblings = ["beforeHTML", "afterHTML", "replaceWithHTML"];
    var streams = ["streamHTML", "streamAppendHTML", "streamPrependHTML",
      "streamBeforeHTML", "streamAfterHTML", "streamReplaceWithHTML"];
    for (var t = 0; t < targets.length; t++) {
      var proto = prototypeOf(w, targets[t]);
      if (!proto) continue;
      for (var unsafe = 0; unsafe < 2; unsafe++) {
        var suffix = unsafe ? "Unsafe" : "";
        for (var i = 0; i < inside.length; i++) wrap(proto, inside[i] + suffix, "value", sweep, unsafe ? prefixUnsafe : prefixMarkup);
        for (var s = 0; s < siblings.length; s++) wrap(proto, siblings[s] + suffix, "value", sweep, unsafe ? prefixUnsafeSibling : prefixSibling);
        for (var r = 0; r < streams.length; r++) wrap(proto, streams[r] + suffix, "value", null, blockStream);
      }
    }
    var documentType = w.Document;
    if (documentType) {
      function prefixDocument(self, args) { if (args.length) args[0] = documentMarkup(args[0]); }
      function prefixUnsafeDocument(self, args) {
        prefixDocument(self, args);
        if (args.length) args[0] = trustedMarkup(args[0]);
      }
      wrap(documentType, "parseHTMLUnsafe", "value", null, prefixUnsafeDocument);
      wrap(documentType, "parseHTML", "value", null, prefixDocument);
      wrap(documentType.prototype, "write", "value", sweep, prefixWrite);
      wrap(documentType.prototype, "writeln", "value", sweep, prefixWrite);
    }
  }
`;
