import { db, notifyChanged } from "./draftsDb";
import { draftSource, webHandleDraftPrefix } from "./draftIdentity";
import { isDraftOpen } from "./draftProtection";
import {
  clearOperationLog,
  operationLogIds,
  readOperationLog,
  writeOperationLog,
} from "./operationLog";

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
 * draftIdentity.ts). When neither that draft nor its crash log exists yet, it
 * takes over a draft of the same bytes that no source can reach any more: a
 * hash-only draft (written by an older build, or by a dropped or cached copy
 * of the file) that no open tab in any window still holds, or one under a
 * forgotten web file handle. The rows move in one transaction with their
 * revision and timestamps, and the crash-recovery log goes with them. The
 * first source to open the bytes wins; the next one at another path starts
 * clean.
 *
 * Returns the id to read. That is `draftId`, except when the move failed
 * (say, quota while copying the PDF bytes or the log): then the unclaimed
 * draft and its log are read as before, and the tab's next save writes its
 * own.
 */
export async function claimDraft(
  hash: string,
  draftId: string,
  deps: DraftClaimDeps = {},
): Promise<string> {
  if (draftId === hash) return draftId;
  let from: string | null = null;
  try {
    // A crash log alone is this source's recovery too (written before the
    // first autosave); adopting another draft would race it by timestamp.
    if ((await hasDraft(draftId)) || readOperationLog(draftId)) return draftId;
    from = await claimableDraftId(hash, deps);
    if (!from) return draftId;
    // The log goes first, as a copy: it is the step that can fail on quota
    // and still be undone. If it cannot land, nothing moves, so the rows and
    // the newest edits stay under one id.
    const log = readOperationLog(from);
    if (log && writeOperationLog(draftId, log.model, log.lastTouched) !== "written") {
      return from;
    }
    try {
      if (await moveDraftRows(from, draftId)) notifyChanged();
    } catch (error) {
      if (log) clearOperationLog(draftId);
      throw error;
    }
    if (log) clearOperationLog(from);
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
  // A crash before the first autosave leaves a log and no row.
  const prefix = webHandleDraftPrefix(hash);
  const newest = new Map<string, number>();
  const seen = (id: string, at: number) =>
    newest.set(id, Math.max(at, newest.get(id) ?? 0));
  for (const row of await db.draftModels.where("id").startsWith(prefix).toArray()) {
    seen(row.id, row.lastTouched);
  }
  for (const id of operationLogIds(prefix)) {
    seen(id, readOperationLog(id)?.lastTouched ?? 0);
  }
  const ids = [...newest.keys()].sort((a, b) => newest.get(b)! - newest.get(a)!);
  for (const id of ids) {
    const source = draftSource(id);
    if (source?.type !== "webFileHandle" || isDraftOpen(id)) continue;
    if (!(await exists(source.id))) return id;
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
