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

type FakeFrame = { realm: Realm };

function fakeRealm(): Realm {
  const frames: Realm[] = [];
  const observers: Array<() => void> = [];
  const loadListeners: Array<() => void> = [];
  const frameProto: Record<string, unknown> = {};
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
  Object.defineProperty(win, "length", { get: () => frames.length });
  function attach(child: Realm) {
    const index = frames.length;
    frames.push(child);
    Object.defineProperty(win, index, {
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
  return Object.assign(Object.create(ctor.prototype), { realm: child });
}

function appendFrame(parent: Realm, child: Realm) {
  const node = parent.win.Node as {
    prototype: { appendChild: (node: FakeFrame) => FakeFrame };
  };
  return node.prototype.appendChild.call({}, frameOf(parent.win, child));
}

function runShim(top: Realm) {
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
