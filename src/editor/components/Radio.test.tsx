import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { Radio } from "./ui";

const OPTIONS = [
  { v: "all" as const, label: "All pages" },
  { v: "current" as const, label: "Current page" },
  { v: "custom" as const, label: "Custom range" },
];

function renderRadio() {
  const picked: string[] = [];
  const view = render(
    <Radio
      label="Pages"
      options={OPTIONS}
      value="all"
      onChange={(v) => picked.push(v)}
    />,
  );
  const inputs = Array.from(
    view.container.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  );
  return { picked, view, inputs };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("Radio", () => {
  // The defect: the real <input> was hidden with `display: none`, which drops
  // it from the tab order and the accessibility tree alike. The visible dot is
  // a decorative <span>, so nothing focusable was left — every Radio group in
  // the app was unreachable without a mouse. In Export that meant page range,
  // annotation mode and quality could only ever be left at their defaults.
  test("the inputs stay focusable rather than being display:none", () => {
    const { inputs } = renderRadio();
    expect(inputs.length).toBe(3);
    for (const input of inputs) {
      expect(input.style.display).not.toBe("none");
      // Clipped to a pixel, but still a real control.
      expect(input.style.position).toBe("absolute");
    }
  });

  test("options share one name, so they form a single radio group", () => {
    const { inputs } = renderRadio();
    const names = new Set(inputs.map((i) => i.name));
    expect(names.size).toBe(1);
    expect([...names][0]).toBeTruthy();
  });

  test("the group announces itself and reports which option is checked", () => {
    const { view, inputs } = renderRadio();
    expect(
      view.container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label"),
    ).toBe("Pages");
    expect(inputs[0]!.checked).toBe(true);
    expect(inputs[1]!.checked).toBe(false);
  });

  test("changing an option reports the new value", () => {
    const { picked, inputs } = renderRadio();
    fireEvent.click(inputs[1]!);
    expect(picked).toEqual(["current"]);
  });
});
