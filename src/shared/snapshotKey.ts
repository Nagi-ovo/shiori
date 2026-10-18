import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const SNAPSHOT_KEY_PREFIX = "sha256:";
const LEGACY_MODEL_PREFIX = '{"pages":';

/**
 * Builds a compact, deterministic key for a serialized document snapshot.
 * The JSON is transient; only the 71-character digest is persisted.
 */
export function snapshotKeyFromJson(json: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${bytesToHex(sha256(new TextEncoder().encode(json)))}`;
}
/** Migrate only the model JSON shape emitted by the pre-digest implementation. */
export function normalizeLegacySnapshotKey(key: string): string {
  if (key.startsWith(SNAPSHOT_KEY_PREFIX)) return key;
  return key.startsWith(LEGACY_MODEL_PREFIX) ? snapshotKeyFromJson(key) : key;
}
