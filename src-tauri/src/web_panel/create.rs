// Creating the Browser panel's native child webview: its builder, the
// navigation policy and history recording wired into it, and the replay of
// visibility/geometry requests that raced the creation. Desktop only.

use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, Url, WebviewUrl,
};

use super::navigation::{
    emit_web_panel_nav, parse_web_url, record_web_navigation, route_non_web_panel_navigation,
    web_panel_allows_navigation,
};
use super::{
    apply_web_panel_bounds, lock_web_panel, WebPanelBounds, WebPanelState, WEB_PANEL_LABEL,
    WEB_PANEL_USER_AGENT,
};

pub(super) fn create_web_panel<R: Runtime>(
    app: &AppHandle<R>,
    url: Url,
    bounds: Option<WebPanelBounds>,
    persist_session: bool,
) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "web-panel-no-window".to_string())?;
    let nav_app = app.clone();
    let builder = WebviewBuilder::new(WEB_PANEL_LABEL, WebviewUrl::External(url))
        .user_agent(WEB_PANEL_USER_AGENT)
        .incognito(!persist_session)
        // Policy only: this fires for subframes too, so it records nothing.
        .on_navigation(|url| {
            let target = url.as_str();
            if !web_panel_allows_navigation(target) {
                route_non_web_panel_navigation(target);
                return false;
            }
            true
        })
        // History and the address bar follow main-frame commits only: page-load
        // Started is WebKit's didCommitNavigation / WebKitGTK's Committed /
        // WebView2's ContentLoading, all main frame and post-redirect. Recording
        // in on_navigation put an iframe's URL (an embed, an ad) in the address
        // bar and history.
        .on_page_load(move |_webview, payload| {
            if payload.event() != PageLoadEvent::Started
                || parse_web_url(payload.url().as_str()).is_err()
            {
                return;
            }
            {
                let state = nav_app.state::<WebPanelState>();
                let mut inner = lock_web_panel(&state);
                record_web_navigation(&mut inner, payload.url().as_str());
            }
            // Emit nav-state OFF this callback's stack. On Windows this closure
            // is a synchronous WebView2 COM callback (`ContentLoading`),
            // running on the main UI thread inside the message pump.
            // `emit_web_panel_nav` -> `app.emit` -> webview `eval` goes through
            // wry's `send_user_message`, which INLINE-EXECUTES when called from
            // the main thread (POSTMORTEMS 2026-05-30) — i.e. it would run
            // re-entrantly while a navigation COM callback is still on the
            // stack. macOS WKWebView dispatches `evaluateJavaScript`
            // asynchronously, so it never re-enters; Windows does, and that
            // re-entrancy is the prime suspect for the post-navigation main-
            // thread wedge (page blank + dead buttons + unclosable window +
            // terminal stuck at "starting shell" — every invoke round-trip
            // frozen). `async_runtime::spawn` hops the emit onto a worker
            // thread, so `send_user_message` takes its QUEUED branch and the
            // eval lands on a later, clean event-loop turn. Do NOT swap in
            // `run_on_main_thread`: from the main thread it ALSO inline-runs and
            // reproduces the re-entrancy. History was recorded synchronously
            // above; the spawned emit re-reads that snapshot, so the address
            // bar / back-forward state stay correct, one loop-tick later.
            let emit_app = nav_app.clone();
            tauri::async_runtime::spawn(async move {
                emit_web_panel_nav(&emit_app, false, None);
            });
        });
    let (position, size) = match &bounds {
        Some(b) => (
            LogicalPosition::new(b.x, b.y),
            LogicalSize::new(b.width.max(1.0), b.height.max(1.0)),
        ),
        // Fallback only — the frontend measures the host and corrects via
        // set_bounds on the next frame. Keep it rail-sized, not 800px, so a
        // missed measurement never overflows the panel.
        None => (
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(420.0, 560.0),
        ),
    };
    // Mark "creating" across add_child. On Windows add_child synchronously
    // runs a nested message pump while the WebView2 controller is built; an
    // IPC queued concurrently (the frontend's independent rAF/ResizeObserver
    // fires web_panel_set_bounds right as the panel opens) can be dispatched
    // re-entrantly inside that pump and hit SetBounds/SetIsVisible on the
    // half-built controller. While this flag is set, those commands stash their
    // request instead of calling wry; we flush the latest once below. macOS
    // never re-enters, so the gate is simply never tripped there.
    {
        let state = app.state::<WebPanelState>();
        let mut inner = lock_web_panel(&state);
        inner.creating = true;
        inner.pending_bounds = None;
        inner.pending_hide = false;
    }
    let result = window
        .add_child(builder, position, size)
        .map_err(|err| err.to_string());
    let (pending_bounds, pending_hide) = {
        let state = app.state::<WebPanelState>();
        let mut inner = lock_web_panel(&state);
        inner.creating = false;
        (
            inner.pending_bounds.take(),
            std::mem::take(&mut inner.pending_hide),
        )
    };
    result?;
    // add_child creates the child webview VISIBLE. Replay the visibility/geometry
    // intent that arrived during creation, and make this the single authority for
    // the `visible` flag (web_panel_open no longer forces it true on the create
    // path). If a hide raced the create, take the panel down now — otherwise the
    // OS-top-layer webview would float over whatever the user switched to.
    let webview = app.get_webview(WEB_PANEL_LABEL);
    if pending_hide {
        if let Some(webview) = &webview {
            webview.hide().map_err(|err| err.to_string())?;
        }
        lock_web_panel(&app.state::<WebPanelState>()).visible = false;
    } else {
        if let (Some(bounds), Some(webview)) = (pending_bounds, &webview) {
            apply_web_panel_bounds(webview, &bounds);
        }
        lock_web_panel(&app.state::<WebPanelState>()).visible = true;
    }
    Ok(())
}
