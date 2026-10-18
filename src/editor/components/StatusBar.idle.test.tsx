import "../../test/setupDom";
import { Profiler } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import type { DraftSyncState } from "../hooks/useDraftSync";
import { useEditorStore } from "../store/store";
import { StatusBar } from "./StatusBar";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useEditorStore.setState({ historyFeedback: null });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const idleDraft = {
  status: "saved",
  hash: null,
  lastTouched: null,
  error: null,
  errorKind: null,
  usedBytes: 0,
  realUsedBytes: null,
  quotaBytes: null,
  persisted: null,
  flushNow: () => Promise.resolve(),
  flushNowOrThrow: () => Promise.resolve(),
} as unknown as DraftSyncState;

function renderBar(props: { restoredDraftAt: number | null }) {
  let commits = 0;
  const view = render(
    <Profiler id="status-bar" onRender={() => { commits += 1; }}>
      <StatusBar
        draft={idleDraft}
        exportStatus={{ kind: "clean" }}
        onOpenStorage={() => undefined}
        restoredDraftAt={props.restoredDraftAt}
        draftSetAside={false}
        onOpenOriginal={() => undefined}
        onRestoreSetAsideDraft={() => undefined}
      />
    </Profiler>,
  );
  return { view, commits: () => commits };
}

describe("StatusBar idle work", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  // The defect: a 500ms clock ran unconditionally, so a bar with nothing
  // time-dependent to show still committed ten times every five seconds.
  test("commits nothing while idle", async () => {
    const bar = renderBar({ restoredDraftAt: null });
    expect(bar.commits()).toBe(1);
    await wait(1_200);
    expect(bar.commits()).toBe(1);
  });

  // The history toast still has to disappear on its own — one commit at
  // expiry, not a stream of them before it.
  test("clears the undo notice once, at expiry", async () => {
    useEditorStore.setState({
      historyFeedback: { kind: "undo", at: Date.now() - 2_400 },
    });
    const bar = renderBar({ restoredDraftAt: null });
    expect(bar.view.container.textContent).toContain(i18n.t("history.undo"));
    await wait(300);
    expect(bar.view.container.textContent).not.toContain(i18n.t("history.undo"));
    expect(bar.commits()).toBe(2);
  });

  // "Just now" flips to "1 min ago" at 60s; a restored-draft notice must
  // not tick every half second on its way there.
  test("does not poll for the restored-draft relative time", async () => {
    const bar = renderBar({ restoredDraftAt: Date.now() - 10_000 });
    await wait(1_200);
    expect(bar.commits()).toBe(1);
  });

  // 26.9.8 on Android: a restored draft adds three more items to a row that
  // is a fixed 28px tall, and the labels wrapped onto three lines and spilled
  // out of the bar. Flex items shrink by default, so "don't wrap" has to be
  // said on the container AND the children (the latter in app.css). The bar
  // is desktop-only now, but a narrow window still has to scroll, not wrap.
  test("keeps its row on one line and scrolls instead of wrapping", () => {
    const { view } = renderBar({ restoredDraftAt: Date.now() - 60_000 });
    const bar = view.container.querySelector<HTMLElement>(".shioriStatusBar");
    expect(bar).not.toBeNull();
    expect(bar!.style.flexWrap).toBe("nowrap");
    expect(bar!.style.whiteSpace).toBe("nowrap");
    expect(bar!.style.overflowX).toBe("auto");
    expect(bar!.style.overflowY).toBe("hidden");
  });
});
