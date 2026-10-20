// iOS native backend for Shiori's in-rail embedded browser.
//
// A single WKWebView is added as a SUBVIEW of the Tauri webview's superview
// (the view controller's root view) and frame-positioned to track the rail
// rect the React side measures. It is a plain WKWebView, NOT a Tauri webview:
// it has no IPC bridge, so remote pages inherit zero Shiori commands (§9).
//
// Nav state is kept in a lock-guarded snapshot updated by the WKNavigationDelegate
// and read by `navState` (which the Rust side polls and re-emits as
// `web-panel-nav`). See `src/mobile.rs` for why polling rather than a push channel.

import Tauri
import UIKit
import WebKit

struct Bounds: Decodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct OpenArgs: Decodable {
  let url: String
  let bounds: Bounds?
  let persistSession: Bool?
  let userAgent: String?
}

struct NavigateArgs: Decodable {
  let url: String
}

struct BoundsArgs: Decodable {
  let bounds: Bounds
}

struct ShareFileArgs: Decodable {
  let path: String
  let filename: String?
  let mime: String?
}

struct ShareFileResult: Encodable {
  let completed: Bool
}

// Encodable mirror of the frozen `web-panel-nav` payload.
struct NavStatePayload: Encodable {
  let url: String?
  let loading: Bool
  let canGoBack: Bool
  let canGoForward: Bool
  let error: String?
}

private struct NavSnapshot {
  var url: String? = nil
  var loading: Bool = false
  var canGoBack: Bool = false
  var canGoForward: Bool = false
  var error: String? = nil
}

class ShioriBrowserPlugin: Plugin, WKNavigationDelegate, WKUIDelegate {
  // Fallback only — Rust always passes the canonical UA (WEB_PANEL_USER_AGENT).
  static let defaultUserAgent =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

  private var webView: WKWebView?
  private weak var tauriWebView: WKWebView?
  private var currentPersist = true

  private let navLock = NSLock()
  private var nav = NavSnapshot()

  // Tauri hands us the main webview here; we position relative to it so the
  // mapping stays correct under status-bar / safe-area insets.
  override func load(webview: WKWebView) {
    self.tauriWebView = webview
  }

  private func hostView() -> UIView? {
    return self.tauriWebView?.superview ?? self.manager.viewController?.view
  }

  // CSS logical px → UIKit points. For the Tauri webview the mapping is ~1:1;
  // we offset by the Tauri webview's origin so insets don't shift us (§8c).
  private func frame(from b: Bounds) -> CGRect {
    let ox = self.tauriWebView?.frame.minX ?? 0
    let oy = self.tauriWebView?.frame.minY ?? 0
    return CGRect(
      x: ox + CGFloat(b.x),
      y: oy + CGFloat(b.y),
      width: max(1, CGFloat(b.width)),
      height: max(1, CGFloat(b.height)))
  }

