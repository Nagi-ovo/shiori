# Export Fonts

These unmodified official notofonts fonts are bundled for PDF export.
SC/JP Regular also serve the existing web/mobile PDFium fallback. All eight fonts
are licensed under the SIL Open Font License 1.1.

| File | Bytes | Pinned official source |
| --- | ---: | --- |
| NotoSansSC-Regular.otf (existing) | 8,331,336 | [noto-cjk SC SubsetOTF](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf) |
| NotoSansJP-Regular.otf (existing) | 4,533,028 | [noto-cjk JP SubsetOTF](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf) |
| NotoSansKR-Regular.otf | 4,644,748 | [noto-cjk KR SubsetOTF](https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf) |
| NotoSansSC-Bold.otf | 8,543,168 | [noto-cjk SC Bold SubsetOTF](https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/SC/NotoSansSC-Bold.otf) |
| NotoSansJP-Bold.otf | 4,656,448 | [noto-cjk JP Bold SubsetOTF](https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/JP/NotoSansJP-Bold.otf) |
| NotoSansKR-Bold.otf | 4,816,044 | [noto-cjk KR Bold SubsetOTF](https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/KR/NotoSansKR-Bold.otf) |
| NotoSansMath-Regular.ttf | 990,564 | [math NotoSansMath-v3.000 release](https://github.com/notofonts/math/releases/download/NotoSansMath-v3.000/NotoSansMath-v3.000.zip), `NotoSansMath/hinted/ttf/NotoSansMath-Regular.ttf` |
| NotoSansSymbols2-Regular.ttf | 671,568 | [symbols NotoSansSymbols2-v2.008 release](https://github.com/notofonts/symbols/releases/download/NotoSansSymbols2-v2.008/NotoSansSymbols2-v2.008.zip), `NotoSansSymbols2/hinted/ttf/NotoSansSymbols2-Regular.ttf` |

CJK is pinned at commit `f8d157532fbfaeda587e826d4cd5b21a49186f7c`
(Sans 2.004). The existing SC/JP bytes were compared against that official
commit and are identical. Math's release tag resolves to commit
`00e9941d95b2a355399a66f3990ffde6e4985676`; Symbols 2's tag resolves to
`25b00f0d3f40873a005287514ba2a48558655314`. KR Regular, Math and Symbols 2
total 6,306,880 bytes. The three additional Bold subsets total 18,015,660
bytes, comparable in size to their Regular counterparts. All six regional
CJK files are official SubsetOTFs; none is a full CJK super-OTC, and no
additional subsetting or modification is applied to the bundled assets.

Unmodified upstream licenses (also emitted in `dist/licenses/fonts/`):

- [LICENSE-NotoSansCJK.txt](LICENSE-NotoSansCJK.txt), from
  [noto-cjk Sans/LICENSE](https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE), 4,301 bytes.
- [LICENSE-NotoSansMath.txt](LICENSE-NotoSansMath.txt), `OFL.txt` from the
  pinned Math release archive, 4,380 bytes.
- [LICENSE-NotoSansSymbols2.txt](LICENSE-NotoSansSymbols2.txt), `OFL.txt` from
  the pinned Symbols 2 release archive, 4,383 bytes.

SHA-256 of the font files:

```text
faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9  NotoSansSC-Regular.otf
dff723ba59d57d136764a04b9b2d03205544f7cd785a711442d6d2d085ac5073  NotoSansJP-Regular.otf
69975a0ac8472717870aefeab0a4d52739308d90856b9955313b2ad5e0148d68  NotoSansKR-Regular.otf
c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0  NotoSansSC-Bold.otf
1b0edfb500b73a4fa8a4fcaae1bbbd403994e08e73e3e0da37e70d3853f42c5f  NotoSansJP-Bold.otf
5a6ceb287ed2fc6cfc6213144ebea68cbd94b20fc9eb873d8486493bf02d9bda  NotoSansKR-Bold.otf
d51afd5739c7ba6c44fcab35a88160e25dfb69a2d4ad0bd99533f8d894af1f96  NotoSansMath-Regular.ttf
c4a0a80f0041ce4be81e2478faad22776d23edb98ae3f0d19bd37044820ecf9d  NotoSansSymbols2-Regular.ttf
```

Retypeset prefers JP for kana, KR for Hangul, SC for other Han, and a
style-matched Liberation face for Latin. It reads the original resource's
descriptor Flags/FontWeight and BaseFont/FontName/FontFamily hints, including
Type0 descendants. Every needed scalar must map to a nonzero cmap GID.
If the preferred face lacks coverage, selection walks the official Noto
chain; a single face for all missing clusters is preferred. Only when none
covers them all does it use the writer's existing per-cluster font switches.
Encodable source text retains its original font. No Liberation candidate
is allowed anywhere in a paragraph containing Han/kana/Hangul.

JP lacks simplified `调` (U+8C03), while SC covers it. Both Math and Symbols 2
lack U+2329/U+3008; SC supplies the angle brackets. Math supplies U+210E `ℎ`
and mathematical italic rho. KR supplies Hangul syllables missing from SC/JP.
The official SC/JP/KR files also contain kana and compatibility jamo; coverage
is measured instead of inferred from locale names. NFC canonically maps
U+2329 `〈` to U+3008 `〈`; no NFKC is applied.

CJK retypeset substitutes use Bold Sans when Liberation's existing style
decision identifies Bold/Black/Heavy, descriptor ForceBold, or FontWeight
>= 600. Regular and Medium (500) retain Regular. Bold regional subsets are
tried before Regular coverage fallbacks, including the primary region's
Regular face. Other substitution paths retain their existing selection.
Black/Medium-specific faces, italic and serif matching remain unavailable
for CJK; no synthetic bold stroke or slant is added. The separate vertical
compiler reuses proved upright Identity-V glyphs and local two-byte vertical
CMaps. Its Regular JP fallback carries explicit W2 metrics read from `vmtx`
and `VORG`; horizontal advance is never used as vertical displacement.
Substitute characters requiring a `vert` or `vrt2` alternate remain precisely
refused, and these features are never stacked on WMode 1 output. The official
CJK font files remain unmodified.

# Embedded-terminal symbols (`ui/`)

`SymbolsNerdFontMono-Regular.woff2` is a webfont conversion of the official
Nerd Fonts 3.4.0 SymbolsOnly fallback. It contains all encoded symbols from
the upstream TTF so Powerline, Powerlevel10k, Starship, and Nerd Font prompts
do not depend on fonts configured in a separate terminal application.

The upstream SymbolsOnly directory license, the project license audit, and
the exact source/conversion hashes are committed beside the font:

- `ui/LICENSE-nerd-fonts-symbols.txt`
- `ui/nerd-fonts-license-audit.md`
- `ui/NOTICE-nerd-fonts-symbols.md`

# Metric-compatible fallbacks (`metric/`)

`LiberationSerif/Sans/Mono-Regular.woff2` come from the official
liberation-fonts 2.1.5 release
(https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5,
TTFs converted with ttf2woff2). They are glyph-for-glyph width-identical
to Times, Helvetica/Arial, and Courier — the PDF Standard-14 metrics the
export fallback embeds — so on-screen contentText edits keep their line
widths on platforms that ship none of those system fonts. Declared in
`src/styles/fonts.css`; loaded lazily on first use. Licensed under the
SIL Open Font License 1.1 (`metric/LICENSE-liberation.txt`).

Surgical PDF fallback loads the existing Liberation TTF assets from
`@docx-editor.dev/fonts`, which the DOCX view already bundles. Regular, Bold,
Italic and BoldItalic variants are selected lazily by source class/style;
loaded bytes are cached in memory. These assets retain the dependency's OFL
notices and are embedded under a `+ShioriFallback` subset name. The dependency
package declares `Apache-2.0 AND OFL-1.1 AND LicenseRef-GUST-Font-License`;
Liberation itself is OFL-1.1. See THIRD_PARTY_NOTICES.md and the unmodified
`licenses/docx-editor/fonts/` notices shipped by the existing build process.

Verify asset reuse after a build with:

```sh
bun scripts/pdf-inplace/checkFallbackAssets.ts
```
