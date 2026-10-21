// Mobile implementation: forward the embedded-browser protocol to the native
// Swift/Kotlin plugin and surface the native nav state as the frozen
// `web-panel-nav` event.
//
// Nav-event delivery — why a poll, not a push channel:
//   The desktop side emits `web-panel-nav` from Rust on each committed nav.
//   The natural mobile analogue is a Tauri `Channel` the native delegate pushes
//   through. But native→Rust channel routing only works for channels that
//   originated on the JS side (`register_channel` is `pub(crate)` and is only
//   called from `JavaScriptChannelId::channel_on`). The frozen frontend listens
//   via the global `listen("web-panel-nav")` and never passes a channel down,
//   and the contract (and file ownership) forbids changing it. So the native
//   delegate instead keeps a nav-state snapshot, and this side polls `navState`
//   while the panel is visible and re-emits `web-panel-nav` on change. The
//   emitted event is byte-identical to desktop; only the transport differs.
//   `loading` is explicitly "best-effort" per webPanel.ts, so a sub-poll-window
//   load that never shows a spinner is acceptable; url / canGoBack / canGoForward
//   always settle to the correct value within one tick.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Emitter, Runtime,
};

use crate::models::*;
use crate::Error;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.shioribrowser";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_shiori_browser);

// Poll cadence while the panel is on-screen vs. parked. Visible-only polling
// keeps the steady cost near zero except while the user is actively browsing.
const POLL_VISIBLE: Duration = Duration::from_millis(150);
const POLL_IDLE: Duration = Duration::from_millis(400);

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<ShioriBrowser<R>> {
    #[cfg(target_os = "android")]
    let handle = api
        .register_android_plugin(PLUGIN_IDENTIFIER, "ShioriBrowserPlugin")
        .map_err(|err| Error::Runtime(err.to_string()))?;
    #[cfg(target_os = "ios")]
    let handle = api
        .register_ios_plugin(init_plugin_shiori_browser)
        .map_err(|err| Error::Runtime(err.to_string()))?;

    Ok(ShioriBrowser {
        handle: Arc::new(handle),
        app: app.clone(),
        poll: Arc::new(PollState::default()),
    })
}

#[derive(Default)]
struct PollState {
    started: AtomicBool,
    visible: AtomicBool,
    // A native view exists: `open` succeeded and no `close` followed. Bounds
    // alone never start polling, since polling no view reads an empty
    // snapshot whose nulls would wipe a refused open's error (Android's
    // `web-panel-temporary-unsupported`) and the requested address.
    opened: AtomicBool,
    last: Mutex<Option<WebPanelNav>>,
}

pub struct ShioriBrowser<R: Runtime> {
    handle: Arc<PluginHandle<R>>,
    app: AppHandle<R>,
    poll: Arc<PollState>,
}

impl<R: Runtime> ShioriBrowser<R> {
    pub fn open(&self, payload: OpenPayload) -> crate::Result<()> {
        let url = payload.url.clone();
        self.call("open", payload)?;
        self.poll.opened.store(true, Ordering::SeqCst);
        self.poll.visible.store(true, Ordering::SeqCst);
        self.ensure_poll();
        // Fresh "open" intent — seed the address bar immediately (history
        // resets), mirroring the desktop optimistic `loading:true` emit.
        self.emit_changed(WebPanelNav {
            url: Some(url),
            loading: true,
            ..Default::default()
        });
        Ok(())
    }

    pub fn navigate(&self, url: String) -> crate::Result<()> {
        self.call("navigate", NavigatePayload { url: url.clone() })?;
        self.emit_loading(Some(url));
        Ok(())
    }

    pub fn set_bounds(&self, bounds: WebPanelBounds) -> crate::Result<()> {
        if self.poll.opened.load(Ordering::SeqCst) {
            self.poll.visible.store(true, Ordering::SeqCst);
            self.ensure_poll();
        }
        self.call("setBounds", BoundsPayload { bounds })
    }

    pub fn hide(&self) -> crate::Result<()> {
        self.poll.visible.store(false, Ordering::SeqCst);
        self.call("hide", ())
    }

    pub fn back(&self) -> crate::Result<()> {
        self.call("back", ())?;
        self.emit_loading(None);
        Ok(())
    }

    pub fn forward(&self) -> crate::Result<()> {
        self.call("forward", ())?;
        self.emit_loading(None);
        Ok(())
    }

    pub fn reload(&self) -> crate::Result<()> {
        self.call("reload", ())?;
        self.emit_loading(None);
        Ok(())
    }

    /// Present the native iOS share sheet for an exported file and report
    /// whether the user actually completed a share activity (vs. dismissing the
    /// sheet). Unlike the browser commands this has no nav side effects.
    pub fn share_file(&self, payload: ShareFilePayload) -> crate::Result<bool> {
        self.handle
            .run_mobile_plugin::<ShareFileResult>("shareFile", payload)
            .map(|result| result.completed)
            .map_err(|err| Error::Runtime(err.to_string()))
    }

    pub fn close(&self) -> crate::Result<()> {
        self.poll.opened.store(false, Ordering::SeqCst);
        self.poll.visible.store(false, Ordering::SeqCst);
        self.call("close", ())?;
        // Drop the snapshot so a later reopen re-emits a fresh nav state.
        *self.poll.last.lock().unwrap_or_else(|err| err.into_inner()) = None;
        Ok(())
    }

    /// Forward a command to the native plugin, ignoring the (void) response.
    fn call(&self, command: &str, payload: impl serde::Serialize) -> crate::Result<()> {
        self.handle
            .run_mobile_plugin::<serde_json::Value>(command, payload)
            .map(|_| ())
            .map_err(|err| Error::Runtime(err.to_string()))
    }

    /// Optimistic `loading:true` that preserves the current url / history flags
    /// (used by navigate/back/forward/reload). The poll corrects the rest.
    fn emit_loading(&self, url: Option<String>) {
        let base = self
            .poll
            .last
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
            .unwrap_or_default();
        self.emit_changed(WebPanelNav {
            url: url.or(base.url),
            loading: true,
            can_go_back: base.can_go_back,
            can_go_forward: base.can_go_forward,
            error: None,
        });
    }

    fn emit_changed(&self, nav: WebPanelNav) {
        emit_changed(&self.app, &self.poll, nav);
    }

    /// Start the nav-state poll thread once. It lives for the app's lifetime and
    /// only hits the native bridge while the panel is visible.
    fn ensure_poll(&self) {
        if self.poll.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let handle = self.handle.clone();
        let app = self.app.clone();
        let poll = self.poll.clone();
        let _ = std::thread::Builder::new()
            .name("shiori-browser-nav".into())
            .spawn(move || loop {
                if poll.visible.load(Ordering::SeqCst) {
                    if let Ok(reply) = handle.run_mobile_plugin::<NavStateReply>("navState", ()) {
                        if let Some(url) = reply.external_open {
                            let _ =
                                app.emit("web-panel-external-open", ExternalOpenRequest { url });
                        }
                        emit_changed(&app, &poll, reply.nav);
                    }
                    std::thread::sleep(POLL_VISIBLE);
                } else {
                    std::thread::sleep(POLL_IDLE);
                }
            });
    }
}

/// Emit `web-panel-nav` iff the state changed since the last emit.
fn emit_changed<R: Runtime>(app: &AppHandle<R>, poll: &PollState, nav: WebPanelNav) {
    {
        let mut last = poll.last.lock().unwrap_or_else(|err| err.into_inner());
        if last.as_ref() == Some(&nav) {
            return;
        }
        *last = Some(nav.clone());
    }
    let _ = app.emit("web-panel-nav", nav);
}
