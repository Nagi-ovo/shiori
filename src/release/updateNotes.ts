// What the update notice renders from `notes/<version>.json`.
//
// Since the release after 26.9.26 the file carries the changelog section
// itself under `markdown`, rendered with the in-app changelog's
// MarkdownView — tables and bold leads included. Older files hold only the
// plain-text flattening (group labels, "•" bullets), which is lifted back
// to that renderer's markdown subset; the manifest body falls back the same
// way.

import {
  normalizeLanguage,
  type MarkdownLanguage,
} from "../editor/components/markdownLang";

// Locale chain: requested → en → first available. A Japanese-locale user
// still sees notes when a fast-follow release published only zh/en.
function pickLocalized(record: unknown, lang: MarkdownLanguage): string | null {
  if (!record || typeof record !== "object") return null;
  const values = record as Record<string, unknown>;
  for (const value of [values[lang], values.en, ...Object.values(values)]) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** Markdown for the update notice from a fetched notes file, or null. */
export function notesMarkdownFor(data: unknown, language: string | undefined): string | null {
  if (!data || typeof data !== "object") return null;
  const lang = normalizeLanguage(language);
  const markdown = pickLocalized((data as { markdown?: unknown }).markdown, lang);
  if (markdown) return markdown;
  const plain = pickLocalized(data, lang);
  return plain ? notesToMarkdown(plain) : null;
}

// The plain-text notes — section labels on their own line, "•" bullets
// under them — lifted to the small markdown subset MarkdownView renders
// (### headings, "-" lists). A prose-only fallback (the manifest body) has
// no bullets and passes through as paragraphs.
export function notesToMarkdown(notes: string): string {
  const lines = notes.replace(/\r\n/g, "\n").split("\n");
  const hasBullets = lines.some((line) => /^\s*[•‣◦·-]\s+/.test(line));
  if (!hasBullets) return notes;
  return lines
    .map((line) => {
      const bullet = /^\s*[•‣◦·-]\s+(.*)$/.exec(line);
      if (bullet) return `- ${bullet[1]}`;
      if (line.trim() === "") return "";
      return `### ${line.trim()}`;
    })
    .join("\n");
}
