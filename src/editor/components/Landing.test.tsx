import "../../test/setupDom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import {
  forgetRecent,
  getRecent,
  recordRecent,
  type RecentEntry,
} from "../recentDocs";
import { subscribe } from "../toast";
import { Landing } from "./Landing";

const defaultMatchMedia = window.matchMedia;

describe("Landing recent documents", () => {
  beforeEach(async () => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    installWebFilePicker();
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    delete (window as Window & { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });

  test("keeps a failed web recent visible and marks it as needing access", async () => {
    seedWebRecent();

    const view = renderLanding({
      onReopen: async () => false,
    });

    const row = await findRecentRow(view.container);
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
    });

    expect(await view.findByText("Needs access")).toBeTruthy();
    expect(findRecentRowSync(view.container)).toBeTruthy();
  });

  test("removes the row when App has removed the stale recent entry", async () => {
    const entry = seedWebRecent();

    const view = renderLanding({
      onReopen: async () => {
        forgetRecent(entry);
        return false;
      },
    });

    const row = await findRecentRow(view.container);
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(findRecentRowSync(view.container)).toBeNull();
    });
    // Scoping this to the rendered container avoids happy-dom's extremely
    // slow full accessibility/text walk over the illustration-heavy landing
    // page while still asserting that the empty state replaced the row.
    expect(view.container.textContent).toContain(
      "Nothing here yet. Open a document and it'll show up.",
    );
  });

  test("does not show web recents in browsers that cannot reopen them", async () => {
    seedWebRecent();
    delete (window as Window & { showOpenFilePicker?: unknown }).showOpenFilePicker;

    const view = renderLanding();

    expect(findRecentRowSync(view.container)).toBeNull();
    expect(
      view.getByText(
        "This browser cannot reopen recent documents automatically. Use Open file to pick the same file again — your annotations are saved on this device and come right back.",
      ),
    ).toBeTruthy();
  });

  test("shows an app-local Markdown recent on desktop and web", async () => {
    recordRecent({
      name: "notes.md",
      pages: 0,
      size: 128,
      kind: "markdown",
      cacheId: "working-notes",
      textPreview: "Latest local edits",
    });

    const view = renderLanding();
    await waitFor(() => {
      expect(view.container.querySelector('[aria-label="notes.md"]')).toBeTruthy();
    });
  });
});

