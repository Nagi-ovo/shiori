import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { ExportPagesSection } from "./ExportPagesSection";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(cleanup);

describe("ExportPagesSection", () => {
  // The custom range field had only an example placeholder ("e.g. 1–4, 7"),
  // so a screen reader announced the example as the field's name, or nothing
  // once the field held a value.
  test("the custom range field is named for what it holds", () => {
    const view = render(
      <ExportPagesSection
        range="range"
        onRangeChange={() => undefined}
        customRange="1-4, 7"
        onCustomRangeChange={() => undefined}
        pageCount={10}
        currentPage={1}
      />,
    );
    const field = view.getByRole("textbox", { name: i18n.t("export.range.custom") });
    expect((field as HTMLInputElement).value).toBe("1-4, 7");
  });
});
