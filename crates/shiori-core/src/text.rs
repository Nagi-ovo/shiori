//! A page's text as PDFium reads it: each glyph with where it sits, its
//! advance and its font.

use std::os::raw::c_int;

use pdfium_render::prelude::{FS_MATRIX, FS_RECTF};

use crate::fonts::font_id;
use crate::{
    decode, normalized, same_point, CoreError, Document, Lib, Rect, TextPage, BOX_SLACK_PT,
    PDF_FONT_FLAGS,
};

/// One glyph as drawn: usually one character, but a ligature PDFium splits
/// into its letters ("ﬁ" → "f", "i") comes back whole, as the reader sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct TextChar {
    pub text: String,
    /// Where the glyph's baseline starts.
    pub origin: (f32, f32),
    /// Where its advance ends along the baseline: origin plus the glyph's
    /// width. Selection and highlight edges are built from origin and end.
    pub end: (f32, f32),
    /// PDFium's loose box: the advance box, font ascent to descent, united with
    /// the glyph's ink.
    pub loose: Rect,
    /// Em size on the page, in points.
    pub font_size: f32,
    /// Counter-clockwise, radians; 0 for ordinary horizontal text.
    pub angle: f32,
    /// Inserted by PDFium's text extraction (a space or line break between
    /// runs), not drawn on the page.
    pub generated: bool,
    /// A line-end hyphen PDFium recognised as hyphenation. `text` is "-".
    pub hyphen: bool,
    /// The font's name as the file gives it (PDFium drops a Type 1 font's
    /// subset prefix and keeps a TrueType or CID font's), and
    /// its descriptor flags (PDF 32000 table 123: 1 fixed pitch, 2 serif, …).
    pub font_name: String,
    /// The font's id (`fonts::id::font_identity`), which tells apart fonts
    /// named alike; empty for a font the file does not embed.
    pub font_id: String,
    pub font_flags: i32,
    /// The font's ascent and descent at this glyph's size, in page units
    /// along the glyph's up direction (descent is negative).
    pub ascent: f32,
    pub descent: f32,
}

/// What PDFium reports for one character index, before glyphs are assembled.
struct RawChar {
    unicode: u32,
    origin: (f32, f32),
    loose: Rect,
    /// Unit vector of the baseline on the page.
    direction: (f32, f32),
    angle: f32,
    font_size: f32,
    generated: bool,
    hyphen: bool,
    /// Origin plus the font's width for this character, when the font has one.
    width_end: Option<(f32, f32)>,
    font: FontInfo,
}

/// What a glyph's font contributes, read once per font per page.
#[derive(Clone, Default)]
struct FontInfo {
    name: String,
    id: String,
    flags: i32,
    /// Ascent and descent per unit of font size.
    ascent: f32,
    descent: f32,
}

impl Document {
    /// Every glyph on the page, in PDFium's reading order, or
    /// [`CoreError::TooMuchText`] when PDFium counts more than `max`
    /// characters on it ([`MAX_PAGE_CHARS`] for a reader). The count is
    /// PDFium's characters, which a ligature or surrogate pair makes more
    /// than the glyphs returned. It is checked before anything is read per
    /// character, so a page of millions of characters costs no glyph list
    /// here or in a binding's JSON; PDFium has already parsed the whole page
    /// to count them, which this does not bound.
    pub fn chars(&self, index: u32, max: usize) -> Result<Vec<TextChar>, CoreError> {
        let page = self.page(index)?;
        let text = TextPage {
            lib: self.lib,
            handle: unsafe { self.lib.FPDFText_LoadPage(page.handle) },
        };
        if text.handle.is_null() {
            return Err(CoreError::Pdfium(format!("no text layer for page {index}")));
        }
        let count = unsafe { self.lib.FPDFText_CountChars(text.handle) }.max(0);
        if count as usize > max {
            return Err(CoreError::TooMuchText {
                index,
                count: count as usize,
                max,
            });
        }
        let mut fonts = std::collections::HashMap::new();
        let raw: Vec<RawChar> = (0..count)
            .map(|i| raw_char(self.lib, &text, i, &mut fonts))
            .collect();
        Ok(assemble(&raw))
    }
}

