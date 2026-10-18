import "../../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import i18n from "../../../i18n";
import type { CalloutOverlay } from "../../../pdf/model/types";
import { useAppStore, useEditorStore } from "../../store/store";
import { CalloutThreadPanel } from "./CalloutThreadPanel";

const overlay: CalloutOverlay = {
  type: "callout",
  id: "callout-1",
  pageId: "page-1",
  targetRects: [{ x: 20, y: 30, w: 60, h: 12 }],
  rect: { x: 100, y: 100, w: 180, h: 72 },
  text: "Explain this",
  fontSize: 12,
  color: "#b13a2e",
  bold: false,
  align: "left",
  fontFamily: "sans",
};

function renderPanel(agentCliAvailable: boolean) {
  return render(
    <CalloutThreadPanel
      overlay={overlay}
      left={100}
      top={100}
      width={180}
      height={72}
      rotateDeg={0}
      scale={1}
      pageWidthPx={612}
      pageHeightPx={792}
      agentCliAvailable={agentCliAvailable}
      onAppend={() => undefined}
      onReplaceThread={() => undefined}
    />,
  );
}

describe("CalloutThreadPanel follow-up visibility", () => {
  beforeEach(async () => {
    cleanup();
    document.body.replaceChildren();
    await i18n.changeLanguage("en");
    useEditorStore.setState({ collapsedThreadIds: [] });
    useAppStore.setState((state) => ({
      prefs: { ...state.prefs, showCalloutFollowUp: true },
    }));
  });

  afterEach(() => cleanup());

  test("requires a detected local agent CLI", () => {
    const view = renderPanel(false);
    expect(view.queryByPlaceholderText("Follow up…")).toBeNull();

    view.rerender(
      <CalloutThreadPanel
        overlay={overlay}
        left={100}
        top={100}
        width={180}
        height={72}
        rotateDeg={0}
        scale={1}
        pageWidthPx={612}
        pageHeightPx={792}
        agentCliAvailable
        onAppend={() => undefined}
        onReplaceThread={() => undefined}
      />,
    );
    expect(view.getByPlaceholderText("Follow up…")).toBeTruthy();
  });

  test("respects the follow-up visibility preference", () => {
    useAppStore.setState((state) => ({
      prefs: { ...state.prefs, showCalloutFollowUp: false },
    }));
    const view = renderPanel(true);
    expect(view.queryByPlaceholderText("Follow up…")).toBeNull();
  });

  test("submits a follow-up when a local agent is available", () => {
    let appended: { role: string; text: string; at?: number } | null = null;
    const view = render(
      <CalloutThreadPanel
        overlay={overlay}
        left={100}
        top={100}
        width={180}
        height={72}
        rotateDeg={0}
        scale={1}
        pageWidthPx={612}
        pageHeightPx={792}
        agentCliAvailable
        onAppend={(entry) => {
          appended = entry;
        }}
        onReplaceThread={() => undefined}
      />,
    );
    const box = view.getByPlaceholderText("Follow up…") as HTMLTextAreaElement;
    fireEvent.focus(box);
    // The component intentionally keeps this textarea uncontrolled and reads
    // its DOM value on Enter. `input` mirrors the browser event for typing;
    // `change` only fires after a textarea loses focus.
    fireEvent.input(box, { target: { value: "  再具体点  " } });
    fireEvent.keyDown(box, { key: "Enter", code: "Enter", charCode: 13 });

    expect(appended?.role).toBe("user");
    expect(appended?.text).toBe("再具体点");
    expect(typeof appended?.at).toBe("number");
    expect(box.value).toBe("");
  });
});
