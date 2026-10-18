// Documents handed to Shiori by the OS rather than picked in the app: macOS /
// iOS `RunEvent::Opened`, Windows / Linux launch argv and second-instance
// argv. Every route feeds one pending queue that the frontend drains after it
// mounts (and acks per path), plus a `file-open` event for a frontend that is
// already listening. Android keeps its own intent queue in MainActivity.kt
// and hands it to the webview directly.

use std::sync::Mutex;
#[cfg(any(
    target_os = "windows",
    target_os = "linux",
    target_os = "macos",
    target_os = "ios"
))]
use tauri::AppHandle;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use tauri::Manager;
#[cfg(any(target_os = "macos", target_os = "ios"))]
use tauri::Url;
use tauri::{Runtime, Webview};

#[cfg(any(
    target_os = "windows",
    target_os = "linux",
    target_os = "macos",
    target_os = "ios"
))]
use crate::emit_to_main;
use crate::enforce_main_webview;
#[cfg(not(mobile))]
use crate::runtime_guard::enforce_runtime_guard;
static PENDING_OPEN_PATHS: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[tauri::command]
#[specta::specta]
pub(crate) fn drain_pending_open_paths<R: Runtime>(
    caller: Webview<R>,
) -> Result<Vec<String>, String> {
    enforce_main_webview(&caller)?;
    #[cfg(not(mobile))]
    enforce_runtime_guard()?;
    let mut paths = PENDING_OPEN_PATHS.lock().unwrap();
    Ok(paths.drain(..).collect())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn ack_pending_open_path<R: Runtime>(
    caller: Webview<R>,
    path: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    let mut paths = PENDING_OPEN_PATHS.lock().unwrap();
    paths.retain(|candidate| candidate != &path);
    Ok(())
}

fn enqueue_pending_open_target(target: String) {
    if let Ok(mut pending) = PENDING_OPEN_PATHS.lock() {
        pending.push(target);
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn dispatch_open_target<R: Runtime>(app: &AppHandle<R>, target: String) {
    enqueue_pending_open_target(target.clone());
    let _ = emit_to_main(app, "file-open", target);
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn open_target_from_url(url: Url) -> String {
    #[cfg(target_os = "ios")]
    {
        url.to_string()
    }
    #[cfg(target_os = "macos")]
    {
        url.to_file_path()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default()
    }
}

#[cfg_attr(not(any(target_os = "windows", target_os = "linux")), allow(dead_code))]
const OPENABLE_EXTS: [&str; 6] = ["pdf", "md", "markdown", "html", "htm", "docx"];

#[cfg_attr(not(any(target_os = "windows", target_os = "linux")), allow(dead_code))]
fn openable_path_from_arg(
    arg: &str,
    base_dir: Option<&std::path::Path>,
    is_file: impl Fn(&std::path::Path) -> bool,
    is_dir: impl Fn(&std::path::Path) -> bool,
) -> Option<String> {
    if arg.is_empty() || arg.starts_with('-') {
        return None;
    }
    let raw = std::path::Path::new(arg);
    let abs: std::path::PathBuf = if raw.is_absolute() {
        raw.to_path_buf()
    } else if let Some(base) = base_dir {
        base.join(raw)
    } else {
        raw.to_path_buf()
    };
    let ext_ok = abs
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| OPENABLE_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false);
    if !is_dir(&abs) && (!ext_ok || !is_file(&abs)) {
        return None;
    }
    Some(abs.to_string_lossy().to_string())
}

// First launch on Windows/Linux: a file association or a command-line launch puts
// the targets in this process's own argv.
#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(crate) fn enqueue_launch_args() {
    let cwd = std::env::current_dir().ok();
    for arg in std::env::args().skip(1) {
        if let Some(target) = openable_path_from_arg(
            &arg,
            cwd.as_deref(),
            |path| path.is_file(),
            |path| path.is_dir(),
        ) {
            enqueue_pending_open_target(target);
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(crate) fn on_second_instance<R: Runtime>(app: &AppHandle<R>, argv: Vec<String>, cwd: String) {
    // Windows/Linux file associations launch a second process with the
    // target path in argv. The plugin hands that argv to this running
    // instance, where we feed the same pending-open queue used by macOS.
    let base = std::path::PathBuf::from(cwd);
    let mut opened_any = false;
    for arg in argv.iter().skip(1) {
        if let Some(target) = openable_path_from_arg(
            arg,
            Some(&base),
            |path| path.is_file(),
            |path| path.is_dir(),
        ) {
            dispatch_open_target(app, target);
            opened_any = true;
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = opened_any;
}

// Native file-open (macOS/iOS): buffer the opened document so the
// frontend can drain it after mounting, and also emit for the warm
// case where the listener is already registered. The frontend listens
// before draining and dedupes, so the same file is never opened twice.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub(crate) fn on_opened<R: Runtime>(app: &AppHandle<R>, urls: &[Url]) {
    for url in urls {
        let open_target = open_target_from_url(url.clone());
        if open_target.is_empty() {
            continue;
        }
        enqueue_pending_open_target(open_target.clone());
        let _ = emit_to_main(app, "file-open", open_target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn desktop_open_target_uses_file_paths() {
        let url = Url::parse("file:///tmp/Shiori%20Notes.pdf").unwrap();
        assert_eq!(
            open_target_from_url(url),
            "/tmp/Shiori Notes.pdf".to_string()
        );
    }

    #[test]
    fn arg_filter_resolves_supported_files() {
        let base = std::path::Path::new("/work");
        let yes = |_: &std::path::Path| true;
        let no = |_: &std::path::Path| false;
        assert_eq!(
            openable_path_from_arg("a.PDF", Some(base), yes, no),
            Some(base.join("a.PDF").to_string_lossy().to_string())
        );
        assert_eq!(
            openable_path_from_arg("/abs/b.md", None, yes, no),
            Some(
                std::path::Path::new("/abs/b.md")
                    .to_string_lossy()
                    .to_string()
            )
        );
        assert_eq!(openable_path_from_arg("--flag", Some(base), yes, no), None);
        assert_eq!(
            openable_path_from_arg("note.txt", Some(base), yes, no),
            None
        );
        assert_eq!(openable_path_from_arg("c.pdf", Some(base), no, no), None);
    }

    #[test]
    fn arg_filter_accepts_directories_without_document_extensions() {
        let base = std::path::Path::new("/work");
        assert_eq!(
            openable_path_from_arg("papers", Some(base), |_| false, |_| true),
            Some(base.join("papers").to_string_lossy().to_string())
        );
    }
}
