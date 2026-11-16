//! Unknown CID values must not escape PDFium's Unicode-map-error slots as text.
use std::path::PathBuf;

use shiori_core::{Core, MAX_PAGE_CHARS};

fn cid_pdf(mapped: bool) -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>".to_string(),
        format!("<< /Type /Font /Subtype /Type0 /BaseFont /Unknown /Encoding /Identity-H /DescendantFonts [5 0 R] {} >>", if mapped { "/ToUnicode 7 0 R" } else { "" }),
        "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Unknown /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 600 >>".to_string(),
        stream("BT /F1 10 Tf 50 100 Td <12340041> Tj ET"),
        stream("/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Test def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange 2 beginbfchar <1234> <0058> <0041> <0059> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end"),
    ];
    let mut pdf = "%PDF-1.7\n".to_string();
    let mut offsets = vec![0];
    for (i, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.push_str(&format!("{} 0 obj\n{}\nendobj\n", i + 1, object));
    }
    let xref = pdf.len();
    pdf.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", offsets.len()));
    for offset in offsets.iter().skip(1) {
        pdf.push_str(&format!("{offset:010} 00000 n \n"));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
        offsets.len()
    ));
    pdf.into_bytes()
}

fn stream(body: &str) -> String {
    format!("<< /Length {} >>\nstream\n{body}\nendstream", body.len())
}

#[test]
fn map_errors_are_unknown_scalars_while_explicit_unicode_stays_text() {
    let path = std::env::var_os("SHIORI_PDFIUM_DIR")
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
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../vendor/pdfium")
                .join(format!("{os}-{cpu}"))
                .join(if os == "win" { "bin" } else { "lib" })
        });
    let core = Core::bind(&path).unwrap();
    for (mapped, expected) in [(false, "\u{fffd}\u{fffd}"), (true, "XY")] {
        let doc = core.open(cid_pdf(mapped), None).unwrap();
        let chars = doc.chars(0, MAX_PAGE_CHARS).unwrap();
        let physical: Vec<_> = chars.iter().filter(|ch| !ch.generated).collect();
        assert_eq!(
            physical
                .iter()
                .map(|ch| ch.text.as_str())
                .collect::<String>(),
            expected
        );
        assert_eq!(physical.len(), 2);
        assert!(physical[1].origin.0 > physical[0].origin.0);
    }
}
