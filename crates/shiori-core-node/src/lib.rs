//! The CLI's view of shiori-core: bind PDFium, open a PDF, read page boxes and
//! glyphs. Loaded by `cli/src/coreEngine.ts`; errors carry CoreError's text,
//! which `classifyPdfOpenError` reads.

use std::path::Path;

use napi::bindgen_prelude::{Buffer, Result};
use napi::Error;
use napi_derive::napi;
use shiori_core::{Core, CoreError};

fn js_error(error: CoreError) -> Error {
    Error::from_reason(error.to_string())
}

/// Loads PDFium from `libraryDir`. Later calls reuse the first binding.
#[napi]
pub fn bind_pdfium(library_dir: String) -> Result<()> {
    Core::bind(Path::new(&library_dir))
        .map(|_| ())
        .map_err(js_error)
}

#[napi(object)]
pub struct PageGeometry {
    pub rotation: u32,
    pub origin_x: f64,
    pub origin_y: f64,
    pub width: f64,
    pub height: f64,
}

#[napi(object)]
pub struct Glyph {
    pub text: String,
    /// [x, y] of the baseline start, PDF user space.
    pub origin: Vec<f64>,
    /// [x, y] of the advance end.
    pub end: Vec<f64>,
    /// [left, bottom, right, top].
    pub loose: Vec<f64>,
    pub font_size: f64,
    pub angle: f64,
    pub generated: bool,
    pub hyphen: bool,
    pub font_name: String,
    /// PDF font descriptor flags (1 fixed pitch, 2 serif, 64 italic, …).
    pub font_flags: i32,
    /// Page units at this glyph's size; descent is negative.
    pub ascent: f64,
    pub descent: f64,
}

/// What a document's encryption allows (shiori_core::Security).
#[napi(object)]
pub struct Security {
    /// The Standard handler's /R; absent when the file is not encrypted.
    pub revision: Option<i32>,
    pub permissions: u32,
    pub user_permissions: u32,
}

#[napi]
pub struct CoreDocument {
    inner: Option<shiori_core::Document>,
}

#[napi]
impl CoreDocument {
    /// Parses a copy of `bytes`; the caller keeps its buffer.
    #[napi(factory)]
    pub fn open(library_dir: String, bytes: Buffer, password: Option<String>) -> Result<Self> {
        let core = Core::bind(Path::new(&library_dir)).map_err(js_error)?;
        let doc = core
            .open(bytes.to_vec(), password.as_deref())
            .map_err(js_error)?;
        Ok(CoreDocument { inner: Some(doc) })
    }

    fn doc(&self) -> Result<&shiori_core::Document> {
        self.inner
            .as_ref()
            .ok_or_else(|| Error::from_reason("document is closed"))
    }

    #[napi]
    pub fn page_count(&self) -> Result<u32> {
        Ok(self.doc()?.page_count())
    }

    #[napi]
    pub fn page_geometry(&self, index: u32) -> Result<PageGeometry> {
        let g = self.doc()?.page_geometry(index).map_err(js_error)?;
        Ok(PageGeometry {
            rotation: u32::from(g.rotation),
            origin_x: f64::from(g.origin_x),
            origin_y: f64::from(g.origin_y),
            width: f64::from(g.width),
            height: f64::from(g.height),
        })
    }

    #[napi]
    pub fn glyphs(&self, index: u32) -> Result<Vec<Glyph>> {
        let chars = self.doc()?.chars(index).map_err(js_error)?;
        Ok(chars
            .into_iter()
            .map(|ch| Glyph {
                text: ch.text,
                origin: vec![f64::from(ch.origin.0), f64::from(ch.origin.1)],
                end: vec![f64::from(ch.end.0), f64::from(ch.end.1)],
                loose: vec![
                    f64::from(ch.loose.left),
                    f64::from(ch.loose.bottom),
                    f64::from(ch.loose.right),
                    f64::from(ch.loose.top),
                ],
                font_size: f64::from(ch.font_size),
                angle: f64::from(ch.angle),
                generated: ch.generated,
                hyphen: ch.hyphen,
                font_name: ch.font_name.clone(),
                font_flags: ch.font_flags,
                ascent: f64::from(ch.ascent),
                descent: f64::from(ch.descent),
            })
            .collect())
    }

    /// Draws a region of a page as RGBA rows (`width × height × 4` bytes),
    /// annotations and form fields included, on white. `rotation` is the
    /// displayed rotation in clockwise degrees and replaces the page's /Rotate.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &self,
        index: u32,
        rotation: u32,
        pixels_per_point: f64,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        annotations: Option<bool>,
    ) -> Result<Buffer> {
        let request = shiori_core::RenderRequest {
            rotation: u16::try_from(rotation).map_err(|_| Error::from_reason("bad rotation"))?,
            pixels_per_point: pixels_per_point as f32,
            x,
            y,
            width,
            height,
            annotations: annotations.unwrap_or(true),
        };
        let rgba = self.doc()?.render(index, request).map_err(js_error)?;
        Ok(rgba.into())
    }

    /// The document rewritten without its encryption, objects kept.
    #[napi]
    pub fn decrypted_copy(&self) -> Result<Buffer> {
        Ok(self.doc()?.decrypted_copy().map_err(js_error)?.into())
    }

    /// What the document's encryption allows, as PDFium reports it.
    #[napi]
    pub fn security(&self) -> Result<Security> {
        let security = self.doc()?.security();
        Ok(Security {
            revision: security.revision,
            permissions: security.permissions,
            user_permissions: security.user_permissions,
        })
    }

    /// `plain`, an unencrypted export, encrypted as this document is.
    #[napi]
    pub fn encrypt_like_source(&self, plain: Buffer) -> Result<Buffer> {
        Ok(self
            .doc()?
            .encrypt_like_source(&plain)
            .map_err(js_error)?
            .into())
    }

    /// Releases the document now rather than at garbage collection.
    #[napi]
    pub fn close(&mut self) {
        self.inner = None;
    }
}
