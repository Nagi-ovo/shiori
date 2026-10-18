import "../test/setupDom";
import { describe, expect, test } from "bun:test";
import { createPdfEditorStore, type PdfEditorStoreApi } from "../editor/store/store";
import { NATIVE_APP_EXIT_REQUEST_EVENT } from "../platform/appExit";
import { createNativeMenu, type NativeMenuPorts } from "./nativeMenu";

const EXIT = NATIVE_APP_EXIT_REQUEST_EVENT;

/**
 * Every channel subscribes at once except the exit request, which waits until
 * `subscribeExit` — the window in which Rust still holds ⌘Q.
 */
function setup(overrides: Partial<NativeMenuPorts> = {}) {
  const events: string[] = [];
  const handlers = new Map<string, () => void>();
  let subscribeExit = () => {};
  const exitSubscribed = new Promise<void>((resolve) => {
    subscribeExit = resolve;
  });
  const ports: NativeMenuPorts = {
    listen: async (channel, run) => {
      if (channel === EXIT) await exitSubscribed;
      events.push(`listen:${channel}`);
      handlers.set(channel, run);
      return () => events.push(`off:${channel}`);
    },
    setExitGuardReady: async (ready) => {
      events.push(`guard:${ready}`);
    },
    activeEditor: () => createPdfEditorStore(),
    completeExitRequest: () => events.push("exit"),
    checkForUpdates: () => {},
    openSettings: () => {},
    print: () => {},
    copiedAnnotations: () => {},
    installFailed: (error) => {
      throw error;
    },
    ...overrides,
  };
  const fire = (channel: string) => handlers.get(channel)?.();
  return { menu: createNativeMenu(ports), events, subscribeExit, fire };
}

const settle = () => Bun.sleep(0);
const listened = (events: string[]) =>
  events.filter((e) => e.startsWith("listen:")).map((e) => e.slice("listen:".length));
const released = (events: string[]) =>
  events.filter((e) => e.startsWith("off:")).map((e) => e.slice("off:".length));

describe("the native menu and the exit guard", () => {
  test("the guard reports ready only once the exit request can reach it", async () => {
    const { menu, events, subscribeExit, fire } = setup();

    menu.install();
    await settle();
    expect(events).not.toContain("guard:true");

    subscribeExit();
    await settle();
    expect(events.indexOf("guard:true")).toBeGreaterThan(events.indexOf(`listen:${EXIT}`));

    fire(EXIT);
    expect(events).toContain("exit");
  });

  // React tears the effect down before the async wiring ends (StrictMode,
  // HMR). Whatever subscribes afterwards must not be left listening, and the
  // guard must not claim to be ready for a menu that is gone.
  test("tearing down mid-install leaves nothing subscribed and the guard off", async () => {
    const { menu, events, subscribeExit } = setup();

    const dispose = menu.install();
    await settle();
    dispose();
    subscribeExit();
    await settle();

    expect(listened(events)).toContain(EXIT);
    expect(released(events).sort()).toEqual(listened(events).sort());
    expect(events).toContain("guard:false");
    expect(events).not.toContain("guard:true");
  });

  test("an item acts on the document on screen when it fires", async () => {
    const first = createPdfEditorStore();
    const second = createPdfEditorStore();
    let onScreen: PdfEditorStoreApi = first;
    const { menu, subscribeExit, fire } = setup({ activeEditor: () => onScreen });

    menu.install();
    subscribeExit();
    await settle();
    onScreen = second; // the reader switches tabs after the menu was wired
    second.getState().setScale(1.25);
    const before = first.getState().scale;
    fire("menu:zoom-in");

    expect(first.getState().scale).toBe(before);
    expect(second.getState().scale).toBe(1.5);
  });

  // The menu stepped by a fixed 0.1 while the toolbar walked the ladder:
  // 125% went to 135%, and 100% could not be reached again from a fit.
  test("zoom in and out walk the toolbar's ladder", async () => {
    const editor = createPdfEditorStore();
    const { menu, subscribeExit, fire } = setup({ activeEditor: () => editor });
    menu.install();
    subscribeExit();
    await settle();
    editor.getState().setScale(1.497);

    fire("menu:zoom-out");
    expect(editor.getState().scale).toBe(1.25);
    fire("menu:zoom-out");
    expect(editor.getState().scale).toBe(1.1);
    fire("menu:zoom-out");
    expect(editor.getState().scale).toBe(1);
    fire("menu:zoom-in");
    expect(editor.getState().scale).toBe(1.1);
  });
});
