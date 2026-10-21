import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ComponentType } from "react";
import i18n from "../../i18n";
import { deferModal } from "./deferModal";
import { Modal } from "./ui";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

type Props = { onClose: () => void; open?: boolean };

function Real({ onClose }: Props) {
  return (
    <div role="dialog" aria-label="real">
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  );
}

/** The real thing: a dialog on the Modal shell, which restores focus itself. */
function RealModal({ onClose }: Props) {
  return (
    <Modal title="real" onClose={onClose}>
      <button type="button" onClick={onClose}>
        close
      </button>
    </Modal>
  );
}

/** A loader the test settles by hand. */
function manualLoader(component: ComponentType<Props> = Real) {
  let resolve!: (c: ComponentType<Props>) => void;
  let reject!: (e: unknown) => void;
  let calls = 0;
  const load = () => {
    calls += 1;
    return new Promise<ComponentType<Props>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  };
  return {
    load,
    calls: () => calls,
    resolve: () => act(async () => { resolve(component); await Promise.resolve(); }),
    reject: () => act(async () => { reject(new Error("chunk")); await Promise.resolve(); }),
  };
}

describe("deferModal", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  test("renders nothing until the code arrives, then the real modal", async () => {
    const loader = manualLoader();
    const Deferred = deferModal<Props>(loader.load);
    const view = render(<Deferred onClose={() => undefined} />);
    expect(view.container.textContent).toBe("");
    expect(loader.calls()).toBe(1);
    await loader.resolve();
    expect(view.getByRole("dialog", { name: "real" })).toBeTruthy();
  });

  test("does not load while closed", async () => {
    const loader = manualLoader();
    const Deferred = deferModal<Props>(loader.load, (p) => p.open === true);
    const view = render(<Deferred open={false} onClose={() => undefined} />);
    expect(loader.calls()).toBe(0);
    view.rerender(<Deferred open onClose={() => undefined} />);
    expect(loader.calls()).toBe(1);
    await loader.resolve();
    expect(view.getByRole("dialog", { name: "real" })).toBeTruthy();
  });

  // React.lazy caches a rejected import forever; this wrapper must offer a
  // way back, and closing the failure must still go through onClose.
  test("a failed load can be retried or closed", async () => {
    const loader = manualLoader();
    const Deferred = deferModal<Props>(loader.load);
    let closed = 0;
    const view = render(<Deferred onClose={() => { closed += 1; }} />);
    await loader.reject();
    expect(view.container.textContent).toContain(i18n.t("deferred.failedTitle"));
    fireEvent.click(view.getByRole("button", { name: i18n.t("deferred.retry") }));
    expect(loader.calls()).toBe(2);
    await loader.resolve();
    expect(view.getByRole("dialog", { name: "real" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "close" }));
    expect(closed).toBe(1);
  });

  test("loads once per session across mounts", async () => {
    const loader = manualLoader();
    const Deferred = deferModal<Props>(loader.load);
    const first = render(<Deferred onClose={() => undefined} />);
    await loader.resolve();
    first.unmount();
    const second = render(<Deferred onClose={() => undefined} />);
    expect(second.getByRole("dialog", { name: "real" })).toBeTruthy();
    expect(loader.calls()).toBe(1);
  });

  // A cold chunk on the web build shows the loading notice after 400 ms. The
  // notice's panel held focus when the real dialog mounted and captured it as
  // the place to return to; the notice was gone by the time the dialog closed,
  // so focus fell to <body> instead of the button that opened it.
  for (const closeBy of ["open prop", "unmount"] as const) {
    test(`returns focus to the trigger after a slow load (closed by ${closeBy})`, async () => {
      const loader = manualLoader(RealModal);
      const Deferred = deferModal<Props>(loader.load, (p) => p.open === true);
      const ui = (open: boolean, mounted = true) => (
        <>
          <button type="button">open settings</button>
          {mounted ? <Deferred open={open} onClose={() => undefined} /> : null}
        </>
      );
      const view = render(ui(false));
      const trigger = view.getByRole("button", { name: "open settings" });
      trigger.focus();
      view.rerender(ui(true));
      await act(() => new Promise((resolve) => setTimeout(resolve, 450)));
      expect(view.getByRole("dialog", { name: i18n.t("deferred.loading") })).toBeTruthy();

      await loader.resolve();
      expect(view.getByRole("dialog", { name: "real" })).toBeTruthy();

      view.rerender(closeBy === "unmount" ? ui(true, false) : ui(false));
      await act(async () => undefined);
      expect(view.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  }
});
