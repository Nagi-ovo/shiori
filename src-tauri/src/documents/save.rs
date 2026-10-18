// Writing documents out: Save PDF through the native dialog (raw bytes in the
// request body), text write-back over the file a Markdown/HTML document came
// from, both through an atomic replace, and the mobile share sheet for an
// export.

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use std::fs;
#[cfg(not(mobile))]
use std::path::{Path, PathBuf};
#[cfg(mobile)]
use tauri::Manager;
use tauri::{ipc::Request, AppHandle, Runtime, Webview, WebviewWindow};
#[cfg(not(mobile))]
use tauri_plugin_dialog::DialogExt;

use super::MAX_PDF_BYTES;
#[cfg(not(mobile))]
use super::{validate_text_document_path, MAX_TEXT_DOCUMENT_BYTES};
use crate::{enforce_main_webview, runtime_guard::enforce_runtime_guard};

// The suggested filename crosses the IPC boundary as a fetch header, and
// WebKit's Headers rejects non-ISO-8859-1 values (a CJK filename made the
// frontend throw before the request was even sent). The frontend therefore
// sends it base64-encoded UTF-8; decode it here.
fn suggested_export_name(request: &Request<'_>) -> String {
    request
        .headers()
        .get("x-shiori-suggested-name")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| BASE64_STANDARD.decode(value).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Shiori-export.pdf".to_string())
}

#[tauri::command]
#[cfg(not(mobile))]
pub(crate) async fn save_pdf_dialog<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    request: Request<'_>,
) -> Result<Option<String>, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    let suggested_name = suggested_export_name(&request);
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => return Err("expected-raw-bytes".into()),
    };
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("too-large".into());
    }
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name(suggested_name)
        .set_title("Save PDF")
        .set_parent(&window)
        .blocking_save_file();
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|err| err.to_string())?;
    write_file_atomically(&path, &bytes).map_err(|err| err.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

// Writes an edited Markdown/HTML document back over the file it was opened
// from. The only command in the app that writes to a caller-supplied path, so
// it is deliberately narrow: absolute path, a text-document extension, and the
// destination must already exist as a regular file. Refusing to create files
// means a path that moved or was deleted fails loudly and the frontend can
// offer Save As, instead of silently resurrecting a file somewhere stale.
#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn write_text_document_at_path<R: Runtime>(
    caller: Webview<R>,
    path: String,
    contents: String,
) -> Result<u64, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    let path = PathBuf::from(path);
    validate_text_document_path(&path)?;
    let bytes = contents.into_bytes();
    if bytes.len() as u64 > MAX_TEXT_DOCUMENT_BYTES {
        return Err("too-large".into());
    }
    write_file_atomically(&path, &bytes).map_err(|err| err.to_string())?;
    Ok(bytes.len() as u64)
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn write_text_document_at_path<R: Runtime>(
    caller: Webview<R>,
    _path: String,
    _contents: String,
) -> Result<u64, String> {
    enforce_main_webview(&caller)?;
    Err("native-paths-unsupported".into())
}

// Atomic replace: write beside the target, flush it to disk, then rename over
// the destination. `fs::write` truncates the destination FIRST, so a failure
// part-way through a large export (full disk, removable or network volume, the
// process killed) left the user with neither the export nor the file it was
// overwriting — and picking the currently open PDF in the save dialog is the
// most natural way to "save". rename(2) within a directory is atomic, so a
// reader either sees the old file or the complete new one.
//
// Mirrors cli/src/atomicOutput.ts, which already does this for the CLI.
#[cfg(not(mobile))]
fn write_file_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;

    // rename(2) replaces the *link*, not its target, so writing through a
    // symlinked note would turn the link into a regular file and orphan the
    // real one. Resolve first when the destination exists; a not-yet-created
    // destination (Save As to a new name) has nothing to resolve.
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let path = resolved.as_path();

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "export".to_string());
    // Same directory as the destination, so the rename never crosses a device
    // boundary (which would make it a copy, and non-atomic).
    let temp_path = parent.join(format!(".{file_name}.shiori-tmp"));

    let write_result = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temp_path)?;
        file.write_all(bytes)?;
        // Without fsync the rename can land before the contents do, leaving a
        // zero-length file after a crash or power loss.
        file.sync_all()?;
        Ok(())
    })();

    if let Err(err) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    // A fresh temp file is born 0644 & umask. Replacing a 0600 private note
    // with a world-readable one is a silent permission downgrade, so carry the
    // destination's own mode across when it already exists.
    #[cfg(unix)]
    if let Ok(metadata) = fs::metadata(path) {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = fs::set_permissions(
            &temp_path,
            fs::Permissions::from_mode(metadata.permissions().mode()),
        );
    }

    if let Err(err) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }
    Ok(())
}

