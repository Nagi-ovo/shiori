// Bold / italic read off a font's names. One detector for both sides of an
// original-text edit: the edit infers its style from the text layer's runs
// (whose fontName is the PDF /BaseFont), and the export asks the same
// question of the source /Font it would reuse. Two detectors that disagreed
// would turn an untouched style into a "toggle" (or hide a real one).

// PostScript names glue styles together with no separator: Helvetica-
// BoldOblique, Arial-BoldItalicMT, MinionPro-BoldIt. So a weight word may be
// followed by a slant word or vendor suffix, and a slant word may follow a
// weight word directly; the leading \b still keeps "Kobold" out.
const BOLD_NAME_RE =
  /\b(?:demi[-\s]?|semi[-\s]?)?(?:bold|black|heavy)(?:it|ital|italic|obl|obli|oblique|slanted|mt|ps)*\b|cmbx|nimbus(?:rom|san)[^\s,]*[-_]?bold|nimbus(?:rom|san)[^\s,]*[-_]?med/u;
const ITALIC_NAME_RE =
  /(?:italic|oblique|slanted)(?:mt|ps)*\b|(?:bold|black|heavy)(?:it|obl)(?:\b|[-_\d])|[-_](?:it|obl|sl)(?:\b|[-_\d])|cm(?:ti|sl)|cmmib|nimbus(?:rom|san)[^\s,]*[-_]?(?:ital|obli)/u;

export function fontNamesLookBold(
  names: readonly (string | undefined)[],
  weight?: string,
): boolean {
  const numericWeight = Number.parseInt(weight ?? "", 10);
  return (
    (Number.isFinite(numericWeight) && numericWeight >= 600) ||
    BOLD_NAME_RE.test(joinNames(names))
  );
}

export function fontNamesLookItalic(
  names: readonly (string | undefined)[],
): boolean {
  return ITALIC_NAME_RE.test(joinNames(names));
}

function joinNames(names: readonly (string | undefined)[]): string {
  return names.filter(Boolean).join(" ").toLowerCase();
}
