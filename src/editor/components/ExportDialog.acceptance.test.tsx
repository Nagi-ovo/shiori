import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, mock, test } from "bun:test";
import { overlay } from "../../pdf/export/contentText/fixtures.test-support";
import { exportSnapshotKey } from "../export/exportStatus";
import {
  ExportDialog,
  editorStore,
  render,
  exportCalls,
  fixture,
  page,
  saveCalls,
  setupExportDialogTests,
  type VectorCandidate,
} from "../../test/exportDialog";

describe("ExportDialog acceptance", () => {
  setupExportDialogTests();

  test("requires confirmation before saving substituted characters", async () => {
    fixture.runExport = async () => ({
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

  // An original-text edit whose glyphs could not be cut from the page is only
  // painted over: the PDF looks edited, but search and copy still return the
  // old text. Saving that without a word let a "redacted" name leave the app.
  test("requires confirmation before saving edits that leave the original text in the file", async () => {
    fixture.runExport = async () => ({
      bytes: new Uint8Array(1024),
      lostChars: 0,
      unexcisedEdits: 2,
    });
    const view = render(<ExportDialog open onClose={() => undefined} />);
    await waitFor(() => expect(exportCalls).toEqual(["original"]), {
      timeout: 3_000,
    });

    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain(
        "2 text edits could not be applied. Their original text remains unchanged in the exported PDF.",
      ),
    );
    expect(saveCalls).toHaveLength(0);

    fireEvent.click(view.getByRole("button", { name: "Export anyway" }));
    await waitFor(() => expect(saveCalls).toHaveLength(1));
  });

  test("names both problems when an export substitutes characters and keeps original text", async () => {
    fixture.runExport = async () => ({
      bytes: new Uint8Array(1024),
      lostChars: 1,
      unexcisedEdits: 1,
    });
    const view = render(<ExportDialog open onClose={() => undefined} />);
    await waitFor(() => expect(exportCalls).toEqual(["original"]), {
      timeout: 3_000,
    });

    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    await waitFor(() => expect(view.getByRole("alert")).toBeDefined());
    const alert = view.getByRole("alert").textContent ?? "";
    expect(alert).toContain(
      "1 character cannot be encoded and will be replaced with “?” in the exported PDF.",
    );
    expect(alert).toContain("1 text edit could not be applied. Its original text remains unchanged in the exported PDF.");
    expect(saveCalls).toHaveLength(0);
  });

  // A flattened text box or note that is too small clips its later lines, as
  // the editor does; the export used to drop them with no word, so the saved
  // PDF silently lacked text the user had typed.
  test("requires confirmation before saving text that does not fit its box", async () => {
    fixture.runExport = async () => ({
      bytes: new Uint8Array(1024),
      lostChars: 0,
      clippedChars: 9,
    });
    const view = render(<ExportDialog open onClose={() => undefined} />);
    await waitFor(() => expect(exportCalls).toEqual(["original"]), {
      timeout: 3_000,
    });

    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain(
        "9 characters run past the edges of their boxes and will be cut off in the flattened PDF.",
      ),
    );
    expect(saveCalls).toHaveLength(0);

    fireEvent.click(view.getByRole("button", { name: "Export anyway" }));
    await waitFor(() => expect(saveCalls).toHaveLength(1));
  });

  test("reviews every blocking finding even when all counters are zero", async () => {
    const bytes = Uint8Array.of(10);
    fixture.runExport = async () => ({
      bytes,
      lostChars: 0,
      contentTextOutcomes: [
        {
          overlayId: "edited",
          pageIndex: 1,
          mode: "in-place",
          contact: { kind: "new-collision", region: { x: 15.25, y: 42.5, w: 2.75, h: 1 } },
          strippedEquivalent: true,
        },
        { overlayId: "other", pageIndex: 0, mode: "in-place", contact: { kind: "uncertain" } },
      ],
    });
    const view = render(<ExportDialog open onClose={() => undefined} />);
    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));

    const alert = within(await view.findByRole("alert"));
    const findings = alert.getAllByRole("listitem");
    expect(findings).toHaveLength(3);
    expect(findings[0]?.textContent).toContain("New overlap");
    expect(findings[0]?.textContent).toContain("Output page 2");
    expect(findings[0]?.textContent).toContain("x 15.25, y 42.5, width 2.75, height 1");
    expect(findings[1]?.textContent).toContain("Alternate text removed");
    expect(findings[2]?.textContent).toContain("Overlap could not be verified");
    expect(findings[2]?.textContent).toContain("Output page 1");
    expect(saveCalls).toHaveLength(0);
    const confirm = view.getByRole("button", { name: "Export anyway" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(saveCalls).toHaveLength(1));
    expect(saveCalls[0]).toBe(bytes);
    expect(exportCalls).toEqual(["original"]);
  });

  test("saves without confirmation when the verdict has only notes", async () => {
    const bytes = Uint8Array.of(11);
    fixture.runExport = async () => ({
      bytes,
      lostChars: 0,
      contentTextOutcomes: [{
        overlayId: "edited", mode: "substituted", fidelity: "approximate",
        contact: { kind: "pre-existing-contact" }, sourceSpacingAdjusted: true,
      }],
    });
    const view = render(<ExportDialog open onClose={() => undefined} />);
    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    await waitFor(() => expect(saveCalls[0]).toBe(bytes));
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("keeps a review through an equivalent model update and saves its receipt", async () => {
    const bytes = Uint8Array.of(12);
    fixture.runExport = async () => ({ bytes, lostChars: 1 });
    const onExportSaved = mock();
    const view = render(<ExportDialog open onClose={() => undefined} onExportSaved={onExportSaved} />);
    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    await view.findByRole("button", { name: "Export with replacements" });
    act(() => editorStore.setState({ model: structuredClone(editorStore.getState().model) }));
    fireEvent.click(view.getByRole("button", { name: "Export with replacements" }));
    await waitFor(() => expect(saveCalls[0]).toBe(bytes));
    expect(exportCalls).toEqual(["original"]);
    expect(onExportSaved).toHaveBeenCalledWith({
      path: "paper-edited.pdf", platform: "web", completeDocument: true,
      snapshotKey: exportSnapshotKey(editorStore.getState().model),
    });
  });

  test.each([
    ["font", { fontFamily: "sans" }],
    ["size", { fontSize: 20 }],
    ["text", { text: "Other text" }],
  ] as const)("requires a new review after changing the %s", async (_label, edit) => {
    editorStore.setState({ model: { pages: [page], overlays: [overlay({ pageId: page.id })] } });
    const originalBytes = Uint8Array.of(20);
    const newBytes = Uint8Array.of(21);
    fixture.runExport = async () => ({ bytes: originalBytes, lostChars: 1 });
    const view = render(<ExportDialog open onClose={() => undefined} />);
    await view.findByText(/1 B ·/);
    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    await view.findByRole("button", { name: "Export with replacements" });

    fixture.runExport = async () => ({ bytes: newBytes, lostChars: 2 });
    act(() => editorStore.setState({
      model: { pages: [page], overlays: [overlay({ ...edit, pageId: page.id })] },
    }));
    expect(view.queryByRole("alert")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    const confirm = await view.findByRole("button", { name: "Export with replacements" });
    expect(view.getByRole("alert").textContent).toContain("2 characters");
    expect(saveCalls).toHaveLength(0);
    fireEvent.click(confirm);
    await waitFor(() => expect(saveCalls[0]).toBe(newBytes));
    expect(exportCalls).toEqual(["original", "original"]);
  });

  test("re-evaluates cached bytes when their source bytes have changed", async () => {
    const bytes = Uint8Array.of(30);
    fixture.runExport = async () => ({ bytes, lostChars: 0 });
    const view = render(<ExportDialog open onClose={() => undefined} />);
    await view.findByText(/1 B ·/);

    editorStore.getState().opened!.bytes[0] = 1;
    const freshBytes = Uint8Array.of(31);
    fixture.runExport = async () => ({ bytes: freshBytes, lostChars: 0 });
    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    await waitFor(() => expect(saveCalls[0]).toBe(freshBytes));
    expect(exportCalls).toEqual(["original", "original"]);
  });

  test("re-evaluates a review when the source changes without a render", async () => {
    fixture.runExport = async () => ({ bytes: Uint8Array.of(40), lostChars: 1 });
    const view = render(<ExportDialog open onClose={() => undefined} />);
    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    const staleConfirm = await view.findByRole("button", { name: "Export with replacements" });

    editorStore.getState().opened!.bytes[0] = 1;
    const freshBytes = Uint8Array.of(41);
    fixture.runExport = async () => ({ bytes: freshBytes, lostChars: 2 });
    fireEvent.click(staleConfirm);
    const confirm = await view.findByRole("button", { name: "Export with replacements" });
    expect(view.getByRole("alert").textContent).toContain("2 characters");
    expect(saveCalls).toHaveLength(0);
    fireEvent.click(confirm);
    await waitFor(() => expect(saveCalls[0]).toBe(freshBytes));
    expect(exportCalls).toEqual(["original", "original"]);
  });

  test("retries a pending size preview after the selected settings change", async () => {
    let finishOriginal!: (value: VectorCandidate) => void;
    fixture.runExport = () => new Promise((resolve) => { finishOriginal = resolve; });
    const view = render(<ExportDialog open onClose={() => undefined} />);
    await waitFor(() => expect(exportCalls).toEqual(["original"]));
    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));

    const freshBytes = Uint8Array.of(51);
    fixture.runExport = async () => ({ bytes: freshBytes, lostChars: 3 });
    const qualityGroup = within(view.getByRole("radiogroup", { name: "File size" }));
    fireEvent.click(qualityGroup.getByRole("radio", { name: /Standard/ }));
    await act(async () => finishOriginal({ bytes: Uint8Array.of(50), lostChars: 0 }));

    const confirm = await view.findByRole("button", { name: "Export with replacements" });
    expect(view.getByRole("alert").textContent).toContain("3 characters");
    expect(saveCalls).toHaveLength(0);
    fireEvent.click(confirm);
    await waitFor(() => expect(saveCalls[0]).toBe(freshBytes));
    expect(exportCalls).toEqual(["original", "standard"]);
  });

  test("retries a foreground export after its source is replaced", async () => {
    let finishOriginal!: (value: VectorCandidate) => void;
    fixture.runExport = () => new Promise((resolve) => { finishOriginal = resolve; });
    const view = render(<ExportDialog open onClose={() => undefined} />);
    fireEvent.click(view.getByRole("button", { name: "Export PDF" }));
    await waitFor(() => expect(exportCalls).toEqual(["original"]));

    const freshBytes = Uint8Array.of(61);
    fixture.runExport = async () => ({ bytes: freshBytes, lostChars: 0 });
    act(() => editorStore.setState({
      opened: { ...editorStore.getState().opened!, bytes: Uint8Array.of(1) },
    }));
    await act(async () => finishOriginal({ bytes: Uint8Array.of(60), lostChars: 1 }));
    await waitFor(() => expect(saveCalls[0]).toBe(freshBytes));
    expect(view.queryByRole("alert")).toBeNull();
    expect(exportCalls).toEqual(["original", "original"]);
  });
});
