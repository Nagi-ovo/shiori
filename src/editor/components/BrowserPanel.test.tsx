import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import i18n from "../../i18n";
import { useAppStore } from "../store/store";
import { BrowserPanel } from "./BrowserPanel";

// What the panel asked the native side when it took the webview down.
const hideCalls: unknown[] = [];
mock.module("./browserPanelPlatform", () => ({
  hideWebPanel: async (options?: unknown) => {
    hideCalls.push(options);
  },
}));

const initialSnapshot = useAppStore.getState();

describe("BrowserPanel", () => {
  beforeEach(async () => {
    cleanup();
    useAppStore.setState(initialSnapshot, true);
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState(initialSnapshot, true);
  });

  test("the address field is named for what it holds, not by its hint", () => {
    const view = render(<BrowserPanel active={false} obscured={false} />);
    expect(view.getByRole("textbox", { name: "Address" })).toBeTruthy();
  });
});

describe("BrowserPanel errors", () => {
  beforeEach(async () => {
    cleanup();
    useAppStore.setState(initialSnapshot, true);
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState(initialSnapshot, true);
  });

  // Android refuses a temporary session on a WebView that cannot keep one
  // apart from the saved logins; the user must learn why and what to change.
  test("a refused temporary session says how to browse instead", () => {
    useAppStore.setState({
      webPanel: {
        ...initialSnapshot.webPanel,
        error: "web-panel-temporary-unsupported",
      },
    });
    const view = render(<BrowserPanel active={false} obscured={false} />);
    expect(view.getByText(/Keep browser logins/)).toBeTruthy();
    expect(view.queryByText(/Couldn't load this page/)).toBeNull();
  });
});

describe("BrowserPanel rail lifecycle", () => {
  beforeEach(async () => {
    cleanup();
    hideCalls.length = 0;
    useAppStore.setState(initialSnapshot, true);
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState(initialSnapshot, true);
  });

  afterAll(() => {
    mock.restore();
  });

  // Closing the rail keeps the page alive but ends the panel session, so a
  // mailto quiet period a page stretched must not outlive it (B088). An
  // overlay over the panel only hides it: the page's throttle stays.
  test("closing the rail tells the native side; hiding for an overlay does not", () => {
    const view = render(<BrowserPanel active={true} obscured={true} />);
    expect(hideCalls.length).toBeGreaterThan(0);
    expect(hideCalls.every((options) => options === undefined)).toBe(true);
    hideCalls.length = 0;
    view.unmount();
    expect(hideCalls).toEqual([{ railClosed: true }]);
  });
});
