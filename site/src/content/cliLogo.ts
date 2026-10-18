// Same 16-row mark as cli/installer/terminal-ui.sh. The site used to paint
// it with ▄▀█ in a monospace font; Android substitutes those glyphs from a
// second face, so the 栞 shears. These rows are now a pixel grid.

export const CLI_LOGO_ROWS = [
  "   ▄▄▄▄▄▄▄▄▄▄███  ▄▄▄▄▄▄▄▄▄▄███",
  "         ██            ██",
  "         ██   ▄        ██    ▄",
  "  ▄▄▄▄▄▄▄██▄▄███▄▄▄▄▄▄▄██▄▄▄███▄",
  "   ▀    ▀██       ▀    ██",
  "         ██            ██",
  "        ███            ██",
  "        ▀█▀     ██▄    █▀",
  "                ██          ▄█▄▄",
  "  ██▀▀▀▀▀▀▀▀▀███████▀▀▀▀▀▀▀▀▀▀▀▀",
  "            ▄██▀██ ▀▄",
  "          ▄██▀  ██   ██▄",
  "        ▄██▀    ██    ▀▀██▄▄",
  "     ▄▄▀▀       ██       ▀████▄▄",
  "  ▄▀▀▀          ██          ▀▀█▀",
  "                ▀▀",
] as const;

export const CLI_LOGO_CENTER_ROW = 9;

export type CliLogoCell = "empty" | "full" | "upper" | "lower";

export function cliLogoCellKind(glyph: string): CliLogoCell {
  switch (glyph) {
    case "█":
      return "full";
    case "▀":
      return "upper";
    case "▄":
      return "lower";
    case " ":
      return "empty";
    default:
      throw new Error(`CLI logo contains an unmapped glyph: ${JSON.stringify(glyph)}`);
  }
}

export const CLI_LOGO_COLUMNS = Math.max(
  ...CLI_LOGO_ROWS.map((row) => row.length),
);

export function cliLogoCells(row: string): CliLogoCell[] {
  const cells = Array.from(row, cliLogoCellKind);
  while (cells.length < CLI_LOGO_COLUMNS) cells.push("empty");
  return cells;
}
