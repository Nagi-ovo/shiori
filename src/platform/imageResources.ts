import { CAPABILITIES } from "./index";

export type LocalDocumentImageResource = {
  dataUrl: string;
  mime: string;
  size: number;
};

export type LocalDocumentImageResourceErrorCode =
  | "unsupported"
  | "expired"
  | "invalidSource"
  | "pathEscape"
  | "notImage"
  | "tooLarge"
  | "unavailable";

export class LocalDocumentImageResourceError extends Error {
  readonly code: LocalDocumentImageResourceErrorCode;

  constructor(code: LocalDocumentImageResourceErrorCode, message: string) {
    super(message);
    this.name = "LocalDocumentImageResourceError";
    this.code = code;
  }
}

export async function readTextDocumentRelativeImage(
  documentPath: string | null | undefined,
  imageSrc: string,
): Promise<LocalDocumentImageResource | null> {
  if (!documentPath || !CAPABILITIES.textDocumentRelativeImages) return null;
  const { commands, unwrapCommand } = await import("./ipc");
  try {
    return unwrapCommand(
      await commands.readTextDocumentRelativeImage(documentPath, imageSrc),
    );
  } catch (err) {
    throw new LocalDocumentImageResourceError(
      localDocumentImageResourceErrorCode(err),
      String(err instanceof Error ? err.message : err),
    );
  }
}

export const readLocalDocumentImage = readTextDocumentRelativeImage;

function localDocumentImageResourceErrorCode(
  err: unknown,
): LocalDocumentImageResourceErrorCode {
  const message = String(err instanceof Error ? err.message : err);
  if (message === "image-resource-unsupported") return "unsupported";
  if (message === "runtime-expired") return "expired";
  if (
    message === "image-src-empty" ||
    message === "image-src-invalid" ||
    message === "image-src-absolute" ||
    message === "image-src-url" ||
    message === "document-path-not-absolute"
  ) {
    return "invalidSource";
  }
  if (message === "image-path-escape") return "pathEscape";
  if (message === "unsupported-image" || message === "image-not-file") {
    return "notImage";
  }
  if (message === "image-too-large" || message === "too-large") {
    return "tooLarge";
  }
  return "unavailable";
}
