/**
 * A fresh document may finish as a background tab after navigation changes.
 * A restore targets an existing tab, so once that tab loses ownership its
 * async work must stop rather than resurrecting or replacing stale state.
 */
export function documentOpenMayContinue(
  targetTabId: string | undefined,
  mayActivate: boolean,
): boolean {
  return !targetTabId || mayActivate;
}
