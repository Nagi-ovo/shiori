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

#[derive(Default)]
struct Hooks {
  history: Option<HistoryHandler>,
}

static HOOKS: Mutex<Option<HashMap<String, Hooks>>> = Mutex::new(None);

fn with_hooks<T>(webview_id: &str, read: impl FnOnce(Option<&mut Hooks>) -> T) -> T {
  let mut hooks = HOOKS.lock().unwrap_or_else(|err| err.into_inner());
  read(hooks.get_or_insert_with(HashMap::new).get_mut(webview_id))
}

/// Register (or with `None`, remove) the history handler of the webview built
/// with this id. Takes effect for webviews built afterwards.
pub fn set_history_handler(webview_id: &str, handler: Option<HistoryHandler>) {
  let mut hooks = HOOKS.lock().unwrap_or_else(|err| err.into_inner());
  hooks
    .get_or_insert_with(HashMap::new)
    .entry(webview_id.to_string())
    .or_default()
    .history = handler;
}

pub(crate) fn history_handler(webview_id: &str) -> Option<HistoryHandler> {
  with_hooks(webview_id, |hooks| {
    hooks.and_then(|hooks| hooks.history.clone())
  })
}
