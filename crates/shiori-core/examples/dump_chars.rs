//! Prints every page's characters as JSON, for inspecting PDFium's text
//! geometry by hand.
//! Run: cargo run --example dump_chars -- <pdfium lib dir> <file.pdf>

use std::fmt::Write;
use std::path::Path;

use shiori_core::Core;

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => write!(out, "\\u{:04x}", c as u32).unwrap(),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, lib, file] = args.as_slice() else {
        eprintln!("usage: dump_chars <pdfium lib dir> <file.pdf>");
        std::process::exit(2);
    };
    let core = Core::bind(Path::new(lib)).expect("bind PDFium");
    let doc = core
        .open(std::fs::read(file).expect("read PDF"), None)
        .expect("open PDF");
    let mut out = String::from("[");
    for index in 0..doc.page_count() {
        let geometry = doc.page_geometry(index).expect("page geometry");
        if index > 0 {
            out.push(',');
        }
        write!(
            out,
            "{{\"page\":{},\"height\":{},\"chars\":[",
            index + 1,
            geometry.height
        )
        .unwrap();
        for (i, ch) in doc
            .chars(index, shiori_core::MAX_PAGE_CHARS)
            .expect("chars")
            .iter()
            .enumerate()
        {
            if i > 0 {
                out.push(',');
            }
            write!(
                out,
                "{{\"text\":{},\"origin\":[{},{}],\"end\":[{},{}],\"loose\":[{},{},{},{}],\"angle\":{},\"generated\":{},\"hyphen\":{},\"font\":{},\"flags\":{},\"ascent\":{},\"descent\":{}}}",
                json_string(&ch.text),
                ch.origin.0,
                ch.origin.1,
                ch.end.0,
                ch.end.1,
                ch.loose.left,
                ch.loose.bottom,
                ch.loose.right,
                ch.loose.top,
                ch.angle,
                ch.generated,
                ch.hyphen,
                json_string(&ch.font_name),
                ch.font_flags,
                ch.ascent,
                ch.descent
            )
            .unwrap();
        }
        out.push_str("]}");
    }
    out.push(']');
    println!("{out}");
}
