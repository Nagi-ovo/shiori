import fontkit from '@pdf-lib/fontkit';
import { fontNamesLookBold, fontNamesLookItalic } from '../../model/fontStyle';
import { allowsSubsetEmbedding, fontOs2 } from './fontPermissions';
import type { FontChoice, FontRegion, LocalFont } from './fontService';

const subsetPrefix = /^[A-Z]{6}\+/u;
const separatedStyle = /[-_,\s]+(?:(?:(?:semi|demi|extra|ultra)[-_\s]*)?(?:bold|black|heavy|light|medium)(?:[-_\s]*(?:italic|it|oblique|obl|slanted))?|regular|italic|it|oblique|obl|slanted|sl|roman|book)(?:mt|ps)?$/iu;

function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase().replace(/[-_,\s]+/gu, '');
}

function withoutStyle(name: string): string {
  const style = separatedStyle.exec(name);
  const family = style ? name.slice(0, style.index) : name;
  // These families use <stem>PSMT and <stem>PS-<style>MT.
  // Elsewhere PS and MT can be part of the family name.
  const conventional = style && /MT$/iu.test(style[0]) ? family + 'MT' : name;
  const stem = /^(TimesNewRoman|CourierNew)PSMT$/iu.exec(conventional)?.[1]?.toLowerCase();
  if (stem) return stem === 'couriernew' ? 'Courier New' : 'Times New Roman';
  return family;
}

function isTraditionalChinese(family: string, postscript: string, codePageRange?: number[]): boolean {
  // OS/2 code page 950, or an explicit regional tag in an internal font name.
  if ((codePageRange?.[0] ?? 0) & (1 << 20)) return true;
  return [family, withoutStyle(postscript)].some(name =>
    /(?:^|[-_\s])(?:tc|tw|hant)$/iu.test(name) ||
    /^(?:notosans|notoserif|sourcehansans|sourcehanserif|pingfang)(?:cjk)?(?:tc|tw)$/u.test(nameKey(name)),
  );
}

function localStyle(names: string[], os2: ReturnType<typeof fontOs2>): FontChoice['style'] {
  const bold = os2?.fsSelection?.bold || fontNamesLookBold(names, os2?.usWeightClass?.toString());
  const italic = os2?.fsSelection?.italic || os2?.fsSelection?.oblique || fontNamesLookItalic(names);
  return bold ? (italic ? 'BoldItalic' : 'Bold') : italic ? 'Italic' : 'Regular';
}

type LocalProgram = {
  name: string;
  bytes: Uint8Array;
  parsed: ReturnType<typeof fontkit.create>;
  family: string;
  familyKey: string;
  postscript: string;
  postscriptKey: string;
  postscriptFamilyKey: string;
  style: FontChoice['style'];
  traditional: boolean;
  embeddingAllowed: boolean;
};

// A writer keeps the original choice so equal display names cannot cause it
// to load a different program. The snapshot also survives caller mutations.
const chosenBytes = new WeakMap<FontChoice, Uint8Array>();

export function localFontBytes(choice: FontChoice): Uint8Array | undefined {
  return chosenBytes.get(choice);
}

function comparePrograms(a: LocalProgram, b: LocalProgram): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.postscript !== b.postscript) return a.postscript < b.postscript ? -1 : 1;
  if (a.bytes.length !== b.bytes.length) return a.bytes.length - b.bytes.length;
  for (let i = 0; i < a.bytes.length; i++) {
    const difference = a.bytes[i]! - b.bytes[i]!;
    if (difference) return difference;
  }
  return 0;
}

export function prepareLocalFonts(fonts: readonly LocalFont[]): LocalProgram[] {
  const programs: LocalProgram[] = [];
  for (const font of fonts) {
    try {
      if (!font || typeof font.name !== 'string' || !font.name.trim() ||
        !(font.bytes instanceof Uint8Array) || !font.bytes.length) continue;

      const bytes = new Uint8Array(font.bytes);
      const parsed = fontkit.create(bytes);
      const family = parsed.familyName?.trim() ?? '';
      const postscript = parsed.postscriptName?.trim() ?? '';
      if ((!family && !postscript) || subsetPrefix.test(family) || subsetPrefix.test(postscript)) continue;

      const os2 = fontOs2(parsed);
      const postscriptFamily = withoutStyle(postscript);
      programs.push({
        name: font.name, bytes, parsed, family: family || postscriptFamily, familyKey: nameKey(family), postscript,
        postscriptKey: nameKey(postscript), postscriptFamilyKey: nameKey(postscriptFamily),
        style: localStyle([postscript, parsed.subfamilyName ?? ''], os2),
        traditional: isTraditionalChinese(family, postscript, os2?.codePageRange),
        embeddingAllowed: allowsSubsetEmbedding(os2),
      });
    } catch {
      // Ignore fonts whose program or font metadata cannot be read.
    }
  }
  // Compare tied names/programs once, even when every cluster needs a choice.
  return programs.sort(comparePrograms);
}

export function fontChoiceKey(choice: FontChoice): string | Uint8Array {
  return choice.source === 'local' ? localFontBytes(choice)! : choice.name;
}

export function selectLocalFont(
  programs: readonly LocalProgram[], base: string, text: string, style: FontChoice['style'], region?: FontRegion,
  canUseProgram?: (bytes: Uint8Array) => boolean,
): { choice?: FontChoice; permissionDenied: boolean } {
  if (!programs.length || !base) return { permissionDenied: false };

  const baseKey = nameKey(base);
  const familyKey = nameKey(withoutStyle(base));
  const codePoints = [...new Set(Array.from(text, c => c.codePointAt(0)!))];
  let permissionDenied = false;
  let best: LocalProgram | undefined, bestRank = Infinity;
  for (const program of programs) {
    const { postscriptKey, familyKey: localFamilyKey, postscriptFamilyKey, parsed } = program;
    const exactPostscript = !!postscriptKey && postscriptKey === baseKey;
    const familyMatch = !!localFamilyKey && (localFamilyKey === baseKey || localFamilyKey === familyKey);
    const postscriptMatch = !!familyKey && postscriptFamilyKey === familyKey;
    if (!exactPostscript && !familyMatch && !postscriptMatch) continue;
    if (region === 'TC' && !program.traditional) continue;

    const rank = (program.style === style ? 0 : 2) + (exactPostscript ? 0 : 1);
    if (rank >= bestRank) continue;
    try {
      const glyphCount = parsed.numGlyphs;
      const coversText = codePoints.length ? codePoints.every(cp => {
        const id = parsed.glyphForCodePoint(cp).id;
        return id > 0 && id < glyphCount;
      }) : parsed.characterSet.length > 0;
      if (!glyphCount || !coversText) continue;
    } catch {
      // A broken cmap can first fail when fontkit reads it lazily.
      continue;
    }

    if (!program.embeddingAllowed) {
      permissionDenied = true;
      continue;
    }
    if (canUseProgram && !canUseProgram(program.bytes)) continue;
    best = program;
    bestRank = rank;
  }
  if (!best) return { permissionDenied };

  const choice: FontChoice = {
    name: best.name, source: 'local', family: best.family, style: best.style, reason: 'local-match',
    ...(region ? { region } : {}),
  };
  chosenBytes.set(choice, best.bytes);
  return { choice, permissionDenied };
}
