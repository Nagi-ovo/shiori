import {
  ANNOTATION_SPEC_SCHEMA,
  MAX_ABSOLUTE_NUMBER,
  MAX_ANNOTATIONS_PER_SPEC,
  MAX_ANNOTATION_SPEC_BYTES,
  MAX_PATHS_PER_ANNOTATION,
  MAX_POINTS_PER_ANNOTATION,
  MAX_RECTS_PER_ANNOTATION,
  MAX_TOTAL_RECTS_PER_SPEC,
  MAX_TEXT_CHARACTERS,
  MAX_TOTAL_TEXT_CHARACTERS,
} from "./annotationSpec";
import {
  MAX_ANCHOR_INDEXED_TEXT_CHARACTERS,
  MAX_ANCHOR_INDEXED_TEXT_SPANS,
  MAX_ANCHOR_INDEXED_TEXT_UNITS,
  MAX_ANCHOR_GEOMETRY_WORK,
  MAX_ANCHOR_RETAINED_RUNS,
  MAX_ANCHOR_SEARCH_MAPPING_EXCEPTIONS,
  MAX_ANCHOR_SEARCH_WORK,
  MAX_ANCHOR_SOURCE_CHARACTERS,
  MAX_ANCHOR_SOURCE_ITEMS,
} from "../../src/pdf/annotations/resolveAnchors";
import {
  MAX_SEMANTIC_CONTENT_ITEMS_PER_PAGE,
  MAX_SEMANTIC_MARKED_CONTENT_DEPTH,
  MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE,
  MAX_SEMANTIC_SOURCE_CHARACTERS_PER_PAGE,
  MAX_SEMANTIC_STYLES_PER_PAGE,
} from "../../src/editor/textSelection/semanticText";

type FieldRequirement = "always" | "versioned" | "optional" | "placement";

type SpecFieldHelp = {
  shape: string;
  required: FieldRequirement;
  defaultWhenUnversioned?: string | number | boolean | null;
  note?: string;
};

type SpecTypeHelp = {
  placement: string;
  fields: Record<string, SpecFieldHelp>;
};

const placementFields = (
  geometry: "rects" | "targetRects" | "at",
): Record<string, SpecFieldHelp> => ({
  anchor: {
    shape: '{ quote: string, page?: int >= 1, occurrence?: int >= 1 }',
    required: "placement",
    note: `use instead of page + ${geometry}; occurrence is global without page and page-local with page`,
  },
  page: {
    shape: "int >= 1",
    required: "placement",
    note: `required with ${geometry}; omit with anchor`,
  },
  [geometry]: {
    shape:
      geometry === "at"
        ? "{ x: number, y: number }"
        : "non-empty PdfRect[]",
    required: "placement",
    note: "omit with anchor",
  },
});

const colorField = (): SpecFieldHelp => ({
  shape: "#RRGGBB",
  required: "versioned",
  note: "defaults when schema is omitted",
});

const strokeWidthField = (): SpecFieldHelp => ({
  shape: "number > 0",
  required: "versioned",
  note: "defaults when schema is omitted",
});

const textMarkupHelp = (type: "highlight" | "underline" | "strikethrough"): SpecTypeHelp => ({
  placement: "anchor OR page + rects",
  fields: {
    ...placementFields("rects"),
    color: colorField(),
    opacity: {
      shape: type === "highlight" ? "number 0..0.45" : "number 0..1",
      required: "versioned",
      note: "defaults when schema is omitted",
    },
    quote: {
      shape: "string",
      required: "optional",
      note: "informational for coordinate specs; omit with anchor",
    },
  },
});

