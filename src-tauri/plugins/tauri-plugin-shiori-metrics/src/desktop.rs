// Non-Android stub. Desktop reads metrics via sysinfo and iOS via Mach, both
// directly in the app's collect_process_metrics — this plugin is only registered
// and called on Android. These no-ops exist so the crate compiles for other
// targets (e.g. `cargo check` of the plugin in isolation on the dev host).

use serde::de::DeserializeOwned;
use std::marker::PhantomData;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::MetricsPayload;

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<ShioriMetrics<R>> {
    Ok(ShioriMetrics(PhantomData))
}

pub struct ShioriMetrics<R: Runtime>(PhantomData<R>);

impl<R: Runtime> ShioriMetrics<R> {
    pub fn process_metrics(&self) -> crate::Result<MetricsPayload> {
        Ok(MetricsPayload::default())
    }
}
