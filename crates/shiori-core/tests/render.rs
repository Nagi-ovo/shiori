//! Pixel checks of `Document::render`. Positions are worked out by hand from
//! tests/fixtures/make-fixtures.ts; at one pixel per point a PDF point (x, y)
//! on an upright Letter page lands on pixel (x, 792 − y).

use std::path::PathBuf;

use shiori_core::{AnnotationKey, Core, Rect, RenderRequest};

fn core() -> Core {
    let dir = std::env::var_os("SHIORI_PDFIUM_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let os = match std::env::consts::OS {
                "macos" => "mac",
                "windows" => "win",
                other => other,
            };
            let cpu = match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "x64",
                other => other,
            };
            let lib = if os == "win" { "bin" } else { "lib" };
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../vendor/pdfium")
                .join(format!("{os}-{cpu}"))
                .join(lib)
        });
    Core::bind(&dir).expect("bind PDFium; run `bun scripts/pdfium/fetch.ts`")
}

fn doc() -> shiori_core::Document {
    let bytes =
        std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/text.pdf"))
            .unwrap();
    core().open(bytes, None).unwrap()
}

fn whole(rotation: u16, ppp: f32, width: u32, height: u32) -> RenderRequest {
    RenderRequest {
        rotation,
        pixels_per_point: ppp,
        x: 0,
        y: 0,
        width,
        height,
        annotations: true,
    }
}

fn pixel(rgba: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * width + x) * 4) as usize;
    [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
}

fn is_red(p: [u8; 4]) -> bool {
    p[0] > 200 && p[1] < 80 && p[2] < 80
}

fn is_blue(p: [u8; 4]) -> bool {
    p[2] > 200 && p[0] < 80 && p[1] < 80
}

fn is_dark(p: [u8; 4]) -> bool {
    p[0] < 100 && p[1] < 100 && p[2] < 100
}

/// Whether any pixel in the box [x0, x1) × [y0, y1) passes `test`.
fn any_in(
    rgba: &[u8],
    width: u32,
    (x0, y0, x1, y1): (u32, u32, u32, u32),
    test: fn([u8; 4]) -> bool,
) -> bool {
    (y0..y1).any(|y| (x0..x1).any(|x| test(pixel(rgba, width, x, y))))
}

#[test]
fn a_tile_is_exactly_that_crop_of_the_whole_page() {
    let doc = doc();
    let (w, h) = (1224, 1584);
    let page = doc.render(6, whole(0, 2.0, w, h)).unwrap();
    assert_eq!(page.len(), (w * h * 4) as usize);
    let (tx, ty, tw, th) = (150, 350, 256, 200);
    let tile = doc
        .render(
            6,
            RenderRequest {
                rotation: 0,
                pixels_per_point: 2.0,
                x: tx,
                y: ty,
                width: tw,
                height: th,
                annotations: true,
            },
        )
        .unwrap();
    for row in 0..th {
        let start = (((ty + row) * w + tx) * 4) as usize;
        let expected = &page[start..start + (tw * 4) as usize];
        let actual = &tile[(row * tw * 4) as usize..((row + 1) * tw * 4) as usize];
        assert_eq!(actual, expected, "tile row {row} differs from the page");
    }
    // The crop is not blank: it holds the square's red border.
    assert!(any_in(&tile, tw, (0, 0, tw, th), is_red));
}

#[test]
fn annotations_and_form_fields_are_drawn() {
    let doc = doc();
    let page = doc.render(6, whole(0, 1.0, 612, 792)).unwrap();
    // Square border at x = 100, around y = 792 − 550.
    assert!(any_in(&page, 612, (98, 238, 110, 246), is_red), "square");
    // Circle's left edge at x = 300.
    assert!(any_in(&page, 612, (298, 238, 310, 246), is_blue), "circle");
    // "Form value" inside the field, x 100–300, y 792 − 330 … 792 − 300.
    assert!(
        any_in(&page, 612, (102, 464, 298, 490), is_dark),
        "form text"
    );
}

#[test]
fn without_annotations_the_page_carries_its_content_alone() {
    let doc = doc();
    let page = doc
        .render(
            6,
            RenderRequest {
                annotations: false,
                ..whole(0, 1.0, 612, 792)
            },
        )
        .unwrap();
    assert!(!any_in(&page, 612, (90, 230, 420, 260), is_red), "square");
    assert!(!any_in(&page, 612, (90, 230, 420, 260), is_blue), "circle");
    assert!(
        !any_in(&page, 612, (102, 464, 298, 490), is_dark),
        "form text"
    );
}

