// Android implementation: forward to the Kotlin ShioriMetricsPlugin's `getMetrics`
// command via run_mobile_plugin and return the CPU%/memory payload.

use serde::de::DeserializeOwned;
use std::sync::Arc;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::MetricsPayload;
use crate::Error;

const PLUGIN_IDENTIFIER: &str = "app.tauri.shiorimetrics";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<ShioriMetrics<R>> {
    let handle = api
        .register_android_plugin(PLUGIN_IDENTIFIER, "ShioriMetricsPlugin")
        .map_err(|err| Error::Runtime(err.to_string()))?;
    Ok(ShioriMetrics {
        handle: Arc::new(handle),
    })
}

pub struct ShioriMetrics<R: Runtime> {
    handle: Arc<PluginHandle<R>>,
}

impl<R: Runtime> ShioriMetrics<R> {
    /// Read the app's own process CPU% (0-100 machine-relative) and memory.
    pub fn process_metrics(&self) -> crate::Result<MetricsPayload> {
        self.handle
            .run_mobile_plugin::<MetricsPayload>("getMetrics", ())
            .map_err(|err| Error::Runtime(err.to_string()))
    }
}
