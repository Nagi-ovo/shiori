import "./setupDom";
import { cleanup, render as renderInDom } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  mock,
} from "bun:test";
import i18n from "../i18n";
import type { DocumentModel, PageModel } from "../pdf/model/types";
import type { ExportOptions, ExportResult } from "../pdf/export/exportPdf";
import { evaluateAcceptance } from "../pdf/export/acceptance";
import { exportCandidateKey } from "../pdf/export/candidateKey";
import type { ExportSourceEncryption } from "../pdf/export/encryptedSource";
import { createPdfEditorStore, EditorStoreContext } from "../editor/store/store";
import type { ExportDialog as ExportDialogComponent } from "../editor/components/ExportDialog";

const exportCalls: string[] = [];
const saveCalls: Uint8Array[] = [];
const documentFilePolicies: string[] = [];
const preservedDocumentFileSources: Uint8Array[] = [];
const preservedInfoSources: Uint8Array[] = [];
export type VectorCandidate = Omit<ExportResult, "acceptance">;
const fixture = {
  // Tests that inspect Info in the saved file use the real bridge.
  runInfoBridge: async (_source: Uint8Array, output: Uint8Array) => output,
  runExport: async (): Promise<VectorCandidate> => ({ bytes: new Uint8Array(1024), lostChars: 0 }),
  runCompactRaster: async () => new Uint8Array(256),
  compactRasterCalls: 0,
  unhandledEncryption: false,
  sourceEncryption: undefined as ExportSourceEncryption | undefined,
};
const encryptionPasswords: (string | undefined)[] = [];
/** What the fake handler makes of a plaintext: a tagged copy. */
const ENCRYPTED_TAG = 0xe0;
const fakeEncrypt = async (plain: Uint8Array) => Uint8Array.of(ENCRYPTED_TAG, ...plain);

class MockExportIntegrityError extends Error {}
class MockExportEncryptedSourceError extends Error {}
class MockExportSignedSourceError extends Error {}
class MockExportPermissionError extends Error {
  constructor(readonly denied: string[]) {
    super("denied");
  }
}
class MockExportEncryptionUnsupportedError extends Error {}
class MockExportEncryptionVerifyError extends Error {}

mock.module("../editor/export/exportPdfAdapter", () => ({
  withExportEncryption: async (
    opened: { password?: string },
    run: (encryption: ExportSourceEncryption | undefined) => Promise<unknown>,
  ) => {
    encryptionPasswords.push(opened.password);
    const handler = fixture.sourceEncryption;
    return run(handler && { ...handler, encrypt: (plain, pageCount) => handler.encrypt(plain, pageCount) });
  },
  loadExportPdfModule: async () => ({
    exportPdf: async (
      bytes: Uint8Array,
      model: DocumentModel,
      options: ExportOptions = {},
    ) => {
      exportCalls.push(options.quality ?? "original");
      documentFilePolicies.push(options.documentFiles ?? "auto");
      const candidate = await fixture.runExport();
      const result: ExportResult = {
        ...candidate,
        acceptance: evaluateAcceptance(candidate, options.acceptance ?? "review", exportCandidateKey(bytes, model, options)),
      };
      if (!options.sourceEncryption) return result;
      return {
        ...result,
        bytes: await options.sourceEncryption.encrypt(result.bytes, 1),
      };
    },
    assertExportIntegrity: async () => undefined,
    refuseUnhandledEncryption: async () => {
      if (fixture.unhandledEncryption) throw new MockExportEncryptedSourceError();
    },
    preserveDocumentFilesInPdf: async (
      sourceBytes: Uint8Array,
      outputBytes: Uint8Array,
    ) => {
      preservedDocumentFileSources.push(sourceBytes);
      return outputBytes;
    },
    preserveDocumentInfoInPdf: (sourceBytes: Uint8Array, outputBytes: Uint8Array) => {
      preservedInfoSources.push(sourceBytes);
      return fixture.runInfoBridge(sourceBytes, outputBytes);
    },
    ExportIntegrityError: MockExportIntegrityError,
    ExportEncryptedSourceError: MockExportEncryptedSourceError,
    ExportSignedSourceError: MockExportSignedSourceError,
    ExportPermissionError: MockExportPermissionError,
    ExportEncryptionUnsupportedError: MockExportEncryptionUnsupportedError,
    ExportEncryptionVerifyError: MockExportEncryptionVerifyError,
  }),
}));

mock.module("../editor/export/compactRasterPdfAdapter", () => ({
  exportCompactRasterPdf: async () => {
    fixture.compactRasterCalls += 1;
    return fixture.runCompactRaster();
  },
}));

mock.module("../editor/export/exportPlatformAdapter", () => ({
  saveBytes: async (bytes: Uint8Array) => {
    saveCalls.push(bytes);
    return {
      status: "saved",
      path: "paper-edited.pdf",
      platform: "web",
    };
  },
  openExportedFile: async () => undefined,
  revealExportedFile: async () => undefined,
}));

const editorStore = createPdfEditorStore();
const initialStore = editorStore.getState();
const page: PageModel = {
  id: "page-1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
};
let ExportDialog: typeof ExportDialogComponent;

export function setupExportDialogTests() {
  beforeAll(async () => {
    ExportDialog = (await import("../editor/components/ExportDialog")).ExportDialog;
    await i18n.changeLanguage("en");
  });

  beforeEach(() => {
    cleanup();
    document.body.replaceChildren();
    localStorage.clear();
    exportCalls.length = 0;
    saveCalls.length = 0;
    documentFilePolicies.length = 0;
    preservedDocumentFileSources.length = 0;
    preservedInfoSources.length = 0;
    fixture.runInfoBridge = async (_source, output) => output;
    fixture.compactRasterCalls = 0;
    fixture.unhandledEncryption = false;
    fixture.sourceEncryption = undefined;
    encryptionPasswords.length = 0;
    fixture.runExport = async () => ({ bytes: new Uint8Array(1024), lostChars: 0 });
    fixture.runCompactRaster = async () => new Uint8Array(256);
    editorStore.setState(initialStore, true);
    editorStore.setState({
      opened: {
        fileName: "paper.pdf",
        fileSize: 128,
        doc: {} as never,
        bytes: new Uint8Array(128),
        sourcePages: [page],
      },
      model: { pages: [page], overlays: [] },
      activePageId: page.id,
    });
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    editorStore.setState(initialStore, true);
  });

  afterAll(() => {
    mock.restore();
  });

}

function render(ui: ReactElement) {
  return renderInDom(ui, {
    wrapper: ({ children }) => createElement(EditorStoreContext, { value: editorStore }, children),
  });
}

export {
  ExportDialog,
  editorStore,
  render,
  MockExportPermissionError,
  documentFilePolicies,
  encryptionPasswords,
  exportCalls,
  fakeEncrypt,
  fixture,
  page,
  preservedDocumentFileSources,
  preservedInfoSources,
  saveCalls,
};
