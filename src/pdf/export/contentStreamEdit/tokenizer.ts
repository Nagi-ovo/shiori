// Content-stream tokenizer for the glyph-removal export pass
// (docs/PLAN-CONTENT-STREAM-TEXT-REMOVAL-2026-07.md).
//
// Parses a DECODED and COALESCED page content stream into a flat list of
// operations, each carrying its exact byte extent in the source. A rewrite
// then splices only the show-text ops it modified and copies every other
// byte verbatim (qpdf TokenFilter philosophy: never re-serialize what you
// didn't change).
//
// Scope is deliberately narrow. Operands the removal pass must understand —
// numbers, names, strings, arrays, booleans/null — are parsed; dictionary
// operands (gs/BDC/DP property lists) are scanned for extent only and never
// inspected. An inline image (BI…ID…EI) becomes a single opaque op. Anything
// outside this grammar throws ContentStreamParseError, and callers must treat
// that as "leave the whole page untouched" — a partial parse is never a
// usable result.

export type ContentOperand =
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "string"; bytes: Uint8Array }
  | { kind: "array"; items: ContentOperand[] }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "dict" };

export type ContentOp = {
  operator: string;
  operands: ContentOperand[];
  // Byte extent [start, end) in the source, covering the operands and the
  // operator (for BI: the entire inline image through EI). Splice-safe: the
  // extents of consecutive ops never overlap and appear in source order.
  start: number;
  end: number;
};

export class ContentStreamParseError extends Error {
  constructor(message: string, offset: number) {
    super(`${message} (at byte ${offset})`);
    this.name = "ContentStreamParseError";
  }
}

// PDF 32000-1:2008 Annex A operator summary, plus BX/EX compatibility
// sections. A token outside this set means we lost sync (or the stream uses
// an extension we don't model) — bail rather than guess.
const KNOWN_OPERATORS = new Set([
  "w", "J", "j", "M", "d", "ri", "i", "gs",
  "q", "Q", "cm",
  "m", "l", "c", "v", "y", "h", "re",
  "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n",
  "W", "W*",
  "BT", "ET",
  "Tc", "Tw", "Tz", "TL", "Tf", "Tr", "Ts",
  "Td", "TD", "Tm", "T*",
  "Tj", "TJ", "'", '"',
  "d0", "d1",
  "CS", "cs", "SC", "SCN", "sc", "scn",
  "G", "g", "RG", "rg", "K", "k",
  "sh",
  "BI",
  "Do",
  "MP", "DP", "BMC", "BDC", "EMC",
  "BX", "EX",
]);

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
]);

function isWhitespace(b: number): boolean {
  return WHITESPACE.has(b);
}

function isDelimiter(b: number): boolean {
  return DELIMITERS.has(b);
}

function isRegular(b: number): boolean {
  return !isWhitespace(b) && !isDelimiter(b);
}

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

function isNumberStart(b: number): boolean {
  return isDigit(b) || b === 0x2b /* + */ || b === 0x2d /* - */ || b === 0x2e /* . */;
}

function hexValue(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
}

class Scanner {
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  atEnd(): boolean {
    return this.pos >= this.bytes.length;
  }

  peek(offset = 0): number {
    return this.bytes[this.pos + offset] ?? -1;
  }

  fail(message: string): never {
    throw new ContentStreamParseError(message, this.pos);
  }

  skipWhitespaceAndComments(): void {
    while (!this.atEnd()) {
      const b = this.peek();
      if (isWhitespace(b)) {
        this.pos += 1;
      } else if (b === 0x25 /* % */) {
        while (!this.atEnd() && this.peek() !== 0x0a && this.peek() !== 0x0d) {
          this.pos += 1;
        }
      } else {
        return;
      }
    }
  }

  readKeyword(): string {
    const start = this.pos;
    while (!this.atEnd() && isRegular(this.peek())) this.pos += 1;
    if (this.pos === start) this.fail("expected keyword");
    let out = "";
    for (let i = start; i < this.pos; i += 1) {
      out += String.fromCharCode(this.bytes[i]!);
    }
    return out;
  }

  readNumber(): number {
    const start = this.pos;
    if (this.peek() === 0x2b || this.peek() === 0x2d) this.pos += 1;
    let digits = 0;
    while (isDigit(this.peek())) {
      this.pos += 1;
      digits += 1;
    }
    if (this.peek() === 0x2e) {
      this.pos += 1;
      while (isDigit(this.peek())) {
        this.pos += 1;
        digits += 1;
      }
    }
    if (digits === 0) this.fail("malformed number");
    let text = "";
    for (let i = start; i < this.pos; i += 1) {
      text += String.fromCharCode(this.bytes[i]!);
    }
    const value = Number(text);
    if (!Number.isFinite(value)) this.fail(`non-finite number ${text}`);
    return value;
  }

