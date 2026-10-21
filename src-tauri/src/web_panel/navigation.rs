// The Browser panel's navigation model, kept apart from the commands that
// drive the native webview: which URLs the panel may load, and the linear
// history behind the address bar and back/forward enablement.

use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::Url;
#[cfg(not(mobile))]
use tauri::{AppHandle, Manager, Runtime};

use super::WebPanelInner;
#[cfg(not(mobile))]
use super::{lock_web_panel, WebPanelState};
#[cfg(not(mobile))]
use crate::emit_to_main;

pub(crate) fn parse_web_url(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw.trim()).map_err(|_| "web-panel-invalid-url".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        _ => Err("web-panel-unsupported-url".into()),
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WebPanelNav {
    url: Option<String>,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    error: Option<String>,
}

#[cfg(not(mobile))]
#[derive(Serialize, Clone)]
struct ExternalOpenRequest {
    url: String,
}

// A mailto: link in the panel is for the mail client. Any page can also
// navigate to one from script, as often as it likes and without a click, so
// this never opens it: it asks the main webview to (`web-panel-external-open`),
// which asks the user first (BrowserPanel.tsx). Attempts arriving in a burst
// raise one request. The emit hops off this policy callback's stack, as every
// emit in create.rs does.
#[cfg(not(mobile))]
pub(super) fn route_non_web_panel_navigation<R: Runtime>(app: &AppHandle<R>, raw: &str) {
    let url = raw.trim();
    if !url.to_ascii_lowercase().starts_with("mailto:") {
        return;
    }
    if !external_open_request_allowed(&app.state::<WebPanelState>(), Instant::now()) {
        return;
    }
    let app = app.clone();
    let url = url.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = emit_to_main(&app, "web-panel-external-open", ExternalOpenRequest { url });
    });
}

#[cfg_attr(mobile, allow(dead_code))]
const OPEN_QUIET: Duration = Duration::from_secs(2);
#[cfg_attr(mobile, allow(dead_code))]
const OPEN_RESET: Duration = Duration::from_secs(600);

#[cfg_attr(mobile, allow(dead_code))]
pub(super) struct ExternalOpenGate {
    last_attempt: Option<Instant>,
    quiet: Duration,
}

impl ExternalOpenGate {
    #[cfg_attr(mobile, allow(dead_code))]
    const fn new() -> Self {
        Self {
            last_attempt: None,
            quiet: OPEN_QUIET,
        }
    }
}

impl Default for ExternalOpenGate {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(not(mobile))]
fn external_open_request_allowed(state: &WebPanelState, now: Instant) -> bool {
    let mut gate = state
        .external_open
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    external_open_allowed(&mut gate, now)
}

// The gate belongs to one panel session and one page the user went to.
// Opening, closing (the rail too), a typed address and the panel's Back,
// Forward and Reload start it afresh: a quiet period stretched by an earlier
// page's requests silently dropped the next page's mailto click. Only the
// main webview can call those commands, so a page cannot reset the gate; its
// own navigations and history calls keep it.
#[cfg(not(mobile))]
pub(super) fn restart_external_open_gate(state: &WebPanelState) {
    *state
        .external_open
        .lock()
        .unwrap_or_else(|err| err.into_inner()) = ExternalOpenGate::new();
}

// Every attempt restarts the quiet period, so a loop keeps being refused for
// as long as it runs (no stream of consent prompts), while a click after a
// pause goes through. Each request doubles the quiet period a later one
// needs (back to 2 s after ten silent minutes): a fixed 2 s let a loop
// ticking every 2.1 s through on every tick.
#[cfg_attr(mobile, allow(dead_code))]
fn external_open_allowed(gate: &mut ExternalOpenGate, now: Instant) -> bool {
    let idle = gate
        .last_attempt
        .replace(now)
        .map(|previous| now.saturating_duration_since(previous));
    if idle.is_none_or(|idle| idle >= OPEN_RESET) {
        gate.quiet = OPEN_QUIET;
    }
    if idle.is_some_and(|idle| idle < gate.quiet) {
        return false;
    }
    gate.quiet = (gate.quiet * 2).min(OPEN_RESET);
    true
}

