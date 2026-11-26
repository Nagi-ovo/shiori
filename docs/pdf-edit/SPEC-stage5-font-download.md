# Stage 5 companion: download matching font

Design record, 2026-11-15. **Download matching font is designed, not
implemented.** Current substitution uses only bundled or metric-compatible
fonts; this record enables no network lookup, download or font installation.
The parent specification is [SPEC-stage5.md](SPEC-stage5.md).

## Product policy and boundary

Jesse approved relaxing strict source-font fidelity on 2026-11-15 toward
typographic substitution, together with full reflow when downward growth
is proved safe. A substitute must still pass coverage, metrics, layout and
saved-output checks. This is an explicit Shiori product decision, not a claim
about any third-party editor's download, licensing or save behavior.

Stroked text in Tr 1/2 remains refused. The Stage-5 Type1 parser invariants,
glyph-identity checks and F14 default-off/native-oracle gate are unchanged.
The refusal tables and pinned baseline in the parent record remain evidence
of their stated revision; this design grants no additional measured acceptance.

## Resolution and selection

A future resolver will identify a missing or unreusable source font by its
PostScript name and family name, retaining typographic weight, italic style
and width when present. It will distinguish a PDF subset prefix from the
underlying name and preserve the original descriptor as diagnostic evidence.
A name match is a candidate, not proof of matching outlines, encoding or metrics.

The resolver will first search fonts already installed for the user through
the platform adapter: fontconfig on Linux, Core Text on macOS and DirectWrite
on Windows. Platform-specific mobile support will expose only fonts the
platform permits the app to read; web will use only explicitly authorized
local-font access when available and otherwise skip this step. An OS match
whose file cannot be read and legally embedded is not reusable. No route will
silently install a font OS-wide or modify the user's font library.

If no acceptable local match exists, the resolver will query a free font
source through the Google Fonts API and/or a versioned, pinned index of
approved OFL, UFL, Apache, Liberation/SIL and GUST font releases. It will
match names and available style axes rather than guess from a generic serif
or sans family. The catalog must identify the exact file and its expected
SHA-256 before acquisition; a name or unpinned URL alone is insufficient.

An approved name-matched system or downloaded font will take precedence over
generic bundled Liberation/Noto substitution when metrics and script coverage
check out. Coverage must include the requested clusters, and the existing
shaping, glyph-identity, metric and layout proofs still apply to the chosen
file. A failed lookup, download, license check, parse, coverage or layout check
will fall back to the bundled substitute path. If that path cannot prove the
edit safe, the existing precise refusal is returned.

## License and cache admission

Before embedding or admission to a persistent cache, the resolver must verify
that the exact file's license already permits embedding and subsetting in
the PDF delivered to the user. The initial allowlist will cover verified
OFL, UFL, Apache 2.0, Liberation/SIL and GUST distributions with their
applicable attribution and redistribution conditions. A family label alone
does not establish permission. Unknown, missing or incompatible licensing
refuses that candidate. The OS/2 fsType flags, when present, are an additional
restriction: prohibited embedding, prohibited subsetting, or a restriction
incompatible with the intended editable PDF rejects the candidate even when
the catalog claims a permissive license. A font without OS/2 still requires
affirmative license evidence; absence of that table grants no permission.

Each candidate decision must record the source names/style, resolved file,
license identifier and retained license evidence, source URL (or local-file
provenance for a system font), expected and actual SHA-256, embedding/subsetting
restriction result, and the final acceptance or rejection reason. A decision
record must distinguish a declined download from a license or coverage failure.

An approved file will be cached by content hash in the app's user-local cache,
with user-only access where the platform supports it. It must never enter the
git repository or a global world-writable store. Web/mobile equivalents must
remain private to the app/user origin. A cache hit will verify its bytes against
the stored hash and retain its license decision. Catalog updates may introduce
a new candidate hash, but may not silently replace a previously accepted file;
new bytes require a new license/security check and the applicable consent.

## Consent, offline behavior and security

Before any font-file download, the app will show the font and style, provider,
source URL and license, and ask the user to approve the acquisition. Lookup
that contacts a remote service must also be disclosed and authorized before
it transmits source-font names. Preview, export and background recovery must
not download through a hidden path. Declining consent leaves the bundled
substitution/refusal path available. All user-visible copy will be localized.
Offline operation will skip downloads and use an approved cached/local font,
a bundled substitute or a precise refusal.

Acquisition will require TLS, a trusted catalog entry and verification against
the pinned SHA-256. Redirects must preserve that transport/provider policy.
The file must pass bounded font parsing, restriction checks and the same
subset/embedder validation as other fallbacks before it is selected for an
edit; untrusted input may be staged transiently for inspection but must not
be admitted to the approved cache first. Cache writes must be atomic and must
not follow an untrusted path. No executable installer, script or system-font
registration will run. Export will embed only the needed subset as Type0,
using the existing fallback writer, and native saved-PDF checks remain required.

The first implementation must exercise consent/decline/offline paths, missing
or ambiguous names, style and script mismatch, local-file access denial,
license/fsType denial, bad TLS/hash, rejected parser/embedder input, corrupted
cache files and a changed upstream version. It must also prove that a permitted
name match wins over a generic substitute and that failures retain the bundled
fallback/refusal path. Download success alone earns no acceptance credit.

## First-cut exclusions

Paid foundries, webfont CSS scraping and changes to the user's system font
library are out of scope. This record does not implement Google Fonts access,
network font installation, new parsers or broader stroke/Type1/F14 eligibility.
