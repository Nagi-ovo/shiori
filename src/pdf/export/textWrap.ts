import type { PDFFont } from "pdf-lib";
import { splitGraphemes } from "../../shared/graphemes";
import { hasNonAscii } from "./textScripts";
import { pathTextWidth, type PathTextFont } from "./vectorText";

export function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  pathFont?: PathTextFont | null,
  pathFontUse: PathFontUse | boolean = false,
): string[] {
  const out: string[] = [];
  const paragraphs = text.split(/\r?\n/);
  const widthOf = (value: string): number =>
    measureTextWidth(font, value, size, pathFont, pathFontUse);

  const appendOversizedNonAsciiToken = (token: string): string => {
    let line = "";
    for (const ch of splitGraphemes(token)) {
      const trial = line + ch;
      if (widthOf(trial) > maxWidth && line.length > 0) {
        out.push(line.trimEnd());
        line = ch.replace(/^\s+/, "");
      } else {
        line = trial;
      }
    }
    return line;
  };

  for (const para of paragraphs) {
    if (para.length === 0) {
      out.push("");
      continue;
    }
    const tokens = para.split(/(\s+)/);
    let line = "";
    for (const token of tokens) {
      if (token.length === 0) continue;
      const trial = line + token;
      if (widthOf(trial) <= maxWidth) {
        line = trial;
        continue;
      }

      if (line.length > 0) {
        out.push(line.trimEnd());
        line = "";
      }

      const nextToken = token.replace(/^\s+/, "");
      if (nextToken.length === 0) continue;
      line =
        widthOf(nextToken) > maxWidth && hasNonAscii(nextToken)
          ? appendOversizedNonAsciiToken(nextToken)
          : nextToken;
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

// Which face a line is drawn in when a path (outline) font is at hand.
// Measuring and drawing must agree on it, so both ask usesPathFont:
// - "always": the overlay SELECTED a Noto family, so every line is Noto,
//   ASCII included. Measuring ASCII on Helvetica advances while drawing Noto
//   outlines (~6.6% wider) pushed centred lines off-centre, overflowed
//   right-aligned lines past the box and wrapped against the wrong width.
// - "nonAscii": any non-ASCII line goes to outlines (the editable FreeText
//   and callout appearance writers).
// - "unencodable": only a line the PDF font cannot encode goes to outlines;
//   WinAnsi Latin (curly quotes, dashes, accents) stays real, searchable
//   text (page content: flattened boxes and original-text edits).
// `true` / `false` are the older spellings of "always" / "nonAscii".
export type PathFontUse = "always" | "nonAscii" | "unencodable";

export function usesPathFont(
  font: PDFFont,
  text: string,
  pathFont: PathTextFont | null | undefined,
  use: PathFontUse | boolean = false,
): pathFont is PathTextFont {
  if (!pathFont) return false;
  const mode = use === true ? "always" : use === false ? "nonAscii" : use;
  if (mode === "always") return true;
  if (mode === "nonAscii") return hasNonAscii(text);
  return !encodesText(font, text);
}

export function encodesText(font: PDFFont, text: string): boolean {
  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

export function measureTextWidth(
  font: PDFFont,
  text: string,
  size: number,
  pathFont?: PathTextFont | null,
  pathFontUse: PathFontUse | boolean = false,
): number {
  if (usesPathFont(font, text, pathFont, pathFontUse)) {
    return pathTextWidth(pathFont, text, size);
  }
  return safeWidthOf(font, text, size);
}

function safeWidthOf(font: PDFFont, text: string, size: number): number {
  try {
    return font.widthOfTextAtSize(text, size);
  } catch {
    return Array.from(text).length * size * 0.55;
  }
}
