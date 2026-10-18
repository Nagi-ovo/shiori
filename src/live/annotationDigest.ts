import type { LiveApiAnnotationDigest } from "../platform/liveApi";
import type { Overlay, PageModel } from "../pdf/model/types";
import { splitGraphemes } from "../shared/graphemes";

/**
 * The read half of the agent loop. Until this existed an agent could write a
 * callout and never read one back: `annotationCount` said "4" and nothing
 * said what those four say. A session that answers a follow-up ("what about
 * the other one?") has to be able to see the conversation it is part of.
 *
 * This is a digest, not the model: content only, no geometry. Geometry churns
 * on every drag and would republish the whole payload 60 times a second for
 * nothing, and an agent cannot act on points anyway — it acts on quotes and
 * annotation IDs, both of which are here.
 */

/** Per-annotation caps. Long bodies are truncated, never dropped. */
const MAX_TEXT_CHARACTERS = 400;
const MAX_QUOTE_CHARACTERS = 240;
const MAX_THREAD_TURNS = 12;
const MAX_ANNOTATIONS = 200;
/**
 * Whole-digest ceiling, in UTF-8 BYTES. The context is PUSHED to native on
 * every content change, so its size is a running cost, not a one-off — an
 * unbounded digest would put a large document's entire text through IPC on
 * every keystroke.
 *
 * Bytes, not JavaScript string length, because the receiving end is Rust:
 * live_api.rs budgets with String::len(), which is UTF-8 bytes, against
 * MAX_CONTEXT_ANNOTATION_CHARS (64 KiB). Counting UTF-16 code units here
 * made the two disagree by 3x on CJK — a Chinese or Japanese document with
 * a few hundred annotations looked comfortably under budget on this side and
 * blew past it on the other, and native rejected the whole context. The
 * reader lost the Live channel entirely, with only a console warning.
 *
 * Deliberately below the native ceiling so rounding and the fields Rust
 * counts but this does not can never close the gap.
 */
const MAX_TOTAL_UTF8_BYTES = 48_000;

const textEncoder = new TextEncoder();

/** UTF-8 byte length, matching how the Rust side measures the same string. */
function utf8Length(value: string): number {
  return textEncoder.encode(value).length;
}

export type LiveAnnotationDigestResult = {
  annotations: LiveApiAnnotationDigest[];
  /** True when caps cut the list short — say so rather than look complete. */
  truncated: boolean;
};

export function buildLiveAnnotationDigest(
  overlays: readonly Overlay[],
  pages: readonly PageModel[],
): LiveAnnotationDigestResult {
  const pageNumbers = new Map<string, number>();
  pages.forEach((page, index) => pageNumbers.set(page.id, index + 1));

  const annotations: LiveApiAnnotationDigest[] = [];
  let spent = 0;
  let truncated = false;

  // Budget spent on the most RECENTLY ACTIVE annotations, output in document
  // order.
  //
  // Spending it in array order dropped the newest annotations, which is
  // backwards for what this digest supports: a follow-up is almost always
  // about the callout the reader just touched. But array order is not time
  // order either — adding a reply to an old callout replaces it in place
  // rather than moving it to the end, and imported annotations arrive in
  // page and PDF-object order. So recency is computed from the content
  // (see overlayActivityAt) and only falls back to position.
  //
  // model.overlays itself is never reordered: its order is paint order.
  // Activity is computed once per overlay, not inside the comparator — that
  // walks every thread O(n log n) times, and this runs on every content
  // change.
  const now = Date.now();
  const ranked = overlays.map((overlay, index) => ({
      overlay,
      index,
      activity: overlayActivityAt(overlay, now),
    }));
  heapifyMostActiveOverlays(ranked);

  const kept: { entry: LiveApiAnnotationDigest; index: number }[] = [];
  while (ranked.length > 0) {
    if (kept.length >= MAX_ANNOTATIONS) {
      truncated = true;
      break;
    }
    const { overlay, index } = popMostActiveOverlay(ranked)!;
    const page = pageNumbers.get(overlay.pageId);
    if (page === undefined) continue;
    const digested = digestEntry(overlay, page);
    if (!digested) continue;
    const cost = entryCost(digested.entry);
    if (spent + cost > MAX_TOTAL_UTF8_BYTES) {
      // Skip, do not stop. A grapheme has no fixed byte length — "x" plus
      // 30,000 combining marks is one grapheme and 60 KB — so a single
      // oversized annotation used to end the whole digest, and an agent got
      // an empty list from a document full of perfectly ordinary notes.
      truncated = true;
      continue;
    }
    truncated ||= digested.truncated;
    spent += cost;
    kept.push({ entry: digested.entry, index });
  }
  kept.sort((left, right) => left.index - right.index);
  annotations.push(...kept.map((item) => item.entry));

  return { annotations, truncated };
}

