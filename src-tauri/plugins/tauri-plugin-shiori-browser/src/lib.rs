//! Tauri mobile plugin backing Shiori's in-rail embedded browser on tablets.
//!
//! Tauri has no multi-webview on mobile (`Window::add_child` is `#[cfg(desktop)]`),
//! so the panel content cannot be a Tauri child webview as it is on desktop.
//! Instead this plugin hosts a platform-native web view as a sibling of the
//! Tauri webview inside the single mobile window:
//!   * iOS — a `WKWebView` added as a subview of the Tauri view controller's
//!     root view, frame-positioned.
//!   * Android — an `android.webkit.WebView` added to the Activity's root
//!     `FrameLayout`, layout-positioned.
//!
//! The plugin is driven entirely from Rust: the app's `web_panel_*` commands
//! (src-tauri/src/lib.rs) forward to [`ShioriBrowserExt::shiori_browser`]. It
//! exposes no JS command surface. The native nav delegate keeps a nav-state
//! snapshot which a lightweight poll re-emits as the frozen `web-panel-nav`
//! event (see `mobile.rs` for why a poll rather than a push channel).
//!
//! See `docs/TABLET-BROWSER-HANDOFF.md` for the authoritative spec.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
mod models;

pub use error::{Error, Result};
pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

#[cfg(desktop)]
use desktop::ShioriBrowser;
#[cfg(mobile)]
use mobile::ShioriBrowser;

/// Extension trait to reach the embedded-browser API from any [`Manager`]
/// (`AppHandle`, `WebviewWindow`, …): `app.shiori_browser().open(...)`.
pub trait ShioriBrowserExt<R: Runtime> {
    fn shiori_browser(&self) -> &ShioriBrowser<R>;
}

impl<R: Runtime, T: Manager<R>> ShioriBrowserExt<R> for T {
    fn shiori_browser(&self) -> &ShioriBrowser<R> {
        self.state::<ShioriBrowser<R>>().inner()
    }
}

/// Initialize the plugin. Register it in the app's `run()` builder under
/// `#[cfg(mobile)]` (AGENTS.md fact #7 — every plugin must be `.plugin()`-ed).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("shiori-browser")
        .setup(|app, api| {
            #[cfg(mobile)]
            let browser = mobile::init(app, api)?;
            #[cfg(desktop)]
            let browser = desktop::init(app, api)?;
            app.manage(browser);
            Ok(())
        })
        .build()
}
