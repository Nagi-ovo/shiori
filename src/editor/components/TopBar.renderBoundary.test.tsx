import "../../test/setupDom";
import { useState } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import i18n from "../../i18n";

const renders = new Map<string, number>();

mock.module("../../perf/tabPerf", () => ({
  recordTabPerfRender(component: string) {
    renders.set(component, (renders.get(component) ?? 0) + 1);
  },
  recordTabPerfGauge() {},
}));

const { TopBar } = await import("./TopBar");
const { DocumentShell } = await import("../../App/render/DocumentShell");

const noop = () => undefined;
const shellProps = {
  documentKind: "pdf" as const,
  title: "paper.pdf",
  meta: "12 pages",
  navigatorOpen: false,
  onHome: noop,
  onOpenSettings: noop,
  onOpenShortcuts: noop,
  workspaceSwitcher: null,
  navigator: null,
  tabStrip: null,
  viewport: null,
  railDoc: null,
  showRail: false,
  onCloseRail: noop,
};

function TopBarHarness() {
  const [parentRender, setParentRender] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setParentRender((value) => value + 1)}>
        parent:{parentRender}
      </button>
      <TopBar
        fileName="paper.pdf"
        meta="12 pages"
        onOpenShortcuts={noop}
        onOpenSettings={noop}
        navigatorOpen={false}
      />
    </>
  );
}

function ShellHarness() {
  const [parentRender, setParentRender] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setParentRender((value) => value + 1)}>
        parent:{parentRender}
      </button>
      <DocumentShell {...shellProps} />
    </>
  );
}

describe("chrome render boundaries", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    renders.clear();
  });

  afterAll(() => {
    mock.restore();
  });

  test("a parent update with stable props does not render TopBar again", () => {
    const view = render(<TopBarHarness />);
    expect(renders.get("TopBar")).toBe(1);
    fireEvent.click(view.getByRole("button", { name: "parent:0" }));
    expect(renders.get("TopBar")).toBe(1);
  });

  test("a parent update with stable slots does not render the shell or TopBar", () => {
    const view = render(<ShellHarness />);
    expect(renders.get("DocumentShell")).toBe(1);
    expect(renders.get("TopBar")).toBe(1);
    fireEvent.click(view.getByRole("button", { name: "parent:0" }));
    expect(renders.get("DocumentShell")).toBe(1);
    expect(renders.get("TopBar")).toBe(1);
  });
});
