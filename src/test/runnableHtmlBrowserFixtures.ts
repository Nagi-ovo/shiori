import { buildRunnableHtml } from "../documents/runnableHtml";

// Each route runs in its own opaque frame: poisoning must not affect the
// runner, another case, or the child whose FIRST script reports the result.
export const browserRoutes: Record<string, string> = {
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
    host.firstElementChild.shadowRoot.innerHTML = tag;`,
  adoptedOpenShadow: `const parsed = Document.parseHTMLUnsafe(
    '<div><template shadowrootmode="open">' + tag + '</template></div>');
    host.appendChild(document.adoptNode(parsed.body.firstElementChild));`,
  adoptedClosedShadow: `const parsed = Document.parseHTMLUnsafe(
    '<div><template shadowrootmode="closed">' + tag + '</template></div>');
    host.appendChild(document.adoptNode(parsed.body.firstElementChild));`,
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
};

export type BrowserProbe = {
  id: string;
  complete: true;
  available: string[];
  constructed: string[];
  errors: string[];
  routeError?: string;
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

function childDocument(id: string, mode: BrowserMode): string {
  return script(`(() => {
    const result = { id: ${js(id)}, complete: true, available: [], constructed: [], errors: [] };
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
      const child = childDocument(id, mode);
      const source = `try {
        const child = ${js(child)};
        const tag = '<iframe srcdoc="' + child.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '"></iframe>';
        const host = document.body.appendChild(document.createElement('div'));
        ${operation}
      } catch (error) { top.postMessage({id: ${js(id)}, complete: true,
        routeError: error.message, available: [], constructed: [], errors: []}, '*'); }`;
      const raw = `<!doctype html><body>${script(source, "inline")}</body>`;
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
        reports: Array.from(reports.values()), missing: expected.filter(id => !reports.has(id))
      });
    }
    addEventListener('message', event => {
      const data = event.data;
      if (!data || data.complete !== true || !expected.includes(data.id)) return;
      if (!reports.has(data.id)) reports.set(data.id, data);
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
