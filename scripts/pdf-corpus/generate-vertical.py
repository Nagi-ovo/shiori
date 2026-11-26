#!/usr/bin/env python3
"""Generate redistributable Japanese / Traditional Chinese vertical-writing PDFs.

Sources: Aozora Bunko copyright-expired texts (attribution required) and
public-domain Classical Chinese poems. Fonts: SIL OFL Noto CJK. The typographic
arrangement of the generated PDFs is released under CC-BY-4.0.
"""
from __future__ import annotations

import hashlib
import html
import os
import re
import shutil
import subprocess
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "vertical-fixtures" / "src"
OUT = ROOT / "fixtures" / "vertical"
ARTIFACTS = ROOT.parent.parent / "test-artifacts" / "pdf-corpus"
CACHE = Path(os.environ.get("CORPUS_CACHE", ARTIFACTS / "cache"))
AOZORA_DIR = Path(os.environ.get("AOZORA_DIR", ARTIFACTS / "aozora"))
TYPST = os.environ.get("TYPST_BIN", "typst")
BROWSER = os.environ.get("BROWSER_BIN", "chromium")
SOFFICE = os.environ.get("SOFFICE_BIN", "soffice")

COLOPHON_AOZORA = (
    "本文は著作権保護期間の満了した作品である。青空文庫の本文を利用した。"
    "字体はオープンフォントライセンスの源ノ明朝系書体による。"
    "本PDFの組版はクリエイティブ・コモンズ表示四・〇で提供する。"
)
COLOPHON_CLASSICAL = (
    "本文は著作権保護期間の満了した漢詩である。"
    "字体はオープンフォントライセンスの源ノゴシック系書体による。"
    "本PDFの組版はクリエイティブ・コモンズ表示四・〇で提供する。"
)

TANG_POEMS = """靜夜思
李白

牀前明月光，疑是地上霜。
舉頭望明月，低頭思故鄉。

登鸛雀樓
王之渙

白日依山盡，黃河入海流。
欲窮千里目，更上一層樓。

春曉
孟浩然

春眠不覺曉，處處聞啼鳥。
夜來風雨聲，花落知多少。

竹里館
王維

獨坐幽篁裏，彈琴復長嘯。
深林人不知，明月來相照。
"""


def extract_aozora(path: Path) -> tuple[str, str, str]:
    raw = path.read_text(encoding="utf-8")
    title_m = re.search(r"<h1[^>]*class=\"title\"[^>]*>(.*?)</h1>", raw, re.S)
    if not title_m:
        title_m = re.search(r"<title>(.*?)</title>", raw, re.S)
    author_m = re.search(r"<h2[^>]*class=\"author\"[^>]*>(.*?)</h2>", raw, re.S)
    body_m = re.search(r"<div[^>]*class=\"main_text\"[^>]*>(.*)", raw, re.S)
    body = body_m.group(1) if body_m else raw
    body = re.split(r'<div[^>]*class="(bibliographical_information|notation_notes)"', body)[0]
    body = re.split(r"底本[：:]", body)[0]
    body = re.sub(r"<rp>.*?</rp>", "", body, flags=re.S)
    body = re.sub(r"<rt>.*?</rt>", "", body, flags=re.S)
    body = re.sub(r"</?ruby>", "", body)
    body = re.sub(r"</?rb>", "", body)
    body = re.sub(r"<br\s*/?>", "\n", body, flags=re.I)
    body = re.sub(r"</p>", "\n", body, flags=re.I)
    body = re.sub(r"<[^>]+>", "", body)
    body = html.unescape(body)
    body = body.replace("\u3000", "　")
    body = re.sub(r"\r\n?", "\n", body)
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    title = html.unescape(re.sub(r"<[^>]+>", "", title_m.group(1))).strip() if title_m else path.stem
    author = html.unescape(re.sub(r"<[^>]+>", "", author_m.group(1))).strip() if author_m else ""
    return title, author, body


