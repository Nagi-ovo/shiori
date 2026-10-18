import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { EncryptedPdfWarningDialog } from "./EncryptedPdfWarningDialog";

describe("EncryptedPdfWarningDialog", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(cleanup);

  test("names the edits the password does not allow before editing", () => {
    let closed = false;
    const view = render(
      <EncryptedPdfWarningDialog
        open
        fileName="protected.pdf"
        restricted={["annotations", "pages"]}
        onClose={() => {
          closed = true;
        }}
      />,
    );

    expect(
      view.getByRole("dialog", { name: "This PDF restricts editing" }),
    ).toBeDefined();
    expect(view.getByText("protected.pdf")).toBeDefined();
    expect(
      view.getByText(
        "The password you opened it with allows reading, but not changing annotations or rearranging pages. Exports keep the original password; to export these edits, open the file with its owner password.",
      ),
    ).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: "Continue reading" }));
    expect(closed).toBe(true);
  });
});