function digestEntry(
  overlay: Overlay,
  page: number,
): { entry: LiveApiAnnotationDigest; truncated: boolean } | null {
  const textResult =
    "text" in overlay && typeof overlay.text === "string"
      ? clamp(overlay.text, MAX_TEXT_CHARACTERS)
      : { value: "", truncated: false };
  const quoteResult = overlay.anchor
    ? clamp(overlay.anchor.quote, MAX_QUOTE_CHARACTERS)
    : { value: "", truncated: false };
  let truncated = textResult.truncated || quoteResult.truncated;
  const turns = overlay.type === "callout" ? overlay.thread ?? [] : [];
  if (turns.length > MAX_THREAD_TURNS) truncated = true;
  const thread =
    turns.length > 0
      ? turns.slice(-MAX_THREAD_TURNS).map((turn) => {
          const author = turn.author
            ? clamp(turn.author, 120, MAX_AUTHOR_CODE_UNITS)
            : null;
          const text = clamp(turn.text, MAX_TEXT_CHARACTERS);
          truncated ||= text.truncated || Boolean(author?.truncated);
          return {
            role: turn.role,
            ...(author?.value ? { author: author.value } : {}),
            text: text.value,
          };
        })
      : undefined;
  // An annotation with no text, no anchored quote and no conversation carries
  // nothing an agent can reason about — an ink stroke's shape is not readable.
  if (!textResult.value && !quoteResult.value && !thread) return null;
  return {
    truncated,
    entry: {
      id: overlay.id,
      type: overlay.type,
      page,
      ...(textResult.value ? { text: textResult.value } : {}),
      ...(quoteResult.value ? { quote: quoteResult.value } : {}),
      ...(thread ? { thread } : {}),
    },
  };
}

/**
 * How recently an annotation was touched, as a (tier, timestamp) pair.
 *
 * Array position is NOT a proxy for this: replying to an old callout replaces
 * it in place, and imported annotations arrive in page and PDF-object order,
 * so "later in the array" is easily older.
 *
 * But timestamps from different worlds are not comparable either. A first
 * attempt max()'d them together, which read every number as the same
 * quantity and produced the opposite of the intent: a callout the reader had
 * just created in Shiori carries no timestamp at all, so it scored 0 and lost
 * to every imported annotation with a /M date — the freshest thing in the
 * document was the first thing dropped.
 *
 * So they are tiered instead, and only compared within a tier:
 *
 *   2  the reader's own activity — a thread turn or an edit. For an imported
 *      annotation this only counts if it happened AFTER the import: opening
 *      a file rebuilds its sticky notes through createNoteOverlay(..., now)
 *      and copies source dates into thread.at, so an imported annotation
 *      arrives already carrying today's timestamps. Reading those as the
 *      reader's own work would let any freshly opened document outrank the
 *      notes they actually wrote.
 *   1  no provenance of any kind. Counter-intuitive that this beats tier 0,
 *      but the ABSENCE of source evidence is the signal: an imported
 *      annotation carries an author, a date, or a reply link, so one with
 *      none of those was made here and simply never recorded a time.
 *
 *      Keyed on the whole provenance set, not just dates: a PDF annotation
 *      with an author but no /CreationDate or /M is still someone else's.
 *      A raw PDF callout with no metadata at all is indistinguishable from
 *      a local one and lands here — accepted, because the alternative is
 *      demoting the reader's own untimed notes.
 *   0  imported, untouched since. Ordered by source date where present.
 *
 * Source dates in the future are clamped to now, so a wrong /M date cannot
 * reorder anything.
 */
type OverlayActivity = { tier: 0 | 1 | 2; at: number };

type RankedOverlay = {
  overlay: Overlay;
  index: number;
  activity: OverlayActivity;
};

function isMoreActive(left: RankedOverlay, right: RankedOverlay): boolean {
  if (left.activity.tier !== right.activity.tier) {
    return left.activity.tier > right.activity.tier;
  }
  if (left.activity.at !== right.activity.at) {
    return left.activity.at > right.activity.at;
  }
  return left.index > right.index;
}

