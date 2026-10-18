import { createPdfiumEngine } from "./pdfiumEngine";
import { createWasmCoreBridge } from "./wasm/coreClient";

/** The web and mobile builds' engine: shiori-core as wasm in a worker. */
export const pdfiumWebEngine = createPdfiumEngine(createWasmCoreBridge(), "PDFium 7881 wasm");
