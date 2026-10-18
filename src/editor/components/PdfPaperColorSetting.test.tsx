import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { useState } from "react";
import i18n from "../../i18n";
import { PdfPaperColorSetting } from "./PdfPaperColorSetting";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function Harness() {
  const [color, setColor] = useState("#efebd4");
  return (
    <>
      <output data-testid="value">{color}</output>
      <PdfPaperColorSetting color={color} onChange={setColor} />
    </>
  );
}

describe("PdfPaperColorSetting", () => {
  test("offers paper swatches, validates HEX, and reports safe lightening", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);

    await user.click(view.getByRole("button", { name: "#FDF6E3" }));
    expect(view.getByTestId("value").textContent).toBe("#fdf6e3");

    const input = view.getByRole("textbox", { name: "Custom HEX color" });
    await user.clear(input);
    await user.type(input, "not-a-color");
    await user.click(view.getByRole("button", { name: "Apply" }));
    expect(view.getByRole("alert").textContent).toContain("#RGB");
    expect(view.getByTestId("value").textContent).toBe("#fdf6e3");

    await user.clear(input);
    await user.type(input, "#173f35");
    await user.click(view.getByRole("button", { name: "Apply" }));
    expect(view.getByTestId("value").textContent).toBe("#173f35");
    expect(view.getByText(/Lightened automatically/)).toBeTruthy();

    await user.click(
      view.getByRole("button", { name: "Reset to Everforest paper" }),
    );
    expect(view.getByTestId("value").textContent).toBe("#efebd4");
  });
});