  private func ensureWebView(persistSession: Bool, userAgent: String?) -> WKWebView {
    if let existing = self.webView, self.currentPersist == persistSession {
      if let ua = userAgent { existing.customUserAgent = ua }
      return existing
    }
    // First creation, or the session mode changed (persist <-> incognito), which
    // requires a fresh data store — recreate, mirroring desktop's recreate path.
    self.webView?.removeFromSuperview()
    let config = WKWebViewConfiguration()
    if !persistSession {
      config.websiteDataStore = .nonPersistent()
    }
    let wv = WKWebView(frame: .zero, configuration: config)
    wv.navigationDelegate = self
    wv.uiDelegate = self
    wv.customUserAgent = userAgent ?? Self.defaultUserAgent
    wv.allowsBackForwardNavigationGestures = true
    if #available(iOS 11.0, *) {
      wv.scrollView.contentInsetAdjustmentBehavior = .never
    }
    self.hostView()?.addSubview(wv)
    self.webView = wv
    self.currentPersist = persistSession
    return wv
  }

  @objc public func open(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)
    DispatchQueue.main.async {
      let wv = self.ensureWebView(persistSession: args.persistSession ?? true, userAgent: args.userAgent)
      if let b = args.bounds {
        wv.frame = self.frame(from: b)
        #if DEBUG
          print("[shiori-browser] open frame=\(wv.frame)")
        #endif
      }
      wv.isHidden = false
      self.hostView()?.bringSubviewToFront(wv)
      if let url = URL(string: args.url) {
        wv.load(URLRequest(url: url))
      }
      self.updateNav(loading: true, url: args.url, error: nil, from: wv)
    }
    invoke.resolve()
  }

  @objc public func navigate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(NavigateArgs.self)
    DispatchQueue.main.async {
      guard let wv = self.webView else { return }
      if let url = URL(string: args.url) {
        wv.load(URLRequest(url: url))
      }
      self.updateNav(loading: true, url: args.url, error: nil, from: wv)
    }
    invoke.resolve()
  }

  @objc public func setBounds(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(BoundsArgs.self)
    DispatchQueue.main.async {
      guard let wv = self.webView else { return }
      wv.frame = self.frame(from: args.bounds)
      wv.isHidden = false
      self.hostView()?.bringSubviewToFront(wv)
    }
    invoke.resolve()
  }

  @objc public func hide(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.webView?.isHidden = true
    }
    invoke.resolve()
  }

  @objc public func back(_ invoke: Invoke) {
    DispatchQueue.main.async { self.webView?.goBack() }
    invoke.resolve()
  }

  @objc public func forward(_ invoke: Invoke) {
    DispatchQueue.main.async { self.webView?.goForward() }
    invoke.resolve()
  }

  @objc public func reload(_ invoke: Invoke) {
    DispatchQueue.main.async { self.webView?.reload() }
    invoke.resolve()
  }

  // Present the system share sheet for an exported file. This is unrelated to
  // the embedded browser, but the plugin is already Shiori's iOS-native bridge,
  // so exports route through it rather than the opener plugin —
  // UIApplication.open on a scheme-less file path silently no-ops, which used
  // to make the JS side report a false success and strand the file in cache.
  @objc public func shareFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareFileArgs.self)
    DispatchQueue.main.async {
      guard let presenter = self.manager.viewController else {
        invoke.reject("no-view-controller")
        return
      }
      let fileURL = URL(fileURLWithPath: args.path)
      let activityVC = UIActivityViewController(
        activityItems: [fileURL], applicationActivities: nil)
      // Resolve only when the user finishes with the sheet, reporting whether
      // they actually completed an activity — so the JS side marks the export
      // "done" only on a real share, not when the sheet is merely shown or
      // dismissed without sharing.
      activityVC.completionWithItemsHandler = { _, completed, _, error in
        if let error = error {
          invoke.reject(error.localizedDescription)
        } else {
          invoke.resolve(ShareFileResult(completed: completed))
        }
      }
      // On iPad the share sheet is a popover and UIKit crashes without an
      // anchor; pin it to the center of the host view.
      if let popover = activityVC.popoverPresentationController {
        popover.sourceView = presenter.view
        popover.sourceRect = CGRect(
          x: presenter.view.bounds.midX, y: presenter.view.bounds.midY,
          width: 0, height: 0)
        popover.permittedArrowDirections = []
      }
      presenter.present(activityVC, animated: true, completion: nil)
    }
  }

  @objc public func close(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.webView?.stopLoading()
      self.webView?.removeFromSuperview()
      self.webView = nil
    }
    self.navLock.lock()
    self.nav = NavSnapshot()
    self.navLock.unlock()
    invoke.resolve()
  }

  @objc public func navState(_ invoke: Invoke) {
    self.navLock.lock()
    let snap = self.nav
    self.navLock.unlock()
    invoke.resolve(
      NavStatePayload(
        url: snap.url,
        loading: snap.loading,
        canGoBack: snap.canGoBack,
        canGoForward: snap.canGoForward,
        error: snap.error))
  }

  // Always called on the main thread (delegate callbacks + the command blocks),
  // so reading the WKWebView's nav properties here is safe.
  private func updateNav(loading: Bool, url: String?, error: String?, from wv: WKWebView?) {
    self.navLock.lock()
    self.nav.loading = loading
    if let url = url {
      self.nav.url = url
    } else if let live = wv?.url?.absoluteString {
      self.nav.url = live
    }
    self.nav.error = error
    if let wv = wv {
      self.nav.canGoBack = wv.canGoBack
      self.nav.canGoForward = wv.canGoForward
    }
    self.navLock.unlock()
  }

  // MARK: - WKNavigationDelegate

  // Gate in-page navigation to web content only, mirroring the desktop panel's
  // on_navigation allowlist (src-tauri/src/lib.rs `parse_web_url`, which accepts
  // only http/https). Without this a link or script redirect to `file:` could
  // read local files inside the panel, and `tel:`/custom app schemes could
  // deep-link out of Shiori. http(s) + WebKit-internal/content schemes proceed;
  // communication schemes hand off to the system opener; everything else (file:,
  // javascript:, app schemes) is refused outright.
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
      decisionHandler(.allow)
      return
    }
    switch scheme {
    case "http", "https", "about", "blob", "data":
      decisionHandler(.allow)
    case "mailto", "tel", "sms", "facetime", "facetime-audio", "maps":
      decisionHandler(.cancel)
      DispatchQueue.main.async { UIApplication.shared.open(url) }
    default:
      decisionHandler(.cancel)
    }
  }

  // MARK: - WKUIDelegate

  // target="_blank" links and window.open ask for a new web view. With no UI
  // delegate WebKit drops them and the tap does nothing; the panel has one
  // view, so load the request there. The load passes decidePolicyFor above,
  // so the scheme gate still applies.
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if navigationAction.targetFrame == nil {
      webView.load(navigationAction.request)
    }
    return nil
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    updateNav(loading: true, url: nil, error: nil, from: webView)
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    updateNav(loading: true, url: webView.url?.absoluteString, error: nil, from: webView)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    updateNav(loading: false, url: webView.url?.absoluteString, error: nil, from: webView)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    updateNav(loading: false, url: nil, error: error.localizedDescription, from: webView)
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error
  ) {
    updateNav(loading: false, url: nil, error: error.localizedDescription, from: webView)
  }
}

@_cdecl("init_plugin_shiori_browser")
func initPlugin() -> Plugin {
  return ShioriBrowserPlugin()
}
