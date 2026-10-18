// Relative images in Markdown/HTML documents. The preview asks for each
// `<img src>` relative to the open document; this resolves it inside the
// document's own directory (no absolute paths, URLs or symlink escapes),
// checks the bytes are the raster format the extension claims, and returns
// a data URL. SVG is refused.

#[cfg(not(mobile))]
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use serde::Serialize;
#[cfg(not(mobile))]
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{Runtime, Webview};

#[cfg(not(mobile))]
use super::validate_text_document_path;
use crate::enforce_main_webview;
#[cfg(not(mobile))]
use crate::runtime_guard::enforce_runtime_guard;

const MAX_TEXT_DOCUMENT_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextDocumentImageResource {
    data_url: String,
    mime: String,
    size: u64,
}

#[cfg(not(mobile))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TextDocumentImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
    Avif,
}

#[cfg(not(mobile))]
impl TextDocumentImageFormat {
    fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Avif => "image/avif",
        }
    }
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) async fn read_text_document_relative_image<R: Runtime>(
    caller: Webview<R>,
    document_path: String,
    image_src: String,
) -> Result<TextDocumentImageResource, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    read_text_document_relative_image_resource(Path::new(&document_path), &image_src)
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) async fn read_text_document_relative_image<R: Runtime>(
    caller: Webview<R>,
    _document_path: String,
    _image_src: String,
) -> Result<TextDocumentImageResource, String> {
    enforce_main_webview(&caller)?;
    Err("image-resource-unsupported".into())
}

#[cfg(not(mobile))]
fn read_text_document_relative_image_resource(
    document_path: &Path,
    image_src: &str,
) -> Result<TextDocumentImageResource, String> {
    validate_text_document_path(document_path)?;
    let document_dir = document_path
        .parent()
        .ok_or_else(|| "document-directory-unavailable".to_string())?;
    let document_root =
        fs::canonicalize(document_dir).map_err(|_| "document-directory-unavailable".to_string())?;
    let (relative_path, expected_format) = resolve_relative_image_src(image_src)?;
    let image_path = document_dir.join(relative_path);
    let link_metadata =
        fs::symlink_metadata(&image_path).map_err(|_| "image-unavailable".to_string())?;
    if link_metadata.file_type().is_dir() {
        return Err("image-not-file".into());
    }
    let canonical_image =
        fs::canonicalize(&image_path).map_err(|_| "image-unavailable".to_string())?;
    if !canonical_image.starts_with(&document_root) {
        return Err("image-path-escape".into());
    }
    let metadata = fs::metadata(&canonical_image).map_err(|_| "image-unavailable".to_string())?;
    if !metadata.is_file() {
        return Err("image-not-file".into());
    }
    let size = metadata.len();
    if size > MAX_TEXT_DOCUMENT_IMAGE_BYTES {
        return Err("image-too-large".into());
    }
    let bytes = fs::read(&canonical_image).map_err(|_| "image-unavailable".to_string())?;
    let size = bytes.len() as u64;
    if size > MAX_TEXT_DOCUMENT_IMAGE_BYTES {
        return Err("image-too-large".into());
    }
    let actual_format = sniff_text_document_image_format(&bytes)
        .ok_or_else(|| "image-type-mismatch".to_string())?;
    if actual_format != expected_format {
        return Err("image-type-mismatch".into());
    }
    let mime = expected_format.mime();
    Ok(TextDocumentImageResource {
        data_url: format!("data:{mime};base64,{}", BASE64_STANDARD.encode(bytes)),
        mime: mime.to_string(),
        size,
    })
}

#[cfg(not(mobile))]
fn resolve_relative_image_src(
    image_src: &str,
) -> Result<(PathBuf, TextDocumentImageFormat), String> {
    let src = image_src.trim();
    let path_part = src.split(['?', '#']).next().unwrap_or("").trim();
    if path_part.is_empty() {
        return Err("image-src-empty".into());
    }
    reject_absolute_or_url_like_image_src(path_part)?;
    let decoded = percent_decode_url_path(path_part)?;
    reject_absolute_or_url_like_image_src(&decoded)?;
    if decoded.contains('\0') {
        return Err("image-src-invalid".into());
    }

    let mut relative = PathBuf::new();
    for segment in decoded.split(['/', '\\']) {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err("image-path-escape".into());
        }
        relative.push(segment);
    }
    if relative.as_os_str().is_empty() {
        return Err("image-src-empty".into());
    }
    let format = relative
        .extension()
        .and_then(|ext| ext.to_str())
        .and_then(image_format_for_extension)
        .ok_or_else(|| "unsupported-image".to_string())?;
    Ok((relative, format))
}