/** One structure feeds both human and agent help so their contracts cannot drift. */
export const SPEC_TYPE_HELP: Record<string, SpecTypeHelp> = {
  highlight: textMarkupHelp("highlight"),
  underline: textMarkupHelp("underline"),
  strikethrough: textMarkupHelp("strikethrough"),
  note: {
    placement: "anchor OR page + at",
    fields: {
      ...placementFields("at"),
      text: { shape: "string", required: "always" },
      color: colorField(),
    },
  },
  callout: {
    placement: "anchor OR page + targetRects",
    fields: {
      ...placementFields("targetRects"),
      rect: {
        shape: "{ x, y, w > 0, h > 0 }",
        required: "optional",
        note: "label box; Shiori places it automatically when omitted",
      },
      leader: {
        shape: "2 or 3 { x, y } points, target to label",
        required: "optional",
        note: "preserves a PDF callout elbow; derived automatically when omitted",
      },
      leaderKind: {
        shape: '"polyline" | "quadratic"',
        required: "optional",
        note: "defaults to quadratic for Shiori-created leaders",
      },
      text: { shape: "string", required: "always" },
      fontSize: {
        shape: "number > 0",
        required: "versioned",
        note: "defaults when schema is omitted",
      },
      color: colorField(),
      quote: {
        shape: "string",
        required: "optional",
        note: "informational for coordinate specs; omit with anchor",
      },
      align: {
        shape: '"left" | "center" | "right"',
        required: "optional",
        defaultWhenUnversioned: "left",
      },
    },
  },
  calloutReply: {
    placement:
      "live app only (shiori app annotate); cannot mix with other types",
    fields: {
      replyTo: {
        shape: "string overlay id of a callout in the open document",
        required: "always",
        note: "read ids from `shiori app context` or a previous annotate result",
      },
      text: { shape: "string", required: "always" },
      author: {
        shape: "string <= 512 characters",
        required: "optional",
        note: "display name for the agent turn (e.g. \"Claude Code\")",
      },
    },
  },
  ink: {
    placement: "page + paths",
    fields: {
      page: { shape: "int >= 1", required: "always" },
      paths: {
        shape: "non-empty array of non-empty { x, y }[] paths",
        required: "always",
        note: `at most ${MAX_PATHS_PER_ANNOTATION} paths and ${MAX_POINTS_PER_ANNOTATION} total points`,
      },
      color: colorField(),
      width: {
        shape: "number > 0",
        required: "versioned",
        note: "defaults when schema is omitted",
      },
    },
  },
  rect: {
    placement: "page + rect",
    fields: {
      page: { shape: "int >= 1", required: "always" },
      rect: { shape: "{ x, y, w > 0, h > 0 }", required: "always" },
      color: colorField(),
      strokeWidth: strokeWidthField(),
      fill: {
        shape: "null",
        required: "versioned",
        defaultWhenUnversioned: null,
      },
    },
  },
  stamp: {
    placement: "page + rect",
    fields: {
      page: { shape: "int >= 1", required: "always" },
      kind: { shape: '"check" | "cross"', required: "always" },
      rect: { shape: "{ x, y, w > 0, h > 0 }", required: "always" },
      color: colorField(),
      strokeWidth: strokeWidthField(),
    },
  },
  text: {
    placement: "page + rect",
    fields: {
      page: { shape: "int >= 1", required: "always" },
      rect: { shape: "{ x, y, w > 0, h > 0 }", required: "always" },
      text: { shape: "string", required: "always" },
      fontSize: {
        shape: "number > 0",
        required: "versioned",
        note: "defaults when schema is omitted",
      },
      color: colorField(),
      bold: {
        shape: "boolean",
        required: "versioned",
        defaultWhenUnversioned: false,
      },
      italic: {
        shape: "boolean",
        required: "optional",
        defaultWhenUnversioned: false,
        note: "optional compatibility field even in schema v1",
      },
      align: {
        shape: '"left" | "center" | "right"',
        required: "versioned",
        defaultWhenUnversioned: "left",
      },
      fontFamily: {
        shape: '"sans" | "serif" | "mono"',
        required: "versioned",
        defaultWhenUnversioned: "sans",
      },
    },
  },
};

// The `shiori help spec` topic. Anchors first: quoting text is the intended
// way to place annotations; raw coordinates are the documented low-level
// fallback. Every JSON example below is executed by
// cli/test/helpSpec.test.ts through the shared violation check, the anchor
// resolver, and parseAnnotationSpec — documentation that stops parsing
// fails CI instead of rotting.

export const SPEC_HELP_EXAMPLES: Array<{ title: string; spec: unknown }> = [
  {
    title: "Write an animated callout anchored to quoted text",
    spec: {
      annotations: [
        {
          type: "callout",
          anchor: { quote: "a local-first PDF reader" },
          text: "This is the key claim",
        },
      ],
    },
  },
  {
    title: "Highlight a quoted sentence (preferred; no coordinates)",
    spec: {
      annotations: [
        {
          type: "highlight",
          anchor: { quote: "a local-first PDF reader" },
        },
      ],
    },
  },
  {
    title: "Disambiguate a repeated quote and attach a note",
    spec: {
      annotations: [
        {
          type: "underline",
          anchor: { quote: "annotation workflow", page: 1, occurrence: 2 },
        },
        {
          type: "note",
          anchor: { quote: "a local-first PDF reader" },
          text: "Verify this claim",
        },
      ],
    },
  },
  {
    title: "Low-level fallback: explicit rects (versioned, all fields)",
    spec: {
      schema: ANNOTATION_SPEC_SCHEMA,
      annotations: [
        {
          type: "highlight",
          page: 1,
          rects: [{ x: 72, y: 640, w: 200, h: 14 }],
          color: "#f6c744",
          opacity: 0.35,
        },
      ],
    },
  },
  {
    title: "Free text uses an explicit rect from/around search geometry",
    spec: {
      annotations: [
        {
          type: "text",
          page: 1,
          rect: { x: 72, y: 610, w: 180, h: 32 },
          text: "Direct page text",
        },
      ],
    },
  },
];

