import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import Dexie from "dexie";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import i18n from "../../i18n";

Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;
const { StorageControls, StorageRow } = await import("./SettingsStorage");
const { default: drafts, __draftsTest } = await import("../../storage/drafts");
const { draftIdFor } = await import("../../storage/draftIdentity");

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(cleanup);

describe("Settings storage rows", () => {
  // Deleting a draft is immediate and has no undo. With every row's icon
  // button named just "Delete", a screen-reader user tabbing through ten
  // drafts could not tell which file the next button would destroy.
  test("each delete button names the draft it deletes", () => {
    const view = render(
      <>
        {["thesis.pdf", "receipt.pdf"].map((name) => (
          <StorageRow
            key={name}
            name={name}
            size={1024}
            editedRel="just now"
            storageBytes={2048}
            onDelete={() => undefined}
          />
        ))}
      </>,
    );
    expect(view.getByRole("button", { name: "Delete thesis.pdf" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Delete receipt.pdf" })).toBeTruthy();
  });

  // The same bytes at two paths keep two drafts under one file name.
  test("drafts of the same file at two paths say which path each is", async () => {
    await __draftsTest.reset();
    const hash = "ab".repeat(32);
    for (const path of ["/docs/paper.pdf", "/backup/paper.pdf"]) {
      await drafts.put({
        id: draftIdFor(hash, { type: "path", path }),
        fileName: "paper.pdf",
        fileSize: 4,
        pdfBytes: new Uint8Array([1, 2, 3, 4]),
        model: { pages: [], overlays: [] },
        lastTouched: 1,
      });
    }
    try {
      const view = render(<StorageControls />);
      expect(await view.findByText("/docs/paper.pdf")).toBeTruthy();
      expect(view.getByText("/backup/paper.pdf")).toBeTruthy();
      expect(view.getByRole("button", { name: "Delete /docs/paper.pdf" })).toBeTruthy();
      expect(view.getByRole("button", { name: "Delete /backup/paper.pdf" })).toBeTruthy();
    } finally {
      await __draftsTest.reset();
    }
  });
});
