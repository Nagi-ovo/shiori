use serde::{Deserialize, Serialize};

/// Host rect for the native browser view, in CSS / logical px relative to the
/// Tauri webview's content top-left — exactly what `RightRail` measures and
/// what the desktop `web_panel_set_bounds` receives. The native side converts
/// to points (iOS) or physical px (Android, `× density`); see §8c of the
/// handoff.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebPanelBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Payload for `open`. `user_agent` is passed from Rust so the iPhone-Safari UA
/// (the single source of truth, `WEB_PANEL_USER_AGENT` in lib.rs) stays
/// consistent with desktop and the narrow rail layout fits.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPayload {
    pub url: String,
    pub bounds: Option<WebPanelBounds>,
    pub persist_session: bool,
    pub user_agent: String,
    pub dialog_labels: Option<DialogLabels>,
}

/// Localized buttons for the page's JavaScript alert/confirm/prompt, which
/// the iOS side draws itself and cannot translate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogLabels {
    pub ok: String,
    pub cancel: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigatePayload {
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundsPayload {
    pub bounds: WebPanelBounds,
}

/// Payload for `share_file` (iOS). The native side presents a share sheet
/// (`UIActivityViewController`) for the exported file at `path`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareFilePayload {
    pub path: String,
    pub filename: String,
    pub mime: String,
}

/// Response from `share_file` (iOS): whether the user actually completed a
/// share activity, as opposed to dismissing the sheet without sharing.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareFileResult {
    pub completed: bool,
}

/// Mirror of the frozen `web-panel-nav` event payload (see
/// `src/platform/webPanel.ts` `WebPanelNavState`). Returned by the native
/// `navState` method and re-emitted verbatim as the global `web-panel-nav`
/// event so the address bar / back-forward enablement / loading state work
/// identically to desktop. `#[serde(default)]` lets the native side omit
/// `url`/`error` when they are absent.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WebPanelNav {
    pub url: Option<String>,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub error: Option<String>,
}

/// What the native `navState` returns: the `web-panel-nav` payload, plus a
/// mailto:, tel: or other hand-off link the page asked for since the last
/// poll. The native side never opens those itself (a page can request them
/// from script without a tap); the poll re-emits them as
/// `web-panel-external-open` and the main webview asks the user.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavStateReply {
    #[serde(flatten)]
    pub nav: WebPanelNav,
    #[serde(default)]
    pub external_open: Option<String>,
}

/// Payload of `web-panel-external-open`, the same on desktop and mobile.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalOpenRequest {
    pub url: String,
}
