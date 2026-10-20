/**
 * Markdown and HTML bytes as the editor sees them, and back.
 *
 * Shiori edits and saves text as UTF-8. A file in another encoding (GBK,
 * Shift_JIS, Latin-1, UTF-16) still opens, read through a lossy UTF-8 decode
 * so the reader sees something, but that text is not the file: every byte the
 * decoder could not read became U+FFFD. Saving it would replace the original
 * with those replacement characters for good, so such a document is marked
 * `lossy` and never written back.
 */
export type DecodedTextDocument = {
  text: string;
  /** The bytes were not valid UTF-8; `text` is not a faithful reading. */
  lossy: boolean;
};

export function decodeTextDocument(bytes: Uint8Array): DecodedTextDocument {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      lossy: false,
    };
  } catch {
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      lossy: true,
    };
  }
}
