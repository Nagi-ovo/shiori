import "../test/setupDom";
import { afterEach, describe, expect, test } from "bun:test";
import {
  ANDROID_SAFE_AREA_EVENT,
  installAndroidShellSync,
  parseSafeAreaInsets,
  safeAreaCssVars,
} from "./androidShell";

type Bridge = NonNullable<Window["ShioriAndroid"]>;

function installBridge(bridge: Bridge) {
  Object.defineProperty(window, "ShioriAndroid", {
    configurable: true,
    writable: true,
    value: bridge,
  });
}

describe("Android shell sync", () => {
  afterEach(() => {
    delete (window as { ShioriAndroid?: Bridge }).ShioriAndroid;
    const root = document.documentElement;
    for (const name of [
      "--shiori-safe-top",
      "--shiori-safe-bottom",
      "--shiori-safe-left",
      "--shiori-safe-right",
      "color-scheme",
    ]) {
      root.style.removeProperty(name);
    }
  });

  test("parses bridge JSON and event details, rejecting anything partial", () => {
    expect(
      parseSafeAreaInsets('{"top":24,"bottom":16.5,"left":0,"right":0}'),
    ).toEqual({ top: 24, bottom: 16.5, left: 0, right: 0 });
    expect(parseSafeAreaInsets({ top: 24, bottom: 16, left: 0, right: 0 })).toEqual(
      { top: 24, bottom: 16, left: 0, right: 0 },
    );
    expect(parseSafeAreaInsets({ top: 24, bottom: -1, left: 0, right: 0 })).toBe(
      null,
    );
    expect(parseSafeAreaInsets({ top: 24 })).toBe(null);
    expect(parseSafeAreaInsets("not json")).toBe(null);
    expect(parseSafeAreaInsets(null)).toBe(null);
  });

  test("maps insets onto the safe-area variables the layout already reads", () => {
    expect(safeAreaCssVars({ top: 24, bottom: 16.333, left: 0, right: 0 })).toEqual({
      "--shiori-safe-top": "24px",
      "--shiori-safe-bottom": "16.33px",
      "--shiori-safe-left": "0px",
      "--shiori-safe-right": "0px",
    });
  });

  test("pulls the insets at boot, follows pushes, and mirrors the colour scheme", async () => {
    const appearance: boolean[] = [];
    installBridge({
      safeAreaInsets: () => '{"top":24,"bottom":48,"left":0,"right":0}',
      setSystemBarsAppearance: (dark: boolean) => {
        appearance.push(dark);
        return '{"ok":true}';
      },
    });
    const root = document.documentElement;
    root.style.setProperty("color-scheme", "light");

    const uninstall = installAndroidShellSync({ enabled: true });
    expect(root.style.getPropertyValue("--shiori-safe-bottom")).toBe("48px");
    expect(root.style.getPropertyValue("--shiori-safe-top")).toBe("24px");
    expect(appearance).toEqual([false]);

    // Reader mode hides the bars; the shell pushes the new insets.
    window.dispatchEvent(
      new window.CustomEvent(ANDROID_SAFE_AREA_EVENT, {
        detail: { top: 0, bottom: 0, left: 0, right: 0 },
      }),
    );
    expect(root.style.getPropertyValue("--shiori-safe-bottom")).toBe("0px");

    root.style.setProperty("color-scheme", "dark");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(appearance).toEqual([false, true]);

    uninstall();
    window.dispatchEvent(
      new window.CustomEvent(ANDROID_SAFE_AREA_EVENT, {
        detail: { top: 0, bottom: 99, left: 0, right: 0 },
      }),
    );
    expect(root.style.getPropertyValue("--shiori-safe-bottom")).toBe("0px");
  });

  test("does nothing off Android", () => {
    installBridge({
      safeAreaInsets: () => '{"top":24,"bottom":48,"left":0,"right":0}',
    });
    installAndroidShellSync({ enabled: false });
    expect(document.documentElement.style.getPropertyValue("--shiori-safe-bottom")).toBe(
      "",
    );
  });
});
