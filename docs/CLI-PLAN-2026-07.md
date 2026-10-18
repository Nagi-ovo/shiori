# Shiori CLI — Scope and Decisions

Written 2026-07-05, reconciled with what shipped on 2026-09-23. The product
thesis ("the command line for documents you refuse to upload", CLI before MCP)
lives in [CLI-STRATEGY-2026-06.md](./CLI-STRATEGY-2026-06.md) and is not
restated here. The shipped command contract is `cli/src/helpSpec.ts`; the
user-facing description, annotation schema and safety rules are in
`cli/README.md`.

## Status

Public since `cli-v0.1.25` (2026-09-13). Commands:
`inspect`, `text`, `search`, `render`, `extract`, `annotate` (coordinate and
quote forms), and the live-app pair `app context` / `app annotate`.

## The core bet: a two-way agent loop

The differentiated feature is not "an agent can highlight a PDF" but the round
trip:

1. Agent writes annotations → human reviews them in Shiori.
2. Human highlights/comments in Shiori → agent reads them back as structured
   data (quote + page + position + note text).

No free PDF tool owns this loop. It composes with the 2026-07-05 product
direction: zero backend, pure opener, annotations travel with the file as
standard PDF annots.

## Scope line

**The CLI only does what the Shiori app itself can do.** Out of scope: OCR,
semantic search, chat, encryption, and anything that turns it into a pdftk
clone. Not built but inside the line, because the pipeline already exists:
`merge` (`appendPdf.ts`), `watermark` (overlay + flatten), `pages`
(rotate/delete/reorder as model ops).

## Location

`cli/` is a bun workspace in this repo importing `src/pdf/**` directly: the
CLI must move in lockstep with the overlay model and export pipeline. The
engine for reading and rendering is shiori-core (Rust over PDFium,
`docs/PLAN-RUST-PDF-CORE-2026-09.md`); stages 4–5 shipped: the packaged CLI
reads and renders through it.

## Distribution

A self-contained Node SEA archive per target on its own `cli-v*` tag
namespace; installers, targets and the routing gotchas are in `cli/README.md`.

## Licensing

MIT, like the app (2026-10-17; reverses the 2026-07-05 closed-source
decision). The `shiori.annotations/v1` spec that `annotate` reads and
`extract --as-spec` writes stays the public contract; MCP, if it comes, wraps
the CLI and inherits the same spec.
