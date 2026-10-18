import type { WorkspacePdfViewState } from "../storage/workspace";
import type { RecentEntry } from "./recentDocs";

export function explicitInitialPdfPageIndex(
  pdfView: WorkspacePdfViewState | undefined,
  replaceRecentEntry?: Pick<RecentEntry, "lastViewedPageIndex">,
): number | undefined {
  return pdfView?.pageIndex ?? replaceRecentEntry?.lastViewedPageIndex;
}
