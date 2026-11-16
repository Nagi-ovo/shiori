/** Membership for validated hex byte strings. Office may declare a complete
 * wider codespace while spelling simple-font mapping sources as one byte. */
export function codeInCodespace(key: string, low: string, high: string): boolean {
  if (low.length !== high.length) return false;
  const lo = parseInt(low, 16), hi = parseInt(high, 16);
  if (key.length === low.length) {
    const code = parseInt(key, 16);
    return code >= lo && code <= hi;
  }
  const width = low.length / 2;
  return key.length < low.length && width >= 2 && width <= 4 &&
    lo === 0 && hi === 2 ** (8 * width) - 1;
}
