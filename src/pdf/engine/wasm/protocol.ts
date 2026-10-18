import type { PdfCoreRenderRequest } from "../../../platform/pdfCore";

/** Messages to the core worker (./coreWorker.ts). Every request with an `id` gets one reply. */
export type CoreWorkerRequest =
  | { kind: "open"; id: number; bytes: ArrayBuffer; password?: string }
  | { kind: "close"; doc: number }
  | { kind: "cancel"; tickets: number[] }
  | {
      kind: "render";
      id: number;
      ticket: number;
      doc: number;
      page: number;
      /** 0 visible, 1 backdrop, 2 thumbnail. */
      priority: number;
      request: PdfCoreRenderRequest;
    }
  | {
      kind: "read";
      id: number;
      doc: number;
      op:
        | "pageText"
        | "outline"
        | "links"
        | "hideAnnotations"
        | "decryptedCopy"
        | "geometry"
        | "fonts"
        | "fontOutlines"
        | "security"
        | "encryptLikeSource";
      page?: number;
      keys?: Array<{ subtype: string; rect: [number, number, number, number] }>;
      /** fontOutlines: the BaseFont names to rebuild. */
      names?: string[];
      /** encryptLikeSource: the unencrypted export. */
      bytes?: ArrayBuffer;
    };

export type CoreWorkerReply =
  | { kind: "reply"; id: number; ok: true; value: unknown }
  | { kind: "reply"; id: number; ok: false; error: string };
