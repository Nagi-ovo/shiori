//! Run with `bun run test:core`, which fetches the pinned PDFium first.
//! Expected values are worked out by hand from how the fixtures were made
//! (tests/fixtures/make-fixtures.ts), never read back from PDFium.

use std::path::PathBuf;

use shiori_core::{Core, CoreError, Destination, LinkTarget, Metadata, MAX_PAGE_CHARS};

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
    Core::bind(&dir).unwrap_or_else(|error| {
        panic!("{error}; run `bun scripts/pdfium/fetch.ts` or set SHIORI_PDFIUM_DIR")
    })
}

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

fn close(actual: f32, expected: f32, tolerance: f32) -> bool {
    (actual - expected).abs() <= tolerance
}

#[test]
fn reads_each_page_box_and_rotation() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    assert_eq!(doc.page_count(), 9);

    let plain = doc.page_geometry(0).unwrap();
    assert_eq!(plain.rotation, 0);
    assert_eq!((plain.origin_x, plain.origin_y), (0.0, 0.0));
    assert_eq!((plain.width, plain.height), (612.0, 792.0));

    // Crop box 36, 48, 540 × 700 inside Letter media, /Rotate 90.
    let cropped = doc.page_geometry(1).unwrap();
    assert_eq!(cropped.rotation, 90);
    assert_eq!((cropped.origin_x, cropped.origin_y), (36.0, 48.0));
    assert_eq!((cropped.width, cropped.height), (540.0, 700.0));
}

#[test]
fn places_each_character_on_its_baseline_by_advance() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    let chars: Vec<_> = doc
        .chars(0, MAX_PAGE_CHARS)
        .unwrap()
        .into_iter()
        .filter(|ch| !ch.generated)
        .collect();
    let text: String = chars.iter().map(|ch| ch.text.as_str()).collect();
    assert_eq!(text, "Shiori");

    // Helvetica AFM advances (per 1000 em): S 667, h 556, i 222, o 556,
    // r 333. At 12 pt from x = 72 the origins are:
    let expected_x = [72.0, 80.004, 86.676, 89.34, 96.012, 100.008];
    for (ch, x) in chars.iter().zip(expected_x) {
        assert!(
            close(ch.origin.0, x, 0.01),
            "{} origin x {} ≠ {x}",
            ch.text,
            ch.origin.0
        );
        assert!(
            close(ch.origin.1, 700.0, 0.01),
            "{} baseline {}",
            ch.text,
            ch.origin.1
        );
        assert!(close(ch.font_size, 12.0, 0.01));
        assert_eq!(ch.angle, 0.0);
    }
    // Each glyph's advance ends where the next one starts; the last one ends
    // at its own width (i = 222).
    for pair in chars.windows(2) {
        assert!(
            close(pair[0].end.0, pair[1].origin.0, 0.01),
            "{} end {} ≠ next origin {}",
            pair[0].text,
            pair[0].end.0,
            pair[1].origin.0
        );
    }
    assert!(close(chars[5].end.0, 100.008 + 2.664, 0.01));
    assert!(chars.iter().all(|ch| close(ch.end.1, 700.0, 0.01)));
    let s = &chars[0];
    assert!(close(s.loose.left, 72.0, 0.01), "S left {}", s.loose.left);
    assert!(
        close(s.loose.right, 80.004, 0.01),
        "S right {}",
        s.loose.right
    );
    assert!(s.loose.bottom < 700.0 && s.loose.top > 700.0 + 6.0);
}

#[test]
fn an_encrypted_file_needs_its_password() {
    let core = core();
    for password in [None, Some("nope")] {
        let error = core.open(fixture("locked.pdf"), password).err().unwrap();
        assert_eq!(error, CoreError::Password);
        // classifyPdfOpenError keys on this word.
        assert!(error.to_string().contains("password"));
    }
    let doc = core.open(fixture("locked.pdf"), Some("shiori")).unwrap();
    assert_eq!(doc.page_count(), 1);
}

#[test]
fn bytes_that_are_not_a_pdf_are_damaged() {
    let error = core()
        .open(b"not a pdf at all".to_vec(), None)
        .err()
        .unwrap();
    assert!(matches!(error, CoreError::Damaged(_)), "{error:?}");
    assert!(error.to_string().contains("damaged"));
}

#[test]
fn a_page_past_the_end_is_an_error_not_a_crash() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    assert_eq!(
        doc.page_geometry(9).err(),
        Some(CoreError::PageOutOfRange { index: 9, count: 9 })
    );
    assert!(doc.chars(70_000, MAX_PAGE_CHARS).is_err());
}

#[test]
fn a_split_ligature_comes_back_as_one_glyph_ending_where_the_next_starts() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    let chars: Vec<_> = doc
        .chars(2, MAX_PAGE_CHARS)
        .unwrap()
        .into_iter()
        .filter(|ch| !ch.generated)
        .collect();
    let texts: Vec<&str> = chars.iter().map(|ch| ch.text.as_str()).collect();
    assert_eq!(texts, ["fi", "r"]);
    let fi = &chars[0];
    assert!(close(fi.origin.0, 72.0, 0.01) && close(fi.origin.1, 650.0, 0.01));
    // Its letters have no width of their own; the glyph ends where "r" starts.
    assert!(close(fi.end.0, 80.004, 0.01), "fi end {}", fi.end.0);
}

