# src-tauri/src/lib.rs → domain modules

2026-10-06 · done.

## Why

`src-tauri/src/lib.rs` grew to ~5,900 lines: 57 Tauri commands (110
`#[tauri::command]` items, mostly desktop/mobile pairs), the Browser panel,
the embedded terminal and its `open` routing, process metrics, the exit
handshake, the native menu, file-open handoff and the builder in `run()`.
Every change to one domain scrolls past all the others, and per-platform
`cfg` gates are hard to audit when a domain's pieces sit 3,000 lines apart.
The split is for cohesion, with zero behavior change; line counts are not a
goal.

## Target

```
src-tauri/src/
  lib.rs                 mod decls, the main-webview guard (MAIN_WEBVIEW_LABEL,
                         enforce_main_webview, emit_to_main), the ACL test,
                         build_specta_builder, the bindings export test and the
                         whole run() builder, unchanged in order
  runtime_guard.rs       beta-expiry status, enforce_runtime_guard, now_ms
  metrics.rs             get_process_metrics (sysinfo / iOS Mach / Android plugin)
  window_chrome.rs       native menu (build_app_menu, on_menu_event),
                         set_reader_immersive
  open_handoff.rs        pending-open queue, argv / second-instance / Opened
  live_api_commands.rs   live_api_* commands (live_api.rs is desktop-only)
  host_tools.rs          external terminals, agent CLIs, system fonts commands
  system_open.rs         open / reveal exported PDFs, open_external_url
  web_panel.rs           embedded Browser panel (child webview / mobile plugin)
  terminal/mod.rs        embedded PTY terminal
  terminal/open_routing.rs  terminal `open https://…` → Browser panel shims
  app_exit.rs            exit handshake, shutdown cleanup
  pdf_core_commands.rs   pdf_core_* commands (pdf_core.rs is desktop-only)
  documents/mod.rs       pickers, document/PDF info and bytes, folder listing
  documents/text_images.rs  Markdown/HTML relative images
  documents/save.rs      save/export, text write-back, mobile share
  (unchanged) agent_clis.rs, app_commands.rs, external_terminals.rs,
  live_api.rs, pdf_core.rs, system_fonts.rs
```

`*_commands.rs` files exist because `live_api.rs`, `pdf_core.rs` and
`system_fonts.rs` compile only on desktop, while each command also needs its
mobile stub. Recents and workspace tabs have no Rust; the updater is only
`.plugin()` lines in `run()`.

## Invariants

1. **Invoke names do not change.** Commands keep their names; only their
   module moves. `src/platform/bindings.ts` stays byte-identical, and
   `APP_COMMANDS`, the permission TOMLs and capabilities are untouched.
2. **Moved commands are `pub(crate)`.** `#[tauri::command]` and
   `#[specta::specta]` emit `#visibility use <wrapper macro>`, so a private
   command's wrapper is invisible to `collect_commands!` /
   `generate_handler!` in lib.rs. Both macros take module paths
   (`documents::save::save_pdf_dialog`); the invoke name is the last segment.
3. **The ACL test reads lib.rs as text.** It takes each entry's last `::`
   segment after stripping `::<…>`, and finds the two macro blocks with
   `rsplit_once`, so lib.rs must contain no `collect_commands![` or
   `generate_handler![` text after the real ones in `build_specta_builder`
   and `run()`. The "stays off the main thread" source check reads
   `host_tools.rs`.
4. **Every `cfg` pair moves together** with the same gate (`mobile` alias,
   iOS Mach structs, Android metrics plugin, Windows `hide_menu`, Windows /
   Linux single-instance and argv, macOS / iOS `RunEvent::Opened`).
5. **`run()` keeps its order:** `.manage()` first, single-instance as the
   first plugin, every `.plugin()` in place, setup as PdfCoreService → argv
   → menu → Windows hide_menu → log plugin → Live API start. Closure bodies
   become calls (`open_handoff::on_second_instance`,
   `open_handoff::enqueue_launch_args`, `open_handoff::on_opened`,
   `window_chrome::on_menu_event`, `app_exit::on_exit_requested`).
6. **Tests move with their domain** (`#[cfg(test)] mod tests` per module);
   the ACL and bindings export tests stay in lib.rs.

## Gate per step

`cargo fmt --check`; `cargo clippy --all-targets` and `cargo check` for
aarch64-apple-ios, aarch64-linux-android, x86_64-pc-windows-msvc and
x86_64-unknown-linux-gnu with no diagnostic that the base lacked (the base
has pre-existing warnings); `cargo test`; `bindings.ts` and
`gen/schemas/acl-manifests.json` byte-identical to the base. `bun run tauri
build` after steps 4, 9 and 11c; `bun run verify` at the end.

The Windows and Linux checks run from macOS with zig as the C compiler and
stub `pkg-config` / `llvm-rc` (check only, nothing links); they type-check
the `cfg(windows)` / Linux arms but are no substitute for the release CI
builds.

Out of scope: renaming commands, the TAURI-RULES sync→async fixes,
events→channels, merging the specta and raw dispatchers, plugin reordering,
renaming `pdf_core.rs` / `live_api.rs`, and `app_commands.rs` / `build.rs`.
