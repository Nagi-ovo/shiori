import type { ReactNode } from "react";
import { useLang } from "../i18n/context";
import { Nav } from "./Nav";
import { Footer } from "./Footer";

// Wrapper shell for long-scrolling sub-pages (Changelog, Shortcuts).
// Reuses the same Nav and Footer as the marketing page so the
// publication identity stays intact, but skips PageScroller — these
// pages are read top-to-bottom, not paginated.

type Props = {
  children: ReactNode;
};

export function DocPage({ children }: Props) {
  const { t } = useLang();
  return (
    <>
      <Nav />
      <main className="doc-main" id="top">
        <div className="wrap">
          <a className="doc-back" href="#top">
            {t.docBack}
          </a>
        </div>
        {children}
        <Footer />
      </main>
    </>
  );
}
