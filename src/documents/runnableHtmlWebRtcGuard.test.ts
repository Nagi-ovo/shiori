import "../test/setupDom";
import { describe, expect, test } from "bun:test";
import { buildRunnableHtml, STORAGE_SHIM } from "./runnableHtml";

// The run frame's CSP stops every fetched child frame (default-src 'none'),
// but an about:blank or srcdoc child is never fetched. Where the engine makes
// it same-origin with the run frame, it hands the document a fresh realm whose
// RTCPeerConnection was never removed, and CSP does not govern ICE traffic.
// These fakes model that realm graph: each realm has its own constructors,
// prototypes, frames list, observers and load listeners, so the shim is
// exercised without patching the shared test window's prototypes.

type Realm = {
  win: Record<string | number, unknown>;
  // Inserts a child the way the HTML parser does: no DOM method is called.
  parserInsert: (child: Realm) => FakeFrame;
  // Replaces the realm behind frames[index], as a navigation does.
  navigate: (index: number, next: Realm) => void;
  flushObservers: () => void;
  fireLoad: () => void;
};

type FakeElement = { kind: string; attrs: Record<string, string> };
type FakeFrame = FakeElement & { realm: Realm };

const defineOwn = Object.defineProperty;
const framesOf = new WeakMap<object, Realm[]>();
// Like the engine's getter, it reads whichever window it is called on.
function windowLength(this: object) {
  return framesOf.get(this)?.length ?? 0;
}

function fakeRealm(): Realm {
  const frames: Realm[] = [];
  const observers: Array<() => void> = [];
  const loadListeners: Array<() => void> = [];
  const elementProto: Record<string, unknown> = {
    setAttribute(this: FakeElement, name: string, value: string) {
      this.attrs[name.toLowerCase()] = value;
    },
    setAttributeNS(this: FakeElement, ns: string | null, name: string, value: string) {
      this.attrs[ns ? `${ns}|${name}` : name] = value;
    },
  };
  Object.defineProperty(elementProto, "localName", {
    configurable: true,
    get(this: FakeElement) {
      return this.kind;
    },
  });
  const frameProto: Record<string, unknown> = Object.create(elementProto);
  Object.defineProperty(frameProto, "srcdoc", {
    configurable: true,
    get(this: FakeElement) {
      return this.attrs.srcdoc ?? "";
    },
    set(this: FakeElement, value: string) {
      this.attrs.srcdoc = value;
    },
  });
  Object.defineProperty(frameProto, "contentWindow", {
    configurable: true,
    get(this: FakeFrame) {
      return this.realm.win;
    },
  });
  const storage = { getItem: () => null };
  const win: Record<string | number, unknown> = {
    RTCPeerConnection: function RTCPeerConnection() {},
    webkitRTCPeerConnection: function webkitRTCPeerConnection() {},
    localStorage: storage,
    sessionStorage: storage,
    HTMLIFrameElement: { prototype: frameProto },
    Element: { prototype: elementProto },
    Node: {
      prototype: {
        appendChild(node: FakeFrame) {
          attach(node.realm);
          return node;
        },
      },
    },
    MutationObserver: class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
    },
  };
  win.document = {
    cookie: "",
    addEventListener(type: string, listener: () => void, capture?: boolean) {
      if (type === "load" && capture) loadListeners.push(listener);
    },
  };
  framesOf.set(win, frames);
  // [Replaceable] like the real one: a page can shadow it with its own value.
  Object.defineProperty(win, "length", { configurable: true, get: windowLength });
  function attach(child: Realm) {
    const index = frames.length;
    frames.push(child);
    // The engine's own, which page script cannot replace.
    defineOwn(win, index, {
      configurable: true,
      get: () => frames[index].win,
    });
  }
  return {
    win,
    parserInsert(child) {
      attach(child);
      return frameOf(win, child);
    },
    navigate(index, next) {
      frames[index] = next;
    },
    flushObservers: () => observers.forEach((callback) => callback()),
    fireLoad: () => loadListeners.forEach((listener) => listener()),
  };
}

