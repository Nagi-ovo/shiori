import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { NumField } from "./ui";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("NumField", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  // The defect: the value was static text with two steppers beside it, so the
  // only way to reach a number was to click one of them repeatedly — 4pt per
  // press for a width, 15° for an angle. Unusable for anything but a nudge.
  test("typing a value commits it", () => {
    const committed: number[] = [];
    const view = render(
      <NumField label="Width" value={120} onCommit={(n) => committed.push(n)} />,
    );
    fireEvent.click(view.getByRole("button", { name: /^Width: / }));
    const input = view.container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "260" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(committed).toEqual([260]);
  });

  test("Escape abandons the edit without committing", () => {
    const committed: number[] = [];
    const view = render(
      <NumField label="Width" value={120} onCommit={(n) => committed.push(n)} />,
    );
    fireEvent.click(view.getByRole("button", { name: /^Width: / }));
    const input = view.container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "999" } });
    fireEvent.keyDown(input, { key: "Escape" });
    // Escape clears the draft, which unmounts the input, and unmounting fires
    // blur — whose handler commits. That is the defect: Escape used to write
    // the very value it was meant to discard. Fire the blur explicitly, since
    // the unmount that would produce it is React scheduling under happy-dom.
    fireEvent.blur(input, { target: { value: "999" } });
    // Only the commit is asserted. Whether the input has already unmounted by
    // this point is React scheduling under happy-dom, not behaviour worth
    // pinning — and the defect this guards is that Escape used to commit the
    // value it was meant to discard, via the blur that unmounting fires.
    expect(committed).toEqual([]);
  });

  test("a typed value is clamped to the field's range", () => {
    const committed: number[] = [];
    const view = render(
      <NumField
        label="Size"
        value={12}
        min={6}
        max={144}
        onCommit={(n) => committed.push(n)}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: /^Size: / }));
    const input = view.container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(committed).toEqual([144]);
  });

  // The steppers were 16x13 and stacked 15px apart, then hidden until hover —
  // below the 24px target floor, and unreachable by touch or by anyone who did
  // not already know they were there.
  test("steppers are 24px targets that stay visible while idle", () => {
    const view = render(
      <NumField label="Size" value={12} onMinus={() => {}} onPlus={() => {}} />,
    );
    for (const name of [/^Decrease: Size/, /^Increase: Size/]) {
      const button = view.getByRole("button", { name }) as HTMLButtonElement;
      expect(parseFloat(button.style.width)).toBeGreaterThanOrEqual(24);
      expect(parseFloat(button.style.height)).toBeGreaterThanOrEqual(24);
      const group = button.parentElement as HTMLElement;
      expect(parseFloat(group.style.opacity)).toBeGreaterThan(0);
    }
  });

  // Arrow keys on the value are the keyboard's one-notch nudge, matching the
  // stepper buttons without opening the editor first.
  test("arrow keys on the value step it", () => {
    const steps: string[] = [];
    const view = render(
      <NumField
        label="Size"
        value={12}
        onMinus={() => steps.push("-")}
        onPlus={() => steps.push("+")}
        onCommit={() => {}}
      />,
    );
    const valueButton = view.getByRole("button", { name: /^Size: / });
    fireEvent.keyDown(valueButton, { key: "ArrowUp" });
    fireEvent.keyDown(valueButton, { key: "ArrowDown" });
    expect(steps).toEqual(["+", "-"]);
    expect(view.container.querySelector("input")).toBeNull();
  });

  // Without onCommit the field stays exactly as it was — a live region that
  // re-reads itself after each step, with no editing affordance.
  test("stays read-only when no commit handler is given", () => {
    const view = render(<NumField label="Weight" value={3} />);
    expect(view.container.querySelector("input")).toBeNull();
    expect(view.container.querySelector('[role="status"]')).toBeTruthy();
  });
});
