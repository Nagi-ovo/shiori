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
  // Use PDF dictionary widths separately when compiling a replacement.
} else {
  // result.reason, result.firstMissing, result.offset (UTF-16 index).
}
```

`encodable: Map<string, Uint8Array[]>` preserves all verified candidate codes
for each Unicode string, including ligatures. Default order is shortest code,
then increasing bytes; preferredCodes chooses a matching candidate at each
output code position. To force an original ligature round trip, call
`canEncode(cluster, { preferredCodes: [originalCode] })`. Encoding is atomic,
does not normalize text, and backtracks when a greedy cluster would strand a
suffix. This is encoding coverage, not a shaping or layout guarantee.

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
- Type1/MMType1 CFF and OpenType/CFF: named glyphs, built-in encoding and
  actual charstrings. Raw CFF is wrapped only to expose fontkit's CFF parser.
- Type0: Identity-H/V and embedded cidchar/cidrange CMaps (1–4-byte codes);
  CIDFontType2 with Identity/default/stream CIDToGIDMap; CIDFontType0 with
  numeric CFF charset. Identity-V reports `vertical: true`.
- ToUnicode bfchar and sequential/array bfrange, supplementary Unicode and
  multi-character destinations. Counts/ranges/UTF-16/codespaces are bounded
  and validated. Malformed programs refuse without throwing.
- Standard-14 without an embedded program: encoding and AFM glyph presence,
  flagged `non-embedded standard font`. Type3: existing CharProcs codes only,
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
Run `bun scripts/font-coverage/report.ts` for ten deterministic saved PDFs and
JSON reports under `test-artifacts/font-coverage/generated-*.{pdf,json}`.
Run `bun scripts/font-coverage/report.ts path/to/file.pdf [...]` to inspect other
PDFs (`input-*.json`). Summary files are separate so runs do not overwrite one
another. The existing text-state walker collects shown codes with zero widths:
this checks code boundaries/forced round trips, not geometry. Form invocations are followed with their resource scope and cycle guards.
Variable-width font shows and unsupported content contexts are recorded in `unwalked`.
Encoding data provenance and redistribution terms are in `DATA-NOTICE.txt`.
No new package dependency was introduced; standard AFM/encoding data comes
from pdf-lib's existing `@pdf-lib/standard-fonts` dependency.
