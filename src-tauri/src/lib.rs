// Tauri runtime entry for the Shiori desktop shell.
//
// The frontend is the exact same React bundle used by the web build. All
// application logic — rendering, annotation, export, drafts — runs in the
// webview. Rust owns security-sensitive desktop gates such as native beta
// expiry, plus native file dialogs, narrowly-scoped filesystem reads/writes,
// and a few platform integration commands. External PDF links go through one
// small command so the frontend still calls a platform abstraction.

mod agent_clis;
#[cfg(test)]
mod app_commands;
mod app_exit;
mod documents;
#[cfg(not(mobile))]
mod external_terminals;
mod host_tools;
#[cfg(not(mobile))]
mod live_api;
mod live_api_commands;
mod metrics;
mod open_handoff;
#[cfg(not(mobile))]
mod pdf_core;
mod pdf_core_commands;
mod runtime_guard;
#[cfg(not(mobile))]
mod system_fonts;
mod system_open;
mod terminal;
mod web_panel;
mod window_chrome;

use serde::Serialize;
#[cfg(not(mobile))]
use tauri::Manager;
use tauri::{AppHandle, Emitter, EventTarget, Runtime, Webview};

const MAIN_WEBVIEW_LABEL: &str = "main";

// The capability manifest is the primary security boundary, but every app
// command also checks the caller label as defense in depth. This keeps a
// future capability regression from turning the untrusted Browser child
// webview into a filesystem or shell command surface.
fn enforce_main_webview_label(label: &str) -> Result<(), String> {
    if label == MAIN_WEBVIEW_LABEL {
        Ok(())
    } else {
        Err("untrusted-webview".into())
    }
}

fn enforce_main_webview<R: Runtime>(caller: &Webview<R>) -> Result<(), String> {
    enforce_main_webview_label(caller.label())
}

fn emit_to_main<R, S>(app: &AppHandle<R>, event: &str, payload: S) -> tauri::Result<()>
where
    R: Runtime,
    S: Serialize + Clone,
{
    app.emit_to(EventTarget::webview(MAIN_WEBVIEW_LABEL), event, payload)
}

#[cfg(test)]
mod tests {
    use super::{
        app_commands, enforce_main_webview_label, web_panel::WEB_PANEL_LABEL, MAIN_WEBVIEW_LABEL,
    };
    use std::collections::BTreeSet;

