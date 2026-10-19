//! Shiori's PDF reading core on PDFium: open a document, read each page's box
//! and its glyphs with their positions. Stage 2 of
//! `docs/PLAN-RUST-PDF-CORE-2026-09.md`; the CLI (napi-rs), the desktop app
//! (Tauri commands) and the web build (WASM) are meant to sit on this one crate
//! so a PDF reads the same everywhere.
//!
//! pdfium-render supplies only the FFI: loading the library, the C types and a
//! call table that serialises every call (PDFium is not thread-safe). The
//! semantics are written here against the PDFium C API, because the wrapper's
//! own types hide handles that glyph widths, clipped form drawing and
//! annotation flags need.
//!
//! Coordinates are PDF user space, in points, y up, before the page's own
//! rotation — the space `src/pdf/geometry/coords.ts` calls PDF space.

pub mod encryption;
pub mod pdf_syntax;
mod xref;

use encryption::{EncryptionError, SourceEncryption};

use std::fmt;
use std::os::raw::c_int;
#[cfg(not(target_arch = "wasm32"))]
use std::os::raw::{c_ulong, c_void};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use pdfium_render::prelude::{
    Pdfium, PdfiumLibraryBindings, FPDF_BOOKMARK, FPDF_DEST, FPDF_DOCUMENT, FPDF_FONT,
    FPDF_FORMFILLINFO, FPDF_FORMHANDLE, FPDF_LINK, FPDF_PAGE, FPDF_PAGEOBJECT, FPDF_PAGEOBJ_FORM,
    FPDF_PAGEOBJ_TEXT, FPDF_TEXTPAGE, FS_MATRIX, FS_RECTF,
};

type Lib = dyn PdfiumLibraryBindings;

/// PDFium is initialised once per process and never torn down.
static LIB: OnceLock<Box<Lib>> = OnceLock::new();
static BIND: Mutex<()> = Mutex::new(());
/// FPDF_GetLastError is process-wide: a load and the read of its error must
/// not have another thread's load between them.
static OPEN: Mutex<()> = Mutex::new(());

// fpdfview.h
const FPDF_ERR_FILE: u64 = 2;
const FPDF_ERR_FORMAT: u64 = 3;
const FPDF_ERR_PASSWORD: u64 = 4;
const FPDF_ERR_SECURITY: u64 = 5;

// fpdfview.h render flags, fpdf_annot.h annotation flag, bitmap format.
const FPDF_ANNOT: i32 = 0x01;
const FPDF_REVERSE_BYTE_ORDER: i32 = 0x10;
const FPDF_ANNOT_FLAG_HIDDEN: i32 = 1 << 1;
const FPDF_BITMAP_BGRA: i32 = 4;

/// The largest tile the core will allocate, in pixels: the app's canvas
/// budget (src/pdf/openPolicy.ts MAX_CANVAS_PIXELS).
pub const MAX_RENDER_PIXELS: u64 = 32_000_000;

/// The most characters one page's text may hold before [`Document::chars`]
/// refuses it: the reading layer's own limit
/// (`MAX_SEMANTIC_SOURCE_CHARACTERS_PER_PAGE`, src/editor/textSelection/semanticText.ts).
pub const MAX_PAGE_CHARS: usize = 2_000_000;

/// How close two characters' origins must be to belong to one glyph, and how
/// far outside a box a point may land and still count as inside, in points.
const SAME_POINT_PT: f32 = 0.001;
const BOX_SLACK_PT: f32 = 0.01;

#[derive(Debug, Clone, PartialEq)]
pub enum CoreError {
    /// The PDFium library could not be loaded.
    Library(String),
    /// Encrypted, and the password is missing or wrong.
    Password,
    /// Not a readable PDF.
    Damaged(String),
    PageOutOfRange {
        index: u32,
        count: u32,
    },
    /// PDFium failed on something it had already opened.
    Pdfium(String),
    /// The export cannot be encrypted the way the source was.
    Encryption(encryption::EncryptionError),
    /// The page holds more characters than the caller would read.
    TooMuchText {
        index: u32,
        count: usize,
        max: usize,
    },
}

