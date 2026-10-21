import type { LiveAppContext } from "./liveApp";
import { sanitizeTerminalText } from "./terminalText";

/**
 * The annotations an agent can actually reason about, with their IDs. The ID
 * is the operative part: it is what a `calloutReply` spec targets, so reading
 * and replying become one continuous move instead of a guess.
 */
export function printAnnotationDigest(context: LiveAppContext): void {
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
