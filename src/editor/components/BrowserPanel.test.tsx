import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { useAppStore } from "../store/store";
import { BrowserPanel } from "./BrowserPanel";

const initialSnapshot = useAppStore.getState();

describe("BrowserPanel", () => {
  beforeEach(async () => {
    cleanup();
    useAppStore.setState(initialSnapshot, true);
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState(initialSnapshot, true);
  });

  test("the address field is named for what it holds, not by its hint", () => {
    const view = render(<BrowserPanel active={false} obscured={false} />);
    expect(view.getByRole("textbox", { name: "Address" })).toBeTruthy();
  });
});