#[cfg(not(mobile))]
fn reject_absolute_or_url_like_image_src(src: &str) -> Result<(), String> {
    if src.starts_with('/')
        || src.starts_with('\\')
        || src.starts_with("//")
        || src.starts_with("\\\\")
        || Path::new(src).is_absolute()
    {
        return Err("image-src-absolute".into());
    }
    if has_url_scheme(src) {
        return Err("image-src-url".into());
    }
    Ok(())
}

#[cfg(not(mobile))]
fn has_url_scheme(src: &str) -> bool {
    let Some(colon) = src.find(':') else {
        return false;
    };
    if src
        .find(['/', '\\', '?', '#'])
        .is_some_and(|separator| separator < colon)
    {
        return false;
    }
    let scheme = &src[..colon];
    let mut chars = scheme.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}

#[cfg(not(mobile))]
fn percent_decode_url_path(src: &str) -> Result<String, String> {
    let bytes = src.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("image-src-invalid".into());
            }
            let high = decode_hex_digit(bytes[index + 1]).ok_or("image-src-invalid")?;
            let low = decode_hex_digit(bytes[index + 2]).ok_or("image-src-invalid")?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "image-src-invalid".to_string())
}

#[cfg(not(mobile))]
fn decode_hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(not(mobile))]
fn image_format_for_extension(ext: &str) -> Option<TextDocumentImageFormat> {
    match ext.to_ascii_lowercase().as_str() {
        "avif" => Some(TextDocumentImageFormat::Avif),
        "gif" => Some(TextDocumentImageFormat::Gif),
        "jpg" | "jpeg" => Some(TextDocumentImageFormat::Jpeg),
        "png" => Some(TextDocumentImageFormat::Png),
        "webp" => Some(TextDocumentImageFormat::Webp),
        _ => None,
    }
}

#[cfg(not(mobile))]
fn sniff_text_document_image_format(bytes: &[u8]) -> Option<TextDocumentImageFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(TextDocumentImageFormat::Png);
    }
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return Some(TextDocumentImageFormat::Jpeg);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(TextDocumentImageFormat::Gif);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(TextDocumentImageFormat::Webp);
    }
    if is_avif_bytes(bytes) {
        return Some(TextDocumentImageFormat::Avif);
    }
    None
}

#[cfg(not(mobile))]
fn is_avif_bytes(bytes: &[u8]) -> bool {
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return false;
    }

    if is_avif_brand(&bytes[8..12]) {
        return true;
    }

    if bytes.len() < 20 {
        return false;
    }

    let box_size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let end = if box_size >= 16 && box_size <= bytes.len() {
        box_size
    } else {
        bytes.len().min(64)
    };

    bytes[16..end].chunks_exact(4).any(is_avif_brand)
}

#[cfg(not(mobile))]
fn is_avif_brand(brand: &[u8]) -> bool {
    brand == b"avif" || brand == b"avis"
}

#[cfg(test)]
mod tests {
    #[cfg(not(mobile))]
    use crate::documents::text_image_test_dir;
    #[cfg(not(mobile))]
    use std::fs;

