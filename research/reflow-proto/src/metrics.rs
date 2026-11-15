use harfrust::{Buffer, Font, ShapeOptions, ShaperFont};
use serde_json::Value;
use std::{collections::HashMap, fs};
use ttf_parser::Face;

pub fn num(v: &Value, key: &str) -> f64 {
    v[key].as_f64().unwrap_or(0.)
}

#[derive(Clone)]
pub struct Token {
    pub text: String,
    pub advance: f64,
    pub gap: f64,
    pub source: Option<usize>,
    pub font: String,
    pub gid: Option<u16>,
    pub ink: [f64; 4], // relative to origin
    pub pdf_error: Option<f64>,
    pub raw_error: Option<f64>,
    pub fallback: bool,
}

pub struct Fonts {
    pub data: HashMap<String, Vec<u8>>,
    pub fallback: Vec<u8>,
}

impl Fonts {
    pub fn load(sample: &Value, chinese: bool) -> Result<Self, Box<dyn std::error::Error>> {
        let mut data = HashMap::new();
        for (key, font) in sample["fonts"].as_object().unwrap() {
            if let Some(path) = font["programPath"].as_str() {
                data.insert(key.clone(), fs::read(path)?);
            }
        }
        let path = if chinese {
            "../../src/assets/fonts/NotoSansSC-Regular.otf".to_owned()
        } else {
            std::env::var("LIBERATION_TTF").unwrap_or_else(|_| {
                "../../../pdf-inplace-ui/node_modules/@docx-editor.dev/fonts/assets/LiberationSerif-Regular.ttf".into()
            })
        };
        Ok(Self {
            data,
            fallback: fs::read(path)?,
        })
    }

    pub fn source(&self, raw: &Value, index: usize) -> Token {
        let name = raw["font"].as_str().unwrap().to_string();
        let gid = raw["gid"].as_u64().map(|g| g as u16);
        let inferred = raw["source"].is_null();
        let x = num(raw, "x");
        let y = num(raw, "y");
        let mut ink = [0.; 4];
        for (i, val) in ink.iter_mut().enumerate() {
            *val = raw["ink"][i].as_f64().unwrap() - if i % 2 == 0 { x } else { y };
        }
        let advance = if inferred {
            num(raw, "advance")
        } else {
            let word = if raw["wordSpaced"].as_bool().unwrap_or(false) {
                num(raw, "tw")
            } else {
                0.
            };
            (num(raw, "width1000") / 1000. * num(raw, "sizeText") + num(raw, "tc") + word)
                * num(raw, "xScale")
        };
        let raw_error = self
            .data
            .get(&name)
            .and_then(|data| Face::parse(data, 0).ok())
            .and_then(|face| {
                gid.and_then(|g| face.glyph_hor_advance(ttf_parser::GlyphId(g)))
                    .map(|w| {
                        (f64::from(w) / f64::from(face.units_per_em()) * num(raw, "emX")
                            - num(raw, "width1000") / 1000. * num(raw, "emX"))
                        .abs()
                    })
            });
        Token {
            text: raw["text"].as_str().unwrap().into(),
            advance,
            gap: num(raw, "gap_after"),
            source: if inferred { None } else { Some(index) },
            font: name,
            gid,
            ink,
            pdf_error: if inferred {
                None
            } else {
                Some((advance - num(raw, "advance")).abs())
            },
            raw_error,
            fallback: false,
        }
    }

    pub fn replacement(&self, text: &str, style: &Value, sample: &Value) -> Result<Token, String> {
        let name = style["font"].as_str().unwrap();
        let payload = &sample["fonts"][name];
        let mapping = &payload["mapping"][text];
        let known_gid = mapping["gid"].as_u64();
        let embedded = self
            .data
            .get(name)
            .and_then(|data| Face::parse(data, 0).ok());
        let source_ok = payload["verified"] == "verified"
            && mapping["eligible"] == true
            && known_gid.is_some()
            && embedded.is_some();
        let (face, fallback) = if source_ok {
            (embedded.unwrap(), false)
        } else {
            (
                Face::parse(&self.fallback, 0).map_err(|_| "fallback font cannot be parsed")?,
                true,
            )
        };
        // A PDF subset may have no useful Unicode cmap. Its verified code→GID
        // mapping takes precedence over reshaping Unicode through that subset.
        let (gid, shaped_advance) = if !fallback {
            let gid = known_gid.unwrap() as u16;
            (
                gid,
                i32::from(
                    face.glyph_hor_advance(ttf_parser::GlyphId(gid))
                        .ok_or("missing GID advance")?,
                ),
            )
        } else {
            let font = Font::new(self.fallback.clone(), 0).ok_or("HarfRust font load failed")?;
            let shaper = ShaperFont::new(&font);
            let mut buffer = Buffer::new();
            buffer.push_str(text);
            buffer.guess_segment_properties();
            let features = ["kern=0", "liga=0", "clig=0"].map(|s| s.parse().unwrap());
            harfrust::shape(
                &shaper,
                &mut buffer,
                ShapeOptions::new().features(&features),
            )
            .map_err(|e| format!("HarfRust shaping: {e:?}"))?;
            if buffer.len() != 1 || buffer.glyph_infos()[0].glyph_id == 0 {
                return Err(format!("unsupported shaping/coverage: {text:?}"));
            }
            let pos = buffer.glyph_positions()[0];
            if pos.x_offset != 0 || pos.y_offset != 0 || pos.y_advance != 0 {
                return Err(format!("unsupported shaping offsets: {text:?}"));
            }
            (buffer.glyph_infos()[0].glyph_id as u16, pos.x_advance)
        };
        let x_em = num(style, "emX");
        let units = f64::from(face.units_per_em());
        let advance = if fallback {
            f64::from(shaped_advance) / units * x_em
        } else {
            num(mapping, "width1000") / 1000. * x_em
        };
        let b = face.glyph_bounding_box(ttf_parser::GlyphId(gid));
        let ink = b
            .map(|b| {
                [
                    f64::from(b.x_min) / units * x_em,
                    f64::from(b.y_min) / units * num(style, "size"),
                    f64::from(b.x_max) / units * x_em,
                    f64::from(b.y_max) / units * num(style, "size"),
                ]
            })
            .unwrap_or([0.; 4]);
        Ok(Token {
            text: text.into(),
            advance,
            gap: 0.,
            source: None,
            font: if fallback {
                "fallback".into()
            } else {
                name.into()
            },
            gid: Some(gid),
            ink,
            pdf_error: None,
            raw_error: None,
            fallback,
        })
    }
}
