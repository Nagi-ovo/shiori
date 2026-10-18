import { createContext, useContext } from "react";
import type { ExportStatus } from "../../editor/export/exportStatus";

const CLEAN_STATUS: ExportStatus = { kind: "clean" };

export const PdfExportStatusContext =
  createContext<ExportStatus>(CLEAN_STATUS);

export function usePdfExportStatus(): ExportStatus {
  return useContext(PdfExportStatusContext);
}
