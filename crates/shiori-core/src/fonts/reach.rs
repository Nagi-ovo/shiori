//! What a font dictionary maps: every code it can set, read back.
//!
//! Two dictionaries can share one program and part only at characters the
//! id's fixed probe never asks about: both call a code U+0400, one drawing
//! the program's eacute and the other its egrave (audit B108). Hashing every
//! character there is would cost a call per code point; hashing the ones a
//! page sets would make the id depend on the page read. What a dictionary
//! maps is its own, though, and PDFium will say what that is.
//!
//! PDFium 7881 gives a font handle no dictionary access, no object number
//! and no resource name, but it sets any code in that font: a text object
//! made with the handle and given codes reads back through a text page as
//! the Unicode the dictionary gives each (its /ToUnicode, else the glyph
//! names of its /Encoding and /Differences). That is the dictionary's own
//! mapping, the same in every file and every session, whatever else its file
//! holds. A simple font has 256 codes; a CID font under a CMap of one- and
//! two-byte codes (Identity-H, as nearly every producer writes) up to
//! 65,536, all read.

use std::collections::HashMap;
use std::ops::{Range, RangeInclusive};
use std::os::raw::{c_double, c_uint};

use pdfium_render::prelude::{FPDF_DOCUMENT, FPDF_FONT, FPDF_PAGEOBJECT, FS_RECTF};

use super::id::{answer, Fnv, PROBE, UNMAPPED};
use crate::open::with_blank_document;
use crate::{Lib, TextPage};

/// Every one- and two-byte code.
const ALL_CODES: Range<c_uint> = 0..0x10000;

/// Codes set in one text object. pdfium-render's wasm bridge copies the
/// codes through a view of the core's memory that an allocation on the way
/// can detach, which a 256 KB copy of all 65,536 at once did.
const BLOCK: c_uint = 256;

/// The size the codes are set at: a box rounded to 1/100 pt is then one in
/// 1/1000 em.
const SIZE: f32 = 10.0;

/// Where the first line of codes is set, and how far apart the lines are,
/// in points: 20 pt apart the lines of a page stay close enough to the
/// origin for a box to round true.
const TOP: c_double = 900.0;
const LINE_GAP: c_double = 20.0;

/// Lines set on one page: a page of all 65,536 codes one per line would
/// hold tens of megabytes of text objects in the web worker's heap.
const LINES_PER_PAGE: usize = 4096;

/// What a text page reads a right-to-left letter back as can be a
/// decomposition: of an Arabic or Hebrew presentation form (U+FE8E as
/// U+0627), or of a high-hamza letter (U+0675 as U+0627 U+0674). Every
/// font is asked about these directly.
const DECOMPOSED: [RangeInclusive<u32>; 3] = [0x675..=0x678, 0xfb1d..=0xfdff, 0xfe70..=0xfefe];

/// What a dictionary maps past the probe (`reach`).
pub(super) struct Reach {
    /// The characters past `PROBE` the codes read back as, and every
    /// `DECOMPOSED` one the dictionary maps, ascending.
    pub(super) beyond: Vec<u32>,
    /// For a font with right-to-left letters, a hash of each character a
    /// code alone read back as that its dictionary does not map back, with
    /// its box: what tells apart dictionaries PDFium reads alike.
    pub(super) unverified: Option<u64>,
    /// Every code was read, and back to a character the dictionary maps or
    /// one asked about directly: only then is `beyond` all it maps past the
    /// probe.
    pub(super) established: bool,
}

/// One character a code read back as, and its box (its advance by the
/// font's ascent and descent) from the origin in 1/100 pt (1/1000 em at
/// `SIZE`).
struct Read {
    unicode: u32,
    mapped: bool,
    extent: [i32; 4],
}