  readName(): string {
    // Caller consumed the leading '/'.
    let out = "";
    while (!this.atEnd() && isRegular(this.peek())) {
      let b = this.bytes[this.pos]!;
      this.pos += 1;
      if (b === 0x23 /* # */) {
        const hi = hexValue(this.peek());
        const lo = hexValue(this.peek(1));
        if (hi < 0 || lo < 0) this.fail("malformed #xx escape in name");
        b = hi * 16 + lo;
        this.pos += 2;
      }
      out += String.fromCharCode(b);
    }
    return out;
  }

  readLiteralString(): Uint8Array {
    // Caller consumed the opening '('.
    const out: number[] = [];
    let depth = 1;
    while (true) {
      if (this.atEnd()) this.fail("unterminated literal string");
      const b = this.bytes[this.pos]!;
      this.pos += 1;
      if (b === 0x5c /* \ */) {
        const e = this.bytes[this.pos];
        if (e === undefined) this.fail("unterminated escape in string");
        this.pos += 1;
        switch (e) {
          case 0x6e: out.push(0x0a); break; // \n
          case 0x72: out.push(0x0d); break; // \r
          case 0x74: out.push(0x09); break; // \t
          case 0x62: out.push(0x08); break; // \b
          case 0x66: out.push(0x0c); break; // \f
          case 0x28: out.push(0x28); break; // \(
          case 0x29: out.push(0x29); break; // \)
          case 0x5c: out.push(0x5c); break; // \\
          case 0x0d: // line continuation: \CRLF or \CR
            if (this.peek() === 0x0a) this.pos += 1;
            break;
          case 0x0a: // line continuation: \LF
            break;
          default: {
            if (e >= 0x30 && e <= 0x37) {
              // 1-3 octal digits.
              let code = e - 0x30;
              for (let i = 0; i < 2; i += 1) {
                const d = this.peek();
                if (d < 0x30 || d > 0x37) break;
                code = code * 8 + (d - 0x30);
                this.pos += 1;
              }
              out.push(code & 0xff);
            } else {
              // Unknown escape: the spec says ignore the backslash.
              out.push(e);
            }
          }
        }
      } else if (b === 0x28 /* ( */) {
        depth += 1;
        out.push(b);
      } else if (b === 0x29 /* ) */) {
        depth -= 1;
        if (depth === 0) return new Uint8Array(out);
        out.push(b);
      } else if (b === 0x0d) {
        // Unescaped EOL in a string is recorded as LF (CRLF collapses).
        if (this.peek() === 0x0a) this.pos += 1;
        out.push(0x0a);
      } else {
        out.push(b);
      }
    }
  }

