import "../../test/setupDom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import type { WindowCaptionPorts } from "../../platform/windowCaption";
import { WindowCaption } from "./WindowCaption";

// How the Windows caption buttons can fail the reader:
// 1. a button does nothing, or the wrong window action (close must be the
//    guarded close, never destroy: unsaved work would vanish);
// 2. the middle button claims "Maximize" on a maximized window — at launch,
//    or after the state changed outside the button (Win+Up, snapping,
//    double-clicking the title bar);
// 3. the state query fails over IPC and takes the caption down with it;
// 4. the resize listener outlives the caption, including when unmount
//    races the subscription;
// 5. the buttons carry no accessible name.

type FakeWindow = WindowCaptionPorts & {
  calls: string[];
  maximized: boolean;
  resize: () => void;
  listeners: number;
};

function fakeWindow(
  options: { maximized?: boolean; slowSubscribe?: Promise<void>; failQuery?: boolean } = {},
): FakeWindow {
  const resizeHandlers = new Set<() => void>();
  const win: FakeWindow = {
    calls: [],
    maximized: options.maximized ?? false,
    listeners: 0,
    resize: () => {
      for (const run of resizeHandlers) run();
    },
    minimize: async () => {
      win.calls.push("minimize");
    },
    toggleMaximize: async () => {
      win.calls.push("toggleMaximize");
      win.maximized = !win.maximized;
      win.resize();
    },
    close: async () => {
      win.calls.push("close");
    },
    isMaximized: async () => {
      if (options.failQuery) throw new Error("ipc down");
      return win.maximized;
    },
    onResized: async (run) => {
      await options.slowSubscribe;
      resizeHandlers.add(run);
      win.listeners++;
      return () => {
        resizeHandlers.delete(run);
        win.listeners--;
      };
    },
  };
  return win;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(cleanup);

describe("WindowCaption", () => {
  test("each button runs its own window action, and close is the guarded close", async () => {
    const win = fakeWindow();
    const view = render(<WindowCaption ports={win} />);

    fireEvent.click(view.getByRole("button", { name: "Minimize" }));
    fireEvent.click(view.getByRole("button", { name: "Close" }));

    expect(win.calls).toEqual(["minimize", "close"]);
  });

  test("the middle button follows the window's maximized state", async () => {
    const win = fakeWindow();
    const view = render(<WindowCaption ports={win} />);
    await waitFor(() => expect(win.listeners).toBe(1));

    fireEvent.click(view.getByRole("button", { name: "Maximize" }));
    await waitFor(() => view.getByRole("button", { name: "Restore down" }));

    // Win+Up / snap / title-bar double-click change it without the button.
    win.maximized = false;
    act(() => win.resize());
    await waitFor(() => view.getByRole("button", { name: "Maximize" }));
    expect(win.calls).toEqual(["toggleMaximize"]);
  });

  test("a window that launches maximized offers Restore down", async () => {
    const view = render(<WindowCaption ports={fakeWindow({ maximized: true })} />);
    await waitFor(() => view.getByRole("button", { name: "Restore down" }));
  });

  test("a failed state query leaves working buttons", async () => {
    const win = fakeWindow({ failQuery: true });
    const view = render(<WindowCaption ports={win} />);
    await waitFor(() => expect(win.listeners).toBe(1));
    act(() => win.resize());

    fireEvent.click(view.getByRole("button", { name: "Maximize" }));
    expect(win.calls).toEqual(["toggleMaximize"]);
  });

  test("unmounting drops the resize listener, even mid-subscription", async () => {
    const settled = fakeWindow();
    const first = render(<WindowCaption ports={settled} />);
    await waitFor(() => expect(settled.listeners).toBe(1));
    first.unmount();
    expect(settled.listeners).toBe(0);

    let release!: () => void;
    const racing = fakeWindow({ slowSubscribe: new Promise((r) => (release = r)) });
    const second = render(<WindowCaption ports={racing} />);
    second.unmount();
    // The late dispose runs synchronously (safeUnlisten calls it inline), so
    // one macrotask after the release is enough to see a leak.
    await act(async () => release());
    await waitFor(() => expect(racing.listeners).toBe(0));
    // Stays detached once the late subscription has been handled.
    await new Promise((r) => setTimeout(r, 0));
    expect(racing.listeners).toBe(0);
  });
});
