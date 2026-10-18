import { describe, expect, test } from "bun:test";
import type { PdfSecurity } from "../engine/types";
import { deniedEdits, mayPrint, restrictedEdits } from "./permissions";

// What can go wrong deciding whether an encrypted PDF's /P allows an edit:
// - an unencrypted file (no security) must allow everything;
// - the owner password (every bit set, or 0xFFFFFFFC as PDFium reports it)
//   must allow everything, at every revision;
// - annotations follow bit 6 alone, whatever bit 4 says;
// - page content follows bit 4;
// - page structure follows bit 4 at revision 2 and bit 11 alone from
//   revision 3 on: bit 4 excludes what bits 6, 9 and 11 control, so it
//   neither grants assembly past a clear bit 11 nor is needed beside a set one;
// - /P arrives signed (-3904) or unsigned (4294963392) and must read the same;
// - an edit set with nothing in it is never denied;
// - printing ignores bit 3 (print) of the password that opened the file, or
//   is refused to the owner or to an unencrypted file.

const MODIFY = 1 << 3;
const ANNOTATE = 1 << 5;
const ASSEMBLE = 1 << 10;
const NONE = 0xfffff0c0; // bits 7-8 and 13-32: what a "nothing allowed" /P sets
const security = (permissions: number, revision = 4): PdfSecurity => ({
  revision,
  permissions,
  userPermissions: permissions,
});
const ALL = ["annotations", "content", "pages"] as const;

describe("PDF permissions", () => {
  test("an unencrypted file and the owner password allow every edit", () => {
    expect(deniedEdits(null, ALL)).toEqual([]);
    for (const revision of [2, 3, 4, 6]) {
      expect(deniedEdits(security(0xffffffff, revision), ALL)).toEqual([]);
      expect(deniedEdits(security(0xfffffffc, revision), ALL)).toEqual([]);
    }
  });

  test("annotations need bit 6 and nothing else", () => {
    expect(deniedEdits(security(NONE | ANNOTATE), ["annotations"])).toEqual([]);
    expect(deniedEdits(security(NONE | MODIFY), ["annotations"])).toEqual(["annotations"]);
  });

  test("page content needs bit 4", () => {
    expect(deniedEdits(security(NONE | MODIFY), ["content"])).toEqual([]);
    expect(deniedEdits(security(NONE | ANNOTATE | ASSEMBLE), ["content"])).toEqual(["content"]);
  });

  test("pages need bit 4 at revision 2 and bit 11 from revision 3", () => {
    expect(deniedEdits(security(NONE | MODIFY, 2), ["pages"])).toEqual([]);
    expect(deniedEdits(security(NONE | ASSEMBLE, 2), ["pages"])).toEqual(["pages"]);
    expect(deniedEdits(security(NONE | ASSEMBLE, 3), ["pages"])).toEqual([]);
    expect(deniedEdits(security(NONE | ASSEMBLE, 6), ["pages"])).toEqual([]);
    // Modify on, assemble off (/P 0xfffff0c8): no page edits.
    expect(deniedEdits(security(0xfffff0c8, 4), ["pages"])).toEqual(["pages"]);
    expect(deniedEdits(security(NONE | MODIFY, 3), ["pages"])).toEqual(["pages"]);
    expect(deniedEdits(security(NONE | MODIFY, 6), ["pages"])).toEqual(["pages"]);
    expect(deniedEdits(security(NONE, 4), ["pages"])).toEqual(["pages"]);
  });

  test("a signed /P reads as its unsigned twin", () => {
    const signed = security(-3904 | ANNOTATE);
    const unsigned = security((-3904 | ANNOTATE) >>> 0);
    expect(deniedEdits(signed, ALL)).toEqual(deniedEdits(unsigned, ALL));
    expect(deniedEdits(signed, ALL)).toEqual(["content", "pages"]);
  });

  test("no edits are never denied, and the restrictions list what any edit would hit", () => {
    expect(deniedEdits(security(NONE), [])).toEqual([]);
    expect(restrictedEdits(security(NONE))).toEqual(["annotations", "content", "pages"]);
    expect(restrictedEdits(security(NONE | ANNOTATE))).toEqual(["content", "pages"]);
    expect(restrictedEdits(security(0xfffffffc))).toEqual([]);
    expect(restrictedEdits(null)).toEqual([]);
  });

  test("printing needs bit 3 of the password that opened the file", () => {
    const PRINT = 1 << 2;
    expect(mayPrint(null)).toBe(true);
    for (const revision of [2, 4, 6]) {
      expect(mayPrint(security(0xfffffffc, revision))).toBe(true);
      expect(mayPrint(security(NONE | PRINT, revision))).toBe(true);
      expect(mayPrint(security(NONE | MODIFY | ANNOTATE | ASSEMBLE, revision))).toBe(false);
    }
    expect(mayPrint(security(-3904))).toBe(false);
    expect(mayPrint(security(-3904 | PRINT))).toBe(true);
  });
});
