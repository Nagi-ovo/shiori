import "../../test/setupDom";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { useEditorStore } from "../store/store";
import { ContextualToolbar } from "./ContextualToolbar";
import { PageIndicatorPill } from "./PageIndicatorPill";
import { SelectionMarkupPopup } from "./SelectionMarkupPopup";
import {
  FLOATING_INSPECTOR_BAND,
  PAGE_PILL_EDGE_GAP,
  annotateButtonBottom,
  floatingInspectorPlacement,
  floatingPanelBand,
  getFloatingInspectorBottomInset,
  pagePillBottom,
} from "./floatingInspectorLayout";
import { selectionMarkupPopupEnabled } from "./selectionMarkupGate";

function installViewport(phone: boolean): () => void {
  const previousMatchMedia = window.matchMedia;
  const previousResizeObserver = globalThis.ResizeObserver;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: phone && query.includes("max-width"),
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

// Every tool that owns an inspector, plus select, which owns none on a phone.
const TOOLS = [
  "select",
  "highlight",
  "underline",
  "strikethrough",
  "ink",
  "rect",
  "note",
  "callout",
  "text",
] as const;

function setTool(tool: (typeof TOOLS)[number]): void {
  act(() => {
    useEditorStore.setState({ tool, selectedIds: [] } as never);
  });
}

function setAnnotationMode(on: boolean): void {
  act(() => {
    useEditorStore.getState().setAnnotationMode(on);
  });
}

/**
 * How much the toolbar contributes to the document's flow: its top-level
 * elements that are not fixed-position. The document sits below them, so
 * anything that appears or disappears here moves it.
 */
function flowElementCount(container: HTMLElement): number {
  return Array.from(container.children).filter(
    (el) => (el as HTMLElement).style.position !== "fixed",
  ).length;
}

function toolGrid(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-shiori-tool-grid]");
}

function annotateButton(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-shiori-annotate-button]");
}

/** The px term of a `calc(<n>px + var(--shiori-safe-bottom, 0px))` offset. */
function offsetPx(offset: string): number {
  const match = /calc\((\d+)px/.exec(offset);
  if (!match) throw new Error(`not a safe-area offset: ${offset}`);
  return Number(match[1]);
}

function floatingPanel(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-shiori-floating-inspector]");
}

let restoreViewport: () => void = () => undefined;

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  restoreViewport();
  restoreViewport = () => undefined;
  act(() => {
    useEditorStore.setState({
      tool: "select",
      selectedIds: [],
      annotationMode: false,
    } as never);
  });
});

describe("the phone's floating inspector", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  // THE invariant, and the reason 26.9.7 had to keep an empty select row: an
  // inspector that comes and goes inside the toolbar's flow pushes the
  // document down 47px under the reader's eyes when they change tool. Two
  // ways to break it, and this catches both — the flow must not change
  // between tools (26.7's bug), and on a phone the inspector must not be in
  // the flow at all (which is what makes the first part true for free).
  test("switching tools changes nothing in the toolbar's document flow", () => {
    restoreViewport = installViewport(true);
    const { container } = render(<ContextualToolbar />);
    setAnnotationMode(true);

    const counts = TOOLS.map((tool) => {
      setTool(tool);
      return flowElementCount(container);
    });

    expect(new Set(counts).size).toBe(1);
    // Nothing at all: the grid and the inspector are both fixed-position, so
    // there is no longer any row for the document to be pushed down by.
    expect(counts[0]).toBe(0);
  });

  // The same invariant across the mode boundary, which is the new way to
  // break it: a tool grid that came back into the flow would move the
  // document by ~85px every time the reader stepped in or out.
  test("entering and leaving annotation mode changes nothing in the flow", () => {
    restoreViewport = installViewport(true);
    const { container } = render(<ContextualToolbar />);

    const reading = flowElementCount(container);
    setAnnotationMode(true);
    const annotating = flowElementCount(container);
    setTool("highlight");
    const annotatingWithControls = flowElementCount(container);
    setAnnotationMode(false);
    const backToReading = flowElementCount(container);

    expect([reading, annotating, annotatingWithControls, backToReading]).toEqual(
      [0, 0, 0, 0],
    );
  });

  test("reading mode shows no tool grid, and one way into annotating", () => {
    restoreViewport = installViewport(true);
    const { container } = render(<ContextualToolbar />);
    setAnnotationMode(false);

    expect(toolGrid(container)).toBeNull();
    const button = annotateButton(container);
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-pressed")).toBe("false");
    expect(button!.getAttribute("aria-label")).toBe(i18n.t("nav.annotateEnter"));
  });

  test("annotation mode floats the tool grid out of the flow", () => {
    restoreViewport = installViewport(true);
    const { container } = render(<ContextualToolbar />);
    setAnnotationMode(true);

    const grid = toolGrid(container);
    expect(grid).not.toBeNull();
    // Inside the fixed panel, not in any flow row.
    const panel = floatingPanel(container);
    expect(panel).not.toBeNull();
    expect(panel!.style.position).toBe("fixed");
    expect(panel!.contains(grid)).toBe(true);
    expect(flowElementCount(container)).toBe(0);

    // And the way out is the same button, now saying so.
    const button = annotateButton(container)!;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe(i18n.t("nav.annotateExit"));
  });

  test("select mode with nothing selected floats nothing at all", () => {
    restoreViewport = installViewport(true);
    const { container } = render(<ContextualToolbar />);
    setTool("select");
    expect(floatingPanel(container)).toBeNull();
    expect(container.querySelector("[data-shiori-inspector-flow]")).toBeNull();
  });

  test("a tool with controls floats them out of the document flow", () => {
    restoreViewport = installViewport(true);
    const { container } = render(<ContextualToolbar />);
    setTool("highlight");

    const panel = floatingPanel(container);
    expect(panel).not.toBeNull();
    expect(panel!.style.position).toBe("fixed");
    // Not merely fixed — the phone's toolbar puts nothing in the flow at all,
    // so there is nothing for the panel to add height to.
    expect(container.querySelector("[data-shiori-toolbar-flow]")).toBeNull();
    expect(container.querySelector("[data-shiori-inspector-flow]")).toBeNull();
    expect(flowElementCount(container)).toBe(0);
  });

  // Desktop and tablets are untouched: the inspector stays a row in the flow,
  // select mode included — that row is where their keyboard hints live.
  test("wide layouts keep the inspector in the flow for every tool", () => {
    restoreViewport = installViewport(false);
    const { container } = render(<ContextualToolbar />);

    for (const tool of TOOLS) {
      setTool(tool);
      expect(container.querySelector("[data-shiori-inspector-flow]")).not.toBeNull();
      expect(floatingPanel(container)).toBeNull();
    }
  });

  // Desktop and tablets never split reading from annotating: their toolbar
  // has room for the grid at all times, so the mode must not reach them even
  // when the flag is set.
  test("wide layouts keep the tool row whatever the mode says", () => {
    restoreViewport = installViewport(false);
    const { container } = render(<ContextualToolbar />);

    for (const on of [true, false]) {
      setAnnotationMode(on);
      expect(annotateButton(container)).toBeNull();
      expect(toolGrid(container)).toBeNull();
      expect(container.querySelector("[data-shiori-toolbar-flow]")).not.toBeNull();
      expect(flowElementCount(container)).toBe(1);
    }
  });
});

