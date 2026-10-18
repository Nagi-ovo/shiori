import "../../test/setupDom";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useAppStore } from "../../editor/store/store";
import { useChangelog } from "./useChangelog";

const initialSnapshot = useAppStore.getState();

function launch(lastSeen: string | undefined, currentVersion = "1.4.0") {
  useAppStore.setState({
    prefs: { ...initialSnapshot.prefs, lastSeenChangelogVersion: lastSeen },
  });
  return renderHook(() => useChangelog({ currentVersion, dev: false }));
}

const recorded = () => useAppStore.getState().prefs.lastSeenChangelogVersion;

afterEach(() => {
  cleanup();
  useAppStore.setState(initialSnapshot, true);
});

describe("What's new on launch", () => {
  test("a first launch stays quiet and records the version", () => {
    const { result } = launch(undefined);

    expect(result.current.showChangelog).toBe(false);
    expect(recorded()).toBe("1.4.0");
  });

  test("an upgrade opens it, and closing it records the new version", () => {
    const { result } = launch("1.3.2");
    expect(result.current.showChangelog).toBe(true);
    expect(recorded()).toBe("1.3.2");

    act(() => result.current.closeChangelog());

    expect(result.current.showChangelog).toBe(false);
    expect(recorded()).toBe("1.4.0");
  });

  test("the same version launched again does not open it", () => {
    expect(launch("1.4.0").result.current.showChangelog).toBe(false);
  });
});
