import "../test/setupDom";
import { describe, expect, test } from "bun:test";
import {
  BRIDGE_SCRIPT,
  buildRunnableHtml,
  remoteDependencyFromViolation,
  scanRemoteDependencies,
  STORAGE_SHIM,
} from "./runnableHtml";

function parseHtml(html: string): Document {
  return new window.DOMParser().parseFromString(html, "text/html");
}

function cspContent(html: string): string {
  return (
    parseHtml(html)
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content") ?? ""
  );
}

// Run the shim source against a fake window/document, returning the fakes so a
// test can inspect what got installed. `make` lets each case decide whether the
// real storage is present (and working) or throws like the opaque sandbox does.
function runShim(make: {
  localStorage?: () => unknown;
  sessionStorage?: () => unknown;
  cookie?: () => string;
}) {
  const win: Record<string, unknown> = {};
  const define = (name: "localStorage" | "sessionStorage") => {
    const getter = make[name];
    if (getter) {
      Object.defineProperty(win, name, { configurable: true, get: getter });
    } else {
      Object.defineProperty(win, name, {
        configurable: true,
        get() {
          throw new Error("SecurityError: The operation is insecure.");
        },
      });
    }
  };
  define("localStorage");
  define("sessionStorage");

  const doc: Record<string, unknown> = {};
  Object.defineProperty(doc, "cookie", {
    configurable: true,
    get: make.cookie
      ? make.cookie
      : () => {
          throw new Error("SecurityError: The operation is insecure.");
        },
    set() {},
  });

  new Function("window", "document", STORAGE_SHIM)(win, doc);
  return { win, doc };
}

describe("runnable html prelude", () => {
  // CSP does not govern WebRTC: an ICE candidate to a STUN host of the
  // document's choosing would reach the network with nothing approved.
  test("removes WebRTC before the document's scripts run", () => {
    const storage = { getItem: () => null };
    const win: Record<string, unknown> = {
      localStorage: storage,
      sessionStorage: storage,
      RTCPeerConnection: function RTCPeerConnection() {},
      webkitRTCPeerConnection: function webkitRTCPeerConnection() {},
    };
    new Function("window", "document", STORAGE_SHIM)(win, { cookie: "" });

    expect(win.RTCPeerConnection).toBeUndefined();
    expect(win.webkitRTCPeerConnection).toBeUndefined();
  });
});

