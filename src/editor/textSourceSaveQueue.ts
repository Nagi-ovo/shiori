export type SequencedPendingWrite = {
  seq: number;
};

type DrainPendingWritesOptions<T extends SequencedPendingWrite> = {
  pending: Map<string, T>;
  clearTimer: (id: string) => void;
  persist: (id: string, write: T) => Promise<void>;
  id?: string;
};

/**
 * Persists the newest write for each selected document, including writes that
 * arrive while an older IndexedDB operation is still in flight.
 *
 * JavaScript runs the final empty check and the caller's continuation in the
 * same microtask, so a close/home action cannot miss another UI event between
 * this function returning and removing the tab.
 */
export async function drainPendingWrites<T extends SequencedPendingWrite>({
  pending,
  clearTimer,
  persist,
  id,
}: DrainPendingWritesOptions<T>): Promise<void> {
  while (true) {
    const entries = Array.from(pending.entries()).filter(
      ([entryId]) => id === undefined || entryId === id,
    );
    if (entries.length === 0) return;

    for (const [entryId] of entries) clearTimer(entryId);
    await Promise.all(
      entries.map(([entryId, write]) => persist(entryId, write)),
    );

    for (const [entryId, write] of entries) {
      if (pending.get(entryId)?.seq === write.seq) pending.delete(entryId);
    }
  }
}