    fn permission_commands(source: &str) -> BTreeSet<&str> {
        source
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with('"'))
            .map(|line| line.trim_end_matches(',').trim_matches('"'))
            .collect()
    }

    #[test]
    fn app_command_acl_and_runtime_guard_reject_untrusted_webviews() {
        for (name, source, permission_id) in [
            (
                "desktop",
                include_str!("../capabilities/default.json") as &str,
                "desktop-app-commands",
            ),
            (
                "mobile",
                include_str!("../capabilities/mobile.json") as &str,
                "mobile-app-commands",
            ),
        ] {
            let capability: serde_json::Value = serde_json::from_str(source).unwrap();
            assert_eq!(
                capability["webviews"],
                serde_json::json!([MAIN_WEBVIEW_LABEL]),
                "{name} app commands must be scoped to the main webview label"
            );
            assert!(
                capability.get("windows").is_none(),
                "{name} must not use window-wide capability matching"
            );
            let permissions = capability["permissions"].as_array().unwrap();
            assert!(
                permissions
                    .iter()
                    .any(|permission| permission == permission_id),
                "{name} must explicitly grant the app command permission"
            );
        }

        let desktop_commands =
            permission_commands(include_str!("../permissions/desktop-app-commands.toml"));
        let expected_desktop_commands = app_commands::DESKTOP_APP_COMMANDS
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        assert_eq!(desktop_commands, expected_desktop_commands);

        let mobile_commands =
            permission_commands(include_str!("../permissions/mobile-app-commands.toml"));
        let expected_mobile_commands = app_commands::MOBILE_APP_COMMANDS
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        assert_eq!(mobile_commands, expected_mobile_commands);
        assert!(
            mobile_commands
                .iter()
                .all(|command| !command.starts_with("terminal_")),
            "mobile must never receive embedded-terminal commands"
        );
        assert!(
            [
                "list_external_terminals",
                "detect_agent_clis",
                "list_system_fonts",
                "open_external_terminal",
            ]
            .iter()
            .all(|command| !mobile_commands.contains(command)),
            "mobile must never receive desktop-only font or process commands"
        );
        assert!(
            [
                "live_api_update_context",
                "live_api_authorize_mutation",
                "live_api_complete",
            ]
            .iter()
            .all(|command| !mobile_commands.contains(command)),
            "mobile must never receive the desktop loopback Live API commands"
        );

        // Keep the build-time manifest exactly aligned with the runtime command
        // registration. The commands now flow through tauri-specta's
        // `collect_commands!` in `build_specta_builder` instead of a raw
        // `generate_handler!`, but the alignment guarantee is the same: adding a
        // command without ACL registration must fail this test instead of
        // silently reopening the old bypass.
        let source = include_str!("lib.rs");
        let host_tools_source = include_str!("host_tools.rs");
        assert!(
            host_tools_source
                .contains("spawn_blocking(external_terminals::installed_external_terminals)")
                && host_tools_source.contains("spawn_blocking(agent_clis::installed_agent_clis)")
                && host_tools_source
                    .contains("spawn_blocking(system_fonts::installed_system_fonts)")
                && host_tools_source.contains("spawn_blocking(move ||"),
            "desktop discovery and process launch must stay off the main WebView thread"
        );
        // Registration is split across two macros: the 48 typeable commands go
        // through tauri-specta's `collect_commands!`, and the nine raw-IPC
        // commands (`tauri::ipc::Request` / `Response`, no `specta::Type`) go
        // through a small raw `generate_handler!` composed alongside it in
        // `run()`. Their UNION must equal the manifest — the same alignment
        // guarantee as before: adding a command without ACL registration fails
        // this test instead of silently reopening the old bypass.
        fn macro_command_names(block: &str) -> BTreeSet<&str> {
            block
                .lines()
                .map(str::trim)
                .map(|line| line.trim_end_matches(','))
                // Strip the `::<tauri::Wry>` turbofish collect_commands! requires
                // for the generic commands, then the module path
                // (`documents::save::save_pdf_dialog`): the invoke name is the
                // last segment, exactly as tauri's handler derives it.
                .map(|line| line.split("::<").next().unwrap_or(line).trim())
                .map(|line| line.rsplit("::").next().unwrap_or(line))
                .filter(|line| !line.is_empty())
                .collect()
        }
        let extract_block = |marker: &str| -> String {
            source
                .rsplit_once(marker)
                .and_then(|(_, rest)| rest.split_once("]"))
                .map(|(block, _)| block.to_string())
                .unwrap_or_else(|| panic!("{marker} block"))
        };
        let specta_block = extract_block("collect_commands![");
        let raw_ipc_block = extract_block("generate_handler![");
        let specta_commands = macro_command_names(&specta_block);
        let raw_ipc_commands = macro_command_names(&raw_ipc_block);
        let handler_commands = specta_commands
            .union(&raw_ipc_commands)
            .copied()
            .collect::<BTreeSet<_>>();
        let manifest_commands = app_commands::APP_COMMANDS
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        assert_eq!(handler_commands, manifest_commands);
        let authorized_commands = desktop_commands
            .union(&mobile_commands)
            .copied()
            .collect::<BTreeSet<_>>();
        assert_eq!(authorized_commands, manifest_commands);

        assert_eq!(enforce_main_webview_label(MAIN_WEBVIEW_LABEL), Ok(()));
        assert_eq!(
            enforce_main_webview_label(WEB_PANEL_LABEL),
            Err("untrusted-webview".into())
        );
        assert_eq!(
            enforce_main_webview_label("remote-page"),
            Err("untrusted-webview".into())
        );
    }
}

