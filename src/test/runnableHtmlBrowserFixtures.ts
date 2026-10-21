import { shadowBrowserRoutes } from "./runnableHtmlShadowFixtures";
import { buildRunnableHtml } from "../documents/runnableHtml";

// Each route runs in its own opaque frame: poisoning must not affect the
// runner, another case, or the child whose FIRST script reports the result.
export const browserRoutes: Record<string, string> = {
  ...shadowBrowserRoutes,
  restrictedTrustedTypesSrcdoc: `const meta = document.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy'; meta.content = "trusted-types 'none'";
    document.head.appendChild(meta); host.innerHTML = tag;`,
  innerHTML: "host.innerHTML = tag;",
  outerHTML: "host.appendChild(document.createElement('div')).outerHTML = tag;",
  insertAdjacentHTML: "host.insertAdjacentHTML('beforeend', tag);",
  attrValue: `const frame = host.appendChild(document.createElement('iframe'));
    frame.setAttribute('srcdoc', ''); frame.getAttributeNode('srcdoc').value = child;`,
  templateClone: `const template = document.createElement('template');
    template.innerHTML = tag; host.appendChild(template.content.cloneNode(true));`,
  contextualFragment: "host.appendChild(document.createRange().createContextualFragment(tag));",
  closedShadowRoot: "host.attachShadow({mode:'closed'}).innerHTML = tag;",
  parserOpenShadow: `host.setHTMLUnsafe('<div><template shadowrootmode="open"></template></div>');
    const root = host.firstElementChild.shadowRoot;
    if (!root && !host.firstElementChild.querySelector('template')) throw new Error('missing inert template');
    reportShadow(!!root);
    if (root) root.innerHTML = tag;`,
  adoptedOpenShadow: `const parsed = Document.parseHTMLUnsafe(
    '<div><template shadowrootmode="open">' + tag + '</template></div>');
    const adopted = host.appendChild(document.adoptNode(parsed.body.firstElementChild));
    reportShadow(!!adopted.shadowRoot);`,
  adoptedClosedShadow: `let root = 'not upgraded';
    customElements.define('closed-probe', class extends HTMLElement {
      constructor() { super(); root = this.attachInternals().shadowRoot; }
    });
    const parsed = Document.parseHTMLUnsafe(
      '<closed-probe><template shadowrootmode="closed">' + tag + '</template></closed-probe>');
    host.appendChild(document.adoptNode(parsed.body.firstElementChild));
    if (root === 'not upgraded') throw new Error('custom element never upgraded');
    reportShadow(!!root);`,
  mutationRecordPoison: `Object.defineProperty(MutationRecord.prototype, 'addedNodes',
    {get(){ return []; }}); host.innerHTML = tag;`,
  nodeListPoison: `Object.defineProperty(NodeList.prototype, 'length',
    {get(){ return 0; }}); host.innerHTML = tag;`,
  observerOptionsPoison: `Object.defineProperty(Object.prototype, 'attributeOldValue',
    {get(){ throw new Error('poisoned observer dictionary'); }});
    host.attachShadow({mode:'closed'}).innerHTML = tag;`,
  observerIteratorPoison: `Array.prototype[Symbol.iterator] = function(){
    throw new Error('poisoned observer sequence'); };
    host.attachShadow({mode:'closed'}).innerHTML = tag;`,
  svgParsingContext: `const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    host.appendChild(svg); svg.setHTMLUnsafe('<circle data-label="srcdoc"/><rect/>');
    if (svg.children.length !== 2 || svg.children[1].localName !== 'rect' ||
      svg.children[0].namespaceURI !== 'http://www.w3.org/2000/svg') {
      throw new Error('SVG sibling structure corrupted: ' + svg.innerHTML);
    }
    host.insertAdjacentHTML('beforeend', tag);`,
  svgSrcdocParsingContext: `const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    host.appendChild(svg);
    svg.setHTMLUnsafe('<circle/><foreignObject><div><template shadowrootmode="closed">' +
      tag + '</template></div></foreignObject><rect/>');
    if (svg.children.length !== 3 || svg.children[1].localName !== 'foreignObject' ||
      svg.children[2].localName !== 'rect' || svg.children[1].namespaceURI !== svg.namespaceURI) {
      throw new Error('SVG srcdoc context corrupted: ' + svg.innerHTML);
    }
    activateTemplates(svg);`,
  mathMlParsingContext: `const math = document.createElementNS('http://www.w3.org/1998/Math/MathML', 'math');
    host.appendChild(math); math.setHTMLUnsafe('<mi data-label="srcdoc"/><mn/>');
    if (math.children.length !== 2 || math.children[1].localName !== 'mn' ||
      math.children[0].namespaceURI !== 'http://www.w3.org/1998/Math/MathML') {
      throw new Error('MathML sibling structure corrupted: ' + math.innerHTML);
    }
    const annotation = document.createElementNS(math.namespaceURI, 'annotation-xml');
    annotation.setAttribute('encoding', 'text/html'); math.appendChild(annotation);
    annotation.setHTMLUnsafe(tag);`,
  htmlParsingContext: `const html = document.createElement('html');
    html.setHTMLUnsafe('<head><title>srcdoc</title></head><body>' + tag + '</body>');
    if (html.children.length !== 2 || html.children[0].localName !== 'head' ||
      html.children[1].localName !== 'body') throw new Error('HTML document structure corrupted');
    const table = host.appendChild(document.createElement('table'));
    table.setHTMLUnsafe('<tbody><tr><td data-label="srcdoc">cell</td></tr></tbody>');
    if (table.querySelector('tbody > tr > td')?.textContent !== 'cell') throw new Error('Table context lost');
    host.appendChild(html);`,
  rawTextParsingContext: `const markup = '<iframe srcdoc="user">&amp;<b>text</b></iframe>';
    for (const name of ['script', 'style', 'xmp']) {
      const target = document.createElement(name); target.setHTMLUnsafe(markup);
      if (target.textContent !== markup) throw new Error(name + ' text corrupted');
    }
    host.insertAdjacentHTML('beforeend', tag);`,
  ancestorFormParsingContext: `const form = host.appendChild(document.createElement('form'));
    const target = form.appendChild(document.createElement('div'));
    target.setHTMLUnsafe('<form data-label="srcdoc"><input></form>' + tag);
    if (target.querySelector('form') || !target.querySelector('input')) {
      throw new Error('Ancestor form context lost');
    }`,
  elementDeclarativeShadow: `host.setHTMLUnsafe('<div><template shadowrootmode="closed">' +
    '<div><template shadowrootmode="closed">' + tag + '</template></div></template></div>');
    activateTemplates(host);`,
  shadowRootDeclarativeShadow: `const root = host.attachShadow({mode:'closed'});
    root.setHTMLUnsafe('<div><template shadowrootmode="closed">' + tag + '</template></div>');
    activateTemplates(root);`,
  contextualBuiltinsPoison: `const root = host.attachShadow({mode:'closed'});
    const poison = () => { throw new Error('page builtin called'); };
    Document.prototype.createRange = poison;
    Document.prototype.createElement = poison;
    Range.prototype.selectNodeContents = poison;
    Range.prototype.createContextualFragment = poison;
    Node.prototype.appendChild = poison;
    RegExp.prototype.test = poison;
    for (const [proto, name] of [[ShadowRoot.prototype, 'host'],
      [Element.prototype, 'namespaceURI'], [Element.prototype, 'localName']]) {
      Object.defineProperty(proto, name, {get:poison});
    }
    root.setHTMLUnsafe('<div><template shadowrootmode="closed">' + tag + '</template></div>');
    activateTemplates(root);`,
};

