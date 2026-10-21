import { db, notifyChanged } from "./draftsDb";
import { draftSource, webHandleDraftPrefix } from "./draftIdentity";
import { isDraftOpen } from "./draftProtection";
import { moveOperationLog, readOperationLog } from "./operationLog";

export type DraftClaimDeps = {
  /**
   * Whether a web file handle id is still remembered. The handle store keeps
   * only the most recent ones, and picking a file again after its handle was
   * dropped mints a new id, so a draft under a forgotten id is unreachable
   * through its own source.
   */
  webFileHandleExists?: (id: string) => Promise<boolean>;
};

/**
 * Runs before a tab of a durable source reads `draftId` (see
 * draftIdentity.ts). When that draft does not exist yet, it takes over a
 * draft of the same bytes that no source can reach any more: a hash-only
 * draft (written by an older build, or by a dropped or cached copy of the
 * file) that no open tab in any window still holds, or one under a forgotten
 * web file handle. The rows move in one transaction with their revision and
 * timestamps, then the crash-recovery log follows. The first source to open
 * the bytes wins; the next one at another path starts clean.
 *
 * Returns the id to read. That is `draftId`, except when the move failed
 * (say, quota while copying the PDF bytes): then the unclaimed draft is read
 * as before, and the tab's next save writes its own.
 */
export async function claimDraft(
  hash: string,
  draftId: string,
  deps: DraftClaimDeps = {},
): Promise<string> {
  if (draftId === hash) return draftId;
  let from: string | null = null;
  try {
    if (await hasDraft(draftId)) return draftId;
    from = await claimableDraftId(hash, deps);
    if (!from) return draftId;
    if (await moveDraftRows(from, draftId)) notifyChanged();
    moveOperationLog(from, draftId);
    return draftId;
  } catch (error) {
    console.warn("Could not move a draft to its source; reading it in place", error);
    return from ?? draftId;
  }
}

async function hasDraft(id: string): Promise<boolean> {
  const [model, legacy] = await Promise.all([
    db.draftModels.get(id),
    db.drafts.get(id),
  ]);
  return Boolean(model ?? legacy);
}

async function claimableDraftId(
  hash: string,
  deps: DraftClaimDeps,
): Promise<string | null> {
  if (!isDraftOpen(hash) && ((await hasDraft(hash)) || readOperationLog(hash))) {
    return hash;
  }
  const exists = deps.webFileHandleExists;
  if (!exists) return null;
  const rows = await db.draftModels
    .where("id")
    .startsWith(webHandleDraftPrefix(hash))
    .toArray();
  rows.sort((a, b) => b.lastTouched - a.lastTouched);
  for (const row of rows) {
    const source = draftSource(row.id);
    if (source?.type !== "webFileHandle" || isDraftOpen(row.id)) continue;
    if (!(await exists(source.id))) return row.id;
  }
  return null;
}

/** False when there was nothing to move or another window got there first. */
async function moveDraftRows(from: string, to: string): Promise<boolean> {
  return db.transaction("rw", db.drafts, db.pdfBlobs, db.draftModels, async () => {
    const [model, blob, legacy, taken, takenLegacy] = await Promise.all([
      db.draftModels.get(from),
      db.pdfBlobs.get(from),
      db.drafts.get(from),
      db.draftModels.get(to),
      db.drafts.get(to),
    ]);
    if (taken || takenLegacy || (!model && !legacy)) return false;
    if (model) await db.draftModels.put({ ...model, id: to });
    if (blob) await db.pdfBlobs.put({ ...blob, id: to });
    if (legacy) await db.drafts.put({ ...legacy, id: to });
    await Promise.all([
      db.draftModels.delete(from),
      db.pdfBlobs.delete(from),
      db.drafts.delete(from),
    ]);
    return true;
  });
}