describe("runnable html storage shim", () => {
  test("injects the shim ahead of the host bridge and user scripts", () => {
    const { html } = buildRunnableHtml(
      '<html><head></head><body><script>window.__USER__ = localStorage.getItem("k");</script></body></html>',
    );
    const shimAt = html.indexOf('install("localStorage")');
    const userAt = html.indexOf("__USER__");
    expect(shimAt).toBeGreaterThanOrEqual(0);
    expect(userAt).toBeGreaterThanOrEqual(0);
    // The shim must come first so a top-level localStorage access resolves to
    // the in-memory replacement rather than the throwing sandbox original.
    expect(shimAt).toBeLessThan(userAt);
    // It must not carry the literal closing tag that would end the script early.
    expect(STORAGE_SHIM).not.toContain("</" + "script>");
  });

  test("provides an in-memory localStorage when the real one throws", () => {
    const { win } = runShim({});
    const ls = win.localStorage as Storage & Record<string, string>;

    // Method API.
    expect(ls.getItem("missing")).toBeNull();
    ls.setItem("a", "1");
    expect(ls.getItem("a")).toBe("1");
    expect(ls.length).toBe(1);
    ls.setItem("b", "2");
    expect(ls.key(0)).toBe("a");
    expect(ls.key(1)).toBe("b");
    expect(ls.key(9)).toBeNull();

    // Property access — real Storage exposes keys as properties; lots of pages
    // rely on `localStorage.foo`.
    ls.foo = "bar";
    expect(ls.foo).toBe("bar");
    expect("foo" in ls).toBe(true);
    expect("nope" in ls).toBe(false);
    expect(Object.keys(ls).sort()).toEqual(["a", "b", "foo"]);
    expect((ls as Record<string, unknown>).missing).toBeUndefined();

    // Mutation paths.
    ls.removeItem("a");
    expect(ls.getItem("a")).toBeNull();
    delete ls.foo;
    expect("foo" in ls).toBe(false);
    ls.clear();
    expect(ls.length).toBe(0);

    // Coercion mirrors the spec (values are stringified).
    ls.setItem("n", 42 as unknown as string);
    expect(ls.getItem("n")).toBe("42");

    // sessionStorage is installed too and independent of localStorage.
    const ss = win.sessionStorage as Storage;
    ss.setItem("x", "y");
    expect(ss.getItem("x")).toBe("y");
    expect((win.localStorage as Storage).getItem("x")).toBeNull();
  });

  test("drops writes that would shadow a storage API method", () => {
    const { win } = runShim({});
    const ls = win.localStorage as Storage;

    // Deliberate divergence from real Storage, where the assignment shadows
    // and breaks the method: the shim drops the write to keep its API usable.
    expect(() => {
      (ls as unknown as Record<string, unknown>).setItem = "x";
    }).not.toThrow();
    expect(typeof ls.setItem).toBe("function");
    ls.setItem("a", "1");
    expect(ls.getItem("a")).toBe("1");
    // The dropped write must not be observable as data either.
    expect(ls.getItem("setItem")).toBeNull();
    expect(Object.keys(ls)).toEqual(["a"]);
  });

  test("gives an in-memory document.cookie when the real one throws", () => {
    const { doc } = runShim({});
    const d = doc as { cookie: string };
    expect(d.cookie).toBe("");
    d.cookie = "lang=zh; path=/; SameSite=Lax";
    d.cookie = "theme=dark";
    expect(d.cookie).toContain("lang=zh");
    expect(d.cookie).toContain("theme=dark");
    // Attributes (path, SameSite, …) are dropped — only the name=value survives.
    expect(d.cookie).not.toContain("path=/");
  });

  test("deletes a cookie via Max-Age <= 0 or a past expires date", () => {
    const { doc } = runShim({});
    const d = doc as { cookie: string };

    // Canonical deletion idiom; attribute names match case-insensitively.
    d.cookie = "k=v";
    expect(d.cookie).toBe("k=v");
    d.cookie = "k=; max-age=0";
    expect(d.cookie).toBe("");

    d.cookie = "k=v2";
    d.cookie = "k=; Max-Age=-1";
    expect(d.cookie).toBe("");

    d.cookie = "k=v3";
    d.cookie = "k=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    expect(d.cookie).toBe("");

    // Deleting a name that was never set is harmless.
    d.cookie = "ghost=; Max-Age=0";
    expect(d.cookie).toBe("");

    // Plain set/read still works, and non-deleting attributes keep the cookie.
    d.cookie = "keep=1; path=/; SameSite=Lax";
    expect(d.cookie).toBe("keep=1");
    d.cookie = "later=2; expires=Fri, 01 Jan 2100 00:00:00 GMT";
    expect(d.cookie).toContain("later=2");
    // A positive Max-Age outranks a past Expires (RFC 6265 precedence).
    d.cookie = "ranked=3; Max-Age=3600; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    expect(d.cookie).toContain("ranked=3");
  });

  test("stays inert when real storage works (does not replace it)", () => {
    const real = { getItem: () => "real", setItem: () => {} };
    const { win } = runShim({
      localStorage: () => real,
      sessionStorage: () => real,
      cookie: () => "real=1",
    });
    // The working storage must be left untouched.
    expect(win.localStorage).toBe(real);
    expect((win.localStorage as { getItem: () => string }).getItem()).toBe(
      "real",
    );
  });
});

