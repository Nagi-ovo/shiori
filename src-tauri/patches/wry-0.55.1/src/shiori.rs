// Copyright 2020-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT
// Added by Shiori (not upstream): per-webview hooks for the Browser panel.

//! Hooks Shiori sets on one webview, keyed by its id.
//!
//! Tauri 2.11 builds every webview through tauri-runtime-wry, which Shiori
//! does not patch, so a new `WebViewBuilder` option could not reach wry. The
//! host instead registers a hook under the webview's id (Tauri passes the
//! webview label as the id) before the webview is built. A webview with no
//! registration behaves exactly as upstream wry.
//!
//! - [`set_history_handler`]: told whenever the engine's own back/forward
//!   availability changes (macOS: KVO on `canGoBack` / `canGoForward`;
//!   Windows: `HistoryChanged`; Linux: the back-forward list's `changed`),
//!   and of every same-document navigation (a fragment jump, pushState,
//!   replaceState, Back/Forward between entries of one document), which no
//!   page load reports. macOS: WebKit's private
//!   `_webView:navigation:didSameDocumentNavigation:`; Windows:
//!   `SourceChanged` with `IsNewDocument` false; Linux: `notify::uri` while
//!   no load is in flight, and the URL again when a load finishes (a
//!   pushState during the load). Registered at build time; it runs on the
//!   main thread inside the engine's callback.
//! - [`set_dialog_labels`] (macOS): the webview shows the page's
//!   `alert` / `confirm` / `prompt` as a sheet on its window with these
//!   button titles, read when each dialog opens. Without labels the
//!   webview answers them at once (`confirm` false, `prompt` null), as
//!   upstream wry, whose UI delegate has no `runJavaScript*Panel` methods.
//!   WebView2 and WebKitGTK show their own dialogs either way.

use std::{
  collections::HashMap,
  sync::{Arc, Mutex},
};

/// The engine's session history after a change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEvent {
  /// The main frame's URL after a navigation within its document; `None`
  /// when only back/forward availability changed.
  pub same_document_url: Option<String>,
  pub can_go_back: bool,
  pub can_go_forward: bool,
}

pub type HistoryHandler = Arc<dyn Fn(HistoryEvent) + Send + Sync>;

/// Button titles for the page's JavaScript dialogs, in the host's language.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogLabels {
  pub ok: String,
  pub cancel: String,
}

#[derive(Default)]
struct Hooks {
  history: Option<HistoryHandler>,
  dialog_labels: Option<DialogLabels>,
}

static HOOKS: Mutex<Option<HashMap<String, Hooks>>> = Mutex::new(None);

fn with_hooks<T>(webview_id: &str, f: impl FnOnce(&mut Hooks) -> T) -> T {
  let mut hooks = HOOKS.lock().unwrap_or_else(|err| err.into_inner());
  let hooks = hooks.get_or_insert_with(HashMap::new);
  f(hooks.entry(webview_id.to_string()).or_default())
}

/// Register (or with `None`, remove) the history handler of the webview built
/// with this id. Takes effect for webviews built afterwards.
pub fn set_history_handler(webview_id: &str, handler: Option<HistoryHandler>) {
  with_hooks(webview_id, |hooks| hooks.history = handler);
}

/// Set (or with `None`, remove) the dialog button titles of the webview with
/// this id. Takes effect for the next dialog, also in a webview already built.
pub fn set_dialog_labels(webview_id: &str, labels: Option<DialogLabels>) {
  with_hooks(webview_id, |hooks| hooks.dialog_labels = labels);
}

pub(crate) fn history_handler(webview_id: &str) -> Option<HistoryHandler> {
  with_hooks(webview_id, |hooks| hooks.history.clone())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn dialog_labels(webview_id: &str) -> Option<DialogLabels> {
  with_hooks(webview_id, |hooks| hooks.dialog_labels.clone())
}
