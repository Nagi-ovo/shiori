import type { AtRule, Plugin } from "postcss";

/**
 * Every UI string renders in LXGW WenKai Screen (`--opx-font-sans`), bundled
 * from lxgw-wenkai-screen-web as unicode-range chunks. The face is upright and
 * has one real weight; the package declares each chunk `font-weight: 400;
 * font-style: normal`. Text asking for 600/700 (tab titles, buttons, find
 * matches) would get a synthesized bold that smears the brush strokes, and CJK
 * in an italic display heading (Instrument Serif first, WenKai behind it) a
 * synthesized slant. Declaring the chunks for 400–700 and for slopes from
 * upright to italic sends those requests to the real face, so the browser
 * synthesizes neither. `local()` is dropped so an older WenKai installed on
 * the machine never stands in for the bundled version.
 */
export const UI_FONT_FAMILY = "LXGW WenKai Screen";
export const UI_FONT_WEIGHTS = "400 700";
export const UI_FONT_STYLES = "oblique 0deg 20deg";

const unquote = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, "$2");
// Commas between sources, not the ones inside `format("woff2", …)`.
const SOURCE_SEPARATOR = /,(?![^(]*\))/;

export function uiFontFaces(): Plugin {
  return {
    postcssPlugin: "shiori-ui-font-faces",
    AtRule: {
      "font-face"(rule: AtRule) {
        let family = "";
        rule.walkDecls("font-family", (decl) => {
          family = unquote(decl.value);
        });
        if (family !== UI_FONT_FAMILY) return;
        let weighted = false;
        let styled = false;
        rule.walkDecls((decl) => {
          if (decl.prop === "font-weight") {
            decl.value = UI_FONT_WEIGHTS;
            weighted = true;
          } else if (decl.prop === "font-style") {
            decl.value = UI_FONT_STYLES;
            styled = true;
          } else if (decl.prop === "src") {
            decl.value = decl.value
              .split(SOURCE_SEPARATOR)
              .map((source) => source.trim())
              .filter((source) => !/^local\(/i.test(source))
              .join(", ");
          }
        });
        if (!weighted) rule.append({ prop: "font-weight", value: UI_FONT_WEIGHTS });
        if (!styled) rule.append({ prop: "font-style", value: UI_FONT_STYLES });
      },
    },
  };
}
