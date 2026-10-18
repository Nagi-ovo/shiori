// Shared text-script predicates used by both export paths (flatten in
// exportPdf.ts and editable-mode FreeText in annotations.ts). Both
// need to agree on "does this overlay contain Japanese kana?" so the
// JP font gets picked consistently — keep the ranges in one place.

// Hiragana (U+3040–U+309F), Katakana (U+30A0–U+30FF), Katakana Phonetic
// Extensions (U+31F0–U+31FF — rare but used for Ainu), and half-width
// kana (U+FF66–U+FF9F — common on older Japanese web pages and receipts).
const KANA_RE = /[぀-ヿㇰ-ㇿｦ-ﾟ]/;

export function hasKana(s: string): boolean {
  return KANA_RE.test(s);
}

const HAN_OR_BOPOMOFO_RE = /[\p{Script=Han}\p{Script=Bopomofo}]/u;

/** Text that can benefit from the bundled SC ↔ JP glyph fallback pair. */
export function hasCjkText(s: string): boolean {
  return hasKana(s) || HAN_OR_BOPOMOFO_RE.test(s);
}

// eslint-disable-next-line no-control-regex
const NON_ASCII_RE = /[^\x00-\x7F]/;

export function hasNonAscii(s: string): boolean {
  return NON_ASCII_RE.test(s);
}

export function baseTextDirection(text: string): "ltr" | "rtl" {
  for (const char of text) {
    if (/\p{White_Space}|[\p{P}\p{N}\p{S}]/u.test(char)) continue;
    if (/\p{Script=Arabic}|\p{Script=Hebrew}/u.test(char)) return "rtl";
    return "ltr";
  }
  return "ltr";
}
