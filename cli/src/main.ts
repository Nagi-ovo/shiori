// No `#!/usr/bin/env bun` line: Bun.build then links this entry for the bun
// target and the modules it imports for node too, bundling those twice
// (cli/build.ts refuses such a bundle). Run it as `bun cli/src/main.ts`.
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultTreeAdapter,
  parse as parseHtml,
  type DefaultTreeAdapterMap,
  type DefaultTreeAdapterTypes,
  type TreeAdapter,
} from "parse5";
import packageJson from "../package.json" with { type: "json" };
import {
  AtomicOutputPublishedOutcomeUnknownError,
} from "./atomicOutput";
import {
  annotateDocument,
  errorMessageForPdfKind,
  readAnnotateSourcePdf,
  type AnnotateCliErrorCode,
} from "./annotate";
import { openCoreDocument, type CoreDocument, type CoreMetadata } from "./coreEngine";
import {
  ExtractError,
  corePageModel,
  extractResultAsSpec,
  extractAnnotationsFromCore,
  formatExtractHumanLine,
  type ExtractResult,
} from "./extract";
import { pageTextFromPdfiumGlyphs } from "../../src/pdf/engine/pdfiumText";
import type { PdfPageTextContent } from "../../src/pdf/engine/text";
import {
  MAX_ANNOTATION_SPEC_BYTES,
  annotationSpecByteLength,
  annotationSpecViolation,
} from "./annotationSpec";
import {
  MAX_ANCHOR_INDEXED_TEXT_SPANS,
  MAX_ANCHOR_INDEXED_TEXT_UNITS,
  MAX_ANCHOR_RETAINED_RUNS,
  MAX_ANCHOR_SEARCH_MAPPING_EXCEPTIONS,
  MAX_ANCHOR_SOURCE_CHARACTERS,
  MAX_ANCHOR_SOURCE_ITEMS,
  AnchorResolutionError,
  AnchorTextUnavailableError,
  buildAnchorPageText,
  iterateAnchorSearchRanges,
  resolveAnnotationSpecAnchors,
  type AnchorPageText,
} from "../../src/pdf/annotations/resolveAnchors";
import {
  AnchorGeometryLimitError,
  charRangeToPageRects,
} from "../../src/pdf/annotations/anchorGeometry";
import type { OverlayTextAnchor, PageModel, PdfRect } from "../../src/pdf/model/types";
import {
  MAX_RECTS_PER_ANNOTATION,
  MAX_TOTAL_RECTS_PER_SPEC,
} from "../../src/pdf/annotations/spec";
import {
  RenderOutputConflictError,
  RenderOutputExistsError,
  assertRenderOutputIsDistinct,
  atomicWriteNewFile,
  renderCorePageToPng,
} from "./render";
import { specHelpPayload, specHelpText } from "./helpSpec";
import { detectDocumentKind, type DocumentKind } from "../../src/documents/types";
import {
  SearchTextLimitError,
  buildSearchTextIndex,
  compileSearchQuery,
  iterateSearchRanges,
  makeSearchSnippet,
  type SearchMatch,
} from "../../src/editor/search/findMatches";
import {
  SemanticTextLimitError,
  semanticTextContentToString,
} from "../../src/editor/textSelection/semanticText";
import {
  MAX_PDF_BYTES,
  PdfOpenError,
  assertPdfWithinFileLimit,
  assertPdfWithinPageLimit,
  classifyPdfOpenError,
  diagnosticCode,
} from "../../src/pdf/openPolicy";
import { BoundedFileError, readFileWithinLimit } from "./safeRead";
import {
  LiveAppError,
  annotateLiveApp,
  getLiveAppContextDetails,
  type LiveAppContext,
  type LiveAppErrorCode,
} from "./liveApp";

type OutputFormat = "human" | "json";
type CommandName =
  | "inspect"
  | "text"
  | "search"
  | "annotate"
  | "extract"
  | "render"
  | "app";
type ParsedCommand = CommandName | "help" | "version";

type GlobalOptions = {
  format: OutputFormat;
  pages?: string;
  password?: string;
  limit?: number;
  maxChars?: number;
  specPath?: string;
  outputPath?: string;
  baseSha256?: string;
  highlights: string[];
  page?: number;
  scale?: number;
  asSpec: boolean;
  pageInfo: boolean;
  metadata: boolean;
  agent: boolean;
  force: boolean;
  inPlace: boolean;
  dryRun: boolean;
};

type CliErrorCode =
  | "ERR_USAGE"
  | "ERR_UNSUPPORTED_DOCUMENT"
  | "ERR_FILE_UNAVAILABLE"
  | "ERR_FILE_TOO_LARGE"
  | "ERR_SPEC_INVALID"
  | "ERR_ANCHOR_UNRESOLVED"
  | "ERR_TEXT_UNAVAILABLE"
  | "ERR_ANNOTATIONS_UNAVAILABLE"
  | "ERR_OUTPUT_EXISTS"
  | "ERR_OUTPUT_CONFLICT"
  | "ERR_OUTPUT_OUTCOME_UNKNOWN"
  | "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED"
  | "ERR_WRITE_FAILED"
  | LiveAppErrorCode
  | ReturnType<typeof diagnosticCode>;

class CliError extends Error {
  code: CliErrorCode;
  detail?: string;

  constructor(code: CliErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.detail = detail;
  }
}

type FileInfo = {
  path: string;
  name: string;
  sizeBytes: number;
  kind: DocumentKind;
};

type PdfPageInfo = {
  page: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
};

type TextPage = {
  page: number;
  text: string;
  characters: number;
  truncated: boolean;
};

type PdfTextExtraction = {
  pages: TextPage[];
  truncated: boolean;
};

type PdfSearchPage = {
  page: number;
  text: AnchorPageText;
};

export type PdfSearchRetentionBudget = {
  units: number;
  spans: number;
  mappingExceptions: number;
  sourceItems: number;
  sourceCharacters: number;
  runs: number;
};

type PdfSearchPlacement = {
  page: number;
  pageOccurrence: number;
  globalOccurrence: number;
  anchor: { quote: string; page: number; occurrence: number };
  rects?: PdfRect[];
  rect?: PdfRect;
  geometryUnavailable?: string;
};

type CliSearchMatch = SearchMatch & Partial<PdfSearchPlacement>;