describe("Landing responsive structure and controls", () => {
  beforeEach(async () => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    installWebFilePicker();
    installCompactViewport(false);
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: defaultMatchMedia,
    });
    delete (window as Window & { showOpenFilePicker?: unknown }).showOpenFilePicker;
  });

  test("keeps quote and footer as descendants of the recent scroll panel", () => {
    const view = renderLanding();
    const panel = requiredElement(
      view.container,
      "[data-landing-recent-panel]",
    );
    const metadata = requiredElement(
      view.container,
      "[data-landing-metadata]",
    );
    const quote = requiredElement(view.container, "[data-landing-quote]");
    const footer = requiredElement(view.container, "[data-landing-footer]");
    const hero = requiredElement(view.container, "[data-landing-hero]");

    expect(panel.contains(metadata)).toBe(true);
    expect(metadata.contains(quote)).toBe(true);
    expect(metadata.contains(footer)).toBe(true);
    expect(footer.style.position).toBe("");
    expect(panel.style.overflowY).toBe("auto");
    expect(hero.style.overflowY).toBe("auto");
  });

  test("uses safe-area padding and full touch targets in compact layouts", async () => {
    installCompactViewport(true);
    const view = renderLanding();
    const root = view.container.firstElementChild as HTMLElement;
    const panel = requiredElement(
      view.container,
      "[data-landing-recent-panel]",
    );
    const hero = requiredElement(view.container, "[data-landing-hero]");
    const footer = requiredElement(view.container, "[data-landing-footer]");
    const controls = Array.from(footer.querySelectorAll("button"));

    expect(root.style.overflowY).toBe("auto");
    expect(panel.style.overflowY).toBe("visible");
    expect(hero.dataset.landingSafeArea).toBe("top inline");
    expect(panel.dataset.landingSafeArea).toBe("inline bottom");
    expect(controls.length).toBeGreaterThanOrEqual(4);
    for (const control of controls) {
      const targetSize = Number.parseFloat(
        control.style.height || control.style.minHeight,
      );
      expect(targetSize).toBeGreaterThanOrEqual(44);
    }

    fireEvent.click(view.getByRole("button", { name: "Language" }));
    const languageItems = await view.findAllByRole("menuitemradio");
    for (const item of languageItems) {
      expect(Number.parseFloat(item.style.minHeight)).toBeGreaterThanOrEqual(44);
    }
  });

  test("moves through the language menu and restores its trigger on Escape", async () => {
    const view = renderLanding();
    const trigger = view.getByRole("button", { name: "Language" });
    fireEvent.click(trigger);

    const menu = await view.findByRole("menu", { name: "Language" });
    await waitFor(() => expect(document.activeElement?.textContent).toContain("English"));

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("简体中文");
    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(view.queryByRole("menu", { name: "Language" })).toBeNull();
  });

  test("lets Tab leave the language menu before closing it", async () => {
    const view = renderLanding();
    const trigger = view.getByRole("button", { name: "Language" });
    const nextAction = view.getByRole("button", {
      name: /\? for shortcuts/,
    });
    fireEvent.click(trigger);

    const menu = await view.findByRole("menu", { name: "Language" });
    const activeItem = view.getByRole("menuitemradio", { name: /English/ });
    await waitFor(() => expect(document.activeElement).toBe(activeItem));

    fireEvent.keyDown(menu, { key: "Tab" });
    expect(view.queryByRole("menu", { name: "Language" })).toBe(menu);
    fireEvent.blur(activeItem, { relatedTarget: nextAction });
    nextAction.focus();

    expect(view.queryByRole("menu", { name: "Language" })).toBeNull();
    expect(document.activeElement).toBe(nextAction);

    trigger.focus();
    fireEvent.click(trigger);
    const reopenedMenu = await view.findByRole("menu", { name: "Language" });
    const reopenedItem = view.getByRole("menuitemradio", { name: /English/ });
    await waitFor(() => expect(document.activeElement).toBe(reopenedItem));

    fireEvent.keyDown(reopenedMenu, { key: "Tab", shiftKey: true });
    expect(view.queryByRole("menu", { name: "Language" })).toBe(reopenedMenu);
    fireEvent.blur(reopenedItem, { relatedTarget: trigger });
    trigger.focus();

    expect(view.queryByRole("menu", { name: "Language" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("closes the open language menu when its trigger is clicked again", async () => {
    const view = renderLanding();
    const trigger = view.getByRole("button", { name: "Language" });
    fireEvent.click(trigger);
    const activeItem = await view.findByRole("menuitemradio", {
      name: /English/,
    });
    await waitFor(() => expect(document.activeElement).toBe(activeItem));

    fireEvent.pointerDown(trigger);
    trigger.focus();
    fireEvent.pointerUp(trigger);
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(view.queryByRole("menu", { name: "Language" })).toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
  });
});

function renderLanding({
  onReopen = async () => true,
}: {
  onReopen?: (entry: RecentEntry) => Promise<boolean>;
} = {}) {
  return render(
    <Landing
      onOpen={() => undefined}
      onReopen={onReopen}
      onOpenChangelog={() => undefined}
    />,
  );
}

function seedWebRecent(): RecentEntry {
  recordRecent({
    name: "paper.pdf",
    pages: 12,
    size: 2048,
    hash: "hash-paper",
    webFileHandleId: "handle-paper",
  });
  const entry = getRecent()[0];
  if (!entry) throw new Error("recent entry expected");
  return entry;
}

function installWebFilePicker(): void {
  Object.defineProperty(window, "showOpenFilePicker", {
    configurable: true,
    value: async () => [],
  });
}

function installCompactViewport(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: matches && query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
}

function requiredElement(container: HTMLElement, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Expected ${selector}`);
  return element;
}

async function findRecentRow(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => {
    expect(findRecentRowSync(container)).toBeTruthy();
  });
  return findRecentRowSync(container)!;
}

function findRecentRowSync(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[aria-label="paper.pdf"]');
}

describe("Landing drop handling", () => {
  beforeEach(async () => {
    cleanup();
    await i18n.changeLanguage("en");
  });

  afterEach(() => cleanup());

  function dropOn(
    view: ReturnType<typeof render>,
    init: { files?: File[]; folderNames?: string[] },
  ) {
    const files = init.files ?? [];
    const items = [
      ...files.map((file) => ({
        kind: "file" as const,
        webkitGetAsEntry: () => ({ isDirectory: false }),
        getAsFile: () => file,
      })),
      ...(init.folderNames ?? []).map(() => ({
        kind: "file" as const,
        webkitGetAsEntry: () => ({ isDirectory: true }),
        getAsFile: () => null,
      })),
    ];
    const surface = view.container.firstElementChild as HTMLElement;
    fireEvent.drop(surface, { dataTransfer: { files, items } });
  }

  test("explains a dropped folder instead of doing nothing", async () => {
    // A folder arrives as an entry with no file behind it, so the open loop
    // silently did nothing: no page, no error, no explanation. The string
    // for this existed and had never been rendered.
    const seen: string[] = [];
    const stop = subscribe((items) => {
      for (const item of items) {
        if (typeof item.message === "string") seen.push(item.message);
      }
    });
    try {
      const view = render(
        <Landing
          onOpen={() => undefined}
          onReopen={() => undefined}
          onOpenChangelog={() => undefined}
        />,
      );

      dropOn(view, { folderNames: ["notes"] });

      await waitFor(() => {
        expect(seen).toContain("Opening a folder needs the desktop app.");
      });
    } finally {
      stop();
    }
  });

  test("one unreadable file does not abandon the rest of the drop", async () => {
    const opened: string[] = [];
    const view = render(
      <Landing
        onOpen={async (file: File) => {
          if (file.name === "broken.pdf") throw new Error("unreadable");
          opened.push(file.name);
        }}
        onReopen={() => undefined}
        onOpenChangelog={() => undefined}
      />,
    );

    dropOn(view, {
      files: [
        new File(["a"], "first.pdf", { type: "application/pdf" }),
        new File(["b"], "broken.pdf", { type: "application/pdf" }),
        new File(["c"], "third.pdf", { type: "application/pdf" }),
      ],
    });

    await waitFor(() => expect(opened).toEqual(["first.pdf", "third.pdf"]));
  });
});
