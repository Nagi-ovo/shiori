import { useLang } from "../i18n/context";
import { SUPPORT_DOC } from "../content/legal";
import { LegalPage } from "./LegalPage";

export function Support() {
  const { lang } = useLang();
  return <LegalPage doc={SUPPORT_DOC[lang]} />;
}