function siftMostActiveDown(heap: RankedOverlay[], start: number): void {
  let parent = start;
  while (true) {
    const left = parent * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let best = left;
    if (right < heap.length && isMoreActive(heap[right]!, heap[left]!)) {
      best = right;
    }
    if (!isMoreActive(heap[best]!, heap[parent]!)) return;
    [heap[parent], heap[best]] = [heap[best]!, heap[parent]!];
    parent = best;
  }
}

function heapifyMostActiveOverlays(heap: RankedOverlay[]): void {
  for (let index = Math.floor(heap.length / 2) - 1; index >= 0; index -= 1) {
    siftMostActiveDown(heap, index);
  }
}

function popMostActiveOverlay(heap: RankedOverlay[]): RankedOverlay | undefined {
  const best = heap[0];
  const tail = heap.pop();
  if (heap.length > 0 && tail) {
    heap[0] = tail;
    siftMostActiveDown(heap, 0);
  }
  return best;
}

/**
 * Whether this annotation came from the source document.
 *
 * Prefers what the importer recorded. The fallback is for overlays written
 * by builds before `origin` existed — it reads the review-provenance field
 * set, the same one hasReviewProvenance() uses in
 * editor/highlights/merge.ts. That fallback is a guess and known to be
 * incomplete: PDF metadata is optional, so an imported annotation with no
 * author, no dates and no reply link looks local. Recording origin is what
 * makes new imports exact.
 */
function isImported(overlay: Overlay): boolean {
  if (overlay.origin === "imported") return true;
  return Boolean(
    overlay.sourceAuthor ||
      overlay.sourceCreatedAt !== undefined ||
      overlay.sourceModifiedAt !== undefined ||
      overlay.sourceInReplyToId ||
      overlay.sourceReplyType,
  );
}

function overlayActivityAt(overlay: Overlay, now: number): OverlayActivity {
  const imported = isImported(overlay);
  // Importing stamps the present onto imported data: a PDF sticky note is
  // rebuilt through createNoteOverlay(..., now), so its createdAt/updatedAt
  // are the moment the file was opened, and an imported reply copies the
  // source /CreationDate straight into thread.at. Neither says the reader
  // did anything. For an imported annotation, only activity strictly AFTER
  // the import counts as theirs.
  const createdAt =
    "createdAt" in overlay && typeof overlay.createdAt === "number"
      ? overlay.createdAt
      : 0;
  // The moment after which activity can be the reader's. createdAt is the
  // import time for a rebuilt sticky note, but a callout does not go through
  // createNoteOverlay and has none — and its thread turns carry the SOURCE
  // document's dates, so without a baseline every imported reply looked like
  // live activity. Fall back to the source dates themselves: a reply the
  // reader adds here is stamped with Date.now() and clears them easily.
  let importedAt = 0;
  if (imported) {
    // The recorded import time when there is one. The rest is the old
    // inference, kept for overlays from builds before importedAt existed:
    // createdAt is the import moment for a rebuilt note, and source dates
    // bound an imported reply's own timestamps.
    importedAt = overlay.importedAt ?? createdAt;
    if (overlay.importedAt === undefined) {
      if (typeof overlay.sourceModifiedAt === "number") {
        importedAt = Math.max(importedAt, overlay.sourceModifiedAt);
      }
      if (typeof overlay.sourceCreatedAt === "number") {
        importedAt = Math.max(importedAt, overlay.sourceCreatedAt);
      }
    }
  }

  let local = 0;
  const thread = "thread" in overlay ? overlay.thread : undefined;
  for (const turn of thread ?? []) {
    if (typeof turn.at === "number" && turn.at > local) local = turn.at;
  }
  if ("updatedAt" in overlay && typeof overlay.updatedAt === "number") {
    local = Math.max(local, overlay.updatedAt);
  }
  // The one signal that covers every overlay shape. updatedAt exists only on
  // notes, so without this an edited callout or text overlay carried no
  // evidence of having been touched.
  if (typeof overlay.localActivityAt === "number") {
    local = Math.max(local, overlay.localActivityAt);
  }
  if (!imported) local = Math.max(local, createdAt);
  if (imported && local <= importedAt) local = 0;

  if (local > 0) return { tier: 2, at: Math.min(local, now) };
  if (!imported) return { tier: 1, at: 0 };

  let sourceDate = 0;
  if (typeof overlay.sourceModifiedAt === "number") {
    sourceDate = Math.max(sourceDate, overlay.sourceModifiedAt);
  }
  if (typeof overlay.sourceCreatedAt === "number") {
    sourceDate = Math.max(sourceDate, overlay.sourceCreatedAt);
  }
  // NOT clamped. The tier already keeps imported dates from outranking the
  // reader's own work, so clamping to now only flattened legitimate source
  // dates into one value — several imports dated in the future all collapsed
  // to the same number and fell back to array position, so the newest of them
  // could be the first dropped. Ordering among imports is only ever compared
  // with other imports.
  return { tier: 0, at: sourceDate };
}

