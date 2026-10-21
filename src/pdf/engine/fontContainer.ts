/** A font program a page draws with, as the file embeds it (shiori-core's EmbeddedFont). */
export type PdfEmbeddedFont = {
  /** BaseFont as the text layer names it. */
  name: string;
  /** The program's id, as the text layer's glyphs carry it (./fontKey.ts). */
  id?: string;
  flags: number;
  format: "truetype" | "opentype" | "cff" | "type1" | "unknown";
  /**
   * Whether the program as it is, through its own cmap and advances, draws
   * this font's text as the PDF does (shiori-core's `own_cmap`). Only then
   * may it load as a face; two dictionaries can share one program and map
   * it apart (audit B108).
   */
  ownCmap: boolean;
  data: Uint8Array;
};

/**
 * Unpacks shiori-core's `encode_embedded_fonts`: a u32 little-endian length,
 * that much JSON listing each font's name, id, flags, format, ownCmap and
 * length, then
 * the programs in order.
 */
export function decodeEmbeddedFonts(bytes: Uint8Array): PdfEmbeddedFont[] {
  if (bytes.byteLength < 4) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength))) as Array<
    Omit<PdfEmbeddedFont, "data"> & { length: number }
  >;
  let offset = 4 + headerLength;
  return header.map(({ length, ...font }) => {
    const data = bytes.slice(offset, offset + length);
    offset += length;
    return { ...font, data };
  });
}
