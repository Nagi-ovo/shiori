import {
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { T } from "../../design/tokens";
import {
  extractMarkdownFrontMatter,
  renderMetadataHtml,
} from "../../documents/renderSafeHtml";

export type TextRange = {
  from: number;
  to: number;
};

type MetadataField = "key" | "value";

type MarkdownLiveDecorationKind =
  | "hidden"
  | "sourceLine"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading"
  | "strong"
  | "emphasis"
  | "strikethrough"
  | "inlineCode"
  | "link"
  | "blockquote"
  | "listMark"
  | "taskChecked"
  | "taskUnchecked"
  | "metadata"
  | "codeLine"
  | "codeFence"
  | "codeFenceLine";

export type MarkdownLiveDecorationSpan = TextRange & {
  kind: MarkdownLiveDecorationKind;
  html?: string;
  text?: string;
  /** codeLine: where the line sits in its block, for the box's ends. */
  edge?: "first" | "last" | "only";
};

const hiddenSyntax = Decoration.replace({});
const sourceLine = Decoration.line({ class: "cm-shiori-md-source-line" });
const heading1 = Decoration.line({ class: "cm-shiori-md-heading cm-shiori-md-h1" });
const heading2 = Decoration.line({ class: "cm-shiori-md-heading cm-shiori-md-h2" });
const heading3 = Decoration.line({ class: "cm-shiori-md-heading cm-shiori-md-h3" });
const heading = Decoration.line({ class: "cm-shiori-md-heading" });
const strong = Decoration.mark({ class: "cm-shiori-md-strong" });
const emphasis = Decoration.mark({ class: "cm-shiori-md-emphasis" });
const strikethrough = Decoration.mark({ class: "cm-shiori-md-strikethrough" });
const inlineCode = Decoration.mark({ class: "cm-shiori-md-inline-code" });
const link = Decoration.mark({ class: "cm-shiori-md-link" });
const blockquote = Decoration.line({ class: "cm-shiori-md-blockquote" });
// A folded fence line shrinks to a sliver, so the box is no taller than the
// preview's.
const codeFenceLine = Decoration.line({ class: "cm-shiori-md-code-fence" });
const codeLine = {
  middle: Decoration.line({ class: "cm-shiori-md-code-line" }),
  first: Decoration.line({ class: "cm-shiori-md-code-line cm-shiori-md-code-first" }),
  last: Decoration.line({ class: "cm-shiori-md-code-line cm-shiori-md-code-last" }),
  only: Decoration.line({
    class: "cm-shiori-md-code-line cm-shiori-md-code-first cm-shiori-md-code-last",
  }),
};
const setMarkdownEditorFocused = StateEffect.define<boolean>();
const setMarkdownMetadataEditing = StateEffect.define<boolean>();
const markdownEditorFocused = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setMarkdownEditorFocused)) return effect.value;
    }
    return value;
  },
});
const markdownMetadataEditing = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setMarkdownMetadataEditing)) return effect.value;
    }
    return value;
  },
});

