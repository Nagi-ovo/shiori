import "../../test/setupDom";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import i18n from "../../i18n";
import type { DocumentPreviewData } from "./documentPreview";
import { DocumentList } from "./DocumentTree";

const ITEMS = [
  { id: "first", kind: "pdf" as const, title: "First paper.pdf" },
  { id: "second", kind: "pdf" as const, title: "Second paper.pdf" },
];

const baseProps = {
  items: ITEMS,
  activeTabId: null,
  markCount: 0,
  onSelect: () => undefined,
  onClose: () => undefined,
  onTogglePin: () => undefined,
  onShowMarks: () => undefined,
  folderPaths: [],
  onUnmountFolder: () => undefined,
  onOpenFolderFile: () => undefined,
};

function documentRow(view: ReturnType<typeof render>, title: string) {
  const row = view.getByText(title).closest<HTMLElement>("[role=button]");
  if (!row) throw new Error(`document row not found: ${title}`);
  return row;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("document list cached previews", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  test("keyboard focus shows the cached reading position immediately", async () => {
    const onSelect = mock(() => undefined);
    const onPreviewRequest = mock(async () => ({
      imageUrl: "data:image/jpeg;base64,keyboard-position",
      pageNumber: 7,
      scale: 1.4,
    }));
    const view = render(
      <DocumentList
        {...baseProps}
        onSelect={onSelect}
        onPreviewRequest={onPreviewRequest}
      />,
    );

    fireEvent.focus(documentRow(view, "First paper.pdf"));

    expect(onPreviewRequest).toHaveBeenCalledWith("first");
    const preview = await view.findByRole("tooltip");
    await waitFor(() =>
      expect(preview.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/jpeg;base64,keyboard-position",
      ),
    );
    expect(preview.textContent).toContain("Page 7 · 140%");
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("pointer hover waits briefly before reading the preview cache", async () => {
    const onPreviewRequest = mock(async () => ({
      imageUrl: "data:image/jpeg;base64,hover-position",
      pageNumber: 3,
      scale: 1,
    }));
    const view = render(
      <DocumentList {...baseProps} onPreviewRequest={onPreviewRequest} />,
    );
    const row = documentRow(view, "First paper.pdf");

    fireEvent.mouseMove(row, { clientX: 80, clientY: 160 });

    expect(view.getByRole("tooltip").textContent).toContain("First paper.pdf");
    expect(onPreviewRequest).not.toHaveBeenCalled();
    await waitFor(
      () => expect(onPreviewRequest).toHaveBeenCalledWith("first"),
      { timeout: 900 },
    );
    await waitFor(() =>
      expect(
        view.getByRole("tooltip").querySelector("img")?.getAttribute("src"),
      ).toBe("data:image/jpeg;base64,hover-position"),
    );
  });

  test("a newer row wins when an older preview request resolves late", async () => {
    const first = deferred<DocumentPreviewData | null>();
    const second = deferred<DocumentPreviewData | null>();
    const onPreviewRequest = mock((id: string) =>
      id === "first" ? first.promise : second.promise,
    );
    const view = render(
      <DocumentList {...baseProps} onPreviewRequest={onPreviewRequest} />,
    );

    fireEvent.focus(documentRow(view, "First paper.pdf"));
    fireEvent.focus(documentRow(view, "Second paper.pdf"));
    await act(async () => {
      second.resolve({ imageUrl: "data:image/jpeg;base64,second" });
      await second.promise;
    });
    expect(
      view.getByRole("tooltip").querySelector("img")?.getAttribute("src"),
    ).toBe("data:image/jpeg;base64,second");

    await act(async () => {
      first.resolve({ imageUrl: "data:image/jpeg;base64,first" });
      await first.promise;
    });
    expect(view.getByRole("tooltip").textContent).toContain("Second paper.pdf");
    expect(
      view.getByRole("tooltip").querySelector("img")?.getAttribute("src"),
    ).toBe("data:image/jpeg;base64,second");
  });

  test("metadata without a cached visual keeps the compact filename card", async () => {
    const onPreviewRequest = mock(async () => ({ pageNumber: 2, scale: 1.2 }));
    const view = render(
      <DocumentList {...baseProps} onPreviewRequest={onPreviewRequest} />,
    );

    fireEvent.focus(documentRow(view, "First paper.pdf"));
    await waitFor(() => expect(onPreviewRequest).toHaveBeenCalledWith("first"));
    await act(async () => {
      await Promise.resolve();
    });

    const preview = view.getByRole("tooltip");
    expect(preview.textContent).toContain("First paper.pdf");
    expect(preview.textContent).not.toContain("Page 2");
    expect(preview.querySelector("img, iframe")).toBeNull();
  });
});
