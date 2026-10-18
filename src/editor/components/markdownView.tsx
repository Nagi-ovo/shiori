import type { ReactNode } from "react";
import { Fragment } from "react";
import { T } from "../../design/tokens";
import type { MarkdownFontStacks } from "./markdownLang";
import { parseMarkdown, type MarkdownBlock } from "./markdownBlocks";
import { joinWrapped } from "../../release/changelogSyntax";

// Shared lightweight Markdown renderer for user-facing prose: the in-app
// changelog (ChangelogModal) and the update notification (UpdateModal) both use
// it so they read identically — natural typography on the surface, not a stiff
// boxed text dump. Supports #/##/### headings, `-` lists, paragraphs, fenced
// code, `>` quotes, GFM tables, and inline `code` / **bold** / *italic* /
// [links](url).

export function MarkdownView({
  markdown,
  fonts,
}: {
  markdown: string;
  fonts: MarkdownFontStacks;
}) {
  return (
    <div style={{ color: T.ink, font: `14px/1.62 ${fonts.sans}` }}>
      {parseMarkdown(markdown).map((block, i) => renderBlock(block, i, fonts))}
    </div>
  );
}

function renderBlock(
  block: MarkdownBlock,
  key: number,
  fonts: MarkdownFontStacks,
): ReactNode {
  // The version row. Version left in the display serif, codename right in
  // the accent, sharing one baseline over a hairline rule — so scrolling
  // the changelog has an obvious "a new release starts here" landmark.
  // The old treatment put 18px sans here and 14px sans on the group
  // headings below, four pixels apart and neither of them anchoring
  // anything.
  if (block.kind === "heading" && block.level === 2) {
    return (
      <div
        key={key}
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 16,
          // `key` is the block index and the level-1 title is already
          // dropped, so the newest release is index 0 and must not push
          // itself off the top of the modal.
          margin: key === 0 ? "0 0 4px" : "38px 0 4px",
          paddingBottom: 10,
          borderBottom: `1px solid ${T.rule}`,
        }}
      >
        <h2
          style={{
            font: `${T.displayStyle} 27px/1.15 ${fonts.serif}`,
            color: T.ink,
            fontVariantNumeric: "tabular-nums",
            margin: 0,
          }}
        >
          {renderInline(block.text, fonts)}
        </h2>
        {block.aside && (
          <span
            style={{
              font: `14px/1.4 ${fonts.serif}`,
              color: T.accentText,
              letterSpacing: ".06em",
              textAlign: "right",
              // Shrinks before the version does; a long English codename
              // wraps rather than shoving the number out of the row.
              flex: "0 1 auto",
              minWidth: 0,
            }}
          >
            {block.aside}
          </span>
        )}
      </div>
    );
  }
  if (block.kind === "heading") {
    if (block.level === 1) {
      return (
        <h1
          key={key}
          style={{
            font: `${T.displayStyle} 24px/1.22 ${fonts.serif}`,
            color: T.ink,
            margin: "0 0 18px",
          }}
        >
          {renderInline(block.text, fonts)}
        </h1>
      );
    }
    // Group headings are labels, not titles: quiet, out of the way of
    // the version above and the prose below. Sans, not mono — a mono
    // stack has no CJK and falls back mid-string, and the wide tracking
    // a mono label wants pulls 「页面与 PDF」 apart into loose glyphs.
    return (
      <h3
        key={key}
        style={{
          font: `600 11px/1.4 ${fonts.sans}`,
          color: T.dim,
          letterSpacing: ".05em",
          textTransform: "uppercase",
          margin: "24px 0 12px",
        }}
      >
        {renderInline(block.text, fonts)}
      </h3>
    );
  }
  // No bullet glyphs: every changelog entry already opens with a bold
  // lead, which separates the items better than a column of discs. What
  // the old version lacked was air — six entries at an 8px gap read as
  // one wall of bold. The rest of each entry drops to ink2 so the lead
  // is what the eye lands on.
  if (block.kind === "list") {
    return (
      <ul
        key={key}
        style={{ margin: "0 0 4px", padding: 0, listStyle: "none" }}
      >
        {block.items.map((item, i) => (
          <li key={i} style={{ margin: "0 0 15px", color: T.ink2 }}>
            {renderInline(item, fonts)}
          </li>
        ))}
      </ul>
    );
  }
  if (block.kind === "quote") {
    return (
      <blockquote
        key={key}
        style={{
          margin: "0 0 16px",
          paddingLeft: 12,
          borderLeft: `2px solid ${T.rule}`,
          color: T.dim,
          // Not italic: CJK has no true italic, so the browser
          // synthesises a slant and a four-character codename comes out
          // visibly skewed. Weight and colour carry the distinction.
          font: `13px/1.6 ${fonts.serif}`,
        }}
      >
        {renderInline(block.lines.reduce(joinWrapped, ""), fonts)}
      </blockquote>
    );
  }
  if (block.kind === "code") {
    return (
      <pre
        key={key}
        style={{
          overflowX: "auto",
          background: T.tint,
          border: `1px solid ${T.rule}`,
          borderRadius: 4,
          padding: 10,
          font: `12px/1.5 ${fonts.mono}`,
        }}
      >
        {block.text}
      </pre>
    );
  }
  if (block.kind === "table") {
    // A measurement table (before / after): hairline rows, figures in
    // tabular numerals so a column of milliseconds lines up digit by digit.
    // Scrolls sideways inside the modal rather than widening it.
    const cellAlign = (column: number) => block.align[column] ?? "left";
    return (
      <div key={key} style={{ overflowX: "auto", margin: "-4px 0 18px" }}>
        <table
          style={{
            borderCollapse: "collapse",
            minWidth: "100%",
            font: `13px/1.45 ${fonts.sans}`,
            fontVariantNumeric: "tabular-nums",
            color: T.ink2,
          }}
        >
          <thead>
            <tr>
              {block.header.map((cell, column) => (
                <th
                  key={column}
                  style={{
                    textAlign: cellAlign(column),
                    font: `600 11px/1.4 ${fonts.sans}`,
                    color: T.dim,
                    letterSpacing: ".04em",
                    padding: "0 0 6px",
                    paddingLeft: column === 0 ? 0 : 16,
                    borderBottom: `1px solid ${T.rule}`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {renderInline(cell, fonts)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                {block.header.map((_, column) => (
                  <td
                    key={column}
                    style={{
                      textAlign: cellAlign(column),
                      padding: "7px 0",
                      paddingLeft: column === 0 ? 0 : 16,
                      borderBottom: `1px solid ${T.rule}`,
                      color: column === 0 ? T.ink2 : T.ink,
                      whiteSpace: column === 0 ? "normal" : "nowrap",
                      verticalAlign: "baseline",
                    }}
                  >
                    {renderInline(row[column] ?? "", fonts)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <p key={key} style={{ margin: "0 0 12px" }}>
      {renderInline(block.lines.reduce(joinWrapped, ""), fonts)}
    </p>
  );
}

function renderInline(text: string, fonts: MarkdownFontStacks): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern =
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    out.push(renderToken(match[0], key, fonts));
    key += 1;
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderToken(
  token: string,
  key: number,
  fonts: MarkdownFontStacks,
): ReactNode {
  if (token.startsWith("`")) {
    return (
      <code
        key={key}
        style={{
          font: `12px/1 ${fonts.mono}`,
          background: T.tint,
          border: `1px solid ${T.rule}`,
          borderRadius: 3,
          padding: "1px 4px",
        }}
      >
        {token.slice(1, -1)}
      </code>
    );
  }
  if (token.startsWith("**"))
    return (
      // Explicit ink: list items render at ink2 so the bold lead is the
      // landing point, and an inherited colour would flatten that back out.
      <strong key={key} style={{ color: T.ink, fontWeight: 600 }}>
        {renderInline(token.slice(2, -2), fonts)}
      </strong>
    );
  if (token.startsWith("*")) return <em key={key}>{renderInline(token.slice(1, -1), fonts)}</em>;

  const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
  if (link) {
    const href = link[2]!.trim();
    // These notes are fetched remotely, so an href is attacker-influenced. Allow
    // only http(s)/mailto; a javascript:/file:/custom-scheme link would be an
    // injection vector in this privileged webview. Unsafe links degrade to plain
    // text (the label renders, the href is dropped).
    const isHttp = /^https?:\/\//i.test(href);
    const isSafe = isHttp || /^mailto:/i.test(href);
    if (isSafe) {
      return (
        <a
          key={key}
          href={href}
          target={isHttp ? "_blank" : undefined}
          rel={isHttp ? "noreferrer" : undefined}
          style={{ color: T.ink, textDecoration: "underline" }}
        >
          {renderInline(link[1]!, fonts)}
        </a>
      );
    }
    return <Fragment key={key}>{renderInline(link[1]!, fonts)}</Fragment>;
  }
  return <Fragment key={key}>{token}</Fragment>;
}
