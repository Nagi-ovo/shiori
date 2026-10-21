export const LIVE_OPERATION_SCHEMA = "shiori.live.operation/v1" as const;

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

// The operation id is a sha256 over this serialization, computed
// independently by the CLI (before POST) and re-derived by the bridge to
// authenticate the request. Both sides MUST use this single implementation:
// any divergence in key order, number formatting, or undefined handling makes
// the bridge reject every CLI request as SPEC_INVALID.
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 128) {
    throw new CanonicalJsonError("Spec nesting is too deep");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError("Spec contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalJson(entry, depth + 1)}`,
      )
      .join(",")}}`;
  }
  throw new CanonicalJsonError("Spec contains a non-JSON value");
}

/**
 * An optional caller-chosen token that makes an identical spec a new
 * operation: the receipt of the first outlives Undo and a discarded draft, so
 * without one the same spec can never be applied again. Native checks the
 * same rule (src-tauri/src/live_api/wire.rs valid_nonce).
 */
export const LIVE_OPERATION_NONCE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The exact payload whose sha256 is a live operation id. Without a nonce it
 * is byte-identical to the payload before nonces existed, so stored receipts
 * keep matching.
 */
export function liveOperationCanonicalPayload(
  sha256: string,
  pageTopologyHash: string,
  spec: unknown,
  nonce?: string,
): string {
  return canonicalJson({
    schema: LIVE_OPERATION_SCHEMA,
    sha256,
    pageTopologyHash,
    spec,
    nonce,
  });
}
