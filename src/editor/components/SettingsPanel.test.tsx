import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  IDBKeyRange as FakeIDBKeyRange,
  indexedDB as fakeIndexedDB,
} from "fake-indexeddb";
import Dexie from "dexie";
import i18n from "../../i18n";

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
});
