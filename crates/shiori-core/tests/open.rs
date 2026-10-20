//! Opening documents with a password. Run with `bun run test:core`, which
//! fetches the pinned PDFium first.

use std::path::PathBuf;

use shiori_core::{Core, CoreError};

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

#[test]
fn a_password_with_a_nul_in_it_is_wrong_not_a_crash() {
    // The password dialog and the CLI pass on whatever was typed or pasted;
    // PDFium takes a C string, which cannot hold a NUL. locked.pdf opens
    // with "shiori", and no prefix of what was typed may stand in for it.
    let bytes =
        std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/locked.pdf"))
            .unwrap();
    for password in ["shiori\0", "shiori\0typed", "\0"] {
        let error = core().open(bytes.clone(), Some(password)).err();
        assert_eq!(error, Some(CoreError::Password), "{password:?}");
    }
    assert!(core().open(bytes, Some("shiori")).is_ok());
}
