# Bounded reflow layout

The [layout contract](SPEC-stage5.md#49-layout-engine-selection) uses
verified source codes, PDF dictionary advances and original TJ adjustments.
[ISO 32000-1](https://udp.adobe.io/document-services/docs/assets/35e4369068f86065372c18787171a17e/PDF_ISO_32000-1.pdf) defines text placement in §9.4 and font resources in §§9.6–9.7.
Layout preserves the connection between a source glyph and its text operator.
New glyphs use the advances of the font resource that will be written to the
PDF.

The [reflow planner](../../src/pdf/export/contentText/reflowPlan.ts) and
[compiler](../../src/pdf/export/contentText/reflowCompile.ts) use bounded
regions to track which glyphs an edit may move. A line slot specifies its own left edge,
right edge and baseline. Flush, first-line and hanging indents keep their own
slot widths. A paragraph-level box supplies an outer bound.

Wrap at supported break opportunities inside the available slots. Preserve
TJ adjustments at their original boundaries, and refuse a break that would
split a nonzero adjustment. Before writing the stream, check the replacement
codes and positions, the unchanged glyph origins and the text state at the
rejoin. Native export tests check the saved page's text and raster geometry.
