import { PDFDocument } from "pdf-lib";
import { ExportEncryptedSourceError } from "./encryptedSource";

// Export builds a brand-new document, whose Info dict starts empty — so every
// export used to strip Title/Author/Subject/Keywords and stamp pdf-lib as the
// Producer. A paper annotated in Shiori then showed up untitled and authorless
// in Finder, Zotero, Calibre and Mendeley, usually noticed weeks later.
//
// Producer and ModificationDate are deliberately NOT carried over: pdf-lib
// sets those on save, and they should describe the tool that wrote this file.
// CreationDate is, because it describes the document, not the write.
export function copySourceDocumentInfo(source: PDFDocument, dest: PDFDocument) {
  const title = safeInfoRead(() => source.getTitle());
  if (title) dest.setTitle(title);
  const author = safeInfoRead(() => source.getAuthor());
  if (author) dest.setAuthor(author);
  const subject = safeInfoRead(() => source.getSubject());
  if (subject) dest.setSubject(subject);
  const keywords = safeInfoRead(() => source.getKeywords());
  if (keywords) dest.setKeywords([keywords]);
  const creator = safeInfoRead(() => source.getCreator());
  if (creator) dest.setCreator(creator);
  const creationDate = safeInfoRead(() => source.getCreationDate());
  if (creationDate) dest.setCreationDate(creationDate);
}

// Info entries come from arbitrary files and pdf-lib throws when one holds an
// unexpected type (a date that will not parse, a name where a string belongs).
// Losing one field is not a reason to fail an export.
function safeInfoRead<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Copy a source PDF's document Info onto an already serialized PDF.
 *
 * The compact raster builds its pages outside rebuildPdf(), so when it won on
 * size the saved file came out untitled. This runs on it whatever the
 * attachment policy: Info describes the document, not a hidden payload.
 */
export async function preserveDocumentInfoInPdf(
  sourceBytes: Uint8Array,
  outputBytes: Uint8Array,
): Promise<Uint8Array> {
  const source = await PDFDocument.load(new Uint8Array(sourceBytes), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  // pdf-lib decrypts nothing: an encrypted source's Info strings are
  // ciphertext, and copying them would write garbage as the title.
  if (source.isEncrypted) throw new ExportEncryptedSourceError();
  const output = await PDFDocument.load(new Uint8Array(outputBytes));
  copySourceDocumentInfo(source, output);
  return output.save({ useObjectStreams: true });
}
