//! A page's visible box and rotation, in PDF user space.

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
        let (mut l, mut b, mut r, mut t) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
        let has_media = unsafe {
            self.lib
                .FPDFPage_GetMediaBox(page.handle, &mut l, &mut b, &mut r, &mut t)
        };
        let media = if has_media != 0 {
            normalized(l, b, r, t)
        } else {
            // PDF 32000 §7.7.3.3: a page without /MediaBox is US Letter.
            normalized(0.0, 0.0, 612.0, 792.0)
        };
        let has_crop = unsafe {
            self.lib
                .FPDFPage_GetCropBox(page.handle, &mut l, &mut b, &mut r, &mut t)
        };
        // A crop box that misses the media box is ignored, as pdf.js does.
        let visible = if has_crop != 0 {
            intersect(normalized(l, b, r, t), media).unwrap_or(media)
        } else {
            media
        };
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

fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let rect = Rect {
        left: a.left.max(b.left),
        bottom: a.bottom.max(b.bottom),
        right: a.right.min(b.right),
        top: a.top.min(b.top),
    };
    (rect.right > rect.left && rect.top > rect.bottom).then_some(rect)
}