def xml_esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def write_fodt(path: Path, title: str, author: str, paragraphs: list[str], *, font: str, columns: int = 1, tcy_spans: bool = False) -> None:
    master = "pm2col" if columns == 2 else "pm1"
    cols_xml = ""
    if columns == 2:
        cols_xml = """
    <style:columns fo:column-count="2" fo:column-gap="0.8cm">
      <style:column style:rel-width="1*" fo:start-indent="0cm" fo:end-indent="0cm"/>
      <style:column style:rel-width="1*" fo:start-indent="0cm" fo:end-indent="0cm"/>
    </style:columns>"""
    paras = []
    paras.append(f'<text:p text:style-name="Title">{xml_esc(title)}</text:p>')
    if author:
        paras.append(f'<text:p text:style-name="Author">{xml_esc(author)}</text:p>')
    for p in paragraphs:
        if tcy_spans:
            marked = apply_tcy_markup(p, lambda tok: f"\x00TCY{tok}\x00")
            inner = []
            for part in marked.split("\x00"):
                if part.startswith("TCY"):
                    inner.append(f'<text:span text:style-name="Tcy">{xml_esc(part[3:])}</text:span>')
                else:
                    inner.append(xml_esc(part))
            inner = "".join(inner)
        else:
            inner = xml_esc(p)
        paras.append(f'<text:p text:style-name="Standard">{inner}</text:p>')
    body = "\n   ".join(paras)
    fodt = f'''<?xml version="1.0" encoding="UTF-8"?>
<office:document
 xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"
 office:mimetype="application/vnd.oasis.opendocument.text"
 office:version="1.3">
 <office:meta>
  <dc:title>{xml_esc(title)}</dc:title>
  <meta:generator>Shiori corpus vertical fixtures</meta:generator>
 </office:meta>
 <office:font-face-decls>
  <style:font-face style:name="BodyFont" svg:font-family="&apos;{xml_esc(font)}&apos;" style:font-family-generic="roman" style:font-pitch="variable"/>
  <style:font-face style:name="LatinFont" svg:font-family="&apos;DejaVu Serif&apos;" style:font-family-generic="roman" style:font-pitch="variable"/>
 </office:font-face-decls>
 <office:styles>
  <style:default-style style:family="paragraph">
   <style:paragraph-properties style:writing-mode="tb-rl"/>
   <style:text-properties style:font-name="BodyFont" fo:font-size="12pt" style:font-name-asian="BodyFont" style:font-size-asian="12pt"/>
  </style:default-style>
  <style:style style:name="Standard" style:family="paragraph" style:class="text">
   <style:paragraph-properties style:writing-mode="tb-rl" fo:line-height="165%" fo:margin-bottom="0.12cm"/>
   <style:text-properties style:font-name="BodyFont" fo:font-size="12pt" style:font-name-asian="BodyFont" style:font-size-asian="12pt"/>
  </style:style>
  <style:style style:name="Title" style:family="paragraph" style:parent-style-name="Standard">
   <style:paragraph-properties fo:margin-bottom="0.5cm"/>
   <style:text-properties fo:font-size="18pt" style:font-size-asian="18pt" fo:font-weight="bold" style:font-weight-asian="bold"/>
  </style:style>
  <style:style style:name="Author" style:family="paragraph" style:parent-style-name="Standard">
   <style:paragraph-properties fo:margin-bottom="0.4cm"/>
   <style:text-properties fo:font-size="12pt" style:font-size-asian="12pt"/>
  </style:style>
  <style:style style:name="Tcy" style:family="text">
   <style:text-properties style:text-combine="lines" style:font-name="LatinFont" fo:font-size="10pt" style:font-name-asian="LatinFont" style:font-size-asian="10pt"/>
  </style:style>
 </office:styles>
 <office:automatic-styles>
  <style:page-layout style:name="pm1">
   <style:page-layout-properties fo:page-width="21.0cm" fo:page-height="29.7cm" style:num-format="1" style:print-orientation="portrait" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm" style:writing-mode="tb-rl">
    <style:footnote-sep/>
   </style:page-layout-properties>
  </style:page-layout>
  <style:page-layout style:name="pm2col">
   <style:page-layout-properties fo:page-width="21.0cm" fo:page-height="29.7cm" style:num-format="1" style:print-orientation="portrait" fo:margin-top="1.8cm" fo:margin-bottom="1.8cm" fo:margin-left="1.8cm" fo:margin-right="1.8cm" style:writing-mode="tb-rl">{cols_xml}
    <style:footnote-sep/>
   </style:page-layout-properties>
  </style:page-layout>
 </office:automatic-styles>
 <office:master-styles>
  <style:master-page style:name="Standard" style:page-layout-name="{master}"/>
 </office:master-styles>
 <office:body>
  <office:text>
   {body}
  </office:text>
 </office:body>
</office:document>
'''
    path.write_text(fodt, encoding="utf-8")