impl fmt::Display for CoreError {
    // The wording is matched by `classifyPdfOpenError` in
    // src/pdf/openPolicy.ts: "password" and "damaged" pick the error kind.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CoreError::Library(detail) => write!(f, "PDFium library unavailable: {detail}"),
            CoreError::Password => write!(f, "PDF password required or incorrect"),
            CoreError::Damaged(detail) => write!(f, "damaged PDF: {detail}"),
            CoreError::PageOutOfRange { index, count } => {
                write!(f, "page index {index} out of range for {count} pages")
            }
            CoreError::Pdfium(detail) => write!(f, "PDFium error: {detail}"),
            CoreError::Encryption(error) => write!(f, "{error}"),
            CoreError::TooMuchText { index, count, max } => write!(
                f,
                "page text too large: page index {index} has {count} characters, over {max}"
            ),
        }
    }
}

impl std::error::Error for CoreError {}

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
    fn of(data: &[u8]) -> FontFormat {
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
const MAX_OUTLINE_GLYPHS: usize = 8192;

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
unsafe fn base_font_name(lib: &Lib, font: FPDF_FONT) -> String {
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
unsafe fn glyph_outline(lib: &Lib, font: FPDF_FONT, unicode: u32) -> Option<GlyphOutline> {
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

/// Nested form XObjects followed before giving up (a malformed file can nest forever).
const MAX_FORM_DEPTH: usize = 32;

/// Where a link or outline entry goes: a page and a view of it, the PDF way.
/// `view` is the destination's fit name (`XYZ`, `Fit`, `FitH`, `FitV`, `FitR`,
/// `FitB`, `FitBH`, `FitBV`) and `args` its operands in order, `None` for an
/// operand the file leaves null (XYZ's "keep the current value").
#[derive(Debug, Clone, PartialEq)]
pub struct Destination {
    pub page_index: u32,
    pub view: &'static str,
    pub args: Vec<Option<f32>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutlineItem {
    pub title: String,
    /// None when the entry points nowhere this document can show.
    pub destination: Option<Destination>,
    pub children: Vec<OutlineItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LinkTarget {
    Destination(Destination),
    Url(String),
}

/// A link annotation: its /Rect and where it goes.
#[derive(Debug, Clone, PartialEq)]
pub struct Link {
    pub rect: Rect,
    pub target: LinkTarget,
}

/// Outline entries read before giving up on a malformed (cyclic) outline.
const MAX_OUTLINE_ITEMS: usize = 20_000;

/// An annotation Shiori draws itself, found by its subtype and /Rect: PDFium
/// names annotations by position in /Annots, not by object number.
#[derive(Debug, Clone, PartialEq)]
pub struct AnnotationKey {
    /// The PDF subtype name, as pdf.js reports it ("Highlight", "Link", …).
    pub subtype: String,
    pub rect: Rect,
}

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

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub left: f32,
    pub bottom: f32,
    pub right: f32,
    pub top: f32,
}

impl Rect {
    fn union(self, other: Rect) -> Rect {
        Rect {
            left: self.left.min(other.left),
            bottom: self.bottom.min(other.bottom),
            right: self.right.max(other.right),
            top: self.top.max(other.top),
        }
    }

    fn contains(&self, (x, y): (f32, f32), slack: f32) -> bool {
        x >= self.left - slack
            && x <= self.right + slack
            && y >= self.bottom - slack
            && y <= self.top + slack
    }

    fn corners(&self) -> [(f32, f32); 4] {
        [
            (self.left, self.bottom),
            (self.right, self.bottom),
            (self.right, self.top),
            (self.left, self.top),
        ]
    }
}

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
    /// The font's name as the file gives it (PDFium drops a subset prefix), and
    /// its descriptor flags (PDF 32000 table 123: 1 fixed pitch, 2 serif, …).
    pub font_name: String,
    pub font_flags: i32,
    /// The font's ascent and descent at this glyph's size, in page units
    /// along the glyph's up direction (descent is negative).
    pub ascent: f32,
    pub descent: f32,
}

pub struct Core {
    lib: &'static Lib,
}

impl Core {
    /// Binds the PDFium dynamic library in `library_dir`. The first call in a
    /// process loads and initialises it; later calls reuse that binding
    /// whatever directory they name. On wasm32 PDFium is the Emscripten
    /// module the host handed pdfium-render (`initialize_pdfium_render`), and
    /// `library_dir` is not read.
    pub fn bind(library_dir: &Path) -> Result<Core, CoreError> {
        let _guard = BIND.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some(lib) = LIB.get() {
            return Ok(Core { lib: lib.as_ref() });
        }
        #[cfg(not(target_arch = "wasm32"))]
        let lib =
            Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(library_dir))
                .map_err(|error| CoreError::Library(error.to_string()))?;
        #[cfg(target_arch = "wasm32")]
        let lib = {
            let _ = library_dir;
            Pdfium::bind_to_system_library()
                .map_err(|error| CoreError::Library(error.to_string()))?
        };
        unsafe { lib.FPDF_InitLibrary() };
        Ok(Core {
            lib: LIB.get_or_init(|| lib).as_ref(),
        })
    }

    /// Parses `bytes`, which the document keeps for as long as it is open.
    pub fn open(&self, bytes: Vec<u8>, password: Option<&str>) -> Result<Document, CoreError> {
        let _guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
        let handle = unsafe { self.lib.FPDF_LoadMemDocument64(&bytes, password) };
        if handle.is_null() {
            // c_ulong is u64 here but u32 on Windows.
            #[allow(clippy::useless_conversion)]
            let code = u64::from(unsafe { self.lib.FPDF_GetLastError() });
            return Err(match code {
                FPDF_ERR_PASSWORD => CoreError::Password,
                FPDF_ERR_SECURITY => CoreError::Pdfium("unsupported security handler".into()),
                FPDF_ERR_FILE | FPDF_ERR_FORMAT => {
                    CoreError::Damaged(format!("PDFium error {code}"))
                }
                _ => CoreError::Damaged(format!("PDFium error {code}")),
            });
        }
        // Forms draw through their own environment (FPDF_FFLDraw), which
        // also builds appearances for fields that lack them. PDFium keeps a
        // pointer to the info block, so it lives as long as the document.
        // An encrypted file's key, unlocked now so the password goes no
        // further than this call. A handler the re-encryption cannot
        // reproduce still opens; the export is refused instead.
        let encryption = (unsafe { self.lib.FPDF_GetSecurityHandlerRevision(handle) } != -1)
            .then(|| SourceEncryption::from_source(&bytes, password.unwrap_or("")));
        let mut form_info: Box<FPDF_FORMFILLINFO> = Box::new(unsafe { std::mem::zeroed() });
        form_info.version = 1;
        let form = unsafe {
            self.lib
                .FPDFDOC_InitFormFillEnvironment(handle, form_info.as_mut())
        };
        Ok(Document {
            lib: self.lib,
            handle,
            form,
            _form_info: form_info,
            _bytes: bytes,
            encryption,
        })
    }
}

/// An open PDF. Dropping it closes the document.
pub struct Document {
    lib: &'static Lib,
    handle: FPDF_DOCUMENT,
    /// Null when PDFium could not set one up; pages then draw without forms.
    form: FPDF_FORMHANDLE,
    _form_info: Box<FPDF_FORMFILLINFO>,
    /// PDFium reads from this buffer for the document's whole life.
    _bytes: Vec<u8>,
    /// For an encrypted file, its handler unlocked, or why it cannot be reproduced.
    encryption: Option<Result<SourceEncryption, EncryptionError>>,
}

/// What a document's encryption allows, as PDFium reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Security {
    /// The Standard handler's /R; None for an unencrypted file.
    pub revision: Option<i32>,
    /// FPDF_GetDocPermissions: every bit set when the owner password
    /// opened the file (or it is unencrypted), /P otherwise.
    pub permissions: u32,
    /// FPDF_GetDocUserPermissions: /P whichever password opened the file.
    pub user_permissions: u32,
}

/// The document information PDF readers show, as pdf.js's `documentInfo`
/// names it: the trailer's /Info strings as the file writes them (dates
/// unparsed, XMP never consulted), the header version, the catalog's /Lang
/// and the encryption handler. A field is None when the file has no value
/// for it or an empty one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Metadata {
    pub title: Option<String>,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub keywords: Option<String>,
    pub creator: Option<String>,
    pub producer: Option<String>,
    pub creation_date: Option<String>,
    pub mod_date: Option<String>,
    /// "1.7": the catalog's /Version when it has one, else the header's.
    pub pdf_format_version: Option<String>,
    pub language: Option<String>,
    /// "Standard" for an encrypted file: the only handler PDFium opens
    /// (any other fails to open with FPDF_ERR_SECURITY).
    pub encrypt_filter_name: Option<&'static str>,
}

