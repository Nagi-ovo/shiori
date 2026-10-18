// This plugin is driven entirely from Rust: the app's `get_process_metrics`
// command (src-tauri/src/lib.rs, `#[cfg(target_os = "android")]`) forwards to
// it. It exposes NO JavaScript command surface, so COMMANDS is empty — there is
// nothing for the webview ACL to gate. `android_path` points tauri-build at the
// Kotlin module so the Tauri mobile CLI wires it into gen/android. iOS reads
// metrics via Mach directly in lib.rs, so this plugin is Android-only and needs
// no ios_path.
const COMMANDS: &[&str] = &[];

fn main() {
    let result = tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .try_build();

    // Building docs for Android always fails the plugin build step and is
    // irrelevant to crate docs — mirror the upstream plugins' guard.
    if !(cfg!(docsrs) && std::env::var("TARGET").unwrap_or_default().contains("android")) {
        result.unwrap();
    }
}
