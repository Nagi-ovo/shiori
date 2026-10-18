// Opening documents: the native pickers (with the macOS file-or-folder
// panel), document and PDF info and bytes by path, open-target
// classification and the shallow folder listing, plus the per-kind size caps
// every read and write checks. Writing lives in save.rs, Markdown/HTML
// relative images in text_images.rs.

pub(crate) mod save;
pub(crate) mod text_images;

use serde::Serialize;
#[cfg(not(mobile))]
use std::fs;
#[cfg(not(mobile))]
use std::path::{Path, PathBuf};
use tauri::{ipc::Response, AppHandle, Runtime, Webview, WebviewWindow};
#[cfg(not(mobile))]
use tauri_plugin_dialog::DialogExt;

use crate::enforce_main_webview;
#[cfg(not(mobile))]
use crate::runtime_guard::enforce_runtime_guard;

pub(crate) const MAX_PDF_BYTES: u64 = 200 * 1024 * 1024;

const MAX_TEXT_DOCUMENT_BYTES: u64 = 25 * 1024 * 1024;

/// The webview renderer inflates DOCX synchronously, so keep the native
/// pre-read ceiling aligned with the frontend package budget.
const MAX_DOCX_BYTES: u64 = 50 * 1024 * 1024;

#[cfg(not(mobile))]
const FOLDER_ENTRY_LIMIT: usize = 5_000;

#[cfg(not(mobile))]
const FOLDER_SCAN_LIMIT: usize = 20_000;

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfFileInfo {
    name: String,
    size: u64,
    path: String,
}

