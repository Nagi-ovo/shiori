import "../../test/setupDom";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import type { DraftSyncState } from "../hooks/useDraftSync";
import { subscribe, toast, type ToastItem } from "../toast";
import { useEditorStore } from "../store/store";
import { StatusBar } from "./StatusBar";

function installMobileViewport(): () => void {
  const previous = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: previous,
    });
  };
}

const savedDraft = {
  status: "saved",
  hash: "abc",
  lastTouched: 1_700_000_000_000,
  error: null,
  errorKind: null,
  usedBytes: 1024,
  realUsedBytes: null,
  quotaBytes: null,
  persisted: null,
  flushNow: () => Promise.resolve(),
  flushNowOrThrow: () => Promise.resolve(),
} as unknown as DraftSyncState;

type Overrides = {
  restoredDraftAt?: number | null;
  draftSetAside?: boolean;
  onOpenOriginal?: () => void;
  onRestoreSetAsideDraft?: () => void;
};

function renderBar(overrides: Overrides = {}) {
  return render(
    <StatusBar
      draft={savedDraft}
      exportStatus={{ kind: "needsExport" }}
      onOpenStorage={() => undefined}
      restoredDraftAt={overrides.restoredDraftAt ?? null}
      draftSetAside={overrides.draftSetAside ?? false}
      onOpenOriginal={overrides.onOpenOriginal ?? (() => undefined)}
      onRestoreSetAsideDraft={
        overrides.onRestoreSetAsideDraft ?? (() => undefined)
      }
    />,
  );
}

let restoreViewport: () => void = () => undefined;
let toasts: ToastItem[] = [];
let unsubscribe: () => void = () => undefined;

beforeEach(() => {
  restoreViewport = installMobileViewport();
  unsubscribe = subscribe((items) => {
    toasts = items;
  });
});

afterEach(() => {
  cleanup();
  for (const item of [...toasts]) toast.dismiss(item.id);
  unsubscribe();
  toasts = [];
  document.body.replaceChildren();
  useEditorStore.setState({ historyFeedback: null });
  restoreViewport();
});

describe("StatusBar on a compact viewport", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  // The bar cost a permanent 28px row (plus the safe-area inset) to say six
  // things, only one of which was standing state worth a reader's screen.
  test("renders no permanent row at all", () => {
    const { container } = renderBar();
    expect(container.querySelector(".shioriStatusBar")).toBeNull();
    expect(container.textContent).toBe("");
  });

  test("announces a restored draft once, with the way back to the original", () => {
    let opened = 0;
    const { rerender } = renderBar({ onOpenOriginal: () => (opened += 1) });
    expect(toasts).toHaveLength(0);

    const restoredAt = Date.now() - 5 * 60_000;
    act(() => {
      rerender(
        <StatusBar
          draft={savedDraft}
          exportStatus={{ kind: "needsExport" }}
          onOpenStorage={() => undefined}
          restoredDraftAt={restoredAt}
          draftSetAside={false}
          onOpenOriginal={() => (opened += 1)}
          onRestoreSetAsideDraft={() => undefined}
        />,
      );
    });

    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe(
      i18n.t("drafts.restoredNotice", { rel: "5 min ago" }),
    );
    const actions = toasts[0]!.actions ?? [];
    expect(actions).toHaveLength(1);
    expect(actions[0]!.label).toBe(i18n.t("drafts.openOriginal"));

    // A re-render for an unrelated reason must not re-announce it: App hands
    // this component a fresh inline callback every time it renders.
    act(() => {
      rerender(
        <StatusBar
          draft={savedDraft}
          exportStatus={{ kind: "clean" }}
          onOpenStorage={() => undefined}
          restoredDraftAt={restoredAt}
          draftSetAside={false}
          onOpenOriginal={() => (opened += 1)}
          onRestoreSetAsideDraft={() => undefined}
        />,
      );
    });
    expect(toasts).toHaveLength(1);

    actions[0]!.onClick();
    expect(opened).toBe(1);
  });

  // "Open the original" sets the draft aside, and that state used to keep a
  // permanent "Restore draft" button in the bar. Without a toast the phone
  // would have no visible route back to it.
  test("announces a set-aside draft with the way back to it", () => {
    let restored = 0;
    const { rerender } = renderBar();
    act(() => {
      rerender(
        <StatusBar
          draft={savedDraft}
          exportStatus={{ kind: "clean" }}
          onOpenStorage={() => undefined}
          restoredDraftAt={null}
          draftSetAside
          onOpenOriginal={() => undefined}
          onRestoreSetAsideDraft={() => (restored += 1)}
        />,
      );
    });

    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe(i18n.t("drafts.setAside"));
    const actions = toasts[0]!.actions ?? [];
    expect(actions[0]!.label).toBe(i18n.t("drafts.restoreSetAside"));
    actions[0]!.onClick();
    expect(restored).toBe(1);
  });

  test("announces a draft that was already restored when it mounted", () => {
    renderBar({ restoredDraftAt: Date.now() - 5 * 60_000 });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe(
      i18n.t("drafts.restoredNotice", { rel: "5 min ago" }),
    );
  });
});
