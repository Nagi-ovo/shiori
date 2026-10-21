import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { useAppStore } from "../store/store";
import { BrowserPanel } from "./BrowserPanel";

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
