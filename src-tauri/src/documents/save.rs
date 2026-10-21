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
    // Same directory as the destination, so the rename never crosses a device
    // boundary (which would make it a copy, and non-atomic).
    let (temp_path, mut file) = create_temp_beside(parent)?;

    let write_result = (|| -> std::io::Result<()> {
        file.write_all(bytes)?;
        // Without fsync the rename can land before the contents do, leaving a
        // zero-length file after a crash or power loss.
        file.sync_all()?;
        Ok(())
    })();
    // Close the temp before chmod and rename, as when the closure owned it:
    // Windows may refuse to remove or rename a file that is still open.
    drop(file);

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

// A fixed temp name opened with File::create followed a symlink already at
// that name, truncating its target and filling it with the document, and the
// rename then turned the document itself into that symlink; two saves of one
// path also shared the temp inode. create_new (O_EXCL, which also refuses a
// symlink) under a per-save name sidesteps whatever sits there. A crash now
// leaves its own temp behind instead of the next save reusing it. The name
// leaves out the destination's: a file name may use all of NAME_MAX, and a
// suffix on it overflowed that.
#[cfg(not(mobile))]
fn create_temp_beside(parent: &Path) -> std::io::Result<(PathBuf, fs::File)> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let pid = std::process::id();
    for _ in 0..16 {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let temp_path = parent.join(format!(".shiori-tmp-{pid}-{n}"));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
        {
            Ok(file) => return Ok((temp_path, file)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "no free temporary file name beside the destination",
    ))
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
    let export_dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| err.to_string())?
        .join("exports");
    let path = shareable_export_path(&path, &export_dir)?;
    app.shiori_browser()
        .share_file(ShareFilePayload {
            path: path.to_string_lossy().into_owned(),
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

// The iOS share sheet offers the file to any app the user picks, so share
// only a file inside the exports folder save_pdf_dialog writes to, the rule
// Android's shareCachedExport (MainActivity.kt) already applies; forwarding
// the path as given let the webview offer any file in the sandbox (drafts,
// WebKit data). Both sides are canonicalised: `..` and symlinks resolve
// first, and iOS reaches the cache through the /var -> /private/var link.
#[cfg(any(mobile, all(test, unix)))]
fn shareable_export_path(
    path: &str,
    export_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let invalid = || "share-export-path-invalid".to_string();
    let export_dir = fs::canonicalize(export_dir).map_err(|_| invalid())?;
    let file = fs::canonicalize(path).map_err(|_| invalid())?;
    if file != export_dir && file.starts_with(&export_dir) && file.is_file() {
        Ok(file)
    } else {
        Err(invalid())
    }
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

    // The temp file sits beside the destination under a name anyone who can
    // write that folder could predict. Whatever already sits there (a planted
    // symlink, a leftover, another save's temp) must not be written through
    // or renamed over the document.
    #[test]
    #[cfg(all(not(mobile), unix))]
    fn atomic_write_never_writes_through_an_existing_temp_entry() {
        let dir = text_image_test_dir("atomic-temp-symlink");
        let victim = dir.join("victim.txt");
        let path = dir.join("note.md");
        fs::write(&victim, b"keep me").unwrap();
        fs::write(&path, b"old").unwrap();
        std::os::unix::fs::symlink(&victim, dir.join(".note.md.shiori-tmp")).unwrap();

        super::write_file_atomically(&path, b"new").unwrap();

        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep me");
        assert!(fs::symlink_metadata(&path).unwrap().file_type().is_file());
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        let _ = fs::remove_dir_all(&dir);
    }

    // The share sheet hands a file to any app the user picks, so the path the
    // webview names must be an export save_pdf_dialog wrote, as on Android
    // (MainActivity.kt shareCachedExport), not any file in the sandbox.
    #[test]
    #[cfg(all(not(mobile), unix))]
    fn share_accepts_only_files_inside_the_exports_folder() {
        let dir = text_image_test_dir("share-exports");
        let exports = dir.join("exports");
        fs::create_dir_all(&exports).unwrap();
        fs::write(exports.join("out.pdf"), b"%PDF").unwrap();
        fs::write(dir.join("drafts.sqlite"), b"private").unwrap();
        std::os::unix::fs::symlink(dir.join("drafts.sqlite"), exports.join("link.pdf")).unwrap();
        let share = |path: std::path::PathBuf| {
            super::shareable_export_path(&path.to_string_lossy(), &exports)
        };

        let ok = share(exports.join("out.pdf")).unwrap();
        assert_eq!(ok, fs::canonicalize(exports.join("out.pdf")).unwrap());
        for bad in [
            dir.join("drafts.sqlite"),
            exports.join("../drafts.sqlite"),
            exports.join("link.pdf"),
            exports.join("missing.pdf"),
            exports.clone(),
        ] {
            assert!(
                share(bad.clone()).is_err(),
                "should refuse {}",
                bad.display()
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    // A file name may use the whole NAME_MAX (255 bytes); the temp beside it
    // must fit too, or saving a long-named note fails.
    #[test]
    #[cfg(all(not(mobile), unix))]
    fn atomic_write_saves_a_file_whose_name_is_near_the_limit() {
        let dir = text_image_test_dir("atomic-long-name");
        let path = dir.join(format!("{}.md", "a".repeat(237)));
        fs::write(&path, b"old").unwrap();
        super::write_file_atomically(&path, b"new").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
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
