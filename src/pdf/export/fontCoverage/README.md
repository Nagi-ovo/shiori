# Existing-font coverage oracle

`createFontCoverage(input: FontInput): FontCoverage` is a synchronous pure
resolver. Supply decoded font program bytes and parsed dictionary fields; no
PDF objects are retained. `fontCoverageFromDict(font)` resolves a pdf-lib font,
while `collectFontCoverage(document)` enumerates page/inherited/Form resources.
Pages are 1-based; `resources[].path` contains nested Form resource names.
Reports are deduplicated by font object, never by BaseFont or subset tag.

```ts
import { collectFontCoverage } from './pdfLibAdapter';
const font = collectFontCoverage(document)[0]!;
const result = font.canEncode('office', { preferredCodes: originalCodes });
if (result.ok) {
  // result.codes preserves code boundaries; result.bytes concatenates them.
  // Honor result.preferredApplied before claiming an original-code round trip.
  // Use PDF dictionary widths separately when compiling a replacement.
} else {
  // result.reason, result.firstMissing, result.offset (UTF-16 index).
}
```

`encodable: Map<string, Uint8Array[]>` preserves all verified candidate codes
for each Unicode string, including ligatures. Default order is shortest code,
then increasing bytes; preferredCodes chooses a matching candidate at each
output code position. A miss or count mismatch returns `preferredApplied: false`;
with no preferences it is true. To force an original ligature round trip, call
`canEncode(cluster, { preferredCodes: [originalCode] })`. Encoding is atomic,
does not normalize text, and backtracks when a greedy cluster would strand a
suffix. This is encoding coverage, not a shaping or layout guarantee.

`glyphIds` records the actual embedded-program GID selected for each resolved
code, including GID 0; Standard-14 and Type3 have no program GIDs.
`codeToUnicode` also retains rejected mappings. `missing` explains rejection
by code/cluster or a font-wide reason. Treat maps and candidate bytes as
read-only. `verification` distinguishes verified programs, viewer-assumed
Standard-14 fonts, defined Type3 CharProcs and unverified fonts.

Supported:

- Simple TrueType: PDF nonsymbolic (3,1)/(1,0)/post selection; symbolic
  (3,0), permitted high-byte ranges, and (1,0). Encoding/Differences controls
  glyph selection independently of ToUnicode. Standard, WinAnsi, MacRoman,
  MacExpert, Symbol and ZapfDingbats encodings; Adobe glyph names and `uni`/`u`
  names. Symbolic fonts without ToUnicode require identifiable built-in names.
  Repeated symbolic hits at one GID are accepted; conflicting GIDs reject only
  that code. Both Symbolic/Nonsymbolic flags with a standard Encoding use the
  nonsymbolic path.
- Type1/MMType1 CFF and OpenType/CFF: named glyphs, built-in encoding and
  actual charstrings. Raw CFF is wrapped only to expose fontkit's CFF parser.
- Type0: Identity-H/V and embedded cidchar/cidrange CMaps (1–4-byte codes);
  CIDFontType2 with Identity/default/stream CIDToGIDMap; CIDFontType0 with
  numeric CFF charset. Identity-V reports `vertical: true`.
- ToUnicode bfchar and sequential/array bfrange, supplementary Unicode and
  multi-character destinations. Counts/ranges/UTF-16/codespaces are bounded
  and validated. Malformed programs refuse without throwing.
- Standard-14 without an embedded program: encoding and AFM glyph presence,
  flagged `non-embedded standard font`; `.notdef` is always absent even if its
  AFM entry has a width. Type3: existing CharProcs codes only,
  flagged `type3: encode only codes already defined in /CharProcs`.

Explicit refusals: raw PostScript Type1/PFB programs unsupported by fontkit;
unknown predefined CMaps and external UseCMap inheritance; CFF encoding
supplements; unknown cmap formats; ambiguous symbolic mappings; missing
ToUnicode on CID fonts; nonembedded nonstandard fonts. No source font grows.
Empty TrueType slots are accepted for mapped whitespace, marks and formatting
controls; nonempty glyphs need a decodable glyf entry. CFF needs a charstring
within the original table bounds. Neither ink area nor advance width is a
coverage criterion.

Run `bun test src/pdf/export/fontCoverage` for the isolated failure-list tests.
Run `bun scripts/font-coverage/report.ts` for 17 deterministic saved PDFs and
JSON reports under `test-artifacts/font-coverage/generated-*.{pdf,json}`.
Run `bun scripts/font-coverage/report.ts path/to/file.pdf [...]` to inspect other
PDFs (`input-*.json`). Summary files are separate so runs do not overwrite one
another. The existing text-state walker collects shown codes with zero widths:
this checks code boundaries/forced round trips, not geometry. Form invocations
are followed with their resource scope and cycle guards even when the parent
walk fails. Code width comes from the rendering Encoding. Variable-width font
shows and unsupported contexts are recorded in `unwalked` and fail the command.
Generated fixtures also compare every shown row, GID and rejection reason with
independent expectations in `scripts/font-coverage/expectations.ts`, including
format-4/12 cmap tables. Missing/extra rows or mismatches fail the command even
when every accepted Unicode mapping can round-trip. Partial ToUnicode maps
remain authoritative; glyph-name fallback applies only when ToUnicode is absent.
Encoding data provenance and redistribution terms are in `DATA-NOTICE.txt`.
No new package dependency was introduced; standard AFM/encoding data comes
from pdf-lib's existing `@pdf-lib/standard-fonts` dependency.

Surgical replacement now consumes `canEncode` through `replaceRunPage`.
Coverage is cached per font dictionary object, and the pure compiler passes
original codes as preferences. Missing/unverified coverage refuses; page use
and ToUnicode alone never prove presence. See `scripts/pdf-inplace/README.md`
for the native path/ink oracle and refusal cases. CFF's fontkit-private decoded
encoding offset is accessed only through `cffEncodingOffset.ts`; missing,
wrong-type or out-of-table values throw and become a font-level unverified
coverage reason.

The async `replaceRunPageWithFallback` adapter handles missing replacement
clusters with a new independent subset; source coverage remains authoritative
and source fonts are never extended. Its verified fallback descriptor enters
the same pure span compiler. See `contentStreamEdit/README.md` for policies.
