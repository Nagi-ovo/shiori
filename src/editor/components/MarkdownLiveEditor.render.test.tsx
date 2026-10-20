import "../../test/setupDom";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { DEFAULT_MARKDOWN_APPEARANCE } from "../../documents/markdownAppearance";
import { MarkdownLiveEditor } from "./MarkdownLiveEditor";
import {
  MARKDOWN_EDITOR_COMMAND_EVENT,
  type MarkdownEditorCommand,
} from "./markdownLiveEditorCommands";

const noop = () => undefined;

function editorView(container: HTMLElement): EditorView {
  const content = container.querySelector(".cm-content") as HTMLElement | null;
  const view = content ? EditorView.findFromDOM(content) : null;
  if (!view) throw new Error("CodeMirror view was not mounted");
  return view;
}

function runEditorCommand(command: MarkdownEditorCommand): void {
  window.dispatchEvent(
    new CustomEvent<MarkdownEditorCommand>(MARKDOWN_EDITOR_COMMAND_EVENT, {
      detail: command,
    }),
  );
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("MarkdownLiveEditor integration", () => {
  test("applies external text as a minimal non-history change", async () => {
    const emitted: string[] = [];
    const view = render(
      <MarkdownLiveEditor
        title="Markdown editor"
        text="hello world"
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
        onTextChange={(text) => emitted.push(text)}
      />,
    );
    const firstEditor = editorView(view.container);
    act(() => {
      firstEditor.dispatch({ selection: { anchor: 5 } });
    });

    view.rerender(
      <MarkdownLiveEditor
        title="Markdown editor"
        text="hello brave world"
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
        onTextChange={(text) => emitted.push(text)}
      />,
    );

    await waitFor(() => {
      expect(firstEditor.state.doc.toString()).toBe("hello brave world");
    });
    expect(firstEditor.state.selection.main.anchor).toBe(5);
    expect(emitted).toEqual([]);

    act(() => {
      firstEditor.dispatch({
        changes: {
          from: firstEditor.state.doc.length,
          insert: "!",
        },
      });
      firstEditor.focus();
      runEditorCommand("undo");
    });

    expect(firstEditor.state.doc.toString()).toBe("hello brave world");
    expect(emitted.at(-1)).toBe("hello brave world");
  });

  test("applies an external change that returns to the initial text", async () => {
    const view = render(
      <MarkdownLiveEditor
        title="Markdown editor"
        text="alpha"
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
      />,
    );
    const editor = editorView(view.container);

    view.rerender(
      <MarkdownLiveEditor
        title="Markdown editor"
        text="beta"
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
      />,
    );
    await waitFor(() => expect(editor.state.doc.toString()).toBe("beta"));

    view.rerender(
      <MarkdownLiveEditor
        title="Markdown editor"
        text="alpha"
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
      />,
    );
    await waitFor(() => expect(editor.state.doc.toString()).toBe("alpha"));
  });

  test("preserves undo history when the editor remounts for the same document", () => {
    let currentText = "Draft";
    const first = render(
      <MarkdownLiveEditor
        documentId="history-document"
        title="Markdown editor"
        text={currentText}
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
        onTextChange={(text) => {
          currentText = text;
        }}
      />,
    );
    const firstEditor = editorView(first.container);
    act(() => {
      firstEditor.dispatch({
        changes: { from: firstEditor.state.doc.length, insert: "!" },
      });
    });
    expect(currentText).toBe("Draft!");
    first.unmount();

    const second = render(
      <MarkdownLiveEditor
        documentId="history-document"
        title="Markdown editor"
        text={currentText}
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
        onTextChange={(text) => {
          currentText = text;
        }}
      />,
    );
    const secondEditor = editorView(second.container);
    act(() => {
      secondEditor.focus();
      runEditorCommand("undo");
    });

    expect(secondEditor.state.doc.toString()).toBe("Draft");
    expect(currentText).toBe("Draft");
  });

  test("an edit keeps a CRLF document's line endings, across a remount too", () => {
    let currentText = "# Title\r\n\r\nbody\r\n";
    const editor = (key: string) => (
      <MarkdownLiveEditor
        key={key}
        documentId="crlf-document"
        title="Markdown editor"
        text={currentText}
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
        onTextChange={(text) => {
          currentText = text;
        }}
      />
    );
    const first = render(editor("first"));
    const firstEditor = editorView(first.container);
    act(() => {
      firstEditor.dispatch({ changes: { from: firstEditor.state.doc.length, insert: "more\nlines" } });
    });
    expect(currentText).toBe("# Title\r\n\r\nbody\r\nmore\r\nlines");
    first.unmount();

    const second = render(editor("second"));
    const secondEditor = editorView(second.container);
    act(() => {
      secondEditor.focus();
      runEditorCommand("undo");
    });

    expect(currentText).toBe("# Title\r\n\r\nbody\r\n");
  });

  test("select all keeps folded front matter in the source selection", () => {
    const text = ["---", "title: Notes", "---", "", "Body"].join("\n");
    const view = render(
      <MarkdownLiveEditor
        title="Markdown editor"
        text={text}
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
      />,
    );
    const editor = editorView(view.container);

    act(() => {
      editor.focus();
      runEditorCommand("selectAll");
    });

    expect(editor.state.selection.main.from).toBe(0);
    expect(editor.state.selection.main.to).toBe(text.length);
    expect(view.container.querySelector(".shioriDocumentMetadata")).toBeTruthy();
  });

  test("keeps the editor mounted while appearance settings change", () => {
    const view = render(
      <MarkdownLiveEditor
        title="Markdown editor"
        text="# Draft"
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
      />,
    );
    const firstEditor = editorView(view.container);
    act(() => {
      firstEditor.dispatch({ selection: { anchor: 3 } });
      firstEditor.scrollDOM.scrollTop = 84;
    });

    view.rerender(
      <MarkdownLiveEditor
        title="Markdown editor"
        text="# Draft"
        zoom={1.25}
        headingColor="#2d5a3d"
        appearance={{
          bodyFont: { source: "system", family: "Shiori Body Test" },
          codeFont: { source: "system", family: "Shiori Code Test" },
          headingColor: "#2d5a3d",
          fontSize: 18,
          lineHeight: 1.8,
          contentWidth: 720,
        }}
        scrollTop={0}
        onScrollTopChange={noop}
      />,
    );

    const nextEditor = editorView(view.container);
    const host = view.container.querySelector(
      "[data-shiori-markdown-live-editor='true']",
    ) as HTMLElement;
    expect(nextEditor).toBe(firstEditor);
    expect(nextEditor.state.selection.main.anchor).toBe(3);
    expect(nextEditor.scrollDOM.scrollTop).toBe(84);
    expect(host.style.width).toBe("100%");
    expect(host.style.maxWidth).toBe("");
    const themeCss = document.head.textContent ?? "";
    expect(themeCss).toContain('font-family: "Shiori Body Test"');
    expect(themeCss).toContain('font-family: "Shiori Code Test"');
    expect(themeCss).toContain("font-size: 22.5px");
    expect(themeCss).toContain("line-height: 1.8");
    expect(themeCss).toContain("max-width: 720px");
    expect(themeCss).toContain("color: #2d5a3d");
    expect(themeCss).toContain("color: var(--opx-accentText)");
  });

  // Code in the edit view was plain text: no nested language, no tokens.
  test("highlights a fenced block in the language it names", async () => {
    const view = render(
      <MarkdownLiveEditor
        title="Markdown editor"
        text={["Intro", "", "```ts", "const answer = 42;", "```"].join("\n")}
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
      />,
    );

    // The language loads on first use, then the block re-highlights.
    await waitFor(() => {
      const keyword = view.container.querySelector(
        ".cm-shiori-md-code-line .tok-keyword",
      );
      expect(keyword?.textContent).toBe("const");
    });
    expect(
      view.container.querySelector(".cm-shiori-md-code-line .tok-number")
        ?.textContent,
    ).toBe("42");
  });

  test("renders heading text without the Markdown separator indent", async () => {
    const view = render(
      <MarkdownLiveEditor
        title="Markdown editor"
        text={"# Heading one\n\nBody\n\n## Heading two"}
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
      />,
    );

    await waitFor(() => {
      const lines = view.container.querySelectorAll(".cm-line");
      expect(lines[0]?.textContent).toBe("Heading one");
      expect(lines[2]?.textContent).toBe("Body");
      expect(lines[4]?.textContent).toBe("Heading two");
    });
  });

  test("removes legal Setext indentation from rendered heading text", async () => {
    const view = render(
      <MarkdownLiveEditor
        title="Markdown editor"
        text={"   Setext heading\n   ---\n\nBody"}
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
      />,
    );

    await waitFor(() => {
      const lines = view.container.querySelectorAll(".cm-line");
      expect(lines[0]?.textContent).toBe("Setext heading");
      expect(lines[3]?.textContent).toBe("Body");
    });
  });

  test("uses a two-space indent and supports Shift+Tab", () => {
    const view = render(
      <MarkdownLiveEditor
        title="Markdown editor"
        text={"first\nsecond"}
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
      />,
    );
    const editor = editorView(view.container);
    act(() => {
      editor.dispatch({
        selection: { anchor: 0, head: editor.state.doc.length },
      });
      editor.focus();
    });

    fireEvent.keyDown(editor.contentDOM, { key: "Tab" });
    expect(editor.state.doc.toString()).toBe("  first\n  second");

    fireEvent.keyDown(editor.contentDOM, { key: "Tab", shiftKey: true });
    expect(editor.state.doc.toString()).toBe("first\nsecond");
  });

  test("defers an external replacement while IME composition is active", async () => {
    const view = render(
      <MarkdownLiveEditor
        title="Markdown editor"
        text="draft"
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
      />,
    );
    const editor = editorView(view.container);
    Object.defineProperty(editor, "composing", {
      configurable: true,
      value: true,
    });

    view.rerender(
      <MarkdownLiveEditor
        title="Markdown editor"
        text="external"
        zoom={1}
        appearance={DEFAULT_MARKDOWN_APPEARANCE}
        scrollTop={0}
        onScrollTopChange={noop}
      />,
    );

    expect(editor.state.doc.toString()).toBe("draft");
    Object.defineProperty(editor, "composing", {
      configurable: true,
      value: false,
    });
    fireEvent.compositionEnd(editor.contentDOM);
    await waitFor(() => {
      expect(editor.state.doc.toString()).toBe("external");
    });
  });
});
