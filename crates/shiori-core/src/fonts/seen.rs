//! What a document's fonts are, worked out once per font per document.
//!
//! Reading every code a CID font can set (`reach`) costs a tenth of a
//! second, too much for each of the three reads that ask per page (glyphs,
//! embedded fonts, rebuilt outlines). PDFium 7881 frees a font with the last
//! page that uses it, and a later font can take its address, so a font
//! handle alone is no key. A text object made with the handle holds the
//! font: while the document keeps that object, the font stays loaded and
//! PDFium hands every page that uses its dictionary that same font, at
//! that same address.

use std::collections::HashMap;

use pdfium_render::prelude::{FPDF_FONT, FPDF_PAGEOBJECT};

use super::{font_program, own_cmap, reach, FontFormat};
use crate::{Document, Lib};

/// The fonts one document keeps (see the module docs).
#[derive(Default)]
pub(crate) struct Seen {
    facts: HashMap<usize, Facts>,
    /// One text object per font in `facts`, holding it.
    held: Vec<FPDF_PAGEOBJECT>,
}

/// Fonts a document keeps loaded and remembers; past this many, a font is
/// worked out on each read instead.
const MAX_HELD: usize = 2048;

/// An embedded font's id (`id::font_identity`) and whether a browser may
/// load its program as it is (`EmbeddedFont::own_cmap`).
#[derive(Clone)]
pub(crate) struct Facts {
    pub(crate) id: String,
    pub(crate) own_cmap: bool,
}

impl Seen {
    /// Lets the held fonts go. Runs before the document closes.
    pub(crate) unsafe fn release(&mut self, lib: &Lib) {
        self.facts.clear();
        for object in self.held.drain(..) {
            lib.FPDFPageObj_Destroy(object);
        }
    }
}

impl Document {
    /// The facts of `font`, one of this document's fonts on a page still
    /// open; None for a font the file does not embed.
    pub(crate) unsafe fn font_facts(&self, font: FPDF_FONT) -> Option<Facts> {
        let lib = self.lib;
        let key = font as usize;
        if let Some(facts) = self.fonts.borrow().facts.get(&key) {
            return Some(facts.clone());
        }
        let program = font_program(lib, font)?;
        let reach = reach::reach(lib, self.handle, font);
        // Only a mapping read whole can show the program draws it alike.
        let own_cmap = reach.established
            && matches!(
                FontFormat::of(&program),
                FontFormat::TrueType | FontFormat::OpenType
            )
            && own_cmap::draws_alike(lib, font, &program, &reach.beyond);
        let facts = Facts {
            id: super::font_identity(lib, font, &program, &reach),
            own_cmap,
        };
        let mut seen = self.fonts.borrow_mut();
        if seen.held.len() < MAX_HELD {
            let hold = lib.FPDFPageObj_CreateTextObj(self.handle, font, 1.0);
            if !hold.is_null() && lib.FPDFTextObj_GetFont(hold) == font {
                seen.held.push(hold);
                seen.facts.insert(key, facts.clone());
            } else if !hold.is_null() {
                lib.FPDFPageObj_Destroy(hold);
            }
        }
        Some(facts)
    }
}
