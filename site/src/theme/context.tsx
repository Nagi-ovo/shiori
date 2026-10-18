import { createContext, useContext } from "react";

export type Theme = "light" | "dark";

type Ctx = {
  theme: Theme;
  toggle: () => void;
  set: (next: Theme) => void;
};

export const ThemeContext = createContext<Ctx | null>(null);

export function useTheme(): Ctx {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
