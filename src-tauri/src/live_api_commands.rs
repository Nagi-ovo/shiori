// IPC side of the desktop Live API (live_api.rs): the main webview publishes
// its document context and answers requests the loopback server forwarded.
// live_api.rs compiles only on desktop; mobile keeps the same three commands
// as stubs that report unsupported-platform.

#[cfg(not(mobile))]
use tauri::State;
use tauri::{Runtime, Webview};

use crate::enforce_main_webview;
#[cfg(not(mobile))]
use crate::live_api;

#[cfg(not(mobile))]
#[tauri::command]
#[specta::specta]
pub(crate) fn live_api_update_context<R: Runtime>(
    caller: Webview<R>,
    state: State<'_, live_api::LiveApiState>,
    context: Option<live_api::LiveApiContext>,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    state.update_context(context)
}

#[cfg(mobile)]
#[tauri::command]
#[specta::specta]
pub(crate) fn live_api_update_context<R: Runtime>(
    caller: Webview<R>,
    context: Option<serde_json::Value>,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    let _ = context;
    Err("unsupported-platform".into())
}

#[cfg(not(mobile))]
#[tauri::command]
#[specta::specta]
pub(crate) fn live_api_authorize_mutation<R: Runtime>(
    caller: Webview<R>,
    state: State<'_, live_api::LiveApiState>,
    request_id: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    state.authorize_mutation(&request_id)
}

#[cfg(mobile)]
#[tauri::command]
#[specta::specta]
pub(crate) fn live_api_authorize_mutation<R: Runtime>(
    caller: Webview<R>,
    request_id: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    let _ = request_id;
    Err("unsupported-platform".into())
}

#[cfg(not(mobile))]
#[tauri::command]
#[specta::specta]
pub(crate) fn live_api_complete<R: Runtime>(
    caller: Webview<R>,
    state: State<'_, live_api::LiveApiState>,
    request_id: String,
    result: live_api::LiveApiCompletionResult,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    state.complete(&request_id, result)
}

#[cfg(mobile)]
#[tauri::command]
#[specta::specta]
pub(crate) fn live_api_complete<R: Runtime>(
    caller: Webview<R>,
    request_id: String,
    result: serde_json::Value,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    let _ = (request_id, result);
    Err("unsupported-platform".into())
}
