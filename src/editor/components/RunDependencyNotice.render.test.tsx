import "../../test/setupDom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import i18n from "../../i18n";
import type { RemoteDependency } from "../../documents/runnableHtml";
import { RunDependencyNotice } from "./RunDependencyNotice";

const DEPENDENCIES: RemoteDependency[] = [
  { kind: "script", url: "https://cdn.example/three.js", origin: "https://cdn.example" },
  { kind: "stylesheet", url: "https://cdn.example/a.css", origin: "https://cdn.example" },
  { kind: "media", url: "https://cdn.example/a.mp4", origin: "https://cdn.example" },
  { kind: "image", url: "http://img.example/a.png", origin: "http://img.example" },
  { kind: "image", url: "https://img.example/b.png", origin: "https://img.example" },
];

function renderNotice(inheritsAppCsp: boolean) {
  const view = render(
    <RunDependencyNotice
      dependencies={DEPENDENCIES}
      appliedKeys={new Set()}
      selectedKeys={new Set()}
      selectionDirty={false}
      onToggle={() => undefined}
      onApply={() => undefined}
      inheritsAppCsp={inheritsAppCsp}
    />,
  );
  fireEvent.click(view.getByText("Show details"));
  return view;
}

describe("RunDependencyNotice", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  test("offers every approvable kind where the run frame has no app CSP (web)", () => {
    const view = renderNotice(false);

    expect(view.container.querySelectorAll('input[type="checkbox"]').length).toBe(5);
    expect(view.queryByText(/can only load remote https images/)).toBeNull();
  });

  // The run frame is a blob: document, so it inherits the app's CSP, which a
  // meta policy inside it can only narrow: only https images can ever load.
  test("offers only https images where the run frame inherits the app CSP (Tauri)", () => {
    const view = renderNotice(true);
    const checkboxes = Array.from(
      view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );

    expect(checkboxes.length).toBe(1);
    expect(checkboxes[0]!.closest("label")?.textContent).toContain(
      "https://img.example/b.png",
    );
    expect(view.getByText(/can only load remote https images/)).toBeTruthy();
  });

  // Static check: the Tauri rule above restates what the app CSP admits. If
  // src-tauri/tauri.conf.json changes these directives, the rule changes too.
  test("matches the app CSP that Tauri run frames inherit", async () => {
    const conf = await Bun.file(
      new URL("../../../src-tauri/tauri.conf.json", import.meta.url),
    ).json();
    const directives = new Map<string, string[]>(
      String(conf.app.security.csp)
        .split(";")
        .map((directive) => directive.trim().split(/\s+/))
        .filter(([name]) => name)
        .map(([name, ...sources]) => [name!, sources]),
    );
    const remoteSources = (name: string) =>
      (directives.get(name) ?? directives.get("default-src") ?? []).filter(
        (source) =>
          source === "*" ||
          source === "https:" ||
          source === "http:" ||
          (/^https?:\/\//.test(source) && !/\.localhost(:\d+)?$/.test(source)),
      );

    expect(remoteSources("script-src")).toEqual([]);
    expect(remoteSources("style-src")).toEqual([]);
    expect(remoteSources("media-src")).toEqual([]);
    expect(remoteSources("img-src")).toEqual(["https:"]);
  });
});
