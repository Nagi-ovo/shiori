import "../../test/setupDom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { subscribe, toast, type ToastItem } from "../toast";
import { useAppStore, type PrefsExternalTerminalId } from "../store/store";
import { ExternalTerminalLauncher } from "./ExternalTerminalLauncher";
import type { ExternalTerminalApp } from "./externalTerminalLauncherModel";

const initialSnapshot = useAppStore.getState();
const pngIcon =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const ghostty: ExternalTerminalApp = {
  id: "ghostty",
  name: "Ghostty",
  iconDataUrl: pngIcon,
};
const wezterm: ExternalTerminalApp = { id: "wezterm", name: "WezTerm" };
const iterm2: ExternalTerminalApp = { id: "iterm2", name: "iTerm2" };

describe("ExternalTerminalLauncher", () => {
  beforeEach(async () => {
    cleanup();
    document.body.replaceChildren();
    localStorage.clear();
    useAppStore.setState(initialSnapshot, true);
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    dismissAllToasts();
    document.body.replaceChildren();
    useAppStore.setState(initialSnapshot, true);
  });

  test("shows only terminals returned by discovery", async () => {
    const view = renderLauncher({ terminals: [ghostty, wezterm] });
    const primary = await view.findByRole("button", { name: "Open in Ghostty" });

    expect(
      primary.querySelector(`img[src="${pngIcon}"]`),
    ).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Choose external terminal" }));

    expect(view.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
      "Ghostty",
      "WezTerm",
    ]);
    expect(view.queryByText("iTerm2")).toBeNull();
  });

  test("falls back to the generic glyph when an official icon cannot load", async () => {
    const view = renderLauncher({ terminals: [ghostty] });
    const primary = await view.findByRole("button", { name: "Open in Ghostty" });
    const officialIcon = primary.querySelector("img");

    expect(officialIcon).toBeTruthy();
    fireEvent.error(officialIcon!);

    expect(primary.querySelector("img")).toBeNull();
    expect(primary.querySelector("svg")).toBeTruthy();
  });

  test("opens the saved preference from the primary button", async () => {
    setPreferred("wezterm");
    const opened: Array<[PrefsExternalTerminalId, string | null | undefined]> = [];
    const view = renderLauncher({
      terminals: [ghostty, wezterm],
      onOpen: async (id, workingDirectory) => {
        opened.push([id, workingDirectory]);
      },
    });

    fireEvent.click(await view.findByRole("button", { name: "Open in WezTerm" }));

    await waitFor(() => {
      expect(opened).toEqual([["wezterm", "/work/paper"]]);
    });
  });

  test("coalesces rapid primary activations into one launch", async () => {
    let releaseOpen = () => undefined;
    const pendingOpen = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let openCalls = 0;
    const view = renderLauncher({
      terminals: [ghostty],
      onOpen: async () => {
        openCalls += 1;
        await pendingOpen;
      },
    });
    const primary = await view.findByRole("button", { name: "Open in Ghostty" });

    act(() => {
      primary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      primary.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(openCalls).toBe(1);
    releaseOpen();
    await waitFor(() => expect(primary.getAttribute("aria-busy")).toBe("false"));
  });

  test("falls back to the first available app when the saved app is missing", async () => {
    setPreferred("iterm2");
    const opened: PrefsExternalTerminalId[] = [];
    const view = renderLauncher({
      terminals: [ghostty, wezterm],
      onOpen: async (id) => {
        opened.push(id);
      },
    });

    fireEvent.click(await view.findByRole("button", { name: "Open in Ghostty" }));

    await waitFor(() => expect(opened).toEqual(["ghostty"]));
    expect(useAppStore.getState().prefs.preferredExternalTerminalId).toBe("ghostty");
  });

  test("opens a menu choice and remembers it", async () => {
    const opened: PrefsExternalTerminalId[] = [];
    const view = renderLauncher({
      terminals: [ghostty, wezterm, iterm2],
      onOpen: async (id) => {
        opened.push(id);
      },
    });
    await view.findByRole("button", { name: "Open in Ghostty" });

    fireEvent.click(view.getByRole("button", { name: "Choose external terminal" }));
    fireEvent.click(view.getByRole("menuitemradio", { name: "WezTerm" }));

    await waitFor(() => {
      expect(opened).toEqual(["wezterm"]);
      expect(useAppStore.getState().prefs.preferredExternalTerminalId).toBe("wezterm");
    });
    expect(view.queryByRole("menu")).toBeNull();
  });

  test("closes on Escape and outside pointer input", async () => {
    const view = renderLauncher({ terminals: [ghostty, wezterm] });
    const chooser = await view.findByRole("button", {
      name: "Choose external terminal",
    });

    fireEvent.click(chooser);
    expect(view.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(chooser);

    fireEvent.click(chooser);
    expect(view.getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(view.queryByRole("menu")).toBeNull();
  });

  test("supports arrow-key entry and menu navigation", async () => {
    const view = renderLauncher({ terminals: [ghostty, wezterm] });
    const chooser = await view.findByRole("button", {
      name: "Choose external terminal",
    });

    chooser.focus();
    fireEvent.keyDown(chooser, { key: "ArrowDown" });
    const items = view.getAllByRole("menuitemradio");
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);

    expect(items.every((item) => (item as HTMLButtonElement).tabIndex === -1)).toBe(true);
    fireEvent.keyDown(items[0]!, { key: "Tab" });
    expect(view.queryByRole("menu")).toBeNull();
  });

  test("reports launch failures without changing the preference", async () => {
    setPreferred("ghostty");
    const toasts = observeToasts();
    const view = renderLauncher({
      terminals: [ghostty],
      onOpen: async () => {
        throw new Error("application vanished");
      },
    });

    fireEvent.click(await view.findByRole("button", { name: "Open in Ghostty" }));

    await waitFor(() => {
      expect(toasts.current.at(-1)).toMatchObject({
        message: "Couldn't open in Ghostty",
        detail: "Check that the app is still installed, then try again.",
        tone: "error",
      });
    });
    expect(useAppStore.getState().prefs.preferredExternalTerminalId).toBe("ghostty");
    toasts.unsubscribe();
  });

  test("keeps the chooser useful when no supported app is installed", async () => {
    const view = renderLauncher({ terminals: [] });
    const primary = await view.findByRole("button", {
      name: "No supported external terminal is installed.",
    });
    expect((primary as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(view.getByRole("button", { name: "Choose external terminal" }));
    expect(view.getByRole("status").textContent).toBe(
      "No supported external terminal is installed.",
    );
    expect(view.getByRole("menuitem", { name: "Try again" })).toBeTruthy();
  });
});

function renderLauncher({
  terminals,
  onOpen = async () => undefined,
}: {
  terminals: ExternalTerminalApp[];
  onOpen?: (
    id: PrefsExternalTerminalId,
    workingDirectory?: string | null,
  ) => Promise<void>;
}) {
  return render(
    <ExternalTerminalLauncher
      workingDirectory="/work/paper"
      listTerminals={async () => terminals}
      openTerminal={onOpen}
    />,
  );
}

function setPreferred(id: PrefsExternalTerminalId | null) {
  useAppStore.setState((state) => ({
    prefs: { ...state.prefs, preferredExternalTerminalId: id },
  }));
}

function observeToasts(): {
  current: ToastItem[];
  unsubscribe: () => void;
} {
  const observation = {
    current: [] as ToastItem[],
    unsubscribe: () => undefined,
  };
  observation.unsubscribe = subscribe((items) => {
    observation.current = items;
  });
  return observation;
}

function dismissAllToasts() {
  const observation = observeToasts();
  for (const item of observation.current) toast.dismiss(item.id);
  observation.unsubscribe();
}
