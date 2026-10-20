// Native window chrome: the desktop application menu (built here, its custom
// items forwarded to the main webview as `menu:*` events) and the reader-mode
// immersive toggle, which only iOS implements natively.

#[cfg(not(mobile))]
use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
};
#[cfg(not(mobile))]
use tauri::AppHandle;
use tauri::{Runtime, Webview};

#[cfg(not(mobile))]
use crate::emit_to_main;
use crate::enforce_main_webview;

// Reader-mode immersive toggle for iOS/iPadOS: the status bar and home
// indicator are owned by tao's root view controller, which responds to the
// same `setPrefersStatusBarHidden:` / `setPrefersHomeIndicatorAutoHidden:`
// selectors its window-builder attributes use (tao 0.34 platform_impl/ios).
// UIKit requires appearance updates on the main thread. Android goes through
// the ShioriAndroid JS bridge instead (MainActivity.kt); desktop needs no
// call, so everywhere else this is a no-op that keeps the invoke contract.
#[tauri::command]
#[specta::specta]
#[cfg(target_os = "ios")]
pub(crate) fn set_reader_immersive<R: Runtime>(
    caller: Webview<R>,
    window: tauri::Window<R>,
    enabled: bool,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            use objc::runtime::{Object, BOOL, NO, YES};
            use objc::{msg_send, sel, sel_impl};
            use raw_window_handle::{HasWindowHandle, RawWindowHandle};
            let Ok(handle) = target.window_handle() else {
                return;
            };
            let RawWindowHandle::UiKit(uikit) = handle.as_raw() else {
                return;
            };
            let Some(view_controller) = uikit.ui_view_controller else {
                return;
            };
            let view_controller = view_controller.as_ptr() as *mut Object;
            let flag: BOOL = if enabled { YES } else { NO };
            unsafe {
                let _: () = msg_send![view_controller, setPrefersStatusBarHidden: flag];
                let _: () = msg_send![view_controller, setPrefersHomeIndicatorAutoHidden: flag];
            }
        })
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(target_os = "ios"))]
pub(crate) fn set_reader_immersive<R: Runtime>(
    caller: Webview<R>,
    _enabled: bool,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Ok(())
}

// Language for the custom native-menu labels. Tauri/muda has no menu
// i18n, and the in-app i18next preference lives in the webview's
// localStorage — unreadable from here, and the menu is built before any
// frontend JS runs. So the custom items follow the *OS* language, like
// the system-injected menu entries (Services, Enter Full Screen, …) do.
// zh/ja wording mirrors src/i18n/locales/{zh,ja}.json.
#[cfg(not(mobile))]
#[derive(Clone, Copy)]
enum MenuLanguage {
    English,
    Chinese,
    Japanese,
}

#[cfg(not(mobile))]
fn menu_label(
    lang: MenuLanguage,
    en: &'static str,
    zh: &'static str,
    ja: &'static str,
) -> &'static str {
    match lang {
        MenuLanguage::English => en,
        MenuLanguage::Chinese => zh,
        MenuLanguage::Japanese => ja,
    }
}

#[cfg(not(mobile))]
fn system_menu_language() -> MenuLanguage {
    // `defaults` ships with every macOS; AppleLanguages is the ordered
    // preference list Cocoa itself localizes app menus from. One
    // subprocess read at startup beats pulling in a locale crate.
    // On Windows/Linux `defaults` does not exist, so the spawn fails and
    // we fall back to English below — the menu is English there for now.
    let output = std::process::Command::new("defaults")
        .args(["read", "-g", "AppleLanguages"])
        .output();
    let raw = match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => return MenuLanguage::English,
    };
    // Output is an old-style plist array, e.g. `(\n    "zh-Hans-CN",\n…`.
    // The first entry is the top preference; quotes are omitted for bare
    // codes like `en` that older systems stored.
    let first = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && *line != "(" && *line != ")")
        .unwrap_or("")
        .trim_end_matches(',')
        .trim_matches('"')
        .to_ascii_lowercase();
    if first.starts_with("zh") {
        MenuLanguage::Chinese
    } else if first.starts_with("ja") {
        MenuLanguage::Japanese
    } else {
        MenuLanguage::English
    }
}

