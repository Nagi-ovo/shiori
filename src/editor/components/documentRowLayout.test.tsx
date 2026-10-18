import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { CSSProperties } from "react";
import i18n from "../../i18n";
import { DocumentShell } from "../../App/render/DocumentShell";
import {
  SAFE_BOTTOM,
  pdfDocumentRowStyle,
} from "./documentRowLayout";

function installMobileViewport(): () => void {
  const previousMatchMedia = window.matchMedia;
  const previousResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: { width: 360, height: 40 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  };
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: previousMatchMedia,
    });
    if (previousResizeObserver === undefined) {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    } else {
      globalThis.ResizeObserver = previousResizeObserver;
    }
  };
}

/** The PDF branch of App, rendered through the real shell it renders through. */
function renderPdfShell(rowStyle: CSSProperties) {
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
      rowStyle={rowStyle}
    />,
  );
}

function documentRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>("[data-shiori-document-row]");
  if (!row) throw new Error("no document row rendered");
  return row;
}

let restoreViewport: () => void = () => undefined;

beforeEach(() => {
  restoreViewport = installMobileViewport();
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  restoreViewport();
});

// The claim under test is "on a phone, the PDF document row reserves the
// bottom safe area", and it is covered in two halves because happy-dom's
// CSSStyleDeclaration silently drops `var(…)` values for padding — the
// rendered half therefore uses a plain length, and the value half asserts on
// the style object App hands the shell. App.tsx itself has no test harness,
// so the one link left uncovered is the call site passing this function's
// result as `rowStyle` (App.tsx, the PDF branch's <DocumentShell>).
describe("PDF document row insets", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  // 26.9.8: content ending under the system navigation bar is a defect
  // readers report with a screenshot. The PDF row used to get this room for
  // free from the status bar's own padding; on a phone there is no status
  // bar any more, so the row has to reserve it itself.
  test("the PDF branch's row style reserves the bottom safe area", () => {
    expect(
      pdfDocumentRowStyle({
        readerMode: false,
        trafficLightInsetTop: 0,
        safeTop: "var(--shiori-safe-top, 0px)",
      }).paddingBottom,
    ).toBe(SAFE_BOTTOM);
  });

  // Reader mode already held all four insets open. Making the bottom one
  // unconditional must not have cost it that.
  test("reader mode still reserves every inset", () => {
    const style = pdfDocumentRowStyle({
      readerMode: true,
      trafficLightInsetTop: 34,
      safeTop: "var(--shiori-safe-top, 0px)",
    });
    expect(style.paddingBottom).toBe(SAFE_BOTTOM);
    expect(style.paddingLeft).toBe("var(--shiori-safe-left, 0px)");
    expect(style.paddingRight).toBe("var(--shiori-safe-right, 0px)");
    expect(style.paddingTop).toBe("calc(34px + var(--shiori-safe-top, 0px))");
  });

  // Outside reader mode the top bar and navigator cover their own edges, so
  // the row only owes the macOS traffic-light clearance up top.
  test("leaves the other edges to the chrome outside reader mode", () => {
    const style = pdfDocumentRowStyle({
      readerMode: false,
      trafficLightInsetTop: 0,
      safeTop: "var(--shiori-safe-top, 0px)",
    });
    expect(style.paddingTop).toBe(0);
    expect(style.paddingLeft).toBeUndefined();
    expect(style.paddingRight).toBeUndefined();
  });

  // The other half: on a phone viewport the shell really does put the row
  // style's bottom padding on [data-shiori-document-row], rather than on the
  // column or the viewport inside it.
  test("the shell applies that bottom padding to the document row", () => {
    const { container } = renderPdfShell({
      ...pdfDocumentRowStyle({
        readerMode: false,
        trafficLightInsetTop: 34,
        safeTop: "0px",
      }),
      paddingBottom: "77px",
    });
    const row = documentRow(container);
    expect(row.style.paddingBottom).toBe("77px");
    // …and the rest of the style object reaches the same element.
    expect(row.style.paddingTop).toBe("34px");
  });
});
