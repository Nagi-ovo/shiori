# Handoff — Tablet Embedded Browser (Path B: real in-rail split view)

> **Date:** 2026-06-14 · **Tauri:** 2.10.3 (`unstable`)
>
> **2026-09-23 note:** implemented; code still cites this as the spec. Tauri
> is now `=2.11.5`. The mobile arms forward to the plugin instead of returning
> `web-panel-unsupported` (see §16, `71c0f73a`). File:line references below
> are from June and have drifted — search by symbol name. Android on-device
> QA status is not recorded.

---

## 1. Mission & scope

Build a **real, in-rail, split-view embedded browser on tablets** (iPad +
Android tablets) that matches the desktop experience: it lives in the right rail
beside the document, has an address bar + back/forward/reload + loading/nav
state, follows the rail's geometry, and hides under modals.

**In scope**
- iPad (iPadOS) + Android tablets only.
- Tablet/phone detection (`IS_TABLET` / `IS_PHONE`).
- A Tauri mobile plugin (`tauri-plugin-shiori-browser` or similar) backing the
  browser with a **native WKWebView (iOS) / android.webkit.WebView (Android)**
  child view, driven by the same command/event protocol as desktop.
- Capability matrix wiring so the Browser tab appears on tablet, not phone.

**Out of scope (do NOT build)**
- **Terminal on tablet or phone** — terminal stays `IS_TAURI_DESKTOP` only. Never
  touch `embeddedTerminal`.
- **Anything on phones** — phones get neither browser nor terminal.
- **Full-screen Path A** (SFSafariViewController / Custom Tabs) — explicitly
  rejected by the maintainer in favor of the real in-rail split. (It remains a
  documented fallback only if the native subview path proves impossible in
  practice — see §11.)

---

## 2. Feasibility verdict — why tablet ≠ desktop architecture

The desktop browser is a **native child webview** created with
`Window::add_child` (Tauri `unstable` multi-webview). **That API does not exist on
mobile** — it is `#[cfg(desktop)]`-gated and will not even compile for iOS/Android.

Authoritative evidence (pinned source under
`~/.cargo/registry/src/*/tauri-2.10.3/`):

- `src/window/mod.rs:1049` — `add_child` is `#[cfg(any(test, all(desktop, feature = "unstable")))]`.
- `src/webview/mod.rs:1462` — the whole `impl Webview` block with
  `set_bounds`/`set_size`/`set_position`/`hide`/`show`/`close` is `#[cfg(desktop)]`.
- `src/webview/plugin.rs:52` — `create_webview` returns `Err(UnstableFeatureNotSupported)`
  without the feature; the working arm only compiles on desktop.
- `tauri-runtime-wry-*/src/lib.rs` — child-webview creation + `WebviewKind::WindowChild`
  wiring all sit under `#[cfg(desktop)]`.