// Hard constraint: reading to the middle of a page and marking a sentence is
// the commonest thing a reader does. Making them press the pencil first would
// be the change's worst outcome, and the failure would be silent — the
// popover simply never appears.
describe("select-text-then-mark survives reading mode", () => {
  test("the popover is offered under the select tool, and only there", () => {
    expect(selectionMarkupPopupEnabled("select")).toBe(true);
    expect(selectionMarkupPopupEnabled("highlight")).toBe(false);
    expect(selectionMarkupPopupEnabled("ink")).toBe(false);
  });

  // Which makes reading mode's job to hand the tool back. Leaving annotation
  // mode with any tool armed must land on select, or the reader is left in a
  // mode with no grid to change the tool from and no popover either.
  test.each(["highlight", "ink", "rect", "text", "note"] as const)(
    "leaving annotation mode with %s armed returns the select tool",
    (tool) => {
      act(() => {
        useEditorStore.getState().setAnnotationMode(true);
        useEditorStore.setState({ tool } as never);
      });
      expect(selectionMarkupPopupEnabled(useEditorStore.getState().tool)).toBe(
        false,
      );

      act(() => {
        useEditorStore.getState().setAnnotationMode(false);
      });
      expect(useEditorStore.getState().tool).toBe("select");
      expect(selectionMarkupPopupEnabled(useEditorStore.getState().tool)).toBe(
        true,
      );
    },
  );

  // And the popover the open gate leads to is a working set of markup
  // actions, not an empty shell.
  test("the popover offers the markup actions once the gate is open", () => {
    act(() => {
      useEditorStore.getState().setAnnotationMode(false);
    });
    expect(selectionMarkupPopupEnabled(useEditorStore.getState().tool)).toBe(
      true,
    );

    const applied: string[] = [];
    const { container } = render(
      <SelectionMarkupPopup
        anchor={{ left: 40, top: 120, right: 200, bottom: 150 }}
        onApply={(type) => applied.push(type)}
      />,
    );
    const toolbar = container.querySelector('[role="toolbar"]');
    expect(toolbar?.getAttribute("aria-label")).toBe(
      i18n.t("selectionPopup.label"),
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons).toHaveLength(4);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
  });
});

