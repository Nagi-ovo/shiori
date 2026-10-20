# Contributing to Shiori

Thanks for helping. Bug reports, fixes and focused improvements are welcome;
for a larger change, open an issue first so we can agree on the approach.

## Setup

Shiori uses [bun](https://bun.sh) (not npm, yarn or pnpm) and a Rust
toolchain with the `wasm32-unknown-unknown` target.

```bash
bun install
bun run dev         # web app at localhost:1573
bun run tauri:dev   # desktop app
```

## Before you open a pull request

- `bun run verify` must pass (build, lint, tests, website).
- Changes under `crates/` also need `bun run test:core`.
- Changes under `src-tauri/` also need `bun run tauri build`.
- User-visible strings go through `t()` with keys in all three locale files.

Tests should fail when user-visible behavior breaks and survive harmless
refactors; the "Tests" section of `AGENTS.md` describes what that means here.
A bug fix should come with a test or an end-to-end run that fails without it.

`bun install` also installs a pre-commit hook (`.githooks/`) that refuses a
code file over 5,000 tokens (bytes / 4); its message explains how to split
the file. Rules and exclusions live in `scripts/file-size/policy.ts`.

## License of contributions

Shiori is MIT-licensed (`LICENSE`). By submitting a contribution you agree it
is licensed under the same MIT license (inbound = outbound). There is no CLA.
Documentation prose under `docs/` is CC BY 4.0 (`docs/LICENSE`). The Shiori
name and brand assets are covered by `TRADEMARK.md`, not by the MIT license.