const SCHEMA_VERSION = 1;
const CLI_VERSION = packageJson.version;
const DEFAULT_AGENT_SEARCH_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 1_000;
const MAX_SEARCH_LIMIT = 10_000;
const MAX_SEARCH_MATCH_COUNT = 1_000_000;
const MAX_SEARCH_GEOMETRY_WORK = 1_000_000;
const MAX_SEARCH_OUTPUT_RECTS = MAX_TOTAL_RECTS_PER_SPEC;
const MAX_EXTRACTED_TEXT_CHARACTERS = 10_000_000;
const HUMAN_INSPECT_PAGE_LIMIT = 20;
const HUMAN_ANCHOR_PREVIEW_LIMIT = 20;
const HUMAN_ANCHOR_RECT_LIMIT = 8;
const MAX_HIGHLIGHT_FLAGS = 16;
const MAX_MARKDOWN_BYTES = 20 * 1024 * 1024;
const MAX_HTML_BYTES = 10 * 1024 * 1024;
export async function main(argv: string[]): Promise<void> {
  const startedAt = performance.now();
  const parsed = parseArgs(argv);
  if (parsed.version || parsed.command === "version") {
    writeVersion(parsed.options);
    return;
  }
  if (parsed.help || parsed.command === "help" || !parsed.command) {
    writeHelp(helpTargetFor(parsed), parsed.options);
    return;
  }

  const result = await runCommand(parsed.command, parsed.positionals, parsed.options);
  if (parsed.command === "extract" && parsed.options.asSpec) {
    const spec = extractResultAsSpec(result as ExtractResult);
    const violation = annotationSpecViolation(spec.annotations);
    if (violation) throw new CliError("ERR_SPEC_INVALID", violation);
    const sizeBytes = annotationSpecByteLength(spec);
    if (sizeBytes > MAX_ANNOTATION_SPEC_BYTES) {
      throw new CliError(
        "ERR_SPEC_INVALID",
        `Extracted annotation spec exceeds the ${formatBytes(
          MAX_ANNOTATION_SPEC_BYTES,
        )} output limit`,
        `${sizeBytes} bytes`,
      );
    }
    // Specs are redirectable machine input. Always emit the exact compact
    // representation that was measured above, independent of --agent/--json.
    console.log(JSON.stringify(spec));
    return;
  }
  if (parsed.options.format === "json") {
    const outputCommand = commandNameForOutput(
      parsed.command,
      parsed.positionals,
    );
    writeJson(
      {
        schema: "shiori.cli/v1",
        ok: true,
        command: outputCommand,
        data: result,
        warnings: [],
        meta: parsed.options.agent
          ? { version: SCHEMA_VERSION, cliVersion: CLI_VERSION }
          : {
              version: SCHEMA_VERSION,
              cliVersion: CLI_VERSION,
              durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            },
      },
      parsed.options,
    );
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: GlobalOptions,
): Promise<unknown> {
  if (command === "inspect") {
    const filePath = requireArg(args[0], "inspect requires a file path");
    return inspectDocument(filePath, options);
  }
  if (command === "text") {
    const filePath = requireArg(args[0], "text requires a file path");
    return extractDocumentText(filePath, options);
  }
  if (command === "search") {
    const filePath = requireArg(args[0], "search requires a file path");
    const query = requireArg(args[1], "search requires a query");
    return searchDocument(filePath, query, options);
  }
  if (command === "annotate") {
    const filePath = requireArg(args[0], "annotate requires an input PDF");
    const specPath =
      options.highlights.length > 0
        ? undefined
        : requireArg(
            options.specPath,
            "annotate requires --spec <spec.json> or --highlight <quote>",
          );
    const outputPath = requireArg(
      options.outputPath,
      "annotate requires -o <output.pdf>",
    );
    return annotatePdf(filePath, specPath, outputPath, options);
  }
  if (command === "extract") {
    const filePath = requireArg(args[0], "extract requires a PDF file");
    return extractPdfAnnotations(filePath, options);
  }
  if (command === "render") {
    const filePath = requireArg(args[0], "render requires a PDF file");
    const pageNumber = options.page;
    if (pageNumber == null) {
      throw new CliError("ERR_USAGE", "render requires --page <n>");
    }
    const outputPath = requireArg(
      options.outputPath,
      "render requires -o <output.png>; there is no default output location",
    );
    return renderPdfPage(filePath, pageNumber, outputPath, options);
  }
  if (command === "app") {
    const subcommand = args[0];
    if (subcommand === "context") return liveAppContext(options);
    if (subcommand === "annotate") {
      const specPath =
        options.highlights.length > 0
          ? null
          : requireArg(
              options.specPath,
              "app annotate requires --spec <spec.json> or --highlight <quote>",
            );
      return liveAppAnnotate(specPath, options);
    }
  }
  throw new CliError("ERR_USAGE", `Unknown command: ${command}`);
}

async function inspectDocument(
  inputPath: string,
  options: GlobalOptions,
): Promise<unknown> {
  const file = await readFileInfo(inputPath);
  if (file.kind !== "pdf") {
    rejectPdfOnlyOptions(file, options, ["pages", "password", "pageInfo", "metadata"]);
    const text = await readTextDocument(file);
    const payload = {
      kind: "document.inspect",
      version: SCHEMA_VERSION,
      file,
      text: {
        characters: text.length,
        lines: text.split(/\r\n|\r|\n/).length,
      },
    };
    if (options.format === "human") {
      console.log(sanitizeTerminalText(file.name));
      console.log(`Kind: ${file.kind}`);
      console.log(`Size: ${file.sizeBytes} bytes`);
      console.log(`Text: ${payload.text.characters} chars, ${payload.text.lines} lines`);
    }
    return payload;
  }

  // `!== undefined`, matching selectedPageNumbers: `--pages ""` is a usage
  // error rather than "not supplied", so it must not read as absent here
  // either. Previously the two disagreed and `inspect --agent --pages ""`
  // returned neither an error nor a `pages` array.
  const includePageInfo =
    options.format === "human" ||
    options.pageInfo ||
    options.pages !== undefined;
  // Plain human inspect should not pay thousands of sequential getPage()
  // calls on a large PDF just to print per-page lines; cap the default
  // listing and point at --pages for the rest.
  const humanDefaultPageList =
    options.format === "human" &&
    !options.pageInfo &&
    options.pages === undefined;
  const pdf = await withPdf(file, options, async ({ reader }) => {
    const metadata = options.metadata ? await reader.metadata() : undefined;
    const pageSelection =
      options.pages ??
      (humanDefaultPageList && reader.pageCount > HUMAN_INSPECT_PAGE_LIMIT
        ? `1-${HUMAN_INSPECT_PAGE_LIMIT}`
        : undefined);
    const pages = includePageInfo
      ? await pdfPageInfo(reader, pageSelection)
      : undefined;
    return {
      pageCount: reader.pageCount,
      ...(pages ? { pages } : {}),
      ...(metadata ? { metadata } : {}),
    };
  });
  const payload = {
    kind: "pdf.inspect",
    version: SCHEMA_VERSION,
    file,
    pdf,
  };
  if (options.format === "human") {
    console.log(sanitizeTerminalText(file.name));
    console.log(`Kind: pdf`);
    console.log(`Size: ${file.sizeBytes} bytes`);
    console.log(`Pages: ${pdf.pageCount}`);
    for (const page of pdf.pages ?? []) {
      console.log(
        `  ${page.page}: ${formatNumber(page.widthPt)} x ${formatNumber(
          page.heightPt,
        )} pt, rotate ${page.rotation}`,
      );
    }
    if (humanDefaultPageList && pdf.pageCount > HUMAN_INSPECT_PAGE_LIMIT) {
      console.log(
        `  ... ${pdf.pageCount - HUMAN_INSPECT_PAGE_LIMIT} more pages (use --pages to list others)`,
      );
    }
    if (options.metadata) {
      console.log("Metadata:");
      const entries = Object.entries(pdf.metadata ?? {}).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      if (entries.length === 0) {
        console.log("  (none)");
      } else {
        for (const [key, value] of entries) {
          console.log(`  ${singleLine(key)}: ${singleLine(value)}`);
        }
      }
    }
  }
  return payload;
}

async function extractDocumentText(
  inputPath: string,
  options: GlobalOptions,
): Promise<unknown> {
  const file = await readFileInfo(inputPath);
  if (file.kind !== "pdf") {
    rejectPdfOnlyOptions(file, options, ["pages", "password"]);
    const text = await readTextDocument(file);
    const limited = limitText(
      text,
      options.maxChars ?? MAX_EXTRACTED_TEXT_CHARACTERS,
    );
    const payload = {
      kind: "document.text",
      version: SCHEMA_VERSION,
      file,
      text: limited.text,
      characters: limited.characters,
      truncated: limited.truncated,
    };
    if (options.format === "human") {
      console.log(sanitizeTerminalText(limited.text));
      if (limited.truncated) console.log("... [truncated]");
    }
    return payload;
  }

  const extracted = await withPdf(file, options, ({ reader }) =>
    pdfTextPages(
      reader,
      options.pages,
      options.maxChars ?? MAX_EXTRACTED_TEXT_CHARACTERS,
    ),
  );
  const pages = extracted.pages;
  const payload = {
    kind: "pdf.text",
    version: SCHEMA_VERSION,
    file,
    pages,
    returnedCharacters: pages.reduce((sum, page) => sum + page.text.length, 0),
    truncated: extracted.truncated,
  };
  if (options.format === "human") {
    for (const page of pages) {
      console.log(`--- page ${page.page} ---`);
      console.log(sanitizeTerminalText(page.text));
      if (page.truncated) console.log("... [truncated]");
    }
  }
  return payload;
}

async function searchDocument(
  inputPath: string,
  query: string,
  options: GlobalOptions,
): Promise<unknown> {
  const file = await readFileInfo(inputPath);
  if (file.kind !== "pdf") {
    rejectPdfOnlyOptions(file, options, ["pages", "password"]);
  }
  let pdfPages: PdfSearchPage[] | null = null;
  let plainPages: Array<{ page: number; text: string }> = [];
  if (file.kind === "pdf") {
    pdfPages = await withPdf(file, options, async ({ reader }) => {
      try {
        return await pdfSearchPages(reader, options.pages);
      } catch (error) {
        if (error instanceof AnchorTextUnavailableError) {
          throw new CliError("ERR_TEXT_UNAVAILABLE", error.message);
        }
        throw error;
      }
    });
  } else {
    const text = await readTextDocument(file);
    if (text.length > MAX_EXTRACTED_TEXT_CHARACTERS) {
      throw new CliError(
        "ERR_TEXT_UNAVAILABLE",
        `Search text exceeds the ${MAX_EXTRACTED_TEXT_CHARACTERS}-character safety limit`,
      );
    }
    plainPages = [{ page: 1, text }];
  }
  const limit =
    options.limit ??
    (options.agent ? DEFAULT_AGENT_SEARCH_LIMIT : DEFAULT_SEARCH_LIMIT);
  const matches: CliSearchMatch[] = [];
  let matchCount = 0;
  let matchCountExact = true;
  const geometryBudget = {
    work: MAX_SEARCH_GEOMETRY_WORK,
    outputRects: MAX_SEARCH_OUTPUT_RECTS,
  };
  try {
    const compiledQuery = compileSearchQuery(query);
    if (pdfPages !== null) {
      pdfPageLoop: for (const page of pdfPages) {
        const pageId = `page-${page.page}`;
        let pageOccurrence = 0;
        for (const range of iterateAnchorSearchRanges(page.text, compiledQuery)) {
          if (matchCount >= MAX_SEARCH_MATCH_COUNT) {
            matchCountExact = false;
            break pdfPageLoop;
          }
          matchCount += 1;
          pageOccurrence += 1;
          if (matches.length >= limit) continue;
          matches.push({
            pageId,
            pageNumber: page.page,
            ...range,
            snippet: makeSearchSnippet(
              page.text.index.text,
              range.index,
              range.end,
            ),
            page: page.page,
            pageOccurrence,
            globalOccurrence: matchCount,
            anchor: {
              quote: query,
              page: page.page,
              occurrence: pageOccurrence,
            },
            ...pdfSearchPlacement(page.text, range, geometryBudget),
          });
        }
      }
    } else {
      plainPageLoop: for (const page of plainPages) {
        const pageId = `page-${page.page}`;
        const index = buildSearchTextIndex(page.text);
        for (const range of iterateSearchRanges(index, compiledQuery)) {
          if (matchCount >= MAX_SEARCH_MATCH_COUNT) {
            matchCountExact = false;
            break plainPageLoop;
          }
          matchCount += 1;
          if (matches.length >= limit) continue;
          matches.push({
            pageId,
            pageNumber: page.page,
            ...range,
            snippet: makeSearchSnippet(page.text, range.index, range.end),
          });
        }
      }
    }
  } catch (error) {
    if (error instanceof SearchTextLimitError) {
      throw new CliError(
        "ERR_TEXT_UNAVAILABLE",
        "Search text normalization exceeds Shiori's safety limits",
        error.message,
      );
    }
    throw error;
  }
  const payload = {
    kind: "document.search",
    version: SCHEMA_VERSION,
    file,
    query,
    matchCount,
    matchCountExact,
    returnedMatchCount: matches.length,
    truncated: !matchCountExact || matches.length < matchCount,
    limit,
    matches,
    ...(pdfPages
      ? {
          coordinateSpace: {
            name: "pdf-user-space",
            unit: "pt",
            origin: "bottom-left",
            rects:
              "resolved matched-text glyph bands in reading order; per-character slicing inside a combined PDF text run is estimated",
            rect: "union bounds for reference; choose the final free-text rectangle explicitly",
            recommendedUse:
              "markup anchor geometry; free-text placement reference only",
          },
        }
      : {}),
  };
  if (options.format === "human") {
    if (matches.length === 0) {
      console.log("No matches.");
      return payload;
    }
    for (const match of matches) {
      const coordinate = match.rect
        ? ` ${formatCompactRect(match.rect)}`
        : match.geometryUnavailable
          ? " coordinates-unavailable"
          : "";
      console.log(
        sanitizeTerminalText(
          `[p.${match.pageNumber}${coordinate}] ${match.snippet.before}[${match.snippet.match}]${match.snippet.after}`,
        ),
      );
    }
    // The truncation notice --agent already returns. Without it the human
    // output simply stopped at the limit, so the last line printed read as
    // the last match in the document. `extract` and `inspect` both say so.
    if (payload.truncated) {
      const remaining = matchCount - matches.length;
      const count = matchCountExact
        ? `${remaining} more ${remaining === 1 ? "match" : "matches"}`
        : `more matches`;
      console.log(`... ${count} (raise --limit or narrow --pages)`);
    }
  }
  return payload;
}

type SearchGeometryBudget = { work: number; outputRects: number };

class SearchGeometryBudgetError extends Error {
  constructor() {
    super("search geometry budget exhausted");
    this.name = "SearchGeometryBudgetError";
  }
}

export function pdfSearchPlacement(
  page: AnchorPageText,
  range: { index: number; end: number },
  budget: SearchGeometryBudget,
): Pick<PdfSearchPlacement, "rects" | "rect" | "geometryUnavailable"> {
  try {
    const geometry = charRangeToPageRects(
      { start: range.index, end: range.end },
      page.index,
      page.units,
      page.runs,
      page.visibleRuns,
      {
        maxRects: MAX_RECTS_PER_ANNOTATION,
        consumeWork: (amount) => {
          if (
            !Number.isSafeInteger(amount) ||
            amount < 0 ||
            amount > budget.work
          ) {
            throw new SearchGeometryBudgetError();
          }
          budget.work -= amount;
        },
      },
    );
    if (geometry.unresolvedUnits > 0 || geometry.rects.length === 0) {
      return {
        geometryUnavailable:
          "matched text has no complete horizontal glyph geometry; use render for this page",
      };
    }
    if (geometry.rects.length > budget.outputRects) {
      return {
        geometryUnavailable:
          "search geometry output limit reached; narrow --pages or --limit",
      };
    }
    budget.outputRects -= geometry.rects.length;
    return {
      rects: geometry.rects,
      rect: unionPdfRects(geometry.rects),
    };
  } catch (error) {
    if (
      error instanceof SearchGeometryBudgetError ||
      error instanceof AnchorGeometryLimitError
    ) {
      return {
        geometryUnavailable:
          "search geometry safety limit reached; use a shorter query or narrower --pages/--limit",
      };
    }
    throw error;
  }
}

function unionPdfRects(rects: PdfRect[]): PdfRect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const top = Math.max(...rects.map((rect) => rect.y + rect.h));
  return {
    x: roundPdfPoint(x),
    y: roundPdfPoint(y),
    w: roundPdfPoint(right - x),
    h: roundPdfPoint(top - y),
  };
}

