import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../../editor/store/store";
import { compareSemver } from "../../runtime/version";

/**
 * The "What's new" modal. It opens on its own only after a genuine upgrade:
 * a version recorded by an earlier session that the running build is newer
 * than. A brand-new install has no recorded version; it used to fall through
 * and greet a first-time user with release notes for a product they had not
 * used yet. Now first run records the current version silently instead, and a
 * later upgrade compares against it. Closing the modal records the version.
 */
export function useChangelog({
  currentVersion,
  dev,
}: {
  currentVersion: string;
  /** Dev builds never open it on their own. */
  dev: boolean;
}) {
  const lastSeen = useAppStore((s) => s.prefs.lastSeenChangelogVersion);
  const setPrefs = useAppStore((s) => s.setPrefs);
  const [showChangelog, setShowChangelog] = useState(
    () => !dev && !!lastSeen && compareSemver(currentVersion, lastSeen) > 0,
  );

  useEffect(() => {
    if (lastSeen === undefined) setPrefs({ lastSeenChangelogVersion: currentVersion });
  }, [currentVersion, lastSeen, setPrefs]);

  const closeChangelog = useCallback(() => {
    setShowChangelog(false);
    setPrefs({ lastSeenChangelogVersion: currentVersion });
  }, [currentVersion, setPrefs]);
  const openChangelog = useCallback(() => setShowChangelog(true), []);

  return { showChangelog, openChangelog, closeChangelog };
}
