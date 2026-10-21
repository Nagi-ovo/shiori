//! Telling a document's fonts apart. Run with `bun run test:core`, which
//! fetches the pinned PDFium first.

use std::path::PathBuf;

use shiori_core::{Core, MAX_PAGE_CHARS};

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

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap()
}

/// The font name and id the glyph `text` is drawn with.
fn font_of(glyphs: &[shiori_core::TextChar], text: &str) -> (String, String) {
    let glyph = glyphs.iter().find(|g| g.text == text).unwrap();
    (glyph.font_name.clone(), glyph.font_id.clone())
}

#[test]
fn two_subsets_of_one_font_keep_apart() {
    // "Liberation" and "Sans" each in its own subset of Liberation Sans,
    // both tagged "AAAAAA+", as the first font of two merged word-processor
    // exports is (audit B108). The name alone cannot tell them apart.
    let doc = core().open(fixture("font-subsets.pdf"), None).unwrap();
    let glyphs = doc.chars(0, MAX_PAGE_CHARS).unwrap();
    let (first_name, first) = font_of(&glyphs, "L");
    let (second_name, second) = font_of(&glyphs, "S");
    assert_eq!(first_name, "AAAAAA+LiberationSans");
    assert_eq!(second_name, "AAAAAA+LiberationSans");
    assert!(!first.is_empty());
    assert_ne!(first, second);
    // Every letter of a word is in its word's font.
    assert_eq!(font_of(&glyphs, "s").1, second);
    assert_eq!(font_of(&glyphs, "b").1, first);

    // The programs carry the same ids as the glyphs drawn with them.
    let fonts = doc.embedded_fonts(0).unwrap();
    let programs: Vec<(&str, &str)> = fonts
        .iter()
        .map(|font| (font.name.as_str(), font.id.as_str()))
        .collect();
    assert_eq!(
        programs,
        [
            ("AAAAAA+LiberationSans", first.as_str()),
            ("AAAAAA+LiberationSans", second.as_str())
        ]
    );

    // Asked for by name, both come back rebuilt, each with its own letters.
    let rebuilt: Vec<(String, String)> = doc
        .font_outlines(0, &["AAAAAA+LiberationSans".to_string()])
        .unwrap()
        .into_iter()
        .map(|font| {
            let chars = font
                .glyphs
                .iter()
                .map(|g| char::from_u32(g.unicode).unwrap())
                .collect();
            (font.id, chars)
        })
        .collect();
    assert_eq!(
        rebuilt,
        [
            (first, "Liberaton".to_string()),
            (second, "Sans".to_string())
        ]
    );
}

#[test]
fn a_font_is_known_by_its_program_in_any_file() {
    // An edit box saved with a font's id must find that font again when the
    // file is reopened, and after a merge copies its pages into another file.
    // pdf-lib subsets "Liberaton" from Liberation Sans the same way in both
    // fixtures, so the programs are byte for byte the same.
    let merged = core().open(fixture("font-subsets.pdf"), None).unwrap();
    let source = core().open(fixture("embedded-fonts.pdf"), None).unwrap();
    let in_merged = font_of(&merged.chars(0, MAX_PAGE_CHARS).unwrap(), "L").1;
    let in_source = font_of(&source.chars(0, MAX_PAGE_CHARS).unwrap(), "L").1;
    assert_eq!(in_merged, in_source);
    // A font the file does not embed has no program, and no id.
    let helvetica = font_of(&source.chars(0, MAX_PAGE_CHARS).unwrap(), "H");
    assert_eq!(helvetica, ("Helvetica".to_string(), String::new()));
}

#[test]
fn dictionaries_sharing_a_program_keep_their_own_glyphs() {
    // Three dictionaries share one Foxit Serif program, as pdfTeX shares a
    // Type 1 file across encodings (audit B108). Each sets an "a" with its
    // own glyph: the program's a, its A (as small caps would) and its e at
    // a's width. A face rebuilt for one must not stand in for another.
    let doc = core().open(fixture("shared-program.pdf"), None).unwrap();
    let glyphs = doc.chars(0, MAX_PAGE_CHARS).unwrap();
    let ids: Vec<String> = glyphs
        .iter()
        .filter(|g| g.text == "a")
        .map(|g| {
            assert_eq!(g.font_name, "FoxitSerif");
            g.font_id.clone()
        })
        .collect();
    let [plain, caps, swap] = <[String; 3]>::try_from(ids).unwrap();
    assert!(!plain.is_empty());
    assert_ne!(plain, caps);
    assert_ne!(plain, swap);
    assert_ne!(caps, swap);
    // The ids are the font's, not the page's: the same on every read.
    let again = doc.chars(0, MAX_PAGE_CHARS).unwrap();
    assert_eq!(font_of(&again, "A").1, plain);

    // The programs carry the same ids as the glyphs drawn with them.
    let fonts = doc.embedded_fonts(0).unwrap();
    let embedded: Vec<&str> = fonts.iter().map(|font| font.id.as_str()).collect();
    assert_eq!(embedded, [plain.as_str(), caps.as_str(), swap.as_str()]);
    assert!(fonts.iter().all(|font| font.data == fonts[0].data));

    // Rebuilt by name, each dictionary's "a" is the glyph it draws.
    let rebuilt = doc.font_outlines(0, &["FoxitSerif".to_string()]).unwrap();
    let glyph = |id: &str, unicode: char| {
        let font = rebuilt.iter().find(|font| font.id == id).unwrap();
        let glyph = font.glyphs.iter().find(|g| g.unicode == unicode as u32);
        let glyph = glyph.unwrap();
        (glyph.advance.round(), glyph.path.clone())
    };
    assert_eq!(rebuilt.len(), 3);
    assert_eq!(glyph(&caps, 'a'), glyph(&plain, 'A'));
    assert_eq!(glyph(&swap, 'a'), glyph(&plain, 'e'));
    assert_eq!(glyph(&swap, 'a').0, glyph(&plain, 'a').0);
    assert_ne!(glyph(&swap, 'a').1, glyph(&plain, 'a').1);
}

/// The id of the font each glyph `text` is drawn with, in page order.
fn ids_of(glyphs: &[shiori_core::TextChar], text: &str) -> Vec<String> {
    glyphs
        .iter()
        .filter(|g| g.text == text)
        .map(|g| g.font_id.clone())
        .collect()
}

#[test]
fn dictionaries_drawing_mirrored_glyphs_differ() {
    // Two dictionaries share Foxit Serif and both set "<", one with the
    // program's less and one with its greater (audit B108): one width, one
    // segment count, one set of bounds, mirrored. A face rebuilt for one
    // would draw the other's "<" pointing the wrong way.
    let doc = core()
        .open(fixture("shared-program-beyond.pdf"), None)
        .unwrap();
    let glyphs = doc.chars(0, MAX_PAGE_CHARS).unwrap();
    let [plain, greater] = <[String; 2]>::try_from(ids_of(&glyphs, "<")).unwrap();
    assert_ne!(plain, greater);

    let rebuilt = doc.font_outlines(0, &["FoxitSerif".to_string()]).unwrap();
    let path = |id: &str, unicode: char| {
        let font = rebuilt.iter().find(|font| font.id == id).unwrap();
        let glyph = font.glyphs.iter().find(|g| g.unicode == unicode as u32);
        glyph.unwrap().path.clone()
    };
    assert_eq!(path(&greater, '<'), path(&plain, '>'));
    assert_ne!(path(&greater, '<'), path(&plain, '<'));
}