export function specHelpText(): string {
  const examples = SPEC_HELP_EXAMPLES.map(
    (example) => `# ${example.title}\n${JSON.stringify(example.spec, null, 2)}`,
  ).join("\n\n");
  const types = Object.entries(SPEC_TYPE_HELP)
    .map(([type, help]) => {
      const fields = Object.entries(help.fields)
        .map(([name, field]) => {
          const requirement =
            field.required === "always"
              ? "required"
              : field.required === "versioned"
                ? "required with schema"
                : field.required === "placement"
                  ? "placement alternative"
                  : "optional";
          return `    - ${name}: ${field.shape} (${requirement})${field.note ? `; ${field.note}` : ""}`;
        })
        .join("\n");
      return `  ${type}: ${help.placement}\n${fields}`;
    })
    .join("\n");
  return `Annotation specs (${ANNOTATION_SPEC_SCHEMA})

Anchors (preferred):
  Quote the document text; Shiori finds it and computes all geometry.
  anchor: { "quote": "exact text", "page"?: n, "occurrence"?: k }
  - Matching uses the same case-insensitive, compatibility-normalized semantics
    as "shiori search" (CJK included): visual line wraps and wrap hyphens are
    optional, while detected paragraph/column gaps are hard boundaries.
    A match still needs usable glyph geometry; vertical, rotated, scanned, or
    geometry-less text needs rects.
  - 0 matches or several matches fail with candidates (page + occurrence);
    use a listed global occurrence alone, or copy page + its page occurrence.
  - Supported on highlight, underline, strikethrough (fills rects),
    note (fills at), and callout (fills targetRects). Omit
    page/rects/targetRects/at/quote when using an anchor.
    Free text deliberately requires page + rect so it never silently covers
    matched source text. Search resolves glyph bands for markup, but a combined
    PDF text run only permits estimated per-character slicing; use its
    PDF-space geometry as a reference and choose/adjust the text rect explicitly.
  - Scanned pages without a text layer cannot anchor; use "shiori render"
    to look at the page and fall back to explicit rects.

Types and fields:
${types}
  text portability: non-ASCII text supports regular sans only.

Versioning rule (a common trap):
  Omit the "schema" field and fields marked "required with schema" default.
  With "schema": "${ANNOTATION_SPEC_SCHEMA}" present, those fields become
  REQUIRED. Unknown fields are rejected in both forms.

Coordinates (fallback only):
  PDF points, page-local, origin at the page's bottom-left. rects/at/paths
  are drawn exactly where given; nothing snaps to text.

Limits:
  ${MAX_ANNOTATIONS_PER_SPEC} annotations, ${formatBytes(MAX_ANNOTATION_SPEC_BYTES)} spec file, ${MAX_TEXT_CHARACTERS} chars per text
  field, ${MAX_TOTAL_TEXT_CHARACTERS} total text chars, ${MAX_RECTS_PER_ANNOTATION} rects per annotation and ${MAX_TOTAL_RECTS_PER_SPEC} total rects,
  ${MAX_PATHS_PER_ANNOTATION} paths and ${MAX_POINTS_PER_ANNOTATION} points per ink annotation,
  ${MAX_ANCHOR_SEARCH_WORK} folded-character anchor search work units,
  ${MAX_ANCHOR_INDEXED_TEXT_CHARACTERS} retained anchor-text characters and ${MAX_ANCHOR_INDEXED_TEXT_UNITS} semantic units,
  ${MAX_ANCHOR_INDEXED_TEXT_SPANS} retained semantic spans and ${MAX_ANCHOR_SEARCH_MAPPING_EXCEPTIONS} normalization mappings,
  ${MAX_ANCHOR_SOURCE_CHARACTERS} retained source characters, ${MAX_ANCHOR_SOURCE_ITEMS} source items, ${MAX_ANCHOR_RETAINED_RUNS} geometry runs, and ${MAX_ANCHOR_GEOMETRY_WORK} geometry work units,
  ${MAX_SEMANTIC_SOURCE_CHARACTERS_PER_PAGE} source text characters, ${MAX_SEMANTIC_CONTENT_ITEMS_PER_PAGE} text-content items, ${MAX_SEMANTIC_STYLES_PER_PAGE} styles, ${MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE} semantic spans, and ${MAX_SEMANTIC_MARKED_CONTENT_DEPTH} marked-content nesting depth per page,
  |numbers| <= ${MAX_ABSOLUTE_NUMBER}.

Examples:
${examples}`;
}

