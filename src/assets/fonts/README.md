# Export Fonts

These unmodified official notofonts fonts are bundled for PDF export.
SC/JP also serve the existing web/mobile PDFium fallback. All five fonts
are SIL OFL 1.1; no font was copied from survey/vendor trees.

| File | Bytes | Pinned official source |
| --- | ---: | --- |
| NotoSansSC-Regular.otf (existing) | 8,331,336 | [noto-cjk SC SubsetOTF](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf) |
| NotoSansJP-Regular.otf (existing) | 4,533,028 | [noto-cjk JP SubsetOTF](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf) |
| NotoSansKR-Regular.otf | 4,644,748 | [noto-cjk KR SubsetOTF](https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/KR/NotoSansKR-Regular.otf) |
| NotoSansMath-Regular.ttf | 990,564 | [math NotoSansMath-v3.000 release](https://github.com/notofonts/math/releases/download/NotoSansMath-v3.000/NotoSansMath-v3.000.zip), `NotoSansMath/hinted/ttf/NotoSansMath-Regular.ttf` |
| NotoSansSymbols2-Regular.ttf | 671,568 | [symbols NotoSansSymbols2-v2.008 release](https://github.com/notofonts/symbols/releases/download/NotoSansSymbols2-v2.008/NotoSansSymbols2-v2.008.zip), `NotoSansSymbols2/hinted/ttf/NotoSansSymbols2-Regular.ttf` |

CJK is pinned at commit `f8d157532fbfaeda587e826d4cd5b21a49186f7c`
(Sans 2.004). The existing SC/JP bytes were compared against that official
commit and are identical. Math's release tag resolves to commit
`00e9941d95b2a355399a66f3990ffde6e4985676`; Symbols 2's tag resolves to
`25b00f0d3f40873a005287514ba2a48558655314`. The new fonts total 6,306,880
bytes. KR is comparable to JP/SC and needs no additional subsetting.

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

CJK substitutes are Regular Sans only: bold/italic/serif matching is not
available for CJK and no synthetic bold stroke is added. Vertical writing
is detected and refused with `unsupported-vertical-writing`; no substitute
is shaped or encoded for such a run, and neither `vert` nor `vrt2` is applied.
The official CJK files remain unmodified, preserving `locl`, `vert`, `vrt2`,
`vmtx` and `VORG` for a future vertical emitter.

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
