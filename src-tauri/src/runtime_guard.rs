// Native beta expiry (AGENTS.md fact 8). A build made with
// SHIORI_ENABLE_BUILD_EXPIRY carries its build timestamp and expiry window
// (build.rs); public and store builds carry zeros and never expire. Commands
// that reach files, processes or the network call `enforce_runtime_guard`, and
// the frontend reads `runtime_guard_status` (src/platform/runtimeGuard.ts).

use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Runtime, Webview};

use crate::enforce_main_webview;

const MS_PER_DAY: u64 = 24 * 60 * 60 * 1000;

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeGuardStatus {
    build_timestamp: u64,
    expiry_days: u64,
    expires_at: Option<u64>,
    expired: bool,
}

#[tauri::command]
#[specta::specta]
pub(crate) fn runtime_guard_status<R: Runtime>(
    caller: Webview<R>,
) -> Result<RuntimeGuardStatus, String> {
    enforce_main_webview(&caller)?;
    Ok(runtime_guard_status_at(now_ms()))
}

pub(crate) fn enforce_runtime_guard() -> Result<(), String> {
    if runtime_guard_status_at(now_ms()).expired {
        return Err("runtime-expired".into());
    }
    Ok(())
}

fn runtime_guard_status_at(now: u64) -> RuntimeGuardStatus {
    let build_timestamp = native_build_timestamp_ms();
    let expiry_days = native_expiry_days();
    let expires_at = build_timestamp
        .checked_add(expiry_days.saturating_mul(MS_PER_DAY))
        .filter(|_| build_timestamp > 0 && expiry_days > 0);
    let expired = expires_at.is_some_and(|expires_at| now > expires_at);
    RuntimeGuardStatus {
        build_timestamp,
        expiry_days,
        expires_at,
        expired,
    }
}

fn native_build_timestamp_ms() -> u64 {
    option_env!("SHIORI_BUILD_TIMESTAMP_MS")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

fn native_expiry_days() -> u64 {
    option_env!("SHIORI_EXPIRY_DAYS")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_runtime_guard_expiry_uses_strict_expiry_boundary() {
        let build = super::native_build_timestamp_ms();
        let days = super::native_expiry_days();
        if build == 0 {
            assert!(!runtime_guard_status_at(u64::MAX).expired);
            return;
        }

        let expires = build + days * MS_PER_DAY;
        assert!(!runtime_guard_status_at(expires).expired);
        assert!(runtime_guard_status_at(expires + 1).expired);
    }
}
