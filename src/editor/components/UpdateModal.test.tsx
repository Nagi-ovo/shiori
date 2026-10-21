import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import type { ShioriUpdate } from "../../platform/updater";
import { UpdateModal } from "./UpdateModal";

// Drives the direct-APK install through the real bridge protocol
// (window.ShioriAndroid + "shiori-android-update" events) that
// DirectApkUpdater.kt speaks, and checks what the user is left looking at
// when the system installer does not finish the update.

const update: ShioriUpdate = {
  kind: "android-direct",
  version: "26.10.21",
  currentVersion: "26.10.20",
  body: "Notes",
  date: null,
  url: "https://github.com/Nagi-ovo/shiori/releases/download/v26.10.21/Shiori.apk",
  filename: "Shiori.apk",
  size: 1024,
  sha256: "a".repeat(64),
};

const originalFetch = globalThis.fetch;
let previousLanguage = "en";

beforeAll(async () => {
  previousLanguage = i18n.language;
  await i18n.changeLanguage("en");
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await i18n.changeLanguage(previousLanguage);
});

afterEach(() => {
  cleanup();
  delete window.ShioriAndroid;
});

async function startInstall() {
  let requestId = "";
  window.ShioriAndroid = {
    installDirectApk(requestJson: string) {
      requestId = (JSON.parse(requestJson) as { id: string }).id;
      return JSON.stringify({ ok: true });
    },
  };
  let closed = 0;
  const view = render(<UpdateModal update={update} onClose={() => (closed += 1)} />);
  await act(async () => {
    fireEvent.click(view.getByText(i18n.t("update.downloadAndInstallApk")));
  });
  const send = async (detail: Record<string, unknown>) => {
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("shiori-android-update", { detail: { id: requestId, ...detail } }),
      );
    });
  };
  return { view, send, closed: () => closed };
}

async function installEndingWith(message: string) {
  const started = await startInstall();
  await started.send({ status: "error", message });
  return started;
}

function laterButton(view: Awaited<ReturnType<typeof startInstall>>["view"]) {
  return view.getByText(i18n.t("update.later")).closest("button") as HTMLButtonElement;
}

describe("UpdateModal direct-APK installer outcome", () => {
  test("a cancelled install stays open and says it was cancelled", async () => {
    const { view, closed } = await installEndingWith("android-install-cancelled");
    expect(closed()).toBe(0);
    expect(view.getByText(/The update was cancelled before it was installed\./)).toBeTruthy();
    expect(view.queryByText(/android-install-cancelled/)).toBeNull();
  });

  test("an install the system refused says so instead of showing the slug", async () => {
    const { view, closed } = await installEndingWith("android-install-failed");
    expect(closed()).toBe(0);
    expect(view.getByText(/Android refused to install the update\./)).toBeTruthy();
    expect(view.queryByText(/android-install-failed/)).toBeNull();
  });

  // Dismissing Android's confirmation dialog by tapping outside it (Android
  // 13 and earlier) reports nothing, so the modal must not wait for a final
  // status once the APK is in the system installer's hands.
  test("can be dismissed once the APK is downloaded and with the installer", async () => {
    const { view, send, closed } = await startInstall();
    await send({ status: "progress", downloaded: 512, total: 1024 });
    expect(laterButton(view).disabled).toBe(true);

    await send({ status: "progress", downloaded: 1024, total: 1024 });
    expect(laterButton(view).disabled).toBe(false);
    fireEvent.click(laterButton(view));
    expect(closed()).toBe(1);
  });
});
