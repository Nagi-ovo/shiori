import type { DocumentKind } from "./types";

type TextDocumentKind = Extract<DocumentKind, "markdown" | "html">;
type FrontMatterDelimiter = "---" | "+++";
export type MarkdownMetadataEntry = {
  key: string;
  value: string;
};

const MAX_METADATA_ENTRIES = 32;
const MAX_METADATA_VALUE_LENGTH = 600;

const MARKDOWN_FORBID_TAGS = [
  "base",
  "button",
  "embed",
  "form",
  "iframe",
  "input",
  "link",
  "meta",
  "object",
  "script",
  "select",
  "style",
  "textarea",
];

const HTML_FORBID_TAGS = [
  "base",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "object",
  "script",
];

const MARKDOWN_FORBID_ATTR = ["srcset", "style"];
const HTML_FORBID_ATTR = ["srcdoc", "srcset"];
const HTML_ADD_TAGS = ["link", "meta"];
const HTML_ADD_ATTR = ["charset", "content", "href", "media", "name", "rel"];
const MARKDOWN_FORBID_TAG_SET = new Set(MARKDOWN_FORBID_TAGS);
const MARKDOWN_FORBID_ATTR_SET = new Set(MARKDOWN_FORBID_ATTR);
const HTML_FORBID_TAG_SET = new Set(HTML_FORBID_TAGS);
const HTML_FORBID_ATTR_SET = new Set(HTML_FORBID_ATTR);
const URL_ATTRS = new Set(["href", "poster", "src", "xlink:href"]);
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const SAFE_MEDIA_PROTOCOLS = new Set(["http:", "https:", "blob:"]);

export async function renderSafeHtml(
  kind: TextDocumentKind,
  text: string,
): Promise<string> {
  const [{ default: DOMPurify }, markedModule] = await Promise.all([
    import("dompurify"),
    kind === "markdown" ? import("marked") : Promise.resolve(null),
  ]);
  if (kind === "html") {
    const sanitized = DOMPurify.sanitize(String(text), {
      ADD_ATTR: HTML_ADD_ATTR,
      ADD_TAGS: HTML_ADD_TAGS,
      ALLOW_DATA_ATTR: false,
      WHOLE_DOCUMENT: true,
    });
    return sanitizeHtmlDocument(String(sanitized));
  }

  const markdown = kind === "markdown" ? extractMarkdownFrontMatter(text) : null;
  const unsafe = markdownWithSourceLines(
    markedModule!.marked,
    markdown!.body,
    lineCount(text) - lineCount(markdown!.body),
  );
  const sanitized = DOMPurify.sanitize(unsafe, {
    ADD_ATTR: [SOURCE_LINE_ATTR],
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: MARKDOWN_FORBID_ATTR,
    FORBID_TAGS: MARKDOWN_FORBID_TAGS,
  });
  const metadataHtml = markdown
    ? renderMetadataHtml(markdown.metadata)
    : "";
  return enforceReadableHtml(`${metadataHtml}${sanitized}`);
}

/**
 * Each top-level block's first line in the source, 1-based: what lets the
 * preview and the live editor hand a reading position to each other by line
 * instead of by pixels (src/documents/markdownScrollAnchor.ts).
 */
export const SOURCE_LINE_ATTR = "data-source-line";

// Token types that render as one element opening with a tag. Raw HTML,
// link definitions and blank space are left unmarked.
const SOURCE_LINE_BLOCKS = new Set([
  "blockquote",
  "code",
  "heading",
  "hr",
  "list",
  "paragraph",
  "table",
]);

function lineCount(text: string): number {
  let count = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count += 1;
  return count;
}

type MarkedApi = typeof import("marked").marked;

/**
 * GFM to HTML, with `data-source-line` on each top-level block. The lexer's
 * tokens carry their raw source, so their line numbers are a running sum;
 * each token renders on its own (sharing the document's link definitions),
 * the same output `marked.parse` gives.
 */
