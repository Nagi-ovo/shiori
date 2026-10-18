import { useEffect, useRef, type MutableRefObject } from "react";
import {
  Compartment,
  EditorState,
  StateEffect,
  Transaction,
  type ChangeSpec,
  type Extension,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  selectAll,
  undo,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { codeLanguages } from "../../documents/codeHighlight";
import { T } from "../../design/tokens";
import {
  markdownFontFamilyCss,
  type MarkdownAppearance,
} from "../../documents/markdownAppearance";
import {
  markdownEditorTheme,
  markdownLiveDecorations,
} from "./MarkdownLiveEditorCore";
import {
  MARKDOWN_EDITOR_COMMAND_EVENT,
  type MarkdownEditorCommand,
} from "./markdownLiveEditorCommands";

type Props = {
  documentId?: string;
  title: string;
  metadataEditLabel?: string;
  text: string;
  zoom: number;
  appearance: MarkdownAppearance;
  headingColor?: string;
  scrollTop: number;
  onScrollTopChange: (scrollTop: number) => void;
  onScrollerMount?: (node: HTMLElement | null) => void;
  onTextChange?: (text: string) => void;
  /**
   * The reading position handed over from the preview, as a source line
   * (src/documents/markdownScrollAnchor.ts). Read and cleared on mount; it
   * wins over `scrollTop`, a pixel offset in the other layout.
   */
  sourceLineHandoffRef?: MutableRefObject<number | null>;
  /** Set while mounted: reads the source line at the top of the editor. */
  sourceLineReaderRef?: MutableRefObject<(() => number | null) | null>;
};

const MARKDOWN_EDITOR_CACHE_MAX_DOCUMENTS = 8;
const MARKDOWN_EDITOR_CACHE_MAX_CHARACTERS = 4_000_000;
const markdownEditorStateCache = new Map<string, EditorState>();

export function MarkdownLiveEditor({
  documentId,
  title,
  metadataEditLabel = title,
  text,
  zoom,
  appearance,
  headingColor = T.ink,
  scrollTop,
  onScrollTopChange,
  onScrollerMount,
  onTextChange,
  sourceLineHandoffRef,
  sourceLineReaderRef,
}: Props) {
  const bodyFontFamily = markdownFontFamilyCss(appearance.bodyFont, "body");
  const codeFontFamily = markdownFontFamilyCss(appearance.codeFont, "code");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const syncingExternalTextRef = useRef(false);
  const pendingExternalTextRef = useRef<string | null>(null);
  // What we believe the document currently says. The parent stores every
  // local edit and hands it straight back as a prop, and the sync effect below
  // then has to decide whether the document already says that — which it did
  // by materializing the whole document again, on every keystroke. This
  // answers the local-edit case, which is nearly every case, without walking
  // the text.
  //
  // It has to track EVERY change, not just the ones we emitted: if it only
  // remembered our own last edit, an external replacement would leave it
  // stale, and a later external change back to that remembered value would be
  // mistaken for an echo and silently dropped.
  const knownEditorTextRef = useRef<string | null>(null);
  const latestTextPropRef = useRef(text);
  const onTextChangeRef = useRef(onTextChange);
  const onScrollTopChangeRef = useRef(onScrollTopChange);
  const onScrollerMountRef = useRef(onScrollerMount);
  const themeCompartmentRef = useRef(new Compartment());
  const liveDecorationsCompartmentRef = useRef(new Compartment());
  // The scrollTop prop at mount when a handoff line placed the view instead:
  // that value is the other layout's pixels, so it is not applied.
  const handedOffScrollTopRef = useRef<number | null>(null);

  useEffect(() => {
    latestTextPropRef.current = text;
  }, [text]);

  useEffect(() => {
    onTextChangeRef.current = onTextChange;
  }, [onTextChange]);

  useEffect(() => {
    onScrollTopChangeRef.current = onScrollTopChange;
  }, [onScrollTopChange]);

  useEffect(() => {
    onScrollerMountRef.current = onScrollerMount;
  }, [onScrollerMount]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const themeCompartment = themeCompartmentRef.current;
    const extensions: Extension[] = [
          history(),
          // Fenced code parses in its own language (loaded on first use) and
          // highlights as `tok-*` classes, the same ones the preview uses.
          markdown({ base: markdownLanguage, codeLanguages }),
          syntaxHighlighting(classHighlighter),
          indentUnit.of("  "),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            "aria-label": title,
            spellcheck: "true",
          }),
          EditorView.domEventHandlers({
            scroll(event, editorView) {
              if (event.target === editorView.scrollDOM) {
                onScrollTopChangeRef.current(editorView.scrollDOM.scrollTop);
              }
            },
            compositionend(_event, editorView) {
              window.queueMicrotask(() => {
                flushPendingExternalText(
                  editorView,
                  viewRef,
                  pendingExternalTextRef,
                  latestTextPropRef,
                  syncingExternalTextRef,
                  knownEditorTextRef,
                );
              });
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !syncingExternalTextRef.current) {
              const nextText = update.state.doc.toString();
              pendingExternalTextRef.current = null;
              knownEditorTextRef.current = nextText;
              onTextChangeRef.current?.(nextText);
            }
          }),
          keymap.of([indentWithTab, ...historyKeymap, ...defaultKeymap]),
          liveDecorationsCompartmentRef.current.of(
            markdownLiveDecorations(metadataEditLabel),
          ),
          themeCompartment.of(
            markdownEditorTheme({
              zoom,
              bodyFontFamily,
              codeFontFamily,
              fontSize: appearance.fontSize,
              lineHeight: appearance.lineHeight,
              contentWidth: appearance.contentWidth,
              headingColor,
            }),
          ),
        ];
    const cachedState = takeCachedMarkdownEditorState(documentId);
    const initialState = cachedState
      ? updateEditorStateText(
          cachedState.update({
            effects: StateEffect.reconfigure.of(extensions),
            annotations: Transaction.addToHistory.of(false),
          }).state,
          text,
        )
      : EditorState.create({ doc: text, extensions });
    const view = new EditorView({
      parent: host,
      state: initialState,
    });
    viewRef.current = view;
    // Read, not taken: StrictMode mounts twice in development, and the
    // viewer writes a fresh line on every switch anyway.
    const handoff = sourceLineHandoffRef?.current ?? null;
    if (handoff !== null) {
      handedOffScrollTopRef.current = scrollTop;
      scrollEditorToSourceLine(view, handoff);
    } else {
      view.scrollDOM.scrollTop = scrollTop;
    }
    if (sourceLineReaderRef) sourceLineReaderRef.current = () => editorSourceLine(view);
    onScrollerMountRef.current?.(view.scrollDOM);

    const onCommand = (event: Event) => {
      if (!view.hasFocus) return;
      const command = (event as CustomEvent<MarkdownEditorCommand>).detail;
      if (command === "undo") undo(view);
      else if (command === "redo") redo(view);
      else if (command === "selectAll") selectAll(view);
    };
    window.addEventListener(MARKDOWN_EDITOR_COMMAND_EVENT, onCommand);

    return () => {
      if (sourceLineReaderRef) sourceLineReaderRef.current = null;
      window.removeEventListener(MARKDOWN_EDITOR_COMMAND_EVENT, onCommand);
      onScrollerMountRef.current?.(null);
      cacheMarkdownEditorState(documentId, view.state);
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
    // The editor owns its state after mount; prop sync happens in effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    // The echo of our own edit: the document already says this, so there is
    // nothing to walk.
    if (view && knownEditorTextRef.current === text) {
      pendingExternalTextRef.current = null;
      return;
    }
    if (!view || view.state.doc.toString() === text) {
      knownEditorTextRef.current = text;
      pendingExternalTextRef.current = null;
      return;
    }
    if (view.composing) {
      pendingExternalTextRef.current = text;
      return;
    }
    pendingExternalTextRef.current = null;
    updateEditorViewText(view, text, syncingExternalTextRef);
    knownEditorTextRef.current = text;
  }, [text]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(
        markdownEditorTheme({
          zoom,
          bodyFontFamily,
          codeFontFamily,
          fontSize: appearance.fontSize,
          lineHeight: appearance.lineHeight,
          contentWidth: appearance.contentWidth,
          headingColor,
        }),
      ),
    });
  }, [
    appearance.contentWidth,
    appearance.fontSize,
    appearance.lineHeight,
    bodyFontFamily,
    codeFontFamily,
    headingColor,
    zoom,
  ]);

  useEffect(() => {
    viewRef.current?.contentDOM.setAttribute("aria-label", title);
  }, [title]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: liveDecorationsCompartmentRef.current.reconfigure(
        markdownLiveDecorations(metadataEditLabel),
      ),
    });
  }, [metadataEditLabel]);

  useEffect(() => {
    const view = viewRef.current;
    if (handedOffScrollTopRef.current === scrollTop) return;
    handedOffScrollTopRef.current = null;
    if (!view || Math.abs(view.scrollDOM.scrollTop - scrollTop) <= 1) return;
    view.scrollDOM.scrollTop = scrollTop;
  }, [scrollTop]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        background: T.paper,
        color: T.ink,
        padding: 0,
        overflow: "hidden",
      }}
    >
      <div
        ref={hostRef}
        data-shiori-markdown-live-editor="true"
        style={{
          boxSizing: "border-box",
          width: "100%",
          height: "100%",
          minHeight: 0,
          minWidth: 0,
        }}
      />
    </div>
  );
}

