import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import { subscribe, toast, type ToastItem } from "../toast";
import { ToastHost } from "./ToastHost";
import { Modal } from "./ui";

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

function insideInert(node: Element): boolean {
  for (let el: Element | null = node; el; el = el.parentElement) {
    if ((el as HTMLElement).inert) return true;
  }
  return false;
}

describe("ToastHost above an open dialog", () => {
  // Modal marks everything outside itself inert, and the toast host renders
  // beside the dialogs. A toast fired while the Shortcuts sheet or Export is
  // open painted above the backdrop but was silent to screen readers and
  // ignored clicks on its close and action buttons.
  test("stays announced and clickable while a Modal is open", () => {
    const view = render(
      <>
        <Modal title="Export" onClose={() => undefined}>
          body
        </Modal>
        <ToastHost />
      </>,
    );
    act(() => {
      toast.show("3 annotations added");
    });

    const status = view.getByRole("status");
    expect(status.textContent).toContain("3 annotations added");
    expect(insideInert(status)).toBe(false);
    const close = view
      .getAllByRole("button", { name: "Close" })
      .find((button) => !button.closest("[role=dialog]"));
    expect(close).toBeTruthy();
    expect(insideInert(close!)).toBe(false);
  });
});