export function collectMarkdownLiveDecorationSpans(
  state: EditorState,
  visibleRanges: readonly TextRange[],
  includeSelectionSource: boolean = true,
): MarkdownLiveDecorationSpan[] {
  const spans: MarkdownLiveDecorationSpan[] = [];
  let sourceRanges = collectSourceRanges(state, includeSelectionSource);
  const frontMatter = frontMatterRange(state);

  if (frontMatter) {
    if (frontMatterIsEditing(state, frontMatter, includeSelectionSource)) {
      sourceRanges.push(frontMatter);
    } else if (metadataHtmlForFrontMatter(state, frontMatter)) {
      sourceRanges = sourceRanges.flatMap((range) =>
        subtractTextRange(range, frontMatter),
      );
    } else {
      sourceRanges.push(frontMatter);
    }
  }

  for (const range of sourceRanges) {
    addVisibleSourceLineSpans(state, spans, range, visibleRanges);
  }

  const parseUpto = Math.max(...visibleRanges.map((range) => range.to), 0);
  const tree = ensureSyntaxTree(state, parseUpto, 8) ?? syntaxTree(state);
  for (const visibleRange of visibleRanges) {
    tree.iterate({
      from: visibleRange.from,
      to: visibleRange.to,
      enter(node) {
        const nodeRange = { from: node.from, to: node.to };
        const name = node.name;
        // A code block keeps its box whether or not the cursor is in it, so
        // stepping into one does not reflow the page; only its fences show.
        if (name === "FencedCode" || name === "CodeBlock") {
          addCodeBlockSpans(state, spans, node.node, visibleRange, sourceRanges);
          return false;
        }
        if (containedByAny(nodeRange, sourceRanges)) return false;

        if (name === "HTMLBlock" || name === "Table") {
          const lineRange = expandToLineRange(state, nodeRange);
          addVisibleSourceLineSpans(state, spans, lineRange, [visibleRange]);
          return false;
        }

        if (intersectsAny(nodeRange, sourceRanges)) return;

        const headingLevel = markdownHeadingLevel(name);
        if (headingLevel !== null) {
          const headingLine = state.doc.lineAt(node.from);
          if (name.startsWith("SetextHeading") && node.from > headingLine.from) {
            const leadingIndent = state.sliceDoc(headingLine.from, node.from);
            if (/^[\t ]+$/.test(leadingIndent)) {
              spans.push({
                from: headingLine.from,
                to: node.from,
                kind: "hidden",
              });
            }
          }
          spans.push({
            from: headingLine.from,
            to: headingLine.from,
            kind:
              headingLevel === 1
                ? "heading1"
                : headingLevel === 2
                  ? "heading2"
                  : headingLevel === 3
                    ? "heading3"
                    : "heading",
          });
          return;
        }

        if (name === "HeaderMark") {
          spans.push({
            ...hiddenHeaderMarkRange(state, nodeRange),
            kind: "hidden",
          });
          return;
        }

        if (
          name === "EmphasisMark" ||
          name === "StrikethroughMark" ||
          name === "LinkMark" ||
          (name === "URL" && node.node.parent?.name !== "Autolink") ||
          name === "CodeMark"
        ) {
          spans.push({ ...nodeRange, kind: "hidden" });
          return;
        }

        if (name === "StrongEmphasis") {
          spans.push({ ...nodeRange, kind: "strong" });
          return;
        }

        if (name === "Emphasis") {
          spans.push({ ...nodeRange, kind: "emphasis" });
          return;
        }

        if (name === "Strikethrough") {
          spans.push({ ...nodeRange, kind: "strikethrough" });
          return;
        }

        if (name === "InlineCode") {
          spans.push({ ...nodeRange, kind: "inlineCode" });
          return;
        }

        if (name === "Link" || name === "Image" || name === "Autolink") {
          spans.push({ ...nodeRange, kind: "link" });
          return;
        }

        if (name === "QuoteMark") {
          spans.push({ ...nodeRange, kind: "hidden" });
          spans.push({
            from: state.doc.lineAt(node.from).from,
            to: state.doc.lineAt(node.from).from,
            kind: "blockquote",
          });
          return;
        }

        if (name === "ListMark") {
          const marker = state.sliceDoc(node.from, node.to);
          spans.push({
            ...nodeRange,
            kind: "listMark",
            text: /^\d/.test(marker) ? marker : "•",
          });
          return;
        }

        if (name === "TaskMarker") {
          const marker = state.sliceDoc(node.from, node.to).toLowerCase();
          spans.push({
            ...nodeRange,
            kind: marker === "[x]" ? "taskChecked" : "taskUnchecked",
          });
        }
      },
    });
  }
  return spans;
}

export function markdownLiveDecorations(metadataEditLabel: string): Extension {
  return [
    markdownEditorFocused,
    markdownMetadataEditing,
    EditorView.domEventHandlers({
      focus(_event, view) {
        view.dispatch({ effects: setMarkdownEditorFocused.of(true) });
      },
      pointerdown(event, view) {
        if (beginMarkdownMetadataEditing(view, event.target, event)) return true;
        if (view.state.field(markdownMetadataEditing, false)) {
          view.dispatch({ effects: setMarkdownMetadataEditing.of(false) });
        }
        return false;
      },
      blur(_event, view) {
        view.dispatch({
          effects: [
            setMarkdownEditorFocused.of(false),
            setMarkdownMetadataEditing.of(false),
          ],
        });
      },
    }),
    EditorView.decorations.compute(
      [markdownEditorFocused, markdownMetadataEditing, "doc", "selection"],
      (state) => buildMarkdownMetadataDecorations(state, metadataEditLabel),
    ),
    EditorView.updateListener.of((update) => {
      keepMetadataSelectionVisible(update);
    }),
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = buildMarkdownLiveDecorations(view);
        }

        update(update: ViewUpdate): void {
          if (
            update.docChanged ||
            update.selectionSet ||
            update.viewportChanged ||
            update.focusChanged ||
            syntaxTree(update.startState) !== syntaxTree(update.state) ||
            update.startState.field(markdownEditorFocused, false) !==
              update.state.field(markdownEditorFocused, false) ||
            update.startState.field(markdownMetadataEditing, false) !==
              update.state.field(markdownMetadataEditing, false)
          ) {
            this.decorations = buildMarkdownLiveDecorations(update.view);
          }
        }
      },
      {
        decorations: (plugin) => plugin.decorations,
      },
    ),
  ];
}

export type MarkdownEditorThemeOptions = {
  zoom: number;
  bodyFontFamily: string;
  codeFontFamily: string;
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  headingColor: string;
};

