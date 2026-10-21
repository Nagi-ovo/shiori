import { describe, expect, spyOn, test } from "bun:test";
import type { WriteBackResult } from "../../platform/writeBack";
import { sha256Hex } from "../../storage/hash";
import type { WorkspaceRuntimeTab } from "../types";
import { createWorkspaceStore } from "../workspaceStore";
import {
  createTextSources,
  type TextSourceNotice,
  type TextSourcePorts,
} from "./textSources";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const markdown = (overrides: Partial<WorkspaceRuntimeTab> = {}) =>
  ({
    id: "md",
    kind: "markdown",
    title: "notes.md",
    size: 5,
    text: "hello",
    status: "loaded",
    source: { type: "path", path: "/n/notes.md" },
    ...overrides,
  }) as WorkspaceRuntimeTab;

function setup(tab = markdown(), overrides: Partial<TextSourcePorts> = {}) {
  const store = createWorkspaceStore({ tabs: [tab], activeTabId: tab.id, folderPaths: [] });
  const due: (() => void)[] = [];
  const cache = new Map<string, string>();
  const removed: string[] = [];
  const notices: TextSourceNotice[] = [];
  const writes: string[] = [];
  let nextCache = 0;
  const ports: TextSourcePorts = {
    store,
    timers: {
      set: (run) => due.push(run),
      clear: (handle) => {
        due[handle - 1] = () => {};
      },
    },
    cache: {
      put: async (entry) => {
        const id = `copy-${++nextCache}`;
        cache.set(id, new TextDecoder("utf-8", { ignoreBOM: true }).decode(entry.bytes));
        return id;
      },
      remove: (id) => removed.push(id),
      removeIfUnreferenced: (id) => removed.push(id),
    },
    persistMetadata: () => true,
    writeBack: {
      target: (source) =>
        source.type === "path" ? { kind: "desktopPath", path: source.path } : null,
      write: async (_target, text) => {
        writes.push(text);
        return { status: "written" };
      },
      saveAs: async () => ({ status: "saved", path: "~/Downloads/notes.md", platform: "web" }),
      requiresOrigin: false,
    },
    notify: (notice) => notices.push(notice),
    onPendingChange: () => {},
    ...overrides,
  };
  const sources = createTextSources(ports);
  const tabNow = () => store.getState().tabs[0]!;
  /** Lets the debounce elapse. */
  const pause = async () => {
    const runs = due.splice(0);
    runs.forEach((run) => run());
    await Bun.sleep(0);
  };
  return { store, sources, cache, removed, notices, writes, tabNow, pause, due };
}

describe("text sources", () => {
  test("typing, then pausing, writes one working copy with the last text", async () => {
    const { sources, cache, tabNow, pause } = setup();

    sources.edit("md", "hello w");
    sources.edit("md", "hello wo");
    sources.edit("md", "hello world");
    await pause();

    expect([...cache.values()]).toEqual(["hello world"]);
    expect(tabNow()).toMatchObject({
      text: "hello world",
      textDirty: true,
      size: 11,
      workingCopyCacheId: "copy-1",
    });
  });

  test("keystrokes never encode the document; the pause encodes it once", async () => {
    // A 25 MB document costs ~15 ms to encode; per keystroke, typing stalls.
    const encode = spyOn(TextEncoder.prototype, "encode");
    const { sources, tabNow, pause } = setup(markdown({ text: "x".repeat(1024) }));

    for (let i = 0; i < 20; i += 1) sources.edit("md", `edit ${i}`);
    const duringTyping = encode.mock.calls.length;
    await pause();
    const afterPause = encode.mock.calls.length;
    encode.mockRestore();

    expect(duringTyping).toBe(0);
    expect(afterPause).toBe(1);
    expect(tabNow().text).toBe("edit 19");
  });

  test("closing or going home writes the pending copy without waiting", async () => {
    const { sources, cache } = setup();
    sources.edit("md", "hello there");

    await sources.flush("md");

    expect([...cache.values()]).toEqual(["hello there"]);
  });

  test("a slow copy of older text never replaces a newer one", async () => {
    const slow = deferred<void>();
    const removed: string[] = [];
    let puts = 0;
    const { sources, tabNow, pause } = setup(markdown(), {
      cache: {
        put: async () => {
          const id = `copy-${++puts}`;
          if (id === "copy-1") await slow.promise;
          return id;
        },
        remove: (id) => removed.push(id),
        removeIfUnreferenced: (id) => removed.push(id),
      },
    });

    sources.edit("md", "older");
    await pause(); // the older copy starts writing, slowly
    sources.edit("md", "newer");
    await sources.flush("md");
    slow.resolve();
    await Bun.sleep(5);

    expect(tabNow()).toMatchObject({ text: "newer", workingCopyCacheId: "copy-2" });
    expect(removed).toContain("copy-1");
  });

  test("a copy whose record cannot be saved is undone and kept for retry", async () => {
    const pendingStates: boolean[] = [];
    const { sources, tabNow, removed, pause } = setup(markdown({ workingCopyCacheId: "old" }), {
      persistMetadata: () => false,
      onPendingChange: (pending) => pendingStates.push(pending),
    });

    sources.edit("md", "hello again");
    await pause();

    expect(tabNow().workingCopyCacheId).toBe("old");
    expect(removed).toEqual(["copy-1"]);
    expect(pendingStates.at(-1)).toBe(true);
  });
});