def write_html(path: Path, title: str, author: str, paragraphs: list[str], *, font: str, lang: str, columns: int = 1, tcy: bool = False) -> None:
    # Multicol on body only: a column container on html as well nests two
    # multicols, and a fixed inline size with column-fill:auto runs columns
    # past the left page edge. Balanced columns fragment across pages.
    body_cols = ""
    if columns > 1:
        body_cols = f"  body {{ column-count:{columns}; column-gap:2em; }}\n"
    body_ps = []
    if author:
        body_ps.append(f"<p class='author'>{html.escape(author)}</p>")
    for p in paragraphs:
        if tcy:
            marked = apply_tcy_markup(p, lambda tok: f"\x00TCY{tok}\x00")
            bits = []
            for part in marked.split("\x00"):
                if part.startswith("TCY"):
                    bits.append(f"<span class='tcy'>{html.escape(part[3:])}</span>")
                else:
                    bits.append(html.escape(part).replace("\n", "<br>"))
            inner = "".join(bits)
        else:
            inner = html.escape(p).replace("\n", "<br>")
        body_ps.append(f"<p>{inner}</p>")
    doc = f"""<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<title>{html.escape(title)}</title>
<style>
  @page {{ size: A4; margin: 18mm; }}
  html, body {{
    writing-mode: vertical-rl;
    text-orientation: mixed;
    font-family: "{font}", serif;
    font-feature-settings: "vert" 1, "vrt2" 1;
    font-size: 13pt;
    line-height: 1.75;
    margin: 0;
  }}
  h1 {{ font-size: 20pt; font-weight: bold; letter-spacing: 0.25em; margin: 0 1em 0 0; }}
  p {{ margin: 0 0.4em 0 0; }}
  .author {{ margin-right: 0.8em; }}
  .tcy {{ text-combine-upright: all; font-feature-settings: "halt" 1; }}
  .colophon {{ font-size: 9pt; margin-right: 1.2em; }}
{body_cols}</style>
</head>
<body>
<h1>{html.escape(title)}</h1>
{''.join(body_ps)}
</body>
</html>
"""
    path.write_text(doc, encoding="utf-8")


def write_typst(path: Path, title: str, author: str, paragraphs: list[str], *, font: str, columns: int = 1, tcy: bool = False) -> None:
    def typst_esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("#", "\\#").replace("[", "\\[").replace("]", "\\]")

    lines = [
        '#import "@preview/basho:0.1.0": tate, tcy',
        f'#set text(font: "{font}", lang: "ja", size: 11pt)',
        '#set page(paper: "a4", margin: 2cm)',
        "#show: tate.with(config: (features: (\"vert\", \"vrt2\"), layout: (columns: %d, column-gap: 2.5em)))" % columns,
        f"#align(center)[{typst_esc(title)}]",
        "",
    ]
    if author:
        lines.append(f"#align(center)[{typst_esc(author)}]")
        lines.append("")
    for p in paragraphs:
        if tcy:
            lines.append(apply_tcy_markup(p, lambda tok: "#tcy[" + typst_esc(tok) + "]"))
        else:
            lines.append(typst_esc(p))
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def paras(text: str) -> list[str]:
    parts = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if len(parts) <= 1:
        parts = [p.strip() for p in text.split("\n") if p.strip()]
    return parts


def run(cmd: list[str], **kw) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True, **kw)


