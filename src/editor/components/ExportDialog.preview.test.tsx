import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "bun:test";
import { overlay } from "../../pdf/export/contentText/fixtures.test-support";
import { PDFDocument } from "pdf-lib";
import i18n from "../../i18n";
import {
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
  setupExportDialogTests,
  type VectorCandidate,
} from "../../test/exportDialog";

describe("ExportDialog preview scheduling and compact output", () => {
  setupExportDialogTests();

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
    let resolveExport!: (result: VectorCandidate) => void;
    fixture.runExport = () =>
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
    fixture.runExport = async () => ({ bytes: vectorBytes, lostChars: 0 });
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

  test("compact export classifies the selected bytes and keys the requested quality", async () => {
    const { exportBytesForQuality } = await import("./exportDialogBytes");
    const { opened, model } = editorStore.getState();
    const request = {
      doc: opened!.doc, originalBytes: opened!.bytes, password: undefined,
      model, mode: "flatten", documentFiles: "omit", unicodeFontErrorMessage: "Font unavailable",
    } as const;
    const vector = { bytes: new Uint8Array(1024), lostChars: 2 };
    fixture.runExport = async () => vector;
    const standard = await exportBytesForQuality({ ...request, quality: "standard" });
    const raster = await exportBytesForQuality({ ...request, quality: "compact" });
    expect(raster.bytes.byteLength).toBe(256);
    expect(raster.acceptance).toMatchObject({ status: "accepted", findings: [] });
    const repeat = await exportBytesForQuality({ ...request, quality: "compact" });
    expect(repeat.acceptance.key).toBe(raster.acceptance.key);

    fixture.runCompactRaster = async () => new Uint8Array(2048);
    const fallback = await exportBytesForQuality({ ...request, quality: "compact" });
    expect(fallback.bytes).toBe(vector.bytes);
    expect(fallback.acceptance).toMatchObject({ status: "needs-review", findings: [{ kind: "lost-text", count: 2 }] });
    expect(fallback.acceptance.key).not.toBe(standard.acceptance.key);
    expect(fallback.acceptance.key).toBe(raster.acceptance.key);
    const fallbackAgain = await exportBytesForQuality({ ...request, quality: "compact" });
    expect(fallbackAgain.acceptance.key).toBe(fallback.acceptance.key);
  });

  // The raster is a new PDF drawn page by page. When it won on size, the saved
  // file had no Title or Author, so it appeared untitled in document lists.
  test("a compact raster keeps the source's title and author, attachments or not", async () => {
    fixture.runInfoBridge = (await import("../../pdf/export/documentInfo")).preserveDocumentInfoInPdf;
    const vector = await PDFDocument.create();
    vector.setTitle("Attention Is All You Need");
    vector.setAuthor("A. Vaswani");
    for (let i = 0; i < 40; i++) vector.addPage([612, 792]);
    const vectorBytes = await vector.save();
    fixture.runExport = async () => ({ bytes: vectorBytes, lostChars: 0 });
    const raster = await PDFDocument.create();
    raster.addPage([612, 792]);
    const rasterBytes = await raster.save();
    fixture.runCompactRaster = async () => rasterBytes;
    localStorage.setItem(
      "shiori:exportPrefs:v1",
      JSON.stringify({ mode: "annotations", quality: "compact" }),
    );
    const view = render(<ExportDialog open onClose={() => undefined} />);
    const pagesGroup = view.getByRole("radiogroup", { name: "Pages" });
    fireEvent.click(
      within(pagesGroup).getByRole("radio", { name: /Current page only/ }),
    );
    await waitFor(() => expect(documentFilePolicies.at(-1)).toBe("omit"), {
      timeout: 3_000,
    });

    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    await waitFor(() => expect(saveCalls).toHaveLength(1), { timeout: 3_000 });
    expect(fixture.compactRasterCalls).toBeGreaterThan(0);
    const saved = await PDFDocument.load(saveCalls[0]!);
    expect(saved.getPageCount()).toBe(1);
    expect(saved.getTitle()).toBe("Attention Is All You Need");
    expect(saved.getAuthor()).toBe("A. Vaswani");
  });

  test.each(["in-place", "unsupported"] as const)(
    "Small file saves the source-text writer's result (%s)",
    async (mode) => {
      const edit = overlay({ pageId: page.id });
      editorStore.setState({ model: { pages: [page], overlays: [edit] } });
      const vector = new Uint8Array(1024).fill(86);
      fixture.runExport = async () => ({
        bytes: vector,
        lostChars: 0,
        unexcisedEdits: mode === "unsupported" ? 1 : 0,
        contentTextOutcomes: [{ overlayId: edit.id, mode }],
      });
      localStorage.setItem(
        "shiori:exportPrefs:v1",
        JSON.stringify({ mode: "annotations", quality: "compact" }),
      );
      const view = render(<ExportDialog open onClose={() => undefined} />);
      fireEvent.click(view.getByRole("button", { name: "Export PDF" }));

      if (mode === "unsupported") {
        const confirm = await view.findByRole("button", { name: "Export anyway" });
        expect(saveCalls).toHaveLength(0);
        fireEvent.click(confirm);
      }
      await waitFor(() => expect(saveCalls).toEqual([vector]), { timeout: 3_000 });
      expect(saveCalls[0]).toBe(vector);
      expect(exportCalls).toEqual(["standard"]);
    },
  );

  describe("an encrypted source", () => {
    const MODIFY = 1 << 3;
    const ANNOTATE = 1 << 5;
    const NONE = 0xfffff0c0;
    const vectorPlain = new Uint8Array(1024).fill(86);
    const rasterPlain = new Uint8Array(256).fill(82);

    function openEncrypted(permissions: number) {
      editorStore.setState({
        opened: {
          ...editorStore.getState().opened!,
          password: "user-pw",
          encrypted: true,
        },
      });
      fixture.sourceEncryption = {
        security: { revision: 6, permissions, userPermissions: permissions },
        plaintext: async () => new Uint8Array(128),
        encrypt: fakeEncrypt,
      };
      fixture.runExport = async () => ({ bytes: vectorPlain, lostChars: 0 });
      fixture.runCompactRaster = async () => rasterPlain;
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
      // Attachments and Info are copied from the plaintext vector, never
      // from ciphertext.
      expect(preservedDocumentFileSources.map((b) => b[0])).toEqual([vectorPlain[0]]);
      expect(preservedInfoSources.map((b) => b[0])).toEqual([vectorPlain[0]]);
      expect(new Set(encryptionPasswords)).toEqual(new Set(["user-pw"]));
    });

    test("keeps the encrypted vector when the permissions forbid replacing page content", async () => {
      openEncrypted(NONE | ANNOTATE);
      const view = render(<ExportDialog open onClose={() => undefined} />);

      fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
      await waitFor(() => expect(saveCalls).toHaveLength(1), { timeout: 3_000 });
      expect(Array.from(saveCalls[0]!)).toEqual(Array.from(await fakeEncrypt(vectorPlain)));
      expect(fixture.compactRasterCalls).toBe(0);
    });

    test.each(["original", "compact"] as const)(
      "confirms the reviewed ciphertext exactly once at %s quality",
      async (quality) => {
        openEncrypted(NONE | ANNOTATE);
        localStorage.setItem("shiori:exportPrefs:v1", JSON.stringify({ mode: "annotations", quality }));
        const ciphertext = Uint8Array.of(224, 7, 2);
        fixture.sourceEncryption!.encrypt = async () => ciphertext;
        fixture.runExport = async () => ({ bytes: vectorPlain, lostChars: 1 });
        const view = render(<ExportDialog open onClose={() => undefined} />);
        await view.findByText(/3 B ·/);
        fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
        const confirm = await view.findByRole("button", { name: "Export with replacements" });
        expect(saveCalls).toHaveLength(0);
        fireEvent.click(confirm);
        await waitFor(() => expect(saveCalls).toHaveLength(1));
        expect(saveCalls[0]).toBe(ciphertext);
        expect(encryptionPasswords).toEqual(["user-pw"]);
        expect(exportCalls).toEqual([quality === "compact" ? "standard" : quality]);
      },
    );

    test("never rasterizes an encrypted source it has no handler for", async () => {
      openEncrypted(NONE | MODIFY | ANNOTATE);
      fixture.sourceEncryption = undefined;
      fixture.unhandledEncryption = true;
      const view = render(<ExportDialog open onClose={() => undefined} />);

      fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
      await waitFor(
        () => expect(view.getByText(i18n.t("export.encryptedSourceError"))).toBeDefined(),
        { timeout: 3_000 },
      );
      expect(saveCalls).toHaveLength(0);
      expect(fixture.compactRasterCalls).toBe(0);
    });

    test("explains which edits the permissions refuse", async () => {
      openEncrypted(NONE);
      fixture.runExport = async () => {
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