function roundPdfPoint(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function formatCompactRect(rect: PdfRect): string {
  return `x=${rect.x} y=${rect.y} w=${rect.w} h=${rect.h}`;
}

type AnnotationPlacementPreview = {
  index: number;
  type: string;
  page: number;
  rects?: PdfRect[];
  rect?: PdfRect;
  at?: { x: number; y: number };
};

function annotationPlacementPreviews(spec: unknown): AnnotationPlacementPreview[] {
  if (
    typeof spec !== "object" ||
    spec === null ||
    !Array.isArray((spec as { annotations?: unknown }).annotations)
  ) {
    return [];
  }
  return (spec as { annotations: unknown[] }).annotations.flatMap(
    (annotation, index) => {
      if (typeof annotation !== "object" || annotation === null) return [];
      const value = annotation as Record<string, unknown>;
      if (typeof value.type !== "string" || typeof value.page !== "number") {
        return [];
      }
      return [
        {
          index,
          type: value.type,
          page: value.page,
          ...(Array.isArray(value.rects)
            ? { rects: value.rects as PdfRect[] }
            : {}),
          ...(value.rect !== undefined ? { rect: value.rect as PdfRect } : {}),
          ...(value.at !== undefined
            ? { at: value.at as { x: number; y: number } }
            : {}),
        },
      ];
    },
  );
}

function printHumanPlacementPreviews(
  placements: AnnotationPlacementPreview[],
): void {
  for (const placement of placements.slice(0, HUMAN_ANCHOR_PREVIEW_LIMIT)) {
    let geometry = "";
    if (placement.rects) {
      const shown = placement.rects
        .slice(0, HUMAN_ANCHOR_RECT_LIMIT)
        .map(formatCompactRect)
        .join("; ");
      const hidden = placement.rects.length - HUMAN_ANCHOR_RECT_LIMIT;
      geometry = ` rects=[${shown}${hidden > 0 ? `; +${hidden} more` : ""}]`;
    } else if (placement.rect) {
      geometry = ` rect={${formatCompactRect(placement.rect)}}`;
    } else if (placement.at) {
      geometry = ` at={x=${placement.at.x} y=${placement.at.y}}`;
    }
    console.log(
      sanitizeTerminalText(
        `  #${placement.index + 1} ${placement.type} p.${placement.page}${geometry}`,
      ),
    );
  }
  if (placements.length > HUMAN_ANCHOR_PREVIEW_LIMIT) {
    console.log(
      `  ... ${placements.length - HUMAN_ANCHOR_PREVIEW_LIMIT} more placements omitted`,
    );
  }
}

async function annotatePdf(
  inputPath: string,
  specPath: string | undefined,
  outputPath: string,
  options: GlobalOptions,
): Promise<unknown> {
  const file = await readFileInfo(inputPath);
  if (file.kind !== "pdf") {
    throw new CliError(
      "ERR_UNSUPPORTED_DOCUMENT",
      "annotate only supports PDF input",
      file.name,
    );
  }
  let spec: { value: unknown; bytes: Uint8Array };
  if (specPath == null) {
    spec = synthesizedHighlightSpec(options.highlights);
  } else {
    await assertAuxiliaryFileWithinLimit(
      specPath,
      MAX_ANNOTATION_SPEC_BYTES,
      "Annotation spec",
    );
    spec = await readSpecFile(specPath);
  }
  const anchoredIndexes = anchoredAnnotationIndexes(spec.value);
  let specValue = spec.value;
  let sourceBytes: Uint8Array | undefined;
  let resolvedAnchors: ReadonlyMap<number, OverlayTextAnchor> | undefined;
  if (anchoredIndexes.length > 0) {
    sourceBytes = await readAnnotateSourcePdf(
      { path: file.path, sizeBytes: file.sizeBytes },
      createAnnotateError,
    );
    const resolved = await resolveSpecAnchorsWithPdf(
      sourceBytes,
      specValue,
      options,
    );
    specValue = resolved.spec;
    resolvedAnchors = resolved.anchors;
  }
  const payload = await annotateDocument(
    { path: file.path, sizeBytes: file.sizeBytes },
    {
      specPath,
      outputPath,
      force: options.force,
      inPlace: options.inPlace,
      dryRun: options.dryRun,
      baseSha256: options.baseSha256,
      preloadedSourceBytes: sourceBytes,
      preloadedSpec: { value: specValue, bytes: spec.bytes },
      resolvedAnchors,
    },
    createAnnotateError,
  );
  const finalPayload =
    options.dryRun && "dryRun" in payload
      ? {
          ...payload,
          placements: annotationPlacementPreviews(specValue),
          ...(anchoredIndexes.length > 0
            ? {
                anchors: anchoredIndexes.map((index) => {
                  const annotation = (
                    specValue as { annotations: unknown[] }
                  ).annotations[index] as Record<string, unknown>;
                  return {
                    index,
                    page: annotation.page,
                    ...(annotation.rects !== undefined
                      ? { rects: annotation.rects }
                      : {}),
                    ...(annotation.rect !== undefined
                      ? { rect: annotation.rect }
                      : {}),
                    ...(annotation.at !== undefined ? { at: annotation.at } : {}),
                    ...(annotation.quote !== undefined
                      ? { quote: annotation.quote }
                      : {}),
                  };
                }),
              }
            : {}),
        }
      : payload;
  if (options.format === "human") {
    if ("dryRun" in payload) {
      console.log(
        `Dry run: ${payload.patch.ops} annotations would be written to ${payload.output.path}`,
      );
      printHumanPlacementPreviews(
        (finalPayload as { placements?: AnnotationPlacementPreview[] })
          .placements ?? [],
      );
    } else {
      console.log(`${payload.written} annotations written to ${payload.output}`);
      if (payload.lostChars > 0) {
        console.warn(
          `Warning: ${payload.lostChars} annotation characters are not covered by the bundled portable PDF fonts; semantic text was preserved, but static appearance glyphs were substituted.`,
        );
      }
    }
  }
  return finalPayload;
}

// Anchored specs need page text; read it and resolve before the
// pdf-lib annotate pipeline sees the spec. Alongside the resolved spec it
// returns the per-annotation anchor provenance (index-aligned), which the
// annotate pipeline attaches to the built overlays after parsing.
async function resolveSpecAnchorsWithPdf(
  sourceBytes: Uint8Array,
  specValue: unknown,
  options: GlobalOptions,
): Promise<{
  spec: unknown;
  anchors: ReadonlyMap<number, OverlayTextAnchor>;
}> {
  const violation = Array.isArray(
    (specValue as { annotations?: unknown }).annotations,
  )
    ? annotationSpecViolation(
        (specValue as { annotations: unknown[] }).annotations,
      )
    : "Spec JSON must include an annotations array";
  if (violation) throw new CliError("ERR_SPEC_INVALID", violation);
  return withPdfBytes(sourceBytes, options, async ({ reader }) => {
    try {
      const anchors = new Map<number, OverlayTextAnchor>();
      const spec = await resolveAnnotationSpecAnchors(
        specValue,
        reader.pageCount,
        async (pageNumber) =>
          buildAnchorPageText(
            pageNumber,
            await reader.pageText(pageNumber),
            await reader.pageModel(pageNumber),
          ),
        {
          onAnchorResolved: (index, anchor) => {
            anchors.set(index, anchor);
          },
        },
      );
      return { spec, anchors };
    } catch (error) {
      // Convert inside withPdf: its catch-all would misclassify resolution
      // failures as PDF open errors.
      if (error instanceof AnchorTextUnavailableError) {
        throw new CliError("ERR_TEXT_UNAVAILABLE", error.message);
      }
      if (error instanceof AnchorResolutionError) {
        throw new CliError("ERR_ANCHOR_UNRESOLVED", error.message);
      }
      throw error;
    }
  });
}

/**
 * --highlight quotes become an UNVERSIONED anchored spec: with a schema
 * field present, color/opacity would be required. Construction has fixed
 * key order, so the bytes (and the live operation id derived from them)
 * are deterministic for identical flag sets.
 */
function synthesizedHighlightSpec(highlights: string[]): {
  value: Record<string, unknown>;
  bytes: Uint8Array;
} {
  const value = {
    annotations: highlights.map((quote) => ({
      type: "highlight",
      anchor: { quote },
    })),
  };
  return { value, bytes: new TextEncoder().encode(JSON.stringify(value)) };
}

function anchoredAnnotationIndexes(specValue: unknown): number[] {
  if (
    typeof specValue !== "object" ||
    specValue === null ||
    !Array.isArray((specValue as { annotations?: unknown }).annotations)
  ) {
    return [];
  }
  const indexes: number[] = [];
  (specValue as { annotations: unknown[] }).annotations.forEach(
    (annotation, index) => {
      if (
        typeof annotation === "object" &&
        annotation !== null &&
        (annotation as Record<string, unknown>).anchor != null
      ) {
        indexes.push(index);
      }
    },
  );
  return indexes;
}

async function readSpecFile(
  specPath: string,
): Promise<{ value: unknown; bytes: Uint8Array }> {
  const path = resolve(specPath);
  let bytes: Buffer;
  try {
    bytes = await readFileWithinLimit(path, MAX_ANNOTATION_SPEC_BYTES);
  } catch (err) {
    if (err instanceof BoundedFileError && err.reason === "not-a-file") {
      throw new CliError("ERR_FILE_UNAVAILABLE", "Path is not a file", path);
    }
    if (err instanceof BoundedFileError && err.reason === "too-large") {
      throw new CliError(
        "ERR_FILE_TOO_LARGE",
        `Annotation spec exceeds the ${formatBytes(
          MAX_ANNOTATION_SPEC_BYTES,
        )} input limit`,
        `${path}: ${err.sizeBytes ?? 0} bytes`,
      );
    }
    throw new CliError("ERR_FILE_UNAVAILABLE", "Could not read file", path);
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes: new Uint8Array(bytes) };
  } catch (err) {
    throw new CliError(
      "ERR_SPEC_INVALID",
      "Spec JSON is malformed",
      err instanceof Error ? err.message : undefined,
    );
  }
}