// Tauri 2 ships no default application menu. On macOS, without this the
// system bar shows only the bare-minimum "Shiori → Quit Shiori" fallback;
// on Windows/Linux there is no window menu bar at all. We construct the
// standard menu (App / File / Edit / View / Window) ourselves for every
// desktop platform. The macOS-only app-menu items (Services / Hide / Hide
// Others / Show All) are pushed under a `#[cfg(target_os = "macos")]`
// block in the app submenu below, so Windows/Linux get the same menus
// minus those Cocoa-specific entries. Custom items (Check for Updates,
// Settings, Zoom) emit Tauri events back to the webview, where `App.tsx`
// listens and triggers the same store actions the in-app buttons /
// shortcuts already drive. The OS routes accelerator key presses straight
// to the menu so no double-handling vs. the existing Cmd+= / Cmd+-
// keyboard handlers in `Canvas.tsx`.
#[cfg(not(mobile))]
pub(crate) fn build_app_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<Menu<R>> {
    let lang = system_menu_language();

    let about = AboutMetadata {
        name: Some("Shiori".to_string()),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        copyright: Some("© 2026 Zexi Zhang".to_string()),
        ..Default::default()
    };

    // Built as a boxed vec (rather than a fixed slice) so the macOS-only
    // predefined items can be pushed under a cfg block: Services / Hide /
    // Hide Others / Show All are Cocoa app-menu conventions that only make
    // sense — and are only wired up by muda — on macOS. Everything before
    // and after that block (About / Check for Updates / Settings / Quit and
    // their separators) is shared, so Windows/Linux get a clean app menu
    // with no dangling macOS-only entries or doubled separators.
    let mut app_items: Vec<Box<dyn IsMenuItem<R>>> = vec![
        Box::new(PredefinedMenuItem::about(
            app,
            Some(menu_label(
                lang,
                "About Shiori",
                "关于 Shiori",
                "Shiori について",
            )),
            Some(about),
        )?),
        Box::new(PredefinedMenuItem::separator(app)?),
        Box::new(MenuItem::with_id(
            app,
            "menu-check-for-updates",
            menu_label(
                lang,
                "Check for Updates…",
                "检查更新…",
                "アップデートを確認…",
            ),
            true,
            None::<&str>,
        )?),
        Box::new(PredefinedMenuItem::separator(app)?),
        Box::new(MenuItem::with_id(
            app,
            "menu-settings",
            menu_label(lang, "Settings…", "设置…", "設定…"),
            true,
            Some("CmdOrCtrl+,"),
        )?),
        Box::new(PredefinedMenuItem::separator(app)?),
    ];
    // macOS-only app-menu items. Skipped on Windows/Linux, where these
    // predefined items are macOS conventions with no cross-platform analogue.
    #[cfg(target_os = "macos")]
    {
        app_items.push(Box::new(PredefinedMenuItem::services(app, None)?));
        app_items.push(Box::new(PredefinedMenuItem::separator(app)?));
        app_items.push(Box::new(PredefinedMenuItem::hide(app, None)?));
        app_items.push(Box::new(PredefinedMenuItem::hide_others(app, None)?));
        app_items.push(Box::new(PredefinedMenuItem::show_all(app, None)?));
        app_items.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    app_items.push(Box::new(PredefinedMenuItem::quit(app, None)?));
    let app_submenu = Submenu::with_items(
        app,
        "Shiori",
        true,
        &app_items.iter().map(Box::as_ref).collect::<Vec<_>>(),
    )?;

    let file_submenu = Submenu::with_items(
        app,
        // The menu ITEMS were all localized while their titles stayed literal, so
        // a Chinese or Japanese macOS showed an English menu bar over fully
        // translated menus — the mixed-language bar the 2026-06-10 postmortem
        // set out to remove. Cocoa does not localize app-supplied NSMenu
        // titles, so they have to go through menu_label like everything else.
        menu_label(lang, "File", "文件", "ファイル"),
        true,
        &[&MenuItem::with_id(
            app,
            "menu-print",
            menu_label(lang, "Print…", "打印…", "印刷…"),
            true,
            Some("CmdOrCtrl+P"),
        )?],
    )?;

    let edit_submenu = Submenu::with_items(
        app,
        menu_label(lang, "Edit", "编辑", "編集"),
        true,
        &[
            // NOT PredefinedMenuItem::undo/redo: those claim ⌘Z/⇧⌘Z at
            // the macOS key-equivalent layer and route them as native
            // WKWebView *text* undo, so the webview keydown handler
            // (Canvas.tsx) never sees the keys and the document undo
            // stack is unreachable from the keyboard. Custom items emit
            // menu:undo / menu:redo events; App.tsx dispatches them to
            // the store, falling back to text undo inside inputs.
            &MenuItem::with_id(
                app,
                "menu-undo",
                menu_label(lang, "Undo", "撤销", "取り消し"),
                true,
                Some("CmdOrCtrl+Z"),
            )?,
            &MenuItem::with_id(
                app,
                "menu-redo",
                menu_label(lang, "Redo", "重做", "やり直し"),
                true,
                Some("Shift+CmdOrCtrl+Z"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            // Cut and Paste stay predefined; only Copy and Select All are
            // custom. The predefined items claim ⌘C/⌘V/⌘A at the macOS
            // key-equivalent layer, so the webview keydown (Canvas.tsx) never
            // sees them — which is why annotation copy/paste/select-all were
            // unreachable from the keyboard. Copy and Select All can be custom
            // safely: execCommand('copy'/'selectAll') faithfully reproduces the
            // native text behavior (Copy even still fires the text layer's
            // semantic-copy handler). Paste CANNOT be made custom — suppressing
            // the native `paste` event breaks both text-input paste
            // (clipboard.readText from a menu callback lacks user activation)
            // AND the window `paste` handler that handles the in-app annotation
            // clipboard first, then turns a clipboard image into a PDF page
            // (useAppShortcuts.ts). So Paste (and Cut, which has no annotation
            // analogue) stay native; the DOM paste event supplies the macOS
            // annotation path without breaking text or image paste.
            &PredefinedMenuItem::cut(app, None)?,
            &MenuItem::with_id(
                app,
                "menu-copy",
                menu_label(lang, "Copy", "复制", "コピー"),
                true,
                Some("CmdOrCtrl+C"),
            )?,
            &PredefinedMenuItem::paste(app, None)?,
            &MenuItem::with_id(
                app,
                "menu-select-all",
                menu_label(lang, "Select All", "全选", "すべて選択"),
                true,
                Some("CmdOrCtrl+A"),
            )?,
        ],
    )?;

    let view_submenu = Submenu::with_items(
        app,
        menu_label(lang, "View", "显示", "表示"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "menu-zoom-in",
                menu_label(lang, "Zoom In", "放大", "ズームイン"),
                true,
                Some("CmdOrCtrl+="),
            )?,
            &MenuItem::with_id(
                app,
                "menu-zoom-out",
                menu_label(lang, "Zoom Out", "缩小", "ズームアウト"),
                true,
                Some("CmdOrCtrl+-"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "menu-actual-size",
                menu_label(lang, "Actual Size", "实际大小", "実際のサイズ"),
                true,
                Some("CmdOrCtrl+1"),
            )?,
            &MenuItem::with_id(
                app,
                "menu-fit-width",
                menu_label(lang, "Fit Width", "适应宽度", "幅に合わせる"),
                true,
                Some("CmdOrCtrl+0"),
            )?,
        ],
    )?;

    // Tauri recognizes this reserved id and registers the submenu as
    // NSApplication.windowsMenu on macOS. AppKit only supplies the system
    // Move & Resize commands (and their Fn-Control shortcuts) to a registered
    // Window menu; matching the visible title alone is not enough.
    let window_submenu = Submenu::with_id_and_items(
        app,
        tauri::menu::WINDOW_SUBMENU_ID,
        menu_label(lang, "Window", "窗口", "ウインドウ"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &window_submenu,
        ],
    )
}

#[cfg(not(mobile))]
pub(crate) fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    // Custom menu items emit a Tauri event the frontend listens
    // for (see `App.tsx`). Predefined items (Hide, Quit, Cut, etc.)
    // are handled by Tauri / Cocoa directly and never reach this
    // callback.
    let channel = match event.id().as_ref() {
        "menu-check-for-updates" => "menu:check-for-updates",
        "menu-settings" => "menu:settings",
        "menu-undo" => "menu:undo",
        "menu-redo" => "menu:redo",
        "menu-copy" => "menu:copy",
        "menu-select-all" => "menu:select-all",
        "menu-print" => "menu:print",
        "menu-zoom-in" => "menu:zoom-in",
        "menu-zoom-out" => "menu:zoom-out",
        "menu-actual-size" => "menu:actual-size",
        "menu-fit-width" => "menu:fit-width",
        _ => return,
    };
    let _ = emit_to_main(app, channel, ());
}
