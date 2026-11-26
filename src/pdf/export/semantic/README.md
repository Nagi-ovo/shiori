# Semantic inspection for PDF export

Use `createSemanticInspector(doc).inspectPage(index)` on the loaded source and
on the candidate after its page and catalog changes. Create a new inspector
after a mutation. An inspector indexes the structure once, caches page
results, and reuses decoded bytes and tokens when several invocations share a
stream. The public `inventorySemantics(bytes, pageIndex)` projects the same
bindings to the contract's dependency rows.

- An occurrence is the page content or one invocation of a Form. Its
  `address` starts with `page` and appends the local operator index of each
  `Do`. Its `raw` identifies the shared Form, and `stream` is the public
  reference label. References and operator indices are local to the
  inspected document snapshot.
- Each occurrence has decoded `bytes`, byte-indexed `ops`, the physical
  `parts` and their offsets in the coalesced bytes. `scopesByOp` gives the
  outer-to-inner marked-content stack before each operator. It includes
  caller spans when the occurrence is inside a Form. Each span has its
  opening and closing operator, resolved properties, and the glyphs and
  paint operators it covers. Each glyph retains the show operator, string
  item, and byte offset used by the text compiler.
- Glyph quads and paint bounds use unrotated overlay page coordinates.
  Glyph boxes are typographic bounds. Paint bounds, when available, are
  geometric envelopes. Coverage includes operators inside clips, so a
  dependency's bounding box can extend beyond visible ink. Distinct
  invocations of one stream retain their own glyphs and transforms.
- Each binding pairs a public dependency with its marked-content spans
  and/or objects. A shared span contributes one binding per resolved
  property dictionary, with the union of its invocation bounds. Structure
  replacement text covers descendant spans and objects across the element.
  Check other pages for the same owner before updating a shared value.
  `owner` is the structure element, `reference` is the MCR or OBJR
  dictionary, and `replacementKey` names the replacement entry.
- Use the issues on touched spans and objects to identify unresolved names,
  ownership, or geometry. An issue can also identify a stream, operator,
  ParentTree key, MCID, or reference whose target is absent. The page's
  `issues` list includes diagnostics with no covered operators, such as a
  cyclic branch of the ParentTree. Use those to compare source and
  candidate graphs. A page-wide issue count alone cannot establish contact.

Export takes the source snapshot before annotation filtering. The gate
checks the glyphs addressed by the edit and, for linked flow, the shows
removed and the operator before which the text is inserted. After writing,
it verifies the resulting glyphs, the scopes that contain them, and the
copied references. A failed write is discarded and independent edits
compile again from the source. Strict acceptance also recompiles from the
source and reports only semantic changes in the candidate it returns.

A bare StructParents or StructParent key does not create a structure owner
without a tagged document. Its contents still go through the marked-content
checks, including MCID boundaries, stream identity and reading order.

The gate assigns changes to the source glyphs and keeps unchanged lines and
raised glyphs in their original scopes. Upright columns also supply their
source slots and emitted glyph positions. Each slot must retain its scopes
and read in the same order after compilation.

Whole-span replacement text is updated when the candidate proves the new
glyphs are inside the same scope. A named property can get a private copy.
A structure value can change when its sole child is the verified scope.
Partial replacement and ambiguous shared coverage refuse. The legacy R1
writer can strip a fully covered inline equivalent. The manifest records
`stripped` for that key, review reports `needs-review`, and strict export
drops that edit while retaining its finding and independent edits.