export function markdownEditorTheme({
  zoom,
  bodyFontFamily,
  codeFontFamily,
  fontSize,
  lineHeight,
  contentWidth,
  headingColor,
}: MarkdownEditorThemeOptions): Extension {
  const scaledFontSize = `${fontSize * zoom}px`;
  return EditorView.theme({
    "&": {
      height: "100%",
      width: "100%",
      backgroundColor: T.paper,
      color: T.ink,
      fontSize: scaledFontSize,
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      height: "100%",
      overflow: "auto",
      fontFamily: bodyFontFamily,
      lineHeight: String(lineHeight),
    },
    ".cm-content": {
      boxSizing: "border-box",
      width: "calc(100% - 32px)",
      maxWidth: `${contentWidth}px`,
      marginInline: "auto",
      flexGrow: "0",
      flexShrink: "1",
      minWidth: "0",
      minHeight: "100%",
      padding: "clamp(28px, 5vw, 72px) clamp(20px, 5vw, 56px) 96px",
      caretColor: T.accent,
    },
    ".cm-line": {
      padding: "0",
    },
    ".cm-cursor": {
      borderLeftColor: T.accent,
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: T.accentSoft,
    },
    ".cm-shiori-md-source-line": {
      fontFamily: codeFontFamily,
      backgroundColor: "transparent",
    },
    // Code blocks match the preview's box (app.css .shioriDocumentViewer pre);
    // token colours are shared with it there too.
    ".cm-line.cm-shiori-md-code-line": {
      fontFamily: codeFontFamily,
      fontSize: "0.8125em",
      backgroundColor: T.cream,
      borderInline: `1px solid ${T.rule}`,
      paddingInline: "16px",
    },
    ".cm-line.cm-shiori-md-code-first": {
      borderTop: `1px solid ${T.rule}`,
      borderTopLeftRadius: "6px",
      borderTopRightRadius: "6px",
      paddingTop: "10px",
      marginTop: "0.4em",
    },
    ".cm-line.cm-shiori-md-code-last": {
      borderBottom: `1px solid ${T.rule}`,
      borderBottomLeftRadius: "6px",
      borderBottomRightRadius: "6px",
      paddingBottom: "10px",
      marginBottom: "0.4em",
    },
    ".cm-line.cm-shiori-md-code-fence": {
      fontSize: "0.7em",
      lineHeight: "1",
    },
    ".cm-shiori-md-code-language": {
      display: "block",
      textAlign: "right",
      color: T.dim,
      userSelect: "none",
    },
    ".cm-shiori-md-metadata-widget": {
      display: "block",
      fontFamily: bodyFontFamily,
      paddingBottom: "28px",
    },
    ".cm-shiori-md-metadata-widget .shioriDocumentMetadata": {
      margin: "0",
    },
    ".cm-shiori-md-metadata-widget:focus-visible": {
      outline: `2px solid ${T.accent}`,
      outlineOffset: "4px",
      borderRadius: "4px",
    },
    ".cm-shiori-md-heading": {
      color: headingColor,
      fontWeight: "700",
      lineHeight: "1.2",
      paddingTop: "0.65em",
    },
    ".cm-shiori-md-h1": {
      fontSize: "1.75em",
    },
    ".cm-shiori-md-h2": {
      fontSize: "1.35em",
    },
    ".cm-shiori-md-h3": {
      fontSize: "1.15em",
    },
    ".cm-shiori-md-strong": {
      fontWeight: "700",
    },
    ".cm-shiori-md-emphasis": {
      fontStyle: "italic",
    },
    ".cm-shiori-md-strikethrough": {
      textDecoration: "line-through",
      textDecorationThickness: "1px",
    },
    ".cm-shiori-md-inline-code": {
      border: `1px solid ${T.rule}`,
      borderRadius: "4px",
      backgroundColor: T.cream,
      fontFamily: codeFontFamily,
      fontSize: "0.9em",
      padding: "0 0.22em",
    },
    ".cm-shiori-md-link": {
      color: T.accentText,
      textDecoration: "underline",
      textUnderlineOffset: "3px",
    },
    ".cm-shiori-md-blockquote": {
      boxSizing: "border-box",
      borderLeft: `2px solid ${T.rule}`,
      paddingLeft: "0.75em",
      color: T.dim,
    },
    ".cm-shiori-md-list-marker": {
      display: "inline-block",
      minWidth: "1.2em",
      color: T.dim,
      userSelect: "none",
    },
    ".cm-shiori-md-task-marker": {
      position: "relative",
      display: "inline-block",
      boxSizing: "border-box",
      width: "0.82em",
      height: "0.82em",
      margin: "0 0.38em 0 0.05em",
      border: `1.5px solid ${T.rule}`,
      borderRadius: "3px",
      verticalAlign: "-0.06em",
      userSelect: "none",
    },
    ".cm-shiori-md-task-marker[data-checked='true']": {
      borderColor: T.accent,
      backgroundColor: T.accent,
    },
    ".cm-shiori-md-task-marker-check": {
      position: "absolute",
      left: "0.23em",
      top: "0.06em",
      width: "0.2em",
      height: "0.42em",
      borderRight: `1.5px solid ${T.onAccent}`,
      borderBottom: `1.5px solid ${T.onAccent}`,
      transform: "rotate(42deg)",
    },
  });
}

