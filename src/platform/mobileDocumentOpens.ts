import type { MobileDocumentReference } from "./open";
import { OpenHandoffQueue, type OpenHandoffQueueOptions } from "./openHandoff";

export function isMobileDocumentReference(
  value: unknown,
): value is MobileDocumentReference {
  if (typeof value === "string") return value.length > 0;
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.uri === "string" && ref.uri.length > 0;
}

export function mobileDocumentReferenceUri(ref: MobileDocumentReference): string {
  return typeof ref === "string" ? ref : ref.uri;
}

/** The Android shell's id for one intent's document; absent on other routes. */
export function mobileDocumentDeliveryId(
  ref: MobileDocumentReference,
): string | undefined {
  if (typeof ref === "string") return undefined;
  return typeof ref.deliveryId === "string" && ref.deliveryId
    ? ref.deliveryId
    : undefined;
}

/**
 * Dedupe identity: the delivery when the shell sent one, else the URI. A
 * sender may reuse one fixed content:// URI for different files, so on
 * Android two intents are two opens however alike their URIs; iOS and the
 * `file-open` string route have no delivery id and keep URI dedupe.
 */
export function mobileDocumentOpenKey(ref: MobileDocumentReference): string {
  const deliveryId = mobileDocumentDeliveryId(ref);
  return deliveryId ? `delivery:${deliveryId}` : mobileDocumentReferenceUri(ref);
}

function parseMobileDocumentReferences(
  // A thunk, not a string: the Android bridge call that produces the raw
  // JSON crosses the WebView JavaBridge boundary and can itself throw, so it
  // has to run inside this try/catch.
  readRaw: () => string,
): MobileDocumentReference[] {
  try {
    const parsed = JSON.parse(readRaw()) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.filter(isMobileDocumentReference);
  } catch {
    return [];
  }
}

export type MobileDocumentOpenQueueOptions = Pick<
  OpenHandoffQueueOptions<MobileDocumentReference>,
  "open" | "dedupeMs" | "now" | "setTimer"
>;

export type MobileDocumentOpenQueue = {
  enqueue: (ref: MobileDocumentReference) => void;
  enqueueAll: (refs: readonly MobileDocumentReference[]) => void;
  /** Take what the Android shell is holding for this page. */
  drainAndroidPending: () => void;
  whenIdle: () => Promise<void>;
  /**
   * Unmounting: Android deliveries not started yet stay un-acked for the
   * next drain instead of opening from a queue nobody owns.
   */
  close: () => void;
};

/**
 * The mobile open queue, with the Android shell's drain / ack handshake.
 *
 * The shell keeps every delivery until the page acks it, and each drain
 * returns all of them again, so a page that reloads between draining and
 * opening still gets its files. This side:
 * - accepts each delivery once per page session, however many drains or
 *   events bring it back (until the ack lands, every drain does);
 * - acks a delivery when its open starts, not when it ends: a document that
 *   takes the page down while opening must not reopen on every reload, while
 *   the ones still waiting behind it in the queue stay un-acked and survive.
 */
export function createMobileDocumentOpenQueue(
  options: MobileDocumentOpenQueueOptions,
): MobileDocumentOpenQueue {
  const accepted = new Set<string>();
  let closed = false;
  const queue = new OpenHandoffQueue<MobileDocumentReference>({
    dedupeMs: options.dedupeMs,
    now: options.now,
    setTimer: options.setTimer,
    key: mobileDocumentOpenKey,
    open: (ref) => {
      // Only a delivery the shell still holds can be left for later; a
      // string route (iOS, `file-open`) has no second chance, so it opens.
      if (closed && mobileDocumentDeliveryId(ref)) return;
      ackAndroidDelivery(ref);
      return options.open(ref);
    },
  });

  const enqueue = (ref: MobileDocumentReference) => {
    const deliveryId = mobileDocumentDeliveryId(ref);
    if (deliveryId) {
      if (accepted.has(deliveryId)) return;
      accepted.add(deliveryId);
    }
    queue.enqueue(ref);
  };

  return {
    enqueue,
    enqueueAll: (refs) => {
      for (const ref of refs) enqueue(ref);
    },
    drainAndroidPending: () => {
      const bridge = window.ShioriAndroid;
      if (!bridge?.drainPendingDocumentOpens) return;
      // Keep the receiver (`bridge.`): JavaBridge methods cannot be called
      // detached. The optional call re-checks under the thunk because the
      // guard above does not narrow inside a closure.
      const refs = parseMobileDocumentReferences(
        () => bridge.drainPendingDocumentOpens?.() ?? "",
      );
      for (const ref of refs) enqueue(ref);
    },
    whenIdle: () => queue.whenIdle(),
    close: () => {
      closed = true;
    },
  };
}

function ackAndroidDelivery(ref: MobileDocumentReference): void {
  const deliveryId = mobileDocumentDeliveryId(ref);
  if (!deliveryId) return;
  const bridge = window.ShioriAndroid;
  try {
    bridge?.ackPendingDocumentOpens?.(JSON.stringify([deliveryId]));
  } catch {
    // The shell delivers it again on the next drain; this session's
    // accepted set keeps it from opening twice here.
  }
}
