// Desktop stub. The embedded browser uses Tauri's native child webview
// (`Window::add_child`) on desktop — handled directly in the app's
// `#[cfg(not(mobile))]` `web_panel_*` arms — so this plugin is never registered
// or called on desktop. These no-ops exist only so the crate compiles for
// desktop targets (e.g. `cargo check` of the plugin in isolation).

use serde::de::DeserializeOwned;
use std::marker::PhantomData;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<ShioriBrowser<R>> {
    Ok(ShioriBrowser(PhantomData))
}

pub struct ShioriBrowser<R: Runtime>(PhantomData<R>);

impl<R: Runtime> ShioriBrowser<R> {
    pub fn open(&self, _payload: OpenPayload) -> crate::Result<()> {
        Ok(())
    }
    pub fn navigate(&self, _url: String) -> crate::Result<()> {
        Ok(())
    }
    pub fn set_bounds(&self, _bounds: WebPanelBounds) -> crate::Result<()> {
        Ok(())
    }
    pub fn hide(&self) -> crate::Result<()> {
        Ok(())
    }
    pub fn back(&self) -> crate::Result<()> {
        Ok(())
    }
    pub fn forward(&self) -> crate::Result<()> {
        Ok(())
    }
    pub fn reload(&self) -> crate::Result<()> {
        Ok(())
    }
    pub fn close(&self) -> crate::Result<()> {
        Ok(())
    }
    pub fn share_file(&self, _payload: ShareFilePayload) -> crate::Result<bool> {
        Ok(false)
    }
}
