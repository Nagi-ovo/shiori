import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import Dexie from "dexie";
import i18n from "../../i18n";
import type { WindowCaptionPorts } from "../../platform/windowCaption";
import { WindowCaption } from "./WindowCaption";

// The Storage section lists drafts through Dexie, which setupDom does not
// wire. Dexie reads these when the drafts module creates its database, so the
// panel is imported only after they are set.
Dexie.dependencies.indexedDB = fakeIndexedDB as unknown as IDBFactory;
Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange as unknown as typeof IDBKeyRange;
const { SettingsPanel } = await import("./SettingsPanel");

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// The page behind the panel: a sibling of Testing Library's container, the
// way the document, tab strip and toolbar sit beside the panel in the app.
function insideInert(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node instanceof HTMLElement && node.inert) return true;
  }
  return false;
}

const idleWindow: WindowCaptionPorts = {
  minimize: async () => undefined,
  toggleMaximize: async () => undefined,
  close: async () => undefined,
  isMaximized: async () => false,
  onResized: async () => () => undefined,
};

function mountBackground(): HTMLElement {
  const background = document.createElement("div");
  background.innerHTML = "<button>behind</button>";
  document.body.appendChild(background);
  return background;
}

describe("SettingsPanel", () => {
  // The panel says aria-modal="true" but only trapped Tab. A screen reader's
  // browse cursor or a touch swipe walked straight past its last control into
  // the document and toolbar behind the backdrop, and could activate them.
  test("takes the page behind it out of reach while open", () => {
    const background = mountBackground();
    const view = render(<SettingsPanel open onClose={() => undefined} />);
    expect(view.getByRole("dialog")).toBeTruthy();
    expect(background.inert).toBe(true);

    view.rerender(<SettingsPanel open={false} onClose={() => undefined} />);
    expect(background.inert).toBe(false);
  });

  // On Windows the caption buttons are the window's only minimize, maximize
  // and close, mounted beside the app (main.tsx) and painted above every
  // backdrop. Inerting them with the rest of the page left a window that
  // could not be closed or moved off-screen while Settings was open.
  test("leaves the window caption buttons live while open", () => {
    const view = render(
      <>
        <SettingsPanel open onClose={() => undefined} />
        <WindowCaption ports={idleWindow} />
      </>,
    );
    expect(view.getByRole("dialog")).toBeTruthy();
    for (const name of ["Minimize", "Maximize", "Close"]) {
      const button = view
        .getAllByRole("button", { name })
        .find((candidate) => candidate.classList.contains("shioriCaptionButton"));
      expect(button).toBeTruthy();
      expect(insideInert(button!)).toBe(false);
    }
  });
});
