// The Browser panel's navigation model, kept apart from the commands that
// drive the native webview: which URLs the panel may load, and the linear
// history behind the address bar and back/forward enablement.

use tauri::Url;

use super::WebPanelInner;

pub(crate) fn parse_web_url(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw.trim()).map_err(|_| "web-panel-invalid-url".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        _ => Err("web-panel-unsupported-url".into()),
    }
}

// Classify a committed navigation against the cursor's neighbours so the
// history stays consistent for reloads, link clicks, and back/forward.
pub(super) fn record_web_navigation(inner: &mut WebPanelInner, url: &str) {
    let current = inner.history.get(inner.cursor).map(String::as_str);
    if current == Some(url) {
        return; // reload / re-entrant fire of the same page
    }
    if inner.cursor > 0 && inner.history.get(inner.cursor - 1).map(String::as_str) == Some(url) {
        inner.cursor -= 1; // went back
        return;
    }
    if inner.history.get(inner.cursor + 1).map(String::as_str) == Some(url) {
        inner.cursor += 1; // went forward
        return;
    }
    if !inner.history.is_empty() {
        inner.history.truncate(inner.cursor + 1);
    }
    inner.history.push(url.to_string());
    inner.cursor = inner.history.len().saturating_sub(1);
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

        // Back: navigating to the previous neighbour moves the cursor back
        // without growing history.
        super::record_web_navigation(&mut inner, "https://b.com");
        assert_eq!(inner.cursor, 1);
        assert_eq!(inner.history.len(), 3);

        // Forward: navigating to the next neighbour advances the cursor.
        super::record_web_navigation(&mut inner, "https://c.com");
        assert_eq!(inner.cursor, 2);

        // Go back, then a brand-new navigation truncates the forward entry.
        super::record_web_navigation(&mut inner, "https://b.com");
        super::record_web_navigation(&mut inner, "https://d.com");
        assert_eq!(inner.cursor, 2);
        assert_eq!(
            inner.history,
            vec!["https://a.com", "https://b.com", "https://d.com"]
        );
    }
}
