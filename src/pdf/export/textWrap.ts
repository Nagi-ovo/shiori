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
  alwaysUsePathFont = false,
): string[] {
  const out: string[] = [];
  const paragraphs = text.split(/\r?\n/);
  const widthOf = (value: string): number =>
    measureTextWidth(font, value, size, pathFont, alwaysUsePathFont);

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

// `alwaysUsePathFont` exists because measuring and drawing must agree on which
// face is used. Flatten mode draws with the path font whenever the overlay
// SELECTED a Noto family, not only when the line contains non-ASCII — so for a
// pure-ASCII line in Noto Sans SC the glyphs came from Noto while the advances
// came from Helvetica. Noto's ASCII runs ~6.6% wider, which pushed centred
// lines off-centre, overflowed right-aligned lines past the box, and wrapped
// against a width the text did not actually occupy. Callers that draw by
// family pass true here; callers that switch on the text itself do not.
export function measureTextWidth(
  font: PDFFont,
  text: string,
  size: number,
  pathFont?: PathTextFont | null,
  alwaysUsePathFont = false,
): number {
  if (pathFont && (alwaysUsePathFont || hasNonAscii(text))) {
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