const DEFAULT_RENDER_SCALE = 2;

async function renderPdfPage(
  inputPath: string,
  pageNumber: number,
  outputPath: string,
  options: GlobalOptions,
): Promise<unknown> {
  const file = await readFileInfo(inputPath);
  if (file.kind !== "pdf") {
    throw new CliError(
      "ERR_UNSUPPORTED_DOCUMENT",
      "render only supports PDF input",
      file.name,
    );
  }
  const output = resolve(outputPath);
  try {
    await assertRenderOutputIsDistinct(file.path, output);
  } catch (error) {
    if (error instanceof RenderOutputConflictError) {
      throw new CliError("ERR_OUTPUT_CONFLICT", error.message, output);
    }
    throw new CliError(
      "ERR_WRITE_FAILED",
      "Could not inspect render output path",
      error instanceof Error ? `${output}: ${error.message}` : output,
    );
  }
  if (await pathExists(output)) {
    if (options.force) {
      throw new CliError(
        "ERR_NATIVE_ATOMIC_REPLACE_REQUIRED",
        "This CLI build cannot safely replace an existing output",
        `${output}: choose a new output path`,
      );
    }
    throw new CliError(
      "ERR_OUTPUT_EXISTS",
      "Output already exists; choose a new output path",
      output,
    );
  }
  const requestedScale = options.scale ?? DEFAULT_RENDER_SCALE;
  const rendered = await withPdf(file, options, async (pdf) => {
    if (pageNumber > pdf.reader.pageCount) {
      throw new CliError(
        "ERR_USAGE",
        `--page is ${pageNumber} but the document has ${pdf.reader.pageCount} pages`,
      );
    }
    return renderCorePageToPng(pdf.core, pageNumber, requestedScale);
  });
  try {
    await atomicWriteNewFile(file.path, output, rendered.png);
  } catch (err) {
    if (err instanceof RenderOutputConflictError) {
      throw new CliError("ERR_OUTPUT_CONFLICT", err.message, output);
    }
    if (err instanceof RenderOutputExistsError) {
      throw new CliError(
        "ERR_OUTPUT_EXISTS",
        "Output appeared while rendering; choose a new output path",
        output,
      );
    }
    if (err instanceof AtomicOutputPublishedOutcomeUnknownError) {
      throw new CliError(
        "ERR_OUTPUT_OUTCOME_UNKNOWN",
        "Output may already exist; inspect it before retrying",
        err.outputPath,
      );
    }
    throw new CliError(
      "ERR_WRITE_FAILED",
      "Could not write output file",
      err instanceof Error ? `${output}: ${err.message}` : output,
    );
  }
  const payload = {
    kind: "pdf.render",
    version: SCHEMA_VERSION,
    file,
    page: pageNumber,
    output,
    format: "png",
    requestedScale,
    scale: rendered.scale,
    widthPx: rendered.widthPx,
    heightPx: rendered.heightPx,
  };
  if (options.format === "human") {
    console.log(
      `Rendered page ${pageNumber} to ${output} (${rendered.widthPx}x${rendered.heightPx} px${
        rendered.scale !== requestedScale
          ? `, scale clamped to ${formatNumber(rendered.scale)}`
          : ""
      })`,
    );
  }
  return payload;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new CliError(
      "ERR_WRITE_FAILED",
      "Could not inspect output path",
      error instanceof Error ? `${path}: ${error.message}` : path,
    );
  }
}

async function liveAppContext(options: GlobalOptions): Promise<unknown> {
  const details = await withLiveAppError(() => getLiveAppContextDetails());
  const context = details.context;
  if (options.format === "human") {
    const page = context.activePage
      ? ` · page ${context.activePage.page}/${context.pageCount}`
      : "";
    const dirty = context.dirty ? " · unsaved changes" : "";
    console.log(
      sanitizeTerminalText(
        `${context.name}${page} · ${context.annotationCount} annotations${dirty}`,
      ),
    );
    console.log(sanitizeTerminalText(`Document: ${context.documentId}`));
    console.log(`SHA-256: ${context.sha256}`);
    console.log(`Page topology: ${context.pageTopologyHash}`);
    if (details.appVersion) {
      console.log(sanitizeTerminalText(`Shiori: ${details.appVersion}`));
    }
    printAnnotationDigest(context);
  }
  return {
    ...context,
    ...(details.appVersion ? { appVersion: details.appVersion } : {}),
  };
}

/**
 * The annotations an agent can actually reason about, with their IDs. The ID
 * is the operative part: it is what a `calloutReply` spec targets, so reading
 * and replying become one continuous move instead of a guess.
 */
function printAnnotationDigest(context: LiveAppContext): void {
  const annotations = context.annotations ?? [];
  if (annotations.length === 0) return;
  console.log("");
  console.log(
    `Annotations with content (${annotations.length} of ${context.annotationCount}${
      context.annotationsTruncated ? ", truncated" : ""
    }):`,
  );
  for (const annotation of annotations) {
    console.log(
      sanitizeTerminalText(
        `  [${annotation.type} p${annotation.page}] ${annotation.id}`,
      ),
    );
    if (annotation.quote) {
      console.log(sanitizeTerminalText(`    quote: ${annotation.quote}`));
    }
    if (annotation.text) {
      console.log(sanitizeTerminalText(`    text: ${annotation.text}`));
    }
    for (const turn of annotation.thread ?? []) {
      const who = turn.role === "agent" ? turn.author ?? "agent" : "you";
      console.log(sanitizeTerminalText(`    ${who}: ${turn.text}`));
    }
  }
}

async function liveAppAnnotate(
  specPath: string | null,
  options: GlobalOptions,
): Promise<unknown> {
  const result = await withLiveAppError(() =>
    annotateLiveApp(specPath, {
      dryRun: options.dryRun,
      baseSha256: options.baseSha256,
      ...(specPath == null
        ? { spec: synthesizedHighlightSpec(options.highlights).value }
        : {}),
    }),
  );
  if (options.format === "human") {
    if (result.data.dryRun) {
      console.log(
        `Dry run: ${result.data.added} annotations ready for ${result.context.name}.`,
      );
    } else {
      console.log(
        `Applied ${result.data.added} annotations to ${result.context.name}.`,
      );
    }
  }
  return result.data;
}

async function withLiveAppError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof LiveAppError) {
      throw new CliError(error.code, error.message, error.detail);
    }
    throw error;
  }
}

async function extractPdfAnnotations(
  inputPath: string,
  options: GlobalOptions,
): Promise<unknown> {
  const file = await readFileInfo(inputPath);
  if (file.kind !== "pdf") {
    throw new CliError(
      "ERR_UNSUPPORTED_DOCUMENT",
      "extract only supports PDF input",
      file.name,
    );
  }
  const payload = await withPdf(file, options, async (pdf, bytes) => {
    const pageNumbers = selectedPageNumbers(options.pages, pdf.reader.pageCount);
    try {
      return await extractAnnotationsFromCore(pdf.core, file.path, pageNumbers, bytes);
    } catch (error) {
      if (error instanceof ExtractError) {
        throw new CliError(error.code, error.summary, error.message);
      }
      throw error;
    }
  });
  if (options.format === "human" && !options.asSpec) {
    for (const annotation of payload.annotations) {
      console.log(sanitizeTerminalText(formatExtractHumanLine(annotation)));
    }
  }
  return payload;
}

async function readFileInfo(inputPath: string): Promise<FileInfo> {
  const path = resolve(inputPath);
  let sizeBytes: number;
  try {
    const meta = await stat(path);
    if (!meta.isFile()) {
      throw new CliError("ERR_FILE_UNAVAILABLE", "Path is not a file", path);
    }
    sizeBytes = meta.size;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError("ERR_FILE_UNAVAILABLE", "Could not read file", path);
  }
  const name = basename(path);
  const kind = detectDocumentKind(name);
  if (!kind) {
    throw new CliError(
      "ERR_UNSUPPORTED_DOCUMENT",
      "Supported files are PDF, Markdown, and HTML",
      name,
    );
  }
  return { path, name, sizeBytes, kind };
}

/** What the PDF commands read from a document shiori-core opened; pages count from 1. */
type PdfReader = {
  pageCount: number;
  /** The document information as pdf.js's documentInfo keys it, strings only. */
  metadata: () => Promise<Record<string, string>>;
  /** The page's model; throws when its box exceeds Shiori's page limit. */
  pageModel: (pageNumber: number) => Promise<PageModel>;
  /** The page's text as the reading layer consumes it. */
  pageText: (pageNumber: number) => Promise<PdfPageTextContent>;
};

type OpenedPdf = { reader: PdfReader; core: CoreDocument };

async function withPdf<T>(
  file: FileInfo,
  options: GlobalOptions,
  run: (pdf: OpenedPdf, sourceBytes: Uint8Array) => Promise<T>,
): Promise<T> {
  try {
    assertPdfWithinFileLimit(file.sizeBytes);
  } catch (err) {
    throw cliErrorForPdfOpenError(err);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFileWithinLimit(file.path, MAX_PDF_BYTES));
  } catch (err) {
    if (err instanceof BoundedFileError && err.reason === "too-large") {
      throw cliErrorForPdfOpenError(
        new PdfOpenError("tooLarge", `PDF is ${err.sizeBytes ?? 0} bytes`),
      );
    }
    throw new CliError("ERR_FILE_UNAVAILABLE", "Could not read file", file.path);
  }

  return withPdfBytes(bytes, options, (pdf) => run(pdf, bytes));
}

/** Opens the PDF once, runs `run` on it and closes it, mapping read failures to CLI errors. */
async function withPdfBytes<T>(
  sourceBytes: Uint8Array,
  options: GlobalOptions,
  run: (pdf: OpenedPdf) => Promise<T>,
): Promise<T> {
  try {
    // The core parses its own copy; the caller's bytes stay intact for the
    // pdf-lib export.
    const core = openCoreDocument(sourceBytes, options.password);
    try {
      const reader = coreReader(core);
      assertPdfWithinPageLimit(reader.pageCount);
      return await run({ reader, core });
    } finally {
      core.close();
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    if (err instanceof SemanticTextLimitError || isCoreTextLimitError(err)) {
      throw new CliError(
        "ERR_TEXT_UNAVAILABLE",
        "PDF text exceeds Shiori's safe indexing limits",
        (err as Error).message,
      );
    }
    throw cliErrorForPdfOpenError(err);
  }
}

/** shiori-core refused a page with more characters than MAX_PAGE_CHARS (CoreError::TooMuchText). */
function isCoreTextLimitError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("page text too large");
}

