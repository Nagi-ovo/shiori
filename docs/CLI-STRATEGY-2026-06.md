# Shiori CLI Strategy — Local Document Operating Layer

2026-06-13. Multi-agent research synthesis plus current-code audit.

> **Status (2026-09-23):** the CLI shipped publicly as `cli-v0.1.25`. What
> still holds here is the *why*: the product thesis, audiences, non-goals,
> interaction contract and trust model. Scope and distribution decisions live
> in [CLI-PLAN-2026-07.md](./CLI-PLAN-2026-07.md); the shipped command and
> error contract is `cli/src/helpSpec.ts` and `cli/README.md`. The
> prototype-era architecture, error list and MVP sections were removed.

## Executive Take

Build **Shiori CLI**, but do not frame it as a sidecar automation toy.
The long-term product is a local document operating layer: a tasteful,
scriptable, agent-callable interface for inspecting, transforming, annotating,
and exporting documents without uploading them.

Do **not** start with MCP. MCP can become a thin adapter after the CLI command
handlers and schemas are stable. The durable asset is not a protocol server;
it is Shiori's local document engine.

Language choice: **TypeScript/Bun first** (2026-09: reads and rendering have
since moved to the Rust shiori-core; see "Rust Or TypeScript?"). Rust is a future packaging or
accelerator option, not the first implementation. Shiori's PDF truth already
lives in TypeScript: pdf.js reads, pdf-lib writes, fontkit preserves CJK text,
and the tests already encode the hard-won annotation/export behavior. Rewriting
that in Rust would create two PDF engines on day one.

Verdict: **PURSUE, with discipline.**

## The Product Thesis

Most PDF tools treat the file as an upload, a subscription object, or a GUI-only
artifact. Shiori's edge is the opposite: the file stays local, the PDF remains
portable, and the user's annotations survive outside Shiori.

The CLI extends that promise:

> Shiori CLI is the command line for documents you refuse to upload.

This is a better product shape than "Shiori MCP" because it serves humans,
scripts, Raycast, Obsidian/Zotero workflows, CI, and agents with one interface.
MCP can wrap it later; it should not define it.

## Who It Serves

Primary user:

- Technical readers with local files: researchers, students, engineers,
  writers, archivists.
- People already moving between terminal, Obsidian, Zotero, Raycast, Codex,
  Claude Code, and Finder/Explorer.
- Users who care that a highlighted PDF remains a real PDF, not a database row
  inside one app.

Not the primary user:

- Generic ChatPDF users who expect cloud Q&A.
- People who want semantic search, vector storage, OCR, and LLM chat before
  they have a reliable local document tool.
- Enterprise document-management buyers. Wrong altitude for now.

## What Good Looks Like

A great Shiori CLI should feel closer to `pandoc`, `qpdf`, and `git` than to an
AI plugin. Pandoc's power comes from stable command-line conversion and filters;
qpdf's power comes from predictable local PDF transformations and JSON-oriented
inspection. Shiori should own the higher-level PDF reading/editing lane those
tools do not: text extraction, page-aware search, real annotations, CJK-safe
export, and HTML/Markdown safety.

External references:

- Pandoc positions itself as both a library and command-line tool for document
  conversion, including filter pipelines: https://pandoc.org/MANUAL.html
- qpdf documents a local CLI that reads a PDF, transforms it in memory, and
  writes an output file: https://qpdf.readthedocs.io/en/stable/cli.html
- qpdf explicitly does not render PDFs or provide higher-level page-content
  interfaces, leaving room for Shiori's higher-level document layer:
  https://github.com/qpdf/qpdf
- pdfcpu is a Go API plus CLI for PDF batch workflows:
  https://pdfcpu.io/

## Core Workflows

### 1. Inspect And Search

The smallest valuable loop for agents and humans:

```bash
shiori inspect paper.pdf --agent
shiori text paper.pdf --pages 3-5 --agent
shiori search paper.pdf "QuotaExceededError" --pages 1-20 --agent
```

Why it matters: this gives agents a clean, local, page-aware way to reason about
a PDF without uploading it or guessing through screenshots.

### 2. Annotation Patch Review

Long-term loop:

```bash
shiori annotations list paper.pdf --agent
shiori annotations validate paper.pdf --patch review.json --agent
shiori annotations apply paper.pdf --patch review.json --out paper.reviewed.pdf
```

Rules:

- Patch geometry uses PDF page-local coordinates: points, bottom-left origin.
- CLI-facing pages are always 1-based.
- Writes never modify the source PDF by default.
- A patch is semantic, not a binary diff.

### 3. Local Publishing

Long-term loop:

```bash
shiori document inspect notes.md --agent
shiori convert notes.md --out notes.pdf
shiori convert report.html --remote-images never --out report.pdf
```

This is the bridge from "PDF editor" to "local document finisher". It should
inherit Shiori's HTML safety posture: static/sanitized by default, no script
execution in CLI mode.

### 4. Batch Assembly

Long-term loop:

```bash
shiori merge main.pdf appendix.pdf --insert-after 12 --out packet.pdf
shiori pages apply packet.pdf --plan pages.json --out packet.reordered.pdf
```

This should reuse the same page model as the app and preserve annotations where
possible.

## Explicit Non-Goals

