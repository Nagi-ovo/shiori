import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { contrastRatio } from "../../design/color";
import { THEME_PALETTE_SETS, type ThemePalette } from "../../design/theme";
import { LossyExportNotice } from "./ExportNotices";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(cleanup);

// Inline styles hold either a literal colour or a theme token
// (`var(--opx-ink)`); resolve the token the way applyTheme sets it.
function resolve(value: string, palette: ThemePalette): string {
  const token = /^var\(--opx-([a-zA-Z0-9]+)\)$/.exec(value.trim());
  if (!token) return value;
  return palette[token[1] as keyof ThemePalette];
}

describe("LossyExportNotice", () => {
  // The warning sits on a fixed pale-yellow box but took the theme's ink for
  // its text: in Dark mode that was near-white on yellow (about 1.05:1), so
  // the question the user had to answer before a lossy export was invisible.
  test("its text is readable on its background in every theme", () => {
    const view = render(<LossyExportNotice lostChars={3} />);
    const alert = view.getByRole("alert");
    expect(alert.textContent).toContain(i18n.t("export.lostCharsConfirmTitle"));
    for (const [theme, set] of Object.entries(THEME_PALETTE_SETS)) {
      for (const [mode, palette] of Object.entries(set)) {
        const ratio = contrastRatio(
          resolve(alert.style.color, palette),
          resolve(alert.style.background, palette),
        );
        expect({ theme, mode, ratio: ratio >= 4.5 }).toEqual({ theme, mode, ratio: true });
      }
    }
  });
});