function coreReader(core: CoreDocument): PdfReader {
  // The catalog's /Lang, read once for every page's text.
  let language: string | null | undefined;
  return {
    pageCount: core.pageCount(),
    metadata: async () => coreMetadataStrings(core.metadata()),
    pageModel: async (pageNumber) => corePageModel(core, pageNumber),
    pageText: async (pageNumber) => {
      language ??= core.metadata().language ?? null;
      return pageTextFromPdfiumGlyphs(core.glyphs(pageNumber - 1), language).content;
    },
  };
}

/** The core's document information under the keys the pdf.js reader printed. */
const CORE_METADATA_KEYS: ReadonlyArray<[keyof CoreMetadata, string]> = [
  ["pdfFormatVersion", "PDFFormatVersion"],
  ["language", "Language"],
  ["encryptFilterName", "EncryptFilterName"],
  ["title", "Title"],
  ["author", "Author"],
  ["subject", "Subject"],
  ["keywords", "Keywords"],
  ["creator", "Creator"],
  ["producer", "Producer"],
  ["creationDate", "CreationDate"],
  ["modDate", "ModDate"],
];

function coreMetadataStrings(metadata: CoreMetadata): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, key] of CORE_METADATA_KEYS) {
    const value = metadata[field];
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  return out;
}

async function pdfPageInfo(
  reader: PdfReader,
  pageSelection?: string,
): Promise<PdfPageInfo[]> {
  const pages: PdfPageInfo[] = [];
  for (const pageNumber of selectedPageNumbers(pageSelection, reader.pageCount)) {
    const model = await reader.pageModel(pageNumber);
    pages.push({
      page: pageNumber,
      widthPt: model.widthPt,
      heightPt: model.heightPt,
      rotation: model.rotation,
    });
  }
  return pages;
}

async function pdfTextPages(
  reader: PdfReader,
  pageSelection?: string,
  maxChars?: number,
): Promise<PdfTextExtraction> {
  const pageNumbers = selectedPageNumbers(pageSelection, reader.pageCount);
  const pages: TextPage[] = [];
  let remaining = maxChars;
  let truncated = false;
  for (let index = 0; index < pageNumbers.length; index += 1) {
    const pageNumber = pageNumbers[index]!;
    if (remaining === 0) {
      truncated = true;
      break;
    }
    const text = semanticTextContentToString(await reader.pageText(pageNumber));
    const limited = limitText(text, remaining);
    pages.push({
      page: pageNumber,
      ...limited,
    });
    if (remaining != null) {
      remaining = Math.max(0, remaining - limited.text.length);
    }
    if (limited.truncated || (remaining === 0 && index < pageNumbers.length - 1)) {
      truncated = true;
    }
  }
  return { pages, truncated };
}

async function pdfSearchPages(
  reader: PdfReader,
  pageSelection?: string,
): Promise<PdfSearchPage[]> {
  const pages: PdfSearchPage[] = [];
  let characters = 0;
  const retentionBudget = createPdfSearchRetentionBudget();
  for (const pageNumber of selectedPageNumbers(pageSelection, reader.pageCount)) {
    const text = buildAnchorPageText(
      pageNumber,
      await reader.pageText(pageNumber),
      await reader.pageModel(pageNumber),
    );
    characters += text.index.text.length;
    if (characters > MAX_EXTRACTED_TEXT_CHARACTERS) {
      throw new CliError(
        "ERR_TEXT_UNAVAILABLE",
        `Search text exceeds the ${MAX_EXTRACTED_TEXT_CHARACTERS}-character safety limit`,
        "Narrow the search with --pages",
      );
    }
    consumePdfSearchRetentionBudget(text, retentionBudget);
    pages.push({ page: pageNumber, text });
  }
  return pages;
}

function createPdfSearchRetentionBudget(): PdfSearchRetentionBudget {
  return {
    units: MAX_ANCHOR_INDEXED_TEXT_UNITS,
    spans: MAX_ANCHOR_INDEXED_TEXT_SPANS,
    mappingExceptions: MAX_ANCHOR_SEARCH_MAPPING_EXCEPTIONS,
    sourceItems: MAX_ANCHOR_SOURCE_ITEMS,
    sourceCharacters: MAX_ANCHOR_SOURCE_CHARACTERS,
    runs: MAX_ANCHOR_RETAINED_RUNS,
  };
}

/**
 * PDF search keeps page geometry until matching finishes. Bound every compact
 * object family across the complete selection, not just text characters, so
 * an adversarial PDF cannot turn the 10M-character allowance into millions of
 * retained TextItem-derived objects before `--limit` is applied.
 */
export function consumePdfSearchRetentionBudget(
  page: AnchorPageText,
  budget: PdfSearchRetentionBudget,
): void {
  const mappingExceptions = [
    page.searchIndex,
    ...page.alternateSearchIndexes,
  ].reduce((total, index) => total + index.mappingExceptions.length, 0);
  const costs: PdfSearchRetentionBudget = {
    units: page.units.length,
    spans: page.index.spans.length,
    mappingExceptions,
    sourceItems: page.sourceItemCount,
    sourceCharacters: page.sourceCharacterCount,
    runs: page.runCount,
  };
  const exceeded = (
    Object.keys(costs) as Array<keyof PdfSearchRetentionBudget>
  ).some((key) => costs[key] > budget[key]);
  if (exceeded) {
    throw new CliError(
      "ERR_TEXT_UNAVAILABLE",
      "Search text index exceeds the safe retained-geometry budget",
      "Narrow the search with --pages",
    );
  }
  for (const key of Object.keys(costs) as Array<keyof PdfSearchRetentionBudget>) {
    budget[key] -= costs[key];
  }
}

type PdfOnlyOption = "pages" | "password" | "pageInfo" | "metadata";

function rejectPdfOnlyOptions(
  file: FileInfo,
  options: GlobalOptions,
  candidates: PdfOnlyOption[],
): void {
  const used = candidates.filter((name) => {
    if (name === "pageInfo" || name === "metadata") return options[name];
    return options[name] != null;
  });
  if (used.length === 0) return;
  const flags = used.map((name) => `--${name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`);
  throw new CliError(
    "ERR_USAGE",
    `${flags.join(", ")} ${used.length === 1 ? "is" : "are"} only valid for PDF input`,
    file.name,
  );
}

async function readTextDocument(file: FileInfo): Promise<string> {
  const maxBytes = file.kind === "html" ? MAX_HTML_BYTES : MAX_MARKDOWN_BYTES;
  if (file.sizeBytes > maxBytes) {
    throw new CliError(
      "ERR_FILE_TOO_LARGE",
      `${file.kind === "html" ? "HTML" : "Markdown"} exceeds the ${formatBytes(
        maxBytes,
      )} input limit`,
      `${file.path}: ${file.sizeBytes} bytes`,
    );
  }
  let raw: string;
  try {
    raw = (await readFileWithinLimit(file.path, maxBytes)).toString("utf8");
  } catch (err) {
    if (err instanceof BoundedFileError && err.reason === "too-large") {
      throw new CliError(
        "ERR_FILE_TOO_LARGE",
        `${file.kind === "html" ? "HTML" : "Markdown"} exceeds the ${formatBytes(
          maxBytes,
        )} input limit`,
        `${file.path}: ${err.sizeBytes ?? 0} bytes`,
      );
    }
    throw new CliError("ERR_FILE_UNAVAILABLE", "Could not read file", file.path);
  }
  if (file.kind === "markdown") return raw;
  if (file.kind === "html") return stripHtmlToText(raw);
  throw new CliError("ERR_TEXT_UNAVAILABLE", "Text extraction is unavailable");
}

function selectedPageNumbers(selection: string | undefined, total: number): number[] {
  // `=== undefined`, not falsy. An empty string means the flag WAS given with
  // an empty value — almost always an unset shell variable, as in
  // `--pages "$RANGE"` — and treating it as "no selection" silently processed
  // the whole document instead of failing with ERR_USAGE. `--pages " "` and
  // `--pages=` already errored, so the behaviour was inconsistent too.
  // parseStrictPageRange rejects blank input, which is where "" now lands.
  if (selection === undefined) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  return parseStrictPageRange(selection, total);
}

function limitText(
  text: string,
  maxChars: number | undefined,
): { text: string; characters: number; truncated: boolean } {
  const characters = text.length;
  if (maxChars == null || characters <= maxChars) {
    return { text, characters, truncated: false };
  }
  return {
    text: text.slice(0, Math.max(0, maxChars)),
    characters,
    truncated: true,
  };
}

function parseStrictPageRange(selection: string, total: number): number[] {
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new CliError("ERR_USAGE", "PDF has no selectable pages");
  }
  if (!selection.trim()) {
    throw new CliError("ERR_USAGE", "--pages requires a non-empty range");
  }

  const selected = new Set<number>();
  const chunks = selection.split(/[,，]/);
  for (const rawChunk of chunks) {
    const chunk = rawChunk.trim();
    if (!chunk) {
      throw invalidPageRange(selection, rawChunk || "empty item");
    }
    const range = chunk.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (range) {
      const start = strictPageNumber(range[1]!, total, selection);
      const end = strictPageNumber(range[2]!, total, selection);
      if (start > end) {
        throw new CliError(
          "ERR_USAGE",
          "--pages range start must not exceed its end",
          chunk,
        );
      }
      for (let page = start; page <= end; page += 1) {
        selected.add(page);
      }
      continue;
    }
    if (/^\d+$/.test(chunk)) {
      selected.add(strictPageNumber(chunk, total, selection));
      continue;
    }
    throw invalidPageRange(selection, chunk);
  }
  return [...selected].sort((a, b) => a - b);
}

function strictPageNumber(raw: string, total: number, selection: string): number {
  const page = Number(raw);
  if (!Number.isSafeInteger(page) || page < 1 || page > total) {
    throw new CliError(
      "ERR_USAGE",
      `--pages values must be between 1 and ${total}`,
      selection,
    );
  }
  return page;
}

function invalidPageRange(selection: string, item: string): CliError {
  return new CliError(
    "ERR_USAGE",
    "--pages must contain only page numbers or inclusive ranges",
    `${selection} (invalid item: ${item})`,
  );
}

type HtmlNode = {
  nodeName: string;
  tagName?: string;
  value?: string;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
};