// The panel's navigation policy. WebKit (macOS WKWebView, Linux WebKitGTK)
// asks it about every frame without saying which, so besides http(s) it lets
// through the in-webview documents iframes load (about:blank, about:srcdoc,
// a page's own blob: URLs); refusing those broke embeds. data: stays out: a
// top-level data: page would sit under the previous address.
pub(super) fn web_panel_allows_navigation(raw: &str) -> bool {
    if parse_web_url(raw).is_ok() {
        return true;
    }
    Url::parse(raw.trim()).is_ok_and(|url| match url.scheme() {
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "blob" => true,
        _ => false,
    })
}

// Which way the panel's own Back/Forward buttons asked the webview to go.
#[cfg_attr(mobile, allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Traversal {
    Back,
    Forward,
}

// The panel's Back/Forward button asked the webview to traverse. Requests
// add up: the button stays enabled until the first commit's nav event
// arrives, and a single flag turned a second quick Back into a new entry.
#[cfg_attr(mobile, allow(dead_code))]
pub(super) fn request_traversal(inner: &mut WebPanelInner, traversal: Traversal) {
    inner.pending_steps += match traversal {
        Traversal::Back => -1,
        Traversal::Forward => 1,
    };
}

// Classify a committed navigation. Only the URL reaches us, so moving the
// cursor on a match with a neighbour alone turned a link back to the
// previous page (A -> B -> A) into a Back and disabled the Back button; the
// match counts only within the steps Back/Forward asked for, nearest first
// (WebKit may commit two queued Backs as one).
pub(super) fn record_web_navigation(inner: &mut WebPanelInner, url: &str) {
    let pending = std::mem::take(&mut inner.pending_steps);
    if inner.history.get(inner.cursor).map(String::as_str) == Some(url) {
        inner.pending_steps = pending;
        return; // reload / re-entrant fire of the same page
    }
    let cursor = inner.cursor;
    let target = (1..=pending.unsigned_abs() as usize).find_map(|k| {
        let index = if pending < 0 {
            cursor.checked_sub(k)?
        } else {
            cursor + k
        };
        (inner.history.get(index).map(String::as_str) == Some(url)).then_some((k, index))
    });
    if let Some((k, index)) = target {
        inner.cursor = index;
        inner.pending_steps = pending - pending.signum() * k as i32;
        return;
    }
    if !inner.history.is_empty() {
        inner.history.truncate(inner.cursor + 1);
    }
    inner.history.push(url.to_string());
    inner.cursor = inner.history.len().saturating_sub(1);
}

// A main-frame page commit (page-load Started). Anything the policy let
// load counts: a page sending its top frame to a blob: or about:blank used to
// be ignored, leaving the previous address up and Back disabled on the very
// page the user could not leave. Typed input stays http(s) (parse_web_url).
// Returns whether the commit entered the history.
#[cfg(not(mobile))]
pub(super) fn record_main_frame_commit(inner: &mut WebPanelInner, url: &str) -> bool {
    if !web_panel_allows_navigation(url) {
        return false;
    }
    record_web_navigation(inner, url);
    true
}

#[cfg(not(mobile))]
pub(super) fn emit_web_panel_nav<R: Runtime>(
    app: &AppHandle<R>,
    loading: bool,
    error: Option<String>,
) {
    let (url, (can_go_back, can_go_forward)) = {
        let state = app.state::<WebPanelState>();
        let inner = lock_web_panel(&state);
        (
            inner.history.get(inner.cursor).cloned(),
            super::engine::can_go_back_forward(&inner),
        )
    };
    let _ = emit_to_main(
        app,
        "web-panel-nav",
        WebPanelNav {
            url,
            loading,
            can_go_back,
            can_go_forward,
            error,
        },
    );
}

#[cfg(test)]
mod tests {
    #[test]
    fn web_panel_only_accepts_http_urls() {
        assert!(super::parse_web_url("https://github.com").is_ok());
        assert!(super::parse_web_url("http://example.com/x?q=1").is_ok());
        assert!(super::parse_web_url("  https://trim.me  ").is_ok());
        for bad in [
            "mailto:a@b.com",
            "file:///tmp/x.pdf",
            "ftp://host/f",
            "javascript:alert(1)",
            "not a url",
            "",
        ] {
            assert!(super::parse_web_url(bad).is_err(), "should reject {bad}");
        }
    }