#[derive(Debug, Serialize, Clone, Copy, Eq, PartialEq, specta::Type)]
#[serde(rename_all = "lowercase")]
enum DocumentKind {
    Pdf,
    Markdown,
    Html,
    /// OOXML Word. Binary like a PDF: read-only, no text working copy.
    /// `.doc` is deliberately not here — it is the older OLE format and the
    /// renderer cannot open it.
    Docx,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct FolderEntry {
    name: String,
    path: String,
    is_directory: bool,
    kind: Option<DocumentKind>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderListing {
    entries: Vec<FolderEntry>,
    truncated: bool,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenTargetInfo {
    path: String,
    is_directory: bool,
    kind: Option<DocumentKind>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentFileInfo {
    name: String,
    size: u64,
    path: String,
    kind: DocumentKind,
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn open_document_dialog<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Vec<DocumentFileInfo>, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    // Multi-select, like the mobile picker and the file-association route that
    // both already open N documents at once. An empty vec means cancelled.
    let picked = app
        .dialog()
        .file()
        .add_filter(
            "Documents",
            &["pdf", "md", "markdown", "html", "htm", "docx"],
        )
        .add_filter("PDF", &["pdf"])
        .add_filter("Markdown", &["md", "markdown"])
        .add_filter("HTML", &["html", "htm"])
        .add_filter("Word", &["docx"])
        .set_title("Open Documents")
        .set_parent(&window)
        .blocking_pick_files();
    let Some(paths) = picked else {
        return Ok(Vec::new());
    };
    let mut infos = Vec::with_capacity(paths.len());
    for path in paths {
        // Deliberately propagates instead of skipping. A file that cannot be
        // described (over the size limit, gone between pick and stat) is the
        // one thing the user must be told about — silently returning the
        // others is the very bug multi-select was added to fix.
        infos.push(read_document_info(
            path.into_path().map_err(|err| err.to_string())?,
        )?);
    }
    Ok(infos)
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn open_pdf_dialog<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    title: String,
) -> Result<Option<PdfFileInfo>, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    // Page insertion is intentionally single-source. A PDF-only native panel
    // prevents a Word/Markdown selection from reaching the merge boundary and
    // matches Preview/PDF Expert's "pages from file" interaction.
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_title(title)
        .set_parent(&window)
        .blocking_pick_file();
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|err| err.to_string())?;
    read_pdf_info(path).map(Some)
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn open_pdf_dialog<R: Runtime>(
    caller: Webview<R>,
    _app: AppHandle<R>,
    _window: WebviewWindow<R>,
    _title: String,
) -> Result<Option<PdfFileInfo>, String> {
    enforce_main_webview(&caller)?;
    Err("mobile-document-picker-unimplemented".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn open_document_dialog<R: Runtime>(
    caller: Webview<R>,
    _app: AppHandle<R>,
    _window: WebviewWindow<R>,
) -> Result<Vec<DocumentFileInfo>, String> {
    enforce_main_webview(&caller)?;
    Err("mobile-document-picker-unimplemented".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn pick_folder<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<Vec<String>, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;

    // AppKit is the one supported native picker that can choose files AND
    // directories in the same panel. The frontend treats this command as the
    // navigator's unified Add target on macOS, then classifies the returned
    // path. Keeping this below the WebView seam means it is a real NSOpenPanel,
    // not a hand-painted file manager inside React.
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        return pick_file_or_folder_macos(&app);
    }

    // Windows Common Item Dialog and Linux GTK/portal pickers expose mutually
    // exclusive file/folder modes. This command remains the native folder
    // half of the platform abstraction there.
    #[cfg(not(target_os = "macos"))]
    let picked = app
        .dialog()
        .file()
        .set_parent(&window)
        .blocking_pick_folder();
    #[cfg(not(target_os = "macos"))]
    let Some(path) = picked
    else {
        return Ok(Vec::new());
    };
    #[cfg(not(target_os = "macos"))]
    let path = path.into_path().map_err(|err| err.to_string())?;
    #[cfg(not(target_os = "macos"))]
    Ok(vec![path.to_string_lossy().to_string()])
}

#[cfg(target_os = "macos")]
fn pick_file_or_folder_macos<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<String>, String> {
    use std::ffi::{CStr, CString};
    use std::sync::mpsc;

    let (sender, receiver) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        use objc::runtime::{Object, YES};
        use objc::{class, msg_send, sel, sel_impl};

        let result = unsafe {
            // The pool bounds the autoreleased NSString/NSArray objects created
            // for this modal turn; Tauri's long-lived UI thread does not give
            // this closure its own pool automatically.
            let pool: *mut Object = msg_send![class!(NSAutoreleasePool), new];
            let panel: *mut Object = msg_send![class!(NSOpenPanel), openPanel];
            let _: () = msg_send![panel, setCanChooseFiles: YES];
            let _: () = msg_send![panel, setCanChooseDirectories: YES];
            let _: () = msg_send![panel, setAllowsMultipleSelection: YES];
            let _: () = msg_send![panel, setResolvesAliases: YES];

            // `allowedFileTypes` still permits directories when
            // canChooseDirectories is true, while disabling unrelated files.
            // It is deprecated only in favour of UTType objects; unlike a
            // UTI-only list it also works on the oldest macOS version Shiori
            // currently supports.
            let extensions = ["pdf", "md", "markdown", "html", "htm", "docx"];
            let extension_strings: Vec<*mut Object> = extensions
                .iter()
                .map(|extension| {
                    let extension =
                        CString::new(*extension).expect("static file extension contains no NUL");
                    msg_send![class!(NSString), stringWithUTF8String: extension.as_ptr()]
                })
                .collect();
            let allowed_types: *mut Object = msg_send![
                class!(NSArray),
                arrayWithObjects: extension_strings.as_ptr()
                count: extension_strings.len()
            ];
            let _: () = msg_send![panel, setAllowedFileTypes: allowed_types];

            let response: isize = msg_send![panel, runModal];
            let selected = if response == 1 {
                // NSModalResponseOK is 1 on every supported macOS SDK.
                let urls: *mut Object = msg_send![panel, URLs];
                let count: usize = msg_send![urls, count];
                let mut paths = Vec::with_capacity(count);
                let mut invalid_path = false;
                for index in 0..count {
                    let url: *mut Object = msg_send![urls, objectAtIndex: index];
                    let path: *mut Object = msg_send![url, path];
                    let utf8: *const std::os::raw::c_char = msg_send![path, UTF8String];
                    if utf8.is_null() {
                        invalid_path = true;
                        break;
                    }
                    paths.push(CStr::from_ptr(utf8).to_string_lossy().into_owned());
                }
                if invalid_path {
                    Err("open-target-invalid-path".to_string())
                } else {
                    Ok(paths)
                }
            } else {
                Ok(Vec::new())
            };
            let _: () = msg_send![pool, drain];
            selected
        };
        let _ = sender.send(result);
    })
    .map_err(|err| err.to_string())?;

    receiver
        .recv()
        .map_err(|_| "open-target-panel-closed".to_string())?
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn pick_folder<R: Runtime>(
    caller: Webview<R>,
    _app: AppHandle<R>,
    _window: WebviewWindow<R>,
) -> Result<Vec<String>, String> {
    enforce_main_webview(&caller)?;
    Err("native-paths-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn classify_open_target<R: Runtime>(
    caller: Webview<R>,
    path: String,
) -> Result<OpenTargetInfo, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    classify_open_target_at_path(PathBuf::from(path))
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn classify_open_target<R: Runtime>(
    caller: Webview<R>,
    _path: String,
) -> Result<OpenTargetInfo, String> {
    enforce_main_webview(&caller)?;
    Err("native-paths-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn list_folder_entries<R: Runtime>(
    caller: Webview<R>,
    path: String,
) -> Result<FolderListing, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    tauri::async_runtime::spawn_blocking(move || list_folder_entries_at_path(PathBuf::from(path)))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn list_folder_entries<R: Runtime>(
    caller: Webview<R>,
    _path: String,
) -> Result<FolderListing, String> {
    enforce_main_webview(&caller)?;
    Err("native-paths-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn read_document_info_at_path<R: Runtime>(
    caller: Webview<R>,
    path: String,
) -> Result<DocumentFileInfo, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    read_document_info(PathBuf::from(path))
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn read_document_info_at_path<R: Runtime>(
    caller: Webview<R>,
    _path: String,
) -> Result<DocumentFileInfo, String> {
    enforce_main_webview(&caller)?;
    Err("native-paths-unsupported".into())
}

#[tauri::command]
#[cfg(not(mobile))]
pub(crate) async fn read_document_bytes_at_path<R: Runtime>(
    caller: Webview<R>,
    path: String,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    let path = PathBuf::from(path);
    validate_document_path(&path)?;
    let bytes = fs::read(&path).map_err(document_io_error)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
#[cfg(mobile)]
pub(crate) async fn read_document_bytes_at_path<R: Runtime>(
    caller: Webview<R>,
    _path: String,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    Err("native-paths-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn read_pdf_info_at_path<R: Runtime>(
    caller: Webview<R>,
    path: String,
) -> Result<PdfFileInfo, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    read_pdf_info(PathBuf::from(path))
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn read_pdf_info_at_path<R: Runtime>(
    caller: Webview<R>,
    _path: String,
) -> Result<PdfFileInfo, String> {
    enforce_main_webview(&caller)?;
    Err("native-paths-unsupported".into())
}

#[tauri::command]
#[cfg(not(mobile))]
pub(crate) async fn read_pdf_bytes_at_path<R: Runtime>(
    caller: Webview<R>,
    path: String,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    let path = PathBuf::from(path);
    validate_pdf_path(&path)?;
    let bytes = fs::read(&path).map_err(document_io_error)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
#[cfg(mobile)]
pub(crate) async fn read_pdf_bytes_at_path<R: Runtime>(
    caller: Webview<R>,
    _path: String,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    Err("native-paths-unsupported".into())
}

/// Reading a document the user opened before: a file (or folder) that is gone
/// becomes a code the frontend translates ("moved or deleted"); anything else
/// keeps the OS text, since permission or sharing failures are not "missing".
/// `NotFound` covers POSIX ENOENT and Windows errors 2 and 3.
#[cfg(not(mobile))]
fn document_io_error(err: std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::NotFound {
        "document-path-unavailable".into()
    } else {
        err.to_string()
    }
}

#[cfg(not(mobile))]
fn read_pdf_info(path: PathBuf) -> Result<PdfFileInfo, String> {
    let size = validate_pdf_path(&path)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.pdf")
        .to_string();
    Ok(PdfFileInfo {
        name,
        size,
        path: path.to_string_lossy().to_string(),
    })
}

#[cfg(not(mobile))]
fn read_document_info(path: PathBuf) -> Result<DocumentFileInfo, String> {
    let (kind, size) = validate_document_path(&path)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(match kind {
            DocumentKind::Pdf => "document.pdf",
            DocumentKind::Markdown => "document.md",
            DocumentKind::Html => "document.html",
            DocumentKind::Docx => "document.docx",
        })
        .to_string();
    Ok(DocumentFileInfo {
        name,
        size,
        path: path.to_string_lossy().to_string(),
        kind,
    })
}

#[cfg(not(mobile))]
fn validate_document_path(path: &PathBuf) -> Result<(DocumentKind, u64), String> {
    let kind = detect_document_kind(path)?;
    let metadata = fs::metadata(path).map_err(document_io_error)?;
    let size = metadata.len();
    let max = match kind {
        DocumentKind::Pdf => MAX_PDF_BYTES,
        DocumentKind::Markdown | DocumentKind::Html => MAX_TEXT_DOCUMENT_BYTES,
        DocumentKind::Docx => MAX_DOCX_BYTES,
    };
    if size > max {
        return Err("too-large".into());
    }
    Ok((kind, size))
}

#[cfg(not(mobile))]
fn validate_text_document_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("document-path-not-absolute".into());
    }
    match detect_document_kind(path)? {
        DocumentKind::Markdown | DocumentKind::Html => {}
        DocumentKind::Pdf | DocumentKind::Docx => return Err("unsupported-document".into()),
    }
    let metadata = fs::metadata(path).map_err(|_| "document-unavailable".to_string())?;
    if !metadata.is_file() {
        return Err("document-not-file".into());
    }
    if metadata.len() > MAX_TEXT_DOCUMENT_BYTES {
        return Err("too-large".into());
    }
    Ok(())
}

#[cfg(not(mobile))]
fn detect_document_kind(path: &Path) -> Result<DocumentKind, String> {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());
    match ext.as_deref() {
        Some("pdf") => Ok(DocumentKind::Pdf),
        Some("md") | Some("markdown") => Ok(DocumentKind::Markdown),
        Some("html") | Some("htm") => Ok(DocumentKind::Html),
        Some("docx") => Ok(DocumentKind::Docx),
        _ => Err("unsupported-document".into()),
    }
}

#[cfg(not(mobile))]
fn classify_open_target_at_path(path: PathBuf) -> Result<OpenTargetInfo, String> {
    if !path.is_absolute() {
        return Err("open-target-path-not-absolute".into());
    }
    // Resolve symlinks when deciding the target type. In particular, a
    // symlinked research folder must behave exactly like the folder it points
    // to, while the original path remains the stable workspace identity.
    let metadata = fs::metadata(&path).map_err(|err| err.to_string())?;
    if metadata.is_dir() {
        return Ok(OpenTargetInfo {
            path: path.to_string_lossy().to_string(),
            is_directory: true,
            kind: None,
        });
    }
    if metadata.is_file() {
        return Ok(OpenTargetInfo {
            kind: detect_document_kind(&path).ok(),
            path: path.to_string_lossy().to_string(),
            is_directory: false,
        });
    }
    Err("open-target-unsupported-type".into())
}

#[cfg(not(mobile))]
fn list_folder_entries_at_path(path: PathBuf) -> Result<FolderListing, String> {
    if !path.is_absolute() {
        return Err("folder-path-not-absolute".into());
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut scanned = 0usize;
    // One level only: mounted folders can hold thousands of papers, and walking
    // child directories here would scan the user's disk before the tree asks.
    for entry in fs::read_dir(&path).map_err(|err| err.to_string())? {
        if entries.len() > FOLDER_ENTRY_LIMIT {
            truncated = true;
            break;
        }
        if scanned >= FOLDER_SCAN_LIMIT {
            truncated = true;
            break;
        }
        scanned += 1;
        let entry = entry.map_err(|err| err.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // `entry.file_type()` reports the LINK, not its target: a symlinked
        // folder would be neither dir nor file and get dropped from the
        // listing entirely. People symlink paper folders in from Dropbox and
        // iCloud, so resolve the target. Safe without a loop guard because
        // this walks exactly one level and never follows a child.
        let resolved = entry.path();
        let metadata = match fs::metadata(&resolved) {
            Ok(metadata) => metadata,
            // A broken symlink or a file that vanished mid-listing is not an
            // error for the whole directory — it simply is not there.
            Err(_) => continue,
        };
        let is_directory = metadata.is_dir();
        if is_directory
            && matches!(
                name.as_str(),
                "node_modules" | "target" | "dist" | "__pycache__"
            )
        {
            continue;
        }
        let kind = if is_directory {
            None
        } else if metadata.is_file() {
            detect_document_kind(&resolved).ok()
        } else {
            None
        };
        if !is_directory && kind.is_none() {
            continue;
        }
        entries.push(FolderEntry {
            name,
            path: resolved.to_string_lossy().to_string(),
            is_directory,
            kind,
        });
    }
    Ok(finish_folder_listing(entries, truncated))
}

#[cfg(not(mobile))]
fn finish_folder_listing(mut entries: Vec<FolderEntry>, scan_truncated: bool) -> FolderListing {
    // Directories first, then case-insensitive by name. The exact name is the
    // tiebreak so "A.md" and "a.md" land in a fixed order — read_dir's own
    // order is arbitrary, and a listing that reshuffles between openings looks
    // like the folder changed.
    entries.sort_by_cached_key(|entry| {
        (
            !entry.is_directory,
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
    let truncated = scan_truncated || entries.len() > FOLDER_ENTRY_LIMIT;
    entries.truncate(FOLDER_ENTRY_LIMIT);
    FolderListing { entries, truncated }
}

#[cfg(not(mobile))]
pub(crate) fn validate_pdf_path(path: &PathBuf) -> Result<u64, String> {
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .map_or(true, |ext| !ext.eq_ignore_ascii_case("pdf"))
    {
        return Err("not-a-pdf".into());
    }
    let metadata = fs::metadata(path).map_err(document_io_error)?;
    let size = metadata.len();
    if size > MAX_PDF_BYTES {
        return Err("too-large".into());
    }
    Ok(size)
}

// Scratch directory for the document tests, unique per process and call.
#[cfg(all(test, not(mobile)))]
pub(crate) fn text_image_test_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "shiori-{label}-{}-{}",
        std::process::id(),
        crate::runtime_guard::now_ms()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    #[cfg(not(mobile))]
    use super::text_image_test_dir;
    #[cfg(not(mobile))]
    use std::{fs, path::PathBuf};

    // A recent or restored tab whose file (or whole folder) is gone must reach
    // the frontend as a code it can translate, not the OS sentence: Windows
    // showed "系统找不到指定的路径。 (os error 3)" in the restore toast.
    #[test]
    #[cfg(not(mobile))]
    fn missing_document_paths_report_a_stable_code() {
        let dir = text_image_test_dir("missing-path");
        let cases = [
            dir.join("gone.md"),
            dir.join("gone.pdf"),
            dir.join("no-such-folder").join("README.md"),
        ];
        for path in cases {
            assert_eq!(
                super::read_document_info(path.clone()).err().as_deref(),
                Some("document-path-unavailable"),
                "{path:?}"
            );
        }
        assert_eq!(
            super::read_pdf_info(dir.join("no-such-folder").join("gone.pdf"))
                .err()
                .as_deref(),
            Some("document-path-unavailable")
        );

        let present = dir.join("present.md");
        fs::write(&present, "# hi").unwrap();
        assert_eq!(
            super::read_document_info(present)
                .ok()
                .map(|info| info.size),
            Some(4)
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    #[cfg(not(mobile))]
    fn folder_listing_is_shallow_filtered_and_sorted() {
        let dir = text_image_test_dir("folder-listing");
        fs::create_dir(dir.join("alpha")).unwrap();
        fs::create_dir(dir.join("Zoo")).unwrap();
        fs::create_dir(dir.join("node_modules")).unwrap();
        fs::create_dir(dir.join("target")).unwrap();
        fs::create_dir(dir.join("dist")).unwrap();
        fs::create_dir(dir.join("__pycache__")).unwrap();
        fs::create_dir(dir.join(".hidden-dir")).unwrap();
        fs::write(dir.join("alpha").join("nested.pdf"), b"%PDF-").unwrap();
        fs::write(dir.join("A.md"), b"# A").unwrap();
        fs::write(dir.join("b.HTML"), b"<p>b</p>").unwrap();
        fs::write(dir.join("z.PDF"), b"%PDF-").unwrap();
        fs::write(dir.join("ignore.txt"), b"ignore").unwrap();
        fs::write(dir.join(".secret.pdf"), b"%PDF-").unwrap();

        let listing = super::list_folder_entries_at_path(dir.clone()).unwrap();

        assert!(!listing.truncated);
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| (entry.name.as_str(), entry.is_directory, entry.kind))
                .collect::<Vec<_>>(),
            vec![
                ("alpha", true, None),
                ("Zoo", true, None),
                ("A.md", false, Some(super::DocumentKind::Markdown)),
                ("b.HTML", false, Some(super::DocumentKind::Html)),
                ("z.PDF", false, Some(super::DocumentKind::Pdf)),
            ]
        );
        assert!(listing
            .entries
            .iter()
            .all(|entry| PathBuf::from(&entry.path).is_absolute()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(not(mobile))]
    fn open_target_classification_separates_folders_and_documents() {
        let dir = text_image_test_dir("open-target-classification");
        let pdf = dir.join("paper.pdf");
        let unsupported = dir.join("notes.txt");
        fs::write(&pdf, b"%PDF-").unwrap();
        fs::write(&unsupported, b"notes").unwrap();

        let folder = super::classify_open_target_at_path(dir.clone()).unwrap();
        assert!(folder.is_directory);
        assert_eq!(folder.kind, None);

        let document = super::classify_open_target_at_path(pdf).unwrap();
        assert!(!document.is_directory);
        assert_eq!(document.kind, Some(super::DocumentKind::Pdf));

        let other = super::classify_open_target_at_path(unsupported).unwrap();
        assert!(!other.is_directory);
        assert_eq!(other.kind, None);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    #[cfg(all(unix, not(mobile)))]
    fn folder_listing_follows_symlinks() {
        // read_dir reports the LINK's type, not the target's, so the obvious
        // implementation drops symlinked folders and files silently — and
        // paper folders symlinked in from Dropbox or iCloud are exactly the
        // case this feature exists for.
        let dir = text_image_test_dir("folder-symlink");
        let real_dir = dir.join("real-papers");
        fs::create_dir(&real_dir).unwrap();
        let real_pdf = dir.join("real.pdf");
        fs::write(&real_pdf, b"%PDF-").unwrap();
        std::os::unix::fs::symlink(&real_dir, dir.join("linked-papers")).unwrap();
        std::os::unix::fs::symlink(&real_pdf, dir.join("linked.pdf")).unwrap();
        // A dangling link is not an error for the whole directory.
        std::os::unix::fs::symlink(dir.join("gone.pdf"), dir.join("broken.pdf")).unwrap();

        let listing = super::list_folder_entries_at_path(dir.clone()).unwrap();

        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| (entry.name.as_str(), entry.is_directory))
                .collect::<Vec<_>>(),
            vec![
                ("linked-papers", true),
                ("real-papers", true),
                ("linked.pdf", false),
                ("real.pdf", false),
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(not(mobile))]
    fn folder_listing_reports_its_entry_cap() {
        let entries = (0..=super::FOLDER_ENTRY_LIMIT)
            .map(|index| super::FolderEntry {
                name: format!("{index:05}.pdf"),
                path: format!("/papers/{index:05}.pdf"),
                is_directory: false,
                kind: Some(super::DocumentKind::Pdf),
            })
            .collect();

        let listing = super::finish_folder_listing(entries, false);

        assert_eq!(listing.entries.len(), super::FOLDER_ENTRY_LIMIT);
        assert!(listing.truncated);
    }

    #[test]
    #[cfg(not(mobile))]
    fn folder_listing_reports_a_bounded_scan() {
        let listing = super::finish_folder_listing(
            vec![super::FolderEntry {
                name: "paper.pdf".into(),
                path: "/papers/paper.pdf".into(),
                is_directory: false,
                kind: Some(super::DocumentKind::Pdf),
            }],
            true,
        );

        assert_eq!(listing.entries.len(), 1);
        assert!(listing.truncated);
    }

    #[test]
    #[cfg(not(mobile))]
    fn text_document_paths_reject_pdfs_relative_paths_and_directories() {
        let dir = text_image_test_dir("text-write-guard");
        let note = dir.join("note.md");
        fs::write(&note, b"hi").unwrap();
        assert_eq!(super::validate_text_document_path(&note), Ok(()));

        let pdf = dir.join("doc.pdf");
        fs::write(&pdf, b"%PDF-").unwrap();
        assert_eq!(
            super::validate_text_document_path(&pdf),
            Err("unsupported-document".into())
        );
        assert_eq!(
            super::validate_text_document_path(std::path::Path::new("note.md")),
            Err("document-path-not-absolute".into())
        );
        // Refusing to create files is what makes "the original moved" a loud
        // failure the frontend can turn into an honest message.
        assert_eq!(
            super::validate_text_document_path(&dir.join("gone.md")),
            Err("document-unavailable".into())
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