def soffice_pdf(fodt: Path, dest: Path) -> None:
    tmp = dest.parent / "_lo_out"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir()
    run([SOFFICE, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", str(tmp), str(fodt)], timeout=180)
    produced = next(tmp.glob("*.pdf"))
    shutil.move(str(produced), dest)
    shutil.rmtree(tmp)


def browser_pdf(html_path: Path, dest: Path) -> None:
    run([
        BROWSER, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--no-pdf-header-footer", f"--print-to-pdf={dest}",
        html_path.resolve().as_uri(),
    ], timeout=180)


def typst_pdf(typ: Path, dest: Path) -> None:
    run([TYPST, "compile", str(typ), str(dest)], timeout=180)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


TCY_FRONT = "本書の組版見本は令和8年11月17日に作成した。第12回の試験ではABC案と12pt活字を用い、幅は2欄とする。"
TCY_TOKENS = ("12pt", "11", "17", "ABC", "12")  # longer tokens first

def inject_tcy_demo(text: str) -> str:
    return TCY_FRONT + "\n\n" + text

def apply_tcy_markup(text: str, wrap) -> str:
    """Wrap only intended tate-chu-yoko tokens, longest first, never nested."""
    out = text
    slots = []
    for tok in TCY_TOKENS:
        needle = tok
        if needle not in out:
            continue
        key = f"@@@TCY{len(slots)}@@@"
        out = out.replace(needle, key)
        slots.append((key, wrap(tok)))
    for key, val in slots:
        out = out.replace(key, val)
    return out


def main() -> None:
    SRC.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)

    rashomon = extract_aozora(AOZORA_DIR / "rashomon.html")
    kumo = extract_aozora(AOZORA_DIR / "kumo.html")
    sangetsu = extract_aozora(AOZORA_DIR / "sangetsu.html")
    # Keep stories to a few pages at most
    def clip(body: str, n: int = 2800) -> str:
        return body if len(body) <= n else body[:n].rsplit("\n", 1)[0] + "\n\n（以下、青空文庫本文の抄録）"

    jobs = []

    # 1 LibreOffice JP single column — 羅生門
    title, author, body = rashomon
    body = clip(body)
    src_fodt = SRC / "vert-lo-jp-rashomon.fodt"
    write_fodt(src_fodt, title, author, paras(body + "\n\n" + COLOPHON_AOZORA), font="Noto Serif CJK JP")
    jobs.append(("vert-lo-jp-rashomon", "lo", src_fodt, "LibreOffice 25 Writer, writing-mode tb-rl, Noto Serif CJK JP, Aozora 羅生門"))

    # 2 LibreOffice JP tate-chu-yoko
    tcy_body = inject_tcy_demo(clip(kumo[2], 1800))
    src_fodt = SRC / "vert-lo-jp-tcy.fodt"
    write_fodt(src_fodt, kumo[0] + "（縦中横見本）", kumo[1], paras(tcy_body + "\n\n" + COLOPHON_AOZORA), font="Noto Serif CJK JP", tcy_spans=True)
    jobs.append(("vert-lo-jp-tcy", "lo", src_fodt, "LibreOffice Writer tb-rl + style:text-combine=lines (tate-chu-yoko)"))

    # 3 LibreOffice JP 2 column
    src_fodt = SRC / "vert-lo-jp-2col.fodt"
    write_fodt(src_fodt, sangetsu[0], sangetsu[1], paras(clip(sangetsu[2], 2400) + "\n\n" + COLOPHON_AOZORA), font="Noto Serif CJK JP", columns=2)
    jobs.append(("vert-lo-jp-2col", "lo", src_fodt, "LibreOffice Writer tb-rl, 2 columns"))

    # 4 LibreOffice TC poetry
    src_fodt = SRC / "vert-lo-tc-poetry.fodt"
    write_fodt(src_fodt, "唐詩選抄", "李白・王之渙・孟浩然・王維", paras(TANG_POEMS + "\n" + COLOPHON_CLASSICAL), font="Noto Sans CJK TC")
    jobs.append(("vert-lo-tc-poetry", "lo", src_fodt, "LibreOffice Writer tb-rl, Traditional Chinese, Noto Sans CJK TC"))

    # 5 Browser print, JP vertical
    src_html = SRC / "vert-browser-jp-kumo.html"
    write_html(src_html, kumo[0], kumo[1], paras(clip(kumo[2], 2200) + "\n\n" + COLOPHON_AOZORA), font="Noto Serif CJK JP", lang="ja")
    jobs.append(("vert-browser-jp-kumo", "browser", src_html, "Browser print-to-PDF, writing-mode:vertical-rl, font-feature-settings vert/vrt2"))

    # 6 Browser print, JP tcy + vert
    src_html = SRC / "vert-browser-jp-tcy.html"
    write_html(src_html, "縦中横見本", "青空文庫本文に基づく組版見本", paras(inject_tcy_demo(clip(rashomon[2], 1600)) + "\n\n" + COLOPHON_AOZORA), font="Noto Serif CJK JP", lang="ja", tcy=True)
    jobs.append(("vert-browser-jp-tcy", "browser", src_html, "Browser print, vertical-rl + text-combine-upright:all"))

    # 7 Browser print, JP 2-col
    src_html = SRC / "vert-browser-jp-2col.html"
    write_html(src_html, sangetsu[0], sangetsu[1], paras(clip(sangetsu[2], 2400) + "\n\n" + COLOPHON_AOZORA), font="Noto Serif CJK JP", lang="ja", columns=2)
    jobs.append(("vert-browser-jp-2col", "browser", src_html, "Browser print, vertical-rl, CSS column-count:2"))

    # 8 Browser print, TC
    src_html = SRC / "vert-browser-tc-poetry.html"
    write_html(src_html, "唐詩選抄", "李白・王之渙・孟浩然・王維", paras(TANG_POEMS + "\n" + COLOPHON_CLASSICAL), font="Noto Sans CJK TC", lang="zh-Hant")
    jobs.append(("vert-browser-tc-poetry", "browser", src_html, "Browser print, vertical-rl, Traditional Chinese"))

    # 9 Typst basho JP
    src_typ = SRC / "vert-typst-jp-rashomon.typ"
    write_typst(src_typ, rashomon[0], rashomon[1], paras(clip(rashomon[2], 2200) + "\n\n" + COLOPHON_AOZORA), font="Noto Serif CJK JP")
    jobs.append(("vert-typst-jp-rashomon", "typst", src_typ, "Typst 0.15.1 + basho 0.1.0 tate, Noto Serif CJK JP"))

    # 10 Typst basho tcy + 2col
    src_typ = SRC / "vert-typst-jp-tcy-2col.typ"
    write_typst(src_typ, "縦中横・二段見本", kumo[1], paras(inject_tcy_demo(clip(kumo[2], 1800)) + "\n\n" + COLOPHON_AOZORA), font="Noto Serif CJK JP", columns=2, tcy=True)
    jobs.append(("vert-typst-jp-tcy-2col", "typst", src_typ, "Typst basho tate + tcy + 2 columns"))

    # 11 Typst TC (classical) — basho is JP-oriented but should still emit vertical boxes
    src_typ = SRC / "vert-typst-tc-poetry.typ"
    write_typst(src_typ, "唐詩選抄", "李白・王之渙・孟浩然・王維", paras(TANG_POEMS + "\n" + COLOPHON_CLASSICAL), font="Noto Sans CJK TC")
    jobs.append(("vert-typst-tc-poetry", "typst", src_typ, "Typst basho tate, Traditional Chinese poems"))

    results = []
    for fid, kind, src, notes in jobs:
        dest = OUT / f"{fid}.pdf"
        try:
            if kind == "lo":
                soffice_pdf(src, dest)
            elif kind == "browser":
                browser_pdf(src, dest)
            elif kind == "typst":
                typst_pdf(src, dest)
            else:
                raise SystemExit(f"unknown kind {kind}")
            digest = sha256(dest)
            cache_copy = CACHE / f"{fid}.pdf"
            shutil.copy2(dest, cache_copy)
            results.append((fid, dest.stat().st_size, digest, notes, "ok"))
            print(f"OK {fid} {dest.stat().st_size} {digest}")
        except Exception as e:
            results.append((fid, 0, "", notes, f"FAIL: {e}"))
            print(f"FAIL {fid}: {e}")

    report = SRC / "generate-log.txt"
    report.write_text("\n".join(f"{a}\t{b}\t{c}\t{d}\t{e}" for a, b, c, d, e in results), encoding="utf-8")
    print("Wrote", report)


if __name__ == "__main__":
    main()