// tauri-specta is the single source of truth for the IPC type contract. This
// builder collects every typeable registered command and drives BOTH the
// runtime invoke handler in `run()` and the TypeScript binding export test.
//
// The nine excluded commands — `save_pdf_dialog`, `read_document_bytes_at_path`,
// `read_pdf_bytes_at_path` and the six `pdf_core_*` byte commands listed in
// `run()` — take/return `tauri::ipc::Request` / `Response` for
// raw byte transfer, and those IPC types have no `specta::Type` impl (not even
// with tauri's `specta` feature, which tauri-specta enables). Rather than change
// their real signatures to appease specta, they keep their hand-written TS types
// and are dispatched by a small raw `generate_handler!` composed alongside this
// builder in `run()`. The ACL test
// unions both blocks and checks the total equals `app_commands::APP_COMMANDS`.
//
// Not cfg-gated: like the handler list it replaces, every name is listed
// unconditionally and each command's own `#[cfg(mobile)]` / `#[cfg(not(mobile))]`
// arms decide what compiles per platform. Only commands are collected — the
// emit/Channel event system stays hand-written and out of specta's scope.
fn build_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    // Every command is generic over `<R: Runtime>` (each takes `caller:
    // Webview<R>`), so unlike the old generate_handler! — which inferred R from
    // the Builder it was attached to — collect_commands! cannot infer it here and
    // needs the runtime pinned per command with `::<tauri::Wry>`. The ACL
    // alignment test strips this turbofish before comparing against APP_COMMANDS.
    tauri_specta::Builder::<tauri::Wry>::new().commands(tauri_specta::collect_commands![
        documents::open_document_dialog::<tauri::Wry>,
        documents::open_pdf_dialog::<tauri::Wry>,
        documents::pick_folder::<tauri::Wry>,
        documents::classify_open_target::<tauri::Wry>,
        documents::list_folder_entries::<tauri::Wry>,
        window_chrome::set_reader_immersive::<tauri::Wry>,
        documents::read_document_info_at_path::<tauri::Wry>,
        documents::text_images::read_text_document_relative_image::<tauri::Wry>,
        documents::save::write_text_document_at_path::<tauri::Wry>,
        documents::read_pdf_info_at_path::<tauri::Wry>,
        documents::save::share_exported_file::<tauri::Wry>,
        system_open::open_exported_pdf::<tauri::Wry>,
        system_open::reveal_exported_pdf::<tauri::Wry>,
        system_open::open_external_url::<tauri::Wry>,
        host_tools::list_external_terminals::<tauri::Wry>,
        host_tools::detect_agent_clis::<tauri::Wry>,
        host_tools::list_system_fonts::<tauri::Wry>,
        host_tools::open_external_terminal::<tauri::Wry>,
        web_panel::web_panel_open::<tauri::Wry>,
        web_panel::web_panel_navigate::<tauri::Wry>,
        web_panel::web_panel_set_bounds::<tauri::Wry>,
        web_panel::web_panel_hide::<tauri::Wry>,
        web_panel::web_panel_back::<tauri::Wry>,
        web_panel::web_panel_forward::<tauri::Wry>,
        web_panel::web_panel_reload::<tauri::Wry>,
        web_panel::web_panel_close::<tauri::Wry>,
        terminal::terminal_spawn::<tauri::Wry>,
        terminal::terminal_write::<tauri::Wry>,
        terminal::terminal_write_binary::<tauri::Wry>,
        terminal::terminal_resize::<tauri::Wry>,
        terminal::terminal_kill::<tauri::Wry>,
        metrics::get_process_metrics::<tauri::Wry>,
        runtime_guard::runtime_guard_status::<tauri::Wry>,
        open_handoff::drain_pending_open_paths::<tauri::Wry>,
        open_handoff::ack_pending_open_path::<tauri::Wry>,
        app_exit::resolve_app_exit::<tauri::Wry>,
        app_exit::set_app_exit_guard_ready::<tauri::Wry>,
        live_api_commands::live_api_update_context::<tauri::Wry>,
        live_api_commands::live_api_authorize_mutation::<tauri::Wry>,
        live_api_commands::live_api_complete::<tauri::Wry>,
        pdf_core_commands::pdf_core_cancel::<tauri::Wry>,
        pdf_core_commands::pdf_core_close::<tauri::Wry>,
        pdf_core_commands::pdf_core_hide_annotations::<tauri::Wry>,
        pdf_core_commands::pdf_core_outline::<tauri::Wry>,
        pdf_core_commands::pdf_core_links::<tauri::Wry>,
        pdf_core_commands::pdf_core_page_text::<tauri::Wry>,
        pdf_core_commands::pdf_core_page_geometry::<tauri::Wry>,
        pdf_core_commands::pdf_core_security::<tauri::Wry>
    ])
}

