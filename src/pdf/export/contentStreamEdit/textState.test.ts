import { describe, expect, test } from "bun:test";
import { tokenizeContentStream } from "./tokenizer";
import { walkTextPlacements, type TextWalkCallbacks } from "./textState";
import type { ContentFontInfo } from "./glyphWidths";

const enc = new TextEncoder();

function latinFont(overrides: Partial<ContentFontInfo> = {}): ContentFontInfo {
  return {
    ok: true,
    bytesPerCode: 1,
    widthOf: (code) => (code === 0x20 ? 250 : 500),
    ascentEm: 0.8,
    descentEm: -0.2,
    appliesWordSpacing: true,
    ...overrides,
  };
}

function walk(
  source: string,
  callbacks?: Partial<TextWalkCallbacks>,
) {
  return walkTextPlacements(tokenizeContentStream(enc.encode(source)), {
    resolveFont: () => latinFont(),
    ...callbacks,
  });
}

function expectOk(result: ReturnType<typeof walk>) {
  if (!result.ok) throw new Error(`walk failed: ${result.reason}`);
  return result;
}

describe("text state walk", () => {
  test("places glyphs with advance-box quads in user space", () => {
    const { glyphs } = expectOk(
      walk("BT /F1 12 Tf 100 700 Td (AB) Tj ET"),
    );
    expect(glyphs).toHaveLength(2);
    const [a, b] = glyphs;
    // A: 0.5em × 12pt wide, descent −2.4 … ascent 9.6 around baseline 700.
    expect(a!.quad[0]).toEqual({ x: 100, y: 697.6 });
    expect(a!.quad[2]).toEqual({ x: 106, y: 709.6 });
    expect(b!.quad[0]).toEqual({ x: 106, y: 697.6 });
    expect(b!.quad[2]).toEqual({ x: 112, y: 709.6 });
    expect(a!.code).toBe(0x41);
    expect(a!.opIndex).toBe(3);
    expect(a!.arrayItemIndex).toBe(-1);
    expect(a!.byteOffset).toBe(0);
    expect(b!.byteOffset).toBe(1);
    expect(a!.tjCompensation).toBeCloseTo(500);
  });

  test("TJ kerning numbers displace subsequent glyphs", () => {
    const { glyphs } = expectOk(walk("BT /F1 12 Tf [(A) -100 (B)] TJ ET"));
    // A advances 6pt; the -100 adjustment adds +1.2pt.
    expect(glyphs[1]!.quad[0]!.x).toBeCloseTo(7.2);
    expect(glyphs[1]!.arrayItemIndex).toBe(2);
    expect(glyphs[1]!.byteOffset).toBe(0);
  });

  test("cm and Tm compose into glyph quads", () => {
    const { glyphs } = expectOk(
      walk("q 2 0 0 2 10 0 cm BT /F1 12 Tf 1 0 0 1 50 50 Tm (A) Tj ET Q"),
    );
    // Text at (50,50) doubled and shifted: origin x = 50*2+10.
    expect(glyphs[0]!.quad[0]!.x).toBeCloseTo(110);
    expect(glyphs[0]!.quad[1]!.x).toBeCloseTo(122); // 6pt advance doubled
  });

  test("char and word spacing extend advances and TJ compensation", () => {
    const { glyphs } = expectOk(
      walk("BT /F1 10 Tf 0.5 Tc 2 Tw 0 0 Td ( A) Tj ET"),
    );
    const [space, a] = glyphs;
    // Space: 2.5pt width + Tc 0.5 + Tw 2 = 5pt advance.
    expect(a!.quad[0]!.x).toBeCloseTo(5);
    expect(space!.tjCompensation).toBeCloseTo(1000 * (0.25 + 2.5 / 10));
    // A's compensation only includes Tc.
    expect(a!.tjCompensation).toBeCloseTo(1000 * (0.5 + 0.5 / 10));
  });

  test("horizontal scaling narrows both quad and advance", () => {
    const { glyphs } = expectOk(walk("BT /F1 12 Tf 50 Tz (AA) Tj ET"));
    expect(glyphs[0]!.quad[1]!.x).toBeCloseTo(3); // 6pt halved
    expect(glyphs[1]!.quad[0]!.x).toBeCloseTo(3);
  });

  test("' and \" move to the next line before showing", () => {
    const result = expectOk(
      walk("BT /F1 12 Tf 14 TL 0 700 Td (A) ' 3 1 (B) \" ET"),
    );
    expect(result.glyphs[0]!.quad[0]!.y).toBeCloseTo(700 - 14 - 2.4);
    expect(result.glyphs[1]!.quad[0]!.y).toBeCloseTo(700 - 28 - 2.4);
    // " set word/char spacing for the shown string.
    expect(result.glyphs[1]!.tjCompensation).toBeCloseTo(1000 * (0.5 + 1 / 12));
  });

  test("2-byte fonts consume code pairs", () => {
    const cid = latinFont({
      bytesPerCode: 2,
      widthOf: () => 1000,
      appliesWordSpacing: false,
    });
    const { glyphs } = expectOk(
      walk("BT /F1 12 Tf <00410042> Tj ET", { resolveFont: () => cid }),
    );
    expect(glyphs).toHaveLength(2);
    expect(glyphs[0]!.code).toBe(0x41);
    expect(glyphs[1]!.code).toBe(0x42);
    expect(glyphs[0]!.byteOffset).toBe(0);
    expect(glyphs[1]!.byteOffset).toBe(2);
    expect(glyphs[1]!.quad[0]!.x).toBeCloseTo(12);
  });

  test("records Do invocations with the CTM in effect", () => {
    const { xobjects } = expectOk(walk("q 2 0 0 2 10 10 cm /X1 Do Q /X2 Do"));
    expect(xobjects).toEqual([
      { opIndex: 2, name: "X1", ctm: [2, 0, 0, 2, 10, 10] },
      { opIndex: 4, name: "X2", ctm: [1, 0, 0, 1, 0, 0] },
    ]);
  });

  test("q/Q restore the full text state", () => {
    const { glyphs } = expectOk(
      walk("BT /F1 12 Tf q /F1 24 Tf Q (A) Tj ET"),
    );
    // Size 24 was pushed and popped; the show uses 12.
    expect(glyphs[0]!.quad[1]!.x).toBeCloseTo(6);
  });

  test("gs taints the font unless the ExtGState is known font-free", () => {
    const source = "BT /F1 12 Tf /G0 gs (A) Tj ET";
    const tainted = walk(source);
    expect(tainted.ok).toBe(false);
    if (!tainted.ok) expect(tainted.reason).toContain("ExtGState");

    const cleared = walk(source, { extGStateSetsFont: () => false });
    expect(cleared.ok).toBe(true);

    const setsFont = walk(source, { extGStateSetsFont: () => true });
    expect(setsFont.ok).toBe(false);
  });

  test("fails closed on unmodelable constructs", () => {
    const failures: Array<[string, string]> = [
      ["BT 7 Tr /F1 12 Tf (A) Tj ET", "clipping"],
      ["(A) Tj", "outside BT"],
      ["BT (A) Tj ET", "no font"],
      ["BT /F1 0 Tf (A) Tj ET", "font size 0"],
      ["Q", "graphics state stack"],
      ["BT BT", "nested BT"],
      ["BT /F1 12 Tf [(A) /X] TJ ET", "TJ array item"],
      ["BT ET ET", "ET without BT"],
      ["BT /F1 12 Tf (A) Tj", "unterminated BT"],
      ["1 2 3 cm", "malformed cm"],
    ];
    for (const [source, fragment] of failures) {
      const result = walk(source);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(fragment);
    }
  });

  test("fails on odd byte count for 2-byte fonts and unknown fonts", () => {
    const cid = latinFont({ bytesPerCode: 2, appliesWordSpacing: false });
    const odd = walk("BT /F1 12 Tf <0041 42> Tj ET", {
      resolveFont: () => cid,
    });
    expect(odd.ok).toBe(false);

    const unknown = walk("BT /F9 12 Tf (A) Tj ET", {
      resolveFont: () => null,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toContain("unresolvable");
  });
});
