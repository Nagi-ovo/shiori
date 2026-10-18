// Block model and parser for the lightweight Markdown the changelog and
// update notice are written in. Split out of markdownView.tsx so that
// file exports only its component — React Fast Refresh gives up on a
// module that mixes components with plain exports.

export type MarkdownBlock =
  | {
      kind: "heading";
      level: number;
      text: string;
      /**
       * Only on a level-2 heading: the release codename, lifted from a
       * `>` line directly beneath it. Rendered on the same row, right of
       * the version.
       */
      aside?: string;
    }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; text: string }
  | {
      kind: "table";
      header: string[];
      /** Per column, from the delimiter row's colons. */
      align: CellAlign[];
      rows: string[][];
    };

import {
  TABLE_DELIMITER,
  TABLE_ROW,
  joinWrapped,
  tableAlign,
  tableCells,
  type CellAlign,
} from "../../release/changelogSyntax";

export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];
  let code: string[] | null = null;
  let table: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length > 0) {
      blocks.push({ kind: "list", items: list });
      list = [];
    }
  };
  const flushQuote = () => {
    if (quote.length > 0) {
      blocks.push({ kind: "quote", lines: quote });
      quote = [];
    }
  };
  // Pipe lines without a delimiter row under the first are not a table;
  // they read on as a paragraph, as Markdown has it.
  const flushTable = () => {
    if (!table) return;
    const [head, delimiter, ...body] = table;
    if (delimiter !== undefined && TABLE_DELIMITER.test(delimiter)) {
      blocks.push({
        kind: "table",
        header: tableCells(head!),
        align: tableAlign(delimiter),
        rows: body.map(tableCells),
      });
    } else {
      blocks.push({ kind: "paragraph", lines: table });
    }
    table = null;
  };

  for (const line of lines) {
    if (!code && TABLE_ROW.test(line)) {
      if (!table) {
        flushParagraph();
        flushList();
        flushQuote();
        table = [];
      }
      table.push(line);
      continue;
    }
    flushTable();
    if (line.startsWith("```")) {
      if (code) {
        blocks.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else {
        flushParagraph();
        flushList();
        flushQuote();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        text: heading[2]!,
      });
      continue;
    }

    // Quote marker, then optional space: "> text" and ">text" both. An
    // empty ">" line keeps the block open so a multi-line quote does not
    // split into two.
    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]!);
      continue;
    }

    const bullet = /^-\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      flushQuote();
      list.push(bullet[1]!);
      continue;
    }

    if (line.trim() === "" || line.trim() === "---") {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    // A soft-wrapped bullet. Markdown lets a list item continue on the
    // following line and the changelog source uses that freely; treating
    // the continuation as a new paragraph splits one entry into two
    // blocks with a gap down the middle of it. The website's parser has
    // always folded these — this one had not.
    if (list.length > 0) {
      list[list.length - 1] = joinWrapped(list[list.length - 1]!, line);
      continue;
    }

    flushQuote();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushQuote();
  flushTable();
  if (code) blocks.push({ kind: "code", text: code.join("\n") });

  // A `>` line directly under a version heading is that release's
  // codename, not a standalone quote — it belongs on the version row,
  // not in a block of its own. Folding it here keeps the rule in one
  // place instead of threading heading state through the line loop, and
  // leaves quotes anywhere else rendering as ordinary quotes.
  const merged: MarkdownBlock[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (
      block.kind === "quote" &&
      previous?.kind === "heading" &&
      previous.level === 2 &&
      !previous.aside
    ) {
      previous.aside = block.lines.reduce(joinWrapped, "");
      continue;
    }
    merged.push(block);
  }

  // Drop a leading level-1 heading if present — callers render their own
  // title row, so the markdown's top `# 更新日志` line would just duplicate it.
  if (merged[0]?.kind === "heading" && merged[0].level === 1) {
    merged.shift();
  }
  return merged;
}
