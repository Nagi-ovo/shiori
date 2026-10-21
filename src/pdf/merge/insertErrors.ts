export type PdfPageInsertErrorCode =
  | "encryptedIncoming"
  | "baseEncryption"
  | "pagesPermission"
  | "interactive"
  | "navigation"
  | "empty"
  | "invalidPosition"
  | "documentFiles"
  | "baseDocumentFiles"
  | "baseSigned";

/** A page insertion that cannot be completed without silently losing meaning. */
export class PdfPageInsertError extends Error {
  readonly code: PdfPageInsertErrorCode;

  constructor(code: PdfPageInsertErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PdfPageInsertError";
    this.code = code;
  }
}
