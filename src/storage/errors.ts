/** Dexie preserves the original IndexedDB error on `.inner`; walk wrappers. */
export function isQuotaExceededError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    if (typeof current !== "object") return false;
    const name = (current as { name?: unknown }).name;
    if (
      name === "QuotaExceededError" ||
      name === "QUOTA_EXCEEDED_ERR" ||
      name === "NS_ERROR_DOM_QUOTA_REACHED"
    ) {
      return true;
    }
    if (
      typeof DOMException !== "undefined" &&
      current instanceof DOMException &&
      (current.code === 22 || current.code === 1014)
    ) {
      return true;
    }
    current = (current as { inner?: unknown }).inner;
  }
  return false;
}
export function storageErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