function buildMarkdownLiveDecorations(view: EditorView): DecorationSet {
  const visibleRanges =
    view.visibleRanges.length > 0
      ? view.visibleRanges
      : [{ from: 0, to: view.state.doc.length }];
  const ranges = collectMarkdownLiveDecorationSpans(
    view.state,
    visibleRanges,
    view.hasFocus,
  )
    .map(decorationForSpan)
    .filter((range): range is Range<Decoration> => range !== null)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, true);
}

function decorationForSpan(
  span: MarkdownLiveDecorationSpan,
): Range<Decoration> | null {
  if (span.kind === "sourceLine") return sourceLine.range(span.from);
  if (span.kind === "heading1") return heading1.range(span.from);
  if (span.kind === "heading2") return heading2.range(span.from);
  if (span.kind === "heading3") return heading3.range(span.from);
  if (span.kind === "heading") return heading.range(span.from);
  if (span.kind === "strong") return strong.range(span.from, span.to);
  if (span.kind === "emphasis") return emphasis.range(span.from, span.to);
  if (span.kind === "strikethrough") {
    return strikethrough.range(span.from, span.to);
  }
  if (span.kind === "inlineCode") return inlineCode.range(span.from, span.to);
  if (span.kind === "link") return link.range(span.from, span.to);
  if (span.kind === "blockquote") return blockquote.range(span.from);
  if (span.kind === "codeLine") return codeLine[span.edge ?? "middle"].range(span.from);
  if (span.kind === "codeFenceLine") return codeFenceLine.range(span.from);
  if (span.kind === "codeFence") {
    return Decoration.replace({
      widget: new MarkdownCodeFenceWidget(span.text ?? ""),
    }).range(span.from, span.to);
  }
  if (span.kind === "listMark") {
    return Decoration.replace({
      widget: new MarkdownListMarkerWidget(span.text ?? "•"),
    }).range(span.from, span.to);
  }
  if (span.kind === "taskChecked" || span.kind === "taskUnchecked") {
    return Decoration.replace({
      widget: new MarkdownTaskMarkerWidget(span.kind === "taskChecked"),
    }).range(span.from, span.to);
  }
  if (span.from >= span.to) return null;
  return hiddenSyntax.range(span.from, span.to);
}

export function collectMarkdownMetadataDecorationSpans(
  state: EditorState,
  includeSelectionSource: boolean = true,
): MarkdownLiveDecorationSpan[] {
  const frontMatter = frontMatterRange(state);
  if (!frontMatter) return [];
  if (frontMatterIsEditing(state, frontMatter, includeSelectionSource)) {
    return [];
  }
  const html = metadataHtmlForFrontMatter(state, frontMatter);
  return html ? [{ ...frontMatter, kind: "metadata", html }] : [];
}

function buildMarkdownMetadataDecorations(
  state: EditorState,
  metadataEditLabel: string,
): DecorationSet {
  const focused = state.field(markdownEditorFocused);
  const ranges = collectMarkdownMetadataDecorationSpans(state, focused).map(
    (span) =>
      Decoration.replace({
        block: true,
        widget: new MarkdownMetadataWidget(span.html ?? "", metadataEditLabel),
      }).range(span.from, span.to),
  );
  return Decoration.set(ranges, true);
}

function keepMetadataSelectionVisible(update: ViewUpdate): void {
  const frontMatter = frontMatterRange(update.state);
  if (!frontMatter) return;
  const editing = update.state.field(markdownMetadataEditing, false);
  const selectionInFrontMatter = selectionIntersectsRange(
    update.state,
    frontMatter,
  );
  if (editing && !selectionInFrontMatter) {
    update.view.dispatch({ effects: setMarkdownMetadataEditing.of(false) });
    return;
  }
  if (
    !editing &&
    selectionInFrontMatter &&
    update.state.selection.ranges.every((range) => range.empty)
  ) {
    update.view.dispatch({ selection: { anchor: frontMatter.to } });
  }
}

function beginMarkdownMetadataEditing(
  view: EditorView,
  target: EventTarget | null,
  pointerEvent?: PointerEvent,
): boolean {
  if (!metadataWidgetFromTarget(target)) return false;
  const frontMatter = frontMatterRange(view.state);
  if (!frontMatter) return false;
  const anchor = pointerEvent
    ? (metadataClickSourcePosition(view.state, frontMatter, pointerEvent) ??
      frontMatter.from)
    : frontMatter.from;
  view.dispatch({
    selection: { anchor },
    effects: [
      setMarkdownEditorFocused.of(true),
      setMarkdownMetadataEditing.of(true),
    ],
  });
  view.focus();
  pointerEvent?.preventDefault();
  return true;
}

