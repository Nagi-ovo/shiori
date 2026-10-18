import type { Font as FontkitFont } from "@pdf-lib/fontkit";
import { splitGraphemes } from "../../shared/graphemes";
import {
  appendBezierCurve,
  appendQuadraticCurve,
  closePath,
  fill,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingColor,
} from "pdf-lib";

const SYNTHETIC_ITALIC_SHEAR = 0.22;

type PathOperator = ReturnType<typeof fill>;

export type PathTextFont =
  | FontkitFont
  | {
      primary: FontkitFont;
      fallbacks?: FontkitFont[];
    };

type GlyphPathCommand = {
  command: string;
  args?: number[];
};

type GlyphPath = {
  commands?: GlyphPathCommand[];
};

export function drawPathText(
  font: PathTextFont,
  text: string,
  x: number,
  baselineY: number,
  size: number,
  color: [number, number, number],
  syntheticItalic: boolean,
) {
  const fontSpec = normalizePathFont(font);
  const drawableText = sanitizePathText(fontSpec, text).text;
  const shear = syntheticItalic ? SYNTHETIC_ITALIC_SHEAR : 0;
  const operators = [
    pushGraphicsState(),
    setFillingColor(rgb(color[0], color[1], color[2])),
  ];
  let cursorX = x;

  if (fontSpec.fallbacks.length === 0) {
    cursorX = appendPathTextRun(
      operators,
      fontSpec.primary,
      drawableText,
      cursorX,
      baselineY,
      size,
      shear,
    );
  } else {
    for (const run of pathTextRuns(fontSpec, drawableText)) {
      cursorX = appendPathTextRun(
        operators,
        run.font,
        run.text,
        cursorX,
        baselineY,
        size,
        shear,
      );
    }
  }
  operators.push(popGraphicsState());
  return operators;
}

export function pathTextWidth(font: PathTextFont, text: string, size: number): number {
  const fontSpec = normalizePathFont(font);
  const drawableText = sanitizePathText(fontSpec, text).text;
  if (fontSpec.fallbacks.length === 0) {
    return pathTextRunWidth(fontSpec.primary, drawableText, size);
  }
  return pathTextRuns(fontSpec, drawableText).reduce((total, run) => {
    return total + pathTextRunWidth(run.font, run.text, size);
  }, 0);
}

export function pathTextLostChars(font: PathTextFont, text: string): number {
  const fontSpec = normalizePathFont(font);
  return sanitizePathText(fontSpec, text).lostChars;
}

export function glyphPathOperators(
  path: unknown,
  x: number,
  y: number,
  scale: number,
  shear: number,
) {
  if (![x, y, scale, shear].every(Number.isFinite)) return [];

  const commands = (path as GlyphPath).commands ?? [];
  const operators = [];
  const tx = (glyphX: number, glyphY: number) =>
    x + (glyphX + glyphY * shear) * scale;
  const ty = (glyphY: number) => y + glyphY * scale;
  let openSubpath = false;

  for (const cmd of commands) {
    const args = cmd.args ?? [];
    if (cmd.command === "moveTo") {
      if (!hasFiniteArgs(args, 2)) continue;
      operators.push(moveTo(tx(args[0]!, args[1]!), ty(args[1]!)));
      openSubpath = true;
    } else if (cmd.command === "lineTo") {
      if (!openSubpath || !hasFiniteArgs(args, 2)) continue;
      operators.push(lineTo(tx(args[0]!, args[1]!), ty(args[1]!)));
    } else if (cmd.command === "quadraticCurveTo") {
      if (!openSubpath || !hasFiniteArgs(args, 4)) continue;
      operators.push(
        appendQuadraticCurve(
          tx(args[0]!, args[1]!),
          ty(args[1]!),
          tx(args[2]!, args[3]!),
          ty(args[3]!),
        ),
      );
    } else if (cmd.command === "bezierCurveTo") {
      if (!openSubpath || !hasFiniteArgs(args, 6)) continue;
      operators.push(
        appendBezierCurve(
          tx(args[0]!, args[1]!),
          ty(args[1]!),
          tx(args[2]!, args[3]!),
          ty(args[3]!),
          tx(args[4]!, args[5]!),
          ty(args[5]!),
        ),
      );
    } else if (cmd.command === "closePath" && openSubpath) {
      operators.push(closePath());
      openSubpath = false;
    }
  }

  return operators;
}

function hasFiniteArgs(args: number[], count: number): boolean {
  if (args.length < count) return false;
  for (let i = 0; i < count; i += 1) {
    if (!Number.isFinite(args[i])) return false;
  }
  return true;
}

function appendPathTextRun(
  operators: PathOperator[],
  font: FontkitFont,
  text: string,
  cursorX: number,
  baselineY: number,
  size: number,
  shear: number,
): number {
  const scale = size / font.unitsPerEm;
  const run = font.layout(text);
  for (let i = 0; i < run.glyphs.length; i += 1) {
    const glyph = run.glyphs[i]!;
    const pos = run.positions[i]!;
    const glyphX = cursorX + pos.xOffset * scale;
    const glyphY = baselineY + pos.yOffset * scale;
    const pathOperators = glyphPathOperators(
      glyph.path,
      glyphX,
      glyphY,
      scale,
      shear,
    );
    if (pathOperators.length > 0) {
      operators.push(...pathOperators, fill());
    }
    cursorX += pos.xAdvance * scale;
  }
  return cursorX;
}

function pathTextRunWidth(font: FontkitFont, text: string, size: number): number {
  const scale = size / font.unitsPerEm;
  const run = font.layout(text);
  return run.positions.reduce((total, pos) => total + pos.xAdvance * scale, 0);
}

type NormalizedPathFont = {
  primary: FontkitFont;
  fallbacks: FontkitFont[];
};

function normalizePathFont(font: PathTextFont): NormalizedPathFont {
  if ("primary" in font) {
    return {
      primary: font.primary,
      fallbacks: font.fallbacks ?? [],
    };
  }
  return { primary: font, fallbacks: [] };
}

function sanitizePathText(
  font: NormalizedPathFont,
  text: string,
): { text: string; lostChars: number } {
  let lostChars = 0;
  const sanitized = splitGraphemes(text)
    .map((cluster) => {
      if (pickTextFont(font, cluster)) return cluster;
      lostChars += Array.from(cluster).length;
      return "?";
    })
    .join("");
  return { text: sanitized, lostChars };
}

function pathTextRuns(
  font: NormalizedPathFont,
  text: string,
): Array<{ font: FontkitFont; text: string }> {
  const runs: Array<{ font: FontkitFont; text: string }> = [];
  for (const cluster of splitGraphemes(text)) {
    const clusterFont = pickTextFont(font, cluster) ?? font.primary;
    const previous = runs.at(-1);
    if (previous?.font === clusterFont) previous.text += cluster;
    else runs.push({ font: clusterFont, text: cluster });
  }
  return runs;
}

function pickTextFont(
  font: NormalizedPathFont,
  text: string,
): FontkitFont | null {
  if (fontSupportsText(font.primary, text)) return font.primary;
  for (const fallback of font.fallbacks) {
    if (fontSupportsText(fallback, text)) return fallback;
  }
  return null;
}

function fontSupportsText(font: FontkitFont, text: string): boolean {
  return Array.from(text).every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && font.glyphForCodePoint(codePoint).id !== 0;
  });
}
