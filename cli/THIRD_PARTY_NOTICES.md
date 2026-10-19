# Third-party notices

Shiori CLI itself is free software under the MIT License; see the adjacent
`LICENSE` file. Its release package contains or bundles the following
third-party components under their own licenses.
Corresponding license texts are included in the adjacent `licenses/` folder.

| Component | License | Purpose |
| --- | --- | --- |
| Node.js runtime | Node.js license and bundled third-party notices | Standalone JavaScript runtime |
| Code ported from PDF.js (Copyright Mozilla Foundation) | Apache-2.0 | Annotation import, see below |
| `pdf-lib` | MIT | PDF writing |
| `@pdf-lib/fontkit` and bundled helpers | MIT / Apache-2.0 | Font parsing and WOFF2 decoding |
| `@pdf-lib/standard-fonts` | MIT | Standard font metrics |
| `@pdf-lib/upng` | MIT | PNG decoding |
| `pako` | MIT / Zlib | Deflate support |
| `parse5` | MIT | Safe static HTML parsing |
| `entities` | BSD-2-Clause | HTML entity decoding used by parse5 |
| `nanoid` | MIT | Imported annotation identifiers |
| `tslib` | 0BSD | TypeScript runtime helpers |
| Noto Sans CJK SC/JP | SIL Open Font License 1.1 | CJK PDF export |
| PDFium (pdfium-binaries build) and its bundled libraries | BSD-3-Clause, FreeType License, Unicode License v3, Apache-2.0 and others in `licenses/pdfium/` | PDF reading through `native/` (shiori-core) |
| Rust crates in the shiori-core addon | MIT / Apache-2.0 / ISC / Zlib / Unlicense | Node binding and PDFium FFI; see `licenses/rust-crates-NOTICES.txt` |

The Noto font files are distributed as fonts, not relicensed as part of the
Shiori CLI. They may not be sold by themselves. See
`licenses/Noto-CJK-OFL-1.1.txt`.

Shiori's annotation import (`src/pdf/import/sourceAnnotations.ts`) follows
PDF.js's annotation parsing (`src/core/annotation.js`, `default_appearance.js`,
`colorspace.js`, `core_utils.js`, mozilla/pdf.js) and carries its DeviceCMYK
conversion polynomial and `stringToPDFString` decoding, Copyright Mozilla
Foundation, under the Apache License 2.0 (`licenses/Apache-2.0.txt`). PDF.js
itself is not bundled.

The fontkit bundle retains code derived from Node contributors,
`base64-arraybuffer`, and Google Brotli. Their copyright notices are preserved
in `licenses/fontkit-bundled-NOTICES.txt`; the complete Apache-2.0 terms are in
`licenses/Apache-2.0.txt`.

Portions of this software are copyright © The FreeType Project
(www.freetype.org). All rights reserved. FreeType is included in PDFium under
the FreeType License; see `licenses/pdfium/freetype.txt`.