/** The source line at the top of the editor's viewport, fractional. */
function editorSourceLine(view: EditorView): number {
  const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
  const block = view.lineBlockAtHeight(Math.max(0, height));
  const first = view.state.doc.lineAt(block.from).number;
  const last = view.state.doc.lineAt(block.to).number;
  const through =
    block.height > 0 ? Math.min(Math.max((height - block.top) / block.height, 0), 1) : 0;
  return first + through * (last - first + 1);
}

/** Puts a source line at the top of the editor's viewport. */
function scrollEditorToSourceLine(view: EditorView, line: number): void {
  const doc = view.state.doc;
  const number = Math.min(Math.max(Math.floor(line), 1), doc.lines);
  view.dispatch({
    effects: EditorView.scrollIntoView(doc.line(number).from, { y: "start", yMargin: 0 }),
  });
}

function minimalTextChange(current: string, next: string): ChangeSpec | null {
  if (current === next) return null;
  let from = 0;
  const sharedLength = Math.min(current.length, next.length);
  while (from < sharedLength && current.charCodeAt(from) === next.charCodeAt(from)) {
    from += 1;
  }

  let currentTo = current.length;
  let nextTo = next.length;
  while (
    currentTo > from &&
    nextTo > from &&
    current.charCodeAt(currentTo - 1) === next.charCodeAt(nextTo - 1)
  ) {
    currentTo -= 1;
    nextTo -= 1;
  }

  return { from, to: currentTo, insert: next.slice(from, nextTo) };
}

