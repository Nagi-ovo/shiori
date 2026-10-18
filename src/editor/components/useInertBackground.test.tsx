import "../../test/setupDom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useRef } from "react";
import { useInertBackground } from "./useInertBackground";

function Dialog({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useInertBackground(ref, enabled);
  return (
    <div ref={ref} data-testid="dialog">
      <button>inside</button>
    </div>
  );
}

// The hook walks up from the dialog to <body>, so the background has to be a
// real sibling chain rather than a detached fragment. Testing Library mounts
// into its own container, which would itself become the only sibling; mount the
// background beside that container instead.
function mountBackground(): HTMLElement {
  const background = document.createElement("div");
  background.setAttribute("data-testid", "background");
  background.innerHTML = "<button>behind</button>";
  document.body.appendChild(background);
  return background;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("useInertBackground", () => {
  test("marks siblings inert while mounted and clears them on unmount", () => {
    const background = mountBackground();
    expect(background.inert).toBe(false);

    const view = render(<Dialog />);
    expect(background.inert).toBe(true);
    // The dialog itself must stay reachable — inerting the whole page would
    // take the dialog down with it.
    expect(view.getByTestId("dialog").inert).toBe(false);

    view.unmount();
    expect(background.inert).toBe(false);
  });

  test("leaves the background alone when disabled", () => {
    const background = mountBackground();
    render(<Dialog enabled={false} />);
    expect(background.inert).toBe(false);
  });

  test("stacked dialogs unwind without releasing the outer one's marks", () => {
    const background = mountBackground();

    const outer = render(<Dialog />);
    expect(background.inert).toBe(true);

    const inner = render(<Dialog />);
    expect(background.inert).toBe(true);

    // Closing the inner dialog must not hand the page back while the outer
    // one is still open: the inner never marked `background` (it was already
    // inert), so it has nothing to restore there.
    inner.unmount();
    expect(background.inert).toBe(true);

    outer.unmount();
    expect(background.inert).toBe(false);
  });
});
