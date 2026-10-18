import { describe, expect, test } from "bun:test";
import { createWasmCoreBridge } from "./coreClient";
import type { CoreWorkerReply, CoreWorkerRequest } from "./protocol";

/** A stand-in worker that records messages and answers when told to. */
function fakeWorker() {
  const sent: Array<{ message: CoreWorkerRequest; transfer: Transferable[] }> = [];
  const worker = {
    onmessage: null as ((event: MessageEvent<CoreWorkerReply>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage(message: CoreWorkerRequest, transfer: Transferable[] = []) {
      sent.push({ message, transfer });
    },
  };
  const answer = (reply: CoreWorkerReply) => worker.onmessage?.({ data: reply } as MessageEvent<CoreWorkerReply>);
  let started = 0;
  const start = () => {
    started += 1;
    return worker as unknown as Worker;
  };
  return { sent, answer, start, crash: (message: string) => worker.onerror?.({ message } as ErrorEvent), started: () => started };
}

const request = { rotation: 0, pixelsPerPoint: 1, x: 0, y: 0, width: 1, height: 1 };

/** Fails fast instead of hanging when a promise never settles. */
const settled = <T>(promise: Promise<T>) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject("still pending"), 500))]);

describe("createWasmCoreBridge", () => {
  test("starts the worker on first use and answers each request by its id", async () => {
    const worker = fakeWorker();
    const bridge = createWasmCoreBridge(worker.start);
    expect(worker.started()).toBe(0);
    const outline = bridge.outline(1);
    const links = bridge.links(1, 3);
    const [first, second] = worker.sent.map((s) => s.message as { id: number });
    worker.answer({ kind: "reply", id: second!.id, ok: true, value: ["link"] });
    worker.answer({ kind: "reply", id: first!.id, ok: true, value: ["outline"] });
    expect(await outline).toEqual(["outline"]);
    expect(await links).toEqual(["link"]);
    expect(worker.started()).toBe(1);
  });

  test("hands over a copy of the PDF, so the caller keeps its bytes", async () => {
    const worker = fakeWorker();
    const bridge = createWasmCoreBridge(worker.start);
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const opened = bridge.open(bytes);
    const { message, transfer } = worker.sent[0]!;
    // Transferring detaches the buffer; the caller's must survive that.
    structuredClone(transfer[0], { transfer: transfer as ArrayBuffer[] });
    expect([...bytes]).toEqual([37, 80, 68, 70]);
    worker.answer({ kind: "reply", id: (message as { id: number }).id, ok: true, value: 4 });
    expect(await opened).toBe(4);
  });

  test("renders come back as pixels; a cancelled one rejects as cancelled", async () => {
    const worker = fakeWorker();
    const bridge = createWasmCoreBridge(worker.start);
    const drawn = bridge.render(1, 0, request, "thumbnail", 7);
    const skipped = bridge.render(1, 0, request, "visible", 8);
    bridge.cancel([8]);
    const [a, b, cancel] = worker.sent.map((s) => s.message);
    expect([a, b].map((m) => (m as { priority: number }).priority)).toEqual([2, 0]);
    expect(cancel).toEqual({ kind: "cancel", tickets: [8] });
    worker.answer({ kind: "reply", id: (a as { id: number }).id, ok: true, value: new Uint8Array([1, 2, 3, 4]).buffer });
    worker.answer({ kind: "reply", id: (b as { id: number }).id, ok: false, error: "cancelled" });
    expect([...(await drawn)]).toEqual([1, 2, 3, 4]);
    await expect(skipped).rejects.toBe("cancelled");
  });

  test("a worker that dies fails what is pending and everything after", async () => {
    const worker = fakeWorker();
    const bridge = createWasmCoreBridge(worker.start);
    const pending = bridge.pageText(1, 0);
    worker.crash("out of memory");
    await expect(settled(pending)).rejects.toContain("out of memory");
    await expect(settled(bridge.outline(1))).rejects.toContain("out of memory");
  });
});