// Regenerates the committed `src/platform/bindings.ts` from the command
// signatures above. Run with:
//   cargo test --manifest-path src-tauri/Cargo.toml export_typescript_bindings
// The generated file is committed and type-checked by `bun run build`, so a
// drifted Rust signature breaks the TS build (the point of A4). eslint skips it
// (eslint.config.js globalIgnores) and the file's own `/* eslint-disable */`
// header double-covers it. BigInt→Number keeps u64 fields (`size`, timestamps,
// `memoryBytes`) as TS `number`, matching the hand-written types they replace.
#[cfg(test)]
mod specta_bindings_export {
    #[test]
    fn export_typescript_bindings() {
        build_specta_builder()
            .export(
                specta_typescript::Typescript::default()
                    // u64 fields (`size`, timestamps, `memoryBytes`) export as TS
                    // `number`, matching the hand-written types they replace.
                    .bigint(specta_typescript::BigIntExportBehavior::Number)
                    // eslint skips the file; `@ts-nocheck` stops the strict
                    // tsconfig (noUnusedLocals) from tripping on the unused event
                    // scaffolding specta always emits. The EXPORTED types stay
                    // fully typed, so command call sites are still type-checked —
                    // that is where a drifted Rust signature breaks the TS build.
                    .header("/* eslint-disable */\n// @ts-nocheck\n"),
                "../src/platform/bindings.ts",
            )
            .expect("failed to export TypeScript bindings");
        // specta currently leaves padding spaces on a few generated blank
        // lines. Normalize only line endings/whitespace after generation so
        // `git diff --check` remains a useful release gate.
        let path = "../src/platform/bindings.ts";
        let generated =
            std::fs::read_to_string(path).expect("failed to read generated TypeScript bindings");
        let normalized = generated
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(path, normalized)
            .expect("failed to normalize generated TypeScript bindings");
    }

    use super::build_specta_builder;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Startup breadcrumb — debug only. Release users launch from Finder
    // or Dock and never see stderr.
    #[cfg(debug_assertions)]
    eprintln!("[shiori] starting, registering plugins…");