#[test]
fn a_turned_glyph_advances_along_its_own_baseline() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    let chars = doc.chars(3, MAX_PAGE_CHARS).unwrap();
    let s = chars.iter().find(|ch| ch.text == "S").unwrap();
    assert!(close(s.origin.0, 300.0, 0.01) && close(s.origin.1, 400.0, 0.01));
    // A quarter turn counter-clockwise: the 8.004 pt advance runs up the page.
    assert!(close(s.end.0, 300.0, 0.01), "end x {}", s.end.0);
    assert!(close(s.end.1, 408.004, 0.01), "end y {}", s.end.1);
    assert!(
        close(s.angle, std::f32::consts::FRAC_PI_2, 0.001),
        "angle {}",
        s.angle
    );
}

#[test]
fn a_glyph_whose_ink_overhangs_ends_at_its_advance_not_its_ink() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    let chars = doc.chars(3, MAX_PAGE_CHARS).unwrap();
    let f = chars.iter().find(|ch| ch.text == "f").unwrap();
    // The f is set in an embedded Liberation Sans Italic, so its ink is the
    // file's, not a platform substitute's. Its /W is 569/2048 em = 277.83/1000,
    // which PDFium reads as the integer 277: at 12 pt from x = 100 the advance
    // ends at 103.324.
    assert!(close(f.end.0, 103.324, 0.01), "f end {}", f.end.0);
    // Its ink reaches 746/2048 em = 364.26/1000, 104.371 at 12 pt, over a
    // point past the advance: the loose box ends there, the advance does not.
    assert!(
        close(f.loose.right, 104.371, 0.01),
        "f ink {}",
        f.loose.right
    );
    assert!(f.loose.right > f.end.0 + 1.0, "f ink {}", f.loose.right);
}

#[test]
fn a_line_end_hyphen_reads_as_a_hyphen() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    let chars = doc.chars(4, MAX_PAGE_CHARS).unwrap();
    let hyphen = chars
        .iter()
        .find(|ch| ch.hyphen)
        .expect("PDFium saw no hyphenation");
    assert_eq!(hyphen.text, "-");
    // "exam" is 556 + 500 + 556 + 833 per 1000 em at 12 pt from x = 72.
    assert!(
        close(hyphen.origin.0, 72.0 + 29.34, 0.01),
        "{}",
        hyphen.origin.0
    );
}

#[test]
fn a_width_looked_up_for_the_wrong_code_is_not_trusted() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    let chars: Vec<_> = doc
        .chars(5, MAX_PAGE_CHARS)
        .unwrap()
        .into_iter()
        .filter(|ch| !ch.generated)
        .collect();
    assert_eq!(chars.len(), 2);
    // ★ looks up as X either way; X's 667 fits the X but not the i (222).
    assert!(
        close(chars[0].end.0, 72.0 + 8.004, 0.01),
        "{}",
        chars[0].end.0
    );
    assert!(close(chars[1].origin.0, 72.0 + 8.004, 0.01));
    assert!(
        close(chars[1].end.0, 72.0 + 8.004 + 2.664, 0.01),
        "{}",
        chars[1].end.0
    );
}

#[test]
fn reads_the_outline_with_its_nesting_and_destinations() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    let outline = doc.outline();
    let titles: Vec<&str> = outline.iter().map(|item| item.title.as_str()).collect();
    assert_eq!(titles, ["Chapter one", "Start"]);
    assert_eq!(
        outline[0].destination,
        Some(Destination {
            page_index: 1,
            view: "XYZ",
            // x 50, y 600, and the zoom the file leaves null.
            args: vec![Some(50.0), Some(600.0), None],
        })
    );
    let section = &outline[0].children[0];
    assert_eq!(section.title, "第一节 Section");
    assert_eq!(
        section.destination,
        Some(Destination {
            page_index: 6,
            view: "FitH",
            args: vec![Some(500.0)],
        })
    );
    // A GoTo action lands like a direct destination.
    assert_eq!(
        outline[1].destination,
        Some(Destination {
            page_index: 0,
            view: "Fit",
            args: vec![],
        })
    );
    assert!(outline[1].children.is_empty());
}

#[test]
fn reads_each_link_with_its_rect_and_target() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    let links = doc.links(7).unwrap();
    assert_eq!(links.len(), 3);
    assert_eq!(
        (
            links[0].rect.left,
            links[0].rect.bottom,
            links[0].rect.right,
            links[0].rect.top
        ),
        (72.0, 700.0, 200.0, 720.0)
    );
    assert_eq!(
        links[0].target,
        LinkTarget::Url("https://shiori.nagi.fun/".into())
    );
    assert_eq!(
        links[2].target,
        LinkTarget::Destination(Destination {
            page_index: 3,
            view: "FitR",
            args: vec![Some(10.0), Some(20.0), Some(300.0), Some(400.0)],
        })
    );
    assert_eq!(
        links[1].target,
        LinkTarget::Url("https://example.com/π".into())
    );
    assert!(doc.links(0).unwrap().is_empty());
}