// A document may move to another thread, but only the thread that owns it
// calls into it. pdfium-render's thread-safe table locks each FFI call, so
// calls never overlap, but it orders nothing across the several calls one
// read takes (load page, load text page, walk, close); PDFium documents no
// guarantee for a document shared between threads, so it is not Sync. The
// desktop app gives each document to its one render thread.
unsafe impl Send for Document {}

impl Drop for Document {
    fn drop(&mut self) {
        unsafe {
            if !self.form.is_null() {
                self.lib.FPDFDOC_ExitFormFillEnvironment(self.form);
            }
            self.lib.FPDF_CloseDocument(self.handle);
        }
    }
}

struct Page<'a> {
    lib: &'a Lib,
    handle: FPDF_PAGE,
}

impl Drop for Page<'_> {
    fn drop(&mut self) {
        unsafe { self.lib.FPDF_ClosePage(self.handle) };
    }
}

struct TextPage<'a> {
    lib: &'a Lib,
    handle: FPDF_TEXTPAGE,
}

impl Drop for TextPage<'_> {
    fn drop(&mut self) {
        unsafe { self.lib.FPDFText_ClosePage(self.handle) };
    }
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

/// The descriptor flags PDF 32000 table 123 defines. PDFium ORs its own
/// bookkeeping bits into what it reports (0x80000 for a font it read a
/// descriptor from), which no reader should mistake for a style.
const PDF_FONT_FLAGS: i32 = 0b111_0000_0000_0110_1111;

