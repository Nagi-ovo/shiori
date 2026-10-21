//! The fonts a page's text uses: the programs a file embeds, the faces
//! rebuilt from PDFium's glyph outlines, and how both are packed for a host
//! that moves bytes.

use std::os::raw::c_int;

use pdfium_render::prelude::FPDF_FONT;

use crate::Lib;

/// A font program a page's text uses that the file embeds, as the file
/// stores it: TrueType, OpenType (TrueType or CFF outlines), bare CFF or
/// Type 1. The reading layer turns the ones a browser can load into faces,
/// so edits to existing text can be set in the document's own font.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddedFont {
    /// The BaseFont name as PDFium reports it, a subset prefix ("ABCDEF+")
    /// dropped, the same name the text layer's glyphs carry.
    pub name: String,
    /// Descriptor flags (PDF 32000 table 123).
    pub flags: i32,
    pub format: FontFormat,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontFormat {
    TrueType,
    OpenType,
    Cff,
    Type1,
    Unknown,
}

impl FontFormat {
    /// From the program's first bytes.
    pub(crate) fn of(data: &[u8]) -> FontFormat {
        match data {
            [0, 1, 0, 0, ..] | [b't', b'r', b'u', b'e', ..] => FontFormat::TrueType,
            [b'O', b'T', b'T', b'O', ..] => FontFormat::OpenType,
            [b'%', b'!', ..] | [0x80, 0x01, ..] => FontFormat::Type1,
            // A CFF header: major version 1, then its size and offset size.
            [1, 0, 4, 1..=4, ..] => FontFormat::Cff,
            _ => FontFormat::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            FontFormat::TrueType => "truetype",
            FontFormat::OpenType => "opentype",
            FontFormat::Cff => "cff",
            FontFormat::Type1 => "type1",
            FontFormat::Unknown => "unknown",
        }
    }
}

/// An embedded font rebuilt from what PDFium draws: for each character a
/// page sets in it, the glyph's outline and advance. A browser refuses many
/// font programs as files embed them (bare CFF, Type 1, TrueType subsets
/// stripped of tables its sanitiser requires), and their cmaps rarely map
/// Unicode; PDFium's FreeType has already loaded them all, so the reading
/// layer builds a face from these outlines instead.
#[derive(Debug, Clone, PartialEq)]
pub struct FontOutlines {
    /// The BaseFont name, as `EmbeddedFont::name`.
    pub name: String,
    pub flags: i32,
    /// Ascent and descent in 1/1000 em, descent negative.
    pub ascent: f32,
    pub descent: f32,
    pub glyphs: Vec<GlyphOutline>,
}

/// One character's glyph in the font's own space: 1/1000 em, y up, the
/// origin on the baseline.
#[derive(Debug, Clone, PartialEq)]
pub struct GlyphOutline {
    pub unicode: u32,
    /// The advance the PDF gives the character (its /Widths entry).
    pub advance: f32,
    /// Path data: `M x y`, `L x y`, `C x1 y1 x2 y2 x y` and `Z`, whole units.
    pub path: String,
}

/// Distinct characters rebuilt per font per page; a CJK page sets a few
/// thousand at most.
pub(crate) const MAX_OUTLINE_GLYPHS: usize = 8192;

/// JSON for a host that moves bytes (Tauri IPC, the web worker):
/// `[{name, flags, ascent, descent, glyphs: [[unicode, advance, path]]}]`.
/// src/pdf/engine/fontOutlines.ts reads it.
pub fn encode_font_outlines(fonts: &[FontOutlines]) -> Vec<u8> {
    let mut out = String::from("[");
    for (i, font) in fonts.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{{\"name\":{},\"flags\":{},\"ascent\":{},\"descent\":{},\"glyphs\":[",
            json_string(&font.name),
            font.flags,
            font.ascent.round(),
            font.descent.round()
        ));
        for (j, glyph) in font.glyphs.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push_str(&format!(
                "[{},{},{}]",
                glyph.unicode,
                glyph.advance.round(),
                json_string(&glyph.path)
            ));
        }
        out.push_str("]}");
    }
    out.push(']');
    out.into_bytes()
}

