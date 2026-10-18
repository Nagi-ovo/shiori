//! Tauri plugin exposing the app's own process CPU/memory on Android.
//!
//! Android process metrics come from Java/Kotlin APIs (`android.os.Process`,
//! `ActivityManager`), so unlike desktop (sysinfo) and iOS (Mach task_info,
//! both handled directly in `src-tauri/src/lib.rs`) Android needs a native
//! plugin. The app's `get_process_metrics` command forwards to
//! [`ShioriMetricsExt::shiori_metrics`] under `#[cfg(target_os = "android")]`.
//! It exposes no JS command surface; it is Android-only and a no-op stub
//! everywhere else (so the crate still compiles when checked in isolation).
//!
//! Register it in the app's `run()` builder under `#[cfg(target_os = "android")]`
//! (AGENTS.md fact #7 — every plugin must be `.plugin()`-ed, or Tauri surfaces
//! a misleading "plugin not found" error).

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod error;
mod models;

pub use error::{Error, Result};
pub use models::*;

#[cfg(target_os = "android")]
mod mobile;
#[cfg(not(target_os = "android"))]
mod desktop;

#[cfg(target_os = "android")]
use mobile::ShioriMetrics;
#[cfg(not(target_os = "android"))]
use desktop::ShioriMetrics;

/// Extension trait to reach the metrics API from any [`Manager`]
/// (`AppHandle`, …): `app.shiori_metrics().process_metrics()`.
pub trait ShioriMetricsExt<R: Runtime> {
    fn shiori_metrics(&self) -> &ShioriMetrics<R>;
}

impl<R: Runtime, T: Manager<R>> ShioriMetricsExt<R> for T {
    fn shiori_metrics(&self) -> &ShioriMetrics<R> {
        self.state::<ShioriMetrics<R>>().inner()
    }
}

/// Initialize the plugin. Register under `#[cfg(target_os = "android")]`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("shiori-metrics")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let metrics = mobile::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let metrics = desktop::init(app, api)?;
            app.manage(metrics);
            Ok(())
        })
        .build()
}