#[tauri::command]
#[cfg(mobile)]
pub(crate) async fn save_pdf_dialog<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    _window: WebviewWindow<R>,
    request: Request<'_>,
) -> Result<Option<String>, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    let suggested_name = suggested_export_name(&request);
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => return Err("expected-raw-bytes".into()),
    };
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("too-large".into());
    }
    let export_dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| err.to_string())?
        .join("exports");
    fs::create_dir_all(&export_dir).map_err(|err| err.to_string())?;
    // Every export lands in this cache dir and nothing ever removed them —
    // distinct documents accumulated until the OS reclaimed the cache (the
    // updates cache prunes before each download; exports now follow suit).
    // Age-based rather than wipe-all: a share sheet from a previous export
    // may still be reading its file, so only entries older than a day go.
    prune_stale_exports(&export_dir);
    let filename = sanitize_export_filename(&suggested_name);
    let path = export_dir.join(filename);
    fs::write(&path, bytes).map_err(|err| err.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg(mobile)]
fn prune_stale_exports(export_dir: &std::path::Path) {
    const MAX_EXPORT_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
    let Ok(entries) = fs::read_dir(export_dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > MAX_EXPORT_AGE);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Present the native share sheet for an exported file. Mobile only — desktop
/// writes directly through the save dialog and never calls this. On iOS this
/// routes through the shiori-browser plugin's `share_file`
/// (`UIActivityViewController`); Android shares via its own JS bridge
/// (`window.ShioriAndroid.shareExport`) and never invokes this command.
#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn share_exported_file<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    path: String,
    filename: String,
    mime: String,
) -> Result<bool, String> {
    use tauri_plugin_shiori_browser::{ShareFilePayload, ShioriBrowserExt};
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    app.shiori_browser()
        .share_file(ShareFilePayload {
            path,
            filename,
            mime,
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn share_exported_file<R: Runtime>(
    caller: Webview<R>,
    _app: AppHandle<R>,
    _path: String,
    _filename: String,
    _mime: String,
) -> Result<bool, String> {
    enforce_main_webview(&caller)?;
    Err("share-not-supported-on-desktop".into())
}

#[cfg(mobile)]
fn sanitize_export_filename(value: &str) -> String {
    let mut clean = value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("Shiori-export.pdf")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | ' ') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string();
    if clean.is_empty() {
        clean = "Shiori-export.pdf".into();
    }
    if clean.len() <= 160 {
        return clean;
    }
    let extension = clean
        .rfind('.')
        .filter(|index| *index > 0)
        .map(|index| clean[index..].chars().take(16).collect::<String>())
        .unwrap_or_default();
    let stem_len = 160usize.saturating_sub(extension.len());
    let stem = clean
        .chars()
        .take(stem_len)
        .collect::<String>()
        .trim()
        .to_string();
    format!("{stem}{extension}")
}

#[cfg(test)]
mod tests {
    #[cfg(not(mobile))]
    use crate::documents::text_image_test_dir;
    #[cfg(not(mobile))]
    use std::fs;

    // Save-back writes over a file the user already owns, so the replace must
    // not quietly change what that file IS: a symlinked note stays a symlink,
    // and a private note stays private.
    #[test]
    #[cfg(all(not(mobile), unix))]
    fn atomic_write_follows_symlinks_instead_of_replacing_them() {
        let dir = text_image_test_dir("atomic-symlink");
        let real = dir.join("real.md");
        let link = dir.join("link.md");
        fs::write(&real, b"original").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        super::write_file_atomically(&link, b"edited").unwrap();

        assert_eq!(fs::read_to_string(&real).unwrap(), "edited");
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the link itself must survive the replace"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(all(not(mobile), unix))]
    fn atomic_write_preserves_the_destination_permissions() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = text_image_test_dir("atomic-perms");
        let path = dir.join("private.md");
        fs::write(&path, b"secret").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        super::write_file_atomically(&path, b"still secret").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a 0600 note must not become world-readable");
        assert_eq!(fs::read_to_string(&path).unwrap(), "still secret");
        let _ = fs::remove_dir_all(&dir);
    }

    // Writing to a path that does not exist yet is the Save As case: no
    // destination to resolve or copy a mode from, and it must still work.
    #[test]
    #[cfg(not(mobile))]
    fn atomic_write_creates_a_missing_destination() {
        let dir = text_image_test_dir("atomic-create");
        let path = dir.join("new.md");
        super::write_file_atomically(&path, b"fresh").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "fresh");
        let _ = fs::remove_dir_all(&dir);
    }
}
