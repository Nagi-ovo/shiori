import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import {
  SelectionMarkupPopup,
  type SelectionMarkupType,
} from "./SelectionMarkupPopup";

const ANCHOR = { left: 100, top: 200, right: 300, bottom: 220 };

function renderPopup() {
  const applied: SelectionMarkupType[] = [];
  const view = render(
    <SelectionMarkupPopup
      anchor={ANCHOR}
      onApply={(type) => applied.push(type)}
    />,
  );
  const buttons = Array.from(
    view.container.querySelectorAll<HTMLButtonElement>("button"),
  );
  return { applied, view, buttons };
}

describe("SelectionMarkupPopup keyboard operation", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  // The defect this guards: the buttons bound only onPointerDown, and Enter
  // dispatches a click. The popup looked focusable and had a focus ring, but
  // pressing Enter did nothing — the one non-pointer route into highlight,
  // underline, strikethrough and callout was dead.
  test("a keyboard activation applies the markup", () => {
    const { applied, buttons } = renderPopup();
    expect(buttons.length).toBe(4);

    // Enter/Space produce a click whose detail is 0.
    fireEvent.click(buttons[0]!, { detail: 0 });

    expect(applied).toEqual(["highlight"]);
  });

  test("a pointer activation still applies exactly once", () => {
    const { applied, buttons } = renderPopup();

    fireEvent.pointerDown(buttons[1]!);
    // Browsers follow a pointer activation with a click carrying detail >= 1;
    // it must not apply the markup a second time.
    fireEvent.click(buttons[1]!, { detail: 1 });

    expect(applied).toEqual(["underline"]);
  });

  test("arrow keys move within the toolbar and wrap", () => {
    const { buttons } = renderPopup();
    const group = buttons[0]!.parentElement!;

    buttons[0]!.focus();
    expect(buttons[0]!.tabIndex).toBe(0);
    expect(buttons[1]!.tabIndex).toBe(-1);

    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[1]!);

    fireEvent.keyDown(group, { key: "End" });
    expect(document.activeElement).toBe(buttons[3]!);

    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[0]!);
  });
});