/// Reads every code `font`'s dictionary can set (see the module docs).
/// `document` is the font's own: the text object takes its font from there.
/// It is set on a page of a blank document of its own, so the file is never
/// touched. All 65,536 codes are read, whatever the font: a simple font's
/// code past 255 is that code's low byte, but PDFium does not say which
/// kind a font is, and a CID font can read its first 512 codes exactly as
/// a simple font would and part from another only further on. A CMap with
/// three- or four-byte codes (rare, and never Identity-H) keeps those past
/// 0xFFFF out.
///
/// Set in a line, a text page lays out a right-to-left run backwards,
/// mirroring the brackets and arrows in it and decomposing what it can, and
/// it forgets that a code there had no Unicode (an unmapped Identity-H code
/// 0x5D0 reads back as U+05D0). A font that maps a right-to-left letter or
/// a `DECOMPOSED` one is read again, each code on a line of its own: a code
/// alone reads back as its own character unless it is a right-to-left
/// letter, whose sources are asked about directly. A code that draws
/// nothing on a line of its own is dropped from that reading.
///
/// Costs a text page of 65,536 characters in lines of 256 per font (about
/// 0.1 s natively for a whole Latin TrueType program, 10 ms for a subset or
/// a simple font) and as much again for a font with right-to-left letters,
/// once per font per document (`seen`).
pub(super) unsafe fn reach(lib: &Lib, document: FPDF_DOCUMENT, font: FPDF_FONT) -> Reach {
    let scan = with_blank_document(lib, |blank| {
        let blocks: Vec<Range<c_uint>> = ALL_CODES
            .step_by(BLOCK as usize)
            .map(|first| first..first + BLOCK)
            .collect();
        let all = read_codes(lib, blank, document, font, &blocks, LINE_GAP)?;
        Some(all.into_iter().flatten().collect::<Vec<Read>>())
    })
    .flatten();
    let Some(line) = scan else {
        return Reach {
            beyond: Vec::new(),
            unverified: None,
            established: false,
        };
    };
    let none = answer(lib, font, UNMAPPED);
    let mut maps_back = HashMap::new();
    let mut maps = |unicode: u32| {
        *maps_back
            .entry(unicode)
            .or_insert_with(|| answer(lib, font, unicode) != none)
    };
    let decomposed: Vec<u32> = DECOMPOSED
        .iter()
        .cloned()
        .flatten()
        .filter(|&unicode| maps(unicode))
        .collect();
    let rtl = !decomposed.is_empty()
        || line
            .iter()
            .any(|read| read.mapped && right_to_left(read.unicode) && maps(read.unicode));
    // None when a font with right-to-left letters could not be read again.
    let alone = if rtl {
        let each: Vec<Range<c_uint>> = ALL_CODES.map(|code| code..code + 1).collect();
        with_blank_document(lib, |blank| {
            let mut alone = Vec::new();
            for page in each.chunks(LINES_PER_PAGE) {
                let lines = read_codes(lib, blank, document, font, page, LINE_GAP)?;
                alone.extend(lines.into_iter().flatten());
            }
            Some(alone)
        })
        .flatten()
    } else {
        Some(Vec::new())
    };
    let read_alone = alone.is_some();
    let alone = alone.unwrap_or_default();
    let in_probe = |unicode: u32| PROBE.iter().any(|range| range.contains(&unicode));
    let mut beyond: Vec<u32> = line
        .iter()
        .chain(&alone)
        .filter(|read| read.mapped && character(read.unicode) && !in_probe(read.unicode))
        .map(|read| read.unicode)
        .chain(decomposed)
        .collect();
    let mut unverified: Option<Fnv> = None;
    for read in alone
        .iter()
        .filter(|read| read.mapped && character(read.unicode) && !right_to_left(read.unicode))
    {
        if !maps(read.unicode) {
            let hash = unverified.get_or_insert_with(Fnv::new);
            hash.int(read.unicode as i32);
            read.extent.iter().for_each(|&edge| hash.int(edge));
        }
    }
    beyond.sort_unstable();
    beyond.dedup();
    Reach {
        beyond,
        established: read_alone && unverified.is_none(),
        unverified: unverified.map(|hash| hash.0),
    }
}

