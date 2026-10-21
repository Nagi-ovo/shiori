// Copyright 2020-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT
// Added by Shiori (not upstream): see src/shiori.rs.

use std::{ffi::c_void, ptr::null_mut};

use objc2::{
  define_class, msg_send,
  rc::Retained,
  runtime::{AnyObject, Bool, NSObject},
  AllocAnyThread, DefinedClass,
};
use objc2_foundation::{
  NSDictionary, NSKeyValueChangeKey, NSKeyValueObservingOptions,
  NSObjectNSKeyValueObserverRegistration, NSObjectProtocol, NSString,
};

use crate::{
  shiori::{HistoryEvent, HistoryHandler},
  WryWebView,
};

const KEYS: [&str; 2] = ["canGoBack", "canGoForward"];

pub struct ShioriHistoryObserverIvars {
  pub object: Retained<WryWebView>,
  pub handler: HistoryHandler,
}

define_class!(
  #[unsafe(super(NSObject))]
  #[ivars = ShioriHistoryObserverIvars]
  pub struct ShioriHistoryObserver;

  /// NSKeyValueObserving.
  impl ShioriHistoryObserver {
    #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
    fn observe_value_for_key_path(
      &self,
      _key_path: Option<&NSString>,
      _of_object: Option<&AnyObject>,
      _change: Option<&NSDictionary<NSKeyValueChangeKey, AnyObject>>,
      _context: *mut c_void,
    ) {
      (self.ivars().handler)(history_event(&*self.ivars().object));
    }
  }

  unsafe impl NSObjectProtocol for ShioriHistoryObserver {}
);

pub(crate) fn history_event<T: objc2::Message>(webview: &T) -> HistoryEvent {
  unsafe {
    let can_go_back: Bool = msg_send![webview, canGoBack];
    let can_go_forward: Bool = msg_send![webview, canGoForward];
    HistoryEvent {
      same_document_url: None,
      can_go_back: can_go_back.as_bool(),
      can_go_forward: can_go_forward.as_bool(),
    }
  }
}

impl ShioriHistoryObserver {
  pub fn new(webview: Retained<WryWebView>, handler: HistoryHandler) -> Retained<Self> {
    let observer = Self::alloc().set_ivars(ShioriHistoryObserverIvars {
      object: webview,
      handler,
    });
    let observer: Retained<Self> = unsafe { msg_send![super(observer), init] };
    for key in KEYS {
      unsafe {
        observer
          .ivars()
          .object
          .addObserver_forKeyPath_options_context(
            &observer,
            &NSString::from_str(key),
            NSKeyValueObservingOptions::Initial,
            null_mut(),
          );
      }
    }
    observer
  }
}

impl Drop for ShioriHistoryObserver {
  fn drop(&mut self) {
    unsafe {
      for key in KEYS {
        (self.ivars().object).removeObserver_forKeyPath(self, &NSString::from_str(key));
      }
    }
  }
}
