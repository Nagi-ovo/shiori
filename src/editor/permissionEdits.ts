import type { PdfEditKind } from "../pdf/security/permissions";

/** "changing annotations or rearranging pages", in the reader's language. */
export function formatEditList(
  edits: readonly PdfEditKind[],
  t: (key: string) => string,
  language: string,
): string {
  const names = edits.map((edit) => t(`export.permissionEdits.${edit}`));
  try {
    return new Intl.ListFormat(language, { type: "disjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}