/// Sets each block of codes in a text object of its own, `leading` apart,
/// and reads each back through a text page, in its order: None when PDFium
/// would not. Text-page housekeeping is left out (characters PDFium
/// inserts); a code it found no Unicode for reads back unmapped.
unsafe fn read_codes(
    lib: &Lib,
    blank: FPDF_DOCUMENT,
    document: FPDF_DOCUMENT,
    font: FPDF_FONT,
    blocks: &[Range<c_uint>],
    leading: c_double,
) -> Option<Vec<Vec<Read>>> {
    let page = lib.FPDFPage_New(blank, 0, 612.0, 792.0);
    if page.is_null() {
        return None;
    }
    let mut objects: HashMap<FPDF_PAGEOBJECT, usize> = HashMap::new();
    for (line, block) in blocks.iter().enumerate() {
        let object = lib.FPDFPageObj_CreateTextObj(document, font, SIZE);
        let codes: Vec<c_uint> = block.clone().collect();
        // Inserted, the object is the page's and closes with it; an insert
        // that fails frees it.
        let set = !object.is_null()
            && if lib.FPDFText_SetCharcodes(object, codes.as_ptr(), codes.len() as _) != 0 {
                lib.FPDFPageObj_Transform(
                    object,
                    1.0,
                    0.0,
                    0.0,
                    1.0,
                    0.0,
                    TOP - leading * line as c_double,
                );
                lib.FPDFPage_InsertObject(page, object) != 0
            } else {
                lib.FPDFPageObj_Destroy(object);
                false
            };
        if !set {
            lib.FPDF_ClosePage(page);
            return None;
        }
        objects.insert(object, line);
    }
    let text = TextPage {
        lib,
        handle: lib.FPDFText_LoadPage(page),
    };
    let mut reads: Option<Vec<Vec<Read>>> = None;
    if !text.handle.is_null() {
        let mut lines: Vec<Vec<Read>> = blocks.iter().map(|_| Vec::new()).collect();
        for i in 0..lib.FPDFText_CountChars(text.handle).max(0) {
            if lib.FPDFText_IsGenerated(text.handle, i) == 1 {
                continue;
            }
            let object = lib.FPDFText_GetTextObject(text.handle, i);
            let Some(&line) = objects.get(&object) else {
                continue;
            };
            let (mut x, mut y) = (0.0, 0.0);
            lib.FPDFText_GetCharOrigin(text.handle, i, &mut x, &mut y);
            // Not FPDFText_GetCharBox: pdfium-render 0.9.4's wasm bridge
            // hands it its four out-pointers in the wrong order.
            let mut r = FS_RECTF {
                left: 0.0,
                top: 0.0,
                right: 0.0,
                bottom: 0.0,
            };
            lib.FPDFText_GetLooseCharBox(text.handle, i, &mut r);
            let from =
                |edge: f32, origin: c_double| ((f64::from(edge) - origin) * 100.0).round() as i32;
            lines[line].push(Read {
                unicode: lib.FPDFText_GetUnicode(text.handle, i),
                mapped: lib.FPDFText_HasUnicodeMapError(text.handle, i) != 1,
                extent: [
                    from(r.left, x),
                    from(r.bottom, y),
                    from(r.right, x),
                    from(r.top, y),
                ],
            });
        }
        reads = Some(lines);
    }
    drop(text);
    lib.FPDF_ClosePage(page);
    reads
}

/// A character a face can map: not a control, half a UTF-16 pair (wchar_t
/// is 16-bit on Windows) or a noncharacter. Nothing above the Basic
/// Multilingual Plane reads back whole through a 16-bit wchar_t.
fn character(unicode: u32) -> bool {
    unicode >= 0x20
        && !(0x7f..0xa0).contains(&unicode)
        && !(0xd800..0xe000).contains(&unicode)
        && unicode < 0xfffe
}

/// Hebrew, Arabic, Syriac, Thaana, NKo and their neighbours to U+08FF, and
/// the presentation forms: letters a text page lays out right to left.
fn right_to_left(unicode: u32) -> bool {
    (0x590..=0x8ff).contains(&unicode) || (0xfb1d..=0xfefe).contains(&unicode)
}
