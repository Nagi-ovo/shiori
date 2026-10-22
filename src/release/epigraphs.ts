// Release epigraphs: every Shiori release carries an episode title from
// Samurai Champloo, in broadcast order.
//
// The point is that nobody chooses one at release time. `scripts/prepare-
// release-notes.ts` takes the first entry with no `version` and stamps the
// version being released onto it. Consumption is append-only: once an
// entry carries a version it has shipped, and editing it would rewrite
// a changelog a user has already read. `epigraphs.test.ts` enforces
// that.
//
// Every episode title in the series is a four-character idiom, which is
// why this series and not another: the form is short enough to work as
// a codename and exists natively in all three of our languages. The
// Japanese is the original title, the Chinese is Bangumi's official
// title (subject 254), the English is the official broadcast title.
//
// Two- and three-part episodes are collapsed to one entry: shipping
// "以心伝心 其之壱" and then "其之弐" would make a release codename
// depend on whether the previous release happened to be a two-parter.
// 26 episodes, 20 distinct titles.

export type Epigraph = {
  /** Original Japanese episode title. The canonical form. */
  ja: string;
  /** Bangumi's official Simplified Chinese title. */
  zh: string;
  /** Official English broadcast title. */
  en: string;
  /** Broadcast episode number this title comes from. */
  episode: number;
  /**
   * The release that consumed this entry, e.g. "26.9.7". Absent means
   * unused. Written once by the release script and never edited after.
   */
  version?: string;
};

export type EpigraphLang = "ja" | "zh" | "en";

export const SERIES: Record<EpigraphLang, string> = {
  ja: "サムライチャンプルー",
  zh: "混沌武士",
  en: "Samurai Champloo",
};

export const EPIGRAPHS: Epigraph[] = [
  { episode: 1, ja: "疾風怒濤", zh: "疾风怒涛", en: "Tempestuous Temperaments", version: "26.9.7" },
  { episode: 2, ja: "百鬼夜行", zh: "百鬼夜行", en: "Redeye Reprisal", version: "26.9.8" },
  { episode: 3, ja: "以心伝心", zh: "以心传心", en: "Hellhounds for Hire", version: "26.9.9" },
  { episode: 5, ja: "馬耳東風", zh: "马耳东风", en: "Artistic Anarchy", version: "26.9.26" },
  { episode: 6, ja: "赤毛異人", zh: "赤毛异人", en: "Stranger Searching", version: "26.9.27" },
  { episode: 7, ja: "四面楚歌", zh: "四面楚歌", en: "A Risky Racket", version: "26.10.20" },
  { episode: 8, ja: "唯我独尊", zh: "唯我独尊", en: "A Problematic Past", version: "26.10.23" },
  { episode: 9, ja: "魑魅魍魎", zh: "魑魅魍魉", en: "Beatbox Bandits" },
  { episode: 10, ja: "以毒制毒", zh: "以毒制毒", en: "Lethal Lunacy" },
  { episode: 11, ja: "堕落天使", zh: "堕落天使", en: "Gamblers and Gallantry" },
  { episode: 12, ja: "温故知新", zh: "温故知新", en: "The Disorder Diaries" },
  { episode: 13, ja: "暗夜行路", zh: "暗夜行路", en: "Misguided Miscreants" },
  { episode: 15, ja: "徹頭徹尾", zh: "彻头彻尾", en: "Bogus Booty" },
  { episode: 16, ja: "酔生夢死", zh: "醉生梦死", en: "Lullabies of the Lost" },
  { episode: 18, ja: "文武両道", zh: "文武双全", en: "War of the Words" },
  { episode: 19, ja: "因果応報", zh: "因果报应", en: "Unholy Union" },
  { episode: 20, ja: "悲歌慷慨", zh: "悲歌慷慨", en: "Elegy of Entrapment" },
  { episode: 22, ja: "怒髪衝天", zh: "怒发冲天", en: "The Cosmic Collisions" },
  { episode: 23, ja: "一球入魂", zh: "一球入魂", en: "Baseball Blues" },
  { episode: 26, ja: "生死流転", zh: "生死流转", en: "Evanescent Encounter" },
];

/**
 * How many unused entries are left. The release script warns below
 * LOW_WATER_MARK so a new season gets curated before the pool runs dry
 * on a release day.
 */
export const LOW_WATER_MARK = 3;

export function remainingEpigraphs(pool: Epigraph[] = EPIGRAPHS): number {
  return pool.filter((e) => !e.version).length;
}

/** The entry the next release takes. Null once the pool is exhausted. */
export function nextEpigraph(pool: Epigraph[] = EPIGRAPHS): Epigraph | null {
  return pool.find((e) => !e.version) ?? null;
}

export function epigraphForVersion(
  version: string,
  pool: Epigraph[] = EPIGRAPHS,
): Epigraph | undefined {
  return pool.find((e) => e.version === version);
}

/**
 * The line that goes into the changelog, the release body and the
 * update notice. Deliberately bare: a codename, not a citation. Anyone
 * who recognises it recognises it; naming the series on every release
 * would turn a quiet signature into an advertisement.
 */
export function formatEpigraph(epigraph: Epigraph, lang: EpigraphLang): string {
  return epigraph[lang];
}
