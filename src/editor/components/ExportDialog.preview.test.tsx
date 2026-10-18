import "../../test/setupDom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import i18n from "../../i18n";
import type { PageModel } from "../../pdf/model/types";
import type { ExportResult } from "../../pdf/export/exportPdf";
import type { ExportSourceEncryption } from "../../pdf/export/encryptedSource";
import { useEditorStore } from "../store/store";
import type { ExportDialog as ExportDialogComponent } from "./ExportDialog";

const exportCalls: string[] = [];
const saveCalls: Uint8Array[] = [];
const documentFilePolicies: string[] = [];
const preservedDocumentFileSources: Uint8Array[] = [];
let runExport: () => Promise<ExportResult> = async () => ({
  bytes: new Uint8Array(1024),
  lostChars: 0,
});
let runCompactRaster: () => Promise<Uint8Array> = async () =>
  new Uint8Array(256);

let compactRasterCalls = 0;
/** Whether the export module finds an /Encrypt no handler covers. */
let unhandledEncryption = false;
// The handler of the open document when it is encrypted, as
// src/pdf/export/encryptedSource.ts hands it over; undefined when it is not.
let sourceEncryption: ExportSourceEncryption | undefined;
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

mock.module("../export/exportPdfAdapter", () => ({
  withExportEncryption: async (
    opened: { password?: string },
    run: (encryption: ExportSourceEncryption | undefined) => Promise<unknown>,
  ) => {
    encryptionPasswords.push(opened.password);
    return run(sourceEncryption);
  },
  loadExportPdfModule: async () => ({
    exportPdf: async (
      _bytes: Uint8Array,
      _model: unknown,
      options: {
        quality?: string;
        documentFiles?: string;
        sourceEncryption?: ExportSourceEncryption;
      } = {},
    ) => {
      exportCalls.push(options.quality ?? "original");
      documentFilePolicies.push(options.documentFiles ?? "auto");
      const result = await runExport();
      if (!options.sourceEncryption) return result;
      return {
        ...result,
        bytes: await options.sourceEncryption.encrypt(result.bytes, 1),
      };
    },
    assertExportIntegrity: async () => undefined,
    refuseUnhandledEncryption: async () => {
      if (unhandledEncryption) throw new MockExportEncryptedSourceError();
    },
    preserveDocumentFilesInPdf: async (
      sourceBytes: Uint8Array,
      outputBytes: Uint8Array,
    ) => {
      preservedDocumentFileSources.push(sourceBytes);
      return outputBytes;
    },
    ExportIntegrityError: MockExportIntegrityError,
    ExportEncryptedSourceError: MockExportEncryptedSourceError,
    ExportSignedSourceError: MockExportSignedSourceError,
    ExportPermissionError: MockExportPermissionError,
    ExportEncryptionUnsupportedError: MockExportEncryptionUnsupportedError,
    ExportEncryptionVerifyError: MockExportEncryptionVerifyError,
  }),
}));

mock.module("../export/compactRasterPdfAdapter", () => ({
  exportCompactRasterPdf: async () => {
    compactRasterCalls += 1;
    return runCompactRaster();
  },
}));

