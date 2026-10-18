import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "../../editor/toast";
import { IS_TAURI } from "../../platform";
import {
  checkCanvasCapabilities,
  type CanvasCapabilityReport,
} from "../../platform/canvasCapabilities";

const CANVAS_WARNING_DISMISSED_KEY = "shioriCanvasWarningDismissed";

function readCanvasWarningDismissed(): boolean {
  try {
    return sessionStorage.getItem(CANVAS_WARNING_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveCanvasWarningDismissed(): void {
  try {
    sessionStorage.setItem(CANVAS_WARNING_DISMISSED_KEY, "1");
  } catch {
    // ignore
  }
}

/**
 * The browser-canvas capability warning (web only). Checked when a PDF opens;
 * dismissing it keeps it away for the rest of the browser session.
 */
export function useCanvasWarning() {
  const { t } = useTranslation();
  const [canvasWarning, setCanvasWarning] =
    useState<CanvasCapabilityReport | null>(null);

  const warnAboutCanvas = useCallback(async () => {
    if (IS_TAURI || readCanvasWarningDismissed()) return;
    const report = await checkCanvasCapabilities();
    if (!report.ok && !readCanvasWarningDismissed()) {
      setCanvasWarning(report);
    }
  }, []);

  const closeCanvasWarning = useCallback(() => {
    saveCanvasWarningDismissed();
    setCanvasWarning(null);
  }, []);

  const retryCanvasWarning = useCallback(async () => {
    const report = await checkCanvasCapabilities();
    if (report.ok) {
      setCanvasWarning(null);
      toast.show(t("canvasWarning.okToast"));
      return true;
    }
    setCanvasWarning(report);
    return false;
  }, [t]);

  return { canvasWarning, warnAboutCanvas, closeCanvasWarning, retryCanvasWarning };
}
