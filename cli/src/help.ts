// The CLI's general and per-command help, as text and as the JSON payload.
import {
  CLI_VERSION,
  DEFAULT_AGENT_SEARCH_LIMIT,
  DEFAULT_RENDER_SCALE,
  DEFAULT_SEARCH_LIMIT,
  MAX_EXTRACTED_TEXT_CHARACTERS,
  MAX_SEARCH_LIMIT,
} from "./cliDefaults";
import type { CommandName } from "./main";

export function generalHelpText(): string {
  return `Shiori CLI ${CLI_VERSION}

Usage:
  shiori [--agent | --json] <command> [options]
  shiori help [command] [--agent | --json]
  shiori --version [--agent | --json]

Commands:
  inspect   Identify kind, size, page count, metadata.
  text      Extract text from PDF pages, Markdown, or static HTML.
  search    Return page-aware matches with reusable PDF text geometry.
  annotate  Highlight quoted text (--highlight) or apply an annotation spec.
  extract   Read annotations or emit a spec that annotate accepts directly.
  render    Rasterize one PDF page to PNG (for pages without a text layer).
  app       Inspect or annotate the PDF currently open in Shiori.

Global options (may precede the command):
  --agent       Compact JSON to stdout. Failures also return one JSON envelope.
  --json        Pretty JSON to stdout. Failures also return one JSON envelope.
  -h, --help    Show general or command help.
  -V, --version Show the CLI version.
  --            Stop option parsing; use before paths/queries beginning with '-'.

Rules:
  Options are command-specific; unknown options and extra arguments are errors.
  PDF page ranges are strict and 1-based (for example 1,3-5).
  --max-chars limits total extracted text (default/max ${MAX_EXTRACTED_TEXT_CHARACTERS} characters).
  JSON failures use stdout; a short diagnostic is also written to stderr.
  Markdown/HTML input is decoded as UTF-8.
  Exit codes: 0 success, 2 usage errors, 1 other failures.
  version --json returns a bare shiori.cli/version/v1 object, not the
  shiori.cli/v1 envelope.

Help:
  shiori help inspect
  shiori help text
  shiori help search
  shiori help annotate
  shiori help extract
  shiori help render
  shiori help app
  shiori help spec   (annotation spec schema: anchors first, full field list)
  shiori --help --agent`;
}

export function commandHelpText(command: CommandName): string {
  if (command === "inspect") {
    return `Usage:
  shiori inspect <file> [--pages 1,3-5] [--page-info] [--metadata] [--password value] [--agent | --json]

Output:
  kind, file size, and PDF page count. Metadata requires --metadata.
  JSON page boxes require --page-info or --pages; human output includes them.

Token tip:
  Prefer plain inspect first. Add --metadata/--pages only when needed.`;
  }
  if (command === "text") {
    return `Usage:
  shiori text <file> [--pages 1,3-5] [--max-chars n] [--password value] [--agent | --json]

Output:
  PDF: pages[{page,text,characters,truncated}]. Markdown/HTML: text plus truncation.

Token tip:
  --max-chars is one total text budget across selected PDF pages; extraction stops
  when it is exhausted. Default/max: ${MAX_EXTRACTED_TEXT_CHARACTERS} characters.
  JSON framing and human page headings are not counted.`;
  }
  if (command === "search") {
    return `Usage:
  shiori search <file> <query> [--pages 1,3-5] [--limit n] [--password value] [--agent | --json]

Output:
  PDF matches include page, pageOccurrence, anchor, resolved glyph-band rects,
  and their union rect in PDF user space (points, bottom-left origin). A combined
  PDF text run only permits estimated per-character slicing. This geometry suits
  markup anchors; the union is NOT an automatic free-text placement. Choose or
  adjust a text annotation's final rect explicitly. Human output prints it compactly.
  Visual line wraps, line-wrap hyphenation, CJK compatibility forms, and copied
  whitespace are searchable; matches never cross a detected paragraph/column gap.

Token tip:
  --agent defaults to --limit ${DEFAULT_AGENT_SEARCH_LIMIT}; human/JSON defaults to
  ${DEFAULT_SEARCH_LIMIT}; the maximum is ${MAX_SEARCH_LIMIT}. Tighten --pages when possible.`;
  }
  if (command === "annotate") {
    return `Usage:
  shiori annotate <input.pdf> --highlight "quoted text" -o <output.pdf>
  shiori annotate <input.pdf> --spec <spec.json> -o <new-output.pdf> [--agent | --json] [--dry-run] [--base-sha256 hash]

Output:
  --highlight "quoted text" (repeatable) marks the quoted sentence with no
  spec file and no coordinates; Shiori finds the text and computes geometry.
  For other types and batches, --spec takes a shiori.annotations/v1 file —
  anchors ({ "anchor": { "quote": ... } }) are preferred there too; see
  \`shiori help spec\` for the full schema. Supported round-trippable types:
  highlight, underline, strikethrough, note, callout, ink, rect, stamp, and text.
  Free text is not a note and does not auto-anchor over source text: run
  \`shiori search ... --agent\`, then choose an explicit text rect from/around
  the returned PDF-space geometry.
  The portable CLI never replaces an existing file. Legacy --force/--in-place
  requests fail with ERR_NATIVE_ATOMIC_REPLACE_REQUIRED; choose a new -o path.
  Encrypted PDFs are read-only; --password is not accepted by annotate.

Token tip:
  Anchor by quote instead of computing coordinates; use --dry-run to see
  resolved page/geometry before writing. Free text must keep an explicit rect.`;
  }
  if (command === "app") {
    return `Usage:
  shiori app context [--agent | --json]
  shiori app annotate --highlight "quoted text" [--dry-run]
  shiori app annotate --spec <spec.json> [--dry-run] [--base-sha256 hash] [--agent | --json]

Output:
  context reads the active PDF, page, annotation count, document ID, and SHA-256,
  plus every annotation that carries text: its id, type, page, body, anchored
  quote and callout thread. Read it before replying to a follow-up — the id it
  prints is what a calloutReply targets.
  annotate applies annotations to that in-memory document; it does not write
  a PDF file on disk. --highlight "quoted text" (repeatable) needs no spec
  file and no coordinates; --spec accepts anchored or coordinate specs (see
  \`shiori help spec\`). --base-sha256 fails if the target changed.
  Same target topology + spec reuses a stable operation ID for safe retries.

Connection:
  Shiori must be running. The CLI connects only to its authenticated 127.0.0.1
  live API. Set SHIORI_LIVE_API_DESCRIPTOR to an absolute descriptor path only
  for testing; the descriptor must be owned by the invoking user.`;
  }
  if (command === "render") {
    return `Usage:
  shiori render <file.pdf> --page <n> -o <new-output.png> [--scale s] [--password value] [--agent | --json]

Output:
  One page as PNG at --scale (default ${DEFAULT_RENDER_SCALE}; clamped to the canvas pixel
  budget). -o is required and must be new; existing files are never replaced.

Token tip:
  Use render only when text/search cannot help (scanned pages, figures).`;
  }
  return `Usage:
  shiori extract <file.pdf> [--pages 1,3-5] [--password value] [--as-spec] [--agent | --json]

Output:
  Reads PDF annotations as structured data. --as-spec writes pure
  shiori.annotations/v1 JSON that can be redirected directly to annotate.

Token tip:
  Use --pages when only part of a document matters.`;
}