#[test]
fn a_glyph_carries_its_font_and_metrics() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    let chars = doc.chars(8, MAX_PAGE_CHARS).unwrap();
    let text: String = chars.iter().map(|c| c.text.as_str()).collect();
    assert_eq!(text, "One Two");
    let glyph = |s: &str| chars.iter().find(|c| c.text == s).unwrap();
    let o = glyph("O");
    assert_eq!(o.font_name, "Times-Roman");
    // Serif (2) and nonsymbolic (32), nothing PDFium adds of its own.
    assert_eq!(o.font_flags, 34);
    // Ascent 800 and descent -200 per 1000 at 20 pt.
    assert!(close(o.ascent, 16.0, 0.01), "{}", o.ascent);
    assert!(close(o.descent, -4.0, 0.01), "{}", o.descent);
    // The space between the words is PDFium's: no font, no metrics.
    let space = glyph(" ");
    assert!(space.generated);
    assert_eq!((space.font_name.as_str(), space.ascent), ("", 0.0));
}

#[test]
fn reads_the_document_language_when_the_catalog_gives_one() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    assert_eq!(doc.language().as_deref(), Some("ja-JP"));
    let locked = core().open(fixture("locked.pdf"), Some("shiori")).unwrap();
    assert_eq!(locked.language(), None);
}

// Metadata and the page text bound. What can go wrong: a UTF-16 or
// PDFDocEncoding string decoded wrongly or cut at an embedded NUL; a date
// reformatted instead of kept raw; an absent key, an empty string or a
// missing /Info coming back as ""; XMP read in place of /Info; an encrypted
// file's strings left encrypted (user or owner password, /EncryptMetadata
// false); a filter name reported for a file without encryption; the version
// misformatted; the text bound off by one, refusing an empty page, or
// reported as a password or damage error.

