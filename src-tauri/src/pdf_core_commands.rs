// ---- PDFium page rendering (docs/PLAN-RUST-PDF-CORE-2026-09.md, stage 3) ----
//
// The desktop app's reading engine: the front end opens, draws and reads every
// PDF through these commands (AGENTS.md fact 2). Mobile and web run the same
// shiori-core as wasm in a worker instead, so every command here reports itself
// unsupported on mobile.

#[cfg(not(mobile))]
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use serde::{Deserialize, Serialize};
#[cfg(not(mobile))]
use std::path::PathBuf;
use tauri::{
    ipc::{Request, Response},
    Runtime, Webview,
};
#[cfg(not(mobile))]
use tauri::{AppHandle, Manager, State};

use crate::enforce_main_webview;
#[cfg(not(mobile))]
use crate::{documents::MAX_PDF_BYTES, pdf_core};

mod text;
pub(crate) use text::*;

/// One annotation Shiori draws itself: its subtype and /Rect
/// `[left, bottom, right, top]`.
#[derive(Debug, Deserialize, specta::Type)]
pub(crate) struct PdfCoreAnnotationKey {
    subtype: String,
    rect: [f32; 4],
}

/// Opens the PDF in the request body. The optional password travels
/// base64-encoded in `x-shiori-pdf-password`, like the export filename.
#[tauri::command]
#[cfg(not(mobile))]
pub(crate) async fn pdf_core_open<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    request: Request<'_>,
) -> Result<u32, String> {
    enforce_main_webview(&caller)?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => return Err("expected-raw-bytes".into()),
    };
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("too-large".into());
    }
    let password = request
        .headers()
        .get("x-shiori-pdf-password")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| BASE64_STANDARD.decode(value).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok());
    core.open(bytes, password).await
}

#[tauri::command]
#[cfg(mobile)]
pub(crate) async fn pdf_core_open<R: Runtime>(
    caller: Webview<R>,
    _request: Request<'_>,
) -> Result<u32, String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

/// Draws a region of a page as RGBA rows. `priority` 0 is a tile on screen,
/// 1 the page backdrop, 2 a thumbnail; `ticket` lets `pdf_core_cancel` drop it.
#[tauri::command]
#[cfg(not(mobile))]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn pdf_core_render<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    doc: u32,
    page: u32,
    rotation: u16,
    pixels_per_point: f32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    priority: u8,
    ticket: u64,
    annotations: Option<bool>,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    let request = shiori_core::RenderRequest {
        rotation,
        pixels_per_point,
        x,
        y,
        width,
        height,
        annotations: annotations.unwrap_or(true),
    };
    core.render(doc, page, request, priority, ticket)
        .await
        .map(Response::new)
}

/// The open document rewritten without its encryption (shiori_core's
/// `decrypted_copy`), for the annotation import, which reads the file with
/// pdf-lib and cannot decrypt.
#[tauri::command]
#[cfg(not(mobile))]
pub(crate) async fn pdf_core_decrypted_copy<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    doc: u32,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    core.read(doc, |document| {
        document.decrypted_copy().map_err(|error| error.to_string())
    })
    .await
    .map(Response::new)
}

