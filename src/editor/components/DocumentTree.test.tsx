import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { DocumentList } from "./DocumentTree";

describe("DocumentList folders", () => {
  beforeEach(async () => {
    cleanup();
    document.body.replaceChildren();
    await i18n.changeLanguage("en");
  });

  afterEach(() => cleanup());

  test("renders every mounted folder without a second add-folder control", () => {
    const view = render(
      <DocumentList
        items={[]}
        activeTabId={null}
        markCount={0}
        onSelect={() => undefined}
        onClose={() => undefined}
        onTogglePin={() => undefined}
        onShowMarks={() => undefined}
        folderPaths={["/Users/reader/benchmark", "/Users/reader/notes"]}
        onUnmountFolder={() => undefined}
        onOpenFolderFile={() => undefined}
      />,
    );

    expect(view.getByTitle("/Users/reader/benchmark")).toBeTruthy();
    expect(view.getByTitle("/Users/reader/notes")).toBeTruthy();
    expect(
      view.queryByRole("button", { name: "Add folder…" }),
    ).toBeNull();
  });

  test("closes only the selected folder", () => {
    const closed: string[] = [];
    const view = render(
      <DocumentList
        items={[]}
        activeTabId={null}
        markCount={0}
        onSelect={() => undefined}
        onClose={() => undefined}
        onTogglePin={() => undefined}
        onShowMarks={() => undefined}
        folderPaths={["/Users/reader/benchmark", "/Users/reader/notes"]}
        onUnmountFolder={(path) => closed.push(path)}
        onOpenFolderFile={() => undefined}
      />,
    );

    fireEvent.contextMenu(view.getByTitle("/Users/reader/notes"));
    fireEvent.click(view.getByRole("menuitem", { name: "Close this folder" }));
    expect(closed).toEqual(["/Users/reader/notes"]);
  });
});
