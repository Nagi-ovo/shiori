import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useRef } from "react";
import { useFocusTrap } from "./useFocusTrap";

function Trap({ label, enabled = true }: { label: string; enabled?: boolean }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panelRef, enabled);
  return (
    <div ref={panelRef} data-shiori-modal-open="" tabIndex={-1}>
      <button data-testid={`${label}-first`}>{label} first</button>
      <button data-testid={`${label}-last`}>{label} last</button>
    </div>
  );
}

function pressTab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("useFocusTrap stacking", () => {
  test("single trap wraps Tab from last back to first", () => {
    const view = render(<Trap label="only" />);
    view.getByTestId("only-last").focus();

    const event = pressTab();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.getByTestId("only-first"));
  });

  test("only the top trap acts when two traps are mounted", () => {
    const view = render(
      <>
        <Trap label="lower" />
        <Trap label="upper" />
      </>,
    );
    // Tab in the middle of the upper panel must fall through to the
    // browser untouched. With both handlers live, the lower trap saw
    // focus outside its panel and hijacked the event.
    view.getByTestId("upper-first").focus();
    const passThrough = pressTab();
    expect(passThrough.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(view.getByTestId("upper-first"));

    // Wrapping still happens, and only within the upper panel.
    view.getByTestId("upper-last").focus();
    const wrapped = pressTab();
    expect(wrapped.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.getByTestId("upper-first"));
  });

  test("lower trap takes over when the top trap unmounts", () => {
    const view = render(
      <>
        <Trap label="lower" />
        <Trap label="upper" />
      </>,
    );
    // Keep the fragment shape so React unmounts only the upper trap.
    view.rerender(
      <>
        <Trap label="lower" />
      </>,
    );
    (document.activeElement as HTMLElement | null)?.blur();

    const event = pressTab();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.getByTestId("lower-first"));
  });

  test("top trap keeps working when a lower trap deactivates first", () => {
    const view = render(
      <>
        <Trap label="lower" />
        <Trap label="upper" />
      </>,
    );
    view.rerender(
      <>
        <Trap label="lower" enabled={false} />
        <Trap label="upper" />
      </>,
    );
    view.getByTestId("upper-last").focus();

    const event = pressTab();

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(view.getByTestId("upper-first"));
  });
});
