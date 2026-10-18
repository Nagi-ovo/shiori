import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { useState } from "react";
import i18n from "../../i18n";
import { AccentColorSetting } from "./AccentColorSetting";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function Harness() {
  const [accentColor, setAccentColor] = useState<string | null>(null);
  return (
    <>
      <output data-testid="value">{accentColor ?? "null"}</output>
      <AccentColorSetting
        accentColor={accentColor}
        colorMode="Light"
        theme="Default"
        onChange={setAccentColor}
      />
    </>
  );
}

describe("AccentColorSetting", () => {
  test("expands on demand, validates custom colors, and resets to the theme", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    const trigger = view.getByRole("button", {
      name: "Customize accent color",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("Theme default");

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await user.click(view.getByRole("button", { name: "#A7542A" }));
    expect(view.getByTestId("value").textContent).toBe("#a7542a");
    expect(
      view.getByRole("button", { name: "#A7542A" }).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");

    const customInput = view.getByRole("textbox", {
      name: "Custom HEX color",
    });
    await user.clear(customInput);
    await user.type(customInput, "not-a-color");
    await user.tab();
    expect(view.getByRole("alert").textContent).toContain("#RGB");
    expect(view.getByTestId("value").textContent).toBe("#a7542a");

    await user.clear(customInput);
    await user.type(customInput, "#abc");
    await user.tab();
    expect(view.getByTestId("value").textContent).toBe("#aabbcc");
    expect(customInput.getAttribute("value")).toBe("#AABBCC");

    await user.click(
      view.getByRole("button", { name: "Reset to the theme color" }),
    );
    expect(view.getByTestId("value").textContent).toBe("null");
    expect(trigger.textContent).toContain("Theme default");

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  test("commits native color-picker input immediately", () => {
    const view = render(<Harness />);
    fireEvent.click(
      view.getByRole("button", { name: "Customize accent color" }),
    );
    const colorInput = view.getByLabelText("Custom HEX color", {
      selector: 'input[type="color"]',
    });
    fireEvent.input(colorInput, { target: { value: "#123456" } });
    expect(view.getByTestId("value").textContent).toBe("#123456");
  });

  test("commits complete HEX input immediately and displays uppercase", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    await user.click(
      view.getByRole("button", { name: "Customize accent color" }),
    );
    const customInput = view.getByRole("textbox", {
      name: "Custom HEX color",
    });

    await user.clear(customInput);
    await user.type(customInput, "#abcdef");

    expect(view.getByTestId("value").textContent).toBe("#abcdef");
    expect(customInput.getAttribute("value")).toBe("#ABCDEF");
  });
});
