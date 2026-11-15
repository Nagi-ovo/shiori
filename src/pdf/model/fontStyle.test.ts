import { describe, expect, test } from "bun:test";
import { fontNamesLookBold, fontNamesLookItalic } from "./fontStyle";

// One detector decides both an original-text edit's inferred style and the
// style of the source font the export would reuse; the export reuses the
// font only when the two agree. Ways it can fail:
// - bold and italic glued together with no separator (BoldOblique,
//   BoldItalic, BoldItalicMT, BoldIt): one or both styles missed, so a
//   bold-oblique font is reused for a regular edit, or a matching bold-italic
//   edit is refused;
// - a vendor suffix glued on (Arial-BoldMT, Arial-ItalicMT);
// - a single style misread as both, or a regular face as styled;
// - TeX (cmbx, cmti, cmsl) and URW Nimbus (Medi, ReguItal, BoldItal) names;
// - a six-letter subset tag or upper-case name;
// - "bold" / "italic" letters inside an unrelated word;
// - a numeric weight from CSS (>= 600 is bold) with no style in the name.

const style = (...names: string[]) => ({
  bold: fontNamesLookBold(names),
  italic: fontNamesLookItalic(names),
});
const BOTH = { bold: true, italic: true };
const BOLD = { bold: true, italic: false };
const ITALIC = { bold: false, italic: true };
const NEITHER = { bold: false, italic: false };

describe("font style from names", () => {
  test.each([
    "Helvetica-BoldOblique",
    "Arial-BoldItalic",
    "Arial-BoldItalicMT",
    "Times-BoldItalic",
    "Courier-BoldOblique",
    "MinionPro-BoldIt",
    "ABCDEF+Times-BoldItalic",
    "TIMES-BOLDITALIC",
    "NimbusSanL-BoldItal",
  ])("%s is bold and italic", (name) => {
    expect(style(name)).toEqual(BOTH);
  });

  test.each([
    "Times-Bold",
    "Helvetica-Bold",
    "Arial-BoldMT",
    "Arial-Black",
    "SourceSansPro-Semibold",
    "AAAAAA+NotoSans-Bold",
    "CMBX10",
    "NimbusRomNo9L-Medi",
  ])("%s is bold only", (name) => {
    expect(style(name)).toEqual(BOLD);
  });

  test.each([
    "Helvetica-Oblique",
    "Times-Italic",
    "Arial-ItalicMT",
    "MinionPro-It",
    "CMTI10",
    "CMSL10",
    "NimbusRomNo9L-ReguItal",
  ])("%s is italic only", (name) => {
    expect(style(name)).toEqual(ITALIC);
  });

  test.each([
    "Helvetica",
    "Times-Roman",
    "ArialMT",
    "NotoSans-Regular",
    "Lato-Light",
    "CMR10",
    "NimbusRomNo9L-Regu",
    "Kobold-Regular",
    "Italiana-Regular",
  ])("%s is neither", (name) => {
    expect(style(name)).toEqual(NEITHER);
  });

  test("a numeric weight of 600 or more is bold, below is not", () => {
    expect(fontNamesLookBold(["Inter"], "700")).toBe(true);
    expect(fontNamesLookBold(["Inter"], "600")).toBe(true);
    expect(fontNamesLookBold(["Inter"], "400")).toBe(false);
  });

  test("CSS style keywords among the names count", () => {
    expect(fontNamesLookItalic(["Inter", "italic"])).toBe(true);
    expect(fontNamesLookItalic(["Inter", "normal"])).toBe(false);
  });
});