fn raw_char(
    lib: &Lib,
    text: &TextPage<'_>,
    i: c_int,
    fonts: &mut std::collections::HashMap<usize, FontInfo>,
) -> RawChar {
    let tp = text.handle;
    unsafe {
        let (mut x, mut y) = (0.0f64, 0.0f64);
        lib.FPDFText_GetCharOrigin(tp, i, &mut x, &mut y);
        let origin = (x as f32, y as f32);
        let mut rect = FS_RECTF {
            left: 0.0,
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
        };
        lib.FPDFText_GetLooseCharBox(tp, i, &mut rect);
        let mut m = FS_MATRIX {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            e: 0.0,
            f: 0.0,
        };
        lib.FPDFText_GetMatrix(tp, i, &mut m);
        let unicode = lib.FPDFText_GetUnicode(tp, i);
        // The font's advance for this character, in text space, carried onto
        // the page by the character's matrix.
        let mut width_end = None;
        let mut font_info = FontInfo::default();
        let object = lib.FPDFText_GetTextObject(tp, i);
        if !object.is_null() {
            let font = lib.FPDFTextObj_GetFont(object);
            if !font.is_null() {
                font_info = fonts
                    .entry(font as usize)
                    .or_insert_with(|| {
                        let mut flags = 0;
                        let len =
                            lib.FPDFText_GetFontInfo(tp, i, std::ptr::null_mut(), 0, &mut flags);
                        let mut name = vec![0u8; len as usize];
                        lib.FPDFText_GetFontInfo(tp, i, name.as_mut_ptr().cast(), len, &mut flags);
                        let (mut ascent, mut descent) = (0f32, 0f32);
                        lib.FPDFFont_GetAscent(font, 1.0, &mut ascent);
                        lib.FPDFFont_GetDescent(font, 1.0, &mut descent);
                        FontInfo {
                            name: String::from_utf8_lossy(&name)
                                .trim_end_matches('\0')
                                .to_string(),
                            id: font_id(lib, font),
                            flags: flags & PDF_FONT_FLAGS,
                            ascent,
                            descent,
                        }
                    })
                    .clone();
            }
            let (mut size, mut width) = (0.0f32, 0.0f32);
            if !font.is_null()
                && lib.FPDFTextObj_GetFontSize(object, &mut size) != 0
                && lib.FPDFFont_GetGlyphWidth(font, unicode, size, &mut width) != 0
            {
                width_end = Some((origin.0 + m.a * width, origin.1 + m.b * width));
            }
        }
        let norm = m.a.hypot(m.b);
        let direction = if norm > 0.0 {
            (m.a / norm, m.b / norm)
        } else {
            (1.0, 0.0)
        };
        RawChar {
            unicode,
            origin,
            loose: normalized(rect.left, rect.bottom, rect.right, rect.top),
            direction,
            // Counter-clockwise from the baseline itself; PDFium's own
            // FPDFText_GetCharAngle counts clockwise.
            angle: direction
                .1
                .atan2(direction.0)
                .rem_euclid(std::f32::consts::TAU),
            font_size: lib.FPDFText_GetFontSize(tp, i) as f32 * m.c.hypot(m.d),
            generated: lib.FPDFText_IsGenerated(tp, i) == 1,
            hyphen: lib.FPDFText_IsHyphen(tp, i) == 1,
            width_end,
            font: font_info,
        }
    }
}

/// Turns PDFium's per-character list into glyphs: joins UTF-16 surrogate
/// halves (wchar_t is 16-bit on Windows) and the letters of a split ligature,
/// and gives each glyph its advance end.
fn assemble(raw: &[RawChar]) -> Vec<TextChar> {
    let mut glyphs = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let first = &raw[i];
        let mut last = i;
        // PDFium splits a ligature, an /ActualText span, or a surrogate pair
        // into characters that all sit at the drawn glyph's origin.
        while !first.generated
            && last + 1 < raw.len()
            && !raw[last + 1].generated
            && same_point(raw[last + 1].origin, first.origin)
        {
            last += 1;
        }
        let pieces = &raw[i..=last];
        let text = if first.hyphen && first.unicode == 2 {
            "-".to_string()
        } else {
            decode(pieces.iter().map(|ch| ch.unicode))
        };
        let loose = pieces
            .iter()
            .map(|ch| ch.loose)
            .reduce(Rect::union)
            .unwrap_or(first.loose);
        let single = text.chars().count() == 1;
        let end = if first.generated {
            first.origin
        } else {
            advance_end(first, single, loose, &raw[last + 1..])
        };
        glyphs.push(TextChar {
            text,
            origin: first.origin,
            end,
            loose,
            font_size: first.font_size,
            angle: first.angle,
            generated: first.generated,
            hyphen: first.hyphen,
            font_name: first.font.name.clone(),
            font_id: first.font.id.clone(),
            font_flags: first.font.flags,
            ascent: first.font.ascent * first.font_size,
            descent: first.font.descent * first.font_size,
        });
        i = last + 1;
    }
    glyphs
}

/// The glyph's advance end. The font's width is exact when PDFium maps the
/// character back to its code, and PDFium's loose box always contains the
/// advance box, so a width landing outside it is a failed lookup. Then, and
/// for split ligatures (whose letters have no single width), the glyph right
/// after it on the same baseline marks the end — never one past a generated
/// space, which would reach into the next word — and failing that the loose
/// box's far edge along the baseline. A split ligature's loose box is only its
/// ink, so the next glyph may start up to an em beyond it.
fn advance_end(first: &RawChar, single: bool, loose: Rect, rest: &[RawChar]) -> (f32, f32) {
    if single {
        if let Some(end) = first.width_end {
            if !same_point(end, first.origin) && first.loose.contains(end, BOX_SLACK_PT) {
                return end;
            }
        }
    }
    let (dx, dy) = first.direction;
    let along = |p: (f32, f32)| (p.0 - first.origin.0) * dx + (p.1 - first.origin.1) * dy;
    let across = |p: (f32, f32)| (p.1 - first.origin.1) * dx - (p.0 - first.origin.0) * dy;
    let at = |distance: f32| {
        (
            first.origin.0 + dx * distance,
            first.origin.1 + dy * distance,
        )
    };
    let reach = loose
        .corners()
        .into_iter()
        .map(along)
        .fold(0.0f32, f32::max);
    if let Some(next) = rest.first().filter(|ch| !ch.generated) {
        let distance = along(next.origin);
        if across(next.origin).abs() <= BOX_SLACK_PT
            && distance > 0.0
            && distance <= reach + first.font_size.max(BOX_SLACK_PT)
        {
            return at(distance);
        }
    }
    at(reach)
}
