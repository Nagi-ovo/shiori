import { useCallback, useEffect, useRef, useState } from "react";
import { appPdfEngine } from "../../pdf/engine/appEngine";
import type { PdfDocument } from "../../pdf/engine/types";
import { restrictedEdits } from "../../pdf/security/permissions";

/**
 * Warns once per document whose permissions refuse an edit, keyed by its
 * hash, as the engine reports the active document's security; an encrypted
 * file every edit is allowed on exports re-encrypted and needs no notice. Returns the hash the warning was raised for, or null, and the
 * edits refused.
 */
export function useEncryptedPdfWarning(
  activeHash: string | null,
  doc: PdfDocument | undefined,
) {
  const restricted = restrictedEdits(doc ? securityForNotice(doc) : null);
  const isRestricted = restricted.length > 0;
  const [encryptedPdfWarningHash, setEncryptedPdfWarningHash] = useState<
    string | null
  >(null);
  const warnedRef = useRef(new Set<string>());

  // The once-per-hash record is a ref, which render cannot read, so this
  // stays an effect.
  useEffect(() => {
    if (!activeHash || !isRestricted) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEncryptedPdfWarningHash(null);
      return;
    }
    if (warnedRef.current.has(activeHash)) return;
    warnedRef.current.add(activeHash);
    setEncryptedPdfWarningHash(activeHash);
  }, [activeHash, isRestricted]);

  const closeEncryptedPdfWarning = useCallback(
    () => setEncryptedPdfWarningHash(null),
    [],
  );
  return {
    encryptedPdfWarningHash,
    closeEncryptedPdfWarning,
    restricted,
  };
}

/** The notice degrades to silence when the engine cannot tell; export refuses instead. */
function securityForNotice(doc: PdfDocument) {
  try {
    return appPdfEngine.security(doc);
  } catch {
    return null;
  }
}
