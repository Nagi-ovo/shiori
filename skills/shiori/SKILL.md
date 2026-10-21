---
name: shiori
description: >
  Drive Shiori (栞), the local-first PDF reader, through its `shiori` CLI.
  Use whenever the user mentions a PDF they are reading, asks to annotate /
  highlight / mark up a document, asks "where does this document say …",
  or refers to "the file open in Shiori". Also for offline PDF work:
  extracting text, searching with geometry, batch-annotating files.
---

# Shiori CLI — how an agent should drive it

Shiori is a local-first PDF reader/editor. Its `shiori` CLI has two modes:

- **Live mode** — `shiori app …` talks to the document *currently open* in the
  running desktop app, in memory. No files are written.
- **File mode** — `shiori annotate <in.pdf> … -o <out.pdf>` and friends work on
  PDFs on disk. Output paths must be new; existing files are never replaced.

Everything below assumes `--agent` (compact JSON; failures come back as one
JSON envelope on stdout, exit code 2 = usage error, 1 = other).

## The prime directive: answer with a navigation, not a paragraph

In a reader, the best answer to "where does it say X" or "explain this part"
is **an annotation pointing at the passage** — a highlight on the sentence, or
a callout whose label carries your explanation and whose leader points at the
source text. Prefer dropping an anchored annotation over pasting long quotes
back into chat. An anchor must resolve against real document text, so this
style is self-verifying: if you cannot anchor it, the document does not say it.

## Standard workflow (live mode)

1. **Read context first.**
   `shiori app context --agent`
   Returns the active file, page, annotation count, document ID, and SHA-256.
   Never assume which document or page the user means — this is the answer.
   It also returns `annotations`: every annotation that carries text, with its
   id, page, body, anchored quote and callout thread. That is your read path —
   a follow-up like "and the other one?" is only answerable from it, and the
   ids it prints are what `calloutReply` targets. Annotations with nothing to
   read (ink, stamps) are omitted, so the list is shorter than
   `annotationCount`; `annotationsTruncated` means size caps clipped it.
2. **Find the passage.** If you already know the exact wording, skip ahead —
   anchors search for you. Otherwise:
   `shiori text <file> --pages … --agent` or `shiori search <file> "query" --agent`.
3. **Annotate by quote, not coordinates.**
   The spec's `anchor` form — `{ "anchor": { "quote": "…" } }` — makes Shiori
   locate the text and compute all geometry. Only compute coordinates yourself
   for free `text` placements (see below).
   - One quick mark: `shiori app annotate --highlight "exact quoted sentence"`
     (repeatable, no spec file needed).
   - Anything richer: write ONE spec file and apply it in ONE command:
     `shiori app annotate --spec spec.json --base-sha256 <hash from context> --agent`
4. **Validate before writing when the spec is non-trivial:** add `--dry-run`
   to see resolved pages/geometry without changing the document.

Batching matters: a spec holds many annotations and one command applies them
atomically. Never loop one CLI call per annotation.

## Spec essentials

Schema name: `shiori.annotations/v1`. Full authoritative reference:
`shiori help spec --agent` — trust it over memory.

- Round-trippable types: `highlight`, `underline`, `strikethrough`, `note`,
  `callout`, `ink`, `rect`, `stamp`, `text`.
- Placement is either `anchor` (preferred) or explicit `page` + geometry.
  `anchor.quote` must be text that appears in the document; add `page` /
  `occurrence` to disambiguate repeats.
- **`callout` is the conversational annotation**: `targetRects`/`anchor` say
  what it points at, `text` is your message on the label, and Shiori places
  the label automatically when `rect` is omitted. Use it when your answer
  needs more words than a bare highlight.
- **`calloutReply` continues a conversation** (live mode only, never mixed
  with other types in one spec): `{ "type": "calloutReply", "replyTo":
  "<overlay id>", "text": "…", "author": "<your agent name>" }` appends an
  agent turn under an existing callout's thread — the user sees it unfold on
  the page immediately. Get the overlay id from `app context`'s `annotations`
  (or from a previous annotate result's `annotationIds`). When the user asks a
  follow-up inside a callout, read that callout's thread from `app context`
  first, then answer with a calloutReply to THAT callout, not a new
  annotation.
- **Free `text` is not a note and does not auto-anchor.** It needs an explicit
  `rect`; derive one from `shiori search … --agent` geometry (PDF user space,
  points, origin bottom-left) and place it *beside* the source text, never
  covering it. The search result's union rect is a reference bound, not a
  placement.
- To build on existing annotations: `shiori extract <file.pdf> --as-spec`
  emits a spec that `annotate` accepts directly.

## Safety & retry contract (live mode)

- Pass `--base-sha256` from the latest `app context` so the write fails closed
  if the user switched or edited the document meanwhile.
- The CLI derives a stable operation ID from PDF hash + page topology + spec.
  Retrying the *same spec* against the *unchanged* document cannot duplicate
  annotations.
- On `ERR_APP_OUTCOME_UNKNOWN` (timeout / lost response): do NOT assume nothing
  was applied. Run `app context` again, compare both hashes from the error
  detail, and re-run the identical spec — idempotency makes that safe.
- The same spec is the same operation even after the user pressed Undo or
  discarded the draft: it adds nothing and the result says `alreadyApplied`.
  To apply it again on purpose, add `--nonce <new value>`; retry that new
  operation with the same `--nonce` (the error detail repeats it).
- Live mode requires the desktop app running; the CLI only connects to its
  authenticated 127.0.0.1 live API. If connection fails, tell the user to open
  Shiori (or fall back to file mode on a copy).
- Encrypted PDFs are read-only: `annotate` rejects `--password`.

## Reading efficiently (token budget)

- `shiori inspect <file> --agent` first — kind, size, page count — before any
  full-text pull. Add `--metadata`/`--pages` only when needed.
- `shiori text` takes `--pages 1,3-5` and `--max-chars n` (one total budget
  across selected pages). Tighten both; don't slurp whole documents.
- `shiori search` in `--agent` mode already caps results; narrow `--pages`
  when you can.
- `shiori render <file> --page n -o out.png` is a last resort for scanned
  pages/figures with no text layer.
- All command contracts are self-describing: `shiori help <command> --agent`.

## What NOT to do

- Don't write coordinates when an anchor would do.
- Don't apply annotations one command at a time — batch into one spec.
- Don't overwrite existing files; `-o` must be a fresh path (the portable CLI
  refuses in-place replacement by design).
- Don't answer "the document says…" without having anchored or extracted the
  passage — if the anchor fails to resolve, say so instead of paraphrasing
  from memory.