/// What a glyph's font contributes, read once per font per page.
#[derive(Clone, Default)]
struct FontInfo {
    name: String,
    flags: i32,
    /// Ascent and descent per unit of font size.
    ascent: f32,
    descent: f32,
}

impl Document {
    pub fn page_count(&self) -> u32 {
        let count = unsafe { self.lib.FPDF_GetPageCount(self.handle) };
        u32::try_from(count).unwrap_or(0)
    }

    fn page(&self, index: u32) -> Result<Page<'_>, CoreError> {
        let count = self.page_count();
        if index >= count {
            return Err(CoreError::PageOutOfRange { index, count });
        }
        let handle = unsafe { self.lib.FPDF_LoadPage(self.handle, index as c_int) };
        if handle.is_null() {
            return Err(CoreError::Pdfium(format!("could not load page {index}")));
        }
        Ok(Page {
            lib: self.lib,
            handle,
        })
    }

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

    /// Hides the annotations Shiori draws itself, so the page raster shows
    /// every other annotation exactly once. Changes this open copy only.
    /// Returns how many annotations it hid.
    pub fn hide_annotations(&self, index: u32, keys: &[AnnotationKey]) -> Result<u32, CoreError> {
        if keys.is_empty() {
            return Ok(0);
        }
        let page = self.page(index)?;
        let lib = self.lib;
        let mut hidden = 0;
        unsafe {
            for i in 0..lib.FPDFPage_GetAnnotCount(page.handle) {
                let annot = lib.FPDFPage_GetAnnot(page.handle, i);
                if annot.is_null() {
                    continue;
                }
                let subtype = subtype_name(lib.FPDFAnnot_GetSubtype(annot));
                let mut r = FS_RECTF {
                    left: 0.0,
                    top: 0.0,
                    right: 0.0,
                    bottom: 0.0,
                };
                let has_rect = lib.FPDFAnnot_GetRect(annot, &mut r) != 0;
                let rect = normalized(r.left, r.bottom, r.right, r.top);
                let wanted = has_rect
                    && keys.iter().any(|key| {
                        Some(key.subtype.as_str()) == subtype && same_rect(key.rect, rect)
                    });
                if wanted {
                    let flags = lib.FPDFAnnot_GetFlags(annot);
                    if lib.FPDFAnnot_SetFlags(annot, flags | FPDF_ANNOT_FLAG_HIDDEN) != 0 {
                        hidden += 1;
                    }
                }
                lib.FPDFPage_CloseAnnot(annot);
            }
        }
        Ok(hidden)
    }

    /// The document outline (bookmarks), in order. A malformed outline that
    /// loops back on itself is cut where it repeats.
    /// What the document's encryption allows. Native only: pdfium-render's
    /// wasm bridge reads PDFium's unsigned results as signed and saturates
    /// 0xFFFFFFFF to 0, so the web worker asks PDFium's module directly
    /// (src/pdf/engine/wasm/loadCore.ts).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn security(&self) -> Security {
        let lib = self.lib;
        let revision = unsafe { lib.FPDF_GetSecurityHandlerRevision(self.handle) };
        // c_ulong is u64 here but u32 on Windows; the values are 32-bit.
        #[allow(clippy::useless_conversion)]
        let (permissions, user_permissions) = unsafe {
            (
                u64::from(lib.FPDF_GetDocPermissions(self.handle)) as u32,
                u64::from(lib.FPDF_GetDocUserPermissions(self.handle)) as u32,
            )
        };
        Security {
            revision: (revision != -1).then_some(revision),
            permissions,
            user_permissions,
        }
    }

    /// `plain`, an unencrypted export of this document, encrypted the way
    /// this document is: its /Encrypt dictionary and /ID[0], its key, so its
    /// own user and owner passwords open the result (src/encryption.rs).
    pub fn encrypt_like_source(&self, plain: &[u8]) -> Result<Vec<u8>, CoreError> {
        match &self.encryption {
            Some(Ok(handler)) => handler.encrypt_file(plain).map_err(CoreError::Encryption),
            Some(Err(error)) => Err(CoreError::Encryption(error.clone())),
            None => Err(CoreError::Encryption(EncryptionError::Unreadable(
                "the source is not encrypted",
            ))),
        }
    }

    /// The document rewritten without its encryption: every string and
    /// stream in the clear, the same objects under the same numbers. What
    /// pdf-lib cannot decrypt (it reads a file's annotations for import),
    /// PDFium hands over this way. For an unencrypted document it is a full
    /// rewrite of the same content. Native only: pdfium-render's wasm bridge
    /// accepts only its own file writer, so the web worker saves through
    /// PDFium's module directly (src/pdf/engine/wasm/coreWorker.ts).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn decrypted_copy(&self) -> Result<Vec<u8>, CoreError> {
        use pdfium_render::prelude::FPDF_FILEWRITE;

        #[repr(C)]
        struct Writer {
            // First, so PDFium's pointer to it is a pointer to the Writer.
            file_write: FPDF_FILEWRITE,
            bytes: Vec<u8>,
        }
        unsafe extern "C" fn write_block(
            this: *mut FPDF_FILEWRITE,
            data: *const c_void,
            size: c_ulong,
        ) -> c_int {
            let writer = &mut *(this as *mut Writer);
            writer
                .bytes
                .extend_from_slice(std::slice::from_raw_parts(data as *const u8, size as usize));
            1
        }
        // FPDF_NO_INCREMENTAL | FPDF_REMOVE_SECURITY (fpdf_save.h, 7881).
        const FLAGS: u32 = (1 << 1) | (1 << 2);
        let mut writer = Box::new(Writer {
            file_write: FPDF_FILEWRITE {
                version: 1,
                WriteBlock: Some(write_block),
            },
            bytes: Vec::new(),
        });
        let saved = unsafe {
            self.lib
                .FPDF_SaveAsCopy(self.handle, &mut writer.file_write, FLAGS as _)
        };
        if saved == 0 {
            return Err(CoreError::Pdfium("could not rewrite the document".into()));
        }
        Ok(writer.bytes)
    }

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
                        if font.is_null()
                            || !seen.insert(font as usize)
                            || lib.FPDFFont_GetIsEmbedded(font) != 1
                        {
                            continue;
                        }
                        let mut size = 0;
                        lib.FPDFFont_GetFontData(font, std::ptr::null_mut(), 0, &mut size);
                        if size == 0 {
                            continue;
                        }
                        let mut data = vec![0u8; size];
                        if lib.FPDFFont_GetFontData(font, data.as_mut_ptr(), size, &mut size) == 0 {
                            continue;
                        }
                        data.truncate(size);
                        let len = lib.FPDFFont_GetBaseFontName(font, std::ptr::null_mut(), 0);
                        let mut name = vec![0u8; len];
                        if len > 0 {
                            lib.FPDFFont_GetBaseFontName(font, name.as_mut_ptr().cast(), len);
                        }
                        fonts.push(EmbeddedFont {
                            name: String::from_utf8_lossy(&name)
                                .trim_end_matches('\0')
                                .to_string(),
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
    /// this page sets in each (see `FontOutlines`). A font FreeType could not
    /// load is drawn with a substitute and is left out, as in `embedded_fonts`.
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
                        flags: lib.FPDFFont_GetFlags(font) & PDF_FONT_FLAGS,
                        ascent,
                        descent,
                        glyphs,
                    }
                })
                .collect())
        }
    }

    /// PDFium's handle for this document, an address in PDFium's own wasm
    /// memory: the web worker saves through PDFium's module directly (see
    /// `decrypted_copy`).
    #[cfg(target_arch = "wasm32")]
    pub fn pdfium_handle(&self) -> usize {
        self.handle as usize
    }

    /// The document information: /Info strings, header version, /Lang and
    /// encryption handler (see [`Metadata`]).
    pub fn metadata(&self) -> Metadata {
        let version = {
            let mut version: c_int = 0;
            let ok = unsafe { self.lib.FPDF_GetFileVersion(self.handle, &mut version) };
            (ok != 0 && version > 0).then(|| format!("{}.{}", version / 10, version % 10))
        };
        Metadata {
            title: self.meta_text("Title"),
            author: self.meta_text("Author"),
            subject: self.meta_text("Subject"),
            keywords: self.meta_text("Keywords"),
            creator: self.meta_text("Creator"),
            producer: self.meta_text("Producer"),
            creation_date: self.meta_text("CreationDate"),
            mod_date: self.meta_text("ModDate"),
            pdf_format_version: version,
            language: self.language(),
            encrypt_filter_name: self.encryption.is_some().then_some("Standard"),
        }
    }

    /// One /Info entry as text (PDFium decodes PDFDocEncoding and UTF-16),
    /// None when /Info lacks it or holds an empty string.
    fn meta_text(&self, key: &str) -> Option<String> {
        let lib = self.lib;
        // Bytes of UTF-16LE with a two-byte terminator; 0 without /Info.
        let len = unsafe { lib.FPDF_GetMetaText(self.handle, key, std::ptr::null_mut(), 0) };
        if len <= 2 {
            return None;
        }
        let mut buffer = vec![0u8; len as usize];
        unsafe { lib.FPDF_GetMetaText(self.handle, key, buffer.as_mut_ptr().cast(), len) };
        Some(utf16le(&buffer)).filter(|text| !text.is_empty())
    }

    /// The document's natural language, the catalog's /Lang (a BCP 47 tag
    /// such as "ja"), when it gives one.
    pub fn language(&self) -> Option<String> {
        let lib = self.lib;
        let len = unsafe { lib.FPDFCatalog_GetLanguage(self.handle, std::ptr::null_mut(), 0) };
        if len <= 2 {
            return None;
        }
        let mut buffer = vec![0u16; (len as usize).div_ceil(2)];
        unsafe { lib.FPDFCatalog_GetLanguage(self.handle, buffer.as_mut_ptr(), len) };
        let bytes: Vec<u8> = buffer.iter().flat_map(|unit| unit.to_le_bytes()).collect();
        Some(utf16le(&bytes)).filter(|lang| !lang.trim().is_empty())
    }

    pub fn outline(&self) -> Vec<OutlineItem> {
        let mut seen = std::collections::HashSet::new();
        self.outline_level(std::ptr::null_mut(), 0, &mut seen)
    }

    fn outline_level(
        &self,
        parent: FPDF_BOOKMARK,
        depth: usize,
        seen: &mut std::collections::HashSet<usize>,
    ) -> Vec<OutlineItem> {
        let lib = self.lib;
        let mut items = Vec::new();
        if depth > 64 {
            return items;
        }
        let mut bookmark = unsafe { lib.FPDFBookmark_GetFirstChild(self.handle, parent) };
        while !bookmark.is_null()
            && seen.len() < MAX_OUTLINE_ITEMS
            && seen.insert(bookmark as usize)
        {
            let title = unsafe {
                let len = lib.FPDFBookmark_GetTitle(bookmark, std::ptr::null_mut(), 0);
                let mut buffer = vec![0u8; len as usize];
                lib.FPDFBookmark_GetTitle(bookmark, buffer.as_mut_ptr().cast(), len);
                utf16le(&buffer)
            };
            let destination = unsafe {
                let dest = lib.FPDFBookmark_GetDest(self.handle, bookmark);
                if dest.is_null() {
                    let action = lib.FPDFBookmark_GetAction(bookmark);
                    if action.is_null() {
                        None
                    } else {
                        self.destination(lib.FPDFAction_GetDest(self.handle, action))
                    }
                } else {
                    self.destination(dest)
                }
            };
            let children = self.outline_level(bookmark, depth + 1, seen);
            items.push(OutlineItem {
                title,
                destination,
                children,
            });
            bookmark = unsafe { lib.FPDFBookmark_GetNextSibling(self.handle, bookmark) };
        }
        items
    }

    fn destination(&self, dest: FPDF_DEST) -> Option<Destination> {
        if dest.is_null() {
            return None;
        }
        let lib = self.lib;
        unsafe {
            let page = lib.FPDFDest_GetDestPageIndex(self.handle, dest);
            let page_index = u32::try_from(page).ok()?;
            let mut count = 0;
            let mut params = [0f32; 4];
            let view = lib.FPDFDest_GetView(dest, &mut count, params.as_mut_ptr());
            let view = match view {
                1 => "XYZ",
                2 => "Fit",
                3 => "FitH",
                4 => "FitV",
                5 => "FitR",
                6 => "FitB",
                7 => "FitBH",
                8 => "FitBV",
                // An unknown fit keeps the reader's view: XYZ with no operands.
                _ => {
                    return Some(Destination {
                        page_index,
                        view: "XYZ",
                        args: vec![],
                    })
                }
            };
            let args = if view == "XYZ" {
                // Nulls matter here ("keep the current value"); GetView
                // reports them as zeros.
                let (mut has_x, mut has_y, mut has_zoom) = (0, 0, 0);
                let (mut x, mut y, mut zoom) = (0f32, 0f32, 0f32);
                lib.FPDFDest_GetLocationInPage(
                    dest,
                    &mut has_x,
                    &mut has_y,
                    &mut has_zoom,
                    &mut x,
                    &mut y,
                    &mut zoom,
                );
                vec![
                    (has_x != 0).then_some(x),
                    (has_y != 0).then_some(y),
                    (has_zoom != 0).then_some(zoom),
                ]
            } else {
                params[..(count as usize).min(4)]
                    .iter()
                    .copied()
                    .map(Some)
                    .collect()
            };
            Some(Destination {
                page_index,
                view,
                args,
            })
        }
    }

    /// The page's link annotations that go somewhere: a page of this
    /// document or a URL. Links to other files and launches are left out.
    pub fn links(&self, index: u32) -> Result<Vec<Link>, CoreError> {
        let page = self.page(index)?;
        let lib = self.lib;
        let mut links = Vec::new();
        let mut position = 0;
        let mut link: FPDF_LINK = std::ptr::null_mut();
        unsafe {
            while lib.FPDFLink_Enumerate(page.handle, &mut position, &mut link) != 0 {
                let mut r = FS_RECTF {
                    left: 0.0,
                    top: 0.0,
                    right: 0.0,
                    bottom: 0.0,
                };
                if lib.FPDFLink_GetAnnotRect(link, &mut r) == 0 {
                    continue;
                }
                let rect = normalized(r.left, r.bottom, r.right, r.top);
                let target = match self.destination(lib.FPDFLink_GetDest(self.handle, link)) {
                    Some(destination) => Some(LinkTarget::Destination(destination)),
                    None => {
                        let action = lib.FPDFLink_GetAction(link);
                        if action.is_null() {
                            None
                        } else {
                            match lib.FPDFAction_GetType(action) {
                                // PDFACTION_GOTO
                                1 => self
                                    .destination(lib.FPDFAction_GetDest(self.handle, action))
                                    .map(LinkTarget::Destination),
                                // PDFACTION_URI: 7-bit ASCII, NUL-terminated.
                                3 => {
                                    let len = lib.FPDFAction_GetURIPath(
                                        self.handle,
                                        action,
                                        std::ptr::null_mut(),
                                        0,
                                    );
                                    let mut buffer = vec![0u8; len as usize];
                                    lib.FPDFAction_GetURIPath(
                                        self.handle,
                                        action,
                                        buffer.as_mut_ptr().cast(),
                                        len,
                                    );
                                    let url = uri_text(&buffer);
                                    (!url.is_empty()).then_some(LinkTarget::Url(url))
                                }
                                _ => None,
                            }
                        }
                    }
                };
                if let Some(target) = target {
                    links.push(Link { rect, target });
                }
            }
        }
        Ok(links)
    }

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

