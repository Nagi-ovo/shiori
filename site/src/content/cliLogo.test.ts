import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CLI_LOGO_CENTER_ROW,
  CLI_LOGO_COLUMNS,
  CLI_LOGO_ROWS,
  cliLogoCellKind,
  cliLogoCells,
} from "./cliLogo";

describe("CLI logo pixel grid", () => {
  test("accepts only the four block glyphs the installer already draws", () => {
    for (const row of CLI_LOGO_ROWS) {
      expect(() => cliLogoCells(row)).not.toThrow();
    }
    expect(cliLogoCellKind(" ")).toBe("empty");
    expect(cliLogoCellKind("█")).toBe("full");
    expect(cliLogoCellKind("▀")).toBe("upper");
    expect(cliLogoCellKind("▄")).toBe("lower");
    expect(() => cliLogoCellKind("░")).toThrow();
  });

  test("pads every row to one width so the mark cannot shear", () => {
    expect(CLI_LOGO_COLUMNS).toBe(32);
    expect(CLI_LOGO_ROWS).toHaveLength(16);
    for (const row of CLI_LOGO_ROWS) {
      expect(cliLogoCells(row)).toHaveLength(CLI_LOGO_COLUMNS);
    }
  });
});

// The rows above are a copy of the installer's, and a copy with no test is a
// copy that drifts. Every assertion in the block above compares the data to
// expectations derived from that same data, so either side could be edited
// alone and stay green. This one reads the shell script.
describe("CLI logo and the installer it mirrors", () => {
  const installer = readFileSync(
    resolve(import.meta.dir, "..", "..", "..", "cli", "installer", "terminal-ui.sh"),
    "utf8",
  );

  function installerLogoRows(): string[] {
    const rows: string[] = [];
    for (const line of installer.split("\n")) {
      const match = /^\s*(\d+)\)\s*SHIORI_UI_LOGO_ROW='(.*)'\s*;;\s*$/.exec(line);
      if (!match) continue;
      rows[Number(match[1])] = match[2];
    }
    return rows;
  }

  test("draws the same mark, row for row", () => {
    const rows = installerLogoRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual([...CLI_LOGO_ROWS]);
  });

  test("grows from the row the installer centers on", () => {
    // shiori_installer_draw_logo_frame measures each row's distance from a
    // literal centre index, and the reveal expands outward from it. The site
    // has to start on the same row or the two tell different stories about
    // the same mark.
    const centre = /shiori_ui_distance=\$\(\(shiori_ui_y - (\d+)\)\)/.exec(installer);
    expect(centre).not.toBeNull();
    expect(Number(centre![1])).toBe(CLI_LOGO_CENTER_ROW);
  });

  test("walks the same number of rows the site renders", () => {
    const bound = /while \[ "\$shiori_ui_y" -le (\d+) \]/.exec(installer);
    expect(bound).not.toBeNull();
    expect(Number(bound![1])).toBe(CLI_LOGO_ROWS.length - 1);
  });
});