export function stripHtmlToText(html: string): string {
  const document = parseHtml(html, {
    treeAdapter: boundedHtmlTreeAdapter(),
  }) as unknown as HtmlNode;
  const chunks: string[] = [];
  collectVisibleHtmlText(document, chunks);
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

// Explicit stack rather than recursion. The recursive version had no depth
// budget — the only input constraint was MAX_HTML_BYTES — so a machine
// generated file of deeply nested tags (a few hundred KB is enough) blew the
// call stack and surfaced as
// {"code":"ERR_UNKNOWN","message":"Maximum call stack size exceeded"}, two
// orders of magnitude below the documented byte limit. Every other traversal
// in this CLI carries an explicit budget; depth now costs heap, not frames,
// and MAX_HTML_DEPTH turns pathological nesting into a documented failure.
const MAX_HTML_DEPTH = 10_000;

function boundedHtmlTreeAdapter(): TreeAdapter<DefaultTreeAdapterMap> {
  const depths = new WeakMap<DefaultTreeAdapterTypes.Node, number>();

  const attach = (
    parent: DefaultTreeAdapterTypes.ParentNode,
    child: DefaultTreeAdapterTypes.ChildNode,
  ) => {
    const depth = (depths.get(parent) ?? 0) + 1;
    if (depth > MAX_HTML_DEPTH) {
      throw new CliError(
        "ERR_TEXT_UNAVAILABLE",
        `HTML nesting exceeds the ${MAX_HTML_DEPTH} level limit`,
      );
    }
    depths.set(child, depth);
  };

  return {
    ...defaultTreeAdapter,
    createDocument() {
      const document = defaultTreeAdapter.createDocument();
      depths.set(document, 0);
      return document;
    },
    createDocumentFragment() {
      const fragment = defaultTreeAdapter.createDocumentFragment();
      depths.set(fragment, 0);
      return fragment;
    },
    appendChild(parent, child) {
      attach(parent, child);
      defaultTreeAdapter.appendChild(parent, child);
    },
    insertBefore(parent, child, reference) {
      attach(parent, child);
      defaultTreeAdapter.insertBefore(parent, child, reference);
    },
    setTemplateContent(template, content) {
      const depth = (depths.get(template) ?? 0) + 1;
      if (depth > MAX_HTML_DEPTH) {
        throw new CliError(
          "ERR_TEXT_UNAVAILABLE",
          `HTML nesting exceeds the ${MAX_HTML_DEPTH} level limit`,
        );
      }
      depths.set(content, depth);
      defaultTreeAdapter.setTemplateContent(template, content);
    },
  };
}

function collectVisibleHtmlText(root: HtmlNode, chunks: string[]): void {
  const stack: Array<{ node: HtmlNode; depth: number }> = [
    { node: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_HTML_DEPTH) {
      throw new CliError(
        "ERR_TEXT_UNAVAILABLE",
        `HTML nesting exceeds the ${MAX_HTML_DEPTH} level limit`,
      );
    }
    const name = (node.tagName ?? node.nodeName).toLowerCase();
    if (name === "script" || name === "style" || name === "template") continue;
    if (node.nodeName === "#text") {
      if (node.value) chunks.push(node.value);
      continue;
    }
    const children = node.childNodes ?? [];
    // Pushed in reverse so children pop in document order, preserving the
    // reading order the recursive version produced.
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, depth: depth + 1 });
    }
  }
}

async function assertAuxiliaryFileWithinLimit(
  inputPath: string,
  maxBytes: number,
  label: string,
): Promise<void> {
  const path = resolve(inputPath);
  try {
    const meta = await stat(path);
    if (!meta.isFile()) {
      throw new CliError("ERR_FILE_UNAVAILABLE", "Path is not a file", path);
    }
    if (meta.size > maxBytes) {
      throw new CliError(
        "ERR_FILE_TOO_LARGE",
        `${label} exceeds the ${formatBytes(maxBytes)} input limit`,
        `${path}: ${meta.size} bytes`,
      );
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError("ERR_FILE_UNAVAILABLE", "Could not read file", path);
  }
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  return `${bytes} bytes`;
}

function singleLine(value: string): string {
  return value.replace(/[\p{Cc}]+/gu, " ").replace(/\s+/g, " ").trim();
}

type ParsedArgs = {
  command: ParsedCommand | null;
  positionals: string[];
  options: GlobalOptions;
  help: boolean;
  version: boolean;
};

const OPTIONS_BEFORE_COMMAND = new Set([
  "--agent",
  "--json",
  "--help",
  "-h",
  "--version",
  "-V",
]);

const COMMAND_OPTIONS: Record<ParsedCommand, ReadonlySet<string>> = {
  inspect: new Set([
    "--agent",
    "--json",
    "--help",
    "-h",
    "--pages",
    "--password",
    "--page-info",
    "--metadata",
  ]),
  text: new Set([
    "--agent",
    "--json",
    "--help",
    "-h",
    "--pages",
    "--password",
    "--max-chars",
  ]),
  search: new Set([
    "--agent",
    "--json",
    "--help",
    "-h",
    "--pages",
    "--password",
    "--limit",
  ]),
  annotate: new Set([
    "--agent",
    "--json",
    "--help",
    "-h",
    "--password",
    "--spec",
    "--highlight",
    "--output",
    "-o",
    "--force",
    "--in-place",
    "--dry-run",
    "--base-sha256",
    "--base-hash",
  ]),
  extract: new Set([
    "--agent",
    "--json",
    "--help",
    "-h",
    "--pages",
    "--password",
    "--as-spec",
  ]),
  render: new Set([
    "--agent",
    "--json",
    "--help",
    "-h",
    "--page",
    "--scale",
    "--password",
    "--output",
    "-o",
    "--force",
  ]),
  app: new Set([
    "--agent",
    "--json",
    "--help",
    "-h",
    "--spec",
    "--highlight",
    "--dry-run",
    "--base-sha256",
    "--base-hash",
  ]),
  help: new Set(["--agent", "--json", "--help", "-h"]),
  version: new Set(["--agent", "--json"]),
};

// Every option that consumes a value. parseArgs and the error-envelope
// scanner both derive value consumption from this one set; a new value
// option added to COMMAND_OPTIONS but not here fails loudly in parseArgs
// instead of silently desynchronizing the two passes.
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--pages",
  "--page",
  "--scale",
  "--password",
  "--limit",
  "--max-chars",
  "--spec",
  "--highlight",
  "--output",
  "-o",
  "--base-sha256",
  "--base-hash",
]);

// Options that may appear more than once; everything else keeps the strict
// once-only rule.
const REPEATABLE_OPTIONS: ReadonlySet<string> = new Set(["--highlight"]);

function parseArgs(argv: string[]): ParsedArgs {
  const options: GlobalOptions = {
    format: "human",
    agent: false,
    pageInfo: false,
    metadata: false,
    asSpec: false,
    force: false,
    inPlace: false,
    dryRun: false,
    highlights: [],
  };
  const positionals: string[] = [];
  const seenOptions = new Set<string>();
  let command: ParsedCommand | null = null;
  let help = false;
  let version = false;
  let optionsEnded = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
      const { name, inlineValue } = splitOption(arg);
      const allowed = command ? COMMAND_OPTIONS[command] : OPTIONS_BEFORE_COMMAND;
      if (!allowed.has(name)) {
        throw new CliError(
          "ERR_USAGE",
          `Unknown option for ${command ?? "shiori"}: ${name}`,
        );
      }
      const seenName =
        name === "-o"
          ? "--output"
          : name === "-h"
            ? "--help"
            : name === "-V"
              ? "--version"
          : name === "--base-hash"
            ? "--base-sha256"
            : name;
      if (!REPEATABLE_OPTIONS.has(seenName) && seenOptions.has(seenName)) {
        throw new CliError("ERR_USAGE", `Option may only be provided once: ${seenName}`);
      }
      seenOptions.add(seenName);

      if (name === "--help" || name === "-h") {
        rejectInlineOptionValue(name, inlineValue);
        help = true;
        continue;
      }
      if (name === "--version" || name === "-V") {
        rejectInlineOptionValue(name, inlineValue);
        version = true;
        continue;
      }
      if (name === "--json") {
        rejectInlineOptionValue(name, inlineValue);
        options.format = "json";
        continue;
      }
      if (name === "--agent") {
        rejectInlineOptionValue(name, inlineValue);
        options.agent = true;
        options.format = "json";
        continue;
      }
      if (name === "--page-info") {
        rejectInlineOptionValue(name, inlineValue);
        options.pageInfo = true;
        continue;
      }
      if (name === "--metadata") {
        rejectInlineOptionValue(name, inlineValue);
        options.metadata = true;
        continue;
      }
      if (name === "--force") {
        rejectInlineOptionValue(name, inlineValue);
        options.force = true;
        continue;
      }
      if (name === "--in-place") {
        rejectInlineOptionValue(name, inlineValue);
        options.inPlace = true;
        continue;
      }
      if (name === "--dry-run") {
        rejectInlineOptionValue(name, inlineValue);
        options.dryRun = true;
        continue;
      }
      if (name === "--as-spec") {
        rejectInlineOptionValue(name, inlineValue);
        options.asSpec = true;
        continue;
      }

      if (!VALUE_OPTIONS.has(name)) {
        throw new CliError(
          "ERR_USAGE",
          `Unknown option for ${command ?? "shiori"}: ${name}`,
        );
      }
      const consumed = optionValue(argv, i, name, inlineValue);
      i = consumed.index;
      const raw = consumed.value;
      if (name === "--pages") options.pages = raw;
      else if (name === "--password") options.password = raw;
      else if (name === "--spec") options.specPath = raw;
      else if (name === "--highlight") {
        if (options.highlights.length >= MAX_HIGHLIGHT_FLAGS) {
          throw new CliError(
            "ERR_USAGE",
            `--highlight may be used at most ${MAX_HIGHLIGHT_FLAGS} times per invocation`,
          );
        }
        options.highlights.push(raw);
      }
      else if (name === "--output" || name === "-o") options.outputPath = raw;
      else if (name === "--page") options.page = positiveIntegerOption(name, raw);
      else if (name === "--scale") {
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0 || value > 16) {
          throw new CliError(
            "ERR_USAGE",
            "--scale must be a number between 0 (exclusive) and 16",
            raw,
          );
        }
        options.scale = value;
      } else if (name === "--limit") options.limit = positiveIntegerOption(name, raw);
      else if (name === "--max-chars") {
        options.maxChars = positiveIntegerOption(name, raw);
      } else if (name === "--base-sha256" || name === "--base-hash") {
        if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
          throw new CliError(
            "ERR_USAGE",
            `${name} must be a 64-character SHA-256 hash`,
            raw,
          );
        }
        options.baseSha256 = raw.toLowerCase();
      }
      continue;
    }
    if (!command) {
      command = parseCommand(arg);
    } else {
      positionals.push(arg);
    }
  }

  const parsed = { command, positionals, options, help, version };
  validateParsedArgs(parsed);
  return parsed;
}

function parseCommand(value: string): ParsedCommand {
  if (value === "help" || value === "version" || isCommandName(value)) return value;
  throw new CliError("ERR_USAGE", `Unknown command: ${value}`);
}

function splitOption(arg: string): { name: string; inlineValue?: string } {
  if (!arg.startsWith("--")) return { name: arg };
  const equals = arg.indexOf("=");
  if (equals < 0) return { name: arg };
  return { name: arg.slice(0, equals), inlineValue: arg.slice(equals + 1) };
}