#[test]
fn form_fields_stay_in_a_tile_at_8x() {
    let doc = doc();
    // The field's left end at 8 px per point: x 800–1100, y 8 × 462 … 8 × 492.
    let tile = doc
        .render(
            6,
            RenderRequest {
                rotation: 0,
                pixels_per_point: 8.0,
                x: 800,
                y: 3696,
                width: 512,
                height: 240,
                annotations: true,
            },
        )
        .unwrap();
    assert!(
        any_in(&tile, 512, (0, 0, 512, 240), is_dark),
        "form text in the tile"
    );
}

#[test]
fn hidden_annotations_leave_the_raster_and_the_rest_stay() {
    let doc = doc();
    let hidden = doc
        .hide_annotations(
            6,
            &[AnnotationKey {
                subtype: "Square".into(),
                rect: Rect {
                    left: 100.0,
                    bottom: 500.0,
                    right: 200.0,
                    top: 600.0,
                },
            }],
        )
        .unwrap();
    assert_eq!(hidden, 1);
    let page = doc.render(6, whole(0, 1.0, 612, 792)).unwrap();
    assert!(
        !any_in(&page, 612, (90, 200, 210, 300), is_red),
        "square still drawn"
    );
    assert!(
        any_in(&page, 612, (298, 238, 310, 246), is_blue),
        "circle lost"
    );
    // A key that matches nothing hides nothing.
    let none = doc
        .hide_annotations(
            6,
            &[AnnotationKey {
                subtype: "Circle".into(),
                rect: Rect {
                    left: 0.0,
                    bottom: 0.0,
                    right: 10.0,
                    top: 10.0,
                },
            }],
        )
        .unwrap();
    assert_eq!(none, 0);
}

#[test]
fn a_rotation_replaces_the_pages_own_rotate() {
    let doc = doc();
    // Page 2: crop box 540 × 700 with /Rotate 90 and a black square in the
    // crop's lower-left corner.
    // Shown as the file asks (90° clockwise, 700 × 540): the corner goes to
    // the top left.
    let turned = doc.render(1, whole(90, 1.0, 700, 540)).unwrap();
    assert!(
        any_in(&turned, 700, (2, 2, 18, 18), is_dark),
        "top-left at 90°"
    );
    assert!(!any_in(&turned, 700, (0, 520, 20, 540), is_dark));
    // Shown upright (540 × 700): the corner stays at the bottom left.
    let upright = doc.render(1, whole(0, 1.0, 540, 700)).unwrap();
    assert!(
        any_in(&upright, 540, (2, 682, 18, 698), is_dark),
        "bottom-left at 0°"
    );
    assert!(!any_in(&upright, 540, (0, 0, 20, 20), is_dark));
}

#[test]
fn an_oversized_request_is_refused_not_allocated() {
    let doc = doc();
    assert!(doc.render(0, whole(0, 1.0, 8000, 8000)).is_err());
    assert!(doc.render(0, whole(0, 1.0, 0, 10)).is_err());
}

