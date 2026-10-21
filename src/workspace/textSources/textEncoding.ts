/**
 * Markdown and HTML bytes as the editor sees them, and back.
 *
 * Shiori edits and saves text as UTF-8. A file in another encoding (GBK,
 * Shift_JIS, Latin-1, UTF-16) still opens, read through a lossy UTF-8 decode
 * so the reader sees something, but that text is not the file: every byte the
 * decoder could not read became U+FFFD. Saving it would replace the original
 * with those replacement characters for good, so such a document is marked
 * `lossy` and never written back. So is valid UTF-8 that holds a NUL: no
 * Markdown or HTML does, but BOM-less UTF-16 decodes that way (its ASCII
 * characters' high bytes are NUL), and an edit would splice single UTF-8 bytes
 * into its 2-byte stream.
 *
 * A UTF-8 byte order mark is not part of the text: left in, it would sit in
 * front of the first `#` and stop it parsing as a heading. TextDecoder drops
 * it, the tab remembers it (`bom`), and every encode puts it back, so the
 * working copy and the saved file keep the bytes Windows tools look for.
 */
export type DecodedTextDocument = {
  text: string;
  /** The bytes were not valid UTF-8; `text` is not a faithful reading. */
  lossy: boolean;
  /** The bytes began with a UTF-8 byte order mark, which `text` omits. */
  bom: boolean;
};

const UTF8_BOM = "\uFEFF";

function startsWithUtf8Bom(bytes: Uint8Array): boolean {
  return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

export function decodeTextDocument(bytes: Uint8Array): DecodedTextDocument {
  const bom = startsWithUtf8Bom(bytes);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, lossy: text.includes("\0"), bom };
  } catch {
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      lossy: true,
      bom,
    };
  }
}

/** The text as it goes to disk: with its byte order mark, if it had one. */
export function textDocumentContents(text: string, bom: boolean | undefined): string {
  return bom ? UTF8_BOM + text : text;
}

/** The bytes of `textDocumentContents`, encoded once. */
export function encodeTextDocument(text: string, bom: boolean | undefined): Uint8Array {
  return new TextEncoder().encode(textDocumentContents(text, bom));
}