function markdownWithSourceLines(
  marked: MarkedApi,
  body: string,
  firstLineOffset: number,
): string {
  const options = { async: false as const, breaks: false, gfm: true };
  const tokens = marked.lexer(body, options);
  let line = 1 + firstLineOffset;
  let html = "";
  for (const token of tokens) {
    const part = marked.parser(Object.assign([token], { links: tokens.links }), options);
    html += SOURCE_LINE_BLOCKS.has(token.type)
      ? part.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1 ${SOURCE_LINE_ATTR}="${line}"`)
      : part;
    line += lineCount(token.raw) - 1;
  }
  return html;
}

export function extractMarkdownFrontMatter(text: string): {
  body: string;
  metadata: MarkdownMetadataEntry[];
} {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const start = /^(---|\+\+\+)[ \t]*\n/.exec(normalized);
  if (!start) return { body: text, metadata: [] };

  const delimiter = start[1] as FrontMatterDelimiter;
  const lines = normalized.slice(start[0].length).split("\n");
  const rawLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    const closed =
      delimiter === "---"
        ? trimmed === "---" || trimmed === "..."
        : trimmed === "+++";
    if (closed) {
      const metadata = parseFrontMatter(rawLines.join("\n"), delimiter);
      // Content with no metadata in it is a section between horizontal
      // rules, not front matter; the live editor shows it as source too.
      if (metadata.length === 0 && rawLines.some((raw) => raw.trim())) {
        return { body: text, metadata: [] };
      }
      return { body: lines.slice(index + 1).join("\n"), metadata };
    }
    rawLines.push(line);
  }

  return { body: text, metadata: [] };
}

function parseFrontMatter(
  raw: string,
  delimiter: FrontMatterDelimiter,
): MarkdownMetadataEntry[] {
  const jsonEntries = parseJsonMetadata(raw);
  if (jsonEntries) return jsonEntries;
  return delimiter === "+++" ? parseTomlMetadata(raw) : parseYamlMetadata(raw);
}

function parseYamlMetadata(raw: string): MarkdownMetadataEntry[] {
  const entries: MarkdownMetadataEntry[] = [];
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || startsIndented(line)) continue;

    const match = /^([^:#][^:]*?)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = cleanMetadataKey(match[1]!);
    if (!key) continue;

    let value = match[2]!.trim();
    if (isYamlCollectionOrBlock(value)) {
      const collection: string[] = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const next = lines[cursor]!;
        const nextTrimmed = next.trim();
        if (!nextTrimmed || nextTrimmed.startsWith("#")) continue;
        if (!startsIndented(next) && /^([^:#][^:]*?)\s*:/.test(next)) break;
        collection.push(cleanYamlCollectionLine(nextTrimmed));
      }
      value = collection.join(value.startsWith(">") ? " " : ", ");
      index = cursor - 1;
    } else {
      value = cleanYamlValue(value);
    }

    pushMetadataEntry(entries, key, value);
  }

  return entries;
}

function parseTomlMetadata(raw: string): MarkdownMetadataEntry[] {
  const entries: MarkdownMetadataEntry[] = [];
  let section = "";

  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      section = cleanMetadataKey(sectionMatch[1]!);
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    const key = cleanMetadataKey(
      section ? `${section}.${match[1]!}` : match[1]!,
    );
    pushMetadataEntry(entries, key, cleanYamlValue(match[2]!));
  }

  return entries;
}

function parseJsonMetadata(raw: string): MarkdownMetadataEntry[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const entries: MarkdownMetadataEntry[] = [];
    flattenJsonMetadata(entries, "", parsed);
    return entries;
  } catch {
    return null;
  }
}

function flattenJsonMetadata(
  entries: MarkdownMetadataEntry[],
  prefix: string,
  value: unknown,
): void {
  if (entries.length >= MAX_METADATA_ENTRIES) return;
  if (!prefix && (!value || typeof value !== "object" || Array.isArray(value))) {
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const nextKey = prefix ? `${prefix}.${key}` : key;
      if (isPlainMetadataValue(nested)) {
        pushMetadataEntry(entries, nextKey, formatMetadataValue(nested));
      } else if (Array.isArray(nested)) {
        pushMetadataEntry(
          entries,
          nextKey,
          nested.map(formatMetadataValue).join(", "),
        );
      } else {
        flattenJsonMetadata(entries, nextKey, nested);
      }
    }
  }
}

export function renderMetadataHtml(entries: MarkdownMetadataEntry[]): string {
  const visible = entries
    .map((entry) => ({
      key: cleanMetadataKey(entry.key),
      value: truncateMetadataValue(entry.value),
    }))
    .filter((entry) => entry.key && entry.value);
  if (visible.length === 0) return "";

  return `<section class="shioriDocumentMetadata"><dl>${visible
    .map(
      (entry) =>
        `<dt>${escapeHtml(entry.key)}</dt><dd>${escapeHtml(entry.value).replace(/\n/g, "<br>")}</dd>`,
    )
    .join("")}</dl></section>`;
}

function isYamlCollectionOrBlock(value: string): boolean {
  return (
    value === "" ||
    value === "|" ||
    value === ">" ||
    value === "|-" ||
    value === ">-" ||
    value === "|+" ||
    value === ">+"
  );
}

function cleanYamlCollectionLine(line: string): string {
  if (line.startsWith("- ")) return cleanYamlValue(line.slice(2));
  const pair = /^([^:#][^:]*?)\s*:\s*(.*)$/.exec(line);
  if (pair) {
    return `${cleanMetadataKey(pair[1]!)}: ${cleanYamlValue(pair[2]!)}`;
  }
  return cleanYamlValue(line);
}

function cleanYamlValue(value: string): string {
  const withoutComment = stripYamlComment(value).trim();
  if (!withoutComment || withoutComment === "~" || withoutComment === "null") {
    return "";
  }
  if (withoutComment.startsWith("[") && withoutComment.endsWith("]")) {
    return splitInlineList(withoutComment.slice(1, -1))
      .map(cleanYamlScalar)
      .filter(Boolean)
      .join(", ");
  }
  return cleanYamlScalar(withoutComment);
}

function cleanYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return String(JSON.parse(trimmed));
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function splitInlineList(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      current += char;
      if (char === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function stripYamlComment(value: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(value[index - 1]!))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function startsIndented(line: string): boolean {
  return /^[ \t]/.test(line);
}

function cleanMetadataKey(key: string): string {
  return key
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function pushMetadataEntry(
  entries: MarkdownMetadataEntry[],
  key: string,
  value: string,
): void {
  if (entries.length >= MAX_METADATA_ENTRIES) return;
  const cleanKey = cleanMetadataKey(key);
  const cleanValue = truncateMetadataValue(value);
  if (!cleanKey || !cleanValue) return;
  entries.push({ key: cleanKey, value: cleanValue });
}

function truncateMetadataValue(value: string): string {
  const compact = value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return compact.length > MAX_METADATA_VALUE_LENGTH
    ? `${compact.slice(0, MAX_METADATA_VALUE_LENGTH - 1)}…`
    : compact;
}

function isPlainMetadataValue(value: unknown): boolean {
  return (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function formatMetadataValue(value: unknown): string {
  if (value == null) return "";
  if (isPlainMetadataValue(value)) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeHtmlDocument(html: string): string {
  const parsed = new window.DOMParser().parseFromString(html, "text/html");
  enforceHtmlDocumentTree(parsed);

  for (const node of Array.from(parsed.body.childNodes)) {
    if (isElementNode(node) && isHeadElement(node)) {
      parsed.head.append(node);
    }
  }

  const charset = parsed.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const colorScheme = parsed.createElement("meta");
  colorScheme.setAttribute("name", "color-scheme");
  colorScheme.setAttribute("content", "light dark");
  parsed.head.prepend(colorScheme);
  parsed.head.prepend(charset);

  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

function enforceReadableHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;

  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    const tagName = element.tagName.toLowerCase();
    if (MARKDOWN_FORBID_TAG_SET.has(tagName)) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const attrName = attribute.name.toLowerCase();
      if (
        attrName.startsWith("on") ||
        MARKDOWN_FORBID_ATTR_SET.has(attrName) ||
        (URL_ATTRS.has(attrName) && !isSafeUrl(attribute.value, attrName))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return template.innerHTML;
}

function enforceHtmlDocumentTree(root: ParentNode): void {
  for (const element of Array.from(root.querySelectorAll("*"))) {
    const tagName = element.tagName.toLowerCase();
    if (
      HTML_FORBID_TAG_SET.has(tagName) ||
      (tagName === "meta" && !isAllowedMetaElement(element)) ||
      (tagName === "link" && !isAllowedLinkElement(element))
    ) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const attrName = attribute.name.toLowerCase();
      if (
        attrName.startsWith("on") ||
        HTML_FORBID_ATTR_SET.has(attrName) ||
        (URL_ATTRS.has(attrName) && !isSafeUrl(attribute.value, attrName))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function isHeadElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  return (
    tagName === "link" ||
    tagName === "meta" ||
    tagName === "style" ||
    tagName === "title"
  );
}

function isAllowedLinkElement(element: Element): boolean {
  const rel = element.getAttribute("rel")?.toLowerCase().split(/\s+/) ?? [];
  return rel.includes("stylesheet") && Boolean(element.getAttribute("href"));
}

function isAllowedMetaElement(element: Element): boolean {
  if (element.hasAttribute("charset")) return true;
  const name = element.getAttribute("name")?.toLowerCase();
  return (
    name === "color-scheme" ||
    name === "description" ||
    name === "viewport"
  );
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === 1;
}

function isSafeUrl(value: string, attrName: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) return true;
  if (hasControlCharacters(trimmed)) return false;

  try {
    const url = new URL(trimmed, window.location.href);
    if (SAFE_LINK_PROTOCOLS.has(url.protocol)) return true;
    if (attrName !== "href" && SAFE_MEDIA_PROTOCOLS.has(url.protocol)) return true;
    if (attrName !== "href" && url.protocol === "data:") {
      return /^data:image\/(?:png|gif|jpe?g|webp|avif);/i.test(trimmed);
    }
    return (
      url.origin === window.location.origin &&
      url.protocol === window.location.protocol
    );
  } catch {
    return false;
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
