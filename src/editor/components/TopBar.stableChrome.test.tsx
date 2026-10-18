import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { TopBar } from "./TopBar";

/**
 * Switching format must not change the SHAPE of the top bar.
 *
 * These controls used to render only when their callback was supplied, so
 * opening a Markdown file after a PDF removed Print and Export from the DOM
 * and every button to their left slid sideways. The bar redrew itself on
 * every tab switch, which reads as the window twitching.
 *
 * A control the active format cannot use stays mounted and goes disabled. The
 * geometry is then a property of the app, not of the file that happens to be
 * open.
 */
describe("TopBar keeps one geometry across formats", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  const base = {
    fileName: "doc",
    meta: "",
    navigatorOpen: false,
    onOpenShortcuts: () => undefined,
    onOpenSettings: () => undefined,
  };

  const buttons = (root: HTMLElement) =>
    [...root.querySelectorAll("button")].map((button) => ({
      label: button.getAttribute("title") ?? button.textContent ?? "",
      disabled: button.hasAttribute("disabled"),
    }));

  test("a format without export or print still shows both, disabled", () => {
    const supported = render(
      <TopBar
        {...base}
        documentKind="pdf"
        onOpenExport={() => undefined}
        onPrint={() => undefined}
        onToggleThumbs={() => undefined}
      />,
    );
    const withSupport = buttons(supported.container);
    cleanup();

    const unsupported = render(<TopBar {...base} documentKind="docx" />);
    const withoutSupport = buttons(unsupported.container);

    // Same controls, same order — only the enabled state differs.
    expect(withoutSupport.map((b) => b.label)).toEqual(
      withSupport.map((b) => b.label),
    );

    const state = (all: typeof withSupport, pattern: RegExp) =>
      all.find((button) => pattern.test(button.label))?.disabled;

    expect(state(withSupport, /export/i)).toBe(false);
    expect(state(withSupport, /print/i)).toBe(false);
    expect(state(withoutSupport, /export/i)).toBe(true);
    expect(state(withoutSupport, /print/i)).toBe(true);
  });
});