mock.module("../export/exportPlatformAdapter", () => ({
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

const initialStore = useEditorStore.getState();
const page: PageModel = {
  id: "page-1",
  sourceIndex: 0,
  rotation: 0,
  widthPt: 612,
  heightPt: 792,
};
let ExportDialog: typeof ExportDialogComponent;

describe("ExportDialog preview scheduling", () => {
  beforeAll(async () => {
    ExportDialog = (await import("./ExportDialog")).ExportDialog;
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
    compactRasterCalls = 0;
    unhandledEncryption = false;
    sourceEncryption = undefined;
    encryptionPasswords.length = 0;
    runExport = async () => ({ bytes: new Uint8Array(1024), lostChars: 0 });
    runCompactRaster = async () => new Uint8Array(256);
    useEditorStore.setState(initialStore, true);
    useEditorStore.setState({
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
    useEditorStore.setState(initialStore, true);
  });

  afterAll(() => {
    mock.restore();
  });

  test("calculates only the selected quality", async () => {
    const view = render(<ExportDialog open onClose={() => undefined} />);

    await waitFor(() => expect(exportCalls).toEqual(["original"]), {
      timeout: 3_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exportCalls).toEqual(["original"]);
    expect(view.getAllByText("Select to calculate size")).toHaveLength(2);

    const qualityGroup = view.getByRole("radiogroup", { name: "File size" });
    fireEvent.click(
      within(qualityGroup).getByRole("radio", { name: /Standard/ }),
    );

    await waitFor(
      () => expect(exportCalls).toEqual(["original", "standard"]),
      { timeout: 3_000 },
    );
  });

  test("reuses an in-flight preview when Export is clicked", async () => {
    let resolveExport!: (result: ExportResult) => void;
    runExport = () =>
      new Promise((resolve) => {
        resolveExport = resolve;
      });
    const view = render(<ExportDialog open onClose={() => undefined} />);

    await waitFor(() => expect(exportCalls).toEqual(["original"]), {
      timeout: 3_000,
    });
    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exportCalls).toEqual(["original"]);

    await act(async () => {
      resolveExport({ bytes: new Uint8Array(1024), lostChars: 0 });
      await Promise.resolve();
    });
  });

  test("requires confirmation before saving substituted characters", async () => {
    runExport = async () => ({
      bytes: new Uint8Array(1024),
      lostChars: 2,
    });
    const view = render(<ExportDialog open onClose={() => undefined} />);
    await waitFor(() => expect(exportCalls).toEqual(["original"]), {
      timeout: 3_000,
    });

    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    await waitFor(() =>
      expect(
        view.getByText(
          "2 characters cannot be encoded and will be replaced with “?” in the exported PDF.",
        ),
      ).toBeDefined(),
    );
    expect(saveCalls).toHaveLength(0);

    fireEvent.click(
      view.getByRole("button", { name: "Export with replacements" }),
    );
    await waitFor(() => expect(saveCalls).toHaveLength(1));
  });

  test("omits document files for selected pages and explains the privacy boundary", async () => {
    const view = render(<ExportDialog open onClose={() => undefined} />);
    await waitFor(() => expect(documentFilePolicies).toEqual(["preserve"]), {
      timeout: 3_000,
    });

    const pagesGroup = view.getByRole("radiogroup", { name: "Pages" });
    fireEvent.click(
      within(pagesGroup).getByRole("radio", { name: /Current page only/ }),
    );

    expect(
      view.getByText(
        "Document attachments from the original PDF are not included when you export selected pages.",
      ),
    ).toBeDefined();
    await waitFor(
      () => expect(documentFilePolicies.at(-1)).toBe("omit"),
      { timeout: 3_000 },
    );
  });

  test("uses the projected vector PDF as compact attachment source", async () => {
    const vectorBytes = new Uint8Array([86, 69, 67, 84, 79, 82]);
    runExport = async () => ({ bytes: vectorBytes, lostChars: 0 });
    localStorage.setItem(
      "shiori:exportPrefs:v1",
      JSON.stringify({ mode: "annotations", quality: "compact" }),
    );

    render(<ExportDialog open onClose={() => undefined} />);

    await waitFor(
      () => expect(preservedDocumentFileSources).toEqual([vectorBytes]),
      { timeout: 3_000 },
    );
  });

  describe("an encrypted source", () => {
    const MODIFY = 1 << 3;
    const ANNOTATE = 1 << 5;
    const NONE = 0xfffff0c0;
    const vectorPlain = new Uint8Array(1024).fill(86);
    const rasterPlain = new Uint8Array(256).fill(82);

    function openEncrypted(permissions: number) {
      useEditorStore.setState({
        opened: {
          ...useEditorStore.getState().opened!,
          password: "user-pw",
          encrypted: true,
        },
      });
      sourceEncryption = {
        security: { revision: 6, permissions, userPermissions: permissions },
        plaintext: async () => new Uint8Array(128),
        encrypt: fakeEncrypt,
      };
      runExport = async () => ({ bytes: vectorPlain, lostChars: 0 });
      runCompactRaster = async () => rasterPlain;
      localStorage.setItem(
        "shiori:exportPrefs:v1",
        JSON.stringify({ mode: "annotations", quality: "compact" }),
      );
    }

    test("saves a compact raster only after encrypting it like the source", async () => {
      openEncrypted(NONE | MODIFY | ANNOTATE);
      const view = render(<ExportDialog open onClose={() => undefined} />);

      fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
      await waitFor(() => expect(saveCalls).toHaveLength(1), { timeout: 3_000 });
      expect(Array.from(saveCalls[0]!)).toEqual(Array.from(await fakeEncrypt(rasterPlain)));
      // Attachments are copied from the plaintext vector, never from ciphertext.
      expect(preservedDocumentFileSources.map((b) => b[0])).toEqual([vectorPlain[0]]);
      expect(new Set(encryptionPasswords)).toEqual(new Set(["user-pw"]));
    });

    test("keeps the encrypted vector when the permissions forbid replacing page content", async () => {
      openEncrypted(NONE | ANNOTATE);
      const view = render(<ExportDialog open onClose={() => undefined} />);

      fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
      await waitFor(() => expect(saveCalls).toHaveLength(1), { timeout: 3_000 });
      expect(Array.from(saveCalls[0]!)).toEqual(Array.from(await fakeEncrypt(vectorPlain)));
      expect(compactRasterCalls).toBe(0);
    });

    test("never rasterizes an encrypted source it has no handler for", async () => {
      openEncrypted(NONE | MODIFY | ANNOTATE);
      sourceEncryption = undefined;
      unhandledEncryption = true;
      const view = render(<ExportDialog open onClose={() => undefined} />);

      fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
      await waitFor(
        () => expect(view.getByText(i18n.t("export.encryptedSourceError"))).toBeDefined(),
        { timeout: 3_000 },
      );
      expect(saveCalls).toHaveLength(0);
      expect(compactRasterCalls).toBe(0);
    });

    test("explains which edits the permissions refuse", async () => {
      openEncrypted(NONE);
      runExport = async () => {
        throw new MockExportPermissionError(["annotations", "pages"]);
      };
      localStorage.setItem(
        "shiori:exportPrefs:v1",
        JSON.stringify({ mode: "annotations", quality: "original" }),
      );
      const view = render(<ExportDialog open onClose={() => undefined} />);

      fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
      await waitFor(
        () =>
          expect(
            view.getByText(
              "This PDF's permissions do not allow changing annotations or rearranging pages. Open it with the owner password to export these edits.",
            ),
          ).toBeDefined(),
        { timeout: 3_000 },
      );
      expect(saveCalls).toHaveLength(0);
    });
  });
});