/// A PDF written here object by object, its cross-reference worked out:
/// `objects[i]` is object i + 1, the catalog first.
fn hand_made_pdf(version: &str, objects: &[String], trailer: &str) -> Vec<u8> {
    let mut out = format!("%PDF-{version}\n").into_bytes();
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
    out.extend_from_slice(table.as_bytes());
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R {trailer} >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

/// Two Letter pages, the first reading "Hello" in Helvetica, the second
/// blank; `catalog` adds to the catalog, `info` (object 7) is /Info when given.
fn hello_pdf(version: &str, catalog: &str, info: Option<&str>) -> Vec<u8> {
    let content = "BT /F1 12 Tf 72 700 Td (Hello) Tj ET";
    let mut objects = vec![
        format!("<< /Type /Catalog /Pages 2 0 R {catalog} >>"),
        "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
         /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>"
            .to_string(),
        format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len() + 1
        ),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    let trailer = match info {
        Some(info) => {
            objects.push(info.to_string());
            "/Info 7 0 R"
        }
        None => "",
    };
    hand_made_pdf(version, &objects, trailer)
}

#[test]
fn reads_the_information_dictionary_as_the_file_writes_it() {
    // Title UTF-16BE "秘密", Author PDFDocEncoding "Café" (\351), Producer
    // a hex string, dates as written, Subject empty; Trapped is a name and
    // Custom a key outside the eight.
    let info = r"<< /Title <FEFF79D85BC6> /Author (Caf\351) /Subject () /Keywords (a, b)
        /Creator (Hand) /Producer <48616E64> /CreationDate (D:20260102030405+09'00')
        /ModDate (D:2026) /Trapped /True /Custom (x) >>";
    let doc = core()
        .open(hello_pdf("1.6", "/Lang (en-GB)", Some(info)), None)
        .unwrap();
    let some = |text: &str| Some(text.to_string());
    assert_eq!(
        doc.metadata(),
        Metadata {
            title: some("秘密"),
            author: some("Café"),
            subject: None,
            keywords: some("a, b"),
            creator: some("Hand"),
            producer: some("Hand"),
            creation_date: some("D:20260102030405+09'00'"),
            mod_date: some("D:2026"),
            pdf_format_version: some("1.6"),
            language: some("en-GB"),
            encrypt_filter_name: None,
        }
    );
}

#[test]
fn an_information_string_keeps_a_nul_inside_it() {
    // UTF-16BE "A", U+0000, "B": the string runs to PDFium's byte count,
    // not to the first zero unit.
    let doc = core()
        .open(
            hello_pdf("1.7", "", Some("<< /Title <FEFF004100000042> >>")),
            None,
        )
        .unwrap();
    assert_eq!(doc.metadata().title.as_deref(), Some("A\u{0}B"));
}

#[test]
fn a_file_without_an_information_dictionary_has_only_its_version() {
    let doc = core().open(hello_pdf("1.3", "", None), None).unwrap();
    assert_eq!(
        doc.metadata(),
        Metadata {
            pdf_format_version: Some("1.3".into()),
            ..Metadata::default()
        }
    );
}

#[test]
fn a_catalog_version_overrides_the_header() {
    // As pdf.js reads it: the catalog's /Version when it has one.
    for (header, catalog, expected) in [("1.4", "1.7", "1.7"), ("1.7", "1.4", "1.4")] {
        let doc = core()
            .open(
                hello_pdf(header, &format!("/Version /{catalog}"), None),
                None,
            )
            .unwrap();
        assert_eq!(
            doc.metadata().pdf_format_version.as_deref(),
            Some(expected),
            "header {header}, catalog {catalog}"
        );
    }
}

#[test]
fn an_encrypted_file_reads_its_information_decrypted_whichever_password_opened_it() {
    // Every encrypted fixture has the Info title "Locked title 秘密" and an
    // XMP title "Locked title XMP" (fixtures/encrypted/README.md).
    for (name, password) in [
        ("aes-256", "user-pw"),
        ("aes-256", OWNER),
        ("aes-128-nometa", "user-pw"),
        ("rc4-40", OWNER),
        ("empty-user", ""),
    ] {
        let doc = open_with(&encrypted_fixture(name), password).unwrap();
        let metadata = doc.metadata();
        assert_eq!(
            metadata.title.as_deref(),
            Some("Locked title 秘密"),
            "{name} with {password:?}"
        );
        assert_eq!(metadata.encrypt_filter_name, Some("Standard"), "{name}");
    }
    let plain = core().open(fixture("text.pdf"), None).unwrap().metadata();
    assert_eq!(plain.encrypt_filter_name, None);
    // make-fixtures.ts sets no title; pdf-lib stamps its producer.
    assert_eq!(plain.title, None);
    assert_eq!(
        plain.producer.as_deref(),
        Some("pdf-lib (https://github.com/Hopding/pdf-lib)")
    );
}

#[test]
fn a_page_with_more_characters_than_the_bound_is_refused_whole() {
    let doc = core().open(hello_pdf("1.7", "", None), None).unwrap();
    let text: String = doc
        .chars(0, 5)
        .unwrap()
        .into_iter()
        .map(|ch| ch.text)
        .collect();
    assert_eq!(text, "Hello");
    assert_eq!(
        doc.chars(0, 4).err(),
        Some(CoreError::TooMuchText {
            index: 0,
            count: 5,
            max: 4
        })
    );
    assert_eq!(doc.chars(1, 0).unwrap(), vec![]);
}

#[test]
fn an_encrypted_document_rewrites_in_the_clear_with_its_objects_kept() {
    // Owner-password AES encryption, as many published PDFs have: it opens
    // without a password, but every string in the file is ciphertext.
    let encrypted = fixture("encrypted-notes.pdf");
    assert!(!contains(&encrypted, b"Encrypted note"));
    let doc = core().open(encrypted, None).unwrap();
    let copy = doc.decrypted_copy().unwrap();
    assert!(!contains(&copy, b"/Encrypt"));
    // Strings come out as hex in the clear: the note's UTF-16 /Contents and
    // its author "Reviewer".
    let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02X}")).collect::<String>();
    let utf16: Vec<u8> = "\u{feff}Encrypted note"
        .encode_utf16()
        .flat_map(|unit| unit.to_be_bytes())
        .collect();
    assert!(contains(&copy, hex(&utf16).as_bytes()));
    assert!(contains(
        &copy,
        format!("/T<{}>", hex(b"Reviewer")).as_bytes()
    ));
    // Annotation ids are object numbers: the note is 4 0 obj in both.
    assert!(contains(&copy, b"\n4 0 obj") || contains(&copy, b"\r4 0 obj"));
    let reopened = core().open(copy, None).unwrap();
    assert_eq!(reopened.page_count(), 1);
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[test]
fn lists_the_embedded_fonts_a_page_draws_with_their_programs() {
    // Liberation Sans embedded as TrueType; Noto Sans JP embedded from an
    // OpenType program PDFium's FreeType cannot load from this subset, so it
    // draws a substitute; Helvetica, not embedded; Foxit Serif as bare CFF.
    // Only the first and last are the file's own fonts as drawn.
    let doc = core().open(fixture("embedded-fonts.pdf"), None).unwrap();
    let fonts = doc.embedded_fonts(0).unwrap();
    assert_eq!(fonts.len(), 2);
    let font = &fonts[0];
    assert!(font.name.starts_with("LiberationSans"), "{}", font.name);
    assert_eq!(font.format.as_str(), "truetype");
    // The program itself: a TrueType header (either form), and the glyph
    // outlines table.
    assert!(matches!(&font.data[..4], [0, 1, 0, 0] | b"true"));
    assert!(font.data.windows(4).any(|tag| tag == b"glyf"));
    // PDFium names a font without its subset prefix, as the text layer does.
    assert_eq!(fonts[1].name, "FoxitSerif");
    assert_eq!(fonts[1].format.as_str(), "cff");
}

/// A path's commands and the bounds of its points.
fn path_shape(path: &str) -> (String, [f32; 4]) {
    let commands: String = path.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    let numbers: Vec<f32> = path
        .split(|c: char| c.is_ascii_alphabetic() || c == ' ')
        .filter(|n| !n.is_empty())
        .map(|n| n.parse().unwrap())
        .collect();
    let mut bounds = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    for point in numbers.chunks(2) {
        bounds[0] = bounds[0].min(point[0]);
        bounds[1] = bounds[1].min(point[1]);
        bounds[2] = bounds[2].max(point[0]);
        bounds[3] = bounds[3].max(point[1]);
    }
    (commands, bounds)
}

#[test]
fn rebuilds_a_bare_cff_font_from_the_glyphs_the_page_sets() {
    // "Top compact" in Foxit Serif: bare CFF with no /ToUnicode, as XeTeX and
    // InDesign embed their fonts. A browser cannot load it; PDFium draws it.
    let doc = core().open(fixture("embedded-fonts.pdf"), None).unwrap();
    let fonts = doc.font_outlines(0, &["FoxitSerif".to_string()]).unwrap();
    assert_eq!(fonts.len(), 1, "only the fonts asked for");
    // The reading layer finds a run's rebuilt font by the name its glyphs
    // carry, so the two must agree.
    let t = doc
        .chars(0, MAX_PAGE_CHARS)
        .unwrap()
        .into_iter()
        .find(|c| c.text == "T")
        .unwrap();
    assert_eq!(t.font_name, fonts[0].name);
    let font = &fonts[0];
    assert_eq!(font.name, "FoxitSerif");
    assert_eq!((font.ascent, font.descent), (683.0, -217.0));
    // Each character once, in the order the page sets them.
    let chars: String = font
        .glyphs
        .iter()
        .map(|g| char::from_u32(g.unicode).unwrap())
        .collect();
    assert_eq!(chars, "Top cmat");
    let glyph = |c: char| font.glyphs.iter().find(|g| g.unicode == c as u32).unwrap();
    // Advances are the file's /Widths (Times-Roman's metrics).
    assert_eq!(glyph('T').advance, 611.0);
    assert_eq!(glyph(' ').advance, 250.0);
    // A space draws nothing.
    assert_eq!(glyph(' ').path, "");
    // T: straight strokes, from the baseline to the cap height, inside its
    // advance; y is up.
    let (commands, [left, bottom, right, top]) = path_shape(&glyph('T').path);
    assert!(
        commands.starts_with('M') && commands.ends_with('Z'),
        "{commands}"
    );
    assert!(
        bottom.abs() <= 1.0 && (655.0..=670.0).contains(&top),
        "{bottom} {top}"
    );
    assert!(left >= 0.0 && right <= 611.0, "{left} {right}");
    // o: two closed contours of curves, the counter inside the bowl, and
    // the bowl above the baseline's overshoot, below the x-height's.
    let (commands, [_, bottom, _, top]) = path_shape(&glyph('o').path);
    assert_eq!(commands.matches('M').count(), 2, "{commands}");
    assert_eq!(commands.matches('Z').count(), 2, "{commands}");
    assert!(commands.contains('C'), "{commands}");
    assert!(
        (-20.0..0.0).contains(&bottom) && (440.0..480.0).contains(&top),
        "{bottom} {top}"
    );
    // p's descender goes below the baseline.
    let (_, [_, bottom, _, _]) = path_shape(&glyph('p').path);
    assert!(bottom < -150.0, "{bottom}");
}

#[test]
fn rebuilds_a_truetype_subset_the_same_way() {
    // pdf-lib's Liberation Sans subset, which a browser's sanitiser refuses.
    let doc = core().open(fixture("embedded-fonts.pdf"), None).unwrap();
    let name = doc.embedded_fonts(0).unwrap()[0].name.clone();
    let fonts = doc.font_outlines(0, std::slice::from_ref(&name)).unwrap();
    let chars: String = fonts[0]
        .glyphs
        .iter()
        .map(|g| char::from_u32(g.unicode).unwrap())
        .collect();
    assert_eq!(chars, "Liberaton");
    let l = &fonts[0].glyphs[0];
    // Liberation Sans' L: 1139 of 2048 units wide, a single rectilinear contour.
    assert_eq!(l.advance, 556.0);
    let (commands, [_, bottom, _, top]) = path_shape(&l.path);
    assert_eq!(commands, "MLLLLLLZ");
    assert!(
        bottom == 0.0 && (680.0..700.0).contains(&top),
        "{bottom} {top}"
    );
    // Fonts not asked for, and fonts the file does not embed, are left out.
    assert!(doc.font_outlines(0, &[]).unwrap().is_empty());
    assert!(doc
        .font_outlines(0, &["Helvetica".to_string()])
        .unwrap()
        .is_empty());
}

/// The encrypted fixtures (tests/fixtures/encrypted/README.md): pypdf wrote
/// them, so PDFium reading them and shiori-core re-encrypting them are two
/// implementations checked against a third. Each is (name, user password,
/// /R, whether the user password may annotate and modify).
const ENCRYPTED: &[(&str, &str, i32, bool)] = &[
    ("rc4-40", "user-pw", 2, true),
    ("rc4-128", "user-pw", 3, true),
    ("r4-rc4", "user-pw", 4, true),
    ("aes-128", "user-pw", 4, true),
    ("aes-128-nometa", "user-pw", 4, true),
    ("aes-256-r5", "user-pw", 5, true),
    ("aes-256", "user-pw", 6, true),
    ("aes-256-nometa", "user-pw", 6, true),
    ("restricted", "user-pw", 6, false),
    ("annotate-only", "user-pw", 4, false),
    ("empty-user", "", 6, false),
    ("cjk-password", "密码パス", 6, true),
    ("latin1-password", "café", 3, true),
];
const OWNER: &str = "owner-pw";

fn encrypted_fixture(name: &str) -> Vec<u8> {
    fixture(&format!("encrypted/{name}.pdf"))
}

fn page_text(doc: &shiori_core::Document, index: u32) -> String {
    doc.chars(index, MAX_PAGE_CHARS)
        .unwrap()
        .into_iter()
        .map(|c| c.text)
        .collect()
}

fn open_with(bytes: &[u8], password: &str) -> Result<shiori_core::Document, CoreError> {
    let password = (!password.is_empty()).then_some(password);
    core().open(bytes.to_vec(), password)
}

#[test]
fn an_encrypted_document_reports_its_revision_and_what_each_password_allows() {
    const ANNOTATE: u32 = 1 << 5;
    const MODIFY: u32 = 1 << 3;
    for &(name, user, revision, user_may_edit) in ENCRYPTED {
        let as_user = open_with(&encrypted_fixture(name), user).unwrap();
        let security = as_user.security();
        assert_eq!(security.revision, Some(revision), "{name}");
        assert_eq!(security.user_permissions, security.permissions, "{name}");
        let may_edit = security.permissions & ANNOTATE != 0 && security.permissions & MODIFY != 0;
        assert_eq!(may_edit, user_may_edit, "{name}");
        // The owner password lifts every restriction (bits 3-32; 1 and 2
        // are not permissions); /P stays readable.
        let as_owner = open_with(&encrypted_fixture(name), OWNER).unwrap();
        assert_eq!(as_owner.security().permissions | 3, u32::MAX, "{name}");
        assert_eq!(
            as_owner.security().user_permissions,
            security.user_permissions,
            "{name}"
        );
    }
    let plain = core().open(fixture("text.pdf"), None).unwrap().security();
    assert_eq!(plain.revision, None);
    assert_eq!(plain.permissions | 3, u32::MAX);
}

#[test]
fn an_export_encrypted_like_its_source_opens_with_both_passwords_and_no_other() {
    use shiori_core::pdf_syntax::parse_file;
    for &(name, user, revision, _) in ENCRYPTED {
        for opened_with in [user, OWNER] {
            let source = encrypted_fixture(name);
            let doc = open_with(&source, opened_with).unwrap();
            let plain = doc.decrypted_copy().unwrap();
            let out = doc
                .encrypt_like_source(&plain)
                .unwrap_or_else(|e| panic!("{name} opened with {opened_with:?}: {e}"));
            for password in [user, OWNER] {
                let reopened = open_with(&out, password).unwrap_or_else(|e| {
                    panic!("{name}: {password:?} does not open the export: {e}")
                });
                assert_eq!(reopened.security().revision, Some(revision), "{name}");
                assert_eq!(reopened.page_count(), 2, "{name}");
                assert_eq!(page_text(&reopened, 0).trim(), "Secret page one", "{name}");
                assert_eq!(page_text(&reopened, 1).trim(), "Secret page two", "{name}");
                // PDFium decrypts every object of the export to what it
                // decrypted from the source: the note's CJK /Contents, the
                // Info title, the attachment, the XMP, all of it.
                let again = parse_file(&reopened.decrypted_copy().unwrap()).unwrap();
                let original = parse_file(&plain).unwrap();
                for object in &original.objects {
                    // PDFium's plaintext keeps the source's /Encrypt as an
                    // orphan, which its next save drops.
                    let handler = object.value.as_dict().and_then(|d| d.name("Filter"));
                    if handler.as_deref() == Some(b"Standard") {
                        continue;
                    }
                    let decrypted = again.objects.iter().find(|o| o.num == object.num);
                    assert_eq!(decrypted, Some(object), "{name}: object {}", object.num);
                }
            }
            for wrong in ["wrong", "user-pW"] {
                assert_eq!(
                    open_with(&out, wrong).err(),
                    Some(CoreError::Password),
                    "{name}"
                );
            }
            if !user.is_empty() {
                assert_eq!(
                    core().open(out.clone(), None).err(),
                    Some(CoreError::Password),
                    "{name}"
                );
            }
        }
    }
}

#[test]
fn the_export_keeps_the_source_encrypt_dictionary_and_first_id() {
    use shiori_core::pdf_syntax::{parse_file, Object, Parser};
    for &(name, user, _, _) in ENCRYPTED {
        let source = encrypted_fixture(name);
        let doc = open_with(&source, user).unwrap();
        let out = doc
            .encrypt_like_source(&doc.decrypted_copy().unwrap())
            .unwrap();
        // pypdf writes a classic trailer with an indirect /Encrypt.
        let trailer_of = |bytes: &[u8]| {
            let at = bytes.windows(7).rposition(|w| w == b"trailer").unwrap();
            let Ok(Object::Dict(trailer)) = Parser::new(bytes, at + 7).object() else {
                panic!("{name}: no trailer")
            };
            trailer
        };
        let resolve = |bytes: &[u8], object: &Object| match object {
            Object::Ref(num, _) => {
                parse_file(bytes)
                    .unwrap()
                    .objects
                    .into_iter()
                    .find(|o| o.num == *num)
                    .unwrap()
                    .value
            }
            other => other.clone(),
        };
        let (before, after) = (trailer_of(&source), trailer_of(&out));
        assert!(
            matches!(after.get("Encrypt"), Some(Object::Ref(..))),
            "{name}"
        );
        assert_eq!(
            resolve(&out, after.get("Encrypt").unwrap()),
            resolve(&source, before.get("Encrypt").unwrap()),
            "{name}"
        );
        let first_id = |trailer: &shiori_core::pdf_syntax::Dict| match trailer.get("ID") {
            Some(Object::Array(id)) => id[0].clone(),
            _ => panic!("{name}: no /ID"),
        };
        assert_eq!(first_id(&after), first_id(&before), "{name}");
    }
}

#[test]
fn metadata_stays_in_the_clear_exactly_when_the_source_said_so() {
    for &(name, user, _, _) in ENCRYPTED {
        let doc = open_with(&encrypted_fixture(name), user).unwrap();
        let out = doc
            .encrypt_like_source(&doc.decrypted_copy().unwrap())
            .unwrap();
        assert_eq!(
            contains(&out, b"Locked title XMP"),
            name.ends_with("-nometa"),
            "{name}"
        );
    }
}

#[test]
fn an_unencrypted_document_has_nothing_to_encrypt_like() {
    let doc = core().open(fixture("text.pdf"), None).unwrap();
    let error = doc.encrypt_like_source(b"%PDF-1.7").err().unwrap();
    assert!(matches!(error, CoreError::Encryption(_)), "{error:?}");
}

// Sources whose bytes hold an /Encrypt dictionary no cross-reference points
// at. PDFium reads the one the cross-reference gives; so must the
// re-encryption, or the export goes out under a handler the source never
// had (here: Identity crypt filters, which leave it open to anyone).
// What can go wrong:
// - a comment after %%EOF that spells out `N 0 obj <<...>> endobj` wins;
// - an incremental update moves /Encrypt to a new object and leaves a stale
//   copy of it after the live one, outside its cross-reference;
// - a whole PDF inside a stream the file keeps in the clear (metadata under
//   /EncryptMetadata false) brings its own objects and trailer;
// - a cross-reference PDFium had to rebuild is guessed at instead of refused.

/// The source's /Encrypt object number and dictionary, as pypdf writes them
/// (one revision, `/Encrypt N 0 R`, `N 0 obj\n<<...>>\nendobj`).
fn pypdf_encrypt_object(source: &[u8]) -> (u32, String) {
    let text = String::from_utf8_lossy(source).into_owned();
    let at = text.rfind("/Encrypt ").unwrap() + "/Encrypt ".len();
    let num: u32 = text[at..].split(' ').next().unwrap().parse().unwrap();
    let start = text.find(&format!("\n{num} 0 obj\n")).unwrap() + format!("\n{num} 0 obj\n").len();
    let end = start + text[start..].find("\nendobj").unwrap();
    (num, text[start..end].to_string())
}

/// `dict` with Identity crypt filters: a handler that encrypts nothing.
fn identity_filters(dict: &str) -> String {
    let open = dict
        .replace("/StmF /StdCF", "/StmF /Identity")
        .replace("/StrF /StdCF", "/StrF /Identity");
    assert_ne!(open, dict, "the fixture's crypt filters are not /StdCF");
    open
}

/// `source` plus an incremental update: `body` appended, a classic
/// cross-reference section listing `live` as (object number, offset within
/// `body`), and a trailer repeating the source's with /Encrypt `encrypt`
/// and /Prev.
fn incremental_update(source: &[u8], body: &[u8], live: &[(u32, usize)], encrypt: u32) -> Vec<u8> {
    let text = String::from_utf8_lossy(source).into_owned();
    let trailer_at = text.rfind("\ntrailer\n").unwrap() + "\ntrailer\n".len();
    let startxref_at = text.rfind("startxref\n").unwrap();
    let prev: usize = text[startxref_at + "startxref\n".len()..]
        .lines()
        .next()
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let trailer = text[trailer_at..startxref_at].trim();
    let trailer = trailer.strip_suffix(">>").unwrap();
    let (old_num, _) = pypdf_encrypt_object(source);
    let size = live
        .iter()
        .map(|&(num, _)| num + 1)
        .max()
        .unwrap()
        .max(old_num + 1);
    let trailer = trailer
        .replace(
            &format!("/Encrypt {old_num} 0 R"),
            &format!("/Encrypt {encrypt} 0 R"),
        )
        .replace(&format!("/Size {}", old_num + 1), &format!("/Size {size}"));
    let mut out = source.to_vec();
    out.push(b'\n');
    let base = out.len();
    out.extend_from_slice(body);
    let xref = out.len();
    out.extend_from_slice(b"xref\n");
    for &(num, offset) in live {
        out.extend_from_slice(format!("{num} 1\n{:010} 00000 n \n", base + offset).as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n{trailer}/Prev {prev}\n>>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    out
}

/// The three sources above, from `aes-128` (and its -nometa twin), with the
/// password that opens them.
fn sources_with_an_unlisted_encrypt_dictionary() -> Vec<(&'static str, Vec<u8>)> {
    let mut sources = Vec::new();

    let aes = encrypted_fixture("aes-128");
    let (num, dict) = pypdf_encrypt_object(&aes);
    let open = identity_filters(&dict).replace(['\n', '\r'], " ");
    let mut comment = aes.clone();
    comment.extend_from_slice(format!("\n% {num} 0 obj {open} endobj\n").as_bytes());
    sources.push(("a comment after %%EOF", comment));

    let moved = num + 1;
    let live = format!("{moved} 0 obj\n{dict}\nendobj\n");
    let stale = format!("{moved} 0 obj\n{}\nendobj\n", identity_filters(&dict));
    let body = format!("{live}{stale}");
    sources.push((
        "a stale copy in an update that moved /Encrypt",
        incremental_update(&aes, body.as_bytes(), &[(moved, 0)], moved),
    ));

    let nometa = encrypted_fixture("aes-128-nometa");
    let (num, dict) = pypdf_encrypt_object(&nometa);
    let inner = format!(
        "%PDF-1.7\n{num} 0 obj\n{}\nendobj\ntrailer\n<< /Size {} /Encrypt {num} 0 R >>\nstartxref\n9\n%%EOF\n",
        identity_filters(&dict),
        num + 1
    );
    let carrier = num + 1;
    let body = format!(
        "{carrier} 0 obj\n<< /Type /Metadata /Subtype /XML /Length {} >>\nstream\n{inner}\nendstream\nendobj\n",
        inner.len()
    );
    sources.push((
        "a PDF inside a stream kept in the clear",
        incremental_update(&nometa, body.as_bytes(), &[(carrier, 0)], num),
    ));
    sources
}

#[test]
fn an_encrypt_dictionary_no_cross_reference_points_at_is_never_used() {
    let mut failures = Vec::new();
    for (case, source) in sources_with_an_unlisted_encrypt_dictionary() {
        // PDFium reads the listed handler: the source stays locked.
        assert_eq!(
            core().open(source.clone(), None).err(),
            Some(CoreError::Password),
            "{case}: the source opens without a password"
        );
        for opened_with in ["user-pw", OWNER] {
            let doc = open_with(&source, opened_with).unwrap();
            let out = match doc.encrypt_like_source(&doc.decrypted_copy().unwrap()) {
                Ok(out) => out,
                Err(e) => {
                    failures.push(format!("{case}: refused a well-formed source: {e}"));
                    continue;
                }
            };
            if core().open(out.clone(), None).err() != Some(CoreError::Password) {
                failures.push(format!("{case}: the export opens without a password"));
            }
            if open_with(&out, "wrong").err() != Some(CoreError::Password) {
                failures.push(format!("{case}: the export opens with a wrong password"));
            }
            if contains(&out, b"Secret page") {
                failures.push(format!("{case}: page text in the clear"));
            }
            for password in ["user-pw", OWNER] {
                match open_with(&out, password) {
                    Ok(reopened) => {
                        assert_eq!(reopened.security().revision, Some(4), "{case}");
                        assert_eq!(page_text(&reopened, 0).trim(), "Secret page one", "{case}");
                    }
                    Err(e) => failures.push(format!("{case}: {password:?} does not open it: {e}")),
                }
            }
        }
    }
    failures.dedup();
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn a_source_whose_cross_reference_cannot_be_followed_is_refused_not_guessed() {
    let mut source = encrypted_fixture("aes-128");
    let at = source
        .windows(10)
        .rposition(|w| w == b"startxref\n")
        .unwrap();
    source.truncate(at);
    // startxref points at the header: PDFium rebuilds the cross-reference
    // by scanning, which the re-encryption must not imitate.
    source.extend_from_slice(b"startxref\n0\n%%EOF\n");
    let doc = open_with(&source, "user-pw").unwrap();
    assert_eq!(page_text(&doc, 0).trim(), "Secret page one");
    let error = doc
        .encrypt_like_source(&doc.decrypted_copy().unwrap())
        .expect_err("re-encrypted a source it could not read");
    assert!(matches!(error, CoreError::Encryption(_)), "{error:?}");
}