/// fpdf_annot.h subtype numbers, named as the PDF (and pdf.js) names them.
fn subtype_name(code: i32) -> Option<&'static str> {
    Some(match code {
        1 => "Text",
        2 => "Link",
        3 => "FreeText",
        4 => "Line",
        5 => "Square",
        6 => "Circle",
        7 => "Polygon",
        8 => "PolyLine",
        9 => "Highlight",
        10 => "Underline",
        11 => "Squiggly",
        12 => "StrikeOut",
        13 => "Stamp",
        14 => "Caret",
        15 => "Ink",
        16 => "Popup",
        17 => "FileAttachment",
        18 => "Sound",
        19 => "Movie",
        20 => "Widget",
        21 => "Screen",
        22 => "PrinterMark",
        23 => "TrapNet",
        24 => "Watermark",
        25 => "3D",
        26 => "RichMedia",
        27 => "XFAWidget",
        28 => "Redact",
        _ => return None,
    })
}

/// Rects read back from a file as floats: equal within a hundredth of a point.
fn same_rect(a: Rect, b: Rect) -> bool {
    const SLACK: f32 = 0.01;
    (a.left - b.left).abs() <= SLACK
        && (a.bottom - b.bottom).abs() <= SLACK
        && (a.right - b.right).abs() <= SLACK
        && (a.top - b.top).abs() <= SLACK
}

