import i18n from "../i18n";

/**
 * `t` for modules created once per window: it reads the language when a
 * message is shown, so a language switch needs no re-creation.
 */
export const translate = (key: string, vars?: Record<string, unknown>) =>
  i18n.t(key, vars) as string;