function metadataWidgetFromTarget(target: EventTarget | null): Element | null {
  if (!isNodeLike(target)) return null;
  const element = target.nodeType === 1 ? (target as Element) : target.parentElement;
  return element?.closest(".cm-shiori-md-metadata-widget") ?? null;
}

function metadataClickSourcePosition(
  state: EditorState,
  frontMatter: TextRange,
  event: MouseEvent,
): number | null {
  const cell = metadataCellFromTarget(event.target);
  if (!cell) return null;
  return metadataSourcePositionForEntry(
    state,
    frontMatter,
    cell.entryIndex,
    cell.field,
    textOffsetFromPoint(event, cell.element),
  );
}

function metadataCellFromTarget(target: EventTarget | null): {
  element: Element;
  entryIndex: number;
  field: MetadataField;
} | null {
  if (!isNodeLike(target)) return null;
  const element = target.nodeType === 1 ? (target as Element) : target.parentElement;
  const cell = element?.closest(
    ".cm-shiori-md-metadata-widget dt, .cm-shiori-md-metadata-widget dd",
  );
  if (!cell?.parentElement) return null;
  const siblings = Array.from(cell.parentElement.children).filter(
    (child) => child.tagName === "DT" || child.tagName === "DD",
  );
  const cellIndex = siblings.indexOf(cell);
  if (cellIndex < 0) return null;
  return {
    element: cell,
    entryIndex: Math.floor(cellIndex / 2),
    field: cell.tagName === "DT" ? "key" : "value",
  };
}

function textOffsetFromPoint(event: MouseEvent, container: Element): number {
  const doc = container.ownerDocument as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => globalThis.Range | null;
  };
  const position = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
  if (position && container.contains(position.offsetNode)) {
    return textOffsetWithin(container, position.offsetNode, position.offset);
  }
  const range = doc.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (range && container.contains(range.startContainer)) {
    return textOffsetWithin(container, range.startContainer, range.startOffset);
  }

  const textLength = container.textContent?.length ?? 0;
  const rect = container.getBoundingClientRect();
  if (textLength === 0 || rect.width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  return Math.round(textLength * ratio);
}

function textOffsetWithin(container: Element, node: Node, offset: number): number {
  const range = container.ownerDocument.createRange();
  try {
    range.selectNodeContents(container);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return 0;
  } finally {
    range.detach();
  }
}

function isNodeLike(target: EventTarget | null): target is Node {
  return (
    target !== null &&
    typeof (target as { nodeType?: unknown }).nodeType === "number"
  );
}

export function metadataSourcePositionForEntry(
  state: EditorState,
  frontMatter: TextRange,
  entryIndex: number,
  field: MetadataField,
  textOffset: number = 0,
): number {
  const source = state.sliceDoc(frontMatter.from, frontMatter.to);
  const entry = extractMarkdownFrontMatter(source).metadata[entryIndex];
  if (!entry) return frontMatter.from;

  const candidates = metadataSourceCandidates(source);
  const direct = candidates[entryIndex];
  const candidate =
    direct && metadataKeysMatch(entry.key, direct.key)
      ? direct
      : candidates.find((item) => metadataKeysMatch(entry.key, item.key));
  if (!candidate) return frontMatter.from;

  const from = field === "key" ? candidate.keyFrom : candidate.valueFrom;
  const to = field === "key" ? candidate.keyTo : candidate.valueTo;
  return frontMatter.from + from + clampTextOffset(textOffset, to - from);
}

type MetadataSourceCandidate = {
  key: string;
  keyFrom: number;
  keyTo: number;
  valueFrom: number;
  valueTo: number;
};

type SourceLine = {
  from: number;
  to: number;
  text: string;
};

function metadataSourceCandidates(source: string): MetadataSourceCandidate[] {
  const lines = splitSourceLines(source);
  const opening = /^(---|\+\+\+)[ \t]*\r?\n/.exec(source);
  if (!opening) return [];
  const delimiter = opening[1]!;
  const closeLineIndex = lines.findIndex((line, index) => {
    if (index === 0) return false;
    const trimmed = line.text.trim();
    return delimiter === "---"
      ? trimmed === "---" || trimmed === "..."
      : trimmed === "+++";
  });
  const contentLines =
    closeLineIndex >= 0 ? lines.slice(1, closeLineIndex) : lines.slice(1);
  if (contentLines.length === 0) return [];

  const contentFrom = contentLines[0]!.from;
  const contentTo = contentLines[contentLines.length - 1]!.to;
  const content = source.slice(contentFrom, contentTo).trimStart();
  if (content.startsWith("{")) {
    return jsonMetadataSourceCandidates(source, contentFrom, contentTo);
  }
  if (delimiter === "+++") return tomlMetadataSourceCandidates(contentLines);
  return yamlMetadataSourceCandidates(contentLines);
}

