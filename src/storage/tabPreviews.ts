import {
  TAB_PREVIEW_AGE_INDEX,
  workspaceDb,
  type StoredTabPreviewRow,
} from "./workspace";

/** Derived tab screenshots stay deliberately small and freely evictable. */
export const TAB_PREVIEW_CACHE_CAP_BYTES = 16 * 1024 * 1024;
export const TAB_PREVIEW_MAX_BYTES = 256 * 1024;
let tabPreviewCacheCapBytes = TAB_PREVIEW_CACHE_CAP_BYTES;

export type TabPreviewSnapshot = Pick<
  StoredTabPreviewRow,
  "tabId" | "imageUrl" | "pageNumber" | "scale"
>;

function encodedSize(imageUrl: string): number {
  // Data URLs are ASCII. Counting characters gives their encoded storage
  // budget without allocating a second byte array just to measure it.
  return imageUrl.length;
}

export async function putTabPreview(
  preview: TabPreviewSnapshot,
): Promise<boolean> {
  const size = encodedSize(preview.imageUrl);
  if (size === 0 || size > TAB_PREVIEW_MAX_BYTES) return false;
  const row: StoredTabPreviewRow = {
    ...preview,
    capturedAt: Date.now(),
    size,
  };
  await workspaceDb.transaction("rw", workspaceDb.tabPreviews, async () => {
    await workspaceDb.tabPreviews.put(row);
    let total = 0;
    const oldest: Array<{ tabId: string; size: number }> = [];
    await workspaceDb.tabPreviews
      .orderBy(TAB_PREVIEW_AGE_INDEX)
      .eachKey((key) => {
        const [, candidateSize, tabId] = key as [number, number, string];
        total += candidateSize;
        oldest.push({ tabId, size: candidateSize });
      });
    const evict: string[] = [];
    for (const candidate of oldest) {
      if (total <= tabPreviewCacheCapBytes) break;
      // Keep the snapshot we just captured when it fits by itself. A very
      // small test cap may evict it too; production's per-item ceiling is far
      // below the global cap.
      total -= candidate.size;
      evict.push(candidate.tabId);
    }
    if (evict.length > 0) await workspaceDb.tabPreviews.bulkDelete(evict);
  });
  return (await workspaceDb.tabPreviews.get(preview.tabId)) !== undefined;
}

export async function readTabPreview(
  tabId: string,
): Promise<StoredTabPreviewRow | null> {
  return (await workspaceDb.tabPreviews.get(tabId)) ?? null;
}

export async function removeTabPreview(tabId: string): Promise<void> {
  await workspaceDb.tabPreviews.delete(tabId);
}

export async function cleanupTabPreviews(
  liveTabIds: ReadonlySet<string>,
): Promise<void> {
  const stale: string[] = [];
  await workspaceDb.tabPreviews.each((row) => {
    if (!liveTabIds.has(row.tabId)) stale.push(row.tabId);
  });
  if (stale.length > 0) await workspaceDb.tabPreviews.bulkDelete(stale);
}

export const __tabPreviewTest = {
  setCapBytes(cap: number | undefined) {
    tabPreviewCacheCapBytes = cap ?? TAB_PREVIEW_CACHE_CAP_BYTES;
  },
};
