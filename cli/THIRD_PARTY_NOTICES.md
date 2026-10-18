# Third-party notices

Shiori CLI itself is free software under the MIT License; see the adjacent
`LICENSE` file. Its release package contains or bundles the following
third-party components under their own licenses.
Corresponding license texts are included in the adjacent `licenses/` folder.

| Component | License | Purpose |
| --- | --- | --- |
| Node.js runtime | Node.js license and bundled third-party notices | Standalone JavaScript runtime |
| PDF.js / `pdfjs-dist` | Apache-2.0 | PDF parsing and text extraction |
| `@napi-rs/canvas` + platform binding | MIT | Packaged PDF page rasterization |
| PDF.js CMaps | BSD-style terms in upstream file | CJK character maps |
| PDF.js Foxit/Liberation fonts | Upstream terms in included files | Standard PDF font fallback |
| OpenJPEG, JBIG2, QCMS and PDF.js WASM glue | Upstream licenses in included files | Image/color decoding |
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

The fontkit bundle retains code derived from Node contributors,
`base64-arraybuffer`, and Google Brotli. Their copyright notices are preserved
in `licenses/fontkit-bundled-NOTICES.txt`; the complete Apache-2.0 terms are in
`licenses/Apache-2.0.txt`.

Portions of this software are copyright © The FreeType Project
(www.freetype.org). All rights reserved. FreeType is included in PDFium under
the FreeType License; see `licenses/pdfium/freetype.txt`.