export function helpPayload(target: CommandName | null): unknown {
  const commands = {
    inspect: {
      usage:
        "shiori inspect <file> [--pages 1,3-5] [--page-info] [--metadata] [--agent|--json]",
      does: "kind,size,pageCount; metadata and page boxes only when requested",
      tokenTip: "omit --metadata/--page-info unless needed",
    },
    text: {
      usage: "shiori text <file> [--pages 1,3-5] [--max-chars n] [--agent|--json]",
      does: "extracts text from PDF pages, Markdown, or static HTML",
      tokenTip: `--max-chars defaults to and cannot exceed ${MAX_EXTRACTED_TEXT_CHARACTERS} characters`,
    },
    search: {
      usage: "shiori search <file> <query> [--pages 1,3-5] [--limit n] [--agent|--json]",
      does:
        "returns page-aware matches; PDF results add resolved glyph-band rects (estimated within combined text runs), union bounds, and a reusable markup/note anchor in bottom-left PDF points",
      tokenTip: `agent default limit is ${DEFAULT_AGENT_SEARCH_LIMIT}; human/JSON default ${DEFAULT_SEARCH_LIMIT}; max ${MAX_SEARCH_LIMIT}`,
    },
    annotate: {
      usage:
        "shiori annotate <input.pdf> --highlight \"quoted text\" -o <new-output.pdf> | --spec <spec.json> [--dry-run] [--base-sha256 hash]",
      does: "marks quoted text (anchors compute all geometry) or applies a spec; see `shiori help spec`",
      tokenTip:
        "anchor by quote; --dry-run previews placement; output must be a new path",
    },
    extract: {
      usage:
        "shiori extract <file.pdf> [--pages 1,3-5] [--as-spec] [--agent|--json]",
      does: "reads PDF annotations; --as-spec emits pure annotate input",
      tokenTip: "use --pages to reduce output; quote is informational and rects anchor markup",
    },
    render: {
      usage:
        "shiori render <file.pdf> --page <n> -o <new-output.png> [--scale s] [--agent|--json]",
      does: "rasterizes one page to a new PNG path; existing files are never replaced",
      tokenTip: "only for pages text/search cannot describe (scans, figures)",
    },
    app: {
      usage:
        "shiori app context [--agent|--json] | shiori app annotate --highlight \"quoted text\" | --spec <spec.json> [--dry-run] [--base-sha256 hash]",
      does: "reads or annotates the active in-memory Shiori PDF without writing a PDF file",
      tokenTip: "same target topology + spec has one stable operation ID for safe retries",
    },
  };
  return {
    schema: "shiori.cli/help/v1",
    ...(target ? { command: target, ...commands[target] } : { commands }),
    global: {
      agent: "compact JSON only",
      json: "pretty JSON",
      pages: "1-based PDF page range",
      password: "PDF password",
      help: "-h or --help",
      version: "-V or --version",
      endOfOptions: "--",
      asSpec: "extract-only pure shiori.annotations/v1 output",
      liveDescriptor:
        "SHIORI_LIVE_API_DESCRIPTOR absolute path override for tests; must be owned by the invoking user",
    },
    version: CLI_VERSION,
    rules: [
      "versioned coordinate annotation specs",
      "no HTML script execution",
      "unknown options and extra positional arguments fail with ERR_USAGE",
      "--max-chars is a total extracted-text budget",
      "portable file commands never replace existing outputs",
      "live app requests use authenticated 127.0.0.1 only",
    ],
  };
}
