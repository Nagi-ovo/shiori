import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { classHighlighter, highlightCode } from "@lezer/highlight";

/**
 * The languages a Markdown code block can name, for both views: the live
 * editor parses fenced code with them (`markdown({ codeLanguages })`) and
 * the preview highlights with the same parsers, so a block reads the same
 * in either. Each language's parser loads the first time a block names it.
 * Tokens come out as `tok-*` classes (Lezer's classHighlighter), styled once
 * in `src/app.css`.
 */
export const codeLanguages = languages;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/**
 * The code as HTML with `tok-*` spans, or null when the info string names
 * no language we know (the caller then shows it as plain text).
 */
export async function highlightCodeToHtml(
  code: string,
  info: string,
): Promise<string | null> {
  const name = info.trim().split(/\s+/)[0] ?? "";
  if (!name) return null;
  const description = LanguageDescription.matchLanguageName(languages, name);
  if (!description) return null;
  const support = description.support ?? (await description.load());
  const tree = support.language.parser.parse(code);
  let html = "";
  highlightCode(
    code,
    tree,
    classHighlighter,
    (text, classes) => {
      html += classes
        ? `<span class="${classes}">${escapeHtml(text)}</span>`
        : escapeHtml(text);
    },
    () => {
      html += "\n";
    },
  );
  return html;
}

/**
 * Highlights one rendered `<pre><code class="language-…">` in place. The
 * preview renders plain first and highlights blocks as they near the
 * viewport (`highlightCodeBlocksNearView`): highlighting a whole long
 * document up front made a 1 MB file with 1,800 blocks take 1.6 s instead
 * of 0.17 s to appear. Leaves the block alone if its text changed while the
 * language loaded, or if the language is unknown.
 */
export async function highlightCodeElement(code: HTMLElement): Promise<boolean> {
  const language = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1];
  if (!language || code.dataset.shioriHighlighted) return false;
  code.dataset.shioriHighlighted = "true";
  const text = code.textContent ?? "";
  const html = await highlightCodeToHtml(text, language);
  // Every character came through escapeHtml; the spans carry only Lezer's
  // fixed tok-* class names.
  if (html === null || !code.isConnected || code.textContent !== text) return false;
  code.innerHTML = html;
  return true;
}