function updateEditorStateText(state: EditorState, text: string): EditorState {
  const changes = minimalTextChange(state.doc.toString(), text);
  if (!changes) return state;
  return state.update({
    changes,
    annotations: Transaction.addToHistory.of(false),
  }).state;
}

function updateEditorViewText(
  view: EditorView,
  text: string,
  syncingExternalTextRef: { current: boolean },
): void {
  const changes = minimalTextChange(view.state.doc.toString(), text);
  if (!changes) return;
  syncingExternalTextRef.current = true;
  try {
    view.dispatch({
      changes,
      annotations: Transaction.addToHistory.of(false),
    });
  } finally {
    syncingExternalTextRef.current = false;
  }
}

function flushPendingExternalText(
  view: EditorView,
  viewRef: { current: EditorView | null },
  pendingExternalTextRef: { current: string | null },
  latestTextPropRef: { current: string },
  syncingExternalTextRef: { current: boolean },
  // Updated when the deferred text lands. Without it the composition path
  // leaves the known text stale, and a later external change back to that
  // stale value is mistaken for our own echo and dropped.
  knownEditorTextRef: { current: string | null },
  attempt: number = 0,
): void {
  if (viewRef.current !== view) return;
  if (view.composing) {
    if (pendingExternalTextRef.current !== null && attempt < 2) {
      window.requestAnimationFrame(() =>
        flushPendingExternalText(
          view,
          viewRef,
          pendingExternalTextRef,
          latestTextPropRef,
          syncingExternalTextRef,
          knownEditorTextRef,
          attempt + 1,
        ),
      );
    }
    return;
  }
  const pending = pendingExternalTextRef.current;
  pendingExternalTextRef.current = null;
  if (pending === null || pending !== latestTextPropRef.current) return;
  updateEditorViewText(view, pending, syncingExternalTextRef);
  knownEditorTextRef.current = pending;
}

function takeCachedMarkdownEditorState(documentId?: string): EditorState | null {
  if (!documentId) return null;
  const state = markdownEditorStateCache.get(documentId) ?? null;
  markdownEditorStateCache.delete(documentId);
  return state;
}

function cacheMarkdownEditorState(
  documentId: string | undefined,
  state: EditorState,
): void {
  if (!documentId || state.doc.length > MARKDOWN_EDITOR_CACHE_MAX_CHARACTERS) {
    return;
  }
  markdownEditorStateCache.delete(documentId);
  markdownEditorStateCache.set(documentId, state);

  let cachedCharacters = 0;
  for (const cached of markdownEditorStateCache.values()) {
    cachedCharacters += cached.doc.length;
  }
  while (
    markdownEditorStateCache.size > MARKDOWN_EDITOR_CACHE_MAX_DOCUMENTS ||
    cachedCharacters > MARKDOWN_EDITOR_CACHE_MAX_CHARACTERS
  ) {
    const oldest = markdownEditorStateCache.entries().next().value as
      | [string, EditorState]
      | undefined;
    if (!oldest) break;
    markdownEditorStateCache.delete(oldest[0]);
    cachedCharacters -= oldest[1].doc.length;
  }
}
