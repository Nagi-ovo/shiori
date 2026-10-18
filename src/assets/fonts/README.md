# Export Fonts

`NotoSansSC-Regular.otf` and `NotoSansJP-Regular.otf` are bundled for
PDF export only. They come from `notofonts/noto-cjk`:

- https://github.com/notofonts/noto-cjk/blob/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf
- https://github.com/notofonts/noto-cjk/blob/main/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf

The SC subset covers CJK Unified Ideographs with Chinese-style glyph
shapes but omits hiragana and katakana. The JP subset covers kana
plus CJK Unified Ideographs with Japanese-style glyph shapes. The
exporter picks per overlay: text containing kana routes through JP,
other non-ASCII routes through SC.

Noto CJK fonts are licensed under the SIL Open Font License 1.1.

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
