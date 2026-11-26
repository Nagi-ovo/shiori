import { prepareLocalFonts, selectLocalFont } from './localFonts';

export type FontRegion = 'JP' | 'SC' | 'TC' | 'KR';
export type FontPurpose = 'cluster-fallback' | 'run-substitute' | 'vertical' | 'retypeset';
export type FontRequest = {
  purpose: FontPurpose;
  baseFont: string;
  flags: number;
  weight?: number;
  text: string;
  cidOrdering?: string;
  lang?: string;
};
export type LocalFont = { name: string; bytes: Uint8Array };
export type FontServiceOptions = { localFonts?: readonly LocalFont[] };
export type FontChoice = {
  name: string;
  source: 'bundled' | 'local';
  family: string;
  style: 'Regular' | 'Bold' | 'Italic' | 'BoldItalic';
  region?: FontRegion;
  reason: string;
};

const localFontCaches = new WeakMap<FontServiceOptions, () => ReturnType<typeof prepareLocalFonts>>();

/** Scope local program snapshots and parsed cmaps to one export operation. */
export function withCachedLocalFonts<T extends FontServiceOptions>(options: T): T {
  if (!options.localFonts?.length || localFontCaches.has(options)) return options;
  const scoped = { ...options };
  let programs: ReturnType<typeof prepareLocalFonts> | undefined;
  localFontCaches.set(scoped, () => programs ??= prepareLocalFonts(scoped.localFonts!));
  return scoped;
}

type RegionalChoice = { region: FontRegion; reason: 'script' | 'cid-ordering' | 'lang' };
type CjkScript = 'kana' | 'hangul' | 'han';

const paragraphScript = Symbol();
const descriptorFamily = Symbol();
const regionalVerticalFace = Symbol();
type LocalCapability = (bytes: Uint8Array) => boolean;
type WriterFontRequest = FontRequest & {
  [paragraphScript]?: CjkScript;
  [descriptorFamily]?: string;
  [regionalVerticalFace]?: { canUseLocal?: LocalCapability };
};
type SourceFontTraits = Pick<WriterFontRequest, 'flags' | typeof descriptorFamily>;

/** Read the containing paragraph once, keeping request.text scoped to the glyphs to draw. */
export function fontRequestsForParagraph(paragraph: string) {
  const script = cjkScript(paragraph);
  return (request: FontRequest): FontRequest => {
    const contextual: WriterFontRequest = { ...request, [paragraphScript]: script };
    return contextual;
  };
}

/** The writer needs regional coverage or metrics beyond the Latin family choice. */
export function forRegionalVerticalFace(request: FontRequest, canUseLocal?: LocalCapability): FontRequest {
  const contextual: WriterFontRequest = { ...request, [regionalVerticalFace]: { canUseLocal } };
  return contextual;
}

const bareFontName = (name: string) => name.trim().replace(/^[A-Z]{6}\+/u, '');
const fixedPitchFlag = 1;
const serifFlag = 2;
const italicFlag = 64;
const forceBold = 1 << 18;

function fontNameStyleFlags(base: string): number {
  const bold = /Bold|Black|Heavy|CM(?:BX|B)\d/i.test(base);
  const italic = /Italic|Oblique|Slanted|CM(?:TI|SL|MI)\d/i.test(base);
  return (bold ? forceBold : 0) | (italic ? italicFlag : 0);
}

function orderingRegion(ordering?: string): FontRegion | undefined {
  switch (ordering?.trim().toLowerCase()) {
    case 'japan1': return 'JP';
    case 'gb1': return 'SC';
    case 'cns1': return 'TC';
    case 'korea1': return 'KR';
  }
}

