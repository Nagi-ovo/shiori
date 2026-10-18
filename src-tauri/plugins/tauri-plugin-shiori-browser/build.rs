// The embedded browser panel is driven entirely from Rust: the app's
// `web_panel_*` commands (src-tauri/src/lib.rs, `#[cfg(mobile)]` arms) forward
// to this plugin's Rust API. The plugin therefore exposes NO JavaScript command
// surface, so COMMANDS is empty — there is nothing for the webview ACL to gate.
// `android_path`/`ios_path` still point tauri-build at the native modules so the
// Tauri mobile CLI wires the Kotlin/Swift sources into gen/android & gen/apple.
const COMMANDS: &[&str] = &[];

fn main() {
    let result = tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .try_build();

    // Building docs for Android always fails the plugin build step and is
    // irrelevant to crate docs — mirror the upstream plugins' guard.
    if !(cfg!(docsrs) && std::env::var("TARGET").unwrap_or_default().contains("android")) {
        result.unwrap();
    }
}