export type BrowserProbe = {
  id: string;
  complete: true;
  available: string[];
  constructed: string[];
  errors: string[];
  routeError?: string;
  shadowRootProduced?: boolean;
  childScriptRan?: boolean;
};

export const browserModes = ["inline", "externalized"] as const;
export type BrowserMode = (typeof browserModes)[number];

function js(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function script(source: string, mode: BrowserMode): string {
  return mode === "inline"
    ? `<script>${source}</script>`
    : `<script src="${dataScript(source)}"></script>`;
}

function dataScript(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

function childDocument(id: string, mode: BrowserMode, prelude = ""): string {
  return script(`(() => {
    ${prelude}
    const result = { id: ${js(id)}, complete: true, childScriptRan: true, available: [], constructed: [], errors: [] };
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
      const Constructor = window[name];
      if (typeof Constructor !== 'function') continue;
      result.available.push(name);
      try { const peer = new Constructor({iceServers: []}); peer.close(); result.constructed.push(name); }
      catch (error) { result.errors.push(name + ': ' + error.message); }
    }
    top.postMessage(result, '*');
  })();`, mode);
}

export function browserFixture(): { html: string; ids: string[] } {
  const frames: { id: string; html: string }[] = [];
  for (const mode of browserModes) {
    const control = `${mode}:unguarded-control`;
    frames.push({ id: control, html: childDocument(control, mode) });
    const policyControl = `${mode}:frame-src-none-control`;
    frames.push({ id: policyControl, html: '<meta http-equiv="Content-Security-Policy" content="frame-src &#39;none&#39;">' +
      '<iframe srcdoc="' + childDocument(policyControl, mode).replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"></iframe>' });
    for (const [route, operation] of Object.entries(browserRoutes)) {
      const id = `${mode}:${route}`;
      const child = childDocument(id, mode, route === "dynamicSrcdocShadow" ? `
        const target = document.getElementById('target');
        if (!target?.querySelector('template')?.content.querySelector('p')) throw new Error('missing inert content');
        top.postMessage({id:${js(id)}, shadowRootProduced:!!target.shadowRoot}, '*');
      ` : "");
      const source = `try {
        const id = ${js(id)};
        function reportShadow(produced, extra = {}) {
          top.postMessage({id: ${js(id)}, shadowRootProduced: produced, ...extra,
            ...(!produced ? {complete: true, childScriptRan: false,
              available: [], constructed: [], errors: []} : {})}, '*');
        }
        function activateTemplates(root) {
          const templates = root.querySelectorAll('template');
          if (!templates.length) throw new Error('missing inert template');
          for (const template of templates) {
            if (template.hasAttribute('shadowrootmode')) throw new Error('template can still create a root');
            if (template.content.querySelector('template')) activateTemplates(template.content);
            template.replaceWith(template.content);
          }
        }
        const child = ${js(child)};
        const tag = '<iframe srcdoc="' + child.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"></iframe>';
        const host = document.body.appendChild(document.createElement('div'));
        ${operation}
      } catch (error) { top.postMessage({id: ${js(id)}, complete: true,
        routeError: error.message, available: [], constructed: [], errors: []}, '*'); }`;
      const raw = `<!doctype html><body><div>${script(source, "inline")}</div></body>`;
      const built = buildRunnableHtml(raw, mode === "externalized"
        ? { externalizeScript: dataScript }
        : {});
      frames.push({ id, html: built.html });
    }
  }
  const ids = frames.map((frame) => frame.id);
  const html = `<!doctype html><html><body><pre id="results"></pre><script>
    const expected = ${JSON.stringify(ids)};
    const reports = new Map();
    function publish() {
      document.querySelector('#results').textContent = JSON.stringify({
        browser: navigator.userAgent,
        reports: Array.from(reports.values()), missing: expected.filter(id => !reports.get(id)?.complete)
      });
    }
    addEventListener('message', event => {
      const data = event.data;
      if (!data || !expected.includes(data.id)) return;
      if (data.complete !== true && typeof data.shadowRootProduced !== 'boolean') return;
      reports.set(data.id, {...reports.get(data.id), ...data});
      publish();
    });
    for (const fixture of ${JSON.stringify(frames).replaceAll("<", "\\u003c")}) {
      const frame = document.createElement('iframe'); frame.sandbox = 'allow-scripts';
      frame.srcdoc = fixture.html; document.body.appendChild(frame);
    }
    publish();
  </script></body></html>`;
  return { html, ids };
}
