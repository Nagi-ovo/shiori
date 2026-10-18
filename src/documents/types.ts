export type DocumentKind = "pdf" | "markdown" | "html" | "docx";

export const PDF_INPUT_ACCEPT = "application/pdf,.pdf";
export const NON_PDF_INPUT_ACCEPT = [
  "text/markdown",
  ".md",
  ".markdown",
  "text/html",
  ".html",
  ".htm",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docx",
].join(",");
export const DOCUMENT_INPUT_ACCEPT = `${PDF_INPUT_ACCEPT},${NON_PDF_INPUT_ACCEPT}`;

export const DOCUMENT_PICKER_ACCEPT: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "application/pdf": Object.freeze([".pdf"]),
    "text/markdown": Object.freeze([".md", ".markdown"]),
    "text/html": Object.freeze([".html", ".htm"]),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      Object.freeze([".docx"]),
  });

/**
 * Kinds whose payload is text the editor owns as a string. `pdf` and `docx`
 * are binary: their viewers read `bytes` and there is no working copy to edit.
 */
export type TextDocumentKind = Extract<DocumentKind, "markdown" | "html">;

export function isTextDocumentKind(kind: DocumentKind): kind is TextDocumentKind {
  return kind === "markdown" || kind === "html";
}

export type DocumentSource =
  | { type: "path"; path: string }
  | { type: "webFileHandle"; id: string }
  | { type: "cache"; id: string }
  | { type: "ephemeral" };

export type LoadedDocumentPayload = {
  kind: DocumentKind;
  name: string;
  size: number;
  bytes: Uint8Array;
  path?: string;
  webFileHandleId?: string;
  cacheId?: string;
};

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);

export function extensionForName(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot < 0 || dot === trimmed.length - 1) return "";
  return trimmed.slice(dot + 1).toLowerCase();
}

export function detectDocumentKind(name: string): DocumentKind | null {
  const ext = extensionForName(name);
  if (ext === "pdf") return "pdf";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (HTML_EXTENSIONS.has(ext)) return "html";
  if (ext === "docx") return "docx";
  // `.doc` is deliberately absent: it is the OLE compound format, not OOXML,
  // and the renderer's entry point is a zip reader. Detecting it here would
  // open a tab that can only fail.
  return null;
}

export function isSupportedDocumentName(name: string): boolean {
  return detectDocumentKind(name) !== null;
}

export function documentKindShortLabel(kind: DocumentKind): string {
  if (kind === "markdown") return "MD";
  if (kind === "html") return "HTML";
  if (kind === "docx") return "DOCX";
  return "PDF";
}

export function sourceForPayload(
  payload: Pick<LoadedDocumentPayload, "path" | "webFileHandleId" | "cacheId">,
): DocumentSource {
  if (payload.path) return { type: "path", path: payload.path };
  if (payload.webFileHandleId) {
    return { type: "webFileHandle", id: payload.webFileHandleId };
  }
  if (payload.cacheId) return { type: "cache", id: payload.cacheId };
  return { type: "ephemeral" };
}

export function sourceKey(source: DocumentSource): string | null {
  if (source.type === "path") return `path:${source.path}`;
  if (source.type === "webFileHandle") return `web:${source.id}`;
  if (source.type === "cache") return `cache:${source.id}`;
  return null;
}
