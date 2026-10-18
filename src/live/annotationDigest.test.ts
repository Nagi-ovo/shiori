import { describe, expect, test } from "bun:test";
import { buildLiveAnnotationDigest } from "./annotationDigest";
import type { Overlay, PageModel } from "../pdf/model/types";

const pages: PageModel[] = [
  { id: "p1", sourceIndex: 0, rotation: 0, widthPt: 612, heightPt: 792 },
  { id: "p2", sourceIndex: 1, rotation: 0, widthPt: 612, heightPt: 792 },
];

function callout(id: string, overrides: Partial<Overlay> = {}): Overlay {
  return {
    type: "callout",
    id,
    pageId: "p1",
    targetRects: [{ x: 0, y: 0, w: 10, h: 10 }],
    rect: { x: 0, y: 0, w: 10, h: 10 },
    text: "why is this bound tight?",
    fontSize: 11,
    color: "#000000",
    bold: false,
    align: "left",
    fontFamily: "sans",
    ...overrides,
  } as Overlay;
}

describe("buildLiveAnnotationDigest", () => {
  test("returns bodies, quotes and threads with 1-based page numbers", () => {
    const overlays: Overlay[] = [
      callout("c1", {
        pageId: "p2",
        anchor: { quote: "the bound is tight for n > 2", page: 2 },
        thread: [
          { id: "t1", role: "user", text: "and the other one?" },
          { id: "t2", role: "agent", author: "Claude Code", text: "same argument" },
        ],
      } as Partial<Overlay>),
    ];
    const { annotations, truncated } = buildLiveAnnotationDigest(overlays, pages);
    expect(truncated).toBe(false);
    expect(annotations).toEqual([
      {
        id: "c1",
        type: "callout",
        page: 2,
        text: "why is this bound tight?",
        quote: "the bound is tight for n > 2",
        thread: [
          { role: "user", text: "and the other one?" },
          { role: "agent", author: "Claude Code", text: "same argument" },
        ],
      },
    ]);
  });

  test("omits annotations with nothing to read", () => {
    const ink: Overlay = {
      type: "ink",
      id: "i1",
      pageId: "p1",
      points: [[{ x: 0, y: 0 }]],
      color: "#000000",
      widthPt: 2,
    } as unknown as Overlay;
    // An empty-bodied callout is just as unreadable as a stroke: the agent
    // would see an id and no content, which is exactly the gap this closes.
    const empty = callout("c2", { text: "   " } as Partial<Overlay>);
    const { annotations } = buildLiveAnnotationDigest([ink, empty], pages);
    expect(annotations).toEqual([]);
  });

  test("skips overlays whose page is gone rather than guessing a number", () => {
    const orphan = callout("c3", { pageId: "deleted" } as Partial<Overlay>);
    const { annotations } = buildLiveAnnotationDigest([orphan], pages);
    expect(annotations).toEqual([]);
  });

  test("marks the digest truncated instead of silently dropping the tail", () => {
    // Each body sits at the per-annotation cap, so ~120 of them exhaust the
    // whole-digest budget; the rest must be reported as clipped, not dropped
    // silently — a partial list that looks complete is worse than no list.
    const long = "x".repeat(400);
    const overlays = Array.from({ length: 180 }, (_, index) =>
      callout(`c${index}`, { text: long } as Partial<Overlay>),
    );
    const { annotations, truncated } = buildLiveAnnotationDigest(
      overlays,
      pages,
    );
    expect(truncated).toBe(true);
    expect(annotations.length).toBeGreaterThan(0);
    expect(annotations.length).toBeLessThan(overlays.length);
  });

  test("clamps an over-long body and says so with an ellipsis", () => {
    const overlays = [callout("c4", { text: "y".repeat(900) } as Partial<Overlay>)];
    const { annotations, truncated } = buildLiveAnnotationDigest(overlays, pages);
    expect(truncated).toBe(true);
    expect(annotations[0]?.text?.endsWith("…")).toBe(true);
    expect(annotations[0]?.text?.length).toBe(401);
  });

  test("keeps the most recent thread turns and reports the omitted history", () => {
    const thread = Array.from({ length: 15 }, (_, index) => ({
      id: `t${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("agent" as const),
      text: `turn-${index}`,
    }));
    const { annotations, truncated } = buildLiveAnnotationDigest(
      [callout("c5", { thread } as Partial<Overlay>)],
      pages,
    );
    expect(truncated).toBe(true);
    expect(annotations[0]?.thread).toHaveLength(12);
    expect(annotations[0]?.thread?.[0]?.text).toBe("turn-3");
    expect(annotations[0]?.thread?.at(-1)?.text).toBe("turn-14");
  });
});

describe("cross-language budget", () => {
  // live_api.rs budgets with String::len() — UTF-8 bytes — against a 64 KiB
  // ceiling. Counting UTF-16 code units here made the two disagree by 3x on
  // CJK: a Chinese document with a few hundred annotations looked fine on
  // this side and was rejected wholesale by native, taking the reader's Live
  // channel with it and leaving only a console warning.
  const NATIVE_CEILING_BYTES = 64 * 1024;

  function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).length;
  }

  function digestBytes(result: {
    annotations: { id: string; type: string; text?: string; quote?: string; thread?: { text: string; role: string; author?: string }[] }[];
  }): number {
    let total = 0;
    for (const entry of result.annotations) {
      total += utf8Bytes(entry.id) + utf8Bytes(entry.type);
      total += entry.text ? utf8Bytes(entry.text) : 0;
      total += entry.quote ? utf8Bytes(entry.quote) : 0;
      for (const turn of entry.thread ?? []) {
        total += utf8Bytes(turn.text) + utf8Bytes(turn.role);
        total += turn.author ? utf8Bytes(turn.author) : 0;
      }
    }
    return total;
  }

  test("a heavily annotated CJK document stays inside the native budget", () => {
    const body = "这是一段中文批注，用来占满预算。".repeat(12);
    const overlays = Array.from({ length: 200 }, (_, index) =>
      callout(`c${index}`, { text: body }),
    );

    const result = buildLiveAnnotationDigest(overlays, pages);

    expect(result.annotations.length).toBeGreaterThan(0);
    expect(digestBytes(result)).toBeLessThanOrEqual(NATIVE_CEILING_BYTES);
    // Clipped rather than silently partial.
    expect(result.truncated).toBe(true);
  });

  test("an ASCII document is not penalised by byte counting", () => {
    const overlays = Array.from({ length: 20 }, (_, index) =>
      callout(`a${index}`, { text: "a short english note" }),
    );

    const result = buildLiveAnnotationDigest(overlays, pages);

    expect(result.annotations).toHaveLength(20);
    expect(result.truncated).toBe(false);
    expect(digestBytes(result)).toBeLessThanOrEqual(NATIVE_CEILING_BYTES);
  });
});

describe("what survives truncation", () => {

  test("keeps a callout whose reply is new even though it sits at the front", () => {
    // Array order is not time order: replying to an old callout replaces it
    // in place rather than moving it to the end, and imported annotations
    // arrive in page / PDF-object order. Position-based "newest" dropped the
    // very conversation a follow-up was about.
    const body = "这是一段中文批注，用来占满预算。".repeat(12);
    const overlays = Array.from({ length: 200 }, (_, index) =>
      callout(`c${index}`, { text: body }),
    );
    // c0 is first in the array but was just replied to.
    overlays[0] = callout("c0", {
      text: body,
      thread: [{ id: "t1", role: "user", text: "还在等这条", at: 9_999_999 }],
    });

    const result = buildLiveAnnotationDigest(overlays, pages);
    const ids = result.annotations.map((entry) => entry.id);

    expect(result.truncated).toBe(true);
    expect(ids).toContain("c0");
    // Still emitted in document order — c0 leads because it is first.
    expect(ids[0]).toBe("c0");
  });

  test("prefers a more recently modified imported annotation", () => {
    const body = "这是一段中文批注，用来占满预算。".repeat(12);
    const overlays = Array.from({ length: 200 }, (_, index) =>
      callout(`c${index}`, {
        text: body,
        // Older the further along the array — the reverse of position order.
        sourceModifiedAt: 1_000_000 - index,
      }),
    );

    const result = buildLiveAnnotationDigest(overlays, pages);
    const ids = result.annotations.map((entry) => entry.id);

    expect(result.truncated).toBe(true);
    expect(ids).toContain("c0");
    expect(ids).not.toContain("c199");
  });

  test("keeps the newest annotations and drops the oldest", () => {
    // A follow-up is almost always about the callout the reader just wrote.
    // Filling oldest-first spent the budget on history and dropped exactly
    // the annotation the agent was being asked about.
    const body = "这是一段中文批注，用来占满预算。".repeat(12);
    const overlays = Array.from({ length: 200 }, (_, index) =>
      callout(`c${index}`, { text: body }),
    );

    const result = buildLiveAnnotationDigest(overlays, pages);
    const ids = result.annotations.map((entry) => entry.id);

    expect(result.truncated).toBe(true);
    expect(ids.length).toBeLessThan(overlays.length);
    // The most recent annotation is present; the oldest is not.
    expect(ids).toContain("c199");
    expect(ids).not.toContain("c0");
    // Still emitted in document order, not reversed.
    const positions = ids.map((id) => Number(id.slice(1)));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe("clamping is safe to send to Rust", () => {
  function hasLoneSurrogate(value: string): boolean {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        i += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  test("never splits a surrogate pair at the clamp boundary", () => {
    // slice() counts UTF-16 code units, so an emoji sitting exactly on the
    // 400-character boundary was cut in half. A lone surrogate is not valid
    // UTF-8, and serde_json refuses to deserialize a String containing one —
    // native rejected the whole context and kept serving a stale one.
    for (let pad = 395; pad <= 402; pad += 1) {
      const overlays = [
        callout("c1", { text: "a".repeat(pad) + "\u{1F600}" + "b".repeat(20) }),
      ];

      const result = buildLiveAnnotationDigest(overlays, pages);
      const text = result.annotations[0]?.text ?? "";

      expect(hasLoneSurrogate(text)).toBe(false);
      // And it must still survive a JSON round trip, which is how it travels.
      expect(JSON.parse(JSON.stringify({ text })).text).toBe(text);
    }
  });

  test("does not split a multi-code-point emoji either", () => {
    // A family emoji is several code points joined by ZWJ; cutting between
    // them would silently change who is in the picture.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const overlays = [
      callout("c1", { text: "a".repeat(399) + family + "tail" }),
    ];

    const text = buildLiveAnnotationDigest(overlays, pages).annotations[0]?.text ?? "";

    expect(hasLoneSurrogate(text)).toBe(false);
    expect(text.includes(family) || !text.includes("\u{1F468}")).toBe(true);
  });
});

describe("one oversized annotation cannot starve the digest", () => {
  test("skips a grapheme that will not fit and keeps the rest", () => {
    // A grapheme has no fixed byte length: "x" plus 30,000 combining marks
    // is ONE grapheme and about 60 KB. Stopping on the first entry that does
    // not fit handed an agent an empty list for a document full of ordinary
    // notes.
    const monstrous = "x" + "\u0301".repeat(30_000);
    const overlays = [
      // Most recently active, so it is considered FIRST — otherwise the
      // budget check never reaches it and the bug hides.
      callout("huge", {
        text: monstrous,
        thread: [{ id: "t1", role: "user", text: "hi", at: 9_999_999 }],
      }),
      callout("ordinary-1", { text: "a normal note" }),
      callout("ordinary-2", { text: "another normal note" }),
    ];

    const result = buildLiveAnnotationDigest(overlays, pages);
    const ids = result.annotations.map((entry) => entry.id);

    expect(ids).toContain("ordinary-1");
    expect(ids).toContain("ordinary-2");
    expect(result.truncated).toBe(true);
  });

  test("does not claim truncation when nothing was dropped", () => {
    // 300 emoji are 300 graphemes but 600 UTF-16 code units. Deciding with
    // one unit and cutting with the other added an ellipsis to text that had
    // lost nothing, and reported the whole digest as clipped.
    const emoji = "\u{1F600}".repeat(300);
    const overlays = [callout("c1", { text: emoji })];

    const result = buildLiveAnnotationDigest(overlays, pages);

    expect(result.truncated).toBe(false);
    expect(result.annotations[0]?.text).toBe(emoji);
    expect(result.annotations[0]?.text?.endsWith("…")).toBe(false);
  });
});

describe("local activity outranks imported dates", () => {
  const body = "这是一段中文批注，用来占满预算。".repeat(12);

  test("a callout the reader just made survives a document full of imports", () => {
    // Shiori-created annotations carry no timestamp, so max()-ing every date
    // into one number scored them 0 and every imported annotation with a /M
    // date beat them. The freshest thing in the document was the first thing
    // dropped — the exact opposite of the point.
    const overlays = [
      ...Array.from({ length: 200 }, (_, index) =>
        callout(`imported-${index}`, {
          text: body,
          sourceModifiedAt: 1_700_000_000_000 + index,
        }),
      ),
      callout("just-written", { text: body }),
    ];

    const ids = buildLiveAnnotationDigest(overlays, pages).annotations.map(
      (entry) => entry.id,
    );

    expect(ids).toContain("just-written");
  });


  test("an imported annotation with an author but no dates is still imported", () => {
    // withSourceProvenance() only sets sourceCreatedAt / sourceModifiedAt
    // when the PDF actually carries /CreationDate or /M. Keying "local" on
    // the absence of DATES alone would promote a foreign annotation that has
    // an author and nothing else, letting another document's comments crowd
    // out the reader's own notes.
    // Deliberately FIRST in the array: if the tier does not separate them,
    // the position tie-break buries it behind all 200 foreign ones.
    const overlays = [
      callout("mine", { text: body }),
      ...Array.from({ length: 200 }, (_, index) =>
        callout(`foreign-${index}`, {
          text: body,
          sourceAuthor: "Someone Else",
        }),
      ),
    ];

    const ids = buildLiveAnnotationDigest(overlays, pages).annotations.map(
      (entry) => entry.id,
    );

    expect(ids).toContain("mine");
  });


  test("an imported note stamped at import time is not treated as fresh", () => {
    // Opening a PDF rebuilds its sticky notes through
    // createNoteOverlay(..., now), so every imported note arrives carrying
    // today's createdAt/updatedAt. Reading those as the reader's own
    // activity let any freshly opened document outrank the notes they
    // actually wrote.
    const importMoment = Date.now();
    const overlays = [
      callout("mine", { text: body }),
      ...Array.from({ length: 200 }, (_, index) =>
        callout(`imported-${index}`, {
          text: body,
          sourceAuthor: "Someone Else",
          createdAt: importMoment,
          updatedAt: importMoment,
        }),
      ),
    ];

    const ids = buildLiveAnnotationDigest(overlays, pages).annotations.map(
      (entry) => entry.id,
    );

    expect(ids).toContain("mine");
  });

  test("editing an imported annotation here does make it fresh", () => {
    // The other half: activity strictly after the import is the reader's.
    const importMoment = Date.now() - 60_000;
    const overlays = [
      ...Array.from({ length: 200 }, (_, index) =>
        callout(`imported-${index}`, {
          text: body,
          sourceAuthor: "Someone Else",
          createdAt: importMoment,
          updatedAt: importMoment,
        }),
      ),
      callout("edited-by-me", {
        text: body,
        sourceAuthor: "Someone Else",
        createdAt: importMoment,
        updatedAt: importMoment + 30_000,
      }),
    ];

    const ids = buildLiveAnnotationDigest(overlays, pages).annotations.map(
      (entry) => entry.id,
    );

    expect(ids).toContain("edited-by-me");
  });


  test("imported annotations keep their relative order even when dated ahead", () => {
    // Clamping every source date to `now` collapsed legitimately different
    // dates into one value, so ordering fell back to array position and the
    // newest import could be the first one dropped.
    const future = Date.now() + 365 * 24 * 3600 * 1000;
    const overlays = Array.from({ length: 200 }, (_, index) =>
      callout(`future-${index}`, {
        text: body,
        sourceAuthor: "Someone Else",
        // Index 0 is the NEWEST, and sits first in the array — so position
        // and date disagree, and only real date ordering keeps it.
        sourceModifiedAt: future - index * 1000,
      }),
    );

    const ids = buildLiveAnnotationDigest(overlays, pages).annotations.map(
      (entry) => entry.id,
    );

    expect(ids).toContain("future-0");
    expect(ids).not.toContain("future-199");
  });


  test("an imported callout's own replies are not mistaken for live activity", () => {
    // A callout does not go through createNoteOverlay, so it has no
    // createdAt to compare against — and its thread turns carry the SOURCE
    // document's dates. Without a baseline every imported reply looked like
    // the reader had just written it.
    const sourceDay = 1_700_000_000_000;
    const overlays = [
      callout("mine", { text: body }),
      ...Array.from({ length: 200 }, (_, index) =>
        callout(`imported-${index}`, {
          text: body,
          sourceAuthor: "Someone Else",
          sourceModifiedAt: sourceDay + index,
          thread: [
            {
              id: `t${index}`,
              role: "user",
              text: "reply from the source file",
              at: sourceDay + index,
            },
          ],
        }),
      ),
    ];

    const ids = buildLiveAnnotationDigest(overlays, pages).annotations.map(
      (entry) => entry.id,
    );

    expect(ids).toContain("mine");
  });

  test("a reply the reader adds to an imported callout does count", () => {
    const sourceDay = 1_700_000_000_000;
    const overlays = [
      ...Array.from({ length: 200 }, (_, index) =>
        callout(`imported-${index}`, {
          text: body,
          sourceAuthor: "Someone Else",
          sourceModifiedAt: sourceDay + index,
        }),
      ),
      callout("i-replied-here", {
        text: body,
        sourceAuthor: "Someone Else",
        sourceModifiedAt: sourceDay,
        thread: [{ id: "mine", role: "user", text: "追问", at: Date.now() }],
      }),
    ];

    const ids = buildLiveAnnotationDigest(overlays, pages).annotations.map(
      (entry) => entry.id,
    );

    expect(ids).toContain("i-replied-here");
  });


  test("an imported annotation with no metadata at all is still imported", () => {
    // The case inference could never get right: PDF metadata is optional, so
    // a sticky note with no author, no dates and no reply link looked local —
    // and importing rebuilds it through createNoteOverlay(..., now), so it
    // even arrives carrying a fresh timestamp. Only the recorded origin
    // distinguishes it.
    const importMoment = Date.now();
    const overlays = [
      callout("mine", { text: body }),
      ...Array.from({ length: 200 }, (_, index) =>
        callout(`bare-import-${index}`, {
          text: body,
          origin: "imported",
          importedAt: importMoment,
          createdAt: importMoment,
          updatedAt: importMoment,
        }),
      ),
    ];

    const ids = buildLiveAnnotationDigest(overlays, pages).annotations.map(
      (entry) => entry.id,
    );

    expect(ids).toContain("mine");
  });

  test("editing an annotation after import still counts as the reader's", () => {
    const importMoment = Date.now() - 60_000;
    const overlays = [
      ...Array.from({ length: 200 }, (_, index) =>
        callout(`bare-import-${index}`, {
          text: body,
          origin: "imported",
          importedAt: importMoment,
        }),
      ),
      callout("i-edited-this", {
        text: body,
        origin: "imported",
        importedAt: importMoment,
        thread: [{ id: "t", role: "user", text: "追问", at: importMoment + 30_000 }],
      }),
    ];

    const ids = buildLiveAnnotationDigest(overlays, pages).annotations.map(
      (entry) => entry.id,
    );

    expect(ids).toContain("i-edited-this");
  });


  test("editing an imported callout's body makes it fresh", () => {
    // Only notes carry updatedAt, so editing a callout or text overlay left
    // no timestamp anywhere and the annotation the reader had just rewritten
    // still ranked as untouched imported content.
    const importMoment = Date.now() - 60_000;
    // First in the array on purpose: with it last, the position tie-break
    // keeps it either way and the test cannot tell the two apart.
    const overlays = [
      callout("i-rewrote-this", {
        text: body,
        origin: "imported",
        importedAt: importMoment,
        localActivityAt: importMoment + 30_000,
      }),
      ...Array.from({ length: 200 }, (_, index) =>
        callout(`imported-${index}`, {
          text: body,
          origin: "imported",
          importedAt: importMoment,
        }),
      ),
    ];

    const ids = buildLiveAnnotationDigest(overlays, pages).annotations.map(
      (entry) => entry.id,
    );

    expect(ids).toContain("i-rewrote-this");
  });

  test("a source date in the future cannot outrank live activity", () => {
    const overlays = [
      callout("bad-clock", {
        text: body,
        // A file whose /M is years ahead — wrong metadata should not be able
        // to hide what the reader is actually working on.
        sourceModifiedAt: Date.now() + 10 * 365 * 24 * 3600 * 1000,
      }),
      ...Array.from({ length: 200 }, (_, index) =>
        callout(`filler-${index}`, {
          text: body,
          sourceModifiedAt: 1_700_000_000_000 + index,
        }),
      ),
      callout("being-discussed", {
        text: body,
        thread: [{ id: "t1", role: "user", text: "这条", at: Date.now() }],
      }),
    ];

    const ids = buildLiveAnnotationDigest(overlays, pages).annotations.map(
      (entry) => entry.id,
    );

    expect(ids).toContain("being-discussed");
  });
});

describe("fields stay inside every layer's limit", () => {
  // Three layers, three units: this file clamps graphemes, the CLI
  // revalidates with value.length <= 1024 UTF-16 code units and discards the
  // WHOLE digest if a field is over, and Rust budgets UTF-8 bytes. A cut has
  // to respect the tightest of them.
  const CLI_LIMIT_CODE_UNITS = 1024;

  test("a field of wide graphemes stays under the CLI's code-unit limit", () => {
    // A family emoji is 8 UTF-16 code units. 400 of them are 400 graphemes
    // and 3,200 code units — accepted by a grapheme-only clamp, rejected by
    // the CLI, taking every other annotation with it.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const overlays = [
      callout("wide", { text: family.repeat(500) }),
    ];

    const entry = buildLiveAnnotationDigest(overlays, pages).annotations[0];

    expect(entry?.text).toBeTruthy();
    expect((entry?.text ?? "").length).toBeLessThanOrEqual(
      CLI_LIMIT_CODE_UNITS,
    );
    // And still not cut through the middle of a family.
    expect((entry?.text ?? "").replace(/…$/, "").length % 8).toBe(0);
  });


  test("a megabyte of annotation text does not cost a full segmentation", () => {
    // A PDF /Contents has no length limit, and the digest is rebuilt on every
    // content change. Segmenting the whole string produced a grapheme array
    // for text that is discarded past the first thousand code units — about
    // 30 ms and tens of MB per build. The bound is deliberately loose; it is
    // here to catch a return to full segmentation, not to police milliseconds.
    const overlays = [callout("huge", { text: "x".repeat(1_000_000) })];

    const started = performance.now();
    for (let i = 0; i < 20; i += 1) buildLiveAnnotationDigest(overlays, pages);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(500);
  });


  test("a wide-grapheme author stays under the CLI's tighter author limit", () => {
    // The CLI checks author separately at 256 code units, not the 1024 it
    // allows text. 120 graphemes of family emoji are 960 — clearing the
    // shared ceiling and still getting the whole context discarded.
    const CLI_AUTHOR_LIMIT = 256;
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const overlays = [
      callout("c1", {
        text: "short",
        thread: [
          {
            id: "t1",
            role: "agent",
            author: family.repeat(200),
            text: "answer",
            at: Date.now(),
          },
        ],
      }),
    ];

    const author =
      buildLiveAnnotationDigest(overlays, pages).annotations[0]?.thread?.[0]
        ?.author ?? "";

    expect(author.length).toBeGreaterThan(0);
    expect(author.length).toBeLessThanOrEqual(CLI_AUTHOR_LIMIT);
  });

  test("ordinary long text is unaffected", () => {
    const plain = "word ".repeat(30).trim();
    const overlays = [callout("plain", { text: plain })];

    const entry = buildLiveAnnotationDigest(overlays, pages).annotations[0];

    expect(entry?.text).toBe(plain);
  });
});
