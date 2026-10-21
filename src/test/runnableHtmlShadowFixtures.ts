// Each probe checks surviving inert content as well as absence of a root.
// This prevents an unsupported API, sanitizer error, or thrown route passing.
export const shadowBrowserRoutes: Record<string, string> = {
  documentWriteShadow: `document.write('<div id="written"><template shadowroot',
    'mode="open"><p>content</p>' + tag + '</template></div>');
    const target = document.getElementById('written');
    if (!target) throw new Error('write did not insert content');
    reportShadow(!!target.shadowRoot);
    if (!target.shadowRoot && target.querySelector('template').content.querySelector('p').textContent !== 'content')
      throw new Error('write lost inert content');`,
  documentWritelnShadow: `document.writeln('<div id="written"><template shadowrootmode="closed">' +
    '<p>content</p></template></div>');
    const target = document.getElementById('written');
    if (!target?.querySelector('template')?.content.querySelector('p'))
      throw new Error('writeln did not preserve an inert template');
    reportShadow(false);`,
  splitDocumentWriteShadow: `document.write('<div id="written"><template shadowroot');
    document.write('mode="open"><p>content</p></template></div>');
    const target = document.getElementById('written');
    if (!target) throw new Error('split write lost host');
    reportShadow(!!target.shadowRoot);`,
  movedWriterShadow: `const anchor = document.currentScript.parentElement;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    anchor.appendChild(svg); svg.appendChild(document.currentScript);
    document.write('İ'.repeat(64) + '<template shadowrootmode="open"><p>content</p></template>');
    reportShadow(!!anchor.shadowRoot);`,
  trustedTypesShadow: `if (window.trustedTypes) {
      const meta = document.createElement('meta'); meta.httpEquiv = 'Content-Security-Policy';
      meta.content = "require-trusted-types-for 'script'"; document.head.appendChild(meta);
      trustedTypes.createPolicy('default', {createHTML: () =>
        '<div><template shadowrootmode="open"><p>injected</p></template></div>'});
    }
    host.setHTMLUnsafe('<div><template shadowrootmode="open"><p>content</p></template></div>');
    const target = host.firstElementChild;
    if (target.querySelector('template')?.content.querySelector('p')?.textContent !== 'content')
      throw new Error('default policy replaced guarded markup');
    reportShadow(!!target.shadowRoot);`,
  safeHtmlParsers: `const covered = [];
    const markup = '<div><template shadowrootmode="open"><p>content</p></template></div>';
    function check(target) {
      if (!target || target.shadowRoot || !target.querySelector('template')?.content.querySelector('p'))
        throw new Error('safe parser did not preserve inert content');
    }
    for (const target of [host, document.createElement('div').attachShadow({mode:'closed'})]) {
      if (typeof target.setHTML !== 'function') continue;
      target.setHTML(markup, {sanitizer:{}}); check(target.firstElementChild); covered.push('setHTML');
    }
    if (typeof Document.parseHTML === 'function') {
      check(Document.parseHTML(markup, {sanitizer:{}}).body.firstElementChild); covered.push('parseHTML');
    }
    reportShadow(false, {covered});`,
  positionalHtmlParsers: `const covered = [];
    const markup = '<section><template shadowrootmode="open"><p>content</p></template></section>';
    for (const method of ['appendHTML', 'prependHTML', 'appendHTMLUnsafe', 'prependHTMLUnsafe',
      'beforeHTML', 'afterHTML', 'replaceWithHTML', 'beforeHTMLUnsafe', 'afterHTMLUnsafe', 'replaceWithHTMLUnsafe']) {
      for (const kind of ['element', 'text', 'shadow']) {
        const container = document.body.appendChild(document.createElement('div'));
        const target = kind === 'shadow' ? container.attachShadow({mode:'closed'}) :
          container.appendChild(kind === 'text' ? document.createTextNode('anchor') : document.createElement('div'));
        if (typeof target[method] !== 'function') continue;
        target[method](markup);
        const section = (kind === 'shadow' ? target : container).querySelector('section');
        if (!section || section.shadowRoot || !section.querySelector('template')?.content.querySelector('p'))
          throw new Error(method + ' lost inert content in ' + kind);
        covered.push(kind + '.' + method);
      }
    }
    reportShadow(false, {covered});`,
  streamingHtmlParsers: `const covered = [];
    for (const target of [host, document.createTextNode('anchor'),
      document.createElement('div').attachShadow({mode:'closed'})]) {
      for (const name of ['streamHTML', 'streamAppendHTML', 'streamPrependHTML',
        'streamBeforeHTML', 'streamAfterHTML', 'streamReplaceWithHTML']) {
        for (const suffix of ['', 'Unsafe']) {
          const method = name + suffix;
          if (typeof target[method] !== 'function') continue;
          let blocked = false;
          try { target[method](); }
          catch (error) { blocked = error.message === 'Streaming HTML parsing is unavailable in run mode'; }
          if (!blocked) throw new Error(method + ' exposed an unfiltered parser');
          covered.push(method);
        }
      }
    }
    reportShadow(false, {covered});`,
  dynamicSrcdocShadow: `const frame = host.appendChild(document.createElement('iframe'));
    frame.srcdoc = '<div id="target"><template shadowrootmode="open"><p>content</p></template></div>' +
      child;`,
  shadowBuiltinsPoison: `const parse = Document.parseHTMLUnsafe;
    const poison = () => { throw new Error('page builtin called'); };
    DOMParser.prototype.parseFromString = poison;
    Element.prototype.removeAttribute = poison;
    Element.prototype.getAttributeNames = poison;
    String.prototype.slice = poison;
    XMLSerializer.prototype.serializeToString = poison;
    const parsed = parse('<div><template shadowrootmode="open"><p>content</p></template></div>');
    const target = parsed.body.firstElementChild;
    if (!target.querySelector('template')?.content.querySelector('p')) throw new Error('inert content missing');
    reportShadow(!!target.shadowRoot);`,
};
