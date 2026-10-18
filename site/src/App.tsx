import { Nav } from "./components/Nav";
import { Hero } from "./components/Hero";
import { Manifesto } from "./components/Manifesto";
import { Features } from "./components/Features";
import { CliPreview } from "./components/CliPreview";
import { Specs } from "./components/Specs";
import { Download } from "./components/Download";
import { Privacy } from "./components/Privacy";
import { Footer } from "./components/Footer";
import { Chrome } from "./components/Chrome";
import { PageScroller } from "./components/PageScroller";
import { DocPage } from "./components/DocPage";
import { Changelog } from "./components/Changelog";
import { Shortcuts } from "./components/Shortcuts";
import { PrivacyPolicy } from "./components/PrivacyPolicy";
import { Support } from "./components/Support";
import { useRouteAnnouncement } from "./router/announce";
import { useRoute } from "./router/route";
import { useLang } from "./i18n/context";

function SkipLink() {
  const { t } = useLang();
  return (
    <a className="skip-link" href="#top">
      {t.a11ySkip}
    </a>
  );
}

export function App() {
  const route = useRoute();
  useRouteAnnouncement(route);

  if (route === "changelog") {
    return (
      <>
        <SkipLink />
        <DocPage>
          <Changelog />
        </DocPage>
        <Chrome />
      </>
    );
  }

  if (route === "shortcuts") {
    return (
      <>
        <SkipLink />
        <DocPage>
          <Shortcuts />
        </DocPage>
        <Chrome />
      </>
    );
  }

  if (route === "privacy") {
    return (
      <>
        <SkipLink />
        <DocPage>
          <PrivacyPolicy />
        </DocPage>
        <Chrome />
      </>
    );
  }

  if (route === "support") {
    return (
      <>
        <SkipLink />
        <DocPage>
          <Support />
        </DocPage>
        <Chrome />
      </>
    );
  }

  return (
    <>
      <SkipLink />
      <Nav />
      <main id="top">
        <PageScroller>
          <Hero />
          <Manifesto />
          <Features />
          <CliPreview />
          <Specs />
          <Download />
          <Privacy />
          <Footer />
        </PageScroller>
      </main>
      <Chrome />
    </>
  );
}
