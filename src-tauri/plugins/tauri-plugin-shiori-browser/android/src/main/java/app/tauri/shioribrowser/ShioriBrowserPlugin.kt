// Android native backend for Shiori's in-rail embedded browser.
//
// A single android.webkit.WebView is added as a child of the Activity's root
// content FrameLayout (the parent of the Tauri WebView) and layout-positioned
// to track the rail rect the React side measures. It is a plain WebView, NOT a
// Tauri webview: no @JavascriptInterface / bridge is injected, so remote pages
// inherit zero Shiori commands (§9).
//
// Nav state is kept in a lock-guarded snapshot updated by the WebViewClient and
// read by `navState` (which the Rust side polls and re-emits as `web-panel-nav`).

package app.tauri.shioribrowser

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class BoundsArg {
    var x: Double = 0.0
    var y: Double = 0.0
    var width: Double = 0.0
    var height: Double = 0.0
}

@InvokeArg
class OpenArgs {
    lateinit var url: String
    var bounds: BoundsArg? = null
    var persistSession: Boolean? = null
    var userAgent: String? = null
}

@InvokeArg
class NavigateArgs {
    lateinit var url: String
}

@InvokeArg
class SetBoundsArgs {
    lateinit var bounds: BoundsArg
}

private const val TEMP_PROFILE_PREFIX = "shiori-browser-temporary"
// Matched by BrowserPanel.tsx, which tells the user why the panel stayed empty.
private const val TEMPORARY_UNSUPPORTED = "web-panel-temporary-unsupported"

@TauriPlugin
class ShioriBrowserPlugin(private val activity: Activity) : Plugin(activity) {
    private var webView: WebView? = null
    private var tauriWebView: WebView? = null
    private var currentPersist = true
    private var tempProfile: String? = null
    private var tempProfilesSwept = false

    private val density: Float
        get() = activity.resources.displayMetrics.density

    // Nav snapshot, guarded by navLock; read by the Rust poll via navState.
    private val navLock = Any()
    private var navUrl: String? = null
    private var navLoading = false
    private var navCanGoBack = false
    private var navCanGoForward = false
    private var navError: String? = null

    override fun load(webView: WebView) {
        this.tauriWebView = webView
    }

    // Every temporary session gets a profile no earlier session used. A
    // reused profile cannot be emptied: removeAllCookies is asynchronous
    // (the next loadUrl can still send the old cookies), deleteAllData
    // leaves CacheStorage and service workers, and deleteProfile refuses a
    // profile this process has loaded. Profiles left by earlier runs are not
    // loaded yet, so the first temporary session of a run deletes them;
    // those used earlier in this run stay on disk until the next run.
    private fun newTempProfile(): String {
        val store = ProfileStore.getInstance()
        if (!tempProfilesSwept) {
            tempProfilesSwept = true
            store.allProfileNames
                .filter { it.startsWith(TEMP_PROFILE_PREFIX) }
                .forEach { name ->
                    try {
                        store.deleteProfile(name)
                    } catch (_: Exception) {
                        // In use; the next run deletes it.
                    }
                }
        }
        val name = "$TEMP_PROFILE_PREFIX-${System.currentTimeMillis()}"
        store.getOrCreateProfile(name)
        tempProfile = name
        return name
    }

    // Best effort: empties the closed session's profile until the next run
    // deletes it.
    private fun clearTempProfile() {
        val name = tempProfile ?: return
        tempProfile = null
        try {
            val profile = ProfileStore.getInstance().getProfile(name) ?: return
            profile.cookieManager.removeAllCookies(null)
            profile.webStorage.deleteAllData()
        } catch (_: Exception) {
            // The next run deletes the profile anyway.
        }
    }

    private fun host(): ViewGroup? {
        (tauriWebView?.parent as? ViewGroup)?.let { return it }
        return activity.findViewById(android.R.id.content)
    }

