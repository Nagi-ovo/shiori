import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { useEscapeClose } from "./useEscapeClose";

function EscapeTarget({
  enabled = true,
  onClose,
}: {
  enabled?: boolean;
  onClose: () => void;
}) {
  useEscapeClose(enabled, onClose);
  return null;
}

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

afterEach(() => cleanup());

describe("useEscapeClose", () => {
  test("stops Escape reaching app-level keydown listeners", () => {
    // Canvas listens for Escape on window and disarms the active drawing
    // tool. Overlays that rolled their own listener typically only called
    // preventDefault, which Canvas does not check — so dismissing a context
    // menu also disarmed the highlighter: press `h`, open the menu, press
    // Escape, and the next drag selected text instead. This hook has to
    // swallow the event outright, which is why menus route through it.
    const appLevel = mock(() => undefined);
    window.addEventListener("keydown", appLevel);
    try {
      const close = mock(() => undefined);
      render(<EscapeTarget onClose={close} />);

      pressEscape();

      expect(close).toHaveBeenCalledTimes(1);
      expect(appLevel).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", appLevel);
    }
  });

  test("only closes the topmost active overlay", () => {
    const lower = mock(() => undefined);
    const upper = mock(() => undefined);
    const view = render(
      <>
        <EscapeTarget onClose={lower} />
        <EscapeTarget onClose={upper} />
      </>,
    );

    const first = pressEscape();
    expect(first.defaultPrevented).toBe(true);
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();

    view.rerender(<EscapeTarget onClose={lower} />);
    pressEscape();
    expect(lower).toHaveBeenCalledTimes(1);
  });

  test("does not consume Escape when disabled", () => {
    const close = mock(() => undefined);
    render(<EscapeTarget enabled={false} onClose={close} />);

    const event = pressEscape();
    expect(event.defaultPrevented).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });
});