fn same_point(a: (f32, f32), b: (f32, f32)) -> bool {
    (a.0 - b.0).abs() <= SAME_POINT_PT && (a.1 - b.1).abs() <= SAME_POINT_PT
}

fn normalized(left: f32, bottom: f32, right: f32, top: f32) -> Rect {
    Rect {
        left: left.min(right),
        bottom: bottom.min(top),
        right: left.max(right),
        top: bottom.max(top),
    }
}

/// A URI action's bytes: 7-bit ASCII by the spec, but some writers store a
/// UTF-16BE text string with its byte-order mark.
fn uri_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_suffix(&[0]).unwrap_or(bytes);
    if let Some(utf16) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let units: Vec<u16> = utf16
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_be_bytes(*pair))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes)
        .trim_end_matches('\0')
        .to_string()
}

/// PDFium's UTF-16LE strings, sized by the byte count PDFium returns and
/// ending in one NUL terminator. Only that terminator goes: a NUL inside the
/// string is part of it.
fn utf16le(bytes: &[u8]) -> String {
    let mut units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    if units.last() == Some(&0) {
        units.pop();
    }
    String::from_utf16_lossy(&units)
}

fn decode(units: impl Iterator<Item = u32>) -> String {
    let units: Vec<u32> = units.collect();
    let mut out = String::new();
    let mut i = 0;
    while i < units.len() {
        let unit = units[i];
        if (0xD800..0xDC00).contains(&unit) {
            if let Some(&low) = units.get(i + 1) {
                if (0xDC00..0xE000).contains(&low) {
                    out.extend(char::from_u32(
                        0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00),
                    ));
                    i += 2;
                    continue;
                }
            }
        }
        out.push(char::from_u32(unit).unwrap_or(char::REPLACEMENT_CHARACTER));
        i += 1;
    }
    out
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