    let builder = tauri::Builder::default()
        .manage(terminal::TerminalState::default())
        .manage(web_panel::WebPanelState::default());
    #[cfg(not(mobile))]
    let builder = builder.manage(live_api::LiveApiState::default());

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        open_handoff::on_second_instance,
    ));

    let builder = builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_opener::init());
    // Backs the in-rail embedded Browser panel on tablets with a native
    // WKWebView (iOS) / WebView (Android). The #[cfg(mobile)] web_panel_* arms
    // forward to it. Desktop uses the child-webview path and never loads this.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_shiori_browser::init());
    // Android native process metrics (CPU/memory) for the resource panel, read
    // by get_process_metrics via run_mobile_plugin. iOS uses Mach and desktop
    // uses sysinfo directly in collect_process_metrics, so this plugin is
    // Android-only (AGENTS.md fact #7 — every plugin must be `.plugin()`-ed).
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_shiori_metrics::init());
    // Updater downloads and verifies the new bundle; process is the
    // plugin the JS side uses to relaunch the app afterward. Both
    // must be registered on desktop or Tauri will surface a runtime
    // "plugin X not found" error from JS — see docs/POSTMORTEMS.md.
    // Mobile updates are owned by App Store / Play Store.
    #[cfg(not(mobile))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Persist and restore the main window's frame across launches.
        // VISIBLE is excluded from the saved flags on purpose: a window
        // quit while hidden must still reappear on the next launch rather
        // than restore invisible with no way to summon it.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        );

    // Command registration now flows through tauri-specta. build_specta_builder
    // collects every typeable command and its invoke_handler() dispatches them;
    // the remaining nine transfer raw bytes via tauri::ipc::Request / Response
    // (which have no specta::Type) and are dispatched by a small raw
    // generate_handler!.
    // The composed handler peeks the command name and routes to the right
    // dispatcher — command names, argument shapes, and the invoke path are all
    // unchanged, so runtime behavior is identical to the single generate_handler!
    // this replaces; only the TS type contract is now generated
    // (src/platform/bindings.ts) for the 48 collected commands.
    let specta_invoke_handler = build_specta_builder().invoke_handler();
    // Box behind a concrete type so the runtime resolves to Wry: a bare `let`
    // from generate_handler! has no Builder or argument to infer R from.
    let raw_ipc_invoke_handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![
            documents::save::save_pdf_dialog,
            documents::read_document_bytes_at_path,
            documents::read_pdf_bytes_at_path,
            pdf_core_commands::pdf_core_open,
            pdf_core_commands::pdf_core_render,
            pdf_core_commands::pdf_core_decrypted_copy,
            pdf_core_commands::pdf_core_page_fonts,
            pdf_core_commands::pdf_core_font_outlines,
            pdf_core_commands::pdf_core_encrypt_like_source
        ]);
    // The `Invoke<tauri::Wry>` annotation pins the runtime so the raw
    // generate_handler! closure above (bound to a `let`, with no Builder to infer
    // from) resolves to Wry — the same runtime tauri::Builder::default() uses.
    let builder = builder.invoke_handler(move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
        // Own the command name before moving `invoke` into a dispatcher: this
        // releases the borrow so either arm can take `invoke` by value.
        let command = invoke.message.command().to_string();
        if matches!(
            command.as_str(),
            "save_pdf_dialog"
                | "read_document_bytes_at_path"
                | "read_pdf_bytes_at_path"
                | "pdf_core_open"
                | "pdf_core_render"
                | "pdf_core_decrypted_copy"
                | "pdf_core_page_fonts"
                | "pdf_core_font_outlines"
                | "pdf_core_encrypt_like_source"
        ) {
            raw_ipc_invoke_handler(invoke)
        } else {
            specta_invoke_handler(invoke)
        }
    });

    #[cfg(not(mobile))]
    let builder = builder.on_menu_event(window_chrome::on_menu_event);

    builder
        .setup(|app| {
            #[cfg(not(mobile))]
            {
                let dirs = pdf_core_commands::pdfium_library_dirs(app.handle());
                app.manage(pdf_core::PdfCoreService::start(dirs));
            }
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            open_handoff::enqueue_launch_args();

            // Native window menu (App / File / Edit / View / Window) on
            // every desktop platform: macOS shows it in the system bar,
            // Windows/Linux attach it to the window. build_app_menu omits
            // the macOS-only app items (Services / Hide / …) off-macOS.
            #[cfg(not(mobile))]
            {
                let menu = window_chrome::build_app_menu(app.handle())?;
                app.set_menu(menu)?;
            }
            // Windows: the menu stays attached but out of sight. A Win32 menu
            // bar under the title bar made the window look like a 2005 app,
            // and every item already has an in-app control. Hidden, not
            // removed: tauri translates accelerators through the menu's
            // HACCEL and muda dispatches WM_COMMAND from its window subclass,
            // neither of which needs the HMENU attached, so every shortcut
            // behaves exactly as before. Linux keeps its menu bar: GTK refuses
            // to activate an accelerator whose menu item is not visible.
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                window.hide_menu()?;
            }

            // File logger on in both debug and release so a crash leaves
            // a trace. The OS log dir for our identifier:
            //   macOS   ~/Library/Logs/fun.nagi.shiori/Shiori.log
            //   Linux   ~/.config/fun.nagi.shiori/logs/
            //   Windows %APPDATA%\fun.nagi.shiori\logs\
            // Stdout target is debug-only. Release drops to Warn to keep
            // the log file from filling with info chatter.
            // `mut` is only used in the debug-assertions branch below,
            // but release builds drop the push — suppress the warning.
            #[allow(unused_mut)]
            let mut targets = vec![tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::LogDir { file_name: None },
            )];
            #[cfg(debug_assertions)]
            targets.push(tauri_plugin_log::Target::new(
                tauri_plugin_log::TargetKind::Stdout,
            ));
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(if cfg!(debug_assertions) {
                        log::LevelFilter::Info
                    } else {
                        log::LevelFilter::Warn
                    })
                    .targets(targets)
                    .build(),
            )?;
            #[cfg(not(mobile))]
            if let Err(error) = app
                .state::<live_api::LiveApiState>()
                .start(app.handle().clone())
            {
                log::error!("[shiori] Live API startup failed: {error}");
            }
            #[cfg(debug_assertions)]
            log::info!("[shiori] setup complete — native plugins registered");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &event {
                open_handoff::on_opened(app, urls);
            }
            // The Live API must not keep serving a destroyed main webview's
            // context (macOS window close keeps the app alive in the Dock).
            // Clear it and fail any in-flight request immediately instead of
            // letting the CLI hang for the full frontend timeout.
            #[cfg(not(mobile))]
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                if label == MAIN_WEBVIEW_LABEL {
                    if let Some(state) = app.try_state::<live_api::LiveApiState>() {
                        state.on_main_webview_destroyed();
                    }
                }
            }
            #[cfg(not(mobile))]
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                app_exit::on_exit_requested(app, api);
            }
            let _ = (app, &event);
        });
}