  readHexString(): Uint8Array {
    // Caller consumed the opening '<'.
    const out: number[] = [];
    let hi = -1;
    while (true) {
      if (this.atEnd()) this.fail("unterminated hex string");
      const b = this.bytes[this.pos]!;
      this.pos += 1;
      if (b === 0x3e /* > */) {
        if (hi >= 0) out.push(hi * 16); // odd digit count: pad with 0
        return new Uint8Array(out);
      }
      if (isWhitespace(b)) continue;
      const v = hexValue(b);
      if (v < 0) this.fail("invalid hex digit in string");
      if (hi < 0) {
        hi = v;
      } else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
  }
}

// Parses one operand. Returns null if the next token is not an operand
// (i.e. it's an operator keyword or a closing bracket handled by callers).
function parseOperand(s: Scanner, terminator: "]" | ">>" | null): ContentOperand | null {
  s.skipWhitespaceAndComments();
  if (s.atEnd()) return null;
  const b = s.peek();

  if (b === 0x5d /* ] */) {
    if (terminator === "]") return null;
    s.fail("unexpected ]");
  }
  if (b === 0x3e /* > */ && s.peek(1) === 0x3e) {
    if (terminator === ">>") return null;
    s.fail("unexpected >>");
  }

  if (isNumberStart(b)) {
    return { kind: "number", value: s.readNumber() };
  }
  if (b === 0x2f /* / */) {
    s.pos += 1;
    return { kind: "name", value: s.readName() };
  }
  if (b === 0x28 /* ( */) {
    s.pos += 1;
    return { kind: "string", bytes: s.readLiteralString() };
  }
  if (b === 0x3c /* < */) {
    if (s.peek(1) === 0x3c) {
      s.pos += 2;
      skipDictBody(s);
      return { kind: "dict" };
    }
    s.pos += 1;
    return { kind: "string", bytes: s.readHexString() };
  }
  if (b === 0x5b /* [ */) {
    s.pos += 1;
    const items: ContentOperand[] = [];
    while (true) {
      const item = parseOperand(s, "]");
      if (item === null) {
        s.skipWhitespaceAndComments();
        if (s.peek() !== 0x5d) s.fail("unterminated array");
        s.pos += 1;
        return { kind: "array", items };
      }
      items.push(item);
    }
  }
  if (b === 0x7b /* { */ || b === 0x7d /* } */) {
    s.fail("PostScript braces are not valid in content streams");
  }
  if (isRegular(b)) {
    // Keyword: either a boolean/null operand or an operator (caller's call).
    const save = s.pos;
    const keyword = s.readKeyword();
    if (keyword === "true") return { kind: "boolean", value: true };
    if (keyword === "false") return { kind: "boolean", value: false };
    if (keyword === "null") return { kind: "null" };
    s.pos = save;
    return null;
  }
  s.fail(`unexpected byte 0x${b.toString(16)}`);
}

// Scans (does not model) a dictionary body up to and including the closing
// '>>'. Values are parsed with the same operand grammar, which keeps strings
// containing ">>" from desyncing the scan.
function skipDictBody(s: Scanner): void {
  while (true) {
    const operand = parseOperand(s, ">>");
    if (operand === null) {
      s.skipWhitespaceAndComments();
      if (s.peek() === 0x3e && s.peek(1) === 0x3e) {
        s.pos += 2;
        return;
      }
      // parseOperand returned null on an operator keyword — invalid in a dict.
      s.fail("unexpected token in dictionary");
    }
  }
}

// Inline image: caller consumed "BI". Parses the key/value pairs, the ID
// operator, then the binary payload through EI. The /L (or /Length) key is
// honored when present; otherwise we scan for a whitespace-delimited EI.
function skipInlineImage(s: Scanner): void {
  let declaredLength: number | null = null;
  let pendingKey: string | null = null;
  while (true) {
    const operand = parseOperand(s, null);
    if (operand === null) {
      s.skipWhitespaceAndComments();
      const keyword = s.readKeyword();
      if (keyword !== "ID") s.fail(`unexpected ${keyword} in inline image`);
      break;
    }
    if (pendingKey === null) {
      if (operand.kind !== "name") s.fail("inline image key must be a name");
      pendingKey = operand.value;
    } else {
      if (
        (pendingKey === "L" || pendingKey === "Length") &&
        operand.kind === "number"
      ) {
        declaredLength = operand.value;
      }
      pendingKey = null;
    }
  }
  // Exactly one whitespace byte separates ID from the data.
  if (isWhitespace(s.peek())) s.pos += 1;
  if (declaredLength !== null && Number.isInteger(declaredLength) && declaredLength >= 0) {
    s.pos += declaredLength;
    s.skipWhitespaceAndComments();
    const keyword = s.readKeyword();
    if (keyword !== "EI") s.fail("inline image /L did not land on EI");
    return;
  }
  // No declared length: scan for ws + "EI" + (ws | delimiter | EOF). A false
  // match inside binary data would desync the parse, which then fails and the
  // caller bails on the page — never a silently wrong rewrite.
  while (true) {
    if (s.pos + 1 >= s.bytes.length) s.fail("unterminated inline image");
    if (
      isWhitespace(s.bytes[s.pos - 1]!) &&
      s.bytes[s.pos] === 0x45 /* E */ &&
      s.bytes[s.pos + 1] === 0x49 /* I */ &&
      (s.pos + 2 >= s.bytes.length ||
        isWhitespace(s.bytes[s.pos + 2]!) ||
        isDelimiter(s.bytes[s.pos + 2]!))
    ) {
      s.pos += 2;
      return;
    }
    s.pos += 1;
  }
}

export function tokenizeContentStream(bytes: Uint8Array): ContentOp[] {
  const s = new Scanner(bytes);
  const ops: ContentOp[] = [];
  let operands: ContentOperand[] = [];
  let extentStart: number | null = null;

  while (true) {
    s.skipWhitespaceAndComments();
    if (s.atEnd()) {
      if (operands.length > 0) s.fail("dangling operands at end of stream");
      return ops;
    }
    const tokenStart = s.pos;
    const operand = parseOperand(s, null);
    if (operand !== null) {
      if (extentStart === null) extentStart = tokenStart;
      operands.push(operand);
      continue;
    }
    const operator = s.readKeyword();
    if (operator === "ID" || operator === "EI") {
      s.fail(`${operator} outside an inline image`);
    }
    if (!KNOWN_OPERATORS.has(operator)) {
      throw new ContentStreamParseError(
        `unknown operator "${operator}"`,
        tokenStart,
      );
    }
    if (operator === "BI") {
      if (operands.length > 0) s.fail("BI takes no operands");
      skipInlineImage(s);
      ops.push({
        operator: "BI",
        operands: [],
        start: tokenStart,
        end: s.pos,
      });
      extentStart = null;
      continue;
    }
    ops.push({
      operator,
      operands,
      start: extentStart ?? tokenStart,
      end: s.pos,
    });
    operands = [];
    extentStart = null;
  }
}

// Coalesces a page's /Contents parts for parsing. Real-world files split the
// array in the middle of a lexical token (the exact pitfall qpdf's
// coalesceContentStreams documents), so parts are joined RAW — inserting a
// separator would break a split token. The residual risk (a spec-compliant
// writer splitting between tokens with no trailing whitespace, merging "1"
// and "0 w" into "10 w") is caught downstream: the tokenizer or the text
// state machine's operand arity checks fail and the page is left untouched.
export function coalesceContentStreams(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