    // The policy sees every frame's navigations (WebKit on macOS and Linux
    // does not say which frame), so it must let embeds load their own
    // in-webview documents while still refusing anything that leaves the web.
    #[test]
    fn web_panel_policy_lets_subframe_documents_load() {
        for ok in [
            "https://www.youtube.com/embed/x",
            "about:blank",
            "about:srcdoc",
            "blob:https://example.com/0d1c6b8e-9a43-4b1f-8f43-0c1e0a4b8b11",
        ] {
            assert!(super::web_panel_allows_navigation(ok), "should allow {ok}");
        }
        for bad in [
            "mailto:a@b.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<h1>x</h1>",
            "tauri://localhost/index.html",
            "shiori://open",
            "about:settings",
        ] {
            assert!(
                !super::web_panel_allows_navigation(bad),
                "should refuse {bad}"
            );
        }
    }

    // A page script looping `location = "mailto:..."` must not open a mail
    // window per iteration; a user clicking a mailto link again later must.
    #[test]
    fn web_panel_mailto_flood_opens_the_mail_client_once() {
        use std::time::{Duration, Instant};
        let start = Instant::now();
        let mut last = super::ExternalOpenGate::new();
        let opened = (0..50)
            .filter(|i| {
                let now = start + Duration::from_millis(200 * i);
                super::external_open_allowed(&mut last, now)
            })
            .count();
        assert_eq!(opened, 1, "a 200 ms loop opens the mail client once");
        let later = start + Duration::from_millis(200 * 49 + 5_000);
        assert!(super::external_open_allowed(&mut last, later));
    }

    // A loop just slower than the quiet period must not get through on every
    // tick either: each open makes the next one wait longer.
    #[test]
    fn web_panel_slow_mailto_loop_stops_opening_the_mail_client() {
        use std::time::{Duration, Instant};
        let start = Instant::now();
        for (period_ms, most) in [(2_100, 1), (60_000, 6)] {
            let mut last = super::ExternalOpenGate::new();
            let opened = (0..60)
                .filter(|i| {
                    let now = start + Duration::from_millis(period_ms * i);
                    super::external_open_allowed(&mut last, now)
                })
                .count();
            assert!(opened <= most, "{period_ms} ms loop opened {opened} times");
        }
    }

    // After a page's mailto requests stretched the quiet period past a
    // minute, reopening the panel or going elsewhere from its own controls
    // must let the next mailto click through.
    #[test]
    #[cfg(not(mobile))]
    fn web_panel_mailto_asks_again_after_the_user_moves_on() {
        use std::time::{Duration, Instant};
        let state = super::WebPanelState::default();
        let start = Instant::now();
        let minute = |i: u64| start + Duration::from_secs(60 * i);
        let opened = (0..6)
            .filter(|&i| super::external_open_request_allowed(&state, minute(i)))
            .count();
        assert_eq!(opened, 5, "the sixth request a minute on is refused");
        super::restart_external_open_gate(&state);
        assert!(super::external_open_request_allowed(&state, minute(6)));
    }

