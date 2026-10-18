import { useEffect, useState } from "react";
import { getRuntimeGuardStatus } from "../../platform";

/**
 * Whether the native runtime says this build has expired. Document intake can
 * also learn it from a refused command, hence the setter.
 */
export function useNativeExpiry() {
  const [nativeExpired, setNativeExpired] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getRuntimeGuardStatus()
      .then((status) => {
        if (!cancelled && status?.expired) setNativeExpired(true);
      })
      .catch(() => {
        // Web builds and legacy desktop builds still fall back to the
        // frontend expiry check. Native commands enforce this separately.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return [nativeExpired, setNativeExpired] as const;
}
