import "../../test/setupDom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { useState } from "react";
import i18n from "../../i18n";
import {
  DEFAULT_MARKDOWN_APPEARANCE,
  type MarkdownAppearanceOverride,
} from "../../documents/markdownAppearance";
import type { MarkdownAppearancePicker as PickerComponent } from "./MarkdownAppearancePicker";

let MarkdownAppearancePicker: typeof PickerComponent;

beforeAll(async () => {
  MarkdownAppearancePicker = (
    await import("./MarkdownAppearancePicker")
  ).MarkdownAppearancePicker;
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function baseProps() {
  return {
    appearance: { ...DEFAULT_MARKDOWN_APPEARANCE },
    globalAppearance: { ...DEFAULT_MARKDOWN_APPEARANCE },
    recentFonts: [],
    onOverrideChange: () => undefined,
    onSetGlobalAppearance: () => undefined,
    onUseFont: () => undefined,
  };
}

describe("MarkdownAppearancePicker", () => {
  test("loads, searches, previews, and selects system fonts", async () => {
    const overrides: unknown[] = [];
    const used: unknown[] = [];
    const view = render(
      <MarkdownAppearancePicker
        {...baseProps()}
        onOverrideChange={(value) => overrides.push(value)}
        onUseFont={(font) => used.push(font)}
        systemFontAccessMode="native"
        loadSystemFonts={async () => ({
          status: "available",
          source: "desktop",
          fonts: [
            { family: "Avenir Next", aliases: [], monospaced: false },
            {
              family: "Cascadia Code",
              aliases: ["Cascadia Mono"],
              monospaced: true,
            },
          ],
        })}
      />,
    );

    fireEvent.click(view.getByLabelText("Reading appearance"));
    expect(await view.findByText("Avenir Next")).toBeTruthy();
    fireEvent.input(view.getByLabelText("Search fonts"), {
      target: { value: "Cascadia Mono" },
    });
    fireEvent.click(view.getByRole("button", { name: /Cascadia Code/ }));

    expect(overrides.at(-1)).toEqual({
      bodyFont: { source: "system", family: "Cascadia Code" },
    });
    expect(used.at(-1)).toEqual({
      source: "system",
      family: "Cascadia Code",
    });
  });

  test("keeps body and code font choices independent", async () => {
    const overrides: unknown[] = [];
    const view = render(
      <MarkdownAppearancePicker
        {...baseProps()}
        override={{
          bodyFont: { source: "builtin", family: "Instrument Serif" },
        }}
        appearance={{
          ...DEFAULT_MARKDOWN_APPEARANCE,
          bodyFont: { source: "builtin", family: "Instrument Serif" },
        }}
        onOverrideChange={(value) => overrides.push(value)}
        systemFontAccessMode="unavailable"
        loadSystemFonts={async () => ({
          status: "unsupported",
          source: "web",
          fonts: [],
        })}
      />,
    );

    fireEvent.click(view.getByLabelText("Reading appearance"));
    await view.findByText(/can't list installed fonts/);
    const bodyTab = view.getByRole("tab", { name: "Body" });
    bodyTab.focus();
    fireEvent.keyDown(bodyTab, { key: "ArrowRight" });
    expect(view.getByRole("tab", { name: "Code" }).getAttribute("aria-selected"))
      .toBe("true");
    fireEvent.click(view.getByRole("button", { name: /JetBrains Mono/ }));

    expect(overrides.at(-1)).toEqual({
      bodyFont: { source: "builtin", family: "Instrument Serif" },
      codeFont: { source: "builtin", family: "JetBrains Mono" },
    });
  });

  test("changes layout, restores global layout, and promotes current settings", async () => {
    const overrides: unknown[] = [];
    const globals: unknown[] = [];
    const view = render(
      <MarkdownAppearancePicker
        {...baseProps()}
        override={{ fontSize: 18, lineHeight: 1.8, contentWidth: 720 }}
        appearance={{
          ...DEFAULT_MARKDOWN_APPEARANCE,
          fontSize: 18,
          lineHeight: 1.8,
          contentWidth: 720,
        }}
        onOverrideChange={(value) => overrides.push(value)}
        onSetGlobalAppearance={(value) => globals.push(value)}
        systemFontAccessMode="unavailable"
        loadSystemFonts={async () => ({
          status: "unsupported",
          source: "web",
          fonts: [],
        })}
      />,
    );

    fireEvent.click(view.getByLabelText("Reading appearance"));
    await view.findByText(/can't list installed fonts/);
    fireEvent.click(view.getByRole("tab", { name: "Layout" }));
    fireEvent.input(view.getByLabelText("Font size"), {
      target: { value: "20" },
    });
    expect(overrides).toHaveLength(0);
    fireEvent.pointerUp(view.getByLabelText("Font size"));
    expect(overrides.at(-1)).toEqual({
      fontSize: 20,
      lineHeight: 1.8,
      contentWidth: 720,
    });

    fireEvent.click(view.getByRole("button", { name: "Wide" }));
    expect(overrides.at(-1)).toEqual({
      fontSize: 18,
      lineHeight: 1.8,
      contentWidth: 1200,
    });

    fireEvent.click(view.getByRole("button", { name: "Use global layout" }));
    expect(overrides.at(-1)).toEqual({});

    fireEvent.click(
      view.getByRole("button", { name: "Set current as global" }),
    );
    expect(globals.at(-1)).toEqual({
      ...DEFAULT_MARKDOWN_APPEARANCE,
      fontSize: 18,
      lineHeight: 1.8,
      contentWidth: 720,
    });
    expect(overrides.at(-1)).toEqual({});
  });

  test("supports manual font names when enumeration is unavailable", async () => {
    const user = userEvent.setup();
    const overrides: unknown[] = [];
    const view = render(
      <MarkdownAppearancePicker
        {...baseProps()}
        onOverrideChange={(value) => overrides.push(value)}
        systemFontAccessMode="unavailable"
        loadSystemFonts={async () => ({
          status: "unsupported",
          source: "web",
          fonts: [],
        })}
      />,
    );

    fireEvent.click(view.getByLabelText("Reading appearance"));
    expect(
      await view.findByText(/can't list installed fonts/),
    ).toBeTruthy();
    await user.type(
      view.getByLabelText("Enter an installed font"),
      "Iowan Old Style",
    );
    await user.click(view.getByRole("button", { name: "Use font" }));

    await waitFor(() => {
      expect(overrides.at(-1)).toEqual({
        bodyFont: { source: "system", family: "Iowan Old Style" },
      });
    });
  });

  test("asks before requesting the browser's installed-font list", async () => {
    let calls = 0;
    const view = render(
      <MarkdownAppearancePicker
        {...baseProps()}
        systemFontAccessMode="permission"
        loadSystemFonts={async () => {
          calls += 1;
          return {
            status: "available",
            source: "web",
            fonts: [
              { family: "Avenir Next", aliases: [], monospaced: false },
            ],
          };
        }}
      />,
    );

    fireEvent.click(view.getByLabelText("Reading appearance"));
    expect(calls).toBe(0);
    expect(await view.findByText(/browser asks before sharing/)).toBeTruthy();
    fireEvent.click(
      view.getByRole("button", { name: "Show installed fonts" }),
    );
    expect(await view.findByText("Avenir Next")).toBeTruthy();
    expect(calls).toBe(1);
  });

  test("distinguishes global, automatic, palette, and validated custom heading colors", async () => {
    const user = userEvent.setup();
    const overrides: unknown[] = [];
    function Harness() {
      const [override, setOverride] = useState<MarkdownAppearanceOverride>({});
      return (
        <MarkdownAppearancePicker
          {...baseProps()}
          appearance={{ ...DEFAULT_MARKDOWN_APPEARANCE, ...override }}
          override={override}
          onOverrideChange={(value) => {
            overrides.push(value);
            setOverride(value);
          }}
          systemFontAccessMode="unavailable"
        />
      );
    }
    const view = render(<Harness />);

    fireEvent.click(view.getByLabelText("Reading appearance"));
    const bodyTab = view.getByRole("tab", { name: "Body" });
    bodyTab.focus();
    fireEvent.keyDown(bodyTab, { key: "End" });
    const colorTab = view.getByRole("tab", { name: "Color" });
    expect(colorTab.getAttribute("aria-selected")).toBe("true");

    const followGlobal = view.getByRole("button", { name: /Use global/ });
    expect(followGlobal.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(
      view.getByRole("button", { name: "Match the current theme" }),
    );
    expect(overrides.at(-1)).toEqual({ headingColor: null });

    fireEvent.click(view.getByRole("button", { name: "#2D5A3D" }));
    expect(overrides.at(-1)).toEqual({ headingColor: "#2d5a3d" });

    const customInput = view.getByRole("textbox", {
      name: "Custom HEX color",
    });
    await user.clear(customInput);
    await user.type(customInput, "transparent");
    expect((customInput as HTMLInputElement).value).toBe("TRANSPARENT");
    await user.click(view.getByRole("button", { name: "Apply" }));
    expect(view.getByRole("alert").textContent).toContain("#RGB");

    await user.clear(customInput);
    await user.type(customInput, "#ABC");
    await user.click(view.getByRole("button", { name: "Apply" }));
    expect(overrides.at(-1)).toEqual({ headingColor: "#aabbcc" });
  });
});
