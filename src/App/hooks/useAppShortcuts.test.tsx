import "../../test/setupDom";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { useEditorStore } from "../../editor/store/store";
import i18n from "../../i18n";
import { useAppShortcuts } from "./useAppShortcuts";

/**
 * The paste handler binds the target document in phase 1 — synchronously,
 * while the reader's action is still on the stack — and only then decodes
 * the image and queues the merge.
 *
 * That ordering is the fix for a real bug: decoding and queueing take long
 * enough to switch tabs, so resolving the target afterwards dropped the
 * pasted page into whichever document the reader had moved to, and reported
 * success. Nothing but this test enforces it; moving the binder call inside
 * the async block would restore the bug silently.
 */
describe("pasting an image binds its target before awaiting", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    cleanup();
    useEditorStore.setState({
      opened: null,
      model: { pages: [], overlays: [] },
      overlayClipboard: [],
      activePageId: null,
    } as never);
  });

  function imagePasteEvent(onArrayBuffer: () => void): Event {
    const file = {
      name: "pasted.png",
      type: "image/png",
      arrayBuffer: async () => {
        onArrayBuffer();
        return new ArrayBuffer(8);
      },
    };
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(event, {
      clipboardData: {
        items: [{ type: "image/png", getAsFile: () => file }],
      },
    });
    return event;
  }

  test("the binder is called before file.arrayBuffer()", async () => {
    // The listener only installs once a document is open.
    useEditorStore.setState({ opened: { doc: {}, bytes: new Uint8Array() } } as never);

    const events: string[] = [];
    const beginPageMerge = () => {
      events.push("bind");
      return async () => {
        events.push("merge");
        return true;
      };
    };

    renderHook(() => useAppShortcuts({ beginPageMerge }));

    await act(async () => {
      window.dispatchEvent(
        imagePasteEvent(() => events.push("arrayBuffer")),
      );
      // Let the async continuation run.
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    // "bind" must come first. If it moved inside the async block it would
    // land after "arrayBuffer".
    expect(events[0]).toBe("bind");
    expect(events).toContain("arrayBuffer");
  });

  test("DOM paste handles annotations outside editable fields", () => {
    const page = {
      id: "page-1",
      sourceIndex: 0,
      rotation: 0 as const,
      widthPt: 612,
      heightPt: 792,
    };
    const annotation = {
      type: "rect" as const,
      id: "rect-1",
      pageId: page.id,
      rect: { x: 10, y: 20, w: 30, h: 40 },
      color: "#000000",
      fill: null,
      strokeWidth: 1,
    };
    useEditorStore.setState({
      opened: { doc: {}, bytes: new Uint8Array() },
      model: { pages: [page], overlays: [annotation] },
      overlayClipboard: [annotation],
      activePageId: page.id,
    } as never);
    let imageBinderCalls = 0;
    renderHook(() =>
      useAppShortcuts({
        beginPageMerge: () => {
          imageBinderCalls += 1;
          return async () => true;
        },
      }),
    );
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(event, { clipboardData: { items: [] } });

    act(() => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(useEditorStore.getState().model.overlays).toHaveLength(2);
    expect(imageBinderCalls).toBe(0);
  });

  test("editable targets keep native paste even with annotation clipboard state", () => {
    useEditorStore.setState({
      opened: { doc: {}, bytes: new Uint8Array() },
      overlayClipboard: [
        {
          type: "rect",
          id: "rect-1",
          pageId: "page-1",
          rect: { x: 10, y: 20, w: 30, h: 40 },
          color: "#000000",
          fill: null,
          strokeWidth: 1,
        },
      ],
      activePageId: "page-1",
    } as never);
    renderHook(() => useAppShortcuts({ beginPageMerge: () => async () => false }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(event, { clipboardData: { items: [] } });

    act(() => input.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
  });
});
