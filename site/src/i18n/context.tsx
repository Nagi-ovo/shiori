import { createContext, useContext, type ReactNode } from "react";
import type { Dict, Lang } from "./dict";

type Ctx = {
  lang: Lang;
  setLang: (next: Lang) => void;
  t: Dict;
};

export const LanguageContext = createContext<Ctx | null>(null);

export function useLang(): Ctx {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLang must be used within LanguageProvider");
  return ctx;
}

// Render a Dict value that may include inline `{ em }` or `{ code }`
// segments. Keeps strong typing at the boundary so components don't
// each re-implement the walker.
export function renderRich(
  parts: ReadonlyArray<string | { em: string } | { code: string }>,
): ReactNode {
  return parts.map((part, i) => {
    if (typeof part === "string") return <span key={i}>{part}</span>;
    if ("em" in part) return <em key={i}>{part.em}</em>;
    return <code key={i}>{part.code}</code>;
  });
}
