// Tiny external-state toast bus. Kept dep-free and hook-less so any
// non-component code (store actions, utility functions) can pop a
// transient message without plumbing props.
//
// Components subscribe via <ToastHost /> — see editor/components/ToastHost.tsx.

export type ToastTone = "info" | "error";

export type ToastAction = { label: string; onClick: () => void };

// Locale-agnostic payloads for messages produced by non-React code. The
// helper stays free of i18n imports; <ToastHost /> resolves each `kind`
// to localised copy via t() at render time, so the active language always
// wins and no English sentinel strings live in toast state.
export type ToastL10nMessage =
  | { kind: "savedTo"; path: string }
  | { kind: "savedAs"; path: string }
  | { kind: "sharedAs"; path: string }
  | { kind: "liveAnnotations"; added: number };

export type ToastMessage = string | ToastL10nMessage;

export type ToastItem = {
  id: number;
  message: ToastMessage;
  detail?: string;
  tone: ToastTone;
  action?: ToastAction;
  actions?: ToastAction[];
};

type Listener = (items: ToastItem[]) => void;

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<Listener>();
const timers = new Map<number, number>();
const MAX_VISIBLE_TOASTS = 4;

function emit() {
  for (const fn of listeners) fn(items);
}

function dismiss(id: number) {
  const timer = timers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(id);
  items = items.filter((i) => i.id !== id);
  emit();
}

function scheduleDismiss(id: number, timeoutMs: number): void {
  const previous = timers.get(id);
  if (previous !== undefined) window.clearTimeout(previous);
  timers.set(
    id,
    window.setTimeout(() => dismiss(id), timeoutMs),
  );
}

function samePassiveToast(
  current: ToastItem,
  incoming: Omit<ToastItem, "id">,
): boolean {
  if (current.action || current.actions || incoming.action || incoming.actions) {
    return false;
  }
  return (
    current.tone === incoming.tone &&
    current.detail === incoming.detail &&
    JSON.stringify(current.message) === JSON.stringify(incoming.message)
  );
}

function push(item: Omit<ToastItem, "id">, timeoutMs = 3400): number {
  const duplicate = items.find((current) => samePassiveToast(current, item));
  if (duplicate) {
    // Move the existing card to the newest edge and extend its lifetime. This
    // keeps a batch of identical unsupported-file errors from covering the UI
    // without discarding distinct failures the user still needs to see.
    items = [...items.filter((current) => current.id !== duplicate.id), duplicate];
    emit();
    scheduleDismiss(duplicate.id, timeoutMs);
    return duplicate.id;
  }
  const id = nextId++;
  const full: ToastItem = { ...item, id };
  items = [...items, full];
  while (items.length > MAX_VISIBLE_TOASTS) {
    const oldest = items.shift();
    if (!oldest) break;
    const timer = timers.get(oldest.id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.delete(oldest.id);
  }
  emit();
  scheduleDismiss(id, timeoutMs);
  return id;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn(items);
  return () => {
    listeners.delete(fn);
  };
}

export const toast = {
  show(message: string, detail?: string) {
    push({ message, detail, tone: "info" });
  },
  // Same as `show` but with an action button (e.g. Undo). Caller-facing
  // dismiss() lets the action handler tear the toast down immediately
  // after the user taps the button.
  showAction(message: string, action: ToastAction, detail?: string) {
    push({ message, detail, tone: "info", action });
  },
  showActions(message: string, actions: ToastAction[], detail?: string) {
    push({ message, detail, tone: "info", actions }, 8000);
  },
  error(message: string, detail?: string) {
    push({ message, detail, tone: "error" }, 5200);
  },
  errorAction(message: string, action: ToastAction, detail?: string) {
    push({ message, detail, tone: "error", action }, 8000);
  },
  // A Live API client just mutated the open document; the user performed no
  // action, so the change (and the redo stack it cleared) must be announced.
  showLiveAnnotations(added: number) {
    push({ message: { kind: "liveAnnotations", added }, tone: "info" });
  },
  showSaved(
    platform: "desktop" | "web" | "mobile",
    path: string,
    actions?: ToastAction[],
  ) {
    if (platform === "desktop") {
      push(
        { message: { kind: "savedTo", path }, tone: "info", actions },
        actions ? 8000 : 3400,
      );
    } else {
      if (platform === "mobile") {
        push({ message: { kind: "sharedAs", path }, tone: "info" });
        return;
      }
      // The "check your Downloads folder" detail is attached by ToastHost,
      // which owns localisation for structured messages.
      push({ message: { kind: "savedAs", path }, tone: "info" });
    }
  },
  dismiss,
};
