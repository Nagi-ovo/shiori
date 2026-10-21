// What the Browser panel learns from its engine's own session history,
// through the vendored wry's hook (patches/wry-0.55.1/src/shiori.rs). The
// panel's cursor (navigation.rs) sees only committed URLs, so a page calling
// history.back() itself looked like a link to the previous page: a new entry,
// Back on and Forward off. The engine knows. It also reports navigations
// within the page (a #fragment, pushState, Back/Forward across them), which
// commit no page load. Desktop only.

use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};
use wry::shiori::{set_dialog_labels, set_history_handler, DialogLabels, HistoryEvent};

use super::navigation::{emit_web_panel_nav, record_main_frame_commit};
use super::{lock_web_panel, WebPanelDialogLabels, WebPanelInner, WebPanelState, WEB_PANEL_LABEL};

// Before the panel's webview is built: wry reads the hook at build time.
pub(super) fn hook_engine_history<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    let handler = move |event: HistoryEvent| {
        let changed =
            record_engine_history(&mut lock_web_panel(&app.state::<WebPanelState>()), event);
        if changed {
            // Off the engine callback's stack, as every emit in create.rs.
            let emit_app = app.clone();
            tauri::async_runtime::spawn(async move {
                emit_web_panel_nav(&emit_app, false, None);
            });
        }
    };
    set_history_handler(WEB_PANEL_LABEL, Some(Arc::new(handler)));
}

// The page's alert/confirm/prompt buttons, in the app's language: wry draws
// those dialogs itself on macOS. Set on every open, as the language may have
// changed; without labels the page's dialogs are answered at once.
pub(super) fn set_engine_dialog_labels(labels: Option<WebPanelDialogLabels>) {
    let labels = labels.map(|labels| DialogLabels {
        ok: labels.ok,
        cancel: labels.cancel,
    });
    set_dialog_labels(WEB_PANEL_LABEL, labels);
}

// Returns whether the address bar or Back/Forward enablement changed.
pub(super) fn record_engine_history(inner: &mut WebPanelInner, event: HistoryEvent) -> bool {
    let url_changed = event.same_document_url.is_some_and(|url| {
        let changed = inner.history.get(inner.cursor) != Some(&url);
        if changed {
            record_main_frame_commit(inner, &url);
        }
        changed
    });
    let next = Some((event.can_go_back, event.can_go_forward));
    std::mem::replace(&mut inner.engine_back_forward, next) != next || url_changed
}

// Back/Forward enablement: the engine's once it has reported, else the
// cursor's.
pub(super) fn can_go_back_forward(inner: &WebPanelInner) -> (bool, bool) {
    inner
        .engine_back_forward
        .unwrap_or((inner.cursor > 0, inner.cursor + 1 < inner.history.len()))
}

#[cfg(test)]
mod tests {
    use super::super::navigation::{request_traversal, Traversal};
    use super::*;

    fn engine(inner: &mut WebPanelInner, can_go_back: bool, can_go_forward: bool) {
        record_engine_history(
            inner,
            HistoryEvent {
                same_document_url: None,
                can_go_back,
                can_go_forward,
            },
        );
    }

    // WKWebView's own reports, in order, when a page links A -> B and then
    // calls history.back() (scratchpad probe, test-artifacts/browser-history).
    #[test]
    fn a_page_calling_history_back_leaves_forward_enabled() {
        let mut inner = WebPanelInner::default();
        engine(&mut inner, false, false);
        record_main_frame_commit(&mut inner, "https://a.com/");
        engine(&mut inner, true, false);
        record_main_frame_commit(&mut inner, "https://b.com/");
        assert_eq!(can_go_back_forward(&inner), (true, false));

        engine(&mut inner, false, true);
        record_main_frame_commit(&mut inner, "https://a.com/");
        assert_eq!(
            inner.history.get(inner.cursor).map(String::as_str),
            Some("https://a.com/")
        );
        assert_eq!(can_go_back_forward(&inner), (false, true));
    }

    fn within_page(inner: &mut WebPanelInner, url: &str, back: bool, forward: bool) -> bool {
        record_engine_history(
            inner,
            HistoryEvent {
                same_document_url: Some(url.to_string()),
                can_go_back: back,
                can_go_forward: forward,
            },
        )
    }

    fn address(inner: &WebPanelInner) -> Option<&str> {
        inner.history.get(inner.cursor).map(String::as_str)
    }

    // A #fragment, pushState and replaceState commit no page load; the
    // address bar follows each, and Back across them lands where WebKit
    // says (its reports in test-artifacts/browser-history).
    #[test]
    fn navigations_within_the_page_move_the_address_bar() {
        let mut inner = WebPanelInner::default();
        engine(&mut inner, false, false);
        record_main_frame_commit(&mut inner, "https://a.com/doc");
        assert!(within_page(&mut inner, "https://a.com/doc#s", true, false));
        assert!(within_page(&mut inner, "https://a.com/doc?p", true, false));
        assert!(within_page(&mut inner, "https://a.com/doc?r", true, false));
        assert_eq!(address(&inner), Some("https://a.com/doc?r"));

        request_traversal(&mut inner, Traversal::Back);
        assert!(within_page(&mut inner, "https://a.com/doc#s", true, true));
        assert_eq!(address(&inner), Some("https://a.com/doc#s"));
        assert_eq!(can_go_back_forward(&inner), (true, true));

        // The page's own history.back() to the first entry.
        assert!(within_page(&mut inner, "https://a.com/doc", false, true));
        assert_eq!(address(&inner), Some("https://a.com/doc"));
        assert_eq!(can_go_back_forward(&inner), (false, true));
        assert!(!within_page(&mut inner, "https://a.com/doc", false, true));
    }

    // Only a change in enablement is worth an event to the frontend.
    #[test]
    fn a_repeated_report_changes_nothing() {
        let mut inner = WebPanelInner::default();
        assert!(record_engine_history(
            &mut inner,
            HistoryEvent {
                same_document_url: None,
                can_go_back: true,
                can_go_forward: false
            }
        ));
        assert!(!record_engine_history(
            &mut inner,
            HistoryEvent {
                same_document_url: None,
                can_go_back: true,
                can_go_forward: false
            }
        ));
    }
}
