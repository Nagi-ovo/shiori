//! A page's visible box and rotation, in PDF user space.

use pdfium_render::prelude::FS_RECTF;

use crate::{normalized, CoreError, Document, Rect};

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
                let (mut l, mut b, mut r, mut t) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
                let has_media = unsafe {
                    self.lib
                        .FPDFPage_GetMediaBox(page.handle, &mut l, &mut b, &mut r, &mut t)
                } != 0;
                Some(normalized(l, b, r, t))
                    .filter(|media| has_media && filled(media))
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
}
