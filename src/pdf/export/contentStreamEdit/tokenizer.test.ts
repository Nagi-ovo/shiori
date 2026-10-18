import { describe, expect, test } from "bun:test";
import {
  coalesceContentStreams,
  ContentStreamParseError,
  tokenizeContentStream,
  type ContentOp,
} from "./tokenizer";

const enc = new TextEncoder();

function ops(source: string): ContentOp[] {
  return tokenizeContentStream(enc.encode(source));
}

function opSummary(op: ContentOp): [string, ...unknown[]] {
  return [
    op.operator,
    ...op.operands.map((operand) => {
      switch (operand.kind) {
        case "number":
          return operand.value;
        case "name":
          return `/${operand.value}`;
        case "string":
          return new TextDecoder("latin1").decode(operand.bytes);
        case "array":
          return operand.items.map((item) =>
            item.kind === "number"
              ? item.value
              : item.kind === "string"
                ? new TextDecoder("latin1").decode(item.bytes)
                : item.kind,
          );
        case "boolean":
          return operand.value;
        default:
          return operand.kind;
      }
    }),
  ];
}

describe("content stream tokenizer", () => {
  test("parses a typical text object with extents that splice back losslessly", () => {
    const source =
      "q\n0.5 0 0 0.5 10 20 cm\nBT\n/F1 12 Tf\n14 TL\n100 700 Td\n(Hello) Tj\nET\nQ";
    const bytes = enc.encode(source);
    const parsed = tokenizeContentStream(bytes);

    expect(parsed.map(opSummary)).toEqual([
      ["q"],
      ["cm", 0.5, 0, 0, 0.5, 10, 20],
      ["BT"],
      ["Tf", "/F1", 12],
      ["TL", 14],
      ["Td", 100, 700],
      ["Tj", "Hello"],
      ["ET"],
      ["Q"],
    ]);

    // Extents are in order, non-overlapping, and re-concatenating source
    // bytes through them reproduces the source exactly (whitespace between
    // extents included via the gaps).
    let cursor = 0;
    let rebuilt = "";
    for (const op of parsed) {
      expect(op.start).toBeGreaterThanOrEqual(cursor);
      rebuilt += source.slice(cursor, op.start);
      rebuilt += source.slice(op.start, op.end);
      cursor = op.end;
    }
    rebuilt += source.slice(cursor);
    expect(rebuilt).toBe(source);

    // Each extent covers operands + operator.
    const tj = parsed.find((op) => op.operator === "Tj")!;
    expect(source.slice(tj.start, tj.end)).toBe("(Hello) Tj");
  });

  test("decodes literal string escapes, octal, nesting, and EOL normalization", () => {
    const [op] = ops("(a\\(b\\)c \\\\ \\101 (nested) \\zx\r\nend) Tj");
    expect(op!.operands[0]).toEqual({
      kind: "string",
      bytes: enc.encode("a(b)c \\ A (nested) zx\nend"),
    });
  });

  test("decodes hex strings including odd digit padding and whitespace", () => {
    const [op] = ops("<48 65 6C6C6F7> Tj");
    expect(op!.operands[0]).toEqual({
      kind: "string",
      bytes: new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x70]),
    });
  });

  test("parses TJ arrays of strings and kerning numbers", () => {
    const [op] = ops("[(Wor) 120 (ld) -30.5 <21>] TJ");
    expect(opSummary(op!)).toEqual([
      "TJ",
      ["Wor", 120, "ld", -30.5, "!"],
    ]);
  });

  test("parses names with #xx escapes and numbers in all syntaxes", () => {
    const parsed = ops("/A#20B /F1 gs\n+4. -.5 0.25 Td");
    expect(opSummary(parsed[0]!)).toEqual(["gs", "/A B", "/F1"]);
    expect(opSummary(parsed[1]!)).toEqual(["Td", 4, -0.5, 0.25]);
  });

  test("treats dictionary operands as opaque but tracks their extent", () => {
    const source = "/OC <</Type /OCMD /X (has >> inside)>> BDC\n(t) Tj\nEMC";
    const parsed = ops(source);
    expect(parsed.map((op) => op.operator)).toEqual(["BDC", "Tj", "EMC"]);
    expect(parsed[0]!.operands.map((operand) => operand.kind)).toEqual([
      "name",
      "dict",
    ]);
    expect(source.slice(parsed[0]!.start, parsed[0]!.end)).toBe(
      "/OC <</Type /OCMD /X (has >> inside)>> BDC",
    );
  });

  test("skips comments and handles boolean/null operands", () => {
    const parsed = ops("% preamble\ntrue false null sh % trailing\nq");
    expect(opSummary(parsed[0]!)).toEqual(["sh", true, false, "null"]);
    expect(parsed[1]!.operator).toBe("q");
  });

  test("captures an inline image with declared /L as one opaque op", () => {
    // Payload contains a fake "EI" to prove /L wins over scanning.
    const payload = "ab EI cd";
    const source = `BI /W 2 /H 2 /L ${payload.length} ID ${payload} EI\nQ`;
    const parsed = ops(source);
    expect(parsed.map((op) => op.operator)).toEqual(["BI", "Q"]);
    expect(source.slice(parsed[0]!.start, parsed[0]!.end)).toBe(
      `BI /W 2 /H 2 /L ${payload.length} ID ${payload} EI`,
    );
  });

  test("captures an inline image without /L by scanning for delimited EI", () => {
    const source = "BI /W 1 /H 1 ID \x00\x01\x02 EI Q";
    const parsed = ops(source);
    expect(parsed.map((op) => op.operator)).toEqual(["BI", "Q"]);
  });

  test("rejects unknown operators instead of guessing", () => {
    expect(() => ops("1 0 0 1 0 0 cmz")).toThrow(ContentStreamParseError);
    expect(() => ops("(a) Tx")).toThrow(ContentStreamParseError);
  });

  test("rejects dangling operands, stray ID/EI, and PostScript braces", () => {
    expect(() => ops("42")).toThrow(ContentStreamParseError);
    expect(() => ops("(data) ID")).toThrow(ContentStreamParseError);
    expect(() => ops("EI")).toThrow(ContentStreamParseError);
    expect(() => ops("{ 0 1 add }")).toThrow(ContentStreamParseError);
  });

  test("coalesces split /Contents parts raw so mid-token splits reassemble", () => {
    const partA = enc.encode("BT /F1 12 Tf 100 7");
    const partB = enc.encode("00 Td (Hi) Tj ET");
    const parsed = tokenizeContentStream(
      coalesceContentStreams([partA, partB]),
    );
    const td = parsed.find((op) => op.operator === "Td")!;
    expect(opSummary(td)).toEqual(["Td", 100, 700]);
  });
});
