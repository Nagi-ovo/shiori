// Single keyboard-shortcut renderer used everywhere on the site so the
// chip styling, sizing, and spacing stay consistent. Splits a string
// like "⇧⌘D" or "⌘E" or "V" into individual glyph chips — the macOS
// menu-bar convention. Modifier glyphs (⇧⌘⌥⌃) are single Unicode
// codepoints; alphanumeric keys are 1 char each.
//
// Cross-platform: callers always pass Mac symbols as the canonical
// form (`⇧⌘D`). At render time we detect Windows / Linux and translate
// the modifiers (⌘ → Ctrl, ⌥ → Alt). The shift symbol ⇧ is Unicode-
// universal and stays as-is. The letter / digit keys never translate.
//
// Surface adapts via CSS: solid neutral chip on cards / chrome, and an
// inverted "tinted-currentColor" chip when nested inside a dark CTA
// button. See .kbd-key + parent overrides in index.css.

type Props = {
  /** Shortcut in canonical Mac form. No separators. Examples: "⇧⌘D",
   *  "⌘E", "V", "⌘⇧4". Whitespace inside is ignored so existing
   *  strings like "⌘ ⇧ 4" still split cleanly. */
  keys: string;
};

import { usesAppleKeys } from "../platform";

// Detected once on module load via the shared platform module. Apple
// platforms keep the symbol form; everything else gets the PC/Linux text form.
const USE_APPLE_KEYS = usesAppleKeys();

const MAC_TO_PC: Record<string, string> = {
  "⌘": "Ctrl",
  "⌥": "Alt",
  // ⌃ is "Control" on Mac too — render as Ctrl on PC for consistency.
  "⌃": "Ctrl",
  // ⇧ Shift is universal Unicode; leave as the symbol on both platforms
  // so the chip stays compact. (Mapped to "Shift" only if you'd rather
  // be explicit — flip the value if so.)
};

function splitKeys(raw: string): string[] {
  const tokens = Array.from(raw.replace(/\s+/g, ""));
  if (USE_APPLE_KEYS) return tokens;
  return tokens.map((t) => MAC_TO_PC[t] ?? t);
}

export function Kbd({ keys }: Props) {
  const tokens = splitKeys(keys);
  return (
    <span className="kbd" aria-label={tokens.join(" ")}>
      {tokens.map((tok, i) => (
        <span
          key={i}
          className={tok.length > 1 ? "kbd-key kbd-key-wide" : "kbd-key"}
        >
          {tok}
        </span>
      ))}
    </span>
  );
}
