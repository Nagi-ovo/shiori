use serde::{Deserialize, Serialize};

/// Result of the native metrics read. Mirrors the camelCase CPU/memory fields of
/// the app's `ProcessMetrics` (the app adds `platform`). `#[serde(default)]` lets
/// the Kotlin side omit a field (→ `None`) when a reading is unavailable.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MetricsPayload {
    pub cpu_percent: Option<f64>,
    pub memory_bytes: Option<u64>,
}
