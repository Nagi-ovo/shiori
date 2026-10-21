//! The characters a font dictionary maps beyond the id's fixed probe.
//!
//! Two dictionaries can share one program and part only at characters the
//! probe never asks about: both call code 128 U+0400, one drawing the
//! program's eacute and the other its egrave (audit B108). Hashing every
//! character there is would cost a call per code point; hashing the ones a
//! page sets would make the id depend on the page read. What a dictionary
//! maps is its own, though, and PDFium will say what that is.
//!
//! PDFium 7881 gives a font handle no dictionary access, no object number
//! and no resource name, but it sets any code in that font: a text object
//! made with the handle and given every one-byte code reads back through a
//! text page as the Unicode the dictionary gives each (its /ToUnicode, else
//! the glyph names of its /Encoding and /Differences). That is the
//! dictionary's own mapping, the same in every file and every session,
//! whatever else its file holds.

use std::os::raw::c_uint;

use pdfium_render::prelude::{FPDF_DOCUMENT, FPDF_FONT};

use super::id::PROBE;
use crate::open::with_blank_document;
use crate::{Lib, TextPage};

/// The codes asked about: every one-byte code, all a simple font has, and a
/// CID font's first 256 (its first 256 glyphs under Identity-H). A CID font
/// mapping characters beyond the probe only from higher codes keeps them
/// out of its id.
const CODES: c_uint = 256;

/// The characters beyond `PROBE` that `font`'s dictionary gives a code,
/// ascending. `document` is the font's own: the text object takes its font
/// from there. It is set on a page of a blank document of its own, so the
/// file is never touched. Text-page housekeeping is left out: characters
/// PDFium inserts, codes it found no Unicode for, controls, surrogates
/// (wchar_t is 16-bit on Windows) and anything above the Basic Multilingual
/// Plane, which a 16-bit wchar_t cannot ask about. A compatibility form
/// PDFium's text page decomposes (U+FB00..U+FB06, Arabic presentation forms)
/// comes back as its parts. Costs a blank document and a 256-character
/// text page per font per page read.
pub(super) unsafe fn mapped_beyond_probe(
    lib: &Lib,
    document: FPDF_DOCUMENT,
    font: FPDF_FONT,
) -> Vec<u32> {
    with_blank_document(lib, |blank| {
        let mut found = Vec::new();
        let page = lib.FPDFPage_New(blank, 0, 612.0, 792.0);
        if page.is_null() {
            return found;
        }
        let object = lib.FPDFPageObj_CreateTextObj(document, font, 10.0);
        let codes: Vec<c_uint> = (0..CODES).collect();
        // Inserted, the object is the page's and closes with it; an insert
        // that fails frees it.
        let set = !object.is_null()
            && if lib.FPDFText_SetCharcodes(object, codes.as_ptr(), codes.len() as _) != 0 {
                lib.FPDFPage_InsertObject(page, object) != 0
            } else {
                lib.FPDFPageObj_Destroy(object);
                false
            };
        let text = TextPage {
            lib,
            handle: if set {
                lib.FPDFText_LoadPage(page)
            } else {
                std::ptr::null_mut()
            },
        };
        if !text.handle.is_null() {
            for i in 0..lib.FPDFText_CountChars(text.handle).max(0) {
                if lib.FPDFText_IsGenerated(text.handle, i) == 1
                    || lib.FPDFText_HasUnicodeMapError(text.handle, i) == 1
                {
                    continue;
                }
                let unicode = lib.FPDFText_GetUnicode(text.handle, i);
                if beyond_probe(unicode) {
                    found.push(unicode);
                }
            }
        }
        drop(text);
        lib.FPDF_ClosePage(page);
        found.sort_unstable();
        found.dedup();
        found
    })
    .unwrap_or_default()
}

fn beyond_probe(unicode: u32) -> bool {
    unicode >= 0x20
        && !(0x7f..0xa0).contains(&unicode)
        && !(0xd800..0xe000).contains(&unicode)
        && unicode < 0xfffe
        && !PROBE.iter().any(|range| range.contains(&unicode))
}
