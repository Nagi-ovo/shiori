// Copyright 2020-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT
// Added by Shiori (not upstream): the page's JavaScript dialogs in a webview
// that has dialog labels (src/shiori.rs). macOS only.

use std::{
  cell::Cell,
  rc::Rc,
  time::{Duration, Instant},
};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSModalResponse, NSTextField};
use objc2_foundation::{ns_string, MainThreadMarker, NSPoint, NSRect, NSSize, NSString};
use objc2_web_kit::WKFrameInfo;

use crate::WryWebView;

// A page that opens a dialog again as soon as the last one closes (an
// `alert` loop) would hold the window's sheet up for good, and the sheet
// blocks the whole host window. After this many such dialogs in a row the
// rest are answered at once, until the page pauses.
const BURST_GAP: Duration = Duration::from_secs(1);
const BURST_LIMIT: u32 = 3;

#[derive(Default)]
pub struct DialogGate {
  last_closed: Cell<Option<Instant>>,
  burst: Cell<u32>,
}

impl DialogGate {
  fn allow(&self, now: Instant) -> bool {
    let quick = self
      .last_closed
      .get()
      .is_some_and(|closed| now.saturating_duration_since(closed) < BURST_GAP);
    let burst = if quick { self.burst.get() + 1 } else { 0 };
    self.burst.set(burst);
    if burst >= BURST_LIMIT {
      // Keep a loop that never pauses answered.
      self.last_closed.set(Some(now));
      return false;
    }
    true
  }
}

pub enum DialogKind<'a> {
  Alert,
  Confirm,
  Prompt { default_text: Option<&'a NSString> },
}

/// Show the dialog, or answer at once. `answer` runs exactly once: with the
/// text field's value (empty for alert and confirm) when the user chose OK,
/// with `None` otherwise.
pub fn show(
  gate: &Rc<DialogGate>,
  webview_id: &str,
  webview: &WryWebView,
  frame: &WKFrameInfo,
  message: &NSString,
  kind: DialogKind,
  answer: impl Fn(Option<Retained<NSString>>) + 'static,
) {
  let (Some(labels), Some(mtm)) = (
    crate::shiori::dialog_labels(webview_id),
    MainThreadMarker::new(),
  ) else {
    return answer(None);
  };
  if !gate.allow(Instant::now()) {
    return answer(None);
  }
  let alert = NSAlert::new(mtm);
  // Titled with the asking frame's host, as in the iOS panel.
  let host = unsafe { frame.securityOrigin().host() };
  alert.setMessageText(&host);
  alert.setInformativeText(message);
  alert.addButtonWithTitle(&NSString::from_str(&labels.ok));
  if !matches!(kind, DialogKind::Alert) {
    let cancel = alert.addButtonWithTitle(&NSString::from_str(&labels.cancel));
    // AppKit assigns Escape by the English title "Cancel"; give it to the
    // translated one too.
    cancel.setKeyEquivalent(ns_string!("\u{1b}"));
  }
  let field = match kind {
    DialogKind::Prompt { default_text } => {
      let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(260.0, 24.0));
      let field = NSTextField::initWithFrame(mtm.alloc(), frame);
      field.setStringValue(default_text.unwrap_or(ns_string!("")));
      alert.setAccessoryView(Some(&field));
      alert.layout();
      alert.window().setInitialFirstResponder(Some(&field));
      Some(field)
    }
    _ => None,
  };
  let gate = gate.clone();
  let finish = move |response: NSModalResponse| {
    gate.last_closed.set(Some(Instant::now()));
    answer((response == NSAlertFirstButtonReturn).then(|| {
      field
        .as_ref()
        .map_or_else(NSString::new, |field| field.stringValue())
    }));
  };
  match webview.window() {
    Some(window) => {
      let finish = RcBlock::new(finish);
      alert.beginSheetModalForWindow_completionHandler(&window, Some(&finish));
    }
    None => finish(alert.runModal()),
  }
}
