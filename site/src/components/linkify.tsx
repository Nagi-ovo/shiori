import type { ReactNode } from "react";
import { DiscordGlyph } from "./DiscordGlyph";

// Shared by the legal pages (Privacy Policy, Support). Turns any http(s)
// URL or bare email address inside a body string into a real anchor, so
// the dictionaries stay plain readable text and translations don't carry
// JSX. URLs open in a new tab; emails become mailto: links. For known
// social hosts (currently just Discord) the URL is replaced with the
// brand glyph — the surrounding sentence already names "Discord", so the
// raw invite URL would just be noise. Other URLs render as their href.
const TOKEN_RE =
  /(https?:\/\/[^\s<>"')\]}）】」』》、，。！？；：]+)|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;

export function linkify(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(text.slice(cursor, start));
    const raw = match[0];
    const isUrl = Boolean(match[1]);
    const value = raw.replace(TRAILING_PUNCTUATION_RE, "");
    const trailing = raw.slice(value.length);

    if (isUrl) {
      const host = safeHost(value) ?? "";
      const isDiscord = /(^|\.)discord\.(gg|com)$/i.test(host);
      parts.push(
        <a
          key={key++}
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className={isDiscord ? "privacy-discord-link" : undefined}
          aria-label={isDiscord ? "Shiori Discord" : undefined}
        >
          {isDiscord ? <DiscordGlyph /> : value}
        </a>,
      );
    } else {
      parts.push(
        <a key={key++} href={`mailto:${value}`}>
          {value}
        </a>,
      );
    }
    if (trailing) parts.push(trailing);
    cursor = start + raw.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