    #[cfg(not(mobile))]
    const PNG_1X1_BYTES: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, b'I', b'H', b'D',
        b'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, b'I', b'D', b'A', b'T', 0x78, 0x9c, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, b'I',
        b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82,
    ];

    #[cfg(not(mobile))]
    const SVG_BYTES: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg"></svg>"#;

    #[test]
    #[cfg(not(mobile))]
    fn read_text_document_relative_image_reads_data_url_from_document_dir() {
        let dir = text_image_test_dir("reads-data-url");
        fs::create_dir_all(dir.join("assets")).unwrap();
        let document = dir.join("note.md");
        fs::write(&document, b"# Note").unwrap();
        fs::write(dir.join("assets/pixel one.PNG"), PNG_1X1_BYTES).unwrap();

        let resource = super::read_text_document_relative_image_resource(
            &document,
            "assets/pixel%20one.PNG?cache=1#frag",
        )
        .unwrap();

        assert_eq!(resource.mime, "image/png");
        assert_eq!(resource.size, PNG_1X1_BYTES.len() as u64);
        assert!(resource.data_url.starts_with("data:image/png;base64,"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    #[cfg(not(mobile))]
    fn read_text_document_relative_image_rejects_unsafe_sources() {
        let dir = text_image_test_dir("rejects-unsafe");
        let document = dir.join("note.html");
        fs::write(&document, b"<p>Note</p>").unwrap();
        fs::write(dir.join("ok.png"), PNG_1X1_BYTES).unwrap();

        for (src, expected) in [
            ("https://example.com/pic.png", "image-src-url"),
            ("//example.com/pic.png", "image-src-absolute"),
            ("/tmp/pic.png", "image-src-absolute"),
            ("..%2fsecret.png", "image-path-escape"),
            ("../secret.png", "image-path-escape"),
            ("ok.txt", "unsupported-image"),
            ("ok.svg", "unsupported-image"),
            ("bad%zz.png", "image-src-invalid"),
        ] {
            let err =
                super::read_text_document_relative_image_resource(&document, src).expect_err(src);
            assert_eq!(err, expected, "unexpected error for {src}");
        }

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    #[cfg(not(mobile))]
    fn read_text_document_relative_image_rejects_svg_and_spoofed_extensions() {
        let dir = text_image_test_dir("rejects-spoofed");
        let document = dir.join("note.md");
        fs::write(&document, b"# Note").unwrap();
        fs::write(dir.join("vector.svg"), SVG_BYTES).unwrap();
        fs::write(dir.join("vector.png"), SVG_BYTES).unwrap();
        fs::write(dir.join("pixel.jpg"), PNG_1X1_BYTES).unwrap();

        let svg_err = super::read_text_document_relative_image_resource(&document, "vector.svg")
            .expect_err("svg extension should not be supported");
        assert_eq!(svg_err, "unsupported-image");

        let svg_as_png_err =
            super::read_text_document_relative_image_resource(&document, "vector.png")
                .expect_err("svg bytes with png extension should be rejected");
        assert_eq!(svg_as_png_err, "image-type-mismatch");

        let png_as_jpeg_err =
            super::read_text_document_relative_image_resource(&document, "pixel.jpg")
                .expect_err("png bytes with jpeg extension should be rejected");
        assert_eq!(png_as_jpeg_err, "image-type-mismatch");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    #[cfg(not(mobile))]
    fn read_text_document_relative_image_rejects_directories_and_large_files() {
        let dir = text_image_test_dir("rejects-file-shape");
        let document = dir.join("note.md");
        fs::write(&document, b"# Note").unwrap();
        fs::create_dir(dir.join("folder.png")).unwrap();
        let large_image = dir.join("large.jpg");
        let large = fs::File::create(&large_image).unwrap();
        large
            .set_len(super::MAX_TEXT_DOCUMENT_IMAGE_BYTES + 1)
            .unwrap();

        let directory_err =
            super::read_text_document_relative_image_resource(&document, "folder.png")
                .expect_err("directory should not be readable as an image");
        assert_eq!(directory_err, "image-not-file");

        let large_err = super::read_text_document_relative_image_resource(&document, "large.jpg")
            .expect_err("oversized image should not be read");
        assert_eq!(large_err, "image-too-large");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    #[cfg(all(not(mobile), unix))]
    fn read_text_document_relative_image_rejects_symlink_escape() {
        let dir = text_image_test_dir("rejects-symlink");
        let outside = text_image_test_dir("outside-symlink-target");
        fs::create_dir_all(dir.join("assets")).unwrap();
        let document = dir.join("note.md");
        let outside_image = outside.join("secret.png");
        fs::write(&document, b"# Note").unwrap();
        fs::write(&outside_image, PNG_1X1_BYTES).unwrap();
        std::os::unix::fs::symlink(&outside_image, dir.join("assets/linked.png")).unwrap();

        let err = super::read_text_document_relative_image_resource(&document, "assets/linked.png")
            .expect_err("symlink outside document dir should be rejected");
        assert_eq!(err, "image-path-escape");

        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(outside);
    }
}