Upstream, unowned, no timeline: tauri-apps/tauri
[#11794](https://github.com/tauri-apps/tauri/issues/11794) (add_child on mobile),
[#11528](https://github.com/tauri-apps/tauri/issues/11528) (multiple webviews on
mobile), tauri-apps/wry [#1580](https://github.com/tauri-apps/wry/issues/1580).
Docs: [Multi-Window on Mobile](https://v2.tauri.app/learn/mobile-multiwindow/) —
"each window is a separate Activity/Scene, **not** a multi-webview arrangement
within one window."

This is **exactly why** every `web_panel_*` command in `lib.rs` already has a
`#[cfg(mobile)]` twin returning `Err("web-panel-unsupported")`, and why the
`WebviewBuilder`/`Webview` import (`lib.rs:37`) is `#[cfg(not(mobile))]`. Today
the mobile build compiles *only because those stubs exist*. **Your job is to
replace those stubs with calls into a native plugin** — not to make the desktop
path compile on mobile (it can't).

iframe is also out, for the same reason it died on desktop (see POSTMORTEM
2026-05-30): target sites set `X-Frame-Options`/`frame-ancestors`, and Shiori's
CSP `frame-src 'self'` blocks cross-origin frames. The content **must** be a
native web view.

---

## 3. Architecture decision

Build **one Tauri mobile plugin** exposing the same command surface the frontend
already calls, backed by a platform-native child web view added as a sibling of
the Tauri WebView inside the single mobile window:

- **iOS:** a `WKWebView` added as a **subview** of the Tauri view controller's
  root `UIView`, positioned by `frame`.
- **Android:** an `android.webkit.WebView` added as a **child** of the Activity's
  root content `FrameLayout`, positioned by `FrameLayout.LayoutParams`.

The frontend (`src/platform/webPanel.ts` + `RightRail.tsx` `BrowserPanel`) stays
**almost unchanged** — it already measures the host rect and drives bounds via
`web_panel_set_bounds`. On tablet, the only difference is that the Rust
`#[cfg(mobile)]` arms forward those same commands to the plugin instead of to
`add_child`. **Keep the protocol identical** so there is one frontend, two
backends.

---

## 4. The canonical desktop protocol you must mirror

Treat the **post-Windows-fix** desktop implementation as the source of truth.
Below is the contract as of this writing (verify against the sealed code).

### 4.1 Tauri commands (frontend → Rust)
Defined in `src/platform/webPanel.ts` → `invokeWebPanel(...)`; Rust handlers in
`lib.rs` (desktop `#[cfg(not(mobile))]`, mobile stub `#[cfg(mobile)]`). Tauri
converts JS camelCase args → Rust snake_case.

| Command | Args (JS) | Desktop behavior | Your mobile arm must… |
|---|---|---|---|
| `web_panel_open` | `{ url, bounds?, persistSession? }` | create-or-navigate child webview, size to bounds, show | create the native WebView if absent (apply UA + incognito per `persistSession`), add to view tree, set frame=bounds, load url, show |
| `web_panel_navigate` | `{ url }` | `webview.navigate(url)` | `webView.load(url)` |
| `web_panel_set_bounds` | `{ bounds:{x,y,width,height} }` | `set_position` + `set_size` (+ show) | set the native view frame/layout; show |
| `web_panel_hide` | — | `webview.hide()` (keep alive) | `isHidden=true` / `visibility=GONE` (keep alive — do NOT destroy) |
| `web_panel_back` | — | `eval("history.back()")` | `webView.goBack()` |
| `web_panel_forward` | — | `eval("history.forward()")` | `webView.goForward()` |
| `web_panel_reload` | — | `eval("location.reload()")` | `webView.reload()` |
| `web_panel_close` | — | `webview.close()` + clear history state | remove native view + release |

Handler registration: `lib.rs` `tauri::generate_handler![ … ]` (~`lib.rs:2609`)
references all eight unconditionally — your mobile arms must keep the **same
signatures**.

### 4.2 Events (Rust → frontend)
- `web-panel-nav` — payload (camelCase): `{ url: string|null, loading: bool, canGoBack: bool, canGoForward: bool, error: string|null }`. Emitted on each committed navigation + on nav start. Frontend listener: `listenWebPanelNav` (`webPanel.ts:123`), consumed by `BrowserPanel` via the store (`webPanel.*`). **Your plugin must emit this** from the native nav delegate so the address bar + back/forward enablement + loading state work. Build the same nav-state model the desktop keeps (`emit_web_panel_nav` at `lib.rs:945`, history/cursor in `WebPanelInner`) — or recompute `canGoBack/Forward` from the native view (`webView.canGoBack()/canGoForward()` on Android; track on iOS).
- `web-panel-open` — `{ url }`. Desktop-only (terminal `open` shim). **Not needed on tablet** (no terminal).

### 4.3 Visibility model (the single most important rule)
From `BrowserPanel` (`RightRail.tsx:462`+):
```
shouldShow = active(tab === "browser") && !obscured(nativeWebviewObscured)
```
- When `shouldShow` is false → call `hideWebPanel()` (keep the page alive; never
  close on tab switch). On unmount → `hideWebPanel()`.
- A native web view is an **OS layer with no DOM clipping/stacking/hit-testing**.
  It floats over the React UI by raw rect. So it MUST be hidden whenever anything
  should sit above it: a non-browser tab, a rail-resize drag, OR **any modal**
  (Settings, Export, shortcuts, go-to-page, find, print, beta gate, …). The
  `obscured` prop already aggregates these on desktop — reuse the same signal.

### 4.4 Geometry units
- `measure()` (`RightRail.tsx:496`) returns the host `div`'s
  `getBoundingClientRect()` **rounded to CSS logical px**, relative to the window
  content's top-left: `{ x, y, width, height }`.
- Desktop: Tauri scales these by the monitor DPR for the physical webview.
- **Tablet — the gotcha:** see §8. iOS `UIView.frame` is in **points** (≈ CSS px
  for the Tauri webview at scale 1). Android `View` layout is in **physical px =
  CSS px × devicePixelRatio**. Convert correctly per platform.

### 4.5 UA + incognito
- Desktop sets an **iPhone Safari UA** (`WEB_PANEL_USER_AGENT`, `lib.rs:175`) so
  responsive sites serve their narrow device-width layout and fit the rail
  (POSTMORTEM 2026-05-30 root-cause #3). **Do the same on tablet** — iPadOS
  WKWebView defaults to a *desktop* UA and will overflow the narrow rail
  otherwise. Pass the UA from Rust (single source of truth) into the plugin, or
  hardcode the same string. Make it a tunable.
- `incognito(!persistSession)` on desktop → on iOS use a **non-persistent**
  `WKWebsiteDataStore`; on Android, WebView has no true incognito — document the
  limitation and at minimum disable persistent cookies/cache when
  `persistSession` is false. The pref is `prefs.browserPersistSession`.

---

## 5. Tablet / phone detection — `src/platform/index.ts`

There is **no tablet vs phone signal today**: `IS_IOS` (index.ts:69) lumps iPad +
iPhone; `useIsMobile` is **viewport-width only** (959px). Build-time
`__TAURI_ENV_PLATFORM__`/`__TAURI_ENV_TARGET_TRIPLE__` give ios/android/desktop
but **not** form factor — the same binary serves phone + tablet. So tablet-vs-phone
is a **runtime** decision.

Add after `IS_IOS`/`IS_ANDROID` (index.ts:~69-74):

```ts
const screenW =
  typeof screen === "undefined" ? 0 : Math.min(screen.width, screen.height);

// iPadOS reports as "iPad" (older UA) OR spoofs desktop Safari
// (platform === "MacIntel" + touch). iPhone reports "iPhone" and never
// MacIntel, so MacIntel+touch is an unambiguous iPad tell. (IS_IOS at
// index.ts:69 already relies on this same spoof signal.)
const isIPadOS =
  /iPad/i.test(userAgent) ||
  (platform === "MacIntel" && maxTouchPoints > 1);

// Android tablets drop the "Mobile" UA token that phones carry; CSS
// shortest-side >= 600 (~Android sw600dp) is the backstop.
const isAndroidTablet =
  IS_ANDROID && (!/Mobile/i.test(userAgent) || screenW >= 600);

export const IS_TABLET = IS_TAURI_MOBILE && (isIPadOS || isAndroidTablet);
export const IS_PHONE =
  IS_TAURI_MOBILE && !IS_TABLET;
```

Caveats (call out in review):
- Keep `IS_TABLET` a **device fact**; keep the rail drawer on `useIsMobile` (a
  **viewport fact**). Different axes — do not merge. iPad mini in Slide Over can
  be phone-width; the Browser tab keys off `IS_TABLET` (still shows), but the rail
  renders as a drawer via `useIsMobile`.
- `MacIntel + maxTouchPoints>1` is gated behind `IS_TAURI_MOBILE` first, so a real
  desktop never enters the tablet branch.
- No build-time/SSR signal exists; default false until the first client render
  (same pattern as `useIsMobile`'s `readInitial`).
- Add a tiny unit test for the detection matrix (pure function over UA/platform/
  screen) — this is the one piece you CAN test without a device.

---

## 6. Capability matrix — `src/platform/index.ts:102-119`

```ts
export const CAPABILITIES = {
  embeddedTerminal: IS_TAURI_DESKTOP,                 // UNCHANGED — desktop only

  // Browser is available on all desktop (the Windows child-webview path is
  // hardened by the parallel stability effort) AND on tablets (native plugin
  // backend). Phones get nothing.
  embeddedBrowserPanel: IS_TAURI_DESKTOP || IS_TABLET,
  // Which backend the panel uses — desktop child webview vs tablet native
  // plugin. They are NOT interchangeable; webPanel.ts / RightRail branch on this.
  embeddedBrowserDesktop: IS_TAURI_DESKTOP,
  embeddedBrowserTablet: IS_TABLET,
  // …rest unchanged
} as const;
```

- The capability is `IS_TAURI_DESKTOP || IS_TABLET`.
- Existing consumers keep working: `webPanel.ts` early-returns to the system
  browser when `!embeddedBrowserPanel`; `RightRail` tab list (~`RightRail.tsx:221-226`)
  pushes the Browser tab when `embeddedBrowserPanel`; `App.tsx` demotes `railTab`
  to outline when the cap is off. The Browser tab auto-appears on tablet for free.

---

## 8. Native plugin specs

### 8a. iOS — Swift `WKWebView` subview
- Hold one `WKWebView` (lazy). Config: `customUserAgent = <iPhone UA>`;
  `WKWebViewConfiguration.websiteDataStore = .nonPersistent()` when
  `persistSession == false`.
- `open`: if absent, create; `addSubview` onto the Tauri view controller's root
  view (the same `UIView` hosting the Tauri WKWebView); `webView.frame =
  CGRect(x, y, width, height)` from bounds (points; see §8c); `load(URLRequest)`.
  Bring to front.
- `setBounds`: update `webView.frame`. `hide`: `webView.isHidden = true` (keep).
  `close`: `removeFromSuperview()` + release.
- `back/forward/reload`: `goBack()`/`goForward()`/`reload()`.
- Nav state: implement `WKNavigationDelegate` —
  `didStartProvisionalNavigation` → emit `web-panel-nav { loading:true }`;
  `didCommit` / `didFinish` → emit `{ url: webView.url, loading:false,
  canGoBack: webView.canGoBack, canGoForward: webView.canGoForward }`;
  `didFail*` → emit `{ error }`. Use the plugin's event/channel API to reach JS.
- Respect safe areas: the bounds JS sends already reflect the laid-out host rect
  (which honors `var(--shiori-safe-*)`), so the frame is correct as given. On
  rotation, JS fires resize → `setBounds` again; no extra work.
- Keyboard/scroll: allow the WKWebView's own scrolling; don't intercept.

### 8b. Android — Kotlin `android.webkit.WebView` child
- Hold one `WebView`. `settings.javaScriptEnabled = true`;
  `settings.userAgentString = <iPhone UA>`; `settings.domStorageEnabled = true`.
  Incognito: when `persistSession == false`, disable persistent cookies
  (`CookieManager.setAcceptCookie(false)` / clear) + `clearCache(true)` — note in
  docs that Android WebView lacks true incognito.
- `open`: if absent, create; add to the Activity root `FrameLayout` (the parent
  of the Tauri WebView) with `FrameLayout.LayoutParams(width, height)` +
  `leftMargin/topMargin = x/y` (physical px; see §8c); `loadUrl(url)`; bring to
  front (`bringToFront()` / proper z-order).
- `setBounds`: update `layoutParams`. `hide`: `visibility = View.GONE` (keep).
  `close`: remove from parent + `destroy()`.
- `back/forward/reload`: `goBack()`/`goForward()`/`reload()`; gate on
  `canGoBack()/canGoForward()`.
- Nav state: `webViewClient = object : WebViewClient() { onPageStarted →
  loading:true; onPageFinished / doUpdateVisitedHistory → url + canGoBack/Forward;
  onReceivedError → error }`. Emit `web-panel-nav` via the plugin channel.
- Lifecycle: pause/resume the WebView with the Activity; ensure it's destroyed on
  app teardown so it doesn't leak (mirror the desktop teardown the stability
  effort is adding).

### 8c. Coordinate-system gotcha (do not skip)
JS bounds are **CSS logical px**. The Tauri mobile WebView renders at the
device's CSS viewport.
- **iOS:** UIKit `frame` is in **points**. For the Tauri WKWebView the CSS px ↔
  point mapping is ~1:1 (the web viewport maps to the view's point size).
  Position the subview in the **same coordinate space** as the Tauri WebView's
  view; if you add it to the same superview, `frame = {x,y,w,h}` in points works
  directly. Validate on a Retina iPad — if you see a 2× offset, you're mixing
  points and pixels.
- **Android:** `View` layout is in **physical px**. Multiply CSS px by
  `resources.displayMetrics.density` (== JS `window.devicePixelRatio`) before
  setting `LayoutParams`. A common bug is forgetting the density multiply → the
  browser renders at 1/density size in the top-left.
- Add a 1-line log of the received vs applied rect during bring-up; remove before
  shipping.

---

## 9. Security isolation (keep the discipline)
- The native WKWebView / Android WebView is **not a Tauri webview** — it has **no
  IPC bridge injected**, so remote pages inherit **zero** Shiori commands. That is
  the posture you want. **Do not** inject any JS bridge, message handler, or
  `@JavascriptInterface` that exposes app capability to the remote page.
- Keep `capabilities/mobile.json` scoped `"webviews": ["main"]` (NOT `"windows"`)
  — same rule as `default.json`. The 2026-05-30 POSTMORTEM root-cause #4 is that a
  `"windows":` match grants commands to *every* webview of the window; a label
  scope keeps the remote content unprivileged. Your native view isn't even a
  labeled webview, so it's outside the ACL entirely — document that explicitly so
  a future reader doesn't "fix" the missing scope.
- Only the **plugin's own** commands go in `mobile.json` permissions.

---

## 10. QA reality
- **No automation.** WKWebView/Android WebView cannot be driven by WebDriver/CDP
  (POSTMORTEM 2026-05-30 root-cause #7; tauri-driver doesn't support this).
  Verification is **manual, on physical devices** — a real iPad and a real Android
  tablet.
- **Layered verification** (what you can do without a device):
  - Unit test the `IS_TABLET/IS_PHONE` detection matrix.
  - `bun run build` + `bun run lint` green.
  - Rust: `. "$HOME/.cargo/env" && bun run tauri build` compiles for desktop
    (proves the mobile arms didn't break the shared signatures) — and the
    iOS/Android targets compile via the Tauri mobile build.
  - ACL check: grep the built capability schema to confirm the remote view has no
    Shiori command scope.
- **On-device manual checklist:** Browser tab appears on tablet (not phone, not
  desktop-phone-width edge), follows rail geometry on scroll/resize/rotate, hides
  under every modal (Settings/Export/shortcuts/find/print/go-to-page), survives
  tab switches without reload, address bar + back/forward/reload + loading work,
  narrow-rail layout (iPhone UA) fits without horizontal scroll, no touch-eating
  over the document, clean teardown on app exit (no leaked WebView / black view).

---

## 11. Risks & fallback
- **Native-subview-into-Tauri's-view-tree is the key unknown.** Tauri owns the
  Activity/ViewController; adding a sibling native web view requires reaching the
  host view from the plugin. Validate **first** on each platform with a trivial
  colored `UIView`/`View` pinned to a rect before wiring the whole protocol —
  de-risk the "can I even add a sibling view at the right z-order and rect" question
  on day one.
- If the subview approach proves infeasible on a platform, the documented fallback
  for THAT platform only is full-screen (SFSafariViewController / Custom Tabs via
  `tauri-plugin-in-app-browser`) with the address-bar/nav UI hidden — a maintainer
  decision, since it diverges from the in-rail UX. Android Custom Tabs
  additionally can't be closed programmatically or report close — a real UX cost.
- Tauri may ship native multi-webview upstream (#11794) and obviate the whole
  plugin; track the issue.

---

## 14. External references
- Tauri 2 — Develop a Plugin: https://v2.tauri.app/develop/plugins/
- Tauri 2 — Mobile Plugin Development (Swift/Kotlin):
  https://v2.tauri.app/develop/plugins/develop-mobile/
- Tauri 2 — Mobile Multi-Window (why multi-webview-in-window is impossible):
  https://v2.tauri.app/learn/mobile-multiwindow/
- Feasibility evidence issues: tauri#11794, tauri#11528, wry#1580 (links in §2).
- Apple `WKWebView` / `WKNavigationDelegate`; Android `WebView` / `WebViewClient`
  official docs.
- Reference plugin (full-screen fallback only):
  https://crates.io/crates/tauri-plugin-in-app-browser

---

## 15. Acceptance criteria
1. Browser tab present + functional on iPad + Android tablet; absent on phones;
   unchanged on desktop.
2. In-rail split: native view tracks the rail rect on scroll/resize/rotate;
   hides under every modal and on tab-away (page survives, no reload).
3. Address bar + back/forward/reload + loading/nav-state work via `web-panel-nav`.
4. Narrow-rail layout fits (iPhone UA); no horizontal overflow; no touch-eating.
5. Terminal remains desktop-only; phones get neither feature.
6. Remote pages have zero Shiori command access (ACL verified).
7. Clean teardown on app exit — no leaked native web view / black surface.
8. `bun run build` + `bun run lint` green; desktop + mobile Tauri builds compile.
9. Detection unit test passes; POSTMORTEM added if a notable pitfall surfaced.

---

## 16. Implementation status (2026-06-14)

Phases 2–4 implemented; the whole native plugin is written and the Rust layer
is gate-green. On-device QA (Phase 5, §10) is the remaining owed work.

**Landed (`tauri-plugin-shiori-browser`, mobile-only path dep):**
- Rust: `src/{lib,mobile,desktop,models,error}.rs`. `init()` registers the
  Swift/Kotlin class and manages `ShioriBrowser<R>`; `ShioriBrowserExt` exposes
  `app.shiori_browser()`. The 8 ops forward to native via `run_mobile_plugin`.
- iOS: `ios/Sources/ShioriBrowserPlugin.swift` — `WKWebView` subview of the
  Tauri webview's superview, frame in points relative to the Tauri webview's
  origin, non-persistent data store when `!persistSession`, `WKNavigationDelegate`
  drives a lock-guarded nav snapshot.
- Android: `android/.../ShioriBrowserPlugin.kt` — `WebView` child of the content
  `FrameLayout`, layout in `px = css × density`, `WebViewClient` drives the
  snapshot; best-effort incognito (no true incognito on Android — documented).
- App wiring: `Cargo.toml` path dep, one `#[cfg(mobile)] .plugin(...)` line in
  `run()`, the 8 `#[cfg(mobile)] web_panel_*` arms rewritten to forward (UA from
  `WEB_PANEL_USER_AGENT`), `capabilities/mobile.json` description updated.

**Key decisions (see POSTMORTEMS 2026-06-14):**
- **Nav events delivered by poll, not push.** A Rust-created `Channel` can't be
  registered for native→Rust send (`register_channel` is `pub(crate)`, JS-channel
  only) and the frozen frontend passes no channel down. So the native delegate
  keeps a snapshot and a 150ms visible-only Rust poll re-emits the byte-identical
  `web-panel-nav`. Contract unchanged; only transport differs.
- **No JS command surface / no ACL entry.** The plugin is Rust-driven, so per §9
  it has no `mobile.json` permission; the rationale is in the capability
  `description` so nobody "fixes" the missing scope. (Deviates from the original plan's "add
  its permission" step, which assumed a JS-command plugin.)

**Gates green:** `cargo check --target aarch64-linux-android` ✓,
`--target aarch64-apple-ios` ✓ (both compile the plugin + the mobile arms),
`bun run build` ✓, `bun run lint` ✓.

**Open:** on-device QA (§10) on a real iPad and Android tablet; a full
`tauri ios build` / `tauri android build` compiles the Swift/Kotlin, which
headless checks do not.
