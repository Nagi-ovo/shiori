import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { DocumentShell, MAIN_LANDMARK_ID } from "./DocumentShell";

function renderShell() {
  return render(
    <DocumentShell
      documentKind="pdf"
      title="annual-report.pdf"
      meta="PDF · 1.2 MB"
      navigatorOpen={false}
      onHome={() => {}}
      onOpenSettings={() => {}}
      onOpenShortcuts={() => {}}
      workspaceSwitcher={null}
      navigator={null}
      tabStrip={null}
      tabCount={1}
      viewport={<div data-testid="viewport">page</div>}
      railDoc={null}
      showRail={false}
      onCloseRail={() => {}}
    />,
  );
}

describe("DocumentShell landmarks", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  // The app was an untagged div tree: no <main>, no skip link. Every visit
  // meant tabbing through the top bar, navigator, tab strip and toolbar to
  // reach the document.
  test("the document sits in a named main landmark", () => {
    const view = renderShell();
    const main = view.container.querySelector("main");
    expect(main).toBeTruthy();
    expect(main!.id).toBe(MAIN_LANDMARK_ID);
    expect(main!.getAttribute("aria-label")).toBeTruthy();
    // The viewport must be inside it, not merely adjacent.
    expect(main!.querySelector('[data-testid="viewport"]')).toBeTruthy();
  });

  test("a skip link is the first focusable element and targets that landmark", () => {
    const view = renderShell();
    const focusable = view.container.querySelector(
      'a[href], button, input, [tabindex]:not([tabindex="-1"])',
    );
    expect(focusable?.tagName).toBe("A");
    expect(focusable?.getAttribute("href")).toBe(`#${MAIN_LANDMARK_ID}`);
    expect(focusable?.textContent?.trim()).toBeTruthy();
  });

  // Focus has to be able to land on the target, or the link moves the
  // viewport without moving the keyboard.
  test("the landmark can receive programmatic focus", () => {
    const view = renderShell();
    const main = view.container.querySelector("main")!;
    expect(main.getAttribute("tabindex")).toBe("-1");
  });
});