function entryCost(entry: LiveApiAnnotationDigest): number {
  // Mirrors the fields live_api.rs adds up, in the same unit it uses.
  let cost = utf8Length(entry.id) + utf8Length(entry.type);
  cost += entry.text ? utf8Length(entry.text) : 0;
  cost += entry.quote ? utf8Length(entry.quote) : 0;
  for (const turn of entry.thread ?? []) {
    cost += utf8Length(turn.text) + utf8Length(turn.role);
    cost += turn.author ? utf8Length(turn.author) : 0;
  }
  return cost;
}

/**
 * UTF-16 ceiling for any single field, below the CLI's own limit.
 *
 * The CLI revalidates what it receives with `value.length <= 1024` — UTF-16
 * code units — and throws away the ENTIRE digest if a field is over. A
 * grapheme is not one code unit: 400 family emoji are 400 graphemes and 3,200
 * code units, so a purely grapheme-based clamp produced fields the CLI
 * refused. Three layers, three units (Rust counts UTF-8 bytes), so each cut
 * has to respect the tightest of them.
 */
const MAX_FIELD_CODE_UNITS = 1000;
// The CLI checks author separately and far more tightly (256). A display
// name of wide graphemes cleared the shared 1000 ceiling and still got the
// whole context thrown away, so the ceiling travels with the call.
const MAX_AUTHOR_CODE_UNITS = 200;

function clamp(
  value: string,
  max: number,
  codeUnitCeiling: number = MAX_FIELD_CODE_UNITS,
): { value: string; truncated: boolean } {
  const trimmed = value.trim();
  // Fast path, and the important one for cost: fewer code units than the
  // grapheme budget means it cannot exceed either ceiling, so nothing needs
  // segmenting at all. Most annotations land here.
  if (trimmed.length <= Math.min(max, codeUnitCeiling)) {
    return { value: trimmed, truncated: false };
  }

  // Segment only as much as could possibly survive. A PDF /Contents has no
  // length limit of its own, and this runs on every content change —
  // materialising a grapheme array for a megabyte of untrusted text would be
  // ~30 ms and tens of MB each time, for a result that is thrown away past
  // the first thousand code units.
  const scanLimit = codeUnitCeiling + 64;
  const scanned =
    trimmed.length > scanLimit ? trimmed.slice(0, scanLimit) : trimmed;
  const graphemes = splitGraphemes(scanned);
  // Measured and cut in the same unit. Deciding with UTF-16 length and
  // cutting by grapheme disagreed on anything astral: 300 emoji are 300
  // graphemes but 600 code units, so nothing was dropped yet the text still
  // got an ellipsis and the whole digest was reported as truncated.
  if (
    scanned.length === trimmed.length &&
    graphemes.length <= max &&
    trimmed.length <= codeUnitCeiling
  ) {
    return { value: trimmed, truncated: false };
  }
  // Cut on grapheme boundaries. String.slice counts UTF-16 code units, so it
  // can land in the middle of a surrogate pair — an emoji at the boundary
  // became a lone surrogate, which is not valid UTF-8. This payload crosses
  // to Rust as JSON, and serde_json refuses to deserialize a String
  // containing one, so a single misplaced emoji made native reject the whole
  // context and keep serving a stale one, with only a console warning. Also
  // avoids splitting a family emoji or a flag down the middle, which is what
  // a reader would actually notice.
  // Whichever ceiling comes first. Never mid-grapheme either way.
  let clipped = "";
  for (const grapheme of graphemes.slice(0, max)) {
    if (clipped.length + grapheme.length > codeUnitCeiling) break;
    clipped += grapheme;
  }
  // The ellipsis is part of the contract: an agent must be able to tell a
  // complete body from a clipped one before quoting it back to the reader.
  return { value: `${clipped}…`, truncated: true };
}