function languageRegion(lang?: string): FontRegion | undefined {
  const tag = lang?.trim().toLowerCase();
  if (!tag) return;
  switch (tag.split('-', 1)[0]) {
    case 'ja': return 'JP';
    case 'ko': return 'KR';
    case 'zh': {
      const [, script, region] = /^zh(?:-[a-z]{3}){0,3}(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?(?:-|$)/u.exec(tag) ?? [];
      return script === 'hant' || region === 'tw' || region === 'hk' || region === 'mo' ? 'TC' : 'SC';
    }
  }
}

function cjkScript(text: string): CjkScript | undefined {
  // Include kana sound marks with Script=Common while excluding punctuation
  // shared with Han or Hangul, such as the middle dot.
  const kana = /(?![\p{Script_Extensions=Han}\p{Script_Extensions=Hangul}])[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;
  if (kana.test(text)) return 'kana';
  if (/\p{Script=Hangul}/u.test(text)) return 'hangul';
  if (/\p{Script=Han}/u.test(text)) return 'han';
}

function regionalChoice(script: CjkScript | undefined, cidOrdering?: string, lang?: string, neutral?: string | true): RegionalChoice | undefined {
  if (script === 'kana') return { region: 'JP', reason: 'script' };
  if (script === 'hangul') return { region: 'KR', reason: 'script' };
  if (!script && neutral === undefined) return;
  const ordering = orderingRegion(cidOrdering);
  if (ordering) return { region: ordering, reason: 'cid-ordering' };
  const language = languageRegion(lang);
  if (language) return { region: language, reason: 'lang' };
  if (script === 'han' || neutral === true || /\p{Script_Extensions=Han}/u.test(neutral ?? '')) return { region: 'SC', reason: 'script' };
}

export function cjkRegion(text: string, cidOrdering?: string, lang?: string): FontRegion | undefined {
  return regionalChoice(cjkScript(text), cidOrdering, lang)?.region;
}

function namedLatinFamily(base: string): string | undefined {
  if (/Calibri|Carlito/i.test(base)) return 'Carlito';
  if (/Cambria|Caladea/i.test(base)) return 'Caladea';
  if (/Avant.?Garde|Adventor/i.test(base)) return 'TeXGyreAdventor';
  if (/Courier|Mono|Consolas|CM(?:TT|VTT)|LMMono/i.test(base)) return 'LiberationMono';
  if (/Arial|Helvetica|Heros|CMSS|LMSans|LatinModernSans/i.test(base)) return 'LiberationSans';
  if (/Times|Serif|Georgia|CM(?:R|BX|B|TI|SL|MI|SY|EX)|LMRoman|LatinModernRoman|Termes/i.test(base)) {
    return 'LiberationSerif';
  }
}

/** Carry descriptor evidence for bundled selection alongside the original BaseFont. */
export function sourceFontTraits(baseFont: string, flags: number, names: readonly (string | undefined)[]): SourceFontTraits {
  const hints = names.flatMap(name => name && name !== baseFont ? [bareFontName(name)] : []);
  const style = hints.reduce((value, hint) => value | fontNameStyleFlags(hint), flags);
  if (namedLatinFamily(bareFontName(baseFont))) return { flags: style };
  const family = namedLatinFamily(hints.join(' '));
  if (!family) return { flags: style };
  const generic = latinFontClass(flags, family);
  const classFlag = generic === 'LiberationMono' ? fixedPitchFlag : generic === 'LiberationSerif' ? serifFlag : 0;
  return { flags: style | classFlag, [descriptorFamily]: family };
}

function bundledLatinFont(family: string, style: FontChoice['style'], reason: string): FontChoice {
  return {
    name: `${family}-${style}.${family === 'TeXGyreAdventor' ? 'otf' : 'ttf'}`, source: 'bundled', family, style, reason,
  };
}

function latinFontClass(flags: number, namedFamily?: string): string {
  if (flags & fixedPitchFlag || namedFamily === 'LiberationMono') return 'LiberationMono';
  if (flags & serifFlag || namedFamily === 'LiberationSerif' || namedFamily === 'Caladea') return 'LiberationSerif';
  return 'LiberationSans';
}

/** The established broad-class face is available to horizontal writers
 * whose slot or layout proof depends on those metrics. */
export function genericFontForFit(request: FontRequest, primary: FontChoice): FontChoice | undefined {
  if (primary.source !== 'bundled' || primary.region ||
    (request.purpose !== 'cluster-fallback' && request.purpose !== 'retypeset')) return;
  const family = latinFontClass(request.flags, primary.family);
  if (family !== primary.family) return bundledLatinFont(family, primary.style, 'generic-class-fit');
}

export function resolveFont(request: FontRequest, options?: FontServiceOptions): FontChoice {
  const { purpose, flags, weight, cidOrdering, lang } = request;
  const base = bareFontName(request.baseFont);
  const text = request.text.normalize('NFC');
  const styleFlags = flags | fontNameStyleFlags(base);
  const bold = (weight ?? 400) >= 600 || !!(styleFlags & forceBold);
  const italic = !!(styleFlags & italicFlag);
  const contextual = request as WriterFontRequest;
  const script = cjkScript(text) ?? contextual[paragraphScript];
  const vertical = purpose === 'vertical' ? contextual[regionalVerticalFace] : undefined;
  // Shared CJK punctuation in a vertical run can still have a regional
  // alternate when neither the cluster nor the paragraph has a strong script.
  const verticalNeutral = purpose === 'vertical' && !script &&
    /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u.test(text);
  const regional = regionalChoice(script, cidOrdering, lang, vertical ? true : verticalNeutral ? text : undefined);
  const region = regional?.region;
  const style = bold ? (italic ? 'BoldItalic' : 'Bold') : italic ? 'Italic' : 'Regular';
  const programs = options?.localFonts?.length
    ? localFontCaches.get(options)?.() ?? prepareLocalFonts(options.localFonts)
    : [];
  const local = selectLocalFont(programs, base, text, style, region, vertical?.canUseLocal);
  if (local.choice) return local.choice;

  if (region) {
    const family = 'NotoSans' + (region === 'TC' ? 'SC' : region);
    const bundledStyle = bold ? 'Bold' : 'Regular';
    const reason = region === 'TC' ? regional.reason + '-tc-fallback' : regional.reason;
    return {
      name: `${family}-${bundledStyle}.otf`, source: 'bundled', family, style: bundledStyle, region,
      reason: local.permissionDenied ? 'local-permission-denied' : reason,
    };
  }
  let family = namedLatinFamily(base) ?? contextual[descriptorFamily] ?? latinFontClass(flags);
  // Caladea and Adventor leave gaps in Extended-A. Keep the serif/sans
  // class when switching to the Liberation face for those glyphs.
  if (/[\u0100-\u017f]/u.test(text) && (family === 'Caladea' || family === 'TeXGyreAdventor')) {
    family = latinFontClass(0, family);
  }
  return bundledLatinFont(family, style, local.permissionDenied ? 'local-permission-denied' : 'family-table');
}
