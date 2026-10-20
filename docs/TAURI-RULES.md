# Tauri rules

Read before adding or changing a Tauri command, capability, permission, plugin
or the updater (`src-tauri/`). Linked from AGENTS.md.

From the official Tauri 2 docs (security/capabilities, develop/calling-rust,
develop/calling-frontend, concept/size, plugin/updater). The 2026-09-23 audit
found the gaps noted in brackets; new code follows the rule.

- Grant commands through the `webviews: ["main"]` capability and
  `AppManifest::commands` in `build.rs`. Child/browser webviews get no
  capability and no `remote` URLs.
- Make a command `async` (or `#[tauri::command(async)]`) whenever it sleeps,
  waits on a process, or does file/PTY I/O — sync commands run on the main
  thread. [`terminal_kill`, `terminal_spawn/write` are still sync.]
- Move bytes with `tauri::ipc::Response` or a raw `Request` body, and
  streams with `tauri::ipc::Channel`; events are for small state changes.
  [Terminal output still streams as events.]
- Commands return `Result` with `map_err`; the release profile sets
  `panic = "abort"`, so a panic in a command is a crash.
- A command that takes a path checks it against what the user granted
  (dialog, drop, file association, mounted folder), not just its extension.
  [The `*_at_path` commands and `list_folder_entries` accept any path.]
- List individual permissions instead of `*:default`; the CSP in
  `tauri.conf.json` only gets tighter, with a written reason beside any new
  source.
- Updater endpoints stay https with the pinned pubkey; updater artifacts are
  signed only through `scripts/build-signed.sh`.