export function specHelpPayload(): unknown {
  return {
    schema: "shiori.cli/help/spec/v1",
    specSchema: ANNOTATION_SPEC_SCHEMA,
    anchors: {
      shape: {
        quote: "string (required)",
        page: "int >= 1",
        occurrence:
          "int >= 1 (global reading-order match without page; page-local match with page)",
      },
      matching:
        "same case-insensitive, compatibility-normalized matching as `shiori search`; visual wraps/wrap hyphens are optional and paragraph gaps are hard boundaries",
      onAmbiguity:
        "error lists both global and page-local occurrences; use global occurrence alone, or page plus its page-local occurrence",
      supportedTypes: [
        "highlight",
        "underline",
        "strikethrough",
        "note",
        "callout",
      ],
      rule: "omit page/rects/targetRects/at/quote when anchor is present",
      noTextLayer:
        "vertical, rotated, scanned, or geometry-less text cannot anchor; use `shiori render` and explicit rects",
    },
    versioningRule:
      "omit `schema` for defaults; with `schema` present, fields marked versioned become required; unknown fields are always rejected",
    types: SPEC_TYPE_HELP,
    coordinates:
      "fallback only: PDF points, page-local, origin bottom-left; drawn exactly where given",
    limits: {
      maxAnnotations: MAX_ANNOTATIONS_PER_SPEC,
      maxSpecBytes: MAX_ANNOTATION_SPEC_BYTES,
      maxTextCharacters: MAX_TEXT_CHARACTERS,
      maxTotalTextCharacters: MAX_TOTAL_TEXT_CHARACTERS,
      maxRectsPerAnnotation: MAX_RECTS_PER_ANNOTATION,
      maxTotalRects: MAX_TOTAL_RECTS_PER_SPEC,
      maxPathsPerAnnotation: MAX_PATHS_PER_ANNOTATION,
      maxPointsPerAnnotation: MAX_POINTS_PER_ANNOTATION,
      maxAnchorSearchWork: MAX_ANCHOR_SEARCH_WORK,
      maxAnchorIndexedTextCharacters: MAX_ANCHOR_INDEXED_TEXT_CHARACTERS,
      maxAnchorIndexedTextUnits: MAX_ANCHOR_INDEXED_TEXT_UNITS,
      maxAnchorIndexedTextSpans: MAX_ANCHOR_INDEXED_TEXT_SPANS,
      maxAnchorSearchMappingExceptions:
        MAX_ANCHOR_SEARCH_MAPPING_EXCEPTIONS,
      maxAnchorSourceCharacters: MAX_ANCHOR_SOURCE_CHARACTERS,
      maxAnchorSourceItems: MAX_ANCHOR_SOURCE_ITEMS,
      maxAnchorRetainedRuns: MAX_ANCHOR_RETAINED_RUNS,
      maxAnchorGeometryWork: MAX_ANCHOR_GEOMETRY_WORK,
      maxSemanticSourceCharactersPerPage:
        MAX_SEMANTIC_SOURCE_CHARACTERS_PER_PAGE,
      maxSemanticContentItemsPerPage: MAX_SEMANTIC_CONTENT_ITEMS_PER_PAGE,
      maxSemanticSearchSpansPerPage: MAX_SEMANTIC_SEARCH_SPANS_PER_PAGE,
      maxSemanticStylesPerPage: MAX_SEMANTIC_STYLES_PER_PAGE,
      maxSemanticMarkedContentDepth: MAX_SEMANTIC_MARKED_CONTENT_DEPTH,
      maxAbsoluteNumber: MAX_ABSOLUTE_NUMBER,
      maxHighlightOpacity: 0.45,
    },
    examples: SPEC_HELP_EXAMPLES,
  };
}

function formatBytes(bytes: number): string {
  return bytes % (1024 * 1024) === 0
    ? `${bytes / (1024 * 1024)} MiB`
    : `${bytes} bytes`;
}
