import { useLang } from "../i18n/context";
import { PRIVACY_DOC } from "../content/legal";
import { LegalPage } from "./LegalPage";

export function PrivacyPolicy() {
  const { lang } = useLang();
  return <LegalPage doc={PRIVACY_DOC[lang]} />;
}
