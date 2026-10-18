import "../../test/setupDom";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { ZoomControls } from "./ZoomControls";
import { setLiveZoomIndicator } from "./liveZoomIndicator";

describe("ZoomControls live zoom readout", () => {
  afterEach(() => {
    act(() => setLiveZoomIndicator(null));
    cleanup();
  });

  test("tracks the live gesture scale and falls back to the committed scale", async () => {
    const view = render(
      <ZoomControls
        scale={1}
        setScale={() => {}}
        zoomOutLabel="out"
        zoomInLabel="in"
        zoomLevelLabel="zoom level"
      />,
    );
    const readout = () => view.getByTitle("zoom level").textContent;

    expect(readout()).toBe("100%");
    // A pinch never commits per frame — the readout must follow the live
    // preview scale anyway, and hand back once the gesture settles.
    await act(async () => setLiveZoomIndicator(1.372));
    expect(readout()).toBe("137%");
    await act(async () => setLiveZoomIndicator(null));
    expect(readout()).toBe("100%");
  });

  test("does not enlarge an automatic fit below the manual zoom floor", () => {
    const committed: number[] = [];
    const view = render(
      <ZoomControls
        scale={0.144}
        setScale={(scale) => committed.push(scale)}
        zoomOutLabel="out"
        zoomInLabel="in"
        zoomLevelLabel="zoom level"
        minimumScale={0.2}
      />,
    );

    const zoomOut = view.getByRole("button", { name: "out" });
    expect((zoomOut as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(zoomOut);
    expect(committed).toEqual([]);
  });
});