    private fun ensureWebView(persist: Boolean, userAgent: String?): WebView {
        val existing = webView
        if (existing != null && currentPersist == persist) {
            userAgent?.let { existing.settings.userAgentString = it }
            return existing
        }
        existing?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.destroy()
            if (!currentPersist) clearTempProfile()
        }
        val wv = WebView(activity)
        // A temporary session gets its own fresh WebView profile (see
        // newTempProfile): cookies, site storage and cache apart from the
        // persistent one and from earlier temporary sessions.
        // CookieManager.getInstance() is process-global, so the old approach
        // (refuse and delete every cookie) erased the persistent logins,
        // blocked all sign-ins, and left localStorage/IndexedDB shared.
        // setProfile must precede any other use of the view. `open` refuses a
        // temporary session without MULTI_PROFILE, so the check here is only
        // a guard.
        val isolated = !persist && WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
        if (isolated) {
            WebViewCompat.setProfile(wv, newTempProfile())
        }
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        userAgent?.let { wv.settings.userAgentString = it }
        wv.webViewClient = navClient
        wv.webChromeClient = WebChromeClient()
        if (isolated) {
            wv.clearCache(true)
        }
        // Earlier builds switched cookies off process-wide for a temporary
        // session; make sure they are on.
        CookieManager.getInstance().setAcceptCookie(true)
        host()?.addView(wv, FrameLayout.LayoutParams(1, 1))
        webView = wv
        currentPersist = persist
        return wv
    }

    // CSS logical px → physical px (× density), offset by the Tauri WebView's
    // position so we stay aligned (§8c). Forgetting the density multiply renders
    // the view at 1/density size in the corner — the classic Android bug.
    private fun layoutParams(b: BoundsArg): FrameLayout.LayoutParams {
        val d = density
        val lp = FrameLayout.LayoutParams(
            (b.width * d).toInt().coerceAtLeast(1),
            (b.height * d).toInt().coerceAtLeast(1)
        )
        lp.leftMargin = (b.x * d).toInt() + (tauriWebView?.left ?: 0)
        lp.topMargin = (b.y * d).toInt() + (tauriWebView?.top ?: 0)
        return lp
    }

    @Command
    fun open(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        val persist = args.persistSession ?: true
        // Without MULTI_PROFILE a temporary session could only run in the
        // shared default profile: the saved logins would show up in it and
        // whatever it stores would outlive it. Refuse it and let the panel
        // say so, rather than quietly breaking the setting's promise.
        if (!persist && !WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            invoke.reject(TEMPORARY_UNSUPPORTED)
            return
        }
        activity.runOnUiThread {
            val wv = ensureWebView(persist, args.userAgent)
            args.bounds?.let { wv.layoutParams = layoutParams(it) }
            wv.visibility = View.VISIBLE
            wv.bringToFront()
            wv.loadUrl(args.url)
            updateNav(loading = true, url = args.url, error = null, wv = wv)
        }
        invoke.resolve()
    }

    @Command
    fun navigate(invoke: Invoke) {
        val args = invoke.parseArgs(NavigateArgs::class.java)
        activity.runOnUiThread {
            val wv = webView ?: return@runOnUiThread
            wv.loadUrl(args.url)
            updateNav(loading = true, url = args.url, error = null, wv = wv)
        }
        invoke.resolve()
    }

    @Command
    fun setBounds(invoke: Invoke) {
        val args = invoke.parseArgs(SetBoundsArgs::class.java)
        activity.runOnUiThread {
            val wv = webView ?: return@runOnUiThread
            wv.layoutParams = layoutParams(args.bounds)
            wv.visibility = View.VISIBLE
            wv.bringToFront()
        }
        invoke.resolve()
    }

    @Command
    fun hide(invoke: Invoke) {
        activity.runOnUiThread { webView?.visibility = View.GONE }
        invoke.resolve()
    }

    @Command
    fun back(invoke: Invoke) {
        activity.runOnUiThread { webView?.let { if (it.canGoBack()) it.goBack() } }
        invoke.resolve()
    }

    @Command
    fun forward(invoke: Invoke) {
        activity.runOnUiThread { webView?.let { if (it.canGoForward()) it.goForward() } }
        invoke.resolve()
    }

    @Command
    fun reload(invoke: Invoke) {
        activity.runOnUiThread { webView?.reload() }
        invoke.resolve()
    }

    @Command
    fun close(invoke: Invoke) {
        activity.runOnUiThread {
            webView?.let {
                (it.parent as? ViewGroup)?.removeView(it)
                it.stopLoading()
                it.destroy()
                if (!currentPersist) clearTempProfile()
            }
            webView = null
        }
        synchronized(navLock) {
            navUrl = null
            navLoading = false
            navCanGoBack = false
            navCanGoForward = false
            navError = null
        }
        invoke.resolve()
    }

    @Command
    fun navState(invoke: Invoke) {
        val ret = JSObject()
        synchronized(navLock) {
            navUrl?.let { ret.put("url", it) }
            ret.put("loading", navLoading)
            ret.put("canGoBack", navCanGoBack)
            ret.put("canGoForward", navCanGoForward)
            navError?.let { ret.put("error", it) }
        }
        invoke.resolve(ret)
    }

    private fun updateNav(loading: Boolean, url: String?, error: String?, wv: WebView?) {
        synchronized(navLock) {
            navLoading = loading
            if (url != null) navUrl = url else if (wv != null) navUrl = wv.url ?: navUrl
            navError = error
            if (wv != null) {
                navCanGoBack = wv.canGoBack()
                navCanGoForward = wv.canGoForward()
            }
        }
    }

    private val navClient = object : WebViewClient() {
        // Gate in-page navigation to web content only, mirroring the desktop
        // panel's on_navigation allowlist (src-tauri/src/lib.rs parse_web_url,
        // which accepts only http/https). Without this a link/redirect to file:
        // could read local files inside the panel, and intent:/custom app schemes
        // could deep-link out of Shiori. http(s) + content schemes load in-view;
        // communication schemes hand off to the system; everything else (file:,
        // intent:, app schemes) is refused.
        override fun shouldOverrideUrlLoading(
            view: WebView?,
            request: WebResourceRequest?
        ): Boolean {
            val url = request?.url ?: return false
            return when (url.scheme?.lowercase()) {
                "http", "https", "about", "blob", "data" -> false // let WebView load it
                "mailto", "tel", "sms", "smsto", "geo" -> {
                    try {
                        activity.startActivity(Intent(Intent.ACTION_VIEW, url))
                    } catch (_: Exception) {
                        // No handler installed — drop silently, same as desktop.
                    }
                    true // handled; don't load in the WebView
                }
                else -> true // file:, intent:, app schemes — refuse
            }
        }

        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            updateNav(loading = true, url = url, error = null, wv = view)
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            updateNav(loading = false, url = url, error = null, wv = view)
        }

        override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) {
            // History changed (SPA navigations, back/forward) — refresh url +
            // canGoBack/Forward without touching the loading flag.
            updateNav(loading = navLoading, url = url, error = null, wv = view)
        }

        override fun onReceivedError(
            view: WebView?,
            request: WebResourceRequest?,
            error: WebResourceError?
        ) {
            // Only main-frame errors reach the address bar; sub-resource failures
            // are noise.
            if (request?.isForMainFrame == true) {
                updateNav(
                    loading = false,
                    url = null,
                    error = error?.description?.toString() ?: "load error",
                    wv = view
                )
            }
        }
    }
}