describe("floating inspector placement", () => {
  const viewport = { top: 100, bottom: 800 };

  // A tool inspector has drawn nothing yet, so nothing on the page needs
  // keeping clear and it takes the edge a thumb reaches.
  test("a tool inspector takes the bottom", () => {
    expect(floatingInspectorPlacement({ selection: null, viewport })).toBe(
      "bottom",
    );
  });

  // The panel edits the selected annotation; sitting on top of it hides the
  // change being made.
  test("moves off a selection that is in the bottom band", () => {
    expect(
      floatingInspectorPlacement({
        selection: { top: 740, bottom: 780 },
        viewport,
      }),
    ).toBe("top");
  });

  test("stays at the bottom for a selection near the top", () => {
    expect(
      floatingInspectorPlacement({
        selection: { top: 110, bottom: 160 },
        viewport,
      }),
    ).toBe("bottom");
  });

  test("stays at the bottom for a selection in the middle", () => {
    expect(
      floatingInspectorPlacement({
        selection: { top: 400, bottom: 460 },
        viewport,
      }),
    ).toBe("bottom");
  });

  // A page-tall annotation reaches both bands: no edge is clear, so the
  // reachable one wins.
  test("prefers the reachable edge when both are covered", () => {
    expect(
      floatingInspectorPlacement({
        selection: { top: 110, bottom: 790 },
        viewport,
      }),
    ).toBe("bottom");
  });
});

describe("the bottom edge is shared, not contested", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  test("the page pill rides above the floating inspector", () => {
    restoreViewport = installViewport(true);
    act(() => {
      useEditorStore.setState({
        model: { pages: [{ id: "p0" }, { id: "p1" }], overlays: [] },
        activePageId: "p0",
      } as never);
    });
    const { container } = render(
      <>
        <ContextualToolbar />
        <PageIndicatorPill />
      </>,
    );

    setTool("select");
    const pill = container.querySelector<HTMLElement>("[data-shiori-page-pill]")!;
    expect(pill).not.toBeNull();
    // Nothing else at the bottom: the pill keeps its own gap.
    expect(getFloatingInspectorBottomInset()).toBe(0);

    setTool("highlight");
    // The panel announces what it took, and the pill's offset clears it.
    // (The rendered value cannot be read back — happy-dom drops `var()`
    // from inline styles — so the offset is asserted at its source.)
    expect(getFloatingInspectorBottomInset()).toBe(FLOATING_INSPECTOR_BAND);
    expect(pagePillBottom(FLOATING_INSPECTOR_BAND)).toContain(
      `${PAGE_PILL_EDGE_GAP + FLOATING_INSPECTOR_BAND}px`,
    );
    expect(pagePillBottom(FLOATING_INSPECTOR_BAND)).not.toBe(pagePillBottom(0));

    // And the pill must never paint over live controls.
    const panel = floatingPanel(container)!;
    expect(Number(pill.style.zIndex)).toBeLessThan(Number(panel.style.zIndex));
  });

  // Three fixed things can want the bottom edge at once. They coordinate
  // through one module rather than each picking its own offset: the panel
  // takes the edge, and the button and the pill both clear whatever it took.
  test("the annotate button and the pill both clear the panel", () => {
    const bands = [
      floatingPanelBand({ toolGrid: false, inspector: false }),
      floatingPanelBand({ toolGrid: false, inspector: true }),
      floatingPanelBand({ toolGrid: true, inspector: false }),
      floatingPanelBand({ toolGrid: true, inspector: true }),
    ];
    expect(bands).toEqual([...bands].sort((a, b) => a - b));
    expect(bands[0]).toBe(0);

    for (const band of bands) {
      // The panel occupies from its own gap up to `band`; both of the others
      // start above that.
      expect(offsetPx(annotateButtonBottom(band))).toBeGreaterThanOrEqual(band);
      expect(offsetPx(pagePillBottom(band))).toBeGreaterThanOrEqual(band);
      // Every offset keeps the safe area underneath it.
      expect(annotateButtonBottom(band)).toContain("--shiori-safe-bottom");
      expect(pagePillBottom(band)).toContain("--shiori-safe-bottom");
    }
  });

  // The button is a circle at the right, the pill a chip in the centre, so
  // the two ride at the same height without meeting. Only the panel is wide
  // enough to collide with either, and both stack above it.
  test("the button and the pill are anchored to different sides", () => {
    restoreViewport = installViewport(true);
    act(() => {
      useEditorStore.setState({
        model: { pages: [{ id: "p0" }], overlays: [] },
        activePageId: "p0",
      } as never);
    });
    const { container } = render(
      <>
        <ContextualToolbar />
        <PageIndicatorPill />
      </>,
    );

    const button = annotateButton(container)!;
    const pill = container.querySelector<HTMLElement>("[data-shiori-page-pill]")!;
    // The pill is centred; the button is not positioned from the left at all
    // (it is anchored right, through a safe-area calc happy-dom drops from
    // inline styles — hence the negative assertion on the left edge).
    expect(pill.style.left).toBe("50%");
    expect(pill.style.transform).toBe("translateX(-50%)");
    expect(button.style.left).toBe("");
    // The button must never sit under the panel it opens either.
    expect(Number(button.style.zIndex)).toBeGreaterThan(Number(pill.style.zIndex));
  });

});