- No cloud upload.
- No ChatPDF clone.
- No built-in vector database in the first product line.
- No OCR in the first CLI generation.
- No in-place overwrite by default.
- No execution of HTML/JS from documents.
- No enumeration of drafts, recents, or the user's filesystem without an
  explicit capability model.
- No Rust rewrite of the PDF engine until there is a measured reason.

## Rust Or TypeScript?

Choose **TypeScript/Bun** for the CLI core.

| Dimension | TypeScript/Bun | Rust |
|---|---|---|
| Existing PDF truth | Directly reuses `src/pdf/*` | Requires rewrite or embedded JS |
| Annotation export | Reuses pdf-lib/fontkit and current tests | High drift risk |
| CJK behavior | Reuses current vector text path | Must re-solve shaping/export |
| Tauri relationship | Separate CLI adapter, no IPC | Current Rust is GUI/platform shell |
| Testing | Extends Bun tests and existing fixtures | Requires parallel golden tests |
| Distribution | Good enough for beta/dev workflows | Better single binary later |
| Long-term maintainability | One semantic PDF engine | Two engines unless carefully avoided |

Rust becomes attractive only when one of these is true:

- Single-binary distribution without a JS runtime becomes a hard requirement.
- Batch processing performance becomes a measured bottleneck.
- A narrow native accelerator is needed for rendering, OCR, or filesystem
  integration.

Until then, Rust should stay in the Tauri/platform lane.

> 2026-09: shipped — the packaged CLI reads and renders through shiori-core
> (napi-rs addon over PDFium, `docs/PLAN-RUST-PDF-CORE-2026-09.md`); writes
> stay on pdf-lib in TypeScript.

## Architecture

As shipped: the CLI is a bun workspace in `cli/` whose command handlers live
in `cli/src/*.ts` and import the app's `src/pdf/**` directly, so geometry and
export move in lockstep with the app. It is packaged as a Node SEA executable
per target (`cli/build.ts`).

## Interaction Contract

### Global Rules

- Human output is concise and readable.
- `--json` returns exactly one JSON object on stdout.
- `--agent` means `--json`, no progress, no color, no interactive prompts.
- Diagnostics and warnings go to stderr.
- Binary output to stdout is only allowed with explicit `-o -`, and cannot be
  mixed with JSON.
- Page arguments are 1-based.
- Internal 0-based indices must be named explicitly if exposed, e.g.
  `sourceIndex0`.

### JSON Envelope

```json
{
  "schema": "shiori.cli/v1",
  "ok": true,
  "command": "inspect",
  "data": {},
  "warnings": [],
  "meta": { "version": 1, "durationMs": 12 }
}
```

Errors:

```json
{
  "schema": "shiori.cli/v1",
  "ok": false,
  "error": {
    "code": "ERR_UNSUPPORTED_DOCUMENT",
    "message": "Supported files are PDF, Markdown, and HTML"
  },
  "warnings": []
}
```

### Agent Ergonomics

The CLI is primarily for agents, so the defaults should save context:

- `--agent` emits compact JSON, not pretty-printed JSON.
- `inspect --agent` returns the minimum useful shape by default: kind, file,
  and page count.
- Expensive fields are opt-in: `--metadata`, `--pages`, `--page-info`.
- Text extraction supports `--max-chars` for sampling.
- Search caps agent output by default and reports whether results were
  truncated.
- `--help --agent` returns machine-readable help so an agent can learn the
  command surface without scraping prose.

This is a product requirement, not polish. Agent-facing tools fail when they are
technically correct but verbose, vague, or inconsistent.

### Safety Envelope For Future Writes

All write commands should support dry-run planning:

```json
{
  "dryRun": true,
  "operation": "annotations.apply",
  "input": { "sha256": "...", "pageCount": 12 },
  "output": { "path": "paper.reviewed.pdf", "exists": false },
  "writes": [{ "path": "paper.reviewed.pdf", "kind": "pdf" }],
  "patch": { "sha256": "...", "ops": 5 }
}
```

Actual write should require:

- explicit input path;
- explicit output path;
- base hash match for semantic patches;
- no output overwrite unless explicitly allowed;
- export integrity validation before finalizing.

## Security And Trust Model

The CLI must be stricter than the GUI because agents can call it repeatedly and
without taste.

Rules:

- Default read-only.
- Never execute document HTML/JS.
- Never recursively scan broad user directories by default.
- Canonicalize paths before write decisions.
- Do not expose drafts as a casual API; drafts contain original PDF bytes and
  full model state.
- Keep recent documents and workspace tabs out of MVP.
- Any future draft/recent access needs a capability prompt or scoped manifest.
- All write outputs are copies by default.

Stable error codes should avoid leaking raw DOM/Dexie/Rust errors as the public
contract. The shipped set is defined in `cli/src/` (search `ERR_`).

## Roadmap

Phases 0–2 (read-only probe, real CLI foundation, annotation and export) have
shipped. Not built: phase 3, local publishing (Markdown/HTML to safe PDF), and
phase 4, adapters (Raycast/Obsidian/Zotero, MCP). MCP stays parked; the agent
surface is the CLI plus the `shiori` skill in `skills/shiori/`.

## Final Recommendation

Pursue Shiori CLI as a first-class product surface, but hold the taste line:
small verbs, stable contracts, local trust, no cloud-shaped feature creep.

MCP remains parked until the CLI has a real command handler layer. The winning
move is not "connect Shiori to agents"; it is "make Shiori the best local
document tool an agent can call."
