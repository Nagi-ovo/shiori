# Third-party notices

Shiori is Copyright (c) 2026 Jesse Zhang (Nagi-ovo). Its source code is
licensed under the MIT license in `LICENSE`, with these exceptions: the
Shiori and 栞 names, logo, app icons and brand artwork are not licensed under
MIT (see `TRADEMARK.md`); the documentation prose in `docs/` is licensed under
CC BY 4.0 (see `docs/LICENSE`); and the third-party files and packages listed
below stay under their own licenses.

## CodeMirror packages

The Markdown live editor and the highlighting of code blocks in Markdown
documents (each language loads only when a document uses it) use these
packages in the bundled JavaScript.

Packages:

- `@codemirror/state`
- `@codemirror/view`
- `@codemirror/commands`
- `@codemirror/language`
- `@codemirror/lang-markdown`
- `@codemirror/autocomplete`
- `@codemirror/lang-html`
- `@codemirror/lang-css`
- `@codemirror/lang-javascript`
- `@codemirror/lint`
- `@codemirror/language-data`
- `@codemirror/legacy-modes`
- `@codemirror/lang-angular`, `lang-cpp`, `lang-go`, `lang-java`,
  `lang-jinja`, `lang-json`, `lang-less`, `lang-liquid`, `lang-php`,
  `lang-python`, `lang-rust`, `lang-sass`, `lang-sql`, `lang-vue`,
  `lang-wast`, `lang-xml`, `lang-yaml`
- `@lezer/common`
- `@lezer/highlight`
- `@lezer/lr`
- `@lezer/markdown`
- `@lezer/html`
- `@lezer/css`
- `@lezer/javascript`
- `@lezer/cpp`, `go`, `java`, `json`, `php`, `python`, `rust`, `sass`, `xml`,
  `yaml`
- `@marijn/find-cluster-break`
- `crelt`
- `style-mod`
- `w3c-keyname`

License: MIT

Copyright notices:

- CodeMirror packages: Copyright (C) 2018-2021 by Marijn Haverbeke
  <marijn@haverbeke.berlin> and others
- Lezer packages (common, highlight, lr and the language grammars above):
  Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
- `@codemirror/legacy-modes`: Copyright (C) 2018-2021 by Marijn Haverbeke
  <marijn@haverbeke.berlin> and others
- `@lezer/markdown`: Copyright (C) 2020 by Marijn Haverbeke
  <marijn@haverbeke.berlin> and others
- `@marijn/find-cluster-break`: Copyright (C) 2024 by Marijn Haverbeke
  <marijn@haverbeke.berlin>
- `crelt`: Copyright (C) 2020 by Marijn Haverbeke
  <marijn@haverbeke.berlin>
- `style-mod`: Copyright (C) 2018 by Marijn Haverbeke
  <marijn@haverbeke.berlin> and others
- `w3c-keyname`: Copyright (C) 2016 by Marijn Haverbeke
  <marijn@haverbeke.berlin> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## PDFium

The desktop app draws PDF pages with PDFium (chromium/7881, the
bblanchon/pdfium-binaries build fetched by `scripts/pdfium/fetch.ts`), shipped
beside the app: in
`Contents/Frameworks` on macOS and in the `pdfium` resource folder on Windows
and Linux. PDFium is BSD-3-Clause; it bundles FreeType, ICU, Abseil,
llvm-libc, Anti-Grain Geometry 2.3, fast_float, Little CMS, libjpeg-turbo,
OpenJPEG, libpng, libtiff, simdutf and zlib under their own terms. The full
texts ship in the app's `licenses/pdfium/` resource folder.

Portions of this software are copyright © The FreeType Project
(www.freetype.org). All rights reserved.

The Rust crate `pdfium-render` (MIT OR Apache-2.0) loads it.

The web and mobile builds run the same PDFium compiled to WebAssembly (the
bblanchon/pdfium-binaries wasm build, same licenses less llvm-libc) together
with Shiori's reading core compiled from Rust. Their texts ship in the web
build's `licenses/pdfium/` folder, and the Rust crates in that core (among
them `pdfium-render` and `wasm-bindgen`, MIT OR Apache-2.0) in
`licenses/rust-crates-NOTICES.txt`. On those builds the app also reads the
Noto Sans SC and JP fonts it bundles (SIL Open Font License 1.1, see
`src/assets/fonts/README.md`) as PDFium's fallback for text in fonts a PDF
does not embed.

## opentype.js

When a PDF embeds a font the browser will not load as filed (bare CFF, Type 1,
a stripped TrueType subset), the app rebuilds it from the glyphs PDFium draws
and writes it as OpenType with opentype.js 2.0.0 (MIT, Copyright (c) 2020
Frederik De Bleser), which inlines tiny-inflate 1.0.3 (MIT, Copyright (c)
2015-present Devon Govett).

The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## PDF.js

`src/pdf/render/textLayer.ts` is a port of PDF.js's TextLayer
(`src/display/text_layer.js`, mozilla/pdf.js), Copyright Mozilla Foundation,
licensed under the Apache License 2.0. The port folds page rotation into the
span layout and takes Shiori's engine-neutral page text.
`src/pdf/import/sourceAnnotations.ts` follows PDF.js's annotation parsing
(`src/core/annotation.js`, `default_appearance.js`, `colorspace.js`,
`core_utils.js`) and carries its DeviceCMYK conversion polynomial and
`stringToPDFString` decoding, under the same copyright and license. Neither the
app nor the Shiori CLI bundles PDF.js itself; the CLI carries the annotation
port (see `cli/THIRD_PARTY_NOTICES.md`).

