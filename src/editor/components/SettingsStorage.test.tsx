import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { StorageRow } from "./SettingsStorage";

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
});
