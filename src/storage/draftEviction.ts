/*
 * LRU eviction of drafts under the app cap or the browser's quota. The cap is
 * passed in, so drafts.ts keeps its test override.
 */
import { db } from "./draftsDb";
import { recordEvictions } from "./draftEvictionNotices";
import { isDraftProtected } from "./draftProtection";
import { clearOperationLog } from "./operationLog";

// Bytes still held by v1 rows the v2 upgrade deliberately left in place as a
// safety copy. They are real occupied space that the app's own cap never saw,
// so the store could exceed CAP_BYTES by the size of everything migrated and
// hit the browser's quota earlier than the app expected.
export async function legacyDraftBytesById(): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  try {
    for (const row of await db.drafts.toArray()) {
      const bytes = row.pdfBytes as { byteLength?: number } | undefined;
      const size = typeof bytes?.byteLength === "number" ? bytes.byteLength : 0;
      if (size > 0) sizes.set(row.id, size);
    }
  } catch {
    // The legacy table is absent on installs that never ran schema v1.
  }
  return sizes;
}

// Eviction target for the retry after IndexedDB has ALREADY rejected a write
// with QuotaExceededError.
//
// The old target was `0.8 * CAP_BYTES - incomingBytes`, and CAP_BYTES is a
// hardcoded 1 GB. Whenever the origin's real quota was smaller than that —
// a nearly full disk, or WebKit/WKWebView's per-origin ceiling — the store was
// already under the app cap, so enforceQuota returned immediately having freed
// nothing, the retry hit the same wall, and autosave failed permanently with a
// single toast and no way to recover.
//
// Three bounds, whichever is tightest:
//   - the app's own cap, unchanged for the normal case
//   - the browser's reported quota, which is the limit actually being hit
//   - a floor that always frees a fifth of what is stored, so a retry after a
//     real failure can never be a no-op even when both numbers look fine
//     (the browser's estimate is approximate, and other databases on this
//     origin — shiori-workspace — consume the same budget without appearing
//     in these rows)
export async function evictAfterQuotaFailure(
  capBytes: number,
  protectId: string,
  incomingBytes: number,
): Promise<boolean> {
  const rows = await db.draftModels.toArray();
  const stored = rows.reduce((sum, row) => sum + row.storageBytes, 0);

  const byAppCap = Math.floor(capBytes * 0.8) - incomingBytes;

  // Read inline rather than through platform/metrics: that module pulls in the
  // platform layer, which imports this one, and the cycle breaks module init.
  let byBrowserQuota = Number.POSITIVE_INFINITY;
  try {
    const quota = (await navigator?.storage?.estimate?.())?.quota;
    if (typeof quota === "number" && quota > 0) {
      byBrowserQuota = Math.floor(quota * 0.8) - incomingBytes;
    }
  } catch {
    // No estimate available (older engines, private mode): the progress floor
    // below still guarantees the retry makes room.
  }

  const byProgress = Math.floor(stored * 0.8);
  const target = Math.max(
    0,
    Math.min(byAppCap, byBrowserQuota, byProgress),
  );
  return enforceQuota(capBytes, protectId, target);
}

// Evict oldest drafts until total bytes <= targetBytes (the cap by default),
// never the one being written (`protectId`) nor one an open tab holds.
export async function enforceQuota(
  capBytes: number,
  protectId?: string,
  targetBytes: number = capBytes,
): Promise<boolean> {
  const rows = await db.draftModels.orderBy("lastTouched").toArray();
  // Legacy v1 rows are counted here for the same reason totalBytes counts
  // them: they occupy the origin's quota even though only the v2 tables
  // describe the drafts. Eviction deletes both, so both come off the total.
  const legacyBytesById = await legacyDraftBytesById();
  let total =
    rows.reduce((sum, r) => sum + r.storageBytes, 0) +
    [...legacyBytesById.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (total <= targetBytes) return false;
  const evictedNames: string[] = [];
  for (const r of rows) {
    if (total <= targetBytes) break;
    if (r.id === protectId || isDraftProtected(r.id)) continue;
    // Delete the legacy v1 row too: the v2 upgrade keeps it as a safety copy
    // and get() falls back to it, so dropping only the v2 tables would let an
    // evicted draft be resurrected (and make the eviction notice a lie).
    await db.transaction("rw", db.drafts, db.pdfBlobs, db.draftModels, async () => {
      await Promise.all([
        db.drafts.delete(r.id),
        db.pdfBlobs.delete(r.id),
        db.draftModels.delete(r.id),
      ]);
    });
    clearOperationLog(r.id);
    total -= r.storageBytes + (legacyBytesById.get(r.id) ?? 0);
    evictedNames.push(r.fileName);
  }
  // Surface what was dropped: silently deleting saved work is a trust killer
  // for a local-first tool. The notice waits in localStorage until the user
  // next opens Settings → Storage.
  if (evictedNames.length > 0) recordEvictions(evictedNames, Date.now());
  // Still over when protected drafts alone pass the target: keeping work the
  // reader has open beats silently dropping it.
  return evictedNames.length > 0;
}
