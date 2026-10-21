// The error every CLI command fails with: a stable code, a message, an optional detail.
import type { diagnosticCode } from "../../src/pdf/openPolicy";
import type { LiveAppErrorCode } from "./liveApp";

export type CliErrorCode =
  | "ERR_USAGE"
  | "ERR_UNSUPPORTED_DOCUMENT"
  | "ERR_FILE_UNAVAILABLE"
  | "ERR_FILE_TOO_LARGE"
  | "ERR_SPEC_INVALID"
  | "ERR_ANCHOR_UNRESOLVED"
  | "ERR_TEXT_UNAVAILABLE"
  | "ERR_ANNOTATIONS_UNAVAILABLE"
  | "ERR_OUTPUT_EXISTS"
  | "ERR_OUTPUT_CONFLICT"
  | "ERR_OUTPUT_OUTCOME_UNKNOWN"
  | "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED"
  | "ERR_WRITE_FAILED"
  | LiveAppErrorCode
  | ReturnType<typeof diagnosticCode>;

export class CliError extends Error {
  code: CliErrorCode;
  detail?: string;

  constructor(code: CliErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.detail = detail;
  }
}
