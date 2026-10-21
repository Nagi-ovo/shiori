//! Whether a browser may load an embedded program as it is.
//!
//! A face a browser loads from a font program draws Unicode through the
//! program's own cmap, with the program's own advances. The text a PDF sets
//! in it goes through the font dictionary instead: its /Encoding, /ToUnicode
//! and /Widths. Two dictionaries can share one program and map it apart
//! (audit B108), one dictionary's "a" drawing the program's A as small caps
//! would; a face loaded as it is then edits that text with the wrong letter.
//! A subset whose cmap the producer dropped draws none of it.
//!
//! PDFium 7881 gives a font handle no dictionary access, but it loads the
//! same program on its own (FPDFText_LoadFont as a CID font, which takes its
//! /ToUnicode and /W from the program's cmap and advances): what the browser
//! will draw. The two are compared over the font id's probe.

use std::os::raw::c_int;

use pdfium_render::prelude::FPDF_FONT;

use super::id::{glyph_shape, Fnv, PROBE};
use crate::Lib;

// fpdf_edit.h
const FPDF_FONT_TRUETYPE: c_int = 2;

/// A character no font maps: each font's answer for it is its answer for a
/// character it does not map (no outline, or its .notdef).
const UNMAPPED: u32 = 0xffff;

/// The most two advances, in 1/1000 em, may part by rounding: a /Widths
/// entry and the advance PDFium derives from the program round apart.
const ADVANCE_SLACK: i32 = 1;

/// Whether `program`, loaded as it is, draws every probe character `font`'s
/// dictionary maps with the dictionary's glyph and advance. A character only
/// the program maps is extra coverage and does not count against it; one the
/// dictionary maps and the program does not does, since the face could not
/// draw that text. A program PDFium cannot load on its own does not match.
///
/// Costs a second load of the program and its cmap per font per page read:
/// tens of microseconds for a subset, milliseconds for a whole CJK font.
pub(crate) unsafe fn draws_alike(lib: &Lib, font: FPDF_FONT, program: &[u8]) -> bool {
    let Ok(size) = u32::try_from(program.len()) else {
        return false;
    };
    let doc = lib.FPDF_CreateNewDocument();
    if doc.is_null() {
        return false;
    }
    let own = lib.FPDFText_LoadFont(doc, program.as_ptr(), size, FPDF_FONT_TRUETYPE, 1);
    let alike = !own.is_null() && same_glyphs(lib, font, own);
    if !own.is_null() {
        lib.FPDFFont_Close(own);
    }
    lib.FPDF_CloseDocument(doc);
    alike
}

unsafe fn same_glyphs(lib: &Lib, font: FPDF_FONT, own: FPDF_FONT) -> bool {
    let (font_none, own_none) = (answer(lib, font, UNMAPPED), answer(lib, own, UNMAPPED));
    PROBE.iter().cloned().flatten().all(|unicode| {
        let drawn = answer(lib, font, unicode);
        if drawn == font_none {
            return true;
        }
        let loaded = answer(lib, own, unicode);
        loaded != own_none && loaded.1 == drawn.1 && (loaded.0 - drawn.0).abs() <= ADVANCE_SLACK
    })
}

/// The advance (whole 1/1000 em) and the outline's hash (`glyph_shape`) of
/// the glyph `font` draws for `unicode`.
unsafe fn answer(lib: &Lib, font: FPDF_FONT, unicode: u32) -> (i32, u64) {
    let mut advance = 0f32;
    lib.FPDFFont_GetGlyphWidth(font, unicode, 1000.0, &mut advance);
    let mut hash = Fnv::new();
    glyph_shape(lib, font, unicode, &mut hash);
    (advance.round() as i32, hash.0)
}
