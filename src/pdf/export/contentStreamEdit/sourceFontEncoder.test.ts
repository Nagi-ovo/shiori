import { describe, expect, test } from "bun:test";
import { PDFDocument, type PDFDict } from "pdf-lib";
import { createSourceFontEncoder } from "./sourceFontEncoder";

// A minimal simple (1-byte) font dict with a hand-written /ToUnicode CMap:
// bfchar pairs for A/B, an incrementing bfrange for a..c, and an array
// bfrange mapping codes 0x64/0x65 to X/Y.
async function makeSimpleFont(cmap: string | null): Promise<PDFDict> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const entries: Record<string, unknown> = {
    Type: "Font",
    Subtype: "TrueType",
    BaseFont: "Fake",
    FirstChar: 0x41,
    Widths: [500, 600],
  };
  if (cmap !== null) {
    entries.ToUnicode = ctx.register(ctx.stream(cmap));
  }
  return ctx.obj(entries) as PDFDict;
}

// The CIDSystemInfo dict is part of the real pdf-lib CMap template — its
// "<<" / ">>" delimiters once stalled the tokenizer (lone ">" made no
// progress), so keep them in the fixture.
const CMAP = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo <<
  /Registry (Adobe)
  /Ordering (UCS)
  /Supplement 0
>> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
2 beginbfchar
<41> <0041>
<42> <0042>
endbfchar
2 beginbfrange
<61> <63> <0061>
<64> <65> [<0058> <0059>]
endbfrange
endcmap
end
`;

describe("source font encoder", () => {
  test("encodes via bfchar mappings with widths", async () => {
    const encoder = createSourceFontEncoder(await makeSimpleFont(CMAP));
    if (!encoder) throw new Error("expected an encoder");
    expect(encoder.bytesPerCode).toBe(1);
    const line = encoder.encodeLine("AB");
    expect(line).not.toBeNull();
    expect([...line!.bytes]).toEqual([0x41, 0x42]);
    expect(line!.widthEm).toBeCloseTo(1.1, 5);
  });

  test("encodes via an incrementing bfrange", async () => {
    const encoder = createSourceFontEncoder(await makeSimpleFont(CMAP));
    const line = encoder!.encodeLine("abc");
    expect([...line!.bytes]).toEqual([0x61, 0x62, 0x63]);
  });

  test("encodes via an array-destination bfrange", async () => {
    const encoder = createSourceFontEncoder(await makeSimpleFont(CMAP));
    const line = encoder!.encodeLine("XY");
    expect([...line!.bytes]).toEqual([0x64, 0x65]);
  });

  test("returns null for a character outside the CMap", async () => {
    const encoder = createSourceFontEncoder(await makeSimpleFont(CMAP));
    expect(encoder!.encodeLine("AZ")).toBeNull();
  });

  test("returns null without a /ToUnicode CMap", async () => {
    expect(createSourceFontEncoder(await makeSimpleFont(null))).toBeNull();
  });

  test("returns null on a malformed CMap", async () => {
    const broken = "1 beginbfchar\n<41>\nendbfrange\n";
    expect(createSourceFontEncoder(await makeSimpleFont(broken))).toBeNull();
  });
});
