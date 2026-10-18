# pdfjs-dist advisory (CLI only)

Re-checked 2026-10-17: the original 2026-08-12 justification cited app code
that no longer exists. `src/pdf/render/annotationLayerPolicy.ts` and its test were
removed with the move to PDFium (`docs/PLAN-RUST-PDF-CORE-2026-09.md`,
AGENTS.md fact 2); the app bundle imports no pdf.js at all, and
`eslint.config.js` rejects any `pdfjs-dist` import outside the engine. So
GHSA-hq66-cqwq-w95j is no longer reachable from the app. `pdfjs-dist@5.6.205`
stays a direct dependency because the CLI still loads it (`cli/src/main.ts`:
the default engine in a source run, and the `SHIORI_PDF_ENGINE=pdfjs`
opt-out in packaged builds, which default to shiori-core) and because
`scripts/pdfium/` uses it as a rendering oracle. `bun audit` still lists the
advisory, now scoped to the CLI.

The first fixed release, PDF.js 6.2.108, is not a drop-in for the CLI: its
audited native canvas packages, SBOM, licences, and packaging for five targets
(darwin-x64 is not built) are pinned to the PDF.js 5 line and must move
atomically.
