// Quit handshake: native exit waits once for the frontend to flush drafts
// (`app-exit-requested` → resolve_app_exit), with a bounded force path, then
// shuts down the Live API, terminal sessions and the Browser panel.
// Desktop only; mobile keeps the commands as unsupported stubs.

#[cfg(not(mobile))]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(not(mobile))]
use tauri::{AppHandle, Manager};
use tauri::{Runtime, Webview};

use crate::enforce_main_webview;
#[cfg(not(mobile))]
use crate::{
    emit_to_main, live_api, runtime_guard::now_ms, terminal, web_panel::WEB_PANEL_LABEL,
    MAIN_WEBVIEW_LABEL,
};

#[cfg(not(mobile))]
static EXIT_AFTER_FRONTEND_FLUSH: AtomicBool = AtomicBool::new(false);

#[cfg(not(mobile))]
static EXIT_GUARD_READY: AtomicBool = AtomicBool::new(false);

#[cfg(not(mobile))]
static EXIT_HANDSHAKE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[cfg(not(mobile))]
static EXIT_HANDSHAKE_STARTED_AT: AtomicU64 = AtomicU64::new(0);

#[cfg(not(mobile))]
const EXIT_FORCE_RETRY_AFTER_MS: u64 = 10_000;

// Every true desktop quit is paused exactly once so the frontend can
// flush PDF drafts, text working copies, and workspace recovery
// pointers. This covers menu/Dock quit, Windows/Linux last-window
// exit, and OS logout instead of relying on one custom menu route.
// A frontend-approved second request performs native cleanup and exits.
// If no listener is ready, emit fails, or the frontend remains stuck,
// the native side always retains a bounded escape path instead of
// creating an application that cannot be closed.
#[cfg(not(mobile))]
pub(crate) fn on_exit_requested<R: Runtime>(app: &AppHandle<R>, api: &tauri::ExitRequestApi) {
    let frontend_available = app.get_webview(MAIN_WEBVIEW_LABEL).is_some();
    let guard_ready = EXIT_GUARD_READY.load(Ordering::SeqCst);
    let exit_approved = EXIT_AFTER_FRONTEND_FLUSH.load(Ordering::SeqCst);
    let handshake_in_flight = EXIT_HANDSHAKE_IN_FLIGHT.load(Ordering::SeqCst);
    let handshake_started_at = EXIT_HANDSHAKE_STARTED_AT.load(Ordering::SeqCst);
    let force_retry_ready = handshake_in_flight
        && handshake_started_at > 0
        && now_ms().saturating_sub(handshake_started_at) >= EXIT_FORCE_RETRY_AFTER_MS;

    if exit_approved || !frontend_available || !guard_ready || force_retry_ready {
        EXIT_AFTER_FRONTEND_FLUSH.store(true, Ordering::SeqCst);
        shutdown_cleanup(app);
    } else {
        api.prevent_exit();
        if !handshake_in_flight {
            EXIT_HANDSHAKE_IN_FLIGHT.store(true, Ordering::SeqCst);
            EXIT_HANDSHAKE_STARTED_AT.store(now_ms(), Ordering::SeqCst);
            if emit_to_main(app, "app-exit-requested", ()).is_err() {
                EXIT_AFTER_FRONTEND_FLUSH.store(true, Ordering::SeqCst);
                EXIT_HANDSHAKE_IN_FLIGHT.store(false, Ordering::SeqCst);
                app.exit(0);
            }
        }
    }
}

// Single shutdown reaper, invoked once from RunEvent::ExitRequested (true app
// quit only — NOT window close, which on macOS fires without quitting and must
// keep live shells + the persistent web-panel alive). Idempotent: it DRAINS the
// session map, so a re-entrant fire is a no-op.
#[cfg(not(mobile))]
fn shutdown_cleanup<R: Runtime>(app: &AppHandle<R>) {
    if let Some(state) = app.try_state::<live_api::LiveApiState>() {
        state.shutdown();
    }
    if let Some(state) = app.try_state::<terminal::TerminalState>() {
        terminal::shutdown_sessions(&state);
    }
    // Best-effort: close the child web-panel webview if one exists. On macOS
    // it is torn down with the parent window anyway — insurance, not the fix
    // for any specific residue.
    if let Some(webview) = app.get_webview(WEB_PANEL_LABEL) {
        let _ = webview.close();
    }
}

#[cfg(not(mobile))]
#[tauri::command]
#[specta::specta]
pub(crate) fn resolve_app_exit<R: Runtime>(
    app: AppHandle<R>,
    caller: Webview<R>,
    allow: bool,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    if allow {
        EXIT_AFTER_FRONTEND_FLUSH.store(true, Ordering::SeqCst);
        app.exit(0);
    } else {
        EXIT_HANDSHAKE_IN_FLIGHT.store(false, Ordering::SeqCst);
        EXIT_HANDSHAKE_STARTED_AT.store(0, Ordering::SeqCst);
    }
    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
#[specta::specta]
pub(crate) fn resolve_app_exit<R: Runtime>(caller: Webview<R>, _allow: bool) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Err("unsupported-platform".into())
}

#[cfg(not(mobile))]
#[tauri::command]
#[specta::specta]
pub(crate) fn set_app_exit_guard_ready<R: Runtime>(
    caller: Webview<R>,
    ready: bool,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    EXIT_GUARD_READY.store(ready, Ordering::SeqCst);
    if !ready {
        EXIT_HANDSHAKE_IN_FLIGHT.store(false, Ordering::SeqCst);
        EXIT_HANDSHAKE_STARTED_AT.store(0, Ordering::SeqCst);
    }
    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
#[specta::specta]
pub(crate) fn set_app_exit_guard_ready<R: Runtime>(
    caller: Webview<R>,
    _ready: bool,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Err("unsupported-platform".into())
}
