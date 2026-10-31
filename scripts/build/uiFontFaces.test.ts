import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { UI_FONT_FAMILY, UI_FONT_WEIGHTS, uiFontFaces } from "./uiFontFaces.ts";

// Every UI string renders in LXGW WenKai Screen, which has one real weight.
// Ways this goes wrong, each covered below:
// - a face stays declared at 400 only, so 600/700 text gets a smeared faux bold;
// - a face keeps `local()`, so an older WenKai installed on the machine stands
//   in for the bundled version;
// - the rewrite reaches other families (JetBrains Mono's real 500, its local
//   sources) and changes how they resolve;
// - a package update renames the family or drops chunks, and the UI quietly
//   falls back to PingFang / Helvetica;
// - a translated string uses a character the face lacks, which falls back to a
//   system font in the middle of a label.

const run = (css: string) => postcss([uiFontFaces()]).process(css, { from: undefined }).css;

const PACKAGE_CSS = new URL(
  "../../node_modules/lxgw-wenkai-screen-web/lxgwwenkaiscreen/result.css",
  import.meta.url,
);

function faces(css: string) {
  const out: Record<string, string>[] = [];
  postcss.parse(css).walkAtRules("font-face", (rule) => {
    const face: Record<string, string> = {};
    rule.walkDecls((decl) => {
      face[decl.prop] = decl.value;
    });
    out.push(face);
  });
  return out;
}

describe("uiFontFaces", () => {
  test("serves 600 and 700 from the real face instead of a synthesized bold", () => {
    const [face] = faces(
      run(`@font-face{font-family:"LXGW WenKai Screen";src:url("./0.woff2") format("woff2");font-weight: 400;}`),
    );
    expect(face!["font-weight"]).toBe(UI_FONT_WEIGHTS);
  });

  test("adds the weight range to a face that declares none", () => {
    const [face] = faces(run(`@font-face{font-family:'LXGW WenKai Screen';src:url("./0.woff2")}`));
    expect(face!["font-weight"]).toBe(UI_FONT_WEIGHTS);
  });

  test("drops local() sources and keeps the bundled file", () => {
    const [face] = faces(
      run(
        `@font-face{font-family:"LXGW WenKai Screen";src:local("LXGW WenKai Screen"),url("./251.woff2") format("woff2");font-weight:400}`,
      ),
    );
    expect(face!.src).toBe(`url("./251.woff2") format("woff2")`);
  });

  test("leaves other families as they are", () => {
    const css = `@font-face{font-family:"JetBrains Mono";src:local("JetBrains Mono"),url("./m.woff2") format("woff2");font-weight:500}`;
    expect(faces(run(css))).toEqual(faces(css));
  });

  test("the bundled package still declares the family the UI stacks name", () => {
    const declared = faces(run(readFileSync(PACKAGE_CSS, "utf8")));
    expect(declared.length).toBeGreaterThan(100);
    for (const face of declared) {
      expect(face["font-family"]).toBe(`"${UI_FONT_FAMILY}"`);
      expect(face["font-weight"]).toBe(UI_FONT_WEIGHTS);
      expect(face.src).not.toContain("local(");
      expect(face.src).toMatch(/^url\("\.\/\d+\.woff2"\) format\("woff2"\)$/);
    }
  });

  test("covers every character the en, zh and ja strings use", () => {
    const ranges = faces(readFileSync(PACKAGE_CSS, "utf8")).flatMap((face) =>
      (face["unicode-range"] ?? "").split(",").map((part) => {
        const [from, to] = part.trim().replace(/^U\+/i, "").split("-");
        return [parseInt(from!, 16), parseInt(to ?? from!, 16)] as const;
      }),
    );
    const missing = new Set<string>();
    const visit = (value: unknown): void => {
      if (typeof value === "string") {
        for (const ch of value) {
          const cp = ch.codePointAt(0)!;
          if (cp > 0x20 && !ranges.some(([from, to]) => cp >= from && cp <= to)) missing.add(ch);
        }
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(visit);
      }
    };
    for (const lang of ["en", "zh", "ja"]) {
      visit(JSON.parse(readFileSync(new URL(`../../src/i18n/locales/${lang}.json`, import.meta.url), "utf8")));
    }
    expect([...missing]).toEqual([]);
  });
});
