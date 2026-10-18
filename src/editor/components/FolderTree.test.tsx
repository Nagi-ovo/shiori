import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { FolderTree } from "./FolderTree";

describe("FolderTree context menu", () => {
  beforeEach(async () => {
    cleanup();
    document.body.replaceChildren();
    await i18n.changeLanguage("en");
  });

  afterEach(() => cleanup());

  test("clicking the menu item unmounts the folder", () => {
    // pointerdown fires before click. A window-level dismissal that did not
    // exempt the menu unmounted the item mid-gesture, so its onClick never
    // ran and the action was unreachable with a mouse or by touch.
    let unmounted = 0;
    const view = render(
      <FolderTree
        path="/Users/reader/papers"
        onOpenFile={() => undefined}
        onUnmount={() => {
          unmounted += 1;
        }}
      />,
    );
    fireEvent.click(view.getByTitle("/Users/reader/papers"));
    fireEvent.contextMenu(view.getByTitle("/Users/reader/papers"));
    const item = view.getByRole("menuitem");
    fireEvent.pointerDown(item);
    fireEvent.click(item);
    expect(unmounted).toBe(1);
  });

});
