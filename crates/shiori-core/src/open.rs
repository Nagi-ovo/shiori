//! Binding PDFium once per process and opening documents with it.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use pdfium_render::prelude::{Pdfium, FPDF_DOCUMENT, FPDF_FORMFILLINFO};

use crate::encryption::SourceEncryption;
use crate::{CoreError, Document, Lib};

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

/// A PDF with no pages.
const BLANK: &[u8] = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n\
2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\nxref\n0 3\n0000000000 65535 f \n\
0000000009 00000 n \n0000000058 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\n\
startxref\n110\n%%EOF\n";

/// Runs `read` on an empty document of its own, closed afterwards; None when
/// PDFium cannot load one. Loaded, not FPDF_CreateNewDocument: on wasm32
/// pdfium-render frees `document_ptr_{handle}` on every close and never drops
/// the key, so a new document at a closed one's address would free that
/// buffer twice, while a load writes the key afresh.
pub(crate) fn with_blank_document<T>(
    lib: &Lib,
    read: impl FnOnce(FPDF_DOCUMENT) -> T,
) -> Option<T> {
    let handle = {
        let _guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
        unsafe { lib.FPDF_LoadMemDocument64(BLANK, None) }
    };
    if handle.is_null() {
        #[cfg(target_arch = "wasm32")]
        unsafe {
            lib.FPDF_CloseDocument(handle)
        };
        return None;
    }
    let value = read(handle);
    unsafe { lib.FPDF_CloseDocument(handle) };
    Some(value)
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
        // PDFium takes the password as a C string, which cannot hold a NUL:
        // pdfium-render's native bindings panic on one (an abort in a release
        // build), and a prefix of what was typed must not open the file.
        if password.is_some_and(|password| password.contains('\0')) {
            return Err(CoreError::Password);
        }
        let _guard = OPEN.lock().unwrap_or_else(|poison| poison.into_inner());
        let handle = unsafe { self.lib.FPDF_LoadMemDocument64(&bytes, password) };
        if handle.is_null() {
            // c_ulong is u64 here but u32 on Windows.
            #[allow(clippy::useless_conversion)]
            let code = u64::from(unsafe { self.lib.FPDF_GetLastError() });
            // pdfium-render's wasm bridge copied the file into PDFium's heap
            // for this load and frees that copy only in FPDF_CloseDocument,
            // which PDFium lets take a null document.
            #[cfg(target_arch = "wasm32")]
            unsafe {
                self.lib.FPDF_CloseDocument(handle)
            };
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
            fonts: Default::default(),
        })
    }
}