describe("remote dependency scanner", () => {
  test("collects http(s) scripts, stylesheets, images, frames, and media", () => {
    const doc = parseHtml(
      [
        "<html><head>",
        '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js"></script>',
        '<link rel="stylesheet" href="https://fonts.example/style.css">',
        '<link rel="icon" href="https://fonts.example/favicon.ico">',
        "</head><body>",
        '<img src="http://cdn.example/pic.png">',
        '<iframe src="https://embed.example/widget"></iframe>',
        '<video src="https://media.example/clip.mp4">',
        '<source src="https://media.example/alt.webm">',
        "</video>",
        '<audio src="https://media.example/sound.mp3"></audio>',
        "</body></html>",
      ].join(""),
    );

    const deps = scanRemoteDependencies(doc);

    expect(deps).toEqual([
      {
        url: "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js",
        origin: "https://cdnjs.cloudflare.com",
        kind: "script",
      },
      {
        url: "https://fonts.example/style.css",
        origin: "https://fonts.example",
        kind: "stylesheet",
      },
      {
        url: "http://cdn.example/pic.png",
        origin: "http://cdn.example",
        kind: "image",
      },
      {
        url: "https://embed.example/widget",
        origin: "https://embed.example",
        kind: "frame",
      },
      {
        url: "https://media.example/clip.mp4",
        origin: "https://media.example",
        kind: "media",
      },
      {
        url: "https://media.example/alt.webm",
        origin: "https://media.example",
        kind: "media",
      },
      {
        url: "https://media.example/sound.mp3",
        origin: "https://media.example",
        kind: "media",
      },
    ]);
  });

  test("ignores relative, data:, blob:, and non-network URLs", () => {
    const doc = parseHtml(
      [
        '<script src="./app.js"></script>',
        '<script src="/assets/lib.js"></script>',
        '<script src="lib.js"></script>',
        '<script src="blob:https://example.com/123"></script>',
        '<img src="data:image/png;base64,abc">',
        '<img src="figures/chart.png">',
        '<link rel="stylesheet" href="theme.css">',
        '<iframe src="about:blank"></iframe>',
        '<script src="javascript:alert(1)"></script>',
      ].join(""),
    );

    expect(scanRemoteDependencies(doc)).toEqual([]);
  });

  test("treats protocol-relative URLs as https", () => {
    const doc = parseHtml('<script src="//cdn.example/lib.js"></script>');

    expect(scanRemoteDependencies(doc)).toEqual([
      {
        url: "https://cdn.example/lib.js",
        origin: "https://cdn.example",
        kind: "script",
      },
    ]);
  });

  test("dedupes repeated references but keeps distinct kinds apart", () => {
    const doc = parseHtml(
      [
        '<script src="https://cdn.example/a.js"></script>',
        '<script src="https://cdn.example/a.js"></script>',
        '<img src="https://cdn.example/a.js">',
      ].join(""),
    );

    const deps = scanRemoteDependencies(doc);

    expect(deps).toHaveLength(2);
    expect(deps.map((dep) => dep.kind).sort()).toEqual(["image", "script"]);
  });

  test("buildRunnableHtml reports the scan alongside the built document", () => {
    const result = buildRunnableHtml(
      '<script src="https://cdnjs.cloudflare.com/three.min.js"></script>',
    );

    expect(result.remoteDependencies).toEqual([
      {
        url: "https://cdnjs.cloudflare.com/three.min.js",
        origin: "https://cdnjs.cloudflare.com",
        kind: "script",
      },
    ]);
    // The injected shim/bridge scripts must never show up as dependencies.
    expect(result.html).toContain('install("localStorage")');
  });

  test("maps runtime CSP violations onto scan-shaped entries", () => {
    expect(
      remoteDependencyFromViolation(
        "https://cdnjs.cloudflare.com/three.min.js",
        "script-src-elem",
      ),
    ).toEqual({
      url: "https://cdnjs.cloudflare.com/three.min.js",
      origin: "https://cdnjs.cloudflare.com",
      kind: "script",
    });
    expect(
      remoteDependencyFromViolation("https://fonts.example/a.woff2", "font-src"),
    ).toEqual({
      url: "https://fonts.example/a.woff2",
      origin: "https://fonts.example",
      kind: "font",
    });
    // Non-network blocked URIs are noise, not remote dependencies.
    expect(remoteDependencyFromViolation("inline", "script-src")).toBeNull();
    expect(remoteDependencyFromViolation("eval", "script-src")).toBeNull();
    expect(remoteDependencyFromViolation("data", "img-src")).toBeNull();
    expect(remoteDependencyFromViolation("", "img-src")).toBeNull();
  });

  test("bridge script survives serialization", () => {
    // Same constraint as the storage shim: the inline source must not carry
    // the literal closing tag, or serialization would truncate the script.
    expect(BRIDGE_SCRIPT).not.toContain("</" + "script>");
  });
});