## Word editor (@docx-editor.dev)

The Word view is `@docx-editor.dev/core`, `react`, `i18n` and `fonts`,
Apache-2.0. Their builds include harfbuzzjs (MIT) and a prebuilt HarfBuzz
wasm ("Old MIT" license), and the fonts package ships metric-compatible
document fonts: Caladea and Carlito (OFL-1.1), Liberation Sans, Serif and
Mono (OFL-1.1) and TeX Gyre Adventor (GUST Font License). Each package's
LICENSE, THIRD_PARTY_NOTICES.md and license texts ship unchanged under
`licenses/docx-editor/<package>/` in the built app.

## Fonts

The app bundles these fonts. All except the Nerd Fonts symbols are licensed
under the SIL Open Font License 1.1, whose full text follows this list.

- Noto Sans SC and Noto Sans JP (`src/assets/fonts/NotoSans*-Regular.otf`,
  the noto-cjk SubsetOTF builds, version 2.004): © 2014-2021 Adobe
  (http://www.adobe.com/). Used for PDF export and as PDFium's fallback on
  the web and mobile builds.
- Klee One Regular and SemiBold (`src/assets/fonts/ui/KleeOne-*-brand-subset.woff2`,
  subsets of version 1.100 made by `scripts/subset-brand-fonts.ts`):
  Copyright 2020 The Klee Project Authors
  (https://github.com/fontworks-fonts/Klee).
- Shippori Mincho Regular (`src/assets/fonts/ui/ShipporiMincho-Regular-brand-subset.woff2`,
  a subset of version 3.110 made by the same script): Copyright 2021 The
  Shippori Mincho Project Authors (https://github.com/fontdasu/ShipporiMincho).
- Liberation Serif, Sans and Mono Regular (`src/assets/fonts/metric/`,
  version 2.1.5 converted to WOFF2): Digitized data copyright (c) 2010 Google
  Corporation, with Reserved Font Arimo, Tinos and Cousine; Copyright (c) 2012
  Red Hat, Inc., with Reserved Font Name Liberation
  (`src/assets/fonts/metric/LICENSE-liberation.txt`).
- Inter Tight (`@fontsource/inter-tight`, Latin and Latin Extended subsets):
  Copyright 2022 The Inter Project Authors (https://github.com/rsms/inter-tight).
- Instrument Serif (`@fontsource/instrument-serif`, Latin and Latin Extended
  subsets): Copyright 2022 The Instrument Serif Project Authors
  (https://github.com/Instrument/instrument-serif).
- JetBrains Mono (`@fontsource/jetbrains-mono`, Latin and Latin Extended
  subsets): Copyright 2020 The JetBrains Mono Project Authors
  (https://github.com/JetBrains/JetBrainsMono).
- Symbols Nerd Font Mono (`src/assets/fonts/ui/SymbolsNerdFontMono-Regular.woff2`,
  Nerd Fonts 3.4.0 SymbolsOnly converted to WOFF2), the embedded terminal's
  symbol fallback: Copyright (c) 2014 Ryan L McIntyre, MIT. Nerd Fonts
  aggregates glyphs from several icon sets under their own licenses; the
  upstream license, license audit and conversion notice sit beside the font
  (`LICENSE-nerd-fonts-symbols.txt`, `nerd-fonts-license-audit.md`,
  `NOTICE-nerd-fonts-symbols.md` in `src/assets/fonts/ui/`).

Klee One and Shippori Mincho are subset to the glyphs of the Shiori wordmark
and the 栞 mark. The Nerd Fonts, Noto and Liberation files are format
conversions or upstream subsets; none of the fonts is otherwise modified.

```text
-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font
creation efforts of academic and linguistic communities, and to
provide a free and open framework in which fonts may be shared and
improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to
any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software
components as distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to,
deleting, or substituting -- in part or in whole -- any of the
components of the Original Version, by changing formats or by porting
the Font Software to a new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed,
modify, redistribute, and sell modified and unmodified copies of the
Font Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the
corresponding Copyright Holder. This restriction only applies to the
primary font name as presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) shall not
be used to promote, endorse or advertise any Modified Version, except
to acknowledge the contribution(s) of the Copyright Holder(s) and the
Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created using
the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## Everforest

The Everforest theme's light and dark palettes (`src/design/theme.ts`) are
adapted from Everforest by sainnhe (https://github.com/sainnhe/everforest),
Copyright (c) 2019 sainnhe, MIT License (text as in the CodeMirror section
above).

## WebGL Fluid Simulation

The ink animation's fluid solver (`src/brand/fluid/simulation.ts`) is a
trimmed port of WebGL-Fluid-Simulation
(https://github.com/PavelDoGreat/WebGL-Fluid-Simulation), Copyright (c) 2017
Pavel Dobryakov, MIT License (text as in the CodeMirror section above; the
file also carries it in its header).

## Tao and Wry

The desktop and Android builds compile patched copies of Tao 0.35.3 and Wry
0.55.1 from `src-tauri/patches/`, Copyright The Tauri Programme within The
Commons Conservancy (and, for Tao, The winit contributors). Tao is licensed
under the Apache License 2.0 (`src-tauri/patches/tao-0.35.3/LICENSE`); Wry
under Apache-2.0 OR MIT (`src-tauri/patches/wry-0.55.1/LICENSE-APACHE`,
`LICENSE-MIT`). Shiori modified a few files in each (event delivery on
Android, early `Opened` events on macOS); every modified file says so in its
header, and the reasons are recorded in `docs/POSTMORTEMS.md`.
