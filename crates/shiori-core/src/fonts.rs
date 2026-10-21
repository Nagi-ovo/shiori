//! The fonts a page's text uses: the programs a file embeds, the faces
//! rebuilt from PDFium's glyph outlines, and how both are packed for a host
//! that moves bytes.

use std::os::raw::c_int;

use pdfium_render::prelude::{FPDF_FONT, FPDF_PAGEOBJECT, FPDF_PAGEOBJ_FORM, FPDF_PAGEOBJ_TEXT};

use crate::{CoreError, Document, Lib, TextPage, MAX_FORM_DEPTH, PDF_FONT_FLAGS};

/// A font program a page's text uses that the file embeds, as the file
/// stores it: TrueType, OpenType (TrueType or CFF outlines), bare CFF or
/// Type 1. The reading layer turns the ones a browser can load into faces,
/// so edits to existing text can be set in the document's own font.
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddedFont {
    /// The BaseFont name as PDFium reports it, the same name the text layer's
    /// glyphs carry: PDFium drops a Type 1 font's subset prefix ("ABCDEF+")
    /// and keeps a TrueType or CID font's.
    pub name: String,
    /// The program's identity (`program_id`), as the glyphs carry it.
    pub id: String,
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
    /// The BaseFont name and program id, as `EmbeddedFont`'s.
    pub name: String,
    pub id: String,
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
/// `[{name, id, flags, ascent, descent, glyphs: [[unicode, advance, path]]}]`.
/// src/pdf/engine/fontOutlines.ts reads it.
pub fn encode_font_outlines(fonts: &[FontOutlines]) -> Vec<u8> {
    let mut out = String::from("[");
    for (i, font) in fonts.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{{\"name\":{},\"id\":{},\"flags\":{},\"ascent\":{},\"descent\":{},\"glyphs\":[",
            json_string(&font.name),
            json_string(&font.id),
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
/// font's `name`, `id`, `flags`, `format` and `length`, then every program in
/// order. src/pdf/engine/fontContainer.ts reads it.
pub fn encode_embedded_fonts(fonts: &[EmbeddedFont]) -> Vec<u8> {
    let mut header = String::from("[");
    for (i, font) in fonts.iter().enumerate() {
        if i > 0 {
            header.push(',');
        }
        header.push_str(&format!(
            "{{\"name\":{},\"id\":{},\"flags\":{},\"format\":\"{}\",\"length\":{}}}",
            json_string(&font.name),
            json_string(&font.id),
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

/// The program a font embeds, as the file stores it (decoded), or None for
/// a font the file does not embed.
pub(crate) unsafe fn font_program(lib: &Lib, font: FPDF_FONT) -> Option<Vec<u8>> {
    if lib.FPDFFont_GetIsEmbedded(font) != 1 {
        return None;
    }
    let mut size = 0;
    lib.FPDFFont_GetFontData(font, std::ptr::null_mut(), 0, &mut size);
    if size == 0 {
        return None;
    }
    let mut data = vec![0u8; size];
    if lib.FPDFFont_GetFontData(font, data.as_mut_ptr(), size, &mut size) == 0 {
        return None;
    }
    data.truncate(size);
    Some(data)
}

/// Tells apart fonts PDFium names alike. Two papers merged into one file
/// often embed two subsets of one font, both "Calibri" once PDFium drops
/// their subset tags, and a face built from one lacks the other's glyphs.
/// PDFium gives a font handle no object number, and its handles are freed
/// with their pages, so the identity is the program itself: FNV-1a 64 over
/// its bytes, in hex. The same program has the same id on every page, in a
/// reopened file and in a file merged from it, where edits saved with it in
/// a draft find it again. Hashing reads the program once per font per page
/// read: microseconds for a subset, a few milliseconds for a whole CJK font.
pub(crate) fn program_id(data: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in data {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// The id of a font's program (`program_id`); empty for a font the file
/// does not embed.
pub(crate) unsafe fn font_id(lib: &Lib, font: FPDF_FONT) -> String {
    font_program(lib, font)
        .map(|data| program_id(&data))
        .unwrap_or_default()
}

/// A font's BaseFont name as PDFium reports it (see `EmbeddedFont::name`).
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

impl Document {
    /// The embedded fonts a page's text uses, each once, in the order the page
    /// first uses them.
    pub fn embedded_fonts(&self, index: u32) -> Result<Vec<EmbeddedFont>, CoreError> {
        let page = self.page(index)?;
        let lib = self.lib;
        let mut seen = std::collections::HashSet::new();
        let mut fonts = Vec::new();
        let mut stack: Vec<(FPDF_PAGEOBJECT, usize)> = Vec::new();
        unsafe {
            for i in (0..lib.FPDFPage_CountObjects(page.handle)).rev() {
                stack.push((lib.FPDFPage_GetObject(page.handle, i), 0));
            }
            while let Some((object, depth)) = stack.pop() {
                if object.is_null() {
                    continue;
                }
                match lib.FPDFPageObj_GetType(object) as u32 {
                    FPDF_PAGEOBJ_FORM if depth < MAX_FORM_DEPTH => {
                        for i in (0..lib.FPDFFormObj_CountObjects(object)).rev() {
                            stack.push((lib.FPDFFormObj_GetObject(object, i as _), depth + 1));
                        }
                    }
                    FPDF_PAGEOBJ_TEXT => {
                        let font = lib.FPDFTextObj_GetFont(object);
                        if font.is_null() || !seen.insert(font as usize) {
                            continue;
                        }
                        let Some(data) = font_program(lib, font) else {
                            continue;
                        };
                        fonts.push(EmbeddedFont {
                            name: base_font_name(lib, font),
                            id: program_id(&data),
                            flags: lib.FPDFFont_GetFlags(font) & PDF_FONT_FLAGS,
                            format: FontFormat::of(&data),
                            data,
                        });
                    }
                    _ => {}
                }
            }
        }
        Ok(fonts)
    }

    /// The named embedded fonts rebuilt from their glyphs, for the characters
    /// this page sets in each (see `FontOutlines`): every program under a
    /// name asked for, told apart by id. A font FreeType could not load is
    /// drawn with a substitute and is left out, as in `embedded_fonts`.
    pub fn font_outlines(
        &self,
        index: u32,
        names: &[String],
    ) -> Result<Vec<FontOutlines>, CoreError> {
        let page = self.page(index)?;
        let lib = self.lib;
        let text = TextPage {
            lib,
            handle: unsafe { lib.FPDFText_LoadPage(page.handle) },
        };
        if text.handle.is_null() {
            return Err(CoreError::Pdfium(format!("no text layer for page {index}")));
        }
        // Each wanted font's characters, in the order the page first sets them.
        let mut order: Vec<(FPDF_FONT, String)> = Vec::new();
        let mut chars: std::collections::HashMap<usize, Vec<u32>> =
            std::collections::HashMap::new();
        let mut names_of: std::collections::HashMap<usize, Option<String>> =
            std::collections::HashMap::new();
        let mut seen = std::collections::HashSet::new();
        unsafe {
            let count = lib.FPDFText_CountChars(text.handle).max(0);
            for i in 0..count {
                if lib.FPDFText_IsGenerated(text.handle, i) == 1 {
                    continue;
                }
                let unicode = lib.FPDFText_GetUnicode(text.handle, i);
                // Controls, and the halves of a pair UTF-16 splits: a face
                // maps whole characters.
                if unicode < 0x20 || (0xd800..0xe000).contains(&unicode) {
                    continue;
                }
                let object = lib.FPDFText_GetTextObject(text.handle, i);
                if object.is_null() {
                    continue;
                }
                let font = lib.FPDFTextObj_GetFont(object);
                if font.is_null() {
                    continue;
                }
                let key = font as usize;
                let name = names_of.entry(key).or_insert_with(|| {
                    if lib.FPDFFont_GetIsEmbedded(font) != 1 {
                        return None;
                    }
                    let name = base_font_name(lib, font);
                    names.contains(&name).then_some(name)
                });
                let Some(name) = name.clone() else {
                    continue;
                };
                let list = chars.entry(key).or_insert_with(|| {
                    order.push((font, name));
                    Vec::new()
                });
                if list.len() < MAX_OUTLINE_GLYPHS && seen.insert((key, unicode)) {
                    list.push(unicode);
                }
            }
            Ok(order
                .into_iter()
                .map(|(font, name)| {
                    let (mut ascent, mut descent) = (0f32, 0f32);
                    lib.FPDFFont_GetAscent(font, 1000.0, &mut ascent);
                    lib.FPDFFont_GetDescent(font, 1000.0, &mut descent);
                    let glyphs = chars[&(font as usize)]
                        .iter()
                        .filter_map(|&unicode| glyph_outline(lib, font, unicode))
                        .collect();
                    FontOutlines {
                        name,
                        id: font_id(lib, font),
                        flags: lib.FPDFFont_GetFlags(font) & PDF_FONT_FLAGS,
                        ascent,
                        descent,
                        glyphs,
                    }
                })
                .collect())
        }
    }
}
