import { Window } from "happy-dom";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";

const win = new Window({
  url: "http://localhost/",
  width: 1280,
  height: 900,
});

const mediaQueryList = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => true,
});

Object.defineProperties(globalThis, {
  window: { configurable: true, value: win },
  document: { configurable: true, value: win.document },
  navigator: { configurable: true, value: win.navigator },
  location: { configurable: true, value: win.location },
  localStorage: { configurable: true, value: win.localStorage },
  sessionStorage: { configurable: true, value: win.sessionStorage },
  HTMLElement: { configurable: true, value: win.HTMLElement },
  HTMLButtonElement: { configurable: true, value: win.HTMLButtonElement },
  HTMLInputElement: { configurable: true, value: win.HTMLInputElement },
  HTMLImageElement: { configurable: true, value: win.HTMLImageElement },
  MouseEvent: { configurable: true, value: win.MouseEvent },
  KeyboardEvent: { configurable: true, value: win.KeyboardEvent },
  Event: { configurable: true, value: win.Event },
  CustomEvent: { configurable: true, value: win.CustomEvent },
  MutationObserver: { configurable: true, value: win.MutationObserver },
  getComputedStyle: { configurable: true, value: win.getComputedStyle },
  requestAnimationFrame: {
    configurable: true,
    value: (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 16),
  },
  cancelAnimationFrame: {
    configurable: true,
    value: (id: number) => window.clearTimeout(id),
  },
  indexedDB: { configurable: true, writable: true, value: fakeIndexedDB },
  IDBKeyRange: { configurable: true, writable: true, value: FakeIDBKeyRange },
  __APP_VERSION__: { configurable: true, value: "0.0.0-test" },
  __BUILD_TIMESTAMP__: { configurable: true, value: Date.now() },
  __BUILD_EXPIRY_DAYS__: { configurable: true, value: 60 },
});

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: mediaQueryList,
});

Object.defineProperty(window, "SyntaxError", {
  configurable: true,
  value: SyntaxError,
});
