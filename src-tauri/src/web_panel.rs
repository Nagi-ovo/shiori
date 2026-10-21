// Browser panel commands. Desktop hosts the page in a native child webview
// of the main window and reports navigation as `web-panel-nav` events; iOS
// and Android hand the page to the shiori-browser plugin.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
#[cfg(not(mobile))]
use tauri::Manager;
use tauri::{AppHandle, Runtime, Webview};
#[cfg(not(mobile))]
use tauri::{LogicalPosition, LogicalSize};

use crate::{enforce_main_webview, runtime_guard::enforce_runtime_guard};

mod navigation;
pub(crate) use navigation::parse_web_url;
#[cfg(not(mobile))]
mod create;
#[cfg(not(mobile))]
use create::create_web_panel;
#[cfg(not(mobile))]
use navigation::emit_web_panel_nav;

// Embedded Browser panel. Web content lives in a native child webview
// (label `web-panel`) of the main window, created lazily on first open.
// That webview is deliberately granted NO app-command capability: build.rs
// registers a real application ACL manifest and capabilities/default.json
// grants its permission only to `main`. Every command also checks the caller
// label, so remote pages cannot reach Shiori's file/pdf/terminal commands even
// if a future capability edit regresses.
pub(crate) const WEB_PANEL_LABEL: &str = "web-panel";

// The Browser panel is a narrow side rail. WKWebView gives a desktop page
// (no mobile viewport meta) a ~980px layout viewport, so a desktop site
// overflows the panel and scrolls horizontally. A mobile Safari UA makes
// responsive sites serve their device-width layout, which reflows to the
// panel's real width and fits without horizontal scroll.
const WEB_PANEL_USER_AGENT: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

#[derive(Default)]
pub(crate) struct WebPanelState {
    inner: Mutex<WebPanelInner>,
}

// A linear history of committed URLs plus a cursor. Tracked purely to
// drive the address bar and back/forward enablement — actual traversal
// uses the webview's own history via `history.back()/forward()`. A commit
// is a traversal only when the panel's own Back/Forward asked for one
// (`pending_steps`, negative for Back) and the URL is an entry within those
// steps; anything else, a link back to the previous page included, is a new
// entry.
#[derive(Default)]
struct WebPanelInner {
    history: Vec<String>,
    cursor: usize,
    pending_steps: i32,
    persist_session: Option<bool>,
    // Whether the child webview is currently shown. Lets set_bounds skip a
    // redundant show() every frame: on Windows WebView2, Show() forces a
    // visibility/occlusion recompute, unlike macOS WKWebView which coalesces
    // it cheaply. show() fires only on a hidden->visible transition.
    visible: bool,
    // True for the duration of `window.add_child` (synchronous controller
    // creation). On Windows that call runs a NESTED message pump
    // (`webview2_com::wait_with_pump` -> `GetMessageA(None)`/`DispatchMessageA`)
    // on the main thread while the WebView2 controller is still half-built; any
    // IPC queued concurrently (the frontend fires `web_panel_set_bounds` from
    // an independent rAF/ResizeObserver right as the panel opens) can be
    // dispatched RE-ENTRANTLY inside that pump and call SetBounds/SetIsVisible
    // on the controller mid-creation. Geometry-mutating commands check this and
    // stash the pending bounds instead of touching wry; we flush once after
    // creation returns. macOS WKWebView never re-enters, so this is inert there.
    creating: bool,
    // Desired visibility/geometry requested WHILE `creating` was true, replayed
    // once add_child returns. The native webview is an OS-level top layer (it
    // ignores DOM stacking — see POSTMORTEMS 2026-05-30), so if a hide that
    // arrives mid-creation were simply dropped, the panel would float over
    // Settings / a non-Browser tab and never come down (the frontend sends hide
    // exactly once per shouldShow=false transition; it does not poll). So we
    // record intent instead of dropping it. `pending_bounds` and `pending_hide`
    // are mutually exclusive: a set_bounds (only sent while shouldShow=true)
    // clears pending_hide; a hide clears pending_bounds. Last writer wins, which
    // matches the frontend driving both off the same shouldShow state.
    pending_bounds: Option<WebPanelBounds>,
    pending_hide: bool,
}

#[derive(Deserialize, Clone, Copy, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebPanelBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

// Button labels for the page's JavaScript alert/confirm/prompt, which iOS
// draws itself (UIAlertController) and native code has no t() for. Desktop
// and Android show their engine's own dialogs and ignore them.
#[derive(Deserialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebPanelDialogLabels {
    #[cfg_attr(not(mobile), allow(dead_code))]
    ok: String,
    #[cfg_attr(not(mobile), allow(dead_code))]
    cancel: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebPanelOpenRequest {
    pub(crate) url: String,
}

