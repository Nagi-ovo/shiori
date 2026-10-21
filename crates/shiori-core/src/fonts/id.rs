//! Telling apart fonts PDFium names alike.
//!
//! Two papers merged into one file often embed two subsets of one font,
//! both "Calibri" once PDFium drops their subset tags, and a face built from
//! one lacks the other's glyphs. Two font dictionaries can also share one
//! program and use it differently: pdfTeX embeds a Type 1 file once for every
//! encoding a document uses, so one dictionary's "a" can draw the program's
//! small-caps A (its /Encoding, /ToUnicode and /Widths say so) while
//! another's draws the plain a. A face rebuilt for one then draws the other's
//! text with the wrong glyphs.
//!
//! PDFium 7881 gives a font handle no object number and no access to its
//! dictionary, and frees its handles with their pages. So a font's id is
//! what it is: its program, and how its dictionary uses that program, as
//! PDFium reports it for a fixed set of characters and for every further
//! character the dictionary maps (`reach`). The same dictionary has the
//! same id on every page, in a reopened file and in a file merged from it,
//! where edits saved with it in a draft find it again.

use pdfium_render::prelude::FPDF_FONT;

use super::reach::Reach;
use super::GLYPH_PATH_SCALE;
use crate::Lib;

/// The characters every font is asked about: the ones the 8-bit encodings
/// simple fonts use (WinAnsi, MacRoman, Standard, pdfTeX's ligatures) can
/// reach, where the dictionaries that share one program (text, small caps,
/// old-style figures, accented letters, symbols) part. Printable ASCII,
/// Latin-1 and Latin Extended-A, then the punctuation, accents and symbols
/// beyond. Two dictionaries that draw all of these alike and differ only
/// further on, as two CID fonts on one program can, keep one id. The probe
/// is fixed, never the characters a page sets, so the id does not depend on
/// which page is read; what a dictionary maps beyond it is added per font.
pub(super) const PROBE: &[std::ops::RangeInclusive<u32>] = &[
    0x20..=0x7e,
    0xa0..=0x17f,
    0x192..=0x192,
    0x2c6..=0x2dd,
    0x3a9..=0x3a9,
    0x3c0..=0x3c0,
    0x2013..=0x2044,
    0x20ac..=0x20ac,
    0x2122..=0x2122,
    0x2202..=0x2202,
    0x2206..=0x2206,
    0x220f..=0x220f,
    0x2211..=0x2211,
    0x221a..=0x221a,
    0x221e..=0x221e,
    0x222b..=0x222b,
    0x2248..=0x2248,
    0x2260..=0x2260,
    0x2264..=0x2265,
    0x25ca..=0x25ca,
    0xfb00..=0xfb06,
];

/// FNV-1a 64.
pub(super) struct Fnv(pub(super) u64);

impl Fnv {
    pub(super) fn new() -> Fnv {
        Fnv(0xcbf2_9ce4_8422_2325)
    }

    pub(super) fn bytes(&mut self, data: &[u8]) {
        for &byte in data {
            self.0 ^= u64::from(byte);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
    }

    pub(super) fn int(&mut self, value: i32) {
        self.bytes(&value.to_le_bytes());
    }
}

/// A character no font maps: each font's answer for it is its answer for a
/// character it does not map (no outline, or its .notdef).
pub(super) const UNMAPPED: u32 = 0xffff;

/// The id of an embedded font whose program is `program`, in hex: FNV-1a 64
/// over the program's bytes, its descriptor flags and, for each probe
/// character, the advance its /Widths give it and the whole outline of the
/// glyph it draws. The advance (through PDFium's lookup from Unicode back to
/// a code) catches a dictionary that maps a character elsewhere or widens
/// it; the outline catches one that swaps in a glyph of the same width, a
/// mirror image included. Then each character of `reach.beyond` the font
/// draws, with its advance and outline, so two dictionaries that part only
/// past the probe part here, and the hash of what a right-to-left run read
/// back that it does not map (`Reach::unverified`). A font that maps
/// nothing past the probe keeps the id it had before `reach` was added.
///
/// The outline is every segment's type, point and closure in whole 1/1000
/// em, as `glyph_outline` rebuilds it from PDFium's FreeType, so two ids are
/// equal when the rebuilt probe glyphs are. An upgrade of either that moves
/// a point across a rounding boundary changes the id and leaves a draft's
/// edit in a fallback face. Hashing reads the program and asks about 420
/// characters once per font per document (`seen`): 0.1 to 0.3 ms for a Latin font
/// in a native release build, a few more milliseconds to hash a whole CJK
/// program.
pub(crate) unsafe fn font_identity(
    lib: &Lib,
    font: FPDF_FONT,
    program: &[u8],
    reach: &Reach,
) -> String {
    let mut hash = Fnv::new();
    hash.bytes(program);
    hash.int(lib.FPDFFont_GetFlags(font));
    for unicode in PROBE.iter().cloned().flatten() {
        let mut advance = 0f32;
        lib.FPDFFont_GetGlyphWidth(font, unicode, 1000.0, &mut advance);
        hash.int(advance.round() as i32);
        glyph_shape(lib, font, unicode, &mut hash);
    }
    let none = answer(lib, font, UNMAPPED);
    for &unicode in &reach.beyond {
        let (advance, shape) = answer(lib, font, unicode);
        if (advance, shape) != none {
            hash.int(unicode as i32);
            hash.int(advance);
            hash.bytes(&shape.to_le_bytes());
        }
    }
    if let Some(unverified) = reach.unverified {
        hash.int(-1);
        hash.bytes(&unverified.to_le_bytes());
    }
    format!("{:016x}", hash.0)
}

/// The advance (whole 1/1000 em) and the outline's hash (`glyph_shape`) of
/// the glyph `font` draws for `unicode`.
pub(super) unsafe fn answer(lib: &Lib, font: FPDF_FONT, unicode: u32) -> (i32, u64) {
    let mut advance = 0f32;
    lib.FPDFFont_GetGlyphWidth(font, unicode, 1000.0, &mut advance);
    let mut hash = Fnv::new();
    glyph_shape(lib, font, unicode, &mut hash);
    (advance.round() as i32, hash.0)
}

/// The outline of the glyph `font` draws for `unicode`: its segment count
/// (-1 for none), then each segment's type, point and closure.
pub(super) unsafe fn glyph_shape(lib: &Lib, font: FPDF_FONT, unicode: u32, hash: &mut Fnv) {
    let glyph = lib.FPDFFont_GetGlyphPath(font, unicode, 1000.0);
    let count = if glyph.is_null() {
        -1
    } else {
        lib.FPDFGlyphPath_CountGlyphSegments(glyph)
    };
    hash.int(count);
    for i in 0..count.max(0) {
        let segment = lib.FPDFGlyphPath_GetGlyphPathSegment(glyph, i);
        let (mut x, mut y) = (0f32, 0f32);
        if segment.is_null() || lib.FPDFPathSegment_GetPoint(segment, &mut x, &mut y) == 0 {
            hash.int(-1);
            continue;
        }
        hash.int(lib.FPDFPathSegment_GetType(segment));
        hash.int((x * GLYPH_PATH_SCALE).round() as i32);
        hash.int((y * GLYPH_PATH_SCALE).round() as i32);
        hash.int(lib.FPDFPathSegment_GetClose(segment));
    }
}
