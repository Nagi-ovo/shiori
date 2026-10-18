import { describe, expect, test } from "bun:test";
import { substituteAbsorbedText } from "./absorbText";

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
