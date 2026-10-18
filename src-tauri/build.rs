use std::time::{SystemTime, UNIX_EPOCH};

#[path = "src/app_commands.rs"]
mod app_commands;

const DEFAULT_EXPIRY_DAYS: u64 = 60;

fn main() {
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let expiry_enabled = std::env::var("SHIORI_ENABLE_BUILD_EXPIRY")
        .map(|value| value == "true")
        .unwrap_or(false);
    let expiry_days = if expiry_enabled {
        std::env::var("SHIORI_BUILD_EXPIRY_DAYS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(DEFAULT_EXPIRY_DAYS)
    } else {
        0
    };
    let timestamp_ms = if profile == "release" && expiry_enabled {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| u64::try_from(duration.as_millis()).ok())
            .unwrap_or(0)
    } else {
        0
    };

    // The frontend dist is rebuilt before Tauri's Cargo build. Watching
    // index.html makes release rebuilds pick up a fresh native timestamp
    // whenever the embedded frontend changes.
    println!("cargo:rerun-if-changed=../dist/index.html");
    println!("cargo:rerun-if-env-changed=SHIORI_ENABLE_BUILD_EXPIRY");
    println!("cargo:rerun-if-env-changed=SHIORI_BUILD_EXPIRY_DAYS");
    println!("cargo:rustc-env=SHIORI_BUILD_TIMESTAMP_MS={timestamp_ms}");
    println!("cargo:rustc-env=SHIORI_EXPIRY_DAYS={expiry_days}");

    let manifest_commands = app_commands::APP_COMMANDS
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let platform_commands = app_commands::DESKTOP_APP_COMMANDS
        .iter()
        .chain(app_commands::MOBILE_APP_COMMANDS)
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        manifest_commands, platform_commands,
        "every app command must be authorized on at least one platform"
    );

    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(app_commands::APP_COMMANDS));
    tauri_build::try_build(attributes).expect("failed to run Tauri build script")
}