    // The address bar's back/forward enablement and target are driven
    // entirely by this cursor model, so exercise the push / back / forward /
    // reload / branch-truncation transitions directly.
    #[test]
    fn web_navigation_history_tracks_cursor() {
        let mut inner = super::WebPanelInner::default();

        super::record_web_navigation(&mut inner, "https://a.com");
        assert_eq!(inner.cursor, 0);
        assert_eq!(inner.history, vec!["https://a.com"]);

        super::record_web_navigation(&mut inner, "https://b.com");
        super::record_web_navigation(&mut inner, "https://c.com");
        assert_eq!(inner.cursor, 2);
        assert_eq!(inner.history.len(), 3);

        // Reload (same URL) is a no-op.
        super::record_web_navigation(&mut inner, "https://c.com");
        assert_eq!(inner.cursor, 2);
        assert_eq!(inner.history.len(), 3);

        // Back: the Back button, then the previous neighbour commits; the
        // cursor moves back without growing history.
        super::request_traversal(&mut inner, super::Traversal::Back);
        super::record_web_navigation(&mut inner, "https://b.com");
        assert_eq!(inner.cursor, 1);
        assert_eq!(inner.history.len(), 3);

        // Forward: the Forward button, then the next neighbour commits.
        super::request_traversal(&mut inner, super::Traversal::Forward);
        super::record_web_navigation(&mut inner, "https://c.com");
        assert_eq!(inner.cursor, 2);

        // Go back, then a brand-new navigation truncates the forward entry.
        super::request_traversal(&mut inner, super::Traversal::Back);
        super::record_web_navigation(&mut inner, "https://b.com");
        super::record_web_navigation(&mut inner, "https://d.com");
        assert_eq!(inner.cursor, 2);
        assert_eq!(
            inner.history,
            vec!["https://a.com", "https://b.com", "https://d.com"]
        );
    }

    // The policy lets a page send its own top frame to a blob: (a generated
    // file) or about:blank. That page is then what the panel shows, so the
    // address bar must follow and Back must lead back to the page before it.
    #[test]
    #[cfg(not(mobile))]
    fn web_navigation_records_a_top_level_blob_page() {
        let mut inner = super::WebPanelInner::default();
        super::record_web_navigation(&mut inner, "https://a.com");
        let blob = "blob:https://a.com/0d1c6b8e-9a43-4b1f-8f43-0c1e0a4b8b11";
        assert!(super::record_main_frame_commit(&mut inner, blob));
        assert_eq!(inner.history, vec!["https://a.com", blob]);
        assert_eq!(inner.cursor, 1, "Back must be enabled");
        assert!(super::record_main_frame_commit(&mut inner, "about:blank"));
        assert_eq!(inner.cursor, 2);
        assert!(!super::record_main_frame_commit(
            &mut inner,
            "file:///etc/passwd"
        ));
        assert_eq!(inner.cursor, 2);
    }

    // Back is still enabled until the first commit's nav event arrives, so
    // two quick clicks walk two entries; both must move the cursor, or the
    // panel thinks the webview is three deep with nothing forward.
    #[test]
    fn web_navigation_two_quick_backs_walk_two_entries() {
        let mut inner = super::WebPanelInner::default();
        for url in ["https://a.com", "https://b.com", "https://c.com"] {
            super::record_web_navigation(&mut inner, url);
        }
        super::request_traversal(&mut inner, super::Traversal::Back);
        super::request_traversal(&mut inner, super::Traversal::Back);
        super::record_web_navigation(&mut inner, "https://b.com");
        super::record_web_navigation(&mut inner, "https://a.com");
        assert_eq!(inner.cursor, 0);
        assert_eq!(inner.history.len(), 3, "Forward must stay available");
    }

    // WebKit may fold two queued traversals into one commit two entries back.
    #[test]
    fn web_navigation_two_backs_committed_at_once_land_two_back() {
        let mut inner = super::WebPanelInner::default();
        for url in ["https://a.com", "https://b.com", "https://c.com"] {
            super::record_web_navigation(&mut inner, url);
        }
        super::request_traversal(&mut inner, super::Traversal::Back);
        super::request_traversal(&mut inner, super::Traversal::Back);
        super::record_web_navigation(&mut inner, "https://a.com");
        assert_eq!(inner.cursor, 0);
        assert_eq!(inner.history.len(), 3);
    }

    // Following links A -> B -> A is three pages deep, not a Back: the
    // webview can still go back, so the Back button must stay enabled.
    #[test]
    fn web_navigation_link_to_the_previous_page_is_a_new_entry() {
        let mut inner = super::WebPanelInner::default();
        for url in ["https://a.com", "https://b.com", "https://a.com"] {
            super::record_web_navigation(&mut inner, url);
        }
        assert_eq!(inner.cursor, 2, "Back must stay enabled");
        assert_eq!(
            inner.history,
            vec!["https://a.com", "https://b.com", "https://a.com"]
        );
    }
}
