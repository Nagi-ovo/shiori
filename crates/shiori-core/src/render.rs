//! Drawing a region of a page into an RGBA bitmap.

use std::os::raw::c_int;

use pdfium_render::prelude::FS_RECTF;

use crate::{CoreError, Document};

// fpdfview.h render flags and bitmap format.
const FPDF_ANNOT: i32 = 0x01;
const FPDF_REVERSE_BYTE_ORDER: i32 = 0x10;
const FPDF_BITMAP_BGRA: i32 = 4;

/// The largest tile the core will allocate, in pixels: the app's canvas
/// budget (src/pdf/openPolicy.ts MAX_CANVAS_PIXELS).
pub const MAX_RENDER_PIXELS: u64 = 32_000_000;

/// A region of a page drawn at a scale, in device pixels of the whole page:
/// a viewport tile, or the whole page when the region covers it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RenderRequest {
    /// The page's displayed rotation, clockwise degrees (0/90/180/270). Like
    /// pdf.js's viewport rotation it replaces the page's /Rotate, not adds to it.
    pub rotation: u16,
    /// Device pixels per PDF point: the zoom scale times the device pixel ratio.
    pub pixels_per_point: f32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// Draw annotations and form fields. Off for output that must carry the
    /// page content alone (an original-only raster export).
    pub annotations: bool,
}

impl Document {
    /// Draws `request`'s region of a page, annotations and form fields
    /// included, on white. Returns RGBA rows, `width × height × 4` bytes.
    pub fn render(&self, index: u32, request: RenderRequest) -> Result<Vec<u8>, CoreError> {
        let RenderRequest {
            rotation,
            pixels_per_point,
            x,
            y,
            width,
            height,
            annotations,
        } = request;
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_RENDER_PIXELS {
            return Err(CoreError::Pdfium(format!(
                "cannot render {width}×{height} px"
            )));
        }
        let geometry = self.page_geometry(index)?;
        let page = self.page(index)?;
        let lib = self.lib;
        // A crop box that misses the media box leaves PDFium's page box
        // empty, and it then draws the page unscaled with y down. Its crop
        // box on this open copy becomes the box page_geometry falls back
        // to, so PDFium draws, forms included, where the overlays are.
        let mut bbox = FS_RECTF {
            left: 0.0,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
        };
        let has_box = unsafe { lib.FPDF_GetPageBoundingBox(page.handle, &mut bbox) } != 0;
        if !has_box || bbox.right <= bbox.left || bbox.top <= bbox.bottom {
            let (left, bottom) = (geometry.origin_x, geometry.origin_y);
            let (right, top) = (left + geometry.width, bottom + geometry.height);
            unsafe { lib.FPDFPage_SetCropBox(page.handle, left, bottom, right, top) };
        }
        // PDFium applies the page's own /Rotate first and `rotate` on top.
        let page_turns = i32::from(geometry.rotation / 90);
        let turns = (i32::from(rotation / 90) - page_turns).rem_euclid(4);
        let upright = (i32::from(rotation / 90)).rem_euclid(2) == 0;
        let (w_pt, h_pt) = if upright {
            (geometry.width, geometry.height)
        } else {
            (geometry.height, geometry.width)
        };
        let full_w = (w_pt * pixels_per_point).floor().max(1.0) as c_int;
        let full_h = (h_pt * pixels_per_point).floor().max(1.0) as c_int;
        let (w, h) = (width as c_int, height as c_int);
        unsafe {
            let bitmap = lib.FPDFBitmap_CreateEx(w, h, FPDF_BITMAP_BGRA, std::ptr::null_mut(), 0);
            if bitmap.is_null() {
                return Err(CoreError::Pdfium(format!(
                    "no memory for {width}×{height} px"
                )));
            }
            lib.FPDFBitmap_FillRect(bitmap, 0, 0, w, h, 0xFFFF_FFFF);
            let flags = if annotations {
                FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER
            } else {
                FPDF_REVERSE_BYTE_ORDER
            };
            let form = if annotations {
                self.form
            } else {
                std::ptr::null_mut()
            };
            let (start_x, start_y) = (-(x as c_int), -(y as c_int));
            if !form.is_null() {
                lib.FORM_OnAfterLoadPage(page.handle, form);
            }
            lib.FPDF_RenderPageBitmap(
                bitmap,
                page.handle,
                start_x,
                start_y,
                full_w,
                full_h,
                turns,
                flags,
            );
            if !form.is_null() {
                lib.FPDF_FFLDraw(
                    form,
                    bitmap,
                    page.handle,
                    start_x,
                    start_y,
                    full_w,
                    full_h,
                    turns,
                    flags,
                );
                lib.FORM_OnBeforeClosePage(page.handle, form);
            }
            let stride = lib.FPDFBitmap_GetStride(bitmap) as usize;
            let row = width as usize * 4;
            // On wasm32 the bitmap lives in PDFium's own heap, a separate
            // linear memory; it comes over as one copy.
            #[cfg(target_arch = "wasm32")]
            let pixels = lib.FPDFBitmap_GetBuffer_as_vec(bitmap);
            #[cfg(not(target_arch = "wasm32"))]
            let pixels = std::slice::from_raw_parts(
                lib.FPDFBitmap_GetBuffer(bitmap) as *const u8,
                stride * height as usize,
            );
            let mut rgba = Vec::with_capacity(row * height as usize);
            for line in 0..height as usize {
                rgba.extend_from_slice(&pixels[line * stride..line * stride + row]);
            }
            lib.FPDFBitmap_Destroy(bitmap);
            Ok(rgba)
        }
    }
}
