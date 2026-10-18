import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { CAPABILITIES } from "../../platform";
import { LeftNavigator } from "./LeftNavigator";

describe("LeftNavigator add control", () => {
  beforeEach(async () => {
    cleanup();
    document.body.replaceChildren();
    await i18n.changeLanguage("en");
  });

  afterEach(() => cleanup());

  test("opens the unified target picker without a type menu", () => {
    let targetPicks = 0;
    const view = render(
      <LeftNavigator
        view="documents"
        onViewChange={() => undefined}
        onPickView={() => undefined}
        hasPdf={false}
        width={260}
        onWidthChange={() => undefined}
        items={[]}
        activeTabId={null}
        anchors={[]}
        onSelect={() => undefined}
        onClose={() => undefined}
        onTogglePin={() => undefined}
        onOpenAnchor={() => undefined}
        folderPaths={[]}
        onUnmountFolder={() => undefined}
        onOpenFolderFile={() => undefined}
        selectedIds={[]}
        onNew={() => {
          targetPicks += 1;
        }}
        doc={null}
        onInsertPdfPages={() => undefined}
      />,
    );

    // One control, no type menu — the app classifies the target, the reader
    // never does. The LABEL is platform-dependent though: only macOS can
    // return both kinds from one native dialog, so anywhere else the click
    // route is documents-only and must not promise folders it cannot open.
    const mixed = CAPABILITIES.mixedFileFolderPicker;
    const addButton = view.getByRole("button", {
      name: mixed ? "Add document or folder…" : "Add document…",
    });
    fireEvent.click(addButton);
    expect(targetPicks).toBe(1);
    expect(view.queryByRole("menu")).toBeNull();

    if (!mixed) {
      expect(view.queryByRole("button", { name: /folder/i })).toBeNull();
    }
  });

  test("keeps PDF-only views visible and disabled for a DOCX", () => {
    const viewPicks: string[] = [];
    const view = render(
      <LeftNavigator
        view="documents"
        onViewChange={() => undefined}
        onPickView={(next) => viewPicks.push(next)}
        hasPdf={false}
        width={260}
        onWidthChange={() => undefined}
        items={[]}
        activeTabId={null}
        anchors={[]}
        onSelect={() => undefined}
        onClose={() => undefined}
        onTogglePin={() => undefined}
        onOpenAnchor={() => undefined}
        folderPaths={[]}
        onUnmountFolder={() => undefined}
        onOpenFolderFile={() => undefined}
        selectedIds={[]}
        onNew={() => undefined}
        doc={null}
        onInsertPdfPages={() => undefined}
      />,
    );

    const documents = view.getByRole("button", { name: "Documents" });
    const outline = view.getByRole("button", { name: "Outline" });
    const pages = view.getByRole("button", { name: "Pages" });
    const marks = view.getByRole("button", { name: "Annotations" });

    expect(documents.hasAttribute("disabled")).toBe(false);
    expect(outline.hasAttribute("disabled")).toBe(true);
    expect(pages.hasAttribute("disabled")).toBe(true);
    expect(marks.hasAttribute("disabled")).toBe(true);

    fireEvent.click(outline);
    expect(viewPicks).toEqual([]);
  });
});
