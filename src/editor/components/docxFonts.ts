import {
  composeFontConfiguration,
  loadFonts,
  type FontConfigurationFragment,
  type FontLoadFailure,
  type FontSourceSubstitution,
} from "@docx-editor.dev/core";
import {
  ALL_WORD_DEFAULT_FAMILIES,
  defaultFonts,
  type DefaultFontLoadFailure,
} from "@docx-editor.dev/fonts";
import { strFromU8, unzipSync } from "fflate";

const notoSansScUrl = new URL(
  "../../assets/fonts/NotoSansSC-Regular.otf",
  import.meta.url,
).href;
const notoSansJpUrl = new URL(
  "../../assets/fonts/NotoSansJP-Regular.otf",
  import.meta.url,
).href;

const CJK_SANS_FAMILIES = {
  "Noto Sans SC": [
    "Microsoft YaHei",
    "Microsoft YaHei UI",
    "微软雅黑",
    "SimHei",
    "黑体",
    "DengXian",
    "等线",
    "PingFang SC",
    "苹方-简",
    "Heiti SC",
    "STHeiti",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "思源黑体 CN",
  ],
  "Noto Sans JP": [
    "Yu Gothic",
    "Yu Gothic UI",
    "YuGothic",
    "游ゴシック",
    "Meiryo",
    "Meiryo UI",
    "メイリオ",
    "MS Gothic",
    "ＭＳ ゴシック",
    "MS PGothic",
    "ＭＳ Ｐゴシック",
    "MS UI Gothic",
    "Noto Sans CJK JP",
    "Source Han Sans JP",
  ],
} as const;

const CJK_SUBSTITUTIONS = Object.freeze(
  Object.entries(CJK_SANS_FAMILIES).flatMap(([targetFamily, aliases]) =>
    aliases.flatMap((family) =>
      ([400, 700] as const).flatMap((weight) =>
        (["normal", "italic"] as const).map(
          (style): FontSourceSubstitution => ({
            from: { family, weight, style },
            to: { family: targetFamily, weight: 400, style: "normal" },
          }),
        ),
      ),
    ),
  ),
);

export type DocxFontLoadFailure =
  | DefaultFontLoadFailure
  | FontLoadFailure;

/**
 * Load only app-bundled fonts before the first DOCX layout. The explicit
 * substitutions are intentional: docx-editor performs no implicit platform
 * fallback, and measuring an unavailable CJK face with fixed Latin metrics
 * while the browser paints CJK glyphs makes lines overrun the paper.
 *
 * Serif/Mincho/Kai families are deliberately absent. Replacing those with a
 * sans face would hide overflow by changing the document's type category.
 */
export async function loadShioriDocxFonts(options?: {
  onFailure?: (failure: DocxFontLoadFailure) => void;
  /**
   * The families the document names (see {@link scanDocxFontFamilies}). Only
   * the faces those need are loaded: the Word default substitutes the file
   * uses, plus Noto Sans SC / JP when an alias in the substitution map is
   * named. Omitted, everything loads — 7.4 MB of Word substitutes and 12 MB
   * of CJK — which is what every .docx used to cost before first paint.
   */
  families?: Iterable<string>;
}): Promise<FontConfigurationFragment> {
  const named = options?.families
    ? new Set(Array.from(options.families, normalizeFamily))
    : null;
  const wordFamilies = named
    ? ALL_WORD_DEFAULT_FAMILIES.filter(
        (family) =>
          // The engine measures a run that names no font in Calibri, so its
          // substitute is the floor whatever the file says.
          family === "Calibri" || named.has(normalizeFamily(family)),
      )
    : undefined;
  const cjkSources = CJK_SOURCES.filter(
    (source) => named === null || namesAlias(named, source.family),
  );
  const [wordDefaults, cjkFonts] = await Promise.all([
    defaultFonts({
      onFailure: options?.onFailure,
      ...(wordFamilies ? { families: wordFamilies } : {}),
    }),
    cjkSources.length > 0
      ? loadFonts({ sources: cjkSources })
      : { sources: [], failures: [] },
  ]);
  for (const failure of cjkFonts.failures) options?.onFailure?.(failure);

  // A substitution whose target never loaded would send the engine looking
  // for bytes that are not there; keep only the ones a loaded face answers.
  const loadedTargets = new Set<string>(
    cjkSources.map((source) => source.family),
  );
  return composeFontConfiguration(
    {},
    wordDefaults,
    cjkFonts,
    {
      substitutions: CJK_SUBSTITUTIONS.filter((substitution) =>
        loadedTargets.has(substitution.to.family),
      ),
    },
  );
}

type CjkSource = {
  url: string;
  family: keyof typeof CJK_SANS_FAMILIES;
  weight: 400;
  style: "normal";
};

const CJK_SOURCES: readonly CjkSource[] = [
  { url: notoSansScUrl, family: "Noto Sans SC", weight: 400, style: "normal" },
  { url: notoSansJpUrl, family: "Noto Sans JP", weight: 400, style: "normal" },
];

// Word matches font names case-insensitively; so does the engine.
function normalizeFamily(family: string): string {
  return family.trim().toLowerCase();
}

function namesAlias(
  named: ReadonlySet<string>,
  target: keyof typeof CJK_SANS_FAMILIES,
): boolean {
  if (named.has(normalizeFamily(target))) return true;
  return CJK_SANS_FAMILIES[target].some((alias) =>
    named.has(normalizeFamily(alias)),
  );
}

const FONT_ATTRIBUTE =
  /\b(?:w:ascii|w:hAnsi|w:eastAsia|w:cs|typeface)="([^"]*)"/g;

/**
 * Every font family a .docx names, read straight from its XML parts: run and
 * style `w:rFonts` slots, theme `a:latin` / `a:ea` / `a:cs` typefaces. The
 * engine extracts the same list — but only after it has parsed the file, and
 * the eager font loader has to decide before that, because it is the one
 * form that holds the document back until fonts settle (no re-pagination
 * once the faces arrive). Text-only substring matching over the XML: a
 * family named in a comment or a bookmark costs one needless face, never a
 * missing one.
 *
 * Only `word/*.xml` parts are inflated; media stays compressed.
 */
export function scanDocxFontFamilies(bytes: Uint8Array): Set<string> {
  const families = new Set<string>();
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes, {
      filter: (file) => /^word\/.*\.xml$/i.test(file.name),
    });
  } catch {
    return families;
  }
  for (const part of Object.values(parts)) {
    const xml = strFromU8(part);
    for (const match of xml.matchAll(FONT_ATTRIBUTE)) {
      const family = unescapeXml(match[1] ?? "").trim();
      if (family) families.add(family);
    }
  }
  return families;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
