# Surgical run and span compilation

`replaceRuns(content, resolvedSourceFonts, plan)` is a pure TypeScript compiler.
`replaceRunPage(page, plan)` resolves the immutable PDF revision and installs a
new stream only on success. `await replaceRunPageWithFallback(page, plan,
options?)` additionally prepares independent embedded subsets when source
coverage refuses a replacement. Existing source fonts and shared streams are
never extended or mutated. The async adapter checks content and all font /
marked-content resource dependencies again before installing its result.

An edit addresses source hash, font object/resource, operator, TJ item, and
`byteStart:byteEnd` in the **decoded string bytes**. `expected` must match exactly
that slice. Boundaries must align to source codes (one or two bytes). Multiple
non-overlapping spans within one item use original offsets and can arrive in
any order. A single span cannot cross TJ items; quotes (`'`, `"`), Forms,
vertical/Type3 fonts, semantic ActualText/Alt/E contexts and graphics-dependent
contexts explicitly refuse. MCID-only spans remain editable.

Each original prefix/suffix retains its original codes and advances; existing
TJ kern numbers remain in sequence. Each replacement ends with a TJ adjustment
of `newAdvance - oldAdvance`, including Tc, single-byte Tw and the original
font size. Tz and page transforms determine points along the baseline. The
text-line matrix, leading, rise and marked-content scope are preserved. Mixed
source/fallback shows switch Tf at the same size and restore the original Tf
before compensation and following text. Resource names are escaped as PDF
name bytes. Adjacent TJ fragments coalesce so identity rewrites retain native
raster behavior.

## Available space / overflow

Available space is conservatively the original span's advance in PDF
user-space points along its transformed baseline. Every other glyph on that
baseline whose origin is at or beyond the span start can reduce the slot,
regardless of paint order (including a positive TJ number that kerns backwards).
The addressed span's glyphs are excluded. Both page adapters accept
`edit.editBox: { x, y, w, h }` in PDF space and clamp `edit.availablePt` to its
width; an explicitly smaller availablePt remains in force. Extra whitespace beyond the original span is
not claimed automatically. This is an advance-based slot check, not an ink
bounding-box or paragraph-layout engine.

`neededPt` is the replacement advance in that same coordinate system. If it
exceeds the slot, the default is unchanged original bytes plus
`reason: 'replacement overflows available space'` and
`overflow: { availablePt, neededPt }`. `plan.allowOverflow: true` permits the
edit and still returns the first overflow measurement. Neighbours retain their
positions under either policy; callers choosing overflow own any overlap.

## Fallback fonts and embedding

Coverage is checked per whole replacement first. If it refuses, split by
grapheme and retain source encoding wherever possible. Only missing clusters
use a new resource. Font class comes from the source FontDescriptor flags
(including CID descendants) and BaseFont: Liberation Serif/Sans/Mono for
Times/Arial/Courier classes, with Bold/Italic/BoldItalic variants selected from
flags or the face name. Indirect Flags resolves to a PDFNumber. Noto Sans JP
serves kana and SC serves other Han text. No cap-height or glyph-size scaling
is applied.

The adapter builds subsets in a disposable PDF document, checks dictionary
widths, ToUnicode and actual program coverage, then copies reachable objects
into private page resources on success. fsType must be present and permit
editable embedding and subsetting: restricted, preview/print-only,
no-subsetting and bitmap-only fonts refuse. Unsupported fallback shaping
(multiple glyphs or offsets per grapheme) also refuses; this stage does not
provide general shaping, bidi or reflow. The optional `loadFont(name)` seam
supplies bytes in Bun/oracles; the default loads bundled Vite assets lazily.

Liberation subsets are Type0/Identity-H + CIDFontType2 + Identity CIDToGIDMap,
FontDescriptor/FontFile2, W and ToUnicode. Bundled Noto has CFF outlines and
uses the corresponding CIDFontType0 + FontFile3/CIDFontType0C representation,
as specified by the font strategy synthesis. CIDToGIDMap is omitted for CFF.
Widths are rounded to integer PDF em units because native PDFium reads CID W
as integers; both compiler and readers then use identical dictionary advances.

The default lazy loader reuses the exact twelve Liberation TTF assets already
shipped by `@docx-editor.dev/fonts` for DOCX, and the existing Noto URLs from
`fontAssets.ts`. Loaded bytes are cached by selected face. No extra font
programs are emitted; `checkFallbackAssets.ts` builds the real loader and
verifies all fourteen asset hashes against both their sources and the app
bundle. The dependency TTFs have even glyf offsets, so fontkit can subset them
without conversion or alignment repair.

The pinned fontkit CFF writer emits a top-DICT length as header offSize
(24 for Noto). The adapter replaces it with the emitted Name INDEX offSize,
validates that value is 1–4, then verifies coverage and native output.

Font sources and OFL terms are recorded in the fonts README and
THIRD_PARTY_NOTICES.md. Native acceptance runs through
`bun scripts/pdf-inplace/surgical-first.ts`; artifacts and rerun instructions
are under `test-artifacts/pdf-inplace/surgical-first/`.