/// A PDF written object by object, its cross-reference worked out:
/// `objects[i]` is object i + 1, the catalog first.
fn hand_made_pdf(objects: &[&str]) -> Vec<u8> {
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    let mut table = format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
    for offset in offsets {
        table.push_str(&format!("{offset:010} 00000 n \n"));
    }
    let size = objects.len() + 1;
    table.push_str(&format!(
        "trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    ));
    out.extend_from_slice(table.as_bytes());
    out
}

#[test]
fn a_page_takes_the_boxes_its_page_tree_hands_down() {
    // An A4 media box on the root /Pages node, a crop box on an inner one,
    // an empty media box, and a crop box that misses its media box.
    let band = "0 0 0 rg 0 0 595 20 re f";
    let content = format!("<< /Length {} >>\nstream\n{band}\nendstream", band.len());
    let bytes = hand_made_pdf(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R 6 0 R 8 0 R 9 0 R 10 0 R] /Count 6 /MediaBox [0 0 595 842] >>",
        "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>",
        "<< /Type /Pages /Parent 2 0 R /Kids [5 0 R] /Count 1 /CropBox [10 20 310 420] >>",
        "<< /Type /Page /Parent 4 0 R >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 0 0] >>",
        &content,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /CropBox [400 400 500 500] >>",
        "<< /Type /Page /Parent 2 0 R /CropBox [900 900 1000 1000] >>",
        "<< /Type /Pages /Parent 2 0 R /Kids [11 0 R] /Count 1 /CropBox [900 900 1000 1000] >>",
        "<< /Type /Page /Parent 10 0 R >>",
    ]);
    let doc = core().open(bytes, None).unwrap();
    let size = |index| {
        let g = doc.page_geometry(index).unwrap();
        (g.origin_x, g.origin_y, g.width, g.height)
    };
    assert_eq!(size(0), (0.0, 0.0, 595.0, 842.0), "inherited media box");
    assert_eq!(size(1), (10.0, 20.0, 300.0, 400.0), "inherited crop box");
    // PDF 32000 §7.7.3.3 and PDFium: no usable media box means US Letter.
    assert_eq!(size(2), (0.0, 0.0, 612.0, 792.0), "empty media box");
    // Ignored, as pdf.js does, rather than an empty page.
    assert_eq!(size(3), (0.0, 0.0, 200.0, 300.0), "crop box off the page");
    // The same, with the media box handed down from the root.
    assert_eq!(
        size(4),
        (0.0, 0.0, 595.0, 842.0),
        "own crop off an inherited media box"
    );
    assert_eq!(
        size(5),
        (0.0, 0.0, 595.0, 842.0),
        "both boxes inherited, disjoint"
    );
    // The page is drawn at that size, not stretched into Letter: the band
    // along its bottom 20 pt fills the bitmap's last 20 rows.
    let page = doc.render(0, whole(0, 1.0, 595, 842)).unwrap();
    assert!(any_in(&page, 595, (100, 826, 500, 840), is_dark), "band");
    assert!(!any_in(&page, 595, (100, 760, 500, 818), is_dark));
}

#[test]
fn a_crop_box_off_a_page_with_no_media_box_leaves_letter() {
    // No media box anywhere, so US Letter; the crop box misses it and is
    // ignored, not taken for the media box.
    let bytes = hand_made_pdf(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /CropBox [900 900 1000 1000] >>",
    ]);
    let doc = core().open(bytes, None).unwrap();
    let g = doc.page_geometry(0).unwrap();
    assert_eq!(
        (g.origin_x, g.origin_y, g.width, g.height),
        (0.0, 0.0, 612.0, 792.0)
    );
}

#[test]
fn a_page_whose_crop_box_misses_its_media_box_draws_on_the_media_box() {
    // A 20 pt square at (100, 100) on pages whose crop box misses the media
    // box: its own media box, one handed down, and none at all (US Letter).
    // The page is drawn on the box page_geometry reports, scaled and with y
    // up, where the overlays put their marks, at any zoom.
    let square = "0 0 0 rg 100 100 20 20 re f";
    let content = format!(
        "<< /Length {} >>\nstream\n{square}\nendstream",
        square.len()
    );
    let bytes = hand_made_pdf(&[
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R 6 0 R] /Count 3 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /CropBox [400 400 500 500] /Contents 5 0 R >>",
        "<< /Type /Pages /Parent 2 0 R /Kids [7 0 R] /Count 1 /MediaBox [0 0 595 842] >>",
        &content,
        "<< /Type /Page /Parent 2 0 R /CropBox [900 900 1000 1000] /Contents 5 0 R >>",
        "<< /Type /Page /Parent 4 0 R /CropBox [900 900 1000 1000] /Contents 5 0 R >>",
    ]);
    let doc = core().open(bytes, None).unwrap();
    for (index, w, h) in [(0, 200, 300), (1, 595, 842), (2, 612, 792)] {
        let g = doc.page_geometry(index).unwrap();
        assert_eq!((g.width, g.height), (w as f32, h as f32), "page {index}");
        for scale in [1, 2] {
            let (sw, sh) = (w * scale, h * scale);
            let page = doc.render(index, whole(0, scale as f32, sw, sh)).unwrap();
            // Inside the square, at pixel (x, h − y) times the scale.
            let (x0, y0) = (101 * scale, (h - 119) * scale);
            let (x1, y1) = (119 * scale, (h - 101) * scale);
            assert!(
                any_in(&page, sw, (x0, y0, x1, y1), is_dark),
                "page {index} at {scale}x: square"
            );
            // And nowhere else: not at the bitmap's (100, 100).
            let above = (h - 140) * scale;
            assert!(
                !any_in(&page, sw, (0, 0, sw, above), is_dark),
                "page {index} at {scale}x: ink above the square"
            );
        }
    }
    // Drawing the page does not move the box it is drawn on.
    let g = doc.page_geometry(1).unwrap();
    assert_eq!(
        (g.origin_x, g.origin_y, g.width, g.height),
        (0.0, 0.0, 595.0, 842.0)
    );
}