function optionValue(
  argv: string[],
  currentIndex: number,
  name: string,
  inlineValue: string | undefined,
): { value: string; index: number } {
  if (inlineValue != null) {
    if (!inlineValue) throw new CliError("ERR_USAGE", `${name} requires a value`);
    return { value: inlineValue, index: currentIndex };
  }
  const value = argv[currentIndex + 1];
  if (value == null || value === "--" || value.startsWith("-")) {
    throw new CliError("ERR_USAGE", `${name} requires a value`);
  }
  return { value, index: currentIndex + 1 };
}

function rejectInlineOptionValue(name: string, value: string | undefined): void {
  if (value != null) {
    throw new CliError("ERR_USAGE", `${name} does not accept a value`, value);
  }
}

function positiveIntegerOption(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CliError("ERR_USAGE", `${name} must be a positive integer`, raw);
  }
  return value;
}

function validateParsedArgs(parsed: ParsedArgs): void {
  const { command, positionals, options, help, version } = parsed;
  if (options.limit != null && options.limit > MAX_SEARCH_LIMIT) {
    throw new CliError(
      "ERR_USAGE",
      `--limit must not exceed ${MAX_SEARCH_LIMIT}`,
      String(options.limit),
    );
  }
  if (
    options.maxChars != null &&
    options.maxChars > MAX_EXTRACTED_TEXT_CHARACTERS
  ) {
    throw new CliError(
      "ERR_USAGE",
      `--max-chars must not exceed ${MAX_EXTRACTED_TEXT_CHARACTERS}`,
      String(options.maxChars),
    );
  }
  if (version && command && command !== "version") {
    throw new CliError("ERR_USAGE", "--version cannot be combined with a command");
  }
  if (version && help) {
    throw new CliError("ERR_USAGE", "--version cannot be combined with --help");
  }
  if (!command) return;
  if (command === "help") {
    if (positionals.length > 1) {
      throw extraPositionals(command, positionals.slice(1));
    }
    const topic = positionals[0];
    if (topic && !isCommandName(topic) && topic !== "spec") {
      throw new CliError("ERR_USAGE", `Unknown help topic: ${topic}`);
    }
    return;
  }
  if (command === "version") {
    if (positionals.length > 0) throw extraPositionals(command, positionals);
    return;
  }
  if (options.highlights.length > 0 && options.specPath != null) {
    throw new CliError(
      "ERR_USAGE",
      "--highlight and --spec are mutually exclusive",
    );
  }
  if (command === "app") {
    const subcommand = positionals[0];
    if (!subcommand) {
      if (help) return;
      throw new CliError(
        "ERR_USAGE",
        "app requires a subcommand: context or annotate",
      );
    }
    if (subcommand !== "context" && subcommand !== "annotate") {
      throw new CliError(
        "ERR_USAGE",
        `Unknown app subcommand: ${subcommand}`,
      );
    }
    if (positionals.length > 1) {
      throw extraPositionals(command, positionals.slice(1));
    }
    if (subcommand === "context") {
      const invalidOption = options.specPath
        ? "--spec"
        : options.highlights.length > 0
          ? "--highlight"
          : options.dryRun
            ? "--dry-run"
            : options.baseSha256
              ? "--base-sha256"
              : null;
      if (invalidOption) {
        throw new CliError(
          "ERR_USAGE",
          `Unknown option for app context: ${invalidOption}`,
        );
      }
    } else if (!help && !options.specPath && options.highlights.length === 0) {
      throw new CliError(
        "ERR_USAGE",
        "app annotate requires --spec <spec.json> or --highlight <quote>",
      );
    }
    return;
  }
  if (command === "annotate" && options.password != null) {
    throw new CliError(
      "ERR_USAGE",
      "annotate cannot use --password because encrypted PDFs are read-only",
    );
  }
  const expected = command === "search" ? 2 : 1;
  if (positionals.length > expected) {
    throw extraPositionals(command, positionals.slice(expected));
  }
  if (!help && positionals.length < expected) {
    const usage = command === "search" ? "<file> <query>" : "<file>";
    throw new CliError("ERR_USAGE", `${command} requires ${usage}`);
  }
}

function extraPositionals(command: ParsedCommand, extras: string[]): CliError {
  return new CliError(
    "ERR_USAGE",
    `Unexpected positional argument${extras.length === 1 ? "" : "s"} for ${command}`,
    extras.join(" "),
  );
}

function requireArg(value: string | undefined, message: string): string {
  if (!value) throw new CliError("ERR_USAGE", message);
  return value;
}

type HelpTarget = CommandName | "spec" | null;

function helpTargetFor(parsed: {
  command: string | null;
  positionals: string[];
}): HelpTarget {
  if (parsed.command === "help") {
    const topic = parsed.positionals[0];
    if (topic === "spec") return "spec";
    return isCommandName(topic) ? topic : null;
  }
  return isCommandName(parsed.command) ? parsed.command : null;
}

function isCommandName(value: string | null | undefined): value is CommandName {
  return (
    value === "inspect" ||
    value === "text" ||
    value === "search" ||
    value === "annotate" ||
    value === "extract" ||
    value === "render" ||
    value === "app"
  );
}

function commandNameForOutput(
  command: ParsedCommand,
  positionals: string[],
): string {
  if (command === "app") {
    const subcommand = positionals[0];
    if (subcommand === "context" || subcommand === "annotate") {
      return `app.${subcommand}`;
    }
  }
  return command;
}

function writeVersion(options: GlobalOptions): void {
  if (options.format === "json") {
    writeJson(
      {
        schema: "shiori.cli/version/v1",
        name: "shiori",
        version: CLI_VERSION,
        cliSchemaVersion: SCHEMA_VERSION,
      },
      options,
    );
    return;
  }
  console.log(`shiori ${CLI_VERSION}`);
}

function writeHelp(target: HelpTarget, options: GlobalOptions): void {
  if (target === "spec") {
    if (options.format === "json") writeJson(specHelpPayload(), options);
    else console.log(specHelpText());
    return;
  }
  if (options.format === "json") {
    writeJson(helpPayload(target), options);
    return;
  }
  console.log(target ? commandHelpText(target) : generalHelpText());
}

function generalHelpText(): string {
  return `Shiori CLI ${CLI_VERSION}

Usage:
  shiori [--agent | --json] <command> [options]
  shiori help [command] [--agent | --json]
  shiori --version [--agent | --json]

Commands:
  inspect   Identify kind, size, page count, metadata.
  text      Extract text from PDF pages, Markdown, or static HTML.
  search    Return page-aware matches with reusable PDF text geometry.
  annotate  Highlight quoted text (--highlight) or apply an annotation spec.
  extract   Read annotations or emit a spec that annotate accepts directly.
  render    Rasterize one PDF page to PNG (for pages without a text layer).
  app       Inspect or annotate the PDF currently open in Shiori.

Global options (may precede the command):
  --agent       Compact JSON to stdout. Failures also return one JSON envelope.
  --json        Pretty JSON to stdout. Failures also return one JSON envelope.
  -h, --help    Show general or command help.
  -V, --version Show the CLI version.
  --            Stop option parsing; use before paths/queries beginning with '-'.

Rules:
  Options are command-specific; unknown options and extra arguments are errors.
  PDF page ranges are strict and 1-based (for example 1,3-5).
  --max-chars limits total extracted text (default/max ${MAX_EXTRACTED_TEXT_CHARACTERS} characters).
  JSON failures use stdout; a short diagnostic is also written to stderr.
  Markdown/HTML input is decoded as UTF-8.
  Exit codes: 0 success, 2 usage errors, 1 other failures.
  version --json returns a bare shiori.cli/version/v1 object, not the
  shiori.cli/v1 envelope.

Help:
  shiori help inspect
  shiori help text
  shiori help search
  shiori help annotate
  shiori help extract
  shiori help render
  shiori help app
  shiori help spec   (annotation spec schema: anchors first, full field list)
  shiori --help --agent`;
}

function commandHelpText(command: CommandName): string {
  if (command === "inspect") {
    return `Usage:
  shiori inspect <file> [--pages 1,3-5] [--page-info] [--metadata] [--password value] [--agent | --json]

Output:
  kind, file size, and PDF page count. Metadata requires --metadata.
  JSON page boxes require --page-info or --pages; human output includes them.

Token tip:
  Prefer plain inspect first. Add --metadata/--pages only when needed.`;
  }
  if (command === "text") {
    return `Usage:
  shiori text <file> [--pages 1,3-5] [--max-chars n] [--password value] [--agent | --json]

Output:
  PDF: pages[{page,text,characters,truncated}]. Markdown/HTML: text plus truncation.

Token tip:
  --max-chars is one total text budget across selected PDF pages; extraction stops
  when it is exhausted. Default/max: ${MAX_EXTRACTED_TEXT_CHARACTERS} characters.
  JSON framing and human page headings are not counted.`;
  }
  if (command === "search") {
    return `Usage:
  shiori search <file> <query> [--pages 1,3-5] [--limit n] [--password value] [--agent | --json]

Output:
  PDF matches include page, pageOccurrence, anchor, resolved glyph-band rects,
  and their union rect in PDF user space (points, bottom-left origin). A combined
  PDF text run only permits estimated per-character slicing. This geometry suits
  markup anchors; the union is NOT an automatic free-text placement. Choose or
  adjust a text annotation's final rect explicitly. Human output prints it compactly.
  Visual line wraps, line-wrap hyphenation, CJK compatibility forms, and copied
  whitespace are searchable; matches never cross a detected paragraph/column gap.

Token tip:
  --agent defaults to --limit ${DEFAULT_AGENT_SEARCH_LIMIT}; human/JSON defaults to
  ${DEFAULT_SEARCH_LIMIT}; the maximum is ${MAX_SEARCH_LIMIT}. Tighten --pages when possible.`;
  }
  if (command === "annotate") {
    return `Usage:
  shiori annotate <input.pdf> --highlight "quoted text" -o <output.pdf>
  shiori annotate <input.pdf> --spec <spec.json> -o <new-output.pdf> [--agent | --json] [--dry-run] [--base-sha256 hash]

Output:
  --highlight "quoted text" (repeatable) marks the quoted sentence with no
  spec file and no coordinates; Shiori finds the text and computes geometry.
  For other types and batches, --spec takes a shiori.annotations/v1 file —
  anchors ({ "anchor": { "quote": ... } }) are preferred there too; see
  \`shiori help spec\` for the full schema. Supported round-trippable types:
  highlight, underline, strikethrough, note, callout, ink, rect, stamp, and text.
  Free text is not a note and does not auto-anchor over source text: run
  \`shiori search ... --agent\`, then choose an explicit text rect from/around
  the returned PDF-space geometry.
  The portable CLI never replaces an existing file. Legacy --force/--in-place
  requests fail with ERR_NATIVE_ATOMIC_REPLACE_REQUIRED; choose a new -o path.
  Encrypted PDFs are read-only; --password is not accepted by annotate.

Token tip:
  Anchor by quote instead of computing coordinates; use --dry-run to see
  resolved page/geometry before writing. Free text must keep an explicit rect.`;
  }
  if (command === "app") {
    return `Usage:
  shiori app context [--agent | --json]
  shiori app annotate --highlight "quoted text" [--dry-run]
  shiori app annotate --spec <spec.json> [--dry-run] [--base-sha256 hash] [--agent | --json]

Output:
  context reads the active PDF, page, annotation count, document ID, and SHA-256,
  plus every annotation that carries text: its id, type, page, body, anchored
  quote and callout thread. Read it before replying to a follow-up — the id it
  prints is what a calloutReply targets.
  annotate applies annotations to that in-memory document; it does not write
  a PDF file on disk. --highlight "quoted text" (repeatable) needs no spec
  file and no coordinates; --spec accepts anchored or coordinate specs (see
  \`shiori help spec\`). --base-sha256 fails if the target changed.
  Same target topology + spec reuses a stable operation ID for safe retries.

Connection:
  Shiori must be running. The CLI connects only to its authenticated 127.0.0.1
  live API. Set SHIORI_LIVE_API_DESCRIPTOR to an absolute descriptor path only
  for testing; the descriptor must be owned by the invoking user.`;
  }
  if (command === "render") {
    return `Usage:
  shiori render <file.pdf> --page <n> -o <new-output.png> [--scale s] [--password value] [--agent | --json]

Output:
  One page as PNG at --scale (default ${DEFAULT_RENDER_SCALE}; clamped to the canvas pixel
  budget). -o is required and must be new; existing files are never replaced.

Token tip:
  Use render only when text/search cannot help (scanned pages, figures).`;
  }
  return `Usage:
  shiori extract <file.pdf> [--pages 1,3-5] [--password value] [--as-spec] [--agent | --json]

Output:
  Reads PDF annotations as structured data. --as-spec writes pure
  shiori.annotations/v1 JSON that can be redirected directly to annotate.

Token tip:
  Use --pages when only part of a document matters.`;
}

