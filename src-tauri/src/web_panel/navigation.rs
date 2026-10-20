// The Browser panel's navigation model, kept apart from the commands that
// drive the native webview: which URLs the panel may load, and the linear
// history behind the address bar and back/forward enablement.

use serde::Serialize;
use std::time::Instant;
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

// A mailto: link in the panel opens the mail client. Any page can also
// navigate to one from script, as often as it likes and without a click, and
// this runs inside the navigation policy callback on the UI thread: a
// `setInterval(() => location = "mailto:...", 200)` opened a compose window
// per tick and stalled Shiori on every `open`. So the hand-off waits on the
// blocking pool, and attempts arriving in a burst open the client once.
#[cfg(not(mobile))]
pub(super) fn route_non_web_panel_navigation(raw: &str) {
    static LAST_ATTEMPT: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    let lower = raw.trim().to_ascii_lowercase();
    if !lower.starts_with("mailto:") {
        return;
    }
    let mut last_attempt = LAST_ATTEMPT.lock().unwrap_or_else(|err| err.into_inner());
    if !external_open_allowed(&mut last_attempt, Instant::now()) {
        return;
    }
    let url = raw.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = crate::system_open::open_external_url_impl(url);
    });
}

// Every attempt restarts the quiet period, so a loop keeps being refused for
// as long as it runs, while a click after a pause goes through.
#[cfg_attr(mobile, allow(dead_code))]
fn external_open_allowed(last_attempt: &mut Option<Instant>, now: Instant) -> bool {
    const QUIET: std::time::Duration = std::time::Duration::from_secs(2);
    let previous = last_attempt.replace(now);
    previous.is_none_or(|previous| now.saturating_duration_since(previous) >= QUIET)
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
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Traversal {
    Back,
    Forward,
}

// Classify a committed navigation. Only the URL reaches us, so moving the
// cursor on a match with a neighbour alone turned a link back to the
// previous page (A -> B -> A) into a Back and disabled the Back button; the
// match counts only when Back/Forward was asked for.
pub(super) fn record_web_navigation(inner: &mut WebPanelInner, url: &str) {
    let traversal = inner.pending_traversal.take();
    let current = inner.history.get(inner.cursor).map(String::as_str);
    if current == Some(url) {
        return; // reload / re-entrant fire of the same page
    }
    let neighbour = |index: usize| inner.history.get(index).map(String::as_str) == Some(url);
    match traversal {
        Some(Traversal::Back) if inner.cursor > 0 && neighbour(inner.cursor - 1) => {
            inner.cursor -= 1;
            return;
        }
        Some(Traversal::Forward) if neighbour(inner.cursor + 1) => {
            inner.cursor += 1;
            return;
        }
        _ => {}
    }
    if !inner.history.is_empty() {
        inner.history.truncate(inner.cursor + 1);
    }
    inner.history.push(url.to_string());
    inner.cursor = inner.history.len().saturating_sub(1);
}

#[cfg(not(mobile))]
pub(super) fn emit_web_panel_nav<R: Runtime>(
    app: &AppHandle<R>,
    loading: bool,
    error: Option<String>,
) {
    let (url, can_go_back, can_go_forward) = {
        let state = app.state::<WebPanelState>();
        let inner = lock_web_panel(&state);
        (
            inner.history.get(inner.cursor).cloned(),
            inner.cursor > 0,
            inner.cursor + 1 < inner.history.len(),
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
        let mut last = None;
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
        inner.pending_traversal = Some(super::Traversal::Back);
        super::record_web_navigation(&mut inner, "https://b.com");
        assert_eq!(inner.cursor, 1);
        assert_eq!(inner.history.len(), 3);

        // Forward: the Forward button, then the next neighbour commits.
        inner.pending_traversal = Some(super::Traversal::Forward);
        super::record_web_navigation(&mut inner, "https://c.com");
        assert_eq!(inner.cursor, 2);

        // Go back, then a brand-new navigation truncates the forward entry.
        inner.pending_traversal = Some(super::Traversal::Back);
        super::record_web_navigation(&mut inner, "https://b.com");
        super::record_web_navigation(&mut inner, "https://d.com");
        assert_eq!(inner.cursor, 2);
        assert_eq!(
            inner.history,
            vec!["https://a.com", "https://b.com", "https://d.com"]
        );
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
