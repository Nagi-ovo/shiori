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
mod fonts;
mod geometry;
mod open;
pub mod pdf_syntax;
mod render;
mod text;
mod xref;

use encryption::{EncryptionError, SourceEncryption};
pub use fonts::{
    encode_embedded_fonts, encode_font_outlines, EmbeddedFont, FontFormat, FontOutlines,
    GlyphOutline,
};
pub use geometry::PageGeometry;
pub use open::Core;
pub use render::{RenderRequest, MAX_RENDER_PIXELS};
pub use text::TextChar;

use std::fmt;
use std::os::raw::c_int;
#[cfg(not(target_arch = "wasm32"))]
use std::os::raw::{c_ulong, c_void};

use pdfium_render::prelude::{
    PdfiumLibraryBindings, FPDF_BOOKMARK, FPDF_DEST, FPDF_DOCUMENT, FPDF_FORMFILLINFO,
    FPDF_FORMHANDLE, FPDF_LINK, FPDF_PAGE, FPDF_TEXTPAGE, FS_RECTF,
};

pub(crate) type Lib = dyn PdfiumLibraryBindings;

// fpdf_annot.h annotation flag.
const FPDF_ANNOT_FLAG_HIDDEN: i32 = 1 << 1;

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

/// The descriptor flags PDF 32000 table 123 defines. PDFium ORs its own
/// bookkeeping bits into what it reports (0x80000 for a font it read a
/// descriptor from), which no reader should mistake for a style.
const PDF_FONT_FLAGS: i32 = 0b111_0000_0000_0110_1111;

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