function helpPayload(target: CommandName | null): unknown {
  const commands = {
    inspect: {
      usage:
        "shiori inspect <file> [--pages 1,3-5] [--page-info] [--metadata] [--agent|--json]",
      does: "kind,size,pageCount; metadata and page boxes only when requested",
      tokenTip: "omit --metadata/--page-info unless needed",
    },
    text: {
      usage: "shiori text <file> [--pages 1,3-5] [--max-chars n] [--agent|--json]",
      does: "extracts text from PDF pages, Markdown, or static HTML",
      tokenTip: `--max-chars defaults to and cannot exceed ${MAX_EXTRACTED_TEXT_CHARACTERS} characters`,
    },
    search: {
      usage: "shiori search <file> <query> [--pages 1,3-5] [--limit n] [--agent|--json]",
      does:
        "returns page-aware matches; PDF results add resolved glyph-band rects (estimated within combined text runs), union bounds, and a reusable markup/note anchor in bottom-left PDF points",
      tokenTip: `agent default limit is ${DEFAULT_AGENT_SEARCH_LIMIT}; human/JSON default ${DEFAULT_SEARCH_LIMIT}; max ${MAX_SEARCH_LIMIT}`,
    },
    annotate: {
      usage:
        "shiori annotate <input.pdf> --highlight \"quoted text\" -o <new-output.pdf> | --spec <spec.json> [--dry-run] [--base-sha256 hash]",
      does: "marks quoted text (anchors compute all geometry) or applies a spec; see `shiori help spec`",
      tokenTip:
        "anchor by quote; --dry-run previews placement; output must be a new path",
    },
    extract: {
      usage:
        "shiori extract <file.pdf> [--pages 1,3-5] [--as-spec] [--agent|--json]",
      does: "reads PDF annotations; --as-spec emits pure annotate input",
      tokenTip: "use --pages to reduce output; quote is informational and rects anchor markup",
    },
    render: {
      usage:
        "shiori render <file.pdf> --page <n> -o <new-output.png> [--scale s] [--agent|--json]",
      does: "rasterizes one page to a new PNG path; existing files are never replaced",
      tokenTip: "only for pages text/search cannot describe (scans, figures)",
    },
    app: {
      usage:
        "shiori app context [--agent|--json] | shiori app annotate --highlight \"quoted text\" | --spec <spec.json> [--dry-run] [--base-sha256 hash]",
      does: "reads or annotates the active in-memory Shiori PDF without writing a PDF file",
      tokenTip: "same target topology + spec has one stable operation ID for safe retries",
    },
  };
  return {
    schema: "shiori.cli/help/v1",
    ...(target ? { command: target, ...commands[target] } : { commands }),
    global: {
      agent: "compact JSON only",
      json: "pretty JSON",
      pages: "1-based PDF page range",
      password: "PDF password",
      help: "-h or --help",
      version: "-V or --version",
      endOfOptions: "--",
      asSpec: "extract-only pure shiori.annotations/v1 output",
      liveDescriptor:
        "SHIORI_LIVE_API_DESCRIPTOR absolute path override for tests; must be owned by the invoking user",
    },
    version: CLI_VERSION,
    rules: [
      "versioned coordinate annotation specs",
      "no HTML script execution",
      "unknown options and extra positional arguments fail with ERR_USAGE",
      "--max-chars is a total extracted-text budget",
      "portable file commands never replace existing outputs",
      "live app requests use authenticated 127.0.0.1 only",
    ],
  };
}

function createAnnotateError(
  code: AnnotateCliErrorCode,
  message: string,
  detail?: string,
): CliError {
  return new CliError(code as CliErrorCode, message, detail);
}

function writeJson(payload: unknown, options: GlobalOptions): void {
  console.log(JSON.stringify(payload, null, options.agent ? 0 : 2));
}

function cliErrorForPdfOpenError(err: unknown): CliError {
  const kind = classifyPdfOpenError(err);
  return new CliError(
    diagnosticCode(kind) as CliErrorCode,
    errorMessageForPdfKind(kind),
    err instanceof Error ? err.message : String(err),
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// Strip C0/C1 controls (keeping only \n and \t) plus DEL at the human-mode
// print boundary. Document text, names, and snippets are untrusted: a hostile
// PDF can embed ESC/CSI/OSC sequences that retitle the terminal, write the
// clipboard via OSC 52, or stage paste-to-execute payloads. JSON mode is safe
// because JSON.stringify escapes control characters.
function sanitizeTerminalText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

async function runMain(): Promise<void> {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    const output = scanErrorReportingContext(process.argv.slice(2));
    const command = output.command;
    const payload =
      err instanceof CliError
        ? {
            schema: "shiori.cli/v1",
            ok: false,
            ...(command ? { command } : {}),
            error: {
              code: err.code,
              message: err.message,
              ...(err.detail ? { detail: err.detail } : {}),
            },
            warnings: [],
            meta: { version: SCHEMA_VERSION, cliVersion: CLI_VERSION },
          }
        : {
            schema: "shiori.cli/v1",
            ok: false,
            ...(command ? { command } : {}),
            error: {
              code: "ERR_UNKNOWN",
              message: err instanceof Error ? err.message : String(err),
            },
            warnings: [],
            meta: { version: SCHEMA_VERSION, cliVersion: CLI_VERSION },
          };
    if (output.json) {
      console.log(JSON.stringify(payload, null, output.agent ? 0 : 2));
    }
    // Error messages and details can embed server- or document-controlled
    // text; the stderr boundary needs the same control-character stripping
    // as human-mode stdout.
    console.error(
      sanitizeTerminalText(`${payload.error.code}: ${payload.error.message}`),
    );
    if ("detail" in payload.error && payload.error.detail) {
      console.error(sanitizeTerminalText(payload.error.detail));
    }
    // Unix convention: 2 marks a usage error the caller must fix before
    // retrying; 1 covers runtime failures that may be worth retrying.
    process.exitCode = payload.error.code === "ERR_USAGE" ? 2 : 1;
  }
}

// Mirrors parseArgs's tokenization (option splitting via splitOption, value
// consumption via VALUE_OPTIONS, and `--` handling) without validating
// anything, so error envelopes keep the requested output format and command
// label even when parseArgs itself is what threw. `--agent=1` must still
// produce a JSON envelope for its "does not accept a value" error.
function scanErrorReportingContext(argv: string[]): {
  json: boolean;
  agent: boolean;
  command: string | null;
} {
  let json = false;
  let agent = false;
  let optionsEnded = false;
  let command: ParsedCommand | null = null;
  let commandUnknown = false;
  let appSubcommand: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
      const { name, inlineValue } = splitOption(arg);
      if (name === "--agent") {
        agent = true;
        json = true;
      } else if (name === "--json") {
        json = true;
      } else if (VALUE_OPTIONS.has(name) && inlineValue == null) {
        const next = argv[i + 1];
        if (next != null && !next.startsWith("-")) i += 1;
      }
      continue;
    }
    if (!command && !commandUnknown) {
      if (arg === "help" || arg === "version" || isCommandName(arg)) {
        command = arg;
      } else {
        commandUnknown = true;
      }
      continue;
    }
    if (command === "app" && appSubcommand == null) {
      appSubcommand = arg;
    }
  }
  const label =
    command == null || command === "help" || command === "version"
      ? null
      : command === "app"
        ? appSubcommand === "context" || appSubcommand === "annotate"
          ? `app.${appSubcommand}`
          : "app"
        : command;
  return { json, agent, command: label };
}

const modulePath = fileURLToPath(import.meta.url);

export async function entryPathsMatch(
  entryPath: string,
  candidateModulePath: string,
): Promise<boolean> {
  const left = resolve(entryPath);
  const right = resolve(candidateModulePath);
  if (left === right) return true;
  try {
    if ((await realpath(left)) === (await realpath(right))) return true;
    const [leftMetadata, rightMetadata] = await Promise.all([
      stat(left, { bigint: true }),
      stat(right, { bigint: true }),
    ]);
    return (
      leftMetadata.ino !== 0n &&
      leftMetadata.dev === rightMetadata.dev &&
      leftMetadata.ino === rightMetadata.ino
    );
  } catch {
    return false;
  }
}

async function runEntrypoint(): Promise<void> {
  const entryPath = process.argv[1];
  if (!entryPath) return;
  // Node SEA can preserve a bare argv[1] ("shiori") when the executable is
  // found through PATH. Resolving that value against cwd makes the normal
  // installed invocation look like an imported module and silently skips the
  // CLI. process.execPath is absolute in SEA, while it points at Bun/Node when
  // this source module is merely imported by tests.
  if (
    (await entryPathsMatch(entryPath, modulePath)) ||
    (await entryPathsMatch(process.execPath, modulePath))
  ) {
    await runMain();
  }
}

void runEntrypoint();
