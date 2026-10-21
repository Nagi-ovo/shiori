/**
 * How the reading layer names one of a document's fonts: its BaseFont as
 * PDFium reports it and, for a font the file embeds, its program's id after
 * a "#" ("Calibri#9f3a…", shiori-core's `program_id`). Two papers merged
 * into one file often embed two subsets of one font that PDFium names
 * alike, and a face built from one lacks the other's glyphs (audit B108).
 *
 * The key stands in for the name wherever a run's font goes: text runs,
 * a contentText edit's `sourceFontName` (saved in drafts; the id is the
 * program's, so it holds across sessions and merges) and the store's font
 * maps. It must still read as the name: what classifies a font by its name
 * (bold, italic, serif, mono) matches letters past "f" or a "-" or "_"
 * before a style, which "#" and hex digits never supply; a reader anchored
 * at the name's end takes the key off with `fontKeyName`.
 */
export function fontKey(name: string, id: string | undefined): string {
  return id ? `${name}#${id}` : name;
}

/** The name in a font key: the key without its program id. */
export function fontKeyName(key: string): string {
  return key.replace(/#[0-9a-f]+$/u, "");
}
