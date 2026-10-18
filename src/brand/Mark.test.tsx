import "../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { ShioriStacked, ShioriTile } from "./Mark";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("ShioriTile", () => {
  test("follows the live UI accent with a logo-specific foreground", () => {
    const view = render(<ShioriTile />);
    const tile = view.getByLabelText("Shiori") as HTMLElement;
    expect(tile.style.background).toBe("var(--opx-accent)");
    expect(tile.style.color).toBe("var(--opx-logoOnAccent)");
  });

  test("keeps the stacked kanji mark in the fixed brand blue", () => {
    const view = render(<ShioriStacked showSubtitle={false} />);
    // The 栞 is now a vector mark (ShioriGlyph), not text — assert its fill.
    const mark = view.container.querySelector("svg");
    expect(mark?.getAttribute("fill")).toBe("#3388bb");
  });
});
