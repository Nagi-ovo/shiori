import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LanguageProvider } from "./i18n/provider";
import { ReleaseProvider } from "./release/context";
import { ThemeProvider } from "./theme/provider";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <LanguageProvider>
        <ReleaseProvider>
          <App />
        </ReleaseProvider>
      </LanguageProvider>
    </ThemeProvider>
  </StrictMode>,
);