function yamlMetadataSourceCandidates(
  lines: readonly SourceLine[],
): MetadataSourceCandidate[] {
  const candidates: MetadataSourceCandidate[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^[ \t]/.test(line.text)) continue;
    const match = /^([^:#][^:]*?)\s*:\s*(.*)$/.exec(line.text);
    if (!match) continue;
    const keyText = match[1]!;
    const keyStart = line.text.indexOf(keyText);
    const colon = line.text.indexOf(":", keyStart + keyText.length);
    const inlineValueStart = skipHorizontalSpace(line.text, colon + 1);
    const blockValue = inlineValueStart >= line.text.length
      ? yamlBlockValueRange(lines, index)
      : null;
    candidates.push({
      key: normalizeMetadataKey(keyText),
      keyFrom: line.from + keyStart,
      keyTo: line.from + keyStart + keyText.length,
      valueFrom: blockValue?.from ?? line.from + inlineValueStart,
      valueTo: blockValue?.to ?? line.from + line.text.length,
    });
  }
  return candidates;
}

function yamlBlockValueRange(
  lines: readonly SourceLine[],
  keyLineIndex: number,
): TextRange | null {
  for (let index = keyLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.text.trim()) continue;
    if (!/^[ \t]/.test(line.text)) return null;
    const valueStart = skipHorizontalSpace(line.text, 0);
    const bulletStart = line.text.startsWith("- ", valueStart)
      ? valueStart + 2
      : valueStart;
    return {
      from: line.from + bulletStart,
      to: line.from + line.text.length,
    };
  }
  return null;
}

function tomlMetadataSourceCandidates(
  lines: readonly SourceLine[],
): MetadataSourceCandidate[] {
  const candidates: MetadataSourceCandidate[] = [];
  let section = "";
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sectionMatch) {
      section = normalizeMetadataKey(sectionMatch[1]!);
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    const keyText = match[1]!;
    const keyStart = line.text.indexOf(keyText);
    const equals = line.text.indexOf("=", keyStart + keyText.length);
    const valueStart = skipHorizontalSpace(line.text, equals + 1);
    candidates.push({
      key: normalizeMetadataKey(section ? `${section}.${keyText}` : keyText),
      keyFrom: line.from + keyStart,
      keyTo: line.from + keyStart + keyText.length,
      valueFrom: line.from + valueStart,
      valueTo: line.from + line.text.length,
    });
  }
  return candidates;
}

function jsonMetadataSourceCandidates(
  source: string,
  from: number,
  to: number,
): MetadataSourceCandidate[] {
  const candidates: MetadataSourceCandidate[] = [];
  const content = source.slice(from, to);
  const pattern = /"((?:\\.|[^"\\])*)"\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const rawKey = match[1]!;
    const key = parseJsonString(`"${rawKey}"`);
    const keyFrom = from + match.index + 1;
    const valueFrom = from + skipHorizontalSpace(
      content,
      match.index + match[0].length,
    );
    candidates.push({
      key: normalizeMetadataKey(key),
      keyFrom,
      keyTo: keyFrom + rawKey.length,
      valueFrom,
      valueTo: source.indexOf("\n", valueFrom) === -1
        ? to
        : source.indexOf("\n", valueFrom),
    });
  }
  return candidates;
}

function splitSourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let from = 0;
  while (from < source.length) {
    const newline = source.indexOf("\n", from);
    const to = newline === -1 ? source.length : newline + 1;
    lines.push({
      from,
      to,
      text: source.slice(from, to).replace(/\r?\n$/, ""),
    });
    from = to;
  }
  return lines;
}

function metadataKeysMatch(entryKey: string, sourceKey: string): boolean {
  return entryKey === sourceKey || entryKey.endsWith(`.${sourceKey}`);
}

function normalizeMetadataKey(key: string): string {
  return key
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function parseJsonString(value: string): string {
  try {
    return String(JSON.parse(value));
  } catch {
    return value.slice(1, -1);
  }
}

function skipHorizontalSpace(value: string, offset: number): number {
  let cursor = offset;
  while (cursor < value.length && /[ \t]/.test(value[cursor]!)) cursor += 1;
  return cursor;
}

function clampTextOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset) || length <= 0) return 0;
  return Math.max(0, Math.min(Math.round(offset), length));
}

function collectSourceRanges(
  state: EditorState,
  includeSelectionSource: boolean,
): TextRange[] {
  const ranges: TextRange[] = [];
  if (includeSelectionSource) {
    for (const range of state.selection.ranges) {
      const fromLine = state.doc.lineAt(range.from);
      const endPos = range.empty ? range.from : Math.max(range.from, range.to - 1);
      const toLine = state.doc.lineAt(endPos);
      ranges.push({ from: fromLine.from, to: toLine.to });
    }
  }
  return ranges;
}

