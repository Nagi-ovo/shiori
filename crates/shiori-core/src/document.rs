//! The open document handle and its lifetime.

use pdfium_render::prelude::{FPDF_DOCUMENT, FPDF_FORMFILLINFO, FPDF_FORMHANDLE};

use crate::encryption::{EncryptionError, SourceEncryption};
use crate::Lib;

/// An open PDF. Dropping it closes the document.
pub struct Document {
    pub(crate) lib: &'static Lib,
    pub(crate) handle: FPDF_DOCUMENT,
    /// Null when PDFium could not set one up; pages then draw without forms.
    pub(crate) form: FPDF_FORMHANDLE,
    pub(crate) _form_info: Box<FPDF_FORMFILLINFO>,
    /// PDFium reads from this buffer for the document's whole life.
    pub(crate) _bytes: Vec<u8>,
    /// For an encrypted file, its handler unlocked, or why it cannot be reproduced.
    pub(crate) encryption: Option<Result<SourceEncryption, EncryptionError>>,
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
