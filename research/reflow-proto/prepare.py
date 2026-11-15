"""Freeze sample bounds before edits; make no production RegionProof claim."""
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent
SELECTIONS = [("zh-hans-law", "目前人工智能行业", "具有不利的一面"),
              ("zh-hans-education", "“智能”一词", "前人工智能的发展"),
              ("zh-hans-ethics", "人工智能指的是", "够借助人工智能技术"),
              ("arxiv-2611.17030", "Toevaluate", "line."),
              ("arxiv-2611.17052", "Weapplyourevaluation", "atgithub.com"),
              ("arxiv-2611.17053", "Replacingsymbolic", "guagemodelsandavoid")]


def inferred_space(raw, advance, row, kind):
    """Retain style/geometry only: an inferred space has no source glyph proof."""
    x, y = raw["x"] + raw["advance"], raw["y"]
    return dict(raw, text=" ", source=None, source_index=None, row=row,
                code=None, gid=None, nativeOrigin=None, unicodeProven=False,
                x=x, advance=advance, width1000=advance / raw["emX"] * 1000,
                tc=0, tw=0, wordSpaced=False, gap_after=0., inferred=True,
                inference=kind, ink=[x, y, x, y])


def prepare():
    pages = json.loads((BASE / "tmp/extracted.json").read_text())
    samples = []
    for corpus_id, start, end in SELECTIONS:
        page = next(p for p in pages if p["id"] == corpus_id)
        lines = page["lines"]
        first = next(i for i, l in enumerate(lines) if l["text"].startswith(start))
        last = next(i for i, l in enumerate(lines[first:], first) if l["text"].startswith(end))
        lines = lines[first:last + 1]
        # Explicit manual selection and observed slots, never a detector proof.
        glyphs = []
        inferred = 0
        for row, line in enumerate(lines):
            source = line["glyphs"]
            for j, raw in enumerate(source):
                g = dict(raw, row=row, source_index=len(glyphs), gap_after=0.)
                glyphs.append(g)
                if j + 1 < len(source):
                    gap = source[j + 1]["x"] - raw["x"] - raw["advance"]
                    # PDF positioning can encode word spaces. Keep them explicit
                    # and flagged as inferred, rather than silently compacting.
                    if corpus_id.startswith("arxiv") and gap > raw["size"] * .12:
                        glyphs.append(inferred_space(raw, gap, row, "gap>0.12*size"))
                        inferred += 1
                    else:
                        g["gap_after"] = gap
            if row + 1 < len(lines) and corpus_id.startswith("arxiv"):
                # No dehyphenation: retain literal source hyphens; log ambiguity.
                if not glyphs[-1]["text"].endswith("-"):
                    glyphs.append(inferred_space(raw, raw["size"] * .25, row, "soft-join-0.25em"))
                    inferred += 1
        ink = [g["ink"] for g in glyphs if g.get("source")]
        box = [min(l["left"] for l in lines), min(b[1] for b in ink),
               max(max(l["right"] for l in lines), max(b[2] for b in ink)), max(b[3] for b in ink)]
        # Right edge fixed now, before creating edits; no extra vertical slots.
        slots = [dict(left=l["left"], right=box[2], baseline=l["baseline"]) for l in lines]
        samples.append(dict(id=corpus_id, page=page["page"], hash=page["hash"],
            url=page["url"], licence=page["licence"], fonts=page["fonts"],
            box=box, slots=slots, glyphs=glyphs, inferred_spaces=inferred,
            original="".join(g["text"] for g in glyphs),
            column_clip=page["columnClip"],
            source_lines=[l["text"] for l in lines]))
    (BASE / "tmp/input.json").write_text(json.dumps(samples, ensure_ascii=False))
    print("Selected", [(s["id"], len(s["slots"]), len(s["glyphs"])) for s in samples])


if __name__ == "__main__":
    prepare()