function metadataHtmlForFrontMatter(
  state: EditorState,
  range: TextRange,
): string {
  return renderMetadataHtml(
    extractMarkdownFrontMatter(state.sliceDoc(range.from, range.to)).metadata,
  );
}

function frontMatterIsEditing(
  state: EditorState,
  frontMatter: TextRange,
  includeSelectionSource: boolean,
): boolean {
  if (!includeSelectionSource) return false;
  return Boolean(
    state.field(markdownMetadataEditing, false) &&
      selectionIntersectsRange(state, frontMatter),
  );
}

function selectionIntersectsRange(state: EditorState, target: TextRange): boolean {
  return state.selection.ranges.some((range) => {
    const from = Math.min(range.from, range.to);
    const to = range.empty ? from + 1 : Math.max(range.from, range.to);
    return from < target.to && to > target.from;
  });
}

class MarkdownMetadataWidget extends WidgetType {
  private readonly html: string;
  private readonly editLabel: string;

  constructor(html: string, editLabel: string) {
    super();
    this.html = html;
    this.editLabel = editLabel;
  }

  override eq(other: MarkdownMetadataWidget): boolean {
    return other.html === this.html && other.editLabel === this.editLabel;
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-shiori-md-metadata-widget";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "button");
    wrapper.setAttribute("aria-label", this.editLabel);
    wrapper.innerHTML = this.html;
    wrapper.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!beginMarkdownMetadataEditing(view, wrapper)) return;
      event.preventDefault();
      event.stopPropagation();
    });
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** A folded code fence: the block's language, or nothing for a closing fence. */
class MarkdownCodeFenceWidget extends WidgetType {
  private readonly language: string;

  constructor(language: string) {
    super();
    this.language = language;
  }

  override eq(other: MarkdownCodeFenceWidget): boolean {
    return other.language === this.language;
  }

  override toDOM(): HTMLElement {
    const label = document.createElement("span");
    label.className = "cm-shiori-md-code-language";
    label.setAttribute("aria-hidden", "true");
    label.textContent = this.language;
    return label;
  }
}

class MarkdownListMarkerWidget extends WidgetType {
  private readonly marker: string;

  constructor(marker: string) {
    super();
    this.marker = marker;
  }

  override eq(other: MarkdownListMarkerWidget): boolean {
    return other.marker === this.marker;
  }

  override toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "cm-shiori-md-list-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = this.marker;
    return marker;
  }
}

class MarkdownTaskMarkerWidget extends WidgetType {
  private readonly checked: boolean;

  constructor(checked: boolean) {
    super();
    this.checked = checked;
  }

  override eq(other: MarkdownTaskMarkerWidget): boolean {
    return other.checked === this.checked;
  }

  override toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "cm-shiori-md-task-marker";
    marker.dataset.checked = String(this.checked);
    marker.setAttribute("aria-hidden", "true");
    if (this.checked) {
      const check = document.createElement("span");
      check.className = "cm-shiori-md-task-marker-check";
      marker.append(check);
    }
    return marker;
  }
}

function frontMatterRange(state: EditorState): TextRange | null {
  const head = state.sliceDoc(0, Math.min(state.doc.length, 64 * 1024));
  const bomOffset = head.charCodeAt(0) === 0xfeff ? 1 : 0;
  const start = /^(---|\+\+\+)[ \t]*\r?\n/.exec(head.slice(bomOffset));
  if (!start) return null;
  const delimiter = start[1]!;
  let offset = bomOffset + start[0].length;

  while (offset < head.length) {
    const lineEnd = head.indexOf("\n", offset);
    const end = lineEnd === -1 ? head.length : lineEnd;
    const line = head.slice(offset, end).trim();
    const closes =
      delimiter === "---"
        ? line === "---" || line === "..."
        : line === "+++";
    if (closes) {
      return { from: bomOffset, to: lineEnd === -1 ? end : end + 1 };
    }
    if (lineEnd === -1) break;
    offset = lineEnd + 1;
  }

  return null;
}

function addSourceLineSpans(
  state: EditorState,
  spans: MarkdownLiveDecorationSpan[],
  range: TextRange,
): void {
  let line = state.doc.lineAt(Math.min(range.from, state.doc.length));
  while (line.from <= range.to) {
    spans.push({ from: line.from, to: line.from, kind: "sourceLine" });
    if (line.number >= state.doc.lines || line.to >= range.to) break;
    line = state.doc.line(line.number + 1);
  }
}

function addVisibleSourceLineSpans(
  state: EditorState,
  spans: MarkdownLiveDecorationSpan[],
  sourceRange: TextRange,
  visibleRanges: readonly TextRange[],
): void {
  for (const visibleRange of visibleRanges) {
    const from = Math.max(sourceRange.from, visibleRange.from);
    const to = Math.min(sourceRange.to, visibleRange.to);
    if (from > to) continue;
    addSourceLineSpans(state, spans, { from, to });
  }
}

