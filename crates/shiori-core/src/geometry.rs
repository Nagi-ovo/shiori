//! A page's visible box and rotation, in PDF user space.

use pdfium_render::prelude::FS_RECTF;

use crate::open::with_blank_document;
use crate::{normalized, CoreError, Document, Lib, Page, Rect};

/// One page's visible box — the crop box clipped to the media box, as pdf.js
/// reports it in `page.view` — and its /Rotate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageGeometry {
    /// Clockwise degrees: 0, 90, 180 or 270.
    pub rotation: u16,
    pub origin_x: f32,
    pub origin_y: f32,
    pub width: f32,
    pub height: f32,
}

impl Document {
    pub fn page_geometry(&self, index: u32) -> Result<PageGeometry, CoreError> {
        let page = self.page(index)?;
        // The box PDFium draws: the crop box clipped to the media box, each
        // inherited through the page tree, and US Letter for a missing or
        // empty media box (PDF 32000 §7.7.3.3). FPDFPage_GetMediaBox and
        // GetCropBox read the page's own dictionary only.
        let mut bbox = FS_RECTF {
            left: 0.0,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
        };
        let has_box = unsafe { self.lib.FPDF_GetPageBoundingBox(page.handle, &mut bbox) } != 0;
        let filled = |r: &Rect| r.right > r.left && r.top > r.bottom;
        let visible = Some(normalized(bbox.left, bbox.bottom, bbox.right, bbox.top))
            .filter(|visible| has_box && filled(visible))
            .unwrap_or_else(|| {
                // Empty when the crop box misses the media box, a crop box
                // ignored, as pdf.js does: the page's media box instead.
                own_media_box(self.lib, &page)
                    .or_else(|| self.handed_down_media_box(index))
                    .filter(filled)
                    .unwrap_or(normalized(0.0, 0.0, 612.0, 792.0))
            });
        let quarter_turns = unsafe { self.lib.FPDFPage_GetRotation(page.handle) }.rem_euclid(4);
        Ok(PageGeometry {
            rotation: (quarter_turns * 90) as u16,
            origin_x: visible.left,
            origin_y: visible.bottom,
            width: visible.right - visible.left,
            height: visible.top - visible.bottom,
        })
    }

    /// A media box the page inherits through the page tree. PDFium has no
    /// getter for one, but a page copied into another document carries the
    /// boxes it inherits in its own dictionary (fpdf_ppo.cpp). Reached only
    /// for a crop box that misses the media box, a malformed file, so the
    /// copy render() makes on every tile of such a page is left uncached.
    fn handed_down_media_box(&self, index: u32) -> Option<Rect> {
        let lib = self.lib;
        with_blank_document(lib, |scratch| unsafe {
            let range = (index + 1).to_string();
            if lib.FPDF_ImportPages(scratch, self.handle, &range, 0) == 0 {
                return None;
            }
            let handle = lib.FPDF_LoadPage(scratch, 0);
            if handle.is_null() {
                return None;
            }
            let copy = Page { lib, handle };
            let media = own_media_box(lib, &copy)?;
            // With no media box anywhere, the copy takes its crop box for
            // one; that is still a missing media box, so US Letter.
            let (mut l, mut b, mut r, mut t) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
            let has_crop =
                lib.FPDFPage_GetCropBox(copy.handle, &mut l, &mut b, &mut r, &mut t) != 0;
            (!has_crop || normalized(l, b, r, t) != media).then_some(media)
        })
        .flatten()
    }
}

/// The /MediaBox in the page's own dictionary.
fn own_media_box(lib: &Lib, page: &Page) -> Option<Rect> {
    let (mut l, mut b, mut r, mut t) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    let has_media =
        unsafe { lib.FPDFPage_GetMediaBox(page.handle, &mut l, &mut b, &mut r, &mut t) } != 0;
    has_media.then(|| normalized(l, b, r, t))
}