function frameOf(owner: Record<string | number, unknown>, child: Realm) {
  const ctor = owner.HTMLIFrameElement as { prototype: object };
  return Object.assign(Object.create(ctor.prototype), {
    realm: child,
    kind: "iframe",
    attrs: {},
  });
}

function appendFrame(parent: Realm, child: Realm) {
  const node = parent.win.Node as {
    prototype: { appendChild: (node: FakeFrame) => FakeFrame };
  };
  return node.prototype.appendChild.call({}, frameOf(parent.win, child));
}

// The script element the shim runs from, as document.currentScript sees it.
type RunScript = { src: string; nonce?: string; textContent?: string };

function runShim(top: Realm, currentScript?: RunScript) {
  (top.win.document as { currentScript?: RunScript }).currentScript = currentScript;
  new Function("window", "document", STORAGE_SHIM)(top.win, top.win.document);
}

function rtcOf(realm: Realm) {
  return [realm.win.RTCPeerConnection, realm.win.webkitRTCPeerConnection];
}

describe("run frame WebRTC guard in nested frames", () => {
  test("a child frame reached through contentWindow has no WebRTC", () => {
    const top = fakeRealm();
    runShim(top);
    const child = fakeRealm();
    const frame = frameOf(top.win, child) as { contentWindow: Realm["win"] };

    expect(frame.contentWindow.RTCPeerConnection).toBeUndefined();
    expect(rtcOf(child)).toEqual([undefined, undefined]);
  });

  test("a child frame is stripped by the time appendChild returns", () => {
    const top = fakeRealm();
    runShim(top);
    const child = fakeRealm();
    appendFrame(top, child);

    // frames[0] reaches the child without any patchable getter.
    const first = top.win[0] as Realm["win"];
    expect(first.RTCPeerConnection).toBeUndefined();
    expect(first.webkitRTCPeerConnection).toBeUndefined();
  });

  test("a parser-inserted child frame is stripped before the next script", () => {
    const top = fakeRealm();
    runShim(top);
    const child = fakeRealm();
    top.parserInsert(child);
    // The parser runs a microtask checkpoint before each script, which
    // delivers mutation records.
    top.flushObservers();

    expect(rtcOf(child)).toEqual([undefined, undefined]);
  });

  test("a child frame that navigates loses WebRTC in its new realm", () => {
    const top = fakeRealm();
    runShim(top);
    appendFrame(top, fakeRealm());
    const next = fakeRealm();
    top.navigate(0, next);
    top.fireLoad();

    expect(rtcOf(next)).toEqual([undefined, undefined]);
  });

  test("a grandchild frame created from inside a child has no WebRTC", () => {
    const top = fakeRealm();
    runShim(top);
    const child = fakeRealm();
    appendFrame(top, child);
    const grandchild = fakeRealm();
    appendFrame(child, grandchild);

    expect(rtcOf(grandchild)).toEqual([undefined, undefined]);
  });

  test("a page that tampers with built-ins still gets no WebRTC in a child", () => {
    const top = fakeRealm();
    runShim(top);
    const child = fakeRealm();
    let leaked: unknown = "not read";
    const defineProperty = Object.defineProperty;
    const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const apply = Function.prototype.apply;
    const poisoned = Object.getOwnPropertyDescriptor(Object.prototype, "get");
    // What a document's own script could do after the guard has run.
    Object.defineProperty(top.win, "length", { value: 0 });
    Object.defineProperty(Object.prototype, "get", {
      configurable: true,
      writable: true,
      value: function poison() {},
    });
    Object.defineProperty = ((target: object) => target) as typeof defineProperty;
    Object.getOwnPropertyDescriptor = () => ({
      value: undefined,
      writable: false,
    });
    Function.prototype.apply = function (
      this: (...args: unknown[]) => unknown,
      self: unknown,
      args: unknown[],
    ) {
      const result = Reflect.apply(this, self, args);
      const first = top.win[0] as Realm["win"] | undefined;
      if (first) leaked = first.RTCPeerConnection;
      return result;
    };
    try {
      appendFrame(top, child);
    } finally {
      Function.prototype.apply = apply;
      Object.defineProperty = defineProperty;
      Object.getOwnPropertyDescriptor = getOwnPropertyDescriptor;
      if (poisoned) Object.defineProperty(Object.prototype, "get", poisoned);
      else delete (Object.prototype as Record<string, unknown>).get;
    }

    // Read between the insertion and the guard's sweep, or never.
    expect(typeof leaked).not.toBe("function");
    expect(rtcOf(child)).toEqual([undefined, undefined]);
  });

  test("a srcdoc set from script runs the guard before its own scripts", () => {
    const user = "<script>new RTCPeerConnection()</script>";
    const external = { src: "data:text/javascript;charset=utf-8,guard" };
    const inline = { src: "", nonce: "n0nce", textContent: "guard()" };
    const cases: Array<[RunScript, string]> = [
      [external, `<script src="${external.src}"></script>`],
      [inline, `<script nonce="n0nce">guard()</script>`],
    ];
    for (const [currentScript, prefix] of cases) {
      const top = fakeRealm();
      runShim(top, currentScript);
      type Settable = FakeFrame & {
        srcdoc: string;
        setAttribute: (name: string, value: string) => void;
        setAttributeNS: (ns: string | null, name: string, value: string) => void;
      };
      const frame = frameOf(top.win, fakeRealm()) as Settable;

      frame.srcdoc = user;
      expect(frame.attrs.srcdoc).toBe(prefix + user);
      const current = frame.srcdoc;
      frame.srcdoc = current;
      expect(frame.attrs.srcdoc).toBe(prefix + user);
      frame.setAttribute("SRCDOC", user);
      expect(frame.attrs.srcdoc).toBe(prefix + user);
      frame.setAttributeNS(null, "srcdoc", user);
      expect(frame.attrs.srcdoc).toBe(prefix + user);

      const div = Object.assign(Object.create(frameOf(top.win, fakeRealm())), {
        kind: "div",
        attrs: {},
      }) as Settable;
      div.setAttribute("srcdoc", user);
      expect(div.attrs.srcdoc).toBe(user);
    }
  });

  test("a srcdoc in the document runs the guard before its own scripts", () => {
    const user = "new RTCPeerConnection()";
    const toUrl = (source: string) =>
      `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
    const parse = (html: string) => new window.DOMParser().parseFromString(html, "text/html");
    for (const options of [{ externalizeScript: toUrl }, {}]) {
      const { html } = buildRunnableHtml(
        `<iframe srcdoc="<script>${user}</script>"></iframe>`,
        options,
      );
      const srcdoc = parse(html).querySelector("iframe")?.getAttribute("srcdoc") ?? "";
      const scripts = Array.from(parse(srcdoc).querySelectorAll("script"));
      const src = scripts[0]?.getAttribute("src");
      const first = src
        ? decodeURIComponent(src.slice(src.indexOf(",") + 1))
        : scripts[0]?.textContent;

      expect(first).toBe(STORAGE_SHIM);
      expect(scripts.map((script) => script.textContent).at(-1)).toBe(user);
      expect(scripts).toHaveLength(2);
    }
  });

  test("WebRTC is removed where a window refuses non-configurable properties", () => {
    const top = fakeRealm();
    const strict = new Proxy(top.win, {
      defineProperty(target, key, desc) {
        if (desc.configurable === false) throw new TypeError("WindowProxy");
        return Reflect.defineProperty(target, key, desc);
      },
    });
    new Function("window", "document", STORAGE_SHIM)(strict, top.win.document);

    expect(rtcOf(top)).toEqual([undefined, undefined]);
  });

  test("the run CSP blocks WebRTC where the engine implements it", () => {
    // Inherited by about:blank and srcdoc children, which covers a child
    // whose own scripts run before the parent can reach it.
    const { html } = buildRunnableHtml("<p>x</p>");
    const csp = new window.DOMParser()
      .parseFromString(html, "text/html")
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content");
    expect(csp).toContain("webrtc 'block'");
  });
});
