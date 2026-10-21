// ---- A page's text for the reading layer (split out of pdf_core_commands.rs) ----

use serde::Serialize;
#[cfg(not(mobile))]
use tauri::State;
use tauri::{Runtime, Webview};

use crate::enforce_main_webview;
#[cfg(not(mobile))]
use crate::pdf_core;

/// One character of a page as PDFium reads it, PDF user space: the reading
/// layer builds its text items and glyph cells from these.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct PdfCoreGlyph {
    text: String,
    /// Baseline start.
    origin: [f32; 2],
    /// Advance end.
    end: [f32; 2],
    font_size: f32,
    /// Counter-clockwise radians of the baseline.
    angle: f32,
    /// A space or line break PDFium inferred; nothing is drawn.
    generated: bool,
    font_name: String,
    font_flags: i32,
    /// Page units at this glyph's size; descent is negative.
    ascent: f32,
    descent: f32,
    /// A line-end hyphen PDFium recognised as hyphenation.
    hyphen: bool,
}

#[derive(Debug, Serialize, specta::Type)]
pub(crate) struct PdfCorePageText {
    glyphs: Vec<PdfCoreGlyph>,
    /// The document's /Lang, when it names one.
    lang: Option<String>,
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn pdf_core_page_text<R: Runtime>(
    caller: Webview<R>,
    core: State<'_, pdf_core::PdfCoreService>,
    doc: u32,
    page: u32,
) -> Result<PdfCorePageText, String> {
    enforce_main_webview(&caller)?;
    core.read(doc, move |document| {
        // A decompression-bomb page stops at the core's bound instead of
        // crossing IPC as hundreds of megabytes of JSON.
        let chars = document
            .chars(page, shiori_core::MAX_PAGE_CHARS)
            .map_err(|error| error.to_string())?;
        Ok(PdfCorePageText {
            glyphs: chars
                .into_iter()
                .map(|ch| PdfCoreGlyph {
                    text: ch.text,
                    origin: [ch.origin.0, ch.origin.1],
                    end: [ch.end.0, ch.end.1],
                    font_size: ch.font_size,
                    angle: ch.angle,
                    generated: ch.generated,
                    font_name: ch.font_name,
                    font_flags: ch.font_flags,
                    ascent: ch.ascent,
                    descent: ch.descent,
                    hyphen: ch.hyphen,
                })
                .collect(),
            lang: document.language(),
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn pdf_core_page_text<R: Runtime>(
    caller: Webview<R>,
    _doc: u32,
    _page: u32,
) -> Result<PdfCorePageText, String> {
    enforce_main_webview(&caller)?;
    Err("pdf-core-unsupported".into())
}
