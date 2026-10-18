import { Profiler, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import App from "./App";
import { BetaDisclaimerDialog } from "./editor/components/BetaDisclaimerDialog";
import { WindowCaption } from "./editor/components/WindowCaption";
import { applyDisplayStyle, applyTheme, resolveEffectiveTheme } from "./design/theme";
import { installAndroidShellSync } from "./platform/androidShell";
import { CAPABILITIES } from "./platform";
import { markScrollbarStyle } from "./platform/scrollbars";
import { loadInitialPrefs } from "./editor/store/store";
import {
  isTabPerfEnabled,
  recordTabPerfCommit,
} from "./perf/tabPerf";

// Prime the CSS custom properties before the first paint so the app
// doesn't flash as an unstyled (missing-var) tree. App.tsx owns the
// ongoing subscription to prefs + matchMedia — this is just the boot
// shot.
const initialPrefs = loadInitialPrefs();
applyTheme(
  resolveEffectiveTheme(initialPrefs.colorMode),
  initialPrefs.theme,
  initialPrefs.accentColor,
);
applyDisplayStyle(initialPrefs.serifAccents);
markScrollbarStyle(document.documentElement);
// After the boot theme: the Android shell mirrors the colour scheme into the
// system bars and fills the safe-area variables the layout reads.
installAndroidShellSync();

const tabPerfEnabled = isTabPerfEnabled();
const app = tabPerfEnabled ? (
  <Profiler id="AppTree" onRender={recordTabPerfCommit}>
    <App />
  </Profiler>
) : (
  <App />
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {app}
    <BetaDisclaimerDialog />
    {/* Outside App so every screen has it, the expired and error screens
        included: an undecorated window without these cannot be closed. */}
    {CAPABILITIES.customWindowCaption ? <WindowCaption /> : null}
  </StrictMode>,
);