describe("saving to the source file", () => {
  test("writes the text over the file and marks the document clean", async () => {
    const { sources, writes, tabNow, notices } = setup(markdown({ text: "edited", textDirty: true }));

    await sources.saveToSource("md");

    expect(writes).toEqual(["edited"]);
    expect(tabNow().textDirty).toBe(false);
    expect(notices).toEqual([{ kind: "saved", name: "/n/notes.md" }]);
  });

  test("two quick saves reach the file in the order they were asked for", async () => {
    const first = deferred<WriteBackResult>();
    const written: string[] = [];
    const { sources, store } = setup(markdown({ text: "one", textDirty: true }), {
      writeBack: {
        target: (source) =>
          source.type === "path" ? { kind: "desktopPath", path: source.path } : null,
        write: async (_target, text) => {
          if (written.length === 0 && text === "one") await first.promise;
          written.push(text);
          return { status: "written" };
        },
        saveAs: async () => ({ status: "cancelled" }),
        requiresOrigin: false,
      },
    });

    const saveOne = sources.saveToSource("md");
    store.getState().updateTab("md", (tab) => ({ ...tab, text: "two", textDirty: true }));
    const saveTwo = sources.saveToSource("md");
    first.resolve({ status: "written" });
    await Promise.all([saveOne, saveTwo]);

    expect(written).toEqual(["one", "two"]);
    expect(store.getState().tabs[0]).toMatchObject({ text: "two", textDirty: false });
  });

  test("a document that was not UTF-8 is never written over its file", async () => {
    const { sources, writes, tabNow, notices } = setup(
      markdown({ text: "\uFFFD\uFFFD edited", textDirty: true, textLossy: true }),
    );

    await sources.saveToSource("md");

    expect(writes).toEqual([]);
    expect(tabNow().textDirty).toBe(true);
    expect(notices).toEqual([{ kind: "saveEncodingUnsupported", title: "notes.md" }]);
  });

  test("a file that began with a byte order mark keeps it, in the copy and on disk", async () => {
    const { sources, cache, writes, pause } = setup(markdown({ text: "hello", textBom: true }));

    sources.edit("md", "hello world");
    await pause();
    await sources.saveToSource("md");

    expect([...cache.values()]).toEqual(["\uFEFFhello world"]);
    expect(writes).toEqual(["\uFEFFhello world"]);
  });

  test("a file changed on disk since it was opened is only overwritten when the reader says so", async () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    let disk = encode("hello");
    const writes: string[] = [];
    const { sources, notices, tabNow, store } = setup(
      markdown({ text: "hello mine", textDirty: true, sourceHash: await sha256Hex(disk) }),
      {
        writeBack: {
          target: (source) =>
            source.type === "path" ? { kind: "desktopPath", path: source.path } : null,
          write: async (_target, text, unchanged) => {
            if (unchanged && !(await unchanged(disk))) return { status: "changed" };
            writes.push(text);
            disk = encode(text);
            return { status: "written" };
          },
          saveAs: async () => ({ status: "cancelled" }),
          requiresOrigin: true,
        },
      },
    );

    // Saving twice in a row compares against what the first save wrote.
    await sources.saveToSource("md");
    store.getState().updateTab("md", (tab) => ({ ...tab, text: "hello mine 2", textDirty: true }));
    await sources.saveToSource("md");
    expect(writes).toEqual(["hello mine", "hello mine 2"]);

    disk = encode("theirs, from git pull");
    store.getState().updateTab("md", (tab) => ({ ...tab, text: "hello mine 3", textDirty: true }));
    await sources.saveToSource("md");

    expect(writes).toHaveLength(2);
    expect(tabNow().textDirty).toBe(true);
    const conflict = notices.at(-1);
    expect(conflict).toMatchObject({ kind: "saveSourceChanged", title: "notes.md" });

    await (conflict as Extract<TextSourceNotice, { kind: "saveSourceChanged" }>).overwrite();

    expect(writes.at(-1)).toBe("hello mine 3");
    expect(tabNow().textDirty).toBe(false);
  });

  test("a file whose opened version is unknown is only overwritten when the reader says so", async () => {
    // A restore of unsaved edits never read its file, so there is no hash to
    // compare: the file may hold a newer version from another program.
    const writes: string[] = [];
    const { sources, notices, tabNow } = setup(markdown({ text: "restored edits", textDirty: true }), {
      writeBack: {
        target: (source) =>
          source.type === "path" ? { kind: "desktopPath", path: source.path } : null,
        write: async (_target, text, unchanged) => {
          if (unchanged && !(await unchanged(new TextEncoder().encode("theirs")))) {
            return { status: "changed" };
          }
          writes.push(text);
          return { status: "written" };
        },
        saveAs: async () => ({ status: "cancelled" }),
        requiresOrigin: true,
      },
    });

    await sources.saveToSource("md");

    expect(writes).toEqual([]);
    expect(tabNow().textDirty).toBe(true);
    const prompt = notices.at(-1);
    expect(prompt).toMatchObject({ kind: "saveSourceUnverified", title: "notes.md" });

    await (prompt as Extract<TextSourceNotice, { kind: "saveSourceUnverified" }>).overwrite();

    expect(writes).toEqual(["restored edits"]);
    expect(tabNow()).toMatchObject({
      textDirty: false,
      sourceHash: await sha256Hex(new TextEncoder().encode("restored edits")),
    });
  });

  test("a file the check could not read is not written, and the reader can overwrite it", async () => {
    const writes: string[] = [];
    const { sources, notices, tabNow } = setup(
      markdown({ text: "mine", textDirty: true, sourceHash: "opened" }),
      {
        writeBack: {
          target: (source) =>
            source.type === "path" ? { kind: "desktopPath", path: source.path } : null,
          write: async (_target, text, unchanged) => {
            if (unchanged) return { status: "unverified" };
            writes.push(text);
            return { status: "written" };
          },
          saveAs: async () => ({ status: "cancelled" }),
          requiresOrigin: true,
        },
      },
    );

    await sources.saveToSource("md");

    expect(writes).toEqual([]);
    expect(tabNow().textDirty).toBe(true);
    const prompt = notices.at(-1);
    expect(prompt).toMatchObject({ kind: "saveSourceUnverified", title: "notes.md" });
    await (prompt as Extract<TextSourceNotice, { kind: "saveSourceUnverified" }>).overwrite();
    expect(writes).toEqual(["mine"]);
  });

  test("a clean document is not written", async () => {
    const { sources, writes, notices } = setup(markdown({ textDirty: false }));

    await sources.saveToSource("md");

    expect(writes).toEqual([]);
    expect(notices).toEqual([{ kind: "savedNoChanges" }]);
  });

  test("with nowhere to write, the web downloads and the desktop says so", async () => {
    const tab = markdown({ textDirty: true, source: { type: "cache", id: "c" } });
    const noOrigin = (requiresOrigin: boolean): TextSourcePorts["writeBack"] => ({
      target: () => null,
      write: async () => ({ status: "written" }),
      saveAs: async () => ({ status: "saved", path: "~/Downloads/notes.md", platform: "web" }),
      requiresOrigin,
    });
    const web = setup(tab, { writeBack: noOrigin(false) });
    const desktop = setup(tab, { writeBack: noOrigin(true) });

    await web.sources.saveToSource("md");
    await desktop.sources.saveToSource("md");

    expect(web.notices).toEqual([{ kind: "savedAs", path: "~/Downloads/notes.md" }]);
    expect(web.tabNow().textDirty).toBe(false);
    expect(desktop.notices).toEqual([{ kind: "saveOriginMissing", title: "notes.md" }]);
    expect(desktop.tabNow().textDirty).toBe(true);
  });
});
