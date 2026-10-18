//! shiori-core in a web worker. The host loads PDFium's Emscripten build,
//! hands it over with `initialize_pdfium_render` (pdfium-render's export),
//! then opens documents here. Results cross as JSON in the shapes the
//! desktop IPC uses (src/platform/bindings.ts), pixels as RGBA bytes.
use std::path::Path;

use serde::Serialize;
use shiori_core::{AnnotationKey, Core, CoreError, Destination, LinkTarget, OutlineItem, Rect};
use wasm_bindgen::prelude::*;

fn js_error(error: CoreError) -> JsValue {
    JsValue::from_str(&error.to_string())
}

fn json<T: Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(|error| JsValue::from_str(&error.to_string()))
}

fn core() -> Result<Core, JsValue> {
    Core::bind(Path::new("")).map_err(js_error)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Geometry {
    rotation: u16,
    origin_x: f32,
    origin_y: f32,
    width: f32,
    height: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Glyph {
    text: String,
    origin: [f32; 2],
    end: [f32; 2],
    font_size: f32,
    angle: f32,
    generated: bool,
    font_name: String,
    font_flags: i32,
    ascent: f32,
    descent: f32,
}

#[derive(Serialize)]
struct PageText {
    glyphs: Vec<Glyph>,
    lang: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Dest {
    page_index: u32,
    view: &'static str,
    args: Vec<Option<f32>>,
}

#[derive(Serialize)]
struct Outline {
    title: String,
    destination: Option<Dest>,
    children: Vec<Outline>,
}

#[derive(Serialize)]
struct Link {
    rect: [f32; 4],
    destination: Option<Dest>,
    url: Option<String>,
}

#[derive(serde::Deserialize)]
struct HideKey {
    subtype: String,
    rect: [f32; 4],
}

fn dest(destination: Destination) -> Dest {
    Dest {
        page_index: destination.page_index,
        view: destination.view,
        args: destination.args,
    }
}

fn outline(items: Vec<OutlineItem>) -> Vec<Outline> {
    items
        .into_iter()
        .map(|item| Outline {
            title: item.title,
            destination: item.destination.map(dest),
            children: outline(item.children),
        })
        .collect()
}

/// Checks that PDFium was handed over and initialises it; open calls it too.
#[wasm_bindgen(js_name = bindPdfium)]
pub fn bind_pdfium() -> Result<(), JsValue> {
    core().map(|_| ())
}

#[wasm_bindgen]
pub struct CoreDocument {
    inner: shiori_core::Document,
}

#[wasm_bindgen]
impl CoreDocument {
    /// Parses a copy of `bytes`. Errors carry CoreError's wording.
    pub fn open(bytes: Vec<u8>, password: Option<String>) -> Result<CoreDocument, JsValue> {
        let inner = core()?.open(bytes, password.as_deref()).map_err(js_error)?;
        Ok(CoreDocument { inner })
    }

    #[wasm_bindgen(js_name = pageCount)]
    pub fn page_count(&self) -> u32 {
        self.inner.page_count()
    }

    /// JSON `{ rotation, originX, originY, width, height }`.
    #[wasm_bindgen(js_name = pageGeometry)]
    pub fn page_geometry(&self, index: u32) -> Result<String, JsValue> {
        let g = self.inner.page_geometry(index).map_err(js_error)?;
        json(&Geometry {
            rotation: g.rotation,
            origin_x: g.origin_x,
            origin_y: g.origin_y,
            width: g.width,
            height: g.height,
        })
    }

    /// JSON `{ glyphs, lang }`, as `pdf_core_page_text` returns it.
    #[wasm_bindgen(js_name = pageText)]
    pub fn page_text(&self, index: u32) -> Result<String, JsValue> {
        let chars = self.inner.chars(index).map_err(js_error)?;
        json(&PageText {
            glyphs: chars
                .into_iter()
                .map(|ch| Glyph {
                    text: ch.text,
                    origin: [ch.origin.0, ch.origin.1],
                    end: [ch.end.0, ch.end.1],
                    font_size: ch.font_size,
                    angle: ch.angle,
                    generated: ch.generated,
                    font_name: ch.font_name,
                    font_flags: ch.font_flags,
                    ascent: ch.ascent,
                    descent: ch.descent,
                })
                .collect(),
            lang: self.inner.language(),
        })
    }

    /// RGBA rows of a region, `width × height × 4` bytes.
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &self,
        index: u32,
        rotation: u16,
        pixels_per_point: f32,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        annotations: bool,
    ) -> Result<Vec<u8>, JsValue> {
        self.inner
            .render(
                index,
                shiori_core::RenderRequest {
                    rotation,
                    pixels_per_point,
                    x,
                    y,
                    width,
                    height,
                    annotations,
                },
            )
            .map_err(js_error)
    }

    /// PDFium's handle for the document, for saves the host makes through
    /// PDFium's module (pdfium-render's wasm bridge takes only its own writer).
    #[wasm_bindgen(js_name = pdfiumHandle)]
    pub fn pdfium_handle(&self) -> usize {
        self.inner.pdfium_handle()
    }

    /// `plain`, an unencrypted export, encrypted as this document is: its
    /// /Encrypt, /ID[0] and key (shiori_core::encryption). What the
    /// encryption permits is read through PDFium's module instead
    /// (src/pdf/engine/wasm/loadCore.ts).
    #[wasm_bindgen(js_name = encryptLikeSource)]
    pub fn encrypt_like_source(&self, plain: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.inner.encrypt_like_source(plain).map_err(js_error)
    }

    /// The embedded fonts a page draws with, packed by `encode_embedded_fonts`.
    #[wasm_bindgen(js_name = embeddedFonts)]
    pub fn embedded_fonts(&self, index: u32) -> Result<Vec<u8>, JsValue> {
        let fonts = self.inner.embedded_fonts(index).map_err(js_error)?;
        Ok(shiori_core::encode_embedded_fonts(&fonts))
    }

    /// The named embedded fonts rebuilt from this page's glyphs, as
    /// `encode_font_outlines` JSON; `names` is a JSON array of BaseFont names.
    #[wasm_bindgen(js_name = fontOutlines)]
    pub fn font_outlines(&self, index: u32, names: &str) -> Result<Vec<u8>, JsValue> {
        let names: Vec<String> =
            serde_json::from_str(names).map_err(|error| JsValue::from_str(&error.to_string()))?;
        let fonts = self.inner.font_outlines(index, &names).map_err(js_error)?;
        Ok(shiori_core::encode_font_outlines(&fonts))
    }

    /// JSON outline entries, nested.
    pub fn outline(&self) -> Result<String, JsValue> {
        json(&outline(self.inner.outline()))
    }

    /// JSON links of one page.
    pub fn links(&self, index: u32) -> Result<String, JsValue> {
        let links = self.inner.links(index).map_err(js_error)?;
        json(
            &links
                .into_iter()
                .map(|link| {
                    let rect = [
                        link.rect.left,
                        link.rect.bottom,
                        link.rect.right,
                        link.rect.top,
                    ];
                    match link.target {
                        LinkTarget::Url(url) => Link {
                            rect,
                            destination: None,
                            url: Some(url),
                        },
                        LinkTarget::Destination(d) => Link {
                            rect,
                            destination: Some(dest(d)),
                            url: None,
                        },
                    }
                })
                .collect::<Vec<_>>(),
        )
    }

    /// Hides the annotations named in `keys_json` (`[{ subtype, rect }]`).
    #[wasm_bindgen(js_name = hideAnnotations)]
    pub fn hide_annotations(&self, index: u32, keys_json: &str) -> Result<u32, JsValue> {
        let keys: Vec<HideKey> = serde_json::from_str(keys_json)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let keys: Vec<AnnotationKey> = keys
            .into_iter()
            .map(|key| AnnotationKey {
                subtype: key.subtype,
                rect: Rect {
                    left: key.rect[0],
                    bottom: key.rect[1],
                    right: key.rect[2],
                    top: key.rect[3],
                },
            })
            .collect();
        self.inner.hide_annotations(index, &keys).map_err(js_error)
    }
}
