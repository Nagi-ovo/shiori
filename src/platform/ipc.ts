// Typed IPC command bindings — the single source of truth is the Rust side.
//
// `commands` is generated from the `#[tauri::command]` signatures by
// tauri-specta (see `src-tauri/src/lib.rs`: `build_specta_builder` + the
// `export_typescript_bindings` test). Regenerate after changing a command with:
//
//   cargo test --manifest-path src-tauri/Cargo.toml export_typescript_bindings
//
// `bun run build` type-checks the generated `bindings.ts` and every call site,
// so a drifted Rust command signature breaks the TS build — that is the whole
// point of routing invokes through here instead of stringly-typed `invoke(...)`.
//
// The generated functions return a `Result<T, string>` union instead of
// throwing. `unwrapCommand` restores the throw-on-error convention that raw
// Tauri `invoke()` (and every existing call site) already uses, so swapping a
// call site onto the typed binding preserves its exact runtime behavior: a Rust
// error string still surfaces as a thrown string, caught by the same
// `catch (err) { String(err) }` handlers as before.
//
// Three commands are intentionally absent from `commands`: `save_pdf_dialog`,
// `read_document_bytes_at_path`, and `read_pdf_bytes_at_path` transfer raw bytes
// through `tauri::ipc::Request` / `Response`, which have no `specta::Type` and so
// cannot be collected by tauri-specta. They keep their hand-written `invoke(...)`
// call sites (in `save.ts` / `open.ts`).
import { commands, type Result } from "./bindings";

export { commands };

// Collapse a generated command Result back into the value / throw convention of
// raw Tauri invoke(). The error branch always carries the Rust command's error
// string (our commands all return `Result<_, String>`), thrown as-is so callers'
// existing error handling is unchanged.
export function unwrapCommand<T>(result: Result<T, string>): T {
  if (result.status === "error") {
    throw result.error;
  }
  return result.data;
}

/**
 * Stop listening, and never fail doing it.
 *
 * Tauri's `unlisten` is asynchronous under the hood and reads the webview's
 * listener registry: `listeners[eventId].handlerId`. When that entry is
 * already gone the call rejects rather than no-opping. Two ordinary
 * situations hit that. In dev, a hot module update re-runs an effect while
 * the previous listener is still being torn down, so the same handle is
 * unlistened twice — every hot update then leaves an unhandled rejection and
 * (worse) a teardown that stopped halfway, so listeners pile up across
 * updates until the window stops responding. In production the same happens
 * when the webview reloads out from under a pending teardown.
 *
 * A cleanup that cannot be completed must still not throw: the caller has
 * already dropped its reference either way. Accepts a sync or async
 * teardown, and swallows both shapes of failure.
 */
export function safeUnlisten(off: (() => unknown) | null | undefined): void {
  if (!off) return;
  try {
    const result = off();
    if (
      result != null &&
      typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // The listener is already gone, which is the state we wanted.
  }
}
