# Vertical-writing corpus fixtures

First-party Japanese and Traditional Chinese vertical PDFs used by
`scripts/pdf-corpus/manifest.json` (`category: vertical`, `url: fixture:…`).

## Licence

- Japanese stories (羅生門, 蜘蛛の糸, 山月記) are copyright-expired works taken
  from [Aozora Bunko](https://www.aozora.gr.jp/) with the required attribution
  in each PDF.
- Tang poems are public-domain Classical Chinese texts.
- The CJK faces (Noto and Harano Aji) are licensed under the SIL Open Font
  License. `vert-lo-jp-tcy.pdf` also embeds a DejaVu Serif subset with its
  DejaVu and Bitstream Vera notices.
- The typographic arrangement of these generated PDFs is released under
  [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/).

## Regenerating

The generator uses `soffice`, a headless browser and Typst 0.15+ with the
MIT `basho` package. Set `SOFFICE_BIN`, `BROWSER_BIN` or `TYPST_BIN` to choose
executables, and `TYPST_PACKAGE_PATH` to use a local Typst package directory.
Place `rashomon.html`, `kumo.html` and `sangetsu.html` in
`test-artifacts/pdf-corpus/aozora/` or set `AOZORA_DIR` to their directory.
`CORPUS_CACHE` overrides the default `test-artifacts/pdf-corpus/cache/`.
The jlreq samples require LuaTeX-ja, jlreq and Harano Aji or Noto CJK.

```
python3 scripts/pdf-corpus/generate-vertical.py
# plus, if LuaTeX-ja and pdf-lib fixtures are needed:
# lualatex the vert-luatex-*.tex sources in this directory
# bun scripts/pdf-corpus/generate-identity-v.ts
```

Hashes in `manifest.json` must be updated after regeneration.

## Coverage

| Generator | Encoding / placement | Specials |
|---|---|---|
| LibreOffice Writer 25 | per-glyph Tm, Type 1 subsets | tate-chu-yoko, 2 columns, TC |
| Browser print (Skia/PDF) | Type 3, `writing-mode: vertical-rl`, `vert`/`vrt2` | tate-chu-yoko, 2 columns, TC |
| Typst 0.15 + basho | Identity-H + placement transforms, `vert`/`vrt2` | tate-chu-yoko, 2 columns, TC |
| LuaTeX-ja + jlreq `[tate]` | Identity-H + `cm` rotation | `\tatechuyoko`, 2 columns, TC |
| pdf-lib first-party fixture | Identity-V, WMode 1, DW2 | Identity-H tate-chu-yoko inserts |
