import type {
  CalloutOverlay,
  ContentTextOverlay,
  Overlay,
  TextOverlay,
} from "../../pdf/model/types";
import { splitGraphemes } from "../../shared/graphemes";
import { hasCjkText, hasKana } from "../../pdf/export/textScripts";

export function wrapThumbnailText(
  text: string,
  maxWidth: number,
  widthOf: (value: string) => number,
  maxLines = Number.POSITIVE_INFINITY,
): string[] {
  const lines: string[] = [];
  const push = (line: string) => {
    if (lines.length < maxLines) lines.push(line.trimEnd());
  };
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (lines.length >= maxLines) break;
    if (paragraph.length === 0) {
      push("");
      continue;
    }
    let line = "";
    for (const token of paragraph.split(/(\s+)/)) {
      if (!token || lines.length >= maxLines) continue;
      const trial = line + token;
      if (widthOf(trial) <= maxWidth) {
        line = trial;
        continue;
      }
      if (line) push(line);
      line = "";
      const nextToken = token.replace(/^\s+/, "");
      if (!nextToken || lines.length >= maxLines) continue;
      if (widthOf(nextToken) <= maxWidth) {
        line = nextToken;
        continue;
      }
      for (const grapheme of splitGraphemes(nextToken)) {
        const graphemeTrial = line + grapheme;
        if (line && widthOf(graphemeTrial) > maxWidth) {
          push(line);
          line = "";
          if (lines.length >= maxLines) break;
        }
        line += grapheme;
      }
    }
    if (line && lines.length < maxLines) push(line);
  }
  return lines;
}

type CanvasTextOverlay = TextOverlay | ContentTextOverlay | CalloutOverlay;

export function canvasFontShorthand(
  overlay: CanvasTextOverlay,
  fontSize: number,
): string {
  return `${overlay.italic ? "italic " : ""}${overlay.bold ? 600 : 400} ${fontSize}px ${canvasFontFamily(overlay.fontFamily, overlay.text)}`;
}

function canvasFontFamily(
  family: TextOverlay["fontFamily"],
  text: string,
): string {
  if (family === "notoSansSc") {
    return "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif";
  }
  if (family === "notoSansJp") {
    return "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif";
  }
  const cjkFallback = hasKana(text)
    ? "'Noto Sans JP', 'Noto Sans SC'"
    : "'Noto Sans SC', 'Noto Sans JP'";
  if (family === "serif") {
    return `'Times', 'Times New Roman', 'Liberation Serif', ${cjkFallback}, serif`;
  }
  if (family === "mono") {
    return `'JetBrains Mono', ${cjkFallback}, monospace`;
  }
  return `'Inter Tight', 'Inter', ${cjkFallback}, sans-serif`;
}

/** Load lazy webfonts before canvas text is measured and permanently rasterised. */
export async function loadThumbnailOverlayFonts(
  overlays: readonly Overlay[],
): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const requests = new Map<string, string>();
  const addRequest = (font: string, text: string) => {
    const combined = new Set(Array.from((requests.get(font) ?? "") + text));
    requests.set(font, Array.from(combined).slice(0, 512).join(""));
  };
  for (const overlay of overlays) {
    if (
      overlay.type !== "text" &&
      overlay.type !== "contentText" &&
      overlay.type !== "callout"
    ) {
      continue;
    }
    if (!overlay.text) continue;
    const sample = Array.from(overlay.text).slice(0, 512).join("");
    addRequest(canvasFontShorthand(overlay, 16), sample);
    if (overlay.fontFamily === "notoSansJp" || hasKana(overlay.text)) {
      addRequest('400 16px "Noto Sans JP"', sample);
    } else if (
      overlay.fontFamily === "notoSansSc" ||
      // Kana is ruled out above, so this is Han or Bopomofo.
      hasCjkText(overlay.text)
    ) {
      addRequest('400 16px "Noto Sans SC"', sample);
    }
  }
  try {
    await Promise.all(
      Array.from(requests, ([font, text]) => document.fonts.load(font, text)),
    );
    await document.fonts.ready;
  } catch {
    // Canvas can still use platform fallbacks. Font loading must not make
    // thumbnails or compact export fail after the PDF page has rendered.
  }
}
