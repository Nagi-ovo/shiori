export const LIVE_OPERATION_RECEIPT_MAX = 10_000;
export const LIVE_OPERATION_LEDGER_MAX_BYTES = 10 * 1024 * 1024;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_RE.test(value);
}

export function assertSha256Hex(value: string, label: string): void {
  if (!isSha256Hex(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 hex string`);
  }
}
