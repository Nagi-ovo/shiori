import { useTranslation } from "react-i18next";
import { PasswordDialog } from "../../editor/components/PasswordDialog";
import {
  settleSupersededLoad,
  type ColdLoadPorts,
} from "../../workspace/intake/coldLoad";
import { openPdf } from "../../workspace/intake/openPdf";
import type { PendingPassword } from "../../workspace/intake/types";
import { showPlatformOpenError } from "../openErrors";
import { makePasswordPromptRetryable } from "../tabLifecyclePorts";

/** The password dialog for an encrypted PDF, retrying the open it stopped. */
export function PasswordPrompt({
  pendingPassword,
  setPendingPassword,
  intake,
}: {
  pendingPassword: PendingPassword | null;
  setPendingPassword: (next: PendingPassword | null) => void;
  intake: ColdLoadPorts;
}) {
  const { t } = useTranslation();
  if (!pendingPassword) return null;
  return (
    <PasswordDialog
      fileName={pendingPassword.input.name}
      wrongPassword={pendingPassword.wrongPassword}
      onSubmit={(pw) => {
        const pp = pendingPassword;
        setPendingPassword(null);
        void openPdf({ ...pp.input, password: pw }, pp.options, intake)
          .catch((err) => {
            showPlatformOpenError(err, pp.input.name, t, pp.input.path);
          })
          // A load that lost its claim to a newer one leaves a marker behind.
          // Whoever started that load has to clear it, or the NEXT attempt on
          // the same tab is treated as superseded: it reloads for nothing, and
          // on an encrypted document that means a second password prompt for
          // a document the reader already unlocked.
          .finally(() => settleSupersededLoad(pp.options.tabId, intake));
      }}
      onClose={() => {
        const pp = pendingPassword;
        makePasswordPromptRetryable(pp);
        setPendingPassword(null);
      }}
    />
  );
}
