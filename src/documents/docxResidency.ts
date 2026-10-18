import type { DocumentKind, DocumentSource } from "./types";

type DocxResidentTab = {
  id: string;
  kind: DocumentKind;
  source: DocumentSource;
  status: string;
  bytes?: Uint8Array;
};

/** Keep renderer input resident only for the visible DOCX tab. */
export function suspendInactiveDocxTabs<T extends DocxResidentTab>(
  tabs: readonly T[],
  activeTabId: string | null,
): T[] {
  let changed = false;
  const next = tabs.map((tab) => {
    if (
      tab.kind !== "docx" ||
      tab.id === activeTabId ||
      tab.status !== "loaded" ||
      !tab.bytes ||
      tab.source.type === "ephemeral"
    ) {
      return tab;
    }
    changed = true;
    return { ...tab, status: "suspended", bytes: undefined } as T;
  });
  return changed ? next : (tabs as T[]);
}