/// Packs fonts for a host that moves bytes, not objects (Tauri IPC, the web
/// worker): a u32 little-endian length, that many bytes of JSON listing each
/// font's `name`, `flags`, `format` and `length`, then every program in
/// order. src/pdf/engine/fontContainer.ts reads it.
pub fn encode_embedded_fonts(fonts: &[EmbeddedFont]) -> Vec<u8> {
    let mut header = String::from("[");
    for (i, font) in fonts.iter().enumerate() {
        if i > 0 {
            header.push(',');
        }
        header.push_str(&format!(
            "{{\"name\":{},\"flags\":{},\"format\":\"{}\",\"length\":{}}}",
            json_string(&font.name),
            font.flags,
            font.format.as_str(),
            font.data.len()
        ));
    }
    header.push(']');
    let mut out =
        Vec::with_capacity(4 + header.len() + fonts.iter().map(|f| f.data.len()).sum::<usize>());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(header.as_bytes());
    for font in fonts {
        out.extend_from_slice(&font.data);
    }
    out
}

/// A JSON string literal.
fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A font's BaseFont name, a subset prefix dropped (PDFium's own).
pub(crate) unsafe fn base_font_name(lib: &Lib, font: FPDF_FONT) -> String {
    let len = lib.FPDFFont_GetBaseFontName(font, std::ptr::null_mut(), 0);
    let mut name = vec![0u8; len];
    if len > 0 {
        lib.FPDFFont_GetBaseFontName(font, name.as_mut_ptr().cast(), len);
    }
    String::from_utf8_lossy(&name)
        .trim_end_matches('\0')
        .to_string()
}

/// Glyph paths come back in em units (PDFium's CFX_Font::LoadGlyphPath);
/// the rebuilt font uses 1000 units per em.
const GLYPH_PATH_SCALE: f32 = 1000.0;

// fpdf_edit.h
const FPDF_SEGMENT_LINETO: c_int = 0;
const FPDF_SEGMENT_BEZIERTO: c_int = 1;
const FPDF_SEGMENT_MOVETO: c_int = 2;

/// The glyph PDFium draws for `unicode` in `font`, or None when the font has
/// no width for it (PDFium would draw nothing).
pub(crate) unsafe fn glyph_outline(
    lib: &Lib,
    font: FPDF_FONT,
    unicode: u32,
) -> Option<GlyphOutline> {
    let mut advance = 0f32;
    if lib.FPDFFont_GetGlyphWidth(font, unicode, 1000.0, &mut advance) == 0 {
        return None;
    }
    let mut path = String::new();
    let glyph = lib.FPDFFont_GetGlyphPath(font, unicode, 1000.0);
    // A space has an advance and no outline.
    let count = if glyph.is_null() {
        0
    } else {
        lib.FPDFGlyphPath_CountGlyphSegments(glyph)
    };
    let mut curve: Vec<(f32, f32)> = Vec::with_capacity(3);
    for i in 0..count {
        let segment = lib.FPDFGlyphPath_GetGlyphPathSegment(glyph, i);
        let (mut x, mut y) = (0f32, 0f32);
        if segment.is_null() || lib.FPDFPathSegment_GetPoint(segment, &mut x, &mut y) == 0 {
            return None;
        }
        let (x, y) = (x * GLYPH_PATH_SCALE, y * GLYPH_PATH_SCALE);
        match lib.FPDFPathSegment_GetType(segment) {
            FPDF_SEGMENT_MOVETO => path.push_str(&format!("M{} {}", x.round(), y.round())),
            FPDF_SEGMENT_LINETO => path.push_str(&format!("L{} {}", x.round(), y.round())),
            // A cubic arrives as three points, the last the end.
            FPDF_SEGMENT_BEZIERTO => {
                curve.push((x, y));
                if curve.len() == 3 {
                    path.push('C');
                    for (k, (cx, cy)) in curve.drain(..).enumerate() {
                        if k > 0 {
                            path.push(' ');
                        }
                        path.push_str(&format!("{} {}", cx.round(), cy.round()));
                    }
                }
            }
            _ => return None,
        }
        if lib.FPDFPathSegment_GetClose(segment) != 0 && curve.is_empty() {
            path.push('Z');
        }
    }
    Some(GlyphOutline {
        unicode,
        advance,
        path,
    })
}
