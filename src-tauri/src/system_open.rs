// Hand-offs to the OS shell: open or reveal an exported PDF, and open an
// http(s)/mailto URL in the default handler (`open`, `rundll32` or
// `xdg-open`). Desktop only; mobile keeps the commands as unsupported stubs.

#[cfg(not(mobile))]
use std::{path::PathBuf, process::Command};
use tauri::{Runtime, Webview};

use crate::enforce_main_webview;
#[cfg(not(mobile))]
use crate::{documents::validate_pdf_path, runtime_guard::enforce_runtime_guard};

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn open_exported_pdf<R: Runtime>(
    caller: Webview<R>,
    path: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    let path = PathBuf::from(path);
    validate_pdf_path(&path)?;
    open_path(&path)
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn open_exported_pdf<R: Runtime>(
    caller: Webview<R>,
    _path: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Err("native-paths-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn reveal_exported_pdf<R: Runtime>(
    caller: Webview<R>,
    path: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    let path = PathBuf::from(path);
    validate_pdf_path(&path)?;
    reveal_path(&path)
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn reveal_exported_pdf<R: Runtime>(
    caller: Webview<R>,
    _path: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Err("native-paths-unsupported".into())
}

#[cfg(not(mobile))]
fn open_path(path: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(path).status();

    #[cfg(target_os = "windows")]
    let status = Command::new("rundll32")
        .args([
            "url.dll,FileProtocolHandler",
            path.to_string_lossy().as_ref(),
        ])
        .status();

    #[cfg(all(not(mobile), unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(path).status();

    command_status_result(status, "open-file")
}

#[cfg(not(mobile))]
fn reveal_path(path: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open")
        .args(["-R", path.to_string_lossy().as_ref()])
        .status();

    #[cfg(target_os = "windows")]
    let status = Command::new("explorer")
        .arg(format!("/select,{}", path.to_string_lossy()))
        .status();

    #[cfg(all(not(mobile), unix, not(target_os = "macos")))]
    let status = {
        let dir = path.parent().unwrap_or(path.as_path());
        Command::new("xdg-open").arg(dir).status()
    };

    command_status_result(status, "reveal-file")
}

#[cfg(not(mobile))]
fn command_status_result(
    status: std::io::Result<std::process::ExitStatus>,
    label: &str,
) -> Result<(), String> {
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("{label}-failed-{status}")),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(not(mobile))]
pub(crate) fn open_external_url_impl(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:"))
    {
        return Err("unsupported-url".into());
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(&url).status();

    #[cfg(target_os = "windows")]
    let status = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .status();

    #[cfg(all(not(mobile), unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(&url).status();

    command_status_result(status, "open")
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn open_external_url<R: Runtime>(caller: Webview<R>, url: String) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    open_external_url_impl(url)
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn open_external_url<R: Runtime>(
    caller: Webview<R>,
    _url: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Err("system-open-unsupported".into())
}
