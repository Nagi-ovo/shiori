import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { subscribe, toast, type ToastItem } from "../toast";
import { ToastHost } from "./ToastHost";

function visibleToasts(): ToastItem[] {
  let latest: ToastItem[] = [];
  subscribe((items) => {
    latest = items;
  })();
  return latest;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

// The toast bus is module state; other suites in the same run can leave
// cards behind.
function dismissAll(): void {
  for (const item of visibleToasts()) toast.dismiss(item.id);
}

beforeEach(dismissAll);

afterEach(() => {
  act(dismissAll);
  cleanup();
});

describe("ToastHost dismissal", () => {
  test("an error toast with an action closes without running the action", () => {
    let reselected = 0;
    const view = render(<ToastHost />);
    act(() => {
      toast.errorAction(
        "Couldn't restore tab",
        { label: "Choose file again", onClick: () => reselected++ },
        "README.md · The original file was moved or deleted",
      );
    });

    const close = view.getByRole("button", { name: "Close" });
    act(() => {
      fireEvent.click(close);
    });

    expect(view.queryByText("Couldn't restore tab")).toBeNull();
    expect(reselected).toBe(0);
  });

  test("a passive info toast can be closed before it times out", () => {
    const view = render(<ToastHost />);
    act(() => {
      toast.show("Copied");
    });

    act(() => {
      fireEvent.click(view.getByRole("button", { name: "Close" }));
    });

    expect(view.queryByText("Copied")).toBeNull();
  });

  test("each toast offers exactly one close control", () => {
    const view = render(<ToastHost />);
    act(() => {
      toast.error("Couldn't open file");
      toast.show("Saved");
    });

    expect(view.getAllByRole("button", { name: "Close" })).toHaveLength(2);
  });
});
