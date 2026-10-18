import { describe, expect, test } from "bun:test";
import {
  createMergePicker,
  type MergePickerNotice,
  type MergePickerPorts,
} from "./mergePicker";
import type { PageMergeRequest } from "./pageMerge";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(overrides: Partial<MergePickerPorts> = {}) {
  const requests: PageMergeRequest[] = [];
  const inserted: string[] = [];
  const busy: boolean[] = [];
  const notices: MergePickerNotice[] = [];
  const due: (() => void)[] = [];
  const clicks: string[] = [];
  const ports: MergePickerPorts = {
    begin: (request) => {
      requests.push(request);
      return async (_bytes, name) => {
        inserted.push(`${name}→${request.placement.kind === "after" ? request.placement.pageId : "end"}`);
        return true;
      };
    },
    lastPageId: () => "last",
    pickNative: null,
    pickWeb: null,
    clickInput: () => clicks.push("input"),
    timers: {
      set: (run) => due.push(run),
      clear: (handle) => {
        due[handle - 1] = () => {};
      },
    },
    setBusy: (on) => busy.push(on),
    notify: (notice) => notices.push(notice),
    ...overrides,
  };
  return { picker: createMergePicker(ports), requests, inserted, busy, notices, due, clicks };
}

const pdfFile = (name = "scan.pdf") => new File([new Uint8Array([1, 2])], name);

describe("inserting pages from a picked PDF", () => {
  test("pages land after the page the reader chose, or the last page", async () => {
    const { picker, inserted } = setup({
      pickNative: async () => ({ bytes: new Uint8Array([1]), name: "scan.pdf" }),
    });

    await picker.pick("p2");
    await picker.pick(null);

    expect(inserted).toEqual(["scan.pdf→p2", "scan.pdf→last"]);
  });

  // The page and document are bound before the picker opens; the file input
  // answers later, and must insert where the reader asked.
  test("the file input inserts where the picker was opened for", async () => {
    const { picker, inserted, clicks } = setup();

    await picker.pick("p3");
    picker.fromInput(pdfFile());
    await Bun.sleep(0);

    expect(clicks).toEqual(["input"]);
    expect(inserted).toEqual(["scan.pdf→p3"]);
  });

  test("a second insert while one is running is ignored", async () => {
    const slow = deferred<boolean>();
    let calls = 0;
    const { picker } = setup({
      pickNative: async () => ({ bytes: new Uint8Array([1]), name: "a.pdf" }),
      begin: () => async () => {
        calls += 1;
        return slow.promise;
      },
    });

    const first = picker.pick("p1");
    await Bun.sleep(0);
    await picker.pick("p1");
    slow.resolve(true);
    await first;

    expect(calls).toBe(1);
  });

  test("a quick insert never shows as busy; a slow one does until it ends", async () => {
    const slow = deferred<boolean>();
    const { picker, busy, due } = setup({
      pickNative: async () => ({ bytes: new Uint8Array([1]), name: "a.pdf" }),
      begin: () => () => slow.promise,
    });

    const running = picker.pick("p1");
    await Bun.sleep(0);
    due.forEach((run) => run()); // the delay passes while it is still running
    slow.resolve(true);
    await running;

    expect(busy).toEqual([true, false]);

    const quick = setup({
      pickNative: async () => ({ bytes: new Uint8Array([1]), name: "b.pdf" }),
    });
    await quick.picker.pick("p1");
    quick.due.forEach((run) => run()); // the delay would pass only after it ended
    expect(quick.busy).toEqual([false]);
  });

  test("a file that is not a PDF is refused with its name", async () => {
    const { picker, inserted, notices } = setup();

    await picker.pick("p1");
    picker.fromInput(pdfFile("notes.md"));
    await Bun.sleep(0);

    expect(inserted).toEqual([]);
    expect(notices).toEqual([{ kind: "notPdf", name: "notes.md" }]);
  });
});
