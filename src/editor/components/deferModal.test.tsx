import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ComponentType } from "react";
import i18n from "../../i18n";
import { deferModal } from "./deferModal";

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

/** A loader the test settles by hand. */
function manualLoader() {
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
    resolve: () => act(async () => { resolve(Real); await Promise.resolve(); }),
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
});