/**
 * A fenced or indented code block as a box of code lines. Its fences fold
 * away (the opening one into the block's language) unless the selection is
 * in the block, where they are what the writer edits. The code itself is
 * never Markdown-decorated; its highlighting comes from the nested language.
 */
function addCodeBlockSpans(
  state: EditorState,
  spans: MarkdownLiveDecorationSpan[],
  node: SyntaxNode,
  visibleRange: TextRange,
  sourceRanges: readonly TextRange[],
): void {
  const block = expandToLineRange(state, { from: node.from, to: node.to });
  const first = state.doc.lineAt(block.from).number;
  const last = state.doc.lineAt(block.to).number;
  const from = Math.max(first, state.doc.lineAt(Math.max(block.from, visibleRange.from)).number);
  const to = Math.min(last, state.doc.lineAt(Math.min(block.to, visibleRange.to)).number);
  for (let number = from; number <= to; number += 1) {
    const line = state.doc.line(number);
    spans.push({
      from: line.from,
      to: line.from,
      kind: "codeLine",
      edge:
        first === last
          ? "only"
          : number === first
            ? "first"
            : number === last
              ? "last"
              : undefined,
    });
  }
  if (intersectsAny(block, sourceRanges)) return;
  if (node.name === "CodeBlock") {
    // An indented block's four-column indent is its syntax, as a fence is;
    // the preview drops it, so the folded view does too.
    for (let number = from; number <= to; number += 1) {
      const line = state.doc.line(number);
      const indent = /^(?: {4}|\t)/.exec(line.text);
      if (indent) {
        spans.push({ from: line.from, to: line.from + indent[0].length, kind: "hidden" });
      }
    }
    return;
  }
  const marks = node.getChildren("CodeMark");
  const info = node.getChild("CodeInfo");
  const opening = state.doc.line(first);
  if (marks[0] && opening.from >= visibleRange.from && opening.to <= visibleRange.to) {
    spans.push({ from: opening.from, to: opening.from, kind: "codeFenceLine" });
    spans.push({
      from: opening.from,
      to: opening.to,
      kind: "codeFence",
      text: info ? state.sliceDoc(info.from, info.to) : "",
    });
  }
  // An unclosed fence (mid-typing) has one mark and no closing line.
  const closing = state.doc.line(last);
  if (
    marks.length > 1 &&
    last > first &&
    closing.from >= visibleRange.from &&
    closing.to <= visibleRange.to
  ) {
    spans.push({ from: closing.from, to: closing.from, kind: "codeFenceLine" });
    spans.push({ from: closing.from, to: closing.to, kind: "codeFence", text: "" });
  }
}

function expandToLineRange(state: EditorState, range: TextRange): TextRange {
  const fromLine = state.doc.lineAt(Math.min(range.from, state.doc.length));
  const endPos = range.from === range.to ? range.to : Math.max(range.from, range.to - 1);
  const toLine = state.doc.lineAt(Math.min(endPos, state.doc.length));
  return { from: fromLine.from, to: toLine.to };
}

function intersectsAny(range: TextRange, ranges: readonly TextRange[]): boolean {
  const to = range.from === range.to ? range.to + 1 : range.to;
  return ranges.some((source) => range.from < source.to && to > source.from);
}

function subtractTextRange(range: TextRange, removed: TextRange): TextRange[] {
  if (range.to <= removed.from || range.from >= removed.to) return [range];
  const remainder: TextRange[] = [];
  if (range.from < removed.from) {
    remainder.push({ from: range.from, to: removed.from });
  }
  if (range.to > removed.to) {
    remainder.push({ from: removed.to, to: range.to });
  }
  return remainder;
}

function containedByAny(range: TextRange, ranges: readonly TextRange[]): boolean {
  const to = range.from === range.to ? range.to + 1 : range.to;
  return ranges.some((source) => range.from >= source.from && to <= source.to);
}

function markdownHeadingLevel(name: string): number | null {
  const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Lezer's HeaderMark covers the marker characters but intentionally leaves
 * structural whitespace outside the syntax node. In rendered mode, the
 * opening separator would visibly indent a heading and closing-marker spaces
 * would remain in the DOM. Fold adjacent horizontal whitespace into the same
 * atomic range. Source mode still exposes the original line unchanged.
 */
function hiddenHeaderMarkRange(
  state: EditorState,
  marker: TextRange,
): TextRange {
  const line = state.doc.lineAt(marker.from);
  let from = marker.from;
  while (
    from > line.from &&
    /^[\t ]$/.test(state.sliceDoc(from - 1, from))
  ) {
    from -= 1;
  }

  let to = marker.to;
  while (to < line.to && /^[\t ]$/.test(state.sliceDoc(to, to + 1))) {
    to += 1;
  }
  return { from, to };
}
