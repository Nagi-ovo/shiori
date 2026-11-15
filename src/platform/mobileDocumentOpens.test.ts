import "../test/setupDom";
import { afterEach, describe, expect, test } from "bun:test";
import { createMobileDocumentOpenQueue } from "./mobileDocumentOpens";
import type { MobileDocumentReference } from "./open";

type Bridge = NonNullable<Window["ShioriAndroid"]>;
type Delivery = { uri: string; name?: string; deliveryId: string };

const A = "content://files/a.pdf";
const B = "content://files/b.pdf";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const uriOf = (ref: MobileDocumentReference) =>
  typeof ref === "string" ? ref : ref.uri;

/**
 * The Android shell as the page sees it over the bridge: every drain returns
 * each delivery it still holds, an ack removes the acked ones
 * (PendingDocumentOpenQueue in PendingDocumentOpens.kt).
 */
function installShell() {
  let nextId = 1;
  const shell = {
    held: [] as Delivery[],
    ackFails: false,
    deliver(...uris: string[]) {
      for (const uri of uris) {
        shell.held.push({ uri, name: uri.split("/").pop(), deliveryId: String(nextId++) });
      }
    },
  };
  const bridge: Bridge = {
    drainPendingDocumentOpens: () => JSON.stringify(shell.held),
    ackPendingDocumentOpens: (raw) => {
      if (shell.ackFails) throw new Error("bridge gone");
      const ids = JSON.parse(raw) as string[];
      shell.held = shell.held.filter((d) => !ids.includes(d.deliveryId));
      return '{"ok":true}';
    },
  };
  Object.defineProperty(window, "ShioriAndroid", {
    configurable: true,
    writable: true,
    value: bridge,
  });
  return shell;
}

/** One page session's intake, recording what it opened into `opened`. */
function mountPage(
  opened: string[],
  wait?: (ref: MobileDocumentReference) => Promise<void> | undefined,
) {
  return createMobileDocumentOpenQueue({
    dedupeMs: 1500,
    open: async (ref) => {
      opened.push(uriOf(ref));
      await wait?.(ref);
    },
  });
}

describe("mobile document open queue (Android drain / ack)", () => {
  afterEach(() => {
    delete (window as { ShioriAndroid?: Bridge }).ShioriAndroid;
  });

  test("acks a delivery once its open starts, so later drains and reloads skip it", async () => {
    const shell = installShell();
    shell.deliver(A);
    const opened: string[] = [];
    const page = mountPage(opened);

    page.drainAndroidPending();
    await page.whenIdle();
    expect(opened).toEqual([A]);
    expect(shell.held).toEqual([]);

    page.drainAndroidPending();
    const reloaded = mountPage(opened);
    reloaded.drainAndroidPending();
    await page.whenIdle();
    await reloaded.whenIdle();
    expect(opened).toEqual([A]);
  });

  test("a page that reloads before acking gets its un-acked deliveries again", async () => {
    const shell = installShell();
    shell.deliver(A, B);
    const gate = deferred();
    const firstOpened: string[] = [];
    const first = mountPage(firstOpened, () => gate.promise);

    first.drainAndroidPending();
    await tick();
    // A has started (acked); B is still waiting behind it.
    expect(firstOpened).toEqual([A]);
    expect(shell.held.map((d) => d.uri)).toEqual([B]);

    // Reload: that page is gone mid-open; a new one mounts and drains.
    const reloadedOpened: string[] = [];
    const reloaded = mountPage(reloadedOpened);
    reloaded.drainAndroidPending();
    await reloaded.whenIdle();

    expect(reloadedOpened).toEqual([B]);
    expect(shell.held).toEqual([]);
  });

  test("a delivery whose ack never landed opens once per page, again after a reload", async () => {
    const shell = installShell();
    shell.ackFails = true;
    shell.deliver(A);
    const opened: string[] = [];
    const page = mountPage(opened);

    page.drainAndroidPending();
    await page.whenIdle();
    page.drainAndroidPending();
    await page.whenIdle();
    expect(opened).toEqual([A]);

    const reloaded = mountPage(opened);
    reloaded.drainAndroidPending();
    await reloaded.whenIdle();
    expect(opened).toEqual([A, A]);
  });

  test("the same delivery is not opened twice in one page session", async () => {
    const shell = installShell();
    shell.ackFails = true; // keep it coming back on every drain
    shell.deliver(A);
    let now = 10_000;
    const timers: Array<() => void> = [];
    const opened: string[] = [];
    const page = createMobileDocumentOpenQueue({
      dedupeMs: 1500,
      now: () => now,
      setTimer: (callback) => {
        timers.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      open: (ref) => {
        opened.push(uriOf(ref));
      },
    });

    page.drainAndroidPending(); // mount drain
    page.drainAndroidPending(); // "shiori-android-file-open" for the same enqueue
    const held = shell.held[0];
    if (held) page.enqueue(held); // an event carrying the same delivery
    await page.whenIdle();
    expect(opened).toEqual([A]);

    // Long past the URI dedupe window, the delivery is still the same one.
    now += 60_000;
    for (const callback of timers.splice(0)) callback();
    page.drainAndroidPending();
    await page.whenIdle();
    expect(opened).toEqual([A]);
  });

  test("a second delivery of the same URI opens again inside the dedupe window", async () => {
    const shell = installShell();
    const opened: string[] = [];
    const gate = deferred();
    const page = mountPage(opened, () => (opened.length === 1 ? gate.promise : undefined));

    // While the first is still opening…
    shell.deliver(A);
    page.drainAndroidPending();
    await tick();
    shell.deliver(A);
    page.drainAndroidPending();
    gate.resolve();
    await page.whenIdle();
    expect(opened).toEqual([A, A]);

    // …and right after it finished.
    shell.deliver(A);
    page.drainAndroidPending();
    await page.whenIdle();
    expect(opened).toEqual([A, A, A]);
    expect(shell.held).toEqual([]);
  });

  test("a remount opens what the unmounted intake had not started, once", async () => {
    const shell = installShell();
    shell.deliver(A, B);
    const gate = deferred();
    const opened: string[] = [];
    const first = mountPage(opened, (ref) => (uriOf(ref) === A ? gate.promise : undefined));

    first.drainAndroidPending();
    await tick();
    first.close();
    const remounted = mountPage(opened);
    remounted.drainAndroidPending();
    await remounted.whenIdle();
    gate.resolve();
    await first.whenIdle();

    expect(opened).toEqual([A, B]);
    expect(shell.held).toEqual([]);
  });

  test("references without a delivery id keep URI dedupe and still open after close", async () => {
    // iOS and the `file-open` event: no shell to re-deliver them.
    const opened: string[] = [];
    const gate = deferred();
    const page = mountPage(opened, () => (opened.length === 1 ? gate.promise : undefined));

    page.enqueue("file:///docs/x.pdf");
    page.enqueue("file:///docs/x.pdf");
    page.enqueue({ uri: "file:///docs/x.pdf" });
    page.enqueue("file:///docs/y.pdf");
    page.drainAndroidPending(); // no Android bridge: nothing to drain
    await tick();
    page.close();
    gate.resolve();
    await page.whenIdle();

    expect(opened).toEqual(["file:///docs/x.pdf", "file:///docs/y.pdf"]);
  });
});
