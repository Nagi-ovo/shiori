import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { InspectorRow, SelectInspector } from "./ContextualToolbar";

function installViewport(mobile: boolean): () => void {
  const previous = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: mobile && query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: previous,
    });
  };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("select-mode inspector", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  // The defect: on compact layouts select mode rendered no inspector at all,
  // so switching to a markup tool (or tapping an annotation) added a full row
  // and shoved the document down 47 CSS px. The select row must occupy the
  // same height as any tool's row so the reading position never moves.
  //
  // Still the guarantee for tablets and narrow desktop windows. Phones keep
  // it a different way now — the inspector floats out of the flow entirely
  // and select mode renders nothing; see ContextualToolbar.floatingInspector.
  test("keeps the inspector row height on compact layouts", () => {
    const restore = installViewport(true);
    try {
      const select = render(<SelectInspector />);
      const tool = render(
        <InspectorRow label="Markup">
          <button type="button">control</button>
        </InspectorRow>,
      );
      const selectRow = select.container.firstElementChild as HTMLElement | null;
      const toolRow = tool.container.firstElementChild as HTMLElement | null;
      expect(selectRow).not.toBeNull();
      expect(selectRow!.style.minHeight).toBe(toolRow!.style.minHeight);
      expect(selectRow!.style.minHeight).not.toBe("");
      // No keyboard-gesture hint on a phone; the row is the label alone.
      expect(select.container.textContent).toBe(i18n.t("inspector.labels.select"));
    } finally {
      restore();
    }
  });

  test("keeps the teaching hint on wide layouts", () => {
    const restore = installViewport(false);
    try {
      const view = render(<SelectInspector />);
      expect(view.container.textContent).toContain(
        i18n.t("inspector.labels.select"),
      );
      expect(view.container.textContent!.length).toBeGreaterThan(
        i18n.t("inspector.labels.select").length,
      );
    } finally {
      restore();
    }
  });
});
