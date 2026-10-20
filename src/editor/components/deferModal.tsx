import { useEffect, useSyncExternalStore, type ComponentType } from "react";
import { LoadFailed, SlowLoadNotice } from "./deferModalNotices";
import { useDeferredFocusReturn } from "./useDeferredFocusReturn";

type Snapshot<P> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; component: ComponentType<P> }
  | { kind: "error"; error: unknown };

/**
 * Keeps a rarely-opened modal's code out of the entry bundle.
 *
 * The wrapped component loads the first time it is actually open and stays
 * cached for the session. While loading nothing is rendered; only a slow
 * load (a cold network chunk on the web build — the desktop build reads a
 * local file) shows a small notice. A failed load renders an error modal with
 * a retry, closable through the same `onClose`, so the user is never left
 * with a trigger that silently does nothing. The real modal still restores
 * focus itself, but after a slow load it would capture the notice rather than
 * the trigger, so the wrapper also returns focus to the trigger on close
 * (useDeferredFocusReturn).
 *
 * This is deliberately not React.lazy: a rejected lazy import is cached as
 * a permanent error, which makes retry impossible without remounting the
 * tree above it.
 */
export function deferModal<P extends { onClose: () => void }>(
  load: () => Promise<ComponentType<P>>,
  isOpen: (props: P) => boolean = () => true,
): ComponentType<P> {
  let snapshot: Snapshot<P> = { kind: "idle" };
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot<P>) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const getSnapshot = () => snapshot;
  const ensureLoaded = () => {
    if (snapshot.kind === "ready" || snapshot.kind === "loading") return;
    publish({ kind: "loading" });
    load().then(
      (component) => publish({ kind: "ready", component }),
      (error: unknown) => publish({ kind: "error", error }),
    );
  };

  function DeferredModal(props: P) {
    const open = isOpen(props);
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    useDeferredFocusReturn(open);
    useEffect(() => {
      if (open) ensureLoaded();
    }, [open]);
    if (!open) return null;
    if (state.kind === "ready") {
      const Loaded = state.component;
      return <Loaded {...props} />;
    }
    if (state.kind === "error") {
      return <LoadFailed onClose={props.onClose} onRetry={ensureLoaded} />;
    }
    return <SlowLoadNotice onClose={props.onClose} />;
  }
  return DeferredModal;
}