/// What the open document's encryption allows, as PDFium reports it.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfCoreSecurity {
    /// The Standard handler's /R; absent when the file is not encrypted.
    revision: Option<i32>,
    /// Every bit set when the owner password opened it, /P otherwise.
    permissions: u32,
    /// /P, whichever password opened it.
    user_permissions: u32,
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn pdf_core_security<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    doc: u32,
) -> Result<PdfCoreSecurity, String> {
    enforce_main_webview(&caller)?;
    core.read(doc, |document| {
        let security = document.security();
        Ok(PdfCoreSecurity {
            revision: security.revision,
            permissions: security.permissions,
            user_permissions: security.user_permissions,
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn pdf_core_security<R: Runtime>(
    caller: Webview<R>,
    _doc: u32,
) -> Result<PdfCoreSecurity, String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

/// The unencrypted export in the request body, encrypted the way the open
/// document `x-shiori-pdf-doc` is (shiori_core's `encrypt_like_source`): its
/// own /Encrypt and key, unlocked when it was opened, so no password travels.
#[tauri::command]
#[cfg(not(mobile))]
pub(crate) async fn pdf_core_encrypt_like_source<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    request: Request<'_>,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    let plain = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => return Err("expected-raw-bytes".into()),
    };
    if plain.len() as u64 > MAX_PDF_BYTES {
        return Err("too-large".into());
    }
    let doc = request
        .headers()
        .get("x-shiori-pdf-doc")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| "missing-document".to_string())?;
    core.read(doc, move |document| {
        document
            .encrypt_like_source(&plain)
            .map_err(|error| error.to_string())
    })
    .await
    .map(Response::new)
}

#[tauri::command]
#[cfg(mobile)]
pub(crate) async fn pdf_core_encrypt_like_source<R: Runtime>(
    caller: Webview<R>,
    _request: Request<'_>,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

/// The embedded fonts a page draws with, packed by shiori_core's
/// `encode_embedded_fonts` (raw bytes: they are font programs).
#[tauri::command]
#[cfg(not(mobile))]
pub(crate) async fn pdf_core_page_fonts<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    doc: u32,
    page: u32,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    core.read(doc, move |document| {
        document
            .embedded_fonts(page)
            .map(|fonts| shiori_core::encode_embedded_fonts(&fonts))
            .map_err(|error| error.to_string())
    })
    .await
    .map(Response::new)
}

/// The named embedded fonts rebuilt from the glyphs this page sets in them,
/// as shiori_core's `encode_font_outlines` JSON (raw bytes: a CJK page's
/// outlines run to megabytes).
#[tauri::command]
#[cfg(not(mobile))]
pub(crate) async fn pdf_core_font_outlines<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    doc: u32,
    page: u32,
    names: Vec<String>,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    core.read(doc, move |document| {
        document
            .font_outlines(page, &names)
            .map(|fonts| shiori_core::encode_font_outlines(&fonts))
            .map_err(|error| error.to_string())
    })
    .await
    .map(Response::new)
}

#[tauri::command]
#[cfg(mobile)]
pub(crate) async fn pdf_core_font_outlines<R: Runtime>(
    caller: Webview<R>,
    _doc: u32,
    _page: u32,
    _names: Vec<String>,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

#[tauri::command]
#[cfg(mobile)]
pub(crate) async fn pdf_core_page_fonts<R: Runtime>(
    caller: Webview<R>,
    _doc: u32,
    _page: u32,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

#[tauri::command]
#[cfg(mobile)]
pub(crate) async fn pdf_core_decrypted_copy<R: Runtime>(
    caller: Webview<R>,
    _doc: u32,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

#[tauri::command]
#[cfg(mobile)]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn pdf_core_render<R: Runtime>(
    caller: Webview<R>,
    _doc: u32,
    _page: u32,
    _rotation: u16,
    _pixels_per_point: f32,
    _x: u32,
    _y: u32,
    _width: u32,
    _height: u32,
    _priority: u8,
    _ticket: u64,
    _annotations: Option<bool>,
) -> Result<Response, String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn pdf_core_cancel<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    tickets: Vec<u64>,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    core.cancel(&tickets);
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn pdf_core_cancel<R: Runtime>(
    caller: Webview<R>,
    _tickets: Vec<u64>,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn pdf_core_close<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    doc: u32,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    core.close(doc)
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn pdf_core_close<R: Runtime>(caller: Webview<R>, _doc: u32) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

/// Hides annotations Shiori draws itself from the page raster; returns how
/// many it found.
#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn pdf_core_hide_annotations<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    doc: u32,
    page: u32,
    keys: Vec<PdfCoreAnnotationKey>,
) -> Result<u32, String> {
    enforce_main_webview(&caller)?;
    let keys = keys
        .into_iter()
        .map(|key| shiori_core::AnnotationKey {
            subtype: key.subtype,
            rect: shiori_core::Rect {
                left: key.rect[0],
                bottom: key.rect[1],
                right: key.rect[2],
                top: key.rect[3],
            },
        })
        .collect();
    core.hide_annotations(doc, page, keys).await
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn pdf_core_hide_annotations<R: Runtime>(
    caller: Webview<R>,
    _doc: u32,
    _page: u32,
    _keys: Vec<PdfCoreAnnotationKey>,
) -> Result<u32, String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

/// Where a link or outline entry goes: a page and its view, the PDF way
/// (`view` is `XYZ`, `Fit`, `FitH`, …; `args` its operands, null where the file
/// leaves one null).
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct PdfCoreDestination {
    page_index: u32,
    view: String,
    args: Vec<Option<f32>>,
}

#[derive(Debug, Serialize, specta::Type)]
pub(crate) struct PdfCoreOutlineItem {
    title: String,
    destination: Option<PdfCoreDestination>,
    children: Vec<PdfCoreOutlineItem>,
}

/// A link annotation: its /Rect `[left, bottom, right, top]` and either a
/// destination in this document or a URL.
#[derive(Debug, Serialize, specta::Type)]
pub(crate) struct PdfCoreLink {
    rect: [f32; 4],
    destination: Option<PdfCoreDestination>,
    url: Option<String>,
}

#[cfg(not(mobile))]
fn core_destination(dest: shiori_core::Destination) -> PdfCoreDestination {
    PdfCoreDestination {
        page_index: dest.page_index,
        view: dest.view.to_string(),
        args: dest.args,
    }
}

#[cfg(not(mobile))]
fn core_outline(items: Vec<shiori_core::OutlineItem>) -> Vec<PdfCoreOutlineItem> {
    items
        .into_iter()
        .map(|item| PdfCoreOutlineItem {
            title: item.title,
            destination: item.destination.map(core_destination),
            children: core_outline(item.children),
        })
        .collect()
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn pdf_core_outline<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    doc: u32,
) -> Result<Vec<PdfCoreOutlineItem>, String> {
    enforce_main_webview(&caller)?;
    core.read(doc, |document| Ok(core_outline(document.outline())))
        .await
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn pdf_core_outline<R: Runtime>(
    caller: Webview<R>,
    _doc: u32,
) -> Result<Vec<PdfCoreOutlineItem>, String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn pdf_core_links<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    doc: u32,
    page: u32,
) -> Result<Vec<PdfCoreLink>, String> {
    enforce_main_webview(&caller)?;
    core.read(doc, move |document| {
        let links = document.links(page).map_err(|error| error.to_string())?;
        Ok(links
            .into_iter()
            .map(|link| {
                let rect = [
                    link.rect.left,
                    link.rect.bottom,
                    link.rect.right,
                    link.rect.top,
                ];
                match link.target {
                    shiori_core::LinkTarget::Url(url) => PdfCoreLink {
                        rect,
                        destination: None,
                        url: Some(url),
                    },
                    shiori_core::LinkTarget::Destination(dest) => PdfCoreLink {
                        rect,
                        destination: Some(core_destination(dest)),
                        url: None,
                    },
                }
            })
            .collect())
    })
    .await
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn pdf_core_links<R: Runtime>(
    caller: Webview<R>,
    _doc: u32,
    _page: u32,
) -> Result<Vec<PdfCoreLink>, String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

/// One page's visible box (crop clipped to media) and /Rotate.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfCorePageGeometry {
    rotation: u16,
    origin_x: f32,
    origin_y: f32,
    width: f32,
    height: f32,
}

/// Every page's box and rotation, read once when the app opens a document.
#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn pdf_core_page_geometry<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    doc: u32,
) -> Result<Vec<PdfCorePageGeometry>, String> {
    enforce_main_webview(&caller)?;
    core.read(doc, |document| {
        (0..document.page_count())
            .map(|index| {
                document
                    .page_geometry(index)
                    .map(|g| PdfCorePageGeometry {
                        rotation: g.rotation,
                        origin_x: g.origin_x,
                        origin_y: g.origin_y,
                        width: g.width,
                        height: g.height,
                    })
                    .map_err(|error| error.to_string())
            })
            .collect()
    })
    .await
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn pdf_core_page_geometry<R: Runtime>(
    caller: Webview<R>,
    _doc: u32,
) -> Result<Vec<PdfCorePageGeometry>, String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}

/// Where PDFium may be: in the macOS bundle's Frameworks, in the Windows or
/// Linux bundle's resources, or, for `tauri dev`, where scripts/pdfium/fetch.ts
/// put it.
#[cfg(not(mobile))]
pub(crate) fn pdfium_library_dirs<R: Runtime>(app: &AppHandle<R>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(macos) = exe.parent() {
            dirs.push(macos.join("../Frameworks"));
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        dirs.push(resources.join("pdfium"));
    }
    #[cfg(debug_assertions)]
    {
        let os = if cfg!(target_os = "macos") {
            "mac"
        } else if cfg!(target_os = "windows") {
            "win"
        } else {
            "linux"
        };
        let cpu = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let lib = if cfg!(target_os = "windows") {
            "bin"
        } else {
            "lib"
        };
        dirs.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../vendor/pdfium")
                .join(format!("{os}-{cpu}"))
                .join(lib),
        );
    }
    dirs
}