describe("approved remote origins", () => {
  test("adds each approved origin only to its matching directive", () => {
    const { html } = buildRunnableHtml("<script>window.x = 1</script>", {
      allowRemoteOrigins: {
        script: ["https://cdnjs.cloudflare.com"],
        stylesheet: ["https://fonts.googleapis.com"],
        image: ["https://img.example"],
        media: ["https://media.example"],
      },
    });
    const csp = cspContent(html);

    expect(csp).toContain(
      "script-src-elem 'unsafe-inline' https://cdnjs.cloudflare.com",
    );
    expect(csp).toContain(
      "style-src 'unsafe-inline' https://fonts.googleapis.com",
    );
    expect(csp).toContain("img-src data: blob: https://img.example");
    expect(csp).toContain("media-src data: blob: https://media.example");
    // The exfiltration channels stay sealed no matter what was approved.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("navigate-to 'none'");
    // No blanket https: source token anywhere.
    expect(csp.split(/[\s;]+/)).not.toContain("https:");
    // script-src (the inline/eval policy) must not gain the origin — only the
    // element-fetching directive does.
    expect(csp).toMatch(
      /script-src 'nonce-[a-f0-9]{32}' 'unsafe-inline' 'unsafe-eval';/,
    );
  });

  test("keeps data: while adding script origins in externalized mode", () => {
    const { html } = buildRunnableHtml("<script>window.x = 1</script>", {
      externalizeScript: () => "data:text/javascript,x",
      allowRemoteOrigins: { script: ["https://cdn.example"] },
    });
    const csp = cspContent(html);

    expect(csp).toContain("script-src data:; ");
    expect(csp).toContain("script-src-elem data: https://cdn.example");
    expect(csp).toContain("connect-src 'none'");
  });

  test("drops approved values that are not bare http(s) origins", () => {
    const { html } = buildRunnableHtml("<p>x</p>", {
      allowRemoteOrigins: {
        script: [
          "https://ok.example",
          "https://evil.example/path",
          "javascript:alert(1)",
          "https://ok.example; connect-src *",
          "not a url",
          "",
        ],
      },
    });
    const csp = cspContent(html);

    expect(csp).toContain("script-src-elem 'unsafe-inline' https://ok.example");
    expect(csp).not.toContain("evil.example");
    expect(csp).not.toContain("javascript:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("connect-src *");
  });

  test("scan → approve → rebuild round trip allows the blocked origin", () => {
    const raw =
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/three.min.js"></script>';
    const first = buildRunnableHtml(raw);
    expect(cspContent(first.html)).not.toContain("cdnjs.cloudflare.com");
    expect(first.remoteDependencies.map((dep) => dep.kind)).toEqual([
      "script",
    ]);

    const second = buildRunnableHtml(raw, {
      allowRemoteOrigins: {
        script: first.remoteDependencies.map((dep) => dep.origin),
      },
    });
    const csp = cspContent(second.html);

    expect(csp).toContain(
      "script-src-elem 'unsafe-inline' https://cdnjs.cloudflare.com",
    );
    expect(csp).toContain("connect-src 'none'");
    // The scan itself is approval-independent.
    expect(second.remoteDependencies).toEqual(first.remoteDependencies);
  });

  // No CSP directive stops a frame navigating itself (navigate-to never
  // shipped), and a refresh beacons the open without running any script.
  test("drops meta refresh so the document cannot navigate itself away", () => {
    const { html } = buildRunnableHtml(
      '<head><meta http-equiv=" Refresh " content="0; url=https://tracker.example/?opened=1"></head><p>x</p>',
    );

    expect(html).not.toContain("tracker.example");
  });

  // Static check: only the embedding page's frame-src stops script in the
  // run frame from navigating it (location.href = …) to beacon the open.
  // The desktop CSP has it; the web app must send the same directive.
  test("the web app ships the desktop app's frame-src", async () => {
    const root = new URL("../../", import.meta.url);
    const conf = await Bun.file(new URL("src-tauri/tauri.conf.json", root)).json();
    const headers = await Bun.file(new URL("public/_headers", root)).text();
    const frameSrc = /frame-src [^;]*/.exec(String(conf.app.security.csp))?.[0];

    expect(frameSrc).toBe("frame-src 'self' blob:");
    expect(headers).toMatch(/^\/\*\n(?:[ \t]+.*\n)*?[ \t]+Content-Security-Policy: frame-src 'self' blob:\s*$/m);
  });
});
