import { describe, expect, test } from "bun:test";
import { absorbEdits, mapAbsorbedOffset, substituteAbsorbedText } from "./absorbText";

describe("substituteAbsorbedText", () => {
  test("replaces an exact substring", () => {
    expect(substituteAbsorbedText("say hello world", "hello", "goodbye")).toBe(
      "say goodbye world",
    );
  });

  test("matches across whitespace differences (line join vs space)", () => {
    // Old edit captured "faster inference" from a DOM selection; the new
    // paragraph text joins the same words across a line break.
    expect(
      substituteAbsorbedText(
        "48x faster\ninference on GPUs",
        "faster inference",
        "quicker decoding",
      ),
    ).toBe("48x quicker decoding on GPUs");
  });

  test("collapses run-length whitespace differences", () => {
    expect(substituteAbsorbedText("a  b", "a b", "X")).toBe("X");
  });

  test("keeps $ sequences in the replacement literal", () => {
    expect(substituteAbsorbedText("price: cost", "cost", "$& or $1")).toBe(
      "price: $& or $1",
    );
  });

  test("escapes regex metacharacters in the original text", () => {
    expect(substituteAbsorbedText("f(x) = y", "f(x)", "g(x)")).toBe("g(x) = y");
  });

  test("returns the input unchanged when nothing matches", () => {
    expect(substituteAbsorbedText("abc", "zzz", "X")).toBe("abc");
  });

  test("ignores blank or missing original text", () => {
    expect(substituteAbsorbedText("abc", undefined, "X")).toBe("abc");
    expect(substituteAbsorbedText("abc", "  \n ", "X")).toBe("abc");
  });

  test("replaces only the first occurrence", () => {
    expect(substituteAbsorbedText("aa aa", "aa", "b")).toBe("b aa");
  });
});

// Where a caret hit lands once earlier edits are spliced into a re-opened
// block. Failure list: the caret resets to 0 whenever the opened text
// differs from the source; offsets after a longer/shorter replacement do
// not shift; a hit inside an earlier edit is read in source coordinates;
// later splices are not applied to an earlier one's offsets.
describe("absorbEdits / mapAbsorbedOffset", () => {
  test("splices like substituteAbsorbedText and records each span", () => {
    const result = absorbEdits("ABCDE\nFGHIJ", [
      { originalText: "ABCDE\nFGHIJ", text: "AB-DE\nFGHIJ" },
    ]);
    expect(result.text).toBe("AB-DE\nFGHIJ");
    expect(result.steps).toEqual([{ start: 0, end: 11, length: 11 }]);
  });

  test("a hit inside a re-opened edit keeps its offset in that edit's text", () => {
    const result = absorbEdits("say ABCDE now", [
      { originalText: "ABCDE", text: "AB-long-DE" },
    ]);
    expect(result.text).toBe("say AB-long-DE now");
    expect(mapAbsorbedOffset(result, { step: 0, offset: 7 })).toBe(4 + 7);
  });

  test("source hits before an edit stay and hits after it shift by the length change", () => {
    const longer = absorbEdits("say ABCDE now", [{ originalText: "ABCDE", text: "AB-long-DE" }]);
    expect(mapAbsorbedOffset(longer, { step: null, offset: 2 })).toBe(2);
    expect(mapAbsorbedOffset(longer, { step: null, offset: 11 })).toBe(11 + 5);
    const shorter = absorbEdits("say ABCDE now", [{ originalText: "ABCDE", text: "X" }]);
    expect(shorter.text).toBe("say X now");
    expect(mapAbsorbedOffset(shorter, { step: null, offset: 11 })).toBe(11 - 4);
    // a source hit inside the replaced span has no counterpart: nearest edge
    expect(mapAbsorbedOffset(shorter, { step: null, offset: 6 })).toBe(4);
    expect(mapAbsorbedOffset(shorter, { step: null, offset: 8 })).toBe(5);
  });

  test("later splices move an earlier edit's offsets", () => {
    const result = absorbEdits("one two three", [
      { originalText: "three", text: "3" },
      { originalText: "one", text: "uno!" },
    ]);
    expect(result.text).toBe("uno! two 3");
    expect(mapAbsorbedOffset(result, { step: 0, offset: 1 })).toBe(10);
    expect(mapAbsorbedOffset(result, { step: null, offset: 5 })).toBe(6);
  });

  test("an edit whose source no longer matches records no span", () => {
    const result = absorbEdits("hello", [{ originalText: "absent", text: "x" }]);
    expect(result).toEqual({ text: "hello", steps: [null] });
    expect(mapAbsorbedOffset(result, { step: null, offset: 3 })).toBe(3);
  });
});
