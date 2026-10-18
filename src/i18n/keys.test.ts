import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// i18next answers a missing key by printing the key itself, so a typo or a
// key added to the wrong block ships as raw English in the UI and nothing
// fails. That happened: `navigator.marks` was written into the `nav` block by
// mistake and the tab rendered the literal text "navigator.marks".
//
// These two checks close that gap: every static t("…") in the source must
// exist in en.json, and the other locales must carry the same keys.

const LOCALES = ["en", "zh", "ja"] as const;

function loadLocale(lang: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./locales/${lang}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function flatten(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "node_modules" ? [] : sourceFiles(path);
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [path];
  });
}

const enKeys = new Set(flatten(loadLocale("en")));

/** i18next resolves a plural key to its `_one` / `_other` variant. */
function resolves(key: string): boolean {
  return (
    enKeys.has(key) || enKeys.has(`${key}_one`) || enKeys.has(`${key}_other`)
  );
}

describe("i18n keys", () => {
  test("every static t(\"…\") in the source exists in en.json", () => {
    const missing: string[] = [];
    for (const file of sourceFiles(new URL("..", import.meta.url).pathname)) {
      const source = readFileSync(file, "utf8");
      // Only plain-quoted literals. Template literals are dynamic keys
      // (`tools.${kind}`) and cannot be checked without evaluating them.
      for (const match of source.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)) {
        const key = match[1];
        if (key && !resolves(key)) missing.push(`${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every {{count}} string has plural forms in every locale", () => {
    // A single form reads as English only by luck: "1 replies", "1 more tabs".
    // i18next picks the variant by plural category, so the key must have them
    // — including in zh/ja, where the two variants are the same sentence but
    // the lookup still asks for `_other` and falls back to English without it.
    // Strings where one form is correct English because the number is not
    // being counted grammatically — it labels ("Signature 3", "12 TOTAL") or
    // bounds ("from 1 to 12"). "character(s)" used to be exempt here too, but
    // that spelling is a workaround for the plural system this file otherwise
    // uses correctly, so those strings now carry real variants instead.
    const singleFormIsCorrect = new Set([
      "signatures.defaultName",
      "thumbs.total",
      "goto.invalid",
    ]);
    const offenders: string[] = [];
    for (const lang of LOCALES) {
      const locale = loadLocale(lang);
      const keys = flatten(locale);
      const read = (key: string): string =>
        key
          .split(".")
          .reduce<unknown>(
            (node, part) => (node as Record<string, unknown>)?.[part],
            locale,
          ) as string;
      for (const key of keys) {
        const value = read(key);
        if (typeof value !== "string" || !value.includes("{{count}}")) continue;
        if (/_(one|other|zero|two|few|many)$/.test(key)) continue;
        if (singleFormIsCorrect.has(key)) continue;
        offenders.push(`${lang}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("zh and ja carry exactly the keys en does", () => {
    const expected = [...enKeys].toSorted();
    for (const lang of LOCALES.filter((l) => l !== "en")) {
      const keys = flatten(loadLocale(lang)).toSorted();
      // Plural forms legitimately differ (zh/ja have no _one), so compare the
      // base keys with plural suffixes stripped.
      const base = (list: string[]) =>
        [...new Set(list.map((k) => k.replace(/_(one|other)$/, "")))].toSorted();
      expect(base(keys)).toEqual(base(expected));
    }
  });
});
