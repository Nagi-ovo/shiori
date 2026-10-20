import "../test/setupDom";
import { describe, expect, test } from "bun:test";
import { resolveDocumentImageResources } from "./imageResources";
import { buildRunnableHtml } from "./runnableHtml";

describe("document image resources", () => {
  test("blocks https remote images in ask mode until the document opts in", async () => {
    const result = await resolveDocumentImageResources(
      '<p>before</p><img src="https://example.com/track.png"><p>after</p>',
      { allowRemoteImages: false },
    );

    expect(result.summary.remoteImages).toBe(1);
    expect(result.summary.blockedRemoteImages).toBe(1);
    expect(result.html).not.toContain("https://example.com/track.png");
    expect(result.html).toContain("data-shiori-blocked-remote-src");
  });

  test("keeps https images when always load is allowed", async () => {
    const result = await resolveDocumentImageResources(
      '<img src="https://example.com/image.png">',
      { allowRemoteImages: true },
    );

    expect(result.summary.remoteImages).toBe(1);
    expect(result.summary.blockedRemoteImages).toBe(0);
    expect(result.html).toContain('src="https://example.com/image.png"');
  });

  test("blocks http and protocol-relative images even when remote images are allowed", async () => {
    const result = await resolveDocumentImageResources(
      [
        '<img src="http://example.com/plain.png">',
        '<img src="//example.com/protocol-relative.png">',
      ].join(""),
      { allowRemoteImages: true },
    );

    expect(result.summary.remoteImages).toBe(2);
    expect(result.summary.blockedRemoteImages).toBe(2);
    expect(result.html).not.toContain("http://example.com/plain.png");
    expect(result.html).not.toContain("//example.com/protocol-relative.png");
    expect(result.html.match(/data-shiori-blocked-remote-src/g)?.length).toBe(2);
  });

  // Each of these resolves to a remote host from tauri://localhost or
  // http://tauri.localhost (and the backslash forms from a web origin too).
  test("counts and blocks remote URLs the browser repairs, and background images", async () => {
    const result = await resolveDocumentImageResources(
      [
        '<img src="https:evil.example/pixel.png">',
        '<img src="https:\\\\evil.example/slash.png">',
        '<img src="\\\\evil.example/unc.png">',
        '<img src="/\\evil.example/mixed.png">',
        '<table background="https://evil.example/table.png"><tr><td background="//evil.example/cell.png">x</td></tr></table>',
      ].join(""),
      { allowRemoteImages: false },
    );

    expect(result.summary.remoteImages).toBe(6);
    expect(result.summary.blockedRemoteImages).toBe(6);
    expect(result.html).not.toContain("evil.example");
  });

  test("keeps a scheme-only https image when remote images are allowed", async () => {
    const result = await resolveDocumentImageResources(
      '<img src="https:example.com/image.png">',
      { allowRemoteImages: true },
    );

    expect(result.summary.remoteImages).toBe(1);
    expect(result.summary.blockedRemoteImages).toBe(0);
    expect(result.html).toContain('src="https:example.com/image.png"');
  });

  test("rewrites local relative images to data URLs", async () => {
    const result = await resolveDocumentImageResources(
      '<img src="./figures/chart.png">',
      {
        allowRemoteImages: false,
        documentPath: "/tmp/notes/doc.md",
        readLocalImage: async (documentPath, imageSrc) => {
          expect(documentPath).toBe("/tmp/notes/doc.md");
          expect(imageSrc).toBe("./figures/chart.png");
          return {
            dataUrl: "data:image/png;base64,abc",
            mime: "image/png",
            size: 3,
          };
        },
      },
    );

    expect(result.summary.localImages).toBe(1);
    expect(result.summary.failedLocalImages).toBe(0);
    expect(result.html).toContain('src="data:image/png;base64,abc"');
  });

  // The desktop reader percent-decodes the src itself (text_images.rs), so a
  // second decode here turned 100%25.png into an invalid "100%.png" and
  // a%2520b.png into "a b.png".
  test("hands the local image src to the reader still percent-encoded", async () => {
    const seen: string[] = [];
    const result = await resolveDocumentImageResources(
      '<img src="100%25.png?v=1"><img src="a%2520b.png#x"><img src="my%20chart.png">',
      {
        allowRemoteImages: false,
        documentPath: "/tmp/notes/doc.md",
        readLocalImage: async (_documentPath, imageSrc) => {
          seen.push(imageSrc);
          return { dataUrl: "data:image/png;base64,abc", mime: "image/png", size: 3 };
        },
      },
    );

    expect(seen).toEqual(["100%25.png", "a%2520b.png", "my%20chart.png"]);
    expect(result.summary.localImages).toBe(3);
  });

  test("leaves data images alone", async () => {
    const result = await resolveDocumentImageResources(
      '<img src="data:image/png;base64,abc">',
      { allowRemoteImages: false },
    );

    expect(result.summary.remoteImages).toBe(0);
    expect(result.summary.localImages).toBe(0);
    expect(result.html).toContain('src="data:image/png;base64,abc"');
  });

  test("clears remote link, media, svg image, and style resources when remote images are blocked", async () => {
    const result = await resolveDocumentImageResources(
      [
        '<!doctype html><html><head>',
        '<link rel="stylesheet" href="https://cdn.example/theme.css">',
        '<style>',
        '@import url("https://cdn.example/remote.css");',
        '.hero{background:url(https://cdn.example/hero.png)}',
        '.icon{background:url(//cdn.example/icon.png)}',
        '.local{background:url(data:image/png;base64,abc)}',
        '</style></head><body>',
        '<picture><source src="https://cdn.example/photo.webp"></picture>',
        '<video src="https://cdn.example/movie.mp4" poster="//cdn.example/poster.png"></video>',
        '<audio src="http://cdn.example/sound.mp3"></audio>',
        '<track src="https://cdn.example/captions.vtt">',
        '<svg><image href="https://cdn.example/vector.png" xlink:href="http://cdn.example/fallback.png"></image></svg>',
        '<div style="background:url(http://cdn.example/bg.png); mask-image:url(//cdn.example/mask.png); color:red"></div>',
        '</body></html>',
      ].join(""),
      { allowRemoteImages: false },
    );

    expect(result.html).not.toContain("https://cdn.example");
    expect(result.html).not.toContain("http://cdn.example");
    expect(result.html).not.toContain("//cdn.example");
    expect(result.html).toContain("data-shiori-blocked-remote-href");
    expect(result.html).toContain("data-shiori-blocked-remote-poster");
    expect(result.html).toContain("background:none");
    expect(result.html).toContain("mask-image:none");
    expect(result.html).toContain("color:red");
    expect(result.html).toContain("data:image/png;base64,abc");
    expect(result.summary.remoteImages).toBe(6);
    expect(result.summary.blockedRemoteImages).toBe(6);
  });

  test("injects static document CSP with image policy", async () => {
    const blocked = await resolveDocumentImageResources(
      '<!doctype html><html><head><title>Doc</title></head><body></body></html>',
      { allowRemoteImages: false },
    );
    const allowed = await resolveDocumentImageResources(
      '<!doctype html><html><head><title>Doc</title></head><body></body></html>',
      { allowRemoteImages: true },
    );

    const blockedCsp = firstCspContent(blocked.html);
    const allowedCsp = firstCspContent(allowed.html);

    expect(blockedCsp).toContain("script-src 'none'");
    expect(blockedCsp).toContain("connect-src 'none'");
    expect(blockedCsp).toContain("object-src 'none'");
    expect(blockedCsp).toContain("base-uri 'none'");
    expect(blockedCsp).toContain("form-action 'none'");
    expect(blockedCsp).toContain("style-src 'unsafe-inline'");
    expect(blockedCsp).toContain("img-src data: blob:");
    expect(blockedCsp).not.toContain("https:");
    expect(allowedCsp).toContain("img-src data: blob: https:");
  });

  test("hardens runnable HTML CSP and does not bridge link opens", () => {
    const { html } = buildRunnableHtml(
      [
        '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">',
        '<a href="https://example.com">open</a>',
        '<script>window.x = 1</script>',
      ].join(""),
    );
    const doc = new window.DOMParser().parseFromString(html, "text/html");
    const csp = firstCspContent(html);
    const bridgeNonce = bridgeScriptNonce(html);

    expect(
      doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length,
    ).toBe(1);
    expect(bridgeNonce).toMatch(/^[a-f0-9]{32}$/);
    // Cross-check against the DOM: the nonce the helper extracted must be
    // the one on the script element that actually contains the bridge.
    expect(
      Array.from(doc.querySelectorAll("script"))
        .find((script) =>
          script.textContent?.includes('source: "shiori-run-frame"'),
        )
        ?.getAttribute("nonce"),
    ).toBe(bridgeNonce);
    expect(csp).toContain(`script-src 'nonce-${bridgeNonce}'`);
    expect(csp).toContain("script-src-elem 'unsafe-inline'");
    expect(csp).toContain("script-src-attr 'unsafe-inline'");
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("navigate-to 'none'");
    expect(html).toContain(`<script nonce="${bridgeNonce}">window.x = 1</script>`);
    expect(html).toContain(`nonce="${bridgeNonce}"`);
    expect(html).not.toContain("script-src 'none'");
  });

  test("can externalize runnable HTML scripts for Tauri CSP", () => {
    const scripts: string[] = [];
    const { html } = buildRunnableHtml("<script>window.x = 1</script>", {
      externalizeScript: (source) => {
        scripts.push(source);
        return `data:text/javascript,shiori-test-${scripts.length}`;
      },
    });
    const doc = new window.DOMParser().parseFromString(html, "text/html");
    const csp = firstCspContent(html);
    const scriptUrls = Array.from(doc.querySelectorAll("script")).map((script) =>
      script.getAttribute("src"),
    );

    expect(csp).toContain("script-src data:");
    expect(csp).toContain("script-src-elem data:");
    expect(csp).not.toContain("script-src 'nonce");
    // Injection order in <head>: storage shim, host bridge, then the user's
    // own script in <body>.
    expect(scriptUrls).toEqual([
      "data:text/javascript,shiori-test-1",
      "data:text/javascript,shiori-test-2",
      "data:text/javascript,shiori-test-3",
    ]);
    expect(scripts[0]).toContain('install("localStorage")');
    expect(scripts[1]).toContain('source: "shiori-run-frame"');
    expect(scripts[2]).toBe("window.x = 1");
    expect(html).not.toContain("window.x = 1</script>");
    expect(html).not.toContain("data-shiori-run-nonce");
  });
});

function firstCspContent(html: string): string {
  const doc = new window.DOMParser().parseFromString(html, "text/html");
  return (
    doc
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content") ?? ""
  );
}

function bridgeScriptNonce(html: string): string {
  // Tempered body: the span between the open tag and the bridge marker may
  // not cross another script tag boundary, so the captured attribute list
  // always belongs to the <script> element containing the marker — not to
  // whatever script happens to come first (e.g. a shim injected before the
  // bridge).
  const bridgeScript = html.match(
    /<script\b([^>]*)>(?:(?!<\/?script\b)[\s\S])*?source: "shiori-run-frame"/,
  );
  return bridgeScript?.[1]?.match(/\bnonce="([^"]+)"/)?.[1] ?? "";
}
