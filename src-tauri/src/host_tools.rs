// Commands that reach the host desktop beyond Shiori's own window: installed
// external terminals (list and launch), agent CLI detection and the system
// font list. Each probe is blocking OS work, so it runs on spawn_blocking and
// never on the WebView/main thread (the ACL test in lib.rs checks this file
// for it). Mobile keeps every command as an unsupported stub.

use tauri::{Runtime, Webview};

use crate::agent_clis;
use crate::enforce_main_webview;
#[cfg(not(mobile))]
use crate::{external_terminals, runtime_guard::enforce_runtime_guard, system_fonts};

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn list_external_terminals<R: Runtime>(
    caller: Webview<R>,
) -> Result<Vec<external_terminals::ExternalTerminalApp>, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    // LaunchServices and executable probes are blocking OS calls. Keep them
    // off the WebView/main thread; a cold `open -Rb` can take over a second.
    tauri::async_runtime::spawn_blocking(external_terminals::installed_external_terminals)
        .await
        .map_err(|_| "external-terminal-unavailable".to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn detect_agent_clis<R: Runtime>(
    caller: Webview<R>,
) -> Result<agent_clis::AgentCliAvailability, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    tauri::async_runtime::spawn_blocking(agent_clis::installed_agent_clis)
        .await
        .map_err(|_| "agent-cli-detection-unavailable".to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn list_system_fonts<R: Runtime>(
    caller: Webview<R>,
) -> Result<Vec<system_fonts::SystemFontFamily>, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    // Font directory and fontconfig reads can be slow on a cold start. Cache
    // the privacy-minimized family list and keep all scanning off the UI thread.
    tauri::async_runtime::spawn_blocking(system_fonts::installed_system_fonts)
        .await
        .map_err(|_| "system-fonts-unavailable".to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn list_system_fonts<R: Runtime>(
    caller: Webview<R>,
) -> Result<Vec<serde_json::Value>, String> {
    enforce_main_webview(&caller)?;
    Err("system-fonts-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn list_external_terminals<R: Runtime>(
    caller: Webview<R>,
) -> Result<Vec<serde_json::Value>, String> {
    enforce_main_webview(&caller)?;
    Err("external-terminal-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn detect_agent_clis<R: Runtime>(
    caller: Webview<R>,
) -> Result<agent_clis::AgentCliAvailability, String> {
    enforce_main_webview(&caller)?;
    Err("agent-cli-detection-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn open_external_terminal<R: Runtime>(
    caller: Webview<R>,
    terminal_id: String,
    working_directory: Option<String>,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    tauri::async_runtime::spawn_blocking(move || {
        external_terminals::open_external_terminal(&terminal_id, working_directory)
    })
    .await
    .map_err(|_| "external-terminal-unavailable".to_string())?
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn open_external_terminal<R: Runtime>(
    caller: Webview<R>,
    _terminal_id: String,
    _working_directory: Option<String>,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Err("external-terminal-unsupported".into())
}