fn lock_web_panel(state: &WebPanelState) -> std::sync::MutexGuard<'_, WebPanelInner> {
    state.inner.lock().unwrap_or_else(|err| err.into_inner())
}

#[cfg(not(mobile))]
fn apply_web_panel_bounds<R: Runtime>(webview: &Webview<R>, bounds: &WebPanelBounds) {
    let _ = webview.set_position(LogicalPosition::new(bounds.x, bounds.y));
    let _ = webview.set_size(LogicalSize::new(
        bounds.width.max(1.0),
        bounds.height.max(1.0),
    ));
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn web_panel_open<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    url: String,
    bounds: Option<WebPanelBounds>,
    persist_session: Option<bool>,
    _dialog_labels: Option<WebPanelDialogLabels>,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    let parsed = parse_web_url(&url)?;
    let persist_session = persist_session.unwrap_or(true);
    // Fresh "open" intent resets history; seed it so the address bar shows
    // the target immediately (on_navigation no-ops on the matching URL).
    let recreate_for_session_mode = {
        let state = app.state::<WebPanelState>();
        let mut inner = lock_web_panel(&state);
        let recreate = inner
            .persist_session
            .is_some_and(|current| current != persist_session);
        inner.history.clear();
        inner.cursor = 0;
        inner.pending_steps = 0;
        inner.history.push(parsed.to_string());
        inner.persist_session = Some(persist_session);
        recreate
    };
    if let Some(webview) = app.get_webview(WEB_PANEL_LABEL) {
        if recreate_for_session_mode {
            webview.close().map_err(|err| err.to_string())?;
            // create_web_panel owns the post-create visibility (it replays any
            // hide/bounds that raced creation and sets `visible`).
            create_web_panel(&app, parsed, bounds, persist_session)?;
        } else {
            webview.navigate(parsed).map_err(|err| err.to_string())?;
            if let Some(bounds) = &bounds {
                apply_web_panel_bounds(&webview, bounds);
            }
            webview.show().map_err(|err| err.to_string())?;
            // Existing webview, no creation race: this branch genuinely shows it.
            lock_web_panel(&app.state::<WebPanelState>()).visible = true;
        }
    } else {
        // create_web_panel owns the post-create visibility (see above).
        create_web_panel(&app, parsed, bounds, persist_session)?;
    }
    // Defer this emit off the IPC COM-callback stack, same as the on_navigation
    // emit. web_panel_open is a sync command that on Windows runs on the main
    // thread inside WebView2's IPC COM callback; a synchronous emit here would
    // inline-run eval -> send_user_message, re-entering the message pump while
    // that callback (and, on the first open, the just-returned add_child path)
    // is still unwinding. Hopping to a worker forces the queued send_user_message
    // branch so the eval lands on a clean tick. Inert/identical on macOS.
    let emit_app = app.clone();
    tauri::async_runtime::spawn(async move {
        emit_web_panel_nav(&emit_app, true, None);
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn web_panel_open<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    url: String,
    bounds: Option<WebPanelBounds>,
    persist_session: Option<bool>,
    dialog_labels: Option<WebPanelDialogLabels>,
) -> Result<(), String> {
    use tauri_plugin_shiori_browser::{
        DialogLabels, OpenPayload, ShioriBrowserExt, WebPanelBounds as PluginBounds,
    };
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    let parsed = parse_web_url(&url)?;
    app.shiori_browser()
        .open(OpenPayload {
            url: parsed.to_string(),
            bounds: bounds.map(|b| PluginBounds {
                x: b.x,
                y: b.y,
                width: b.width,
                height: b.height,
            }),
            persist_session: persist_session.unwrap_or(true),
            // Single source of truth for the iPhone-Safari UA, same as desktop.
            user_agent: WEB_PANEL_USER_AGENT.to_string(),
            dialog_labels: dialog_labels.map(|labels| DialogLabels {
                ok: labels.ok,
                cancel: labels.cancel,
            }),
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn web_panel_navigate<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    url: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    let parsed = parse_web_url(&url)?;
    let webview = app
        .get_webview(WEB_PANEL_LABEL)
        .ok_or_else(|| "web-panel-missing".to_string())?;
    webview.navigate(parsed).map_err(|err| err.to_string())?;
    // Defer off the IPC COM-callback stack (see web_panel_open). A synchronous
    // emit here would inline-run eval -> send_user_message on the main thread,
    // re-entering the pump from inside WebView2's IPC callback. Inert on macOS.
    let emit_app = app.clone();
    tauri::async_runtime::spawn(async move {
        emit_web_panel_nav(&emit_app, true, None);
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn web_panel_navigate<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    url: String,
) -> Result<(), String> {
    use tauri_plugin_shiori_browser::ShioriBrowserExt;
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    let parsed = parse_web_url(&url)?;
    app.shiori_browser()
        .navigate(parsed.to_string())
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn web_panel_set_bounds<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    bounds: WebPanelBounds,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    // Check `creating` BEFORE get_webview. During add_child's nested pump the
    // runtime webview is built but NOT yet inserted into the manager, so
    // get_webview() can return None while creating==true — a re-entrant IPC
    // here would then fall through the `if let Some` and DROP the request.
    // Gate first, on state alone, and stash for create_web_panel to replay.
    {
        let state = app.state::<WebPanelState>();
        let mut inner = lock_web_panel(&state);
        if inner.creating {
            // shouldShow=true (set_bounds is only sent while visible), so this
            // supersedes any hide that raced; create_web_panel will show+place.
            inner.pending_bounds = Some(bounds);
            inner.pending_hide = false;
            return Ok(());
        }
    }
    if let Some(webview) = app.get_webview(WEB_PANEL_LABEL) {
        apply_web_panel_bounds(&webview, &bounds);
        // Show only on a hidden->visible transition. Re-showing every frame
        // forces a WebView2 visibility/occlusion recompute on Windows; macOS
        // coalesces it but the call is redundant once already visible.
        let state = app.state::<WebPanelState>();
        let mut inner = lock_web_panel(&state);
        if !inner.visible {
            webview.show().map_err(|err| err.to_string())?;
            inner.visible = true;
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn web_panel_set_bounds<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    bounds: WebPanelBounds,
) -> Result<(), String> {
    use tauri_plugin_shiori_browser::{ShioriBrowserExt, WebPanelBounds as PluginBounds};
    enforce_main_webview(&caller)?;
    app.shiori_browser()
        .set_bounds(PluginBounds {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn web_panel_hide<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    // Gate on `creating` BEFORE get_webview (see web_panel_set_bounds): during
    // add_child's nested pump the webview is built but not yet in the manager,
    // so get_webview() can be None while creating==true. Do NOT drop the hide —
    // record the intent so create_web_panel takes the panel down when creation
    // finishes. The frontend sends hide once per shouldShow=false transition and
    // does not poll, so a dropped hide would leave the OS-top-layer webview
    // floating over Settings / another tab.
    {
        let state = app.state::<WebPanelState>();
        let mut inner = lock_web_panel(&state);
        if inner.creating {
            inner.pending_hide = true;
            inner.pending_bounds = None;
            return Ok(());
        }
    }
    if let Some(webview) = app.get_webview(WEB_PANEL_LABEL) {
        webview.hide().map_err(|err| err.to_string())?;
        lock_web_panel(&app.state::<WebPanelState>()).visible = false;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn web_panel_hide<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    use tauri_plugin_shiori_browser::ShioriBrowserExt;
    enforce_main_webview(&caller)?;
    app.shiori_browser().hide().map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn web_panel_back<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    if let Some(webview) = app.get_webview(WEB_PANEL_LABEL) {
        navigation::request_traversal(
            &mut lock_web_panel(&app.state::<WebPanelState>()),
            navigation::Traversal::Back,
        );
        webview
            .eval("history.back()")
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn web_panel_back<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    use tauri_plugin_shiori_browser::ShioriBrowserExt;
    enforce_main_webview(&caller)?;
    app.shiori_browser().back().map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn web_panel_forward<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    if let Some(webview) = app.get_webview(WEB_PANEL_LABEL) {
        navigation::request_traversal(
            &mut lock_web_panel(&app.state::<WebPanelState>()),
            navigation::Traversal::Forward,
        );
        webview
            .eval("history.forward()")
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn web_panel_forward<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    use tauri_plugin_shiori_browser::ShioriBrowserExt;
    enforce_main_webview(&caller)?;
    app.shiori_browser()
        .forward()
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn web_panel_reload<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    if let Some(webview) = app.get_webview(WEB_PANEL_LABEL) {
        webview
            .eval("location.reload()")
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn web_panel_reload<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    use tauri_plugin_shiori_browser::ShioriBrowserExt;
    enforce_main_webview(&caller)?;
    app.shiori_browser().reload().map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn web_panel_close<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    if let Some(webview) = app.get_webview(WEB_PANEL_LABEL) {
        let _ = webview.close();
    }
    let state = app.state::<WebPanelState>();
    let mut inner = lock_web_panel(&state);
    inner.history.clear();
    inner.cursor = 0;
    inner.pending_steps = 0;
    inner.persist_session = None;
    inner.visible = false;
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn web_panel_close<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
) -> Result<(), String> {
    use tauri_plugin_shiori_browser::ShioriBrowserExt;
    enforce_main_webview(&caller)?;
    app.shiori_browser().close().map_err(|err| err.to_string())
}
