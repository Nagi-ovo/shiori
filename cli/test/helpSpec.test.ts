import { describe, expect, test } from "bun:test";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import type { PageModel } from "../../src/pdf/model/types";
import { parseAnnotationSpec } from "../../src/pdf/annotations/parseSpec";
import {
  buildAnchorPageText,
  resolveAnnotationSpecAnchors,
} from "../../src/pdf/annotations/resolveAnchors";
import { annotationSpecViolation } from "../src/annotationSpec";
import {
  SPEC_HELP_EXAMPLES,
  SPEC_TYPE_HELP,
  specHelpPayload,
  specHelpText,
} from "../src/helpSpec";
import { main } from "../src/main";

// Documentation that stops parsing must fail CI: every example shown by
// `shiori help spec` runs through the same violation check, anchor
// resolver, and parser that real specs hit.

const page: PageModel = {
  id: "page-1",
  sourceIndex: 0,
  rotation: 0,
  originXPt: 0,
  originYPt: 0,
  widthPt: 612,
  heightPt: 792,
};

// Fixture text containing every quote used by the examples; "annotation
// workflow" appears twice so occurrence: 2 resolves.
function fixtureTextContent(): TextContent {
  const lines: Array<[string, number]> = [
    ["a local-first PDF reader", 700],
    ["annotation workflow", 660],
    ["annotation workflow", 620],
  ];
  return {
    items: lines.map(([str, y]) => ({
      str,
      dir: "ltr",
      transform: [12, 0, 0, 12, 72, y],
      width: str.length * 6,
      height: 12,
      fontName: "f1",
      hasEOL: true,
    })),
    styles: {
      f1: { ascent: 0.75, descent: -0.25, fontFamily: "serif", vertical: false },
    },
  } as unknown as TextContent;
}

describe("shiori help spec", () => {
  test("every documented example survives violation, resolution, and parse", async () => {
    for (const example of SPEC_HELP_EXAMPLES) {
      const spec = example.spec as { annotations: unknown[] };
      expect(annotationSpecViolation(spec.annotations)).toBeNull();
      const resolved = (await resolveAnnotationSpecAnchors(
        example.spec,
        1,
        async (pageNumber) =>
          buildAnchorPageText(pageNumber, fixtureTextContent(), page),
      )) as { annotations: unknown[] };
      const overlays = parseAnnotationSpec(resolved, [page], {
        namespace: "helpspec",
        idPrefix: "cli",
      });
      expect(overlays.length).toBe(spec.annotations.length);
    }
  });

  test("human and agent outputs cover anchors first", async () => {
    const text = specHelpText();
    expect(text.indexOf("Anchors")).toBeGreaterThan(-1);
    expect(text.indexOf("Anchors")).toBeLessThan(text.indexOf("Coordinates"));

    const payload = specHelpPayload() as { schema: string; examples: unknown[] };
    expect(payload.schema).toBe("shiori.cli/help/spec/v1");
    expect(payload.examples.length).toBe(SPEC_HELP_EXAMPLES.length);
    expect(Object.keys(SPEC_TYPE_HELP)).toEqual([
      "highlight",
      "underline",
      "strikethrough",
      "note",
      "callout",
      "calloutReply",
      "ink",
      "rect",
      "stamp",
      "text",
    ]);
    expect(SPEC_TYPE_HELP.text?.fields.italic).toMatchObject({
      shape: "boolean",
      required: "optional",
    });
    expect(text).toContain("italic: boolean");
    expect(text).toContain("10000 paths and 100000 points");
    expect(text).toContain("50000000 folded-character anchor search work units");

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      logs.push(String(message ?? ""));
    };
    try {
      await main(["help", "spec", "--agent"]);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      schema: "shiori.cli/help/spec/v1",
      types: {
        ink: { fields: { paths: { required: "always" } } },
        text: { fields: { italic: { required: "optional" } } },
      },
      limits: {
        maxPathsPerAnnotation: 10_000,
        maxPointsPerAnnotation: 100_000,
        maxTotalRects: 100_000,
        maxAnchorSearchWork: 50_000_000,
        maxAnchorIndexedTextCharacters: 8_000_000,
        maxAnchorIndexedTextUnits: 500_000,
        maxAnchorIndexedTextSpans: 150_000,
        maxAnchorSearchMappingExceptions: 100_000,
        maxAnchorSourceCharacters: 8_000_000,
        maxAnchorSourceItems: 300_000,
        maxAnchorRetainedRuns: 300_000,
        maxAnchorGeometryWork: 1_000_000,
        maxSemanticSourceCharactersPerPage: 2_000_000,
        maxSemanticContentItemsPerPage: 100_000,
        maxSemanticSearchSpansPerPage: 50_000,
        maxSemanticStylesPerPage: 50_000,
        maxSemanticMarkedContentDepth: 1_000,
      },
    });
  });
});
