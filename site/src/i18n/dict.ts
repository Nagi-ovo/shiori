// Three coherent language modes for the public homepage.
//
// EN is English-only aside from the 栞 brand mark. ZH and JA are pure
// single-language. Strings echo src/i18n/locales/{en,zh,ja}.json from the
// main app so the site reads in the same voice.
//
// `subKana` and `quoteKana` are intentionally string | null — the
// component renders nothing when null so layout collapses cleanly in
// pure-language modes.

export type Lang = "en" | "zh" | "ja";
export const SUPPORTED_LANGS: readonly Lang[] = ["en", "zh", "ja"] as const;

export type Dict = {
  // brand + nav
  brandKana: string;
  navFeatures: string;
  navSpecs: string;
  navDownload: string;
  navCta: string;
  // Accessible names and tooltips for the interaction shell. These bypassed
  // the dictionary entirely, so zh/ja visitors heard the whole chrome in
  // English through a screen reader — and the language picker's own tooltip,
  // the one control those visitors most need, said "Language".
  a11yDisplayPrefs: string;
  a11yThemeToLight: string;
  a11yThemeToDark: string;
  a11yLanguage: string;
  a11yGithubReleases: string;
  a11yMenu: string;
  a11yPageNav: string;
  a11yPage: string;
  a11ySkip: string;
  documentTitleHome: string;
  documentTitleChangelog: string;
  documentTitleShortcuts: string;
  documentTitlePrivacy: string;
  documentTitleSupport: string;
  navExport: string;

  // window mock
  metaPp: string;
  metaLocal: string;
  thumbsHeader: string;
  thumbsTotal: string;
  toolSelect: string;
  toolHighlight: string;
  toolInk: string;
  toolStamp: string;
  toolRect: string;
  toolNote: string;
  toolText: string;
  hintSelect: string;
  hintThumb: string;

  // hero scripted demo
  demoStatus0Reading: string;
  demoStatus1Highlight: string;
  demoStatus2Note: string;
  demoStatus3Ink: string;
  demoStatus4Export: string;
  demoNoteText: string;

  // hero
  heroEyebrow: string;
  heroLine1: string;
  heroLine2: string;
  heroAccent: string;
  heroFocus: string;
  heroSubKana: string | null;
  heroLede: string;
  heroCtaPrimary: string;
  heroCtaMacIntel: string;
  heroCtaWindows: string;
  heroCtaLinux: string;
  heroCtaAndroid: string;
  heroCtaOptions: string;
  heroCtaSecondary: string;
  heroCheckSize: string;
  heroCheckLocal: string;
  heroCheckOffline: string;

  // manifesto
  manifestoKicker: string;
  manifestoTitle: ReadonlyArray<string | { em: string }>;
  manifestoSide: string;
  manifestoP1: string;
  manifestoP1Kana: string | null;
  manifestoP2: string;
  manifestoP2Kana: string | null;
  manifestoP3: string;
  manifestoQuote: string;
  manifestoQuoteSrc: string;

  // features
  featuresKicker: string;
  featuresTitle: ReadonlyArray<string | { em: string }>;
  feat1Num: string;
  feat1Title: string;
  feat1Kana: string | null;
  feat1Body: ReadonlyArray<string | { code: string }>;
  feat1Local: string;
  feat1Cloud: string;
  feat1Telemetry: string;
  feat1Never: string;
  feat2Num: string;
  feat2Title: string;
  feat2Kana: string | null;
  feat2Body: string;
  feat3Num: string;
  feat3Title: string;
  feat3Kana: string | null;
  feat3Body: string;
  feat3Opt1: string;
  feat3Opt2: string;
  feat3Opt3: string;
  feat3Opt4: string;

  // CLI preview
  cliPreviewKicker: string;
  cliPreviewTitle: ReadonlyArray<string | { em: string }>;
  cliPreviewBody: string;
  cliInstallUnixLabel: string;
  cliInstallWindowsLabel: string;
  cliCopy: string;
  cliCopied: string;
  cliCopyFailed: string;
  cliMethodCurl: string;
  cliMethodPowershell: string;
  cliMethodNpm: string;
  a11yCopyUnixInstall: string;
  a11yCopyWindowsInstall: string;
  a11yCopyNpmInstall: string;
  a11yInstallMethods: string;
  cliQuoteLine1: string;
  cliQuoteLine2: string;
  cliTerminalTitle: string;
  cliTerminalTagline: string;
  cliProgressLabel: string;
  cliPhaseResolving: string;
  cliPhaseDownloading: string;
  cliPhaseVerifying: string;
  cliPhaseExtracting: string;
  cliPhaseLinking: string;
  cliPhaseComplete: string;
  cliRunHint: string;

  // specs
  specsKicker: string;
  specsTitle: ReadonlyArray<string | { em: string }>;
  s1K: string;
  s1Sub: string;
  s2K: string;
  s2Sub: string;
  s3K: string;
  s3Sub: string;
  s4K: string;
  s4Sub: string;

  // cta
  ctaTitle: string;
  ctaKana: string[] | null;
  ctaBody: string;
  ctaC1: string;
  ctaC2: string;
  ctaC3: string;
  dlMacSilicon: string;
  dlMacIntel: string;
  dlWindows: string;
  dlLinuxAppImage: string;
  dlLinuxDeb: string;
  dlAndroidPlay: string;
  dlAndroidApk: string;
  dlIosIpad: string;
  dlDownload: string;
  dlOpen: string;
  dlComingSoon: string;
  dlRecommended: string;
  dlForYourMac: string;
  dlTotal: string;

  // footer
  footerColophon: string;
  footerColophonKana: string | null;
  footerProduct: string;
  footerChangelog: string;
  footerResources: string;
  footerKeymap: string;
  footerPrivacy: string;
  footerSupport: string;
  footerTagline: string;
  footerPrivacyShort: string;

  // doc subpages (changelog, shortcuts)
  docBack: string;
  changelogKicker: string;
  changelogTitle: ReadonlyArray<string | { em: string }>;
  changelogLede: string;
  shortcutsKicker: string;
  shortcutsTitle: ReadonlyArray<string | { em: string }>;
  shortcutsLede: string;

  // privacy section
  privacyKicker: string;
  privacyTitle: ReadonlyArray<string | { em: string }>;
  privacyLede: string;
  privacyKeep: string;
  privacyKeepBody: string;
  privacyKnow: string;
  privacyKnowBody: string;
  privacyUpdate: string;
  privacyUpdateBody: string;
  privacyContact: string;
  privacyContactBody: string;
};

export const DICT: Record<Lang, Dict> = {
  en: {
    brandKana: "",
    navFeatures: "Features",
    navSpecs: "Specs",
    navDownload: "Download",
    navCta: "Download",
    a11yDisplayPrefs: "Display preferences",
    a11yThemeToLight: "Switch to light mode",
    a11yThemeToDark: "Switch to dark mode",
    a11yLanguage: "Language",
    a11yGithubReleases: "GitHub releases",
    a11yMenu: "Menu",
    a11yPageNav: "Page navigation",
    a11yPage: "Page {n}",
    a11ySkip: "Skip to content",
    documentTitleHome:
      "Shiori — Read, annotate, and deliver everything you read, quietly.",
    documentTitleChangelog: "Changelog — Shiori",
    documentTitleShortcuts: "Shortcuts — Shiori",
    documentTitlePrivacy: "Privacy — Shiori",
    documentTitleSupport: "Support — Shiori",
    navExport: "Export",

    metaPp: "PP",
    metaLocal: "LOCAL",
    thumbsHeader: "PAGES",
    thumbsTotal: "TOTAL",
    toolSelect: "Select",
    toolHighlight: "Highlight",
    toolInk: "Ink",
    toolStamp: "Stamp",
    toolRect: "Rect",
    toolNote: "Note",
    toolText: "Text",
    hintSelect:
      "Click an annotation to edit · Shift-click to multi-select · Drag to move · ⌘+drag to duplicate",
    hintThumb: "Page thumbnail focused — ⌘+drag to duplicate",

    demoStatus0Reading: "Reading welcome.pdf · pp 1 / 3",
    demoStatus1Highlight: "Highlight · drag selection",
    demoStatus2Note: "Note · pinned to margin",
    demoStatus3Ink: "Ink · stroke saved",
    demoStatus4Export: "Ready to flatten · ⌘E",
    demoNoteText: "key claim — check footnote 3",

    heroEyebrow: "Local-first, in beta",
    heroLine1: "Read, annotate, and deliver",
    heroLine2: "",
    heroAccent: "everything you read — quietly.",
    heroFocus: "everything",
    heroSubKana: null,
    heroLede:
      "Every page renders and every stroke stays on your machine. No sign-in, no telemetry, no cloud upload — just the document, the tools, and the time to think.",
    heroCtaPrimary: "Download for macOS",
    heroCtaMacIntel: "Download macOS Universal",
    heroCtaWindows: "Download for Windows",
    heroCtaLinux: "Download Linux AppImage",
    heroCtaAndroid: "Download Android APK",
    heroCtaOptions: "View download options",
    heroCtaSecondary: "Try in browser →",
    heroCheckSize: "200 MB / 500 page beta cap",
    heroCheckLocal: "Files stay on this machine",
    heroCheckOffline: "No sign-in",

    manifestoKicker: "— 01 / Manifesto",
    manifestoTitle: [
      "Software, like paper,\nshould keep its mouth ",
      { em: "shut" },
      ".",
    ],
    manifestoSide: "A quieter tool",
    manifestoP1: "The PDF you are reading does not need to phone anyone.",
    manifestoP1Kana: null,
    manifestoP2:
      "Your highlights are not training data. They are bookmarks — slips of paper, tucked into a page.",
    manifestoP2Kana: null,
    manifestoP3:
      "Annotation should feel like writing in the margin of a borrowed book — careful, considered, yours alone.",
    manifestoQuote:
      "“Between the page and the world, a bookmark.”",
    manifestoQuoteSrc:
      "— Shiori · the first-page note",

    featuresKicker: "— 02 / Features",
    featuresTitle: ["Three small promises,\nkept ", { em: "locally" }, "."],
    feat1Num: "01 — STORAGE",
    feat1Title: "Lives on your disk.",
    feat1Kana: null,
    feat1Body: [
      "Documents, strokes, and recents are written to a single folder you can ",
      { code: "cp -r" },
      " and back up like any other file.",
    ],
    feat1Local: "local",
    feat1Cloud: "cloud sync",
    feat1Telemetry: "telemetry",
    feat1Never: "— never",
    feat2Num: "02 — ANNOTATE",
    feat2Title: "Tools. No menus.",
    feat2Kana: null,
    feat2Body:
      "Highlight, ink, stamp, rectangle, note, text — each one keyboard-bound, each one undoable, none of them clever.",
    feat3Num: "03 — EXPORT",
    feat3Title: "Ships flat or whole.",
    feat3Kana: null,
    feat3Body:
      "Flatten your annotations into the source PDF, or export them as a sidecar JSON for review tools that already exist.",
    feat3Opt1: "Flattened, ready to send",
    feat3Opt2: "Layered, editable later",
    feat3Opt3: "Annotations only — sidecar",
    feat3Opt4: "Single page, current zoom",

    cliPreviewKicker: "— INTERLUDE / CLI",
    cliPreviewTitle: ["A new way to meet\nyour ", { em: "documents" }, "."],
    cliPreviewBody:
      "Open, search, and annotate from a terminal, and script all of it.",
    cliInstallUnixLabel: "macOS / Linux",
    cliInstallWindowsLabel: "Windows",
    cliCopy: "Copy",
    cliCopied: "Copied",
    cliCopyFailed: "Copy failed",
    cliMethodCurl: "curl",
    cliMethodPowershell: "PowerShell",
    cliMethodNpm: "npm",
    a11yCopyUnixInstall: "Copy the macOS and Linux install command",
    a11yCopyWindowsInstall: "Copy the Windows install command",
    a11yCopyNpmInstall: "Copy the npm install command",
    a11yInstallMethods: "Installation method",
    cliQuoteLine1: "What do “ordinary” and",
    cliQuoteLine2: "“taken for granted” really mean?",
    cliTerminalTitle: "shiori — installer",
    cliTerminalTagline: "Local documents. Agent-ready.",
    cliProgressLabel: "Installing Shiori CLI",
    cliPhaseResolving: "Resolving release",
    cliPhaseDownloading: "Downloading Shiori CLI for darwin-arm64",
    cliPhaseVerifying: "Verifying archive digest",
    cliPhaseExtracting: "Extracting self-contained package",
    cliPhaseLinking: "Linking shiori into PATH",
    cliPhaseComplete: "complete",
    cliRunHint: "Run it with:",

    specsKicker: "— 03 / Specs",
    specsTitle: [
      "Numbers, where they\nactually ",
      { em: "matter" },
      ".",
    ],
    s1K: "RUNTIME",
    s1Sub: "cold open · M-series",
    s2K: "DISK",
    s2Sub: "app + assets, signed",
    s3K: "PRIVACY",
    s3Sub: "telemetry · analytics",
    s4K: "FORMATS",
    s4Sub: "in & out",

    ctaTitle: "Download the current beta.",
    ctaKana: null,
    ctaBody:
      "Free during beta. Desktop builds and the direct Android APK are available now; Google Play and the iOS / iPadOS App Store build are coming soon.",
    ctaC1: "Signed & notarized",
    ctaC2: "Desktop auto-updates",
    ctaC3: "Annotations stored as plain JSON",
    dlMacSilicon: "macOS · Apple Silicon",
    dlMacIntel: "macOS · Universal",
    dlWindows: "Windows",
    dlLinuxAppImage: "Linux · AppImage",
    dlLinuxDeb: "Linux · Debian / Ubuntu",
    dlAndroidPlay: "Android · Google Play",
    dlAndroidApk: "Android · APK",
    dlIosIpad: "iOS / iPadOS · App Store",
    dlDownload: "DOWNLOAD",
    dlOpen: "OPEN",
    dlComingSoon: "COMING SOON",
    dlRecommended: "RECOMMENDED",
    dlForYourMac: "recommended for this device",
    dlTotal: "{n} downloads to date",

    footerColophon:
      "Set in Instrument Serif, Klee One, and JetBrains Mono. A vibe born between two long PDFs, one Tuesday.",
    footerColophonKana: null,
    footerProduct: "Product",
    footerChangelog: "Changelog",
    footerResources: "Resources",
    footerKeymap: "Shortcuts",
    footerPrivacy: "Privacy",
    footerSupport: "Support",
    footerTagline: "Keep reading, even when you get lost.",
    footerPrivacyShort: "NO TELEMETRY · LOCAL ONLY",

    docBack: "← Back to home",
    changelogKicker: "— RELEASES",
    changelogTitle: [
      "What we've been ",
      { em: "quietly" },
      " fixing.",
    ],
    changelogLede:
      "Every release since 0.1.0, in plain English. Same notes the desktop app shows.",
    shortcutsKicker: "— SHORTCUTS",
    shortcutsTitle: [
      "Every key, on a ",
      { em: "single" },
      " page.",
    ],
    shortcutsLede:
      "The same list the desktop app shows when you press ⌘ ? — pinned here so you can print it.",

    privacyKicker: "— 04 / PRIVACY",
    privacyTitle: [
      "One page,\n",
      { em: "no fine print" },
      ".",
    ],
    privacyLede:
      "Shiori runs entirely on your machine. No account, no telemetry, no analytics, no third-party scripts.",
    privacyKeep: "What stays on disk",
    privacyKeepBody:
      "The PDFs you open, the annotations you make, your last-opened list, your theme and language. They live in the app data folder on your device — Application Support/Shiori on a Mac, the equivalent on Windows, Linux, and phones — yours to back up, copy, or delete.",
    privacyKnow: "What this site sees",
    privacyKnowBody:
      "Your IP address when your browser fetches this homepage from our static host, the same as any website. We don't store it, log it, or share it.",
    privacyUpdate: "Updates",
    privacyUpdateBody:
      "The desktop app may check GitHub once on launch for a new release.",
    privacyContact: "Questions",
    privacyContactBody:
      "Drop into Discord https://discord.gg/G5uzmAaHY. There is no mailing list to join, and nothing to subscribe to.",
  },

  zh: {
    brandKana: "栞",
    navFeatures: "特性",
    navSpecs: "数据",
    navDownload: "下载",
    navCta: "下载",
    a11yDisplayPrefs: "显示偏好",
    a11yThemeToLight: "切换到浅色模式",
    a11yThemeToDark: "切换到深色模式",
    a11yLanguage: "语言",
    a11yGithubReleases: "GitHub 发布页",
    a11yMenu: "菜单",
    a11yPageNav: "页面导航",
    a11yPage: "第 {n} 屏",
    a11ySkip: "跳到正文",
    documentTitleHome: "Shiori 栞 — 本地阅读、批注、交出你读过的每一页。",
    documentTitleChangelog: "更新日志 — Shiori",
    documentTitleShortcuts: "快捷键 — Shiori",
    documentTitlePrivacy: "隐私 — Shiori",
    documentTitleSupport: "支持 — Shiori",
    navExport: "导出",

    metaPp: "页",
    metaLocal: "本地",
    thumbsHeader: "页面",
    thumbsTotal: "页",
    toolSelect: "选择",
    toolHighlight: "高亮",
    toolInk: "墨笔",
    toolStamp: "印章",
    toolRect: "矩形",
    toolNote: "便签",
    toolText: "文字",
    hintSelect:
      "点击批注以编辑 · Shift 多选 · 拖动以移动 · ⌘+拖动以复制",
    hintThumb: "页面缩略图已聚焦 — ⌘+拖动可复制",

    demoStatus0Reading: "正在阅读 welcome.pdf · 第 1 / 3 页",
    demoStatus1Highlight: "高亮 · 拖动选择文字",
    demoStatus2Note: "便签 · 已贴到页边",
    demoStatus3Ink: "墨笔 · 笔触已保存",
    demoStatus4Export: "准备压平 · ⌘E",
    demoNoteText: "核心论点 — 查脚注 3",

    heroEyebrow: "本地优先，公测中",
    heroLine1: "更安静地读、批注、",
    heroLine2: "",
    heroAccent: "交付你读到的一切。",
    heroFocus: "一切",
    heroSubKana: null,
    heroLede:
      "每一页的渲染与每一笔，都只留在你的机器上。无需登录、无遥测、不上传云端 — 只剩下文档、工具，和思考的时间。",
    heroCtaPrimary: "下载 macOS 版",
    heroCtaMacIntel: "下载 macOS 通用版",
    heroCtaWindows: "下载 Windows 版",
    heroCtaLinux: "下载 Linux AppImage",
    heroCtaAndroid: "下载 Android APK",
    heroCtaOptions: "查看下载选项",
    heroCtaSecondary: "在浏览器中试试 →",
    heroCheckSize: "公测限制：200 MB / 500 页",
    heroCheckLocal: "文件留在本机",
    heroCheckOffline: "不用登录",

    manifestoKicker: "— 01 / 宣言",
    manifestoTitle: ["软件应当像纸一样，", { em: "沉默" }, "。"],
    manifestoSide: "一件更安静的工具",
    manifestoP1: "你正在读的 PDF，不需要给任何人打电话。",
    manifestoP1Kana: null,
    manifestoP2: "你画下的高亮不是训练数据。它们只是书签 — 像夹进书页里的纸条。",
    manifestoP2Kana: null,
    manifestoP3: "做批注，应当像在借来的书页边写字 — 谨慎、克制、只属于你自己。",
    manifestoQuote: "「在书与现实之间，留一枚栞。」",
    manifestoQuoteSrc: "—— 栞 · 写在第一页",

    featuresKicker: "— 02 / 特性",
    featuresTitle: ["三件小小的承诺，\n只在", { em: "本地" }, "兑现。"],
    feat1Num: "01 — 存储",
    feat1Title: "住在你的硬盘里。",
    feat1Kana: null,
    feat1Body: [
      "文档、笔触、最近打开记录，全部写入一个你可以 ",
      { code: "cp -r" },
      " 备份的文件夹。",
    ],
    feat1Local: "本地",
    feat1Cloud: "云同步",
    feat1Telemetry: "遥测",
    feat1Never: "— 从不",
    feat2Num: "02 — 批注",
    feat2Title: "工具在手，没有菜单。",
    feat2Kana: null,
    feat2Body:
      "高亮、墨笔、印章、矩形、便签、文字 — 每件都绑定快捷键，每件都可撤销，没一件耍小聪明。",
    feat3Num: "03 — 导出",
    feat3Title: "可压平，也可保留。",
    feat3Kana: null,
    feat3Body:
      "把批注压平回 PDF，或者另存为 sidecar JSON，给已有的审阅工具继续用。",
    feat3Opt1: "压平，可直接发送",
    feat3Opt2: "分层，日后可再编辑",
    feat3Opt3: "仅批注 — sidecar",
    feat3Opt4: "单页，当前缩放",

    cliPreviewKicker: "— 幕间 / CLI",
    cliPreviewTitle: ["让文档，\n从", { em: "终端" }, "里开口。"],
    cliPreviewBody:
      "打开、检索、批注，都能写进脚本。",
    cliInstallUnixLabel: "macOS / Linux",
    cliInstallWindowsLabel: "Windows",
    cliCopy: "复制",
    cliCopied: "已复制",
    cliCopyFailed: "复制失败",
    cliMethodCurl: "curl",
    cliMethodPowershell: "PowerShell",
    cliMethodNpm: "npm",
    a11yCopyUnixInstall: "复制 macOS 与 Linux 的安装命令",
    a11yCopyWindowsInstall: "复制 Windows 的安装命令",
    a11yCopyNpmInstall: "复制 npm 安装命令",
    a11yInstallMethods: "安装方式",
    cliQuoteLine1: "“普通”和“理所当然”",
    cliQuoteLine2: "究竟是什么呢？",
    cliTerminalTitle: "shiori — 安装程序",
    cliTerminalTagline: "本地文档。给 agent 用。",
    cliProgressLabel: "正在安装 Shiori CLI",
    cliPhaseResolving: "解析发布",
    cliPhaseDownloading: "正在下载 darwin-arm64 版 Shiori CLI",
    cliPhaseVerifying: "正在校验归档摘要",
    cliPhaseExtracting: "正在解出自包含包",
    cliPhaseLinking: "正在把 shiori 链到 PATH",
    cliPhaseComplete: "完成",
    cliRunHint: "运行：",

    specsKicker: "— 03 / 数据",
    specsTitle: ["把数字，\n放在", { em: "真正重要" }, "的地方。"],
    s1K: "启动 · RUNTIME",
    s1Sub: "冷启动 · M 系列",
    s2K: "容量 · DISK",
    s2Sub: "应用 + 资源，已签名",
    s3K: "通信 · PRIVACY",
    s3Sub: "遥测 · 分析",
    s4K: "格式 · FORMATS",
    s4Sub: "输入 & 输出",

    ctaTitle: "下载当前公测版。",
    ctaKana: null,
    ctaBody:
      "公测期间免费。桌面端与 Android 直接安装 APK 现在可下载；Google Play 版和 iOS / iPadOS 的 App Store 版敬请期待。",
    ctaC1: "已签名 & 公证",
    ctaC2: "桌面端自动更新",
    ctaC3: "批注以普通 JSON 存储",
    dlMacSilicon: "macOS · Apple Silicon",
    dlMacIntel: "macOS · 通用版",
    dlWindows: "Windows",
    dlLinuxAppImage: "Linux · AppImage",
    dlLinuxDeb: "Linux · Debian / Ubuntu",
    dlAndroidPlay: "Android · Google Play",
    dlAndroidApk: "Android · APK",
    dlIosIpad: "iOS / iPadOS · App Store",
    dlDownload: "下载",
    dlOpen: "打开",
    dlComingSoon: "敬请期待",
    dlRecommended: "推荐",
    dlForYourMac: "适合当前设备",
    dlTotal: "累计下载 {n} 次",

    footerColophon:
      "字体取自 Instrument Serif、Klee One 与 JetBrains Mono。某个周二，诞生于两份长 PDF 间歇的 vibe。",
    footerColophonKana: null,
    footerProduct: "产品",
    footerChangelog: "更新记录",
    footerResources: "资源",
    footerKeymap: "快捷键",
    footerPrivacy: "隐私",
    footerSupport: "支持",
    footerTagline: "就算迷路了，也继续读下去。",
    footerPrivacyShort: "无遥测 · 仅本地",

    docBack: "← 回首页",
    changelogKicker: "— 更新记录",
    changelogTitle: ["每一次小小的", { em: "更新" }, "。"],
    changelogLede:
      "0.1.0 以来的所有版本，写成人话。和桌面应用里看到的是同一份。",
    shortcutsKicker: "— 快捷键",
    shortcutsTitle: ["所有按键，", { em: "一页看完" }, "。"],
    shortcutsLede:
      "应用内按 ⌘ ? 看到的同一张表，单页排好，方便打印或贴在桌边。",

    privacyKicker: "— 04 / 隐私",
    privacyTitle: [
      "一页讲完，",
      { em: "没有附加条款" },
      "。",
    ],
    privacyLede:
      "Shiori 完全在你的机器上运行。没有账号，没有遥测，没有分析，没有第三方脚本。",
    privacyKeep: "留在你硬盘里的",
    privacyKeepBody:
      "你打开过的 PDF、你做的批注、最近打开的列表、主题与语言偏好。它们在设备上的应用数据目录里——Mac 是 Application Support/Shiori，Windows、Linux 和手机也有对应位置——可以自由备份、复制或删除。",
    privacyKnow: "本网站看到的",
    privacyKnowBody:
      "你的浏览器从我们的静态主机获取首页时的 IP 地址，和访问任何网站一样。我们不存储、不记录、不共享。",
    privacyUpdate: "更新",
    privacyUpdateBody:
      "桌面应用启动时可能向 GitHub 查询一次新版本。",
    privacyContact: "联系",
    privacyContactBody:
      "Discord：https://discord.gg/G5uzmAaHY。没有邮件列表，也没有什么可订阅的。",
  },

  ja: {
    brandKana: "しおり",
    navFeatures: "機能",
    navSpecs: "スペック",
    navDownload: "ダウンロード",
    navCta: "ダウンロード",
    a11yDisplayPrefs: "表示設定",
    a11yThemeToLight: "ライトモードに切り替え",
    a11yThemeToDark: "ダークモードに切り替え",
    a11yLanguage: "言語",
    a11yGithubReleases: "GitHub リリース",
    a11yMenu: "メニュー",
    a11yPageNav: "ページナビゲーション",
    a11yPage: "{n} ページ目",
    a11ySkip: "本文へスキップ",
    documentTitleHome: "Shiori 栞 — 読んだものを、静かに注釈して渡す。",
    documentTitleChangelog: "更新履歴 — Shiori",
    documentTitleShortcuts: "ショートカット — Shiori",
    documentTitlePrivacy: "プライバシー — Shiori",
    documentTitleSupport: "サポート — Shiori",
    navExport: "書き出し",

    metaPp: "ページ",
    metaLocal: "ローカル",
    thumbsHeader: "ページ",
    thumbsTotal: "ページ",
    toolSelect: "選択",
    toolHighlight: "ハイライト",
    toolInk: "ペン",
    toolStamp: "スタンプ",
    toolRect: "矩形",
    toolNote: "付箋",
    toolText: "テキスト",
    hintSelect:
      "クリックで編集 · Shift クリックで複数選択 · ドラッグで移動 · ⌘+ドラッグで複製",
    hintThumb: "ページサムネイル選択中 — ⌘+ドラッグで複製",

    demoStatus0Reading: "welcome.pdf を閲覧 · 1 / 3 ページ",
    demoStatus1Highlight: "ハイライト · ドラッグで選択",
    demoStatus2Note: "付箋 · 余白に貼付",
    demoStatus3Ink: "ペン · ストローク保存",
    demoStatus4Export: "書き出し可 · ⌘E",
    demoNoteText: "重要な主張 — 脚注 3 を確認",

    heroEyebrow: "ローカルファースト、ベータ版",
    heroLine1: "読むものすべてを、",
    heroLine2: "",
    heroAccent: "静かに読み、注釈し、届ける。",
    heroFocus: "すべて",
    heroSubKana: null,
    heroLede:
      "ページのレンダリングも、ひと筆ひと筆も、すべてあなたのマシンの中に。サインイン不要、テレメトリなし、クラウドへのアップロードなし — ただ文書と道具と、考える時間だけ。",
    heroCtaPrimary: "macOS 版をダウンロード",
    heroCtaMacIntel: "macOS Universal 版をダウンロード",
    heroCtaWindows: "Windows 版をダウンロード",
    heroCtaLinux: "Linux AppImage をダウンロード",
    heroCtaAndroid: "Android APK をダウンロード",
    heroCtaOptions: "ダウンロード一覧を見る",
    heroCtaSecondary: "ブラウザで試す →",
    heroCheckSize: "ベータ制限 200 MB / 500 ページ",
    heroCheckLocal: "ファイルは端末に残る",
    heroCheckOffline: "ログイン不要",

    manifestoKicker: "— 01 / マニフェスト",
    manifestoTitle: [
      "ソフトウェアも紙のように、\n口を",
      { em: "閉じている" },
      "べきだ。",
    ],
    manifestoSide: "もっと静かな道具",
    manifestoP1: "読んでいる PDF は、誰にも電話をかけなくていい。",
    manifestoP1Kana: null,
    manifestoP2: "あなたのハイライトは、訓練データではない。ただの栞だ。",
    manifestoP2Kana: null,
    manifestoP3:
      "注釈は、借りた本の余白に書き込むように — 慎重に、控えめに、自分だけのものとして。",
    manifestoQuote: "「本と現実のあいだに、栞を一枚。」",
    manifestoQuoteSrc: "—— 栞 · 最初のページに",

    featuresKicker: "— 02 / 機能",
    featuresTitle: [
      "三つの小さな約束を、\n",
      { em: "ローカル" },
      "で守る。",
    ],
    feat1Num: "01 — ストレージ",
    feat1Title: "あなたのディスクに住む。",
    feat1Kana: null,
    feat1Body: [
      "文書も筆跡も最近開いた履歴も、すべて一つのフォルダに書き込まれる — ",
      { code: "cp -r" },
      " でそのままバックアップできる。",
    ],
    feat1Local: "ローカル",
    feat1Cloud: "クラウド同期",
    feat1Telemetry: "テレメトリ",
    feat1Never: "— 一切なし",
    feat2Num: "02 — 注釈",
    feat2Title: "道具だけ。メニューは要らない。",
    feat2Kana: null,
    feat2Body:
      "ハイライト、ペン、スタンプ、矩形、付箋、テキスト — それぞれにキーが割り当てられ、どれも取り消せて、どれも余計な賢さを持たない。",
    feat3Num: "03 — 書き出し",
    feat3Title: "焼いて出すか、生のまま渡すか。",
    feat3Kana: null,
    feat3Body:
      "注釈を PDF に焼き込むか、既存のレビューツール向けにサイドカー JSON として書き出すか。",
    feat3Opt1: "フラット化、すぐ送れる",
    feat3Opt2: "レイヤー保持、後で編集可",
    feat3Opt3: "注釈のみ — サイドカー",
    feat3Opt4: "単ページ、現在のズーム",

    cliPreviewKicker: "— 幕間 / CLI",
    cliPreviewTitle: ["文書と出会う、\nもう一つの", { em: "入口" }, "。"],
    cliPreviewBody:
      "ターミナルで開き、検索し、注釈する。スクリプトにもできる。",
    cliInstallUnixLabel: "macOS / Linux",
    cliInstallWindowsLabel: "Windows",
    cliCopy: "コピー",
    cliCopied: "コピー済み",
    cliCopyFailed: "コピーできません",
    cliMethodCurl: "curl",
    cliMethodPowershell: "PowerShell",
    cliMethodNpm: "npm",
    a11yCopyUnixInstall: "macOS と Linux のインストールコマンドをコピー",
    a11yCopyWindowsInstall: "Windows のインストールコマンドをコピー",
    a11yCopyNpmInstall: "npm のインストールコマンドをコピー",
    a11yInstallMethods: "インストール方法",
    cliQuoteLine1: "“普通”とか“あたりまえ”って",
    cliQuoteLine2: "なんだろう",
    cliTerminalTitle: "shiori — インストーラー",
    cliTerminalTagline: "ローカル文書。エージェント向け。",
    cliProgressLabel: "Shiori CLI をインストール中",
    cliPhaseResolving: "リリースを解決",
    cliPhaseDownloading: "darwin-arm64 向け Shiori CLI をダウンロード",
    cliPhaseVerifying: "アーカイブのダイジェストを検証",
    cliPhaseExtracting: "自己完結パッケージを展開",
    cliPhaseLinking: "shiori を PATH にリンク",
    cliPhaseComplete: "完了",
    cliRunHint: "実行：",

    specsKicker: "— 03 / スペック",
    specsTitle: [
      "数字は、\n",
      { em: "本当に効く" },
      "場所に。",
    ],
    s1K: "起動 · RUNTIME",
    s1Sub: "コールドオープン · M シリーズ",
    s2K: "容量 · DISK",
    s2Sub: "アプリ + 資源、署名済み",
    s3K: "通信 · PRIVACY",
    s3Sub: "テレメトリ · 解析",
    s4K: "形式 · FORMATS",
    s4Sub: "入出力",

    ctaTitle: "現在のベータ版をダウンロード。",
    ctaKana: null,
    ctaBody:
      "ベータ期間中は無料。デスクトップ版と直接インストール用 Android APK は現在ダウンロードできます。Google Play 版と iOS / iPadOS の App Store 版は近日公開です。",
    ctaC1: "署名 & 公証済み",
    ctaC2: "デスクトップ自動更新",
    ctaC3: "注釈は素の JSON で保存",
    dlMacSilicon: "macOS · Apple Silicon",
    dlMacIntel: "macOS · ユニバーサル",
    dlWindows: "Windows",
    dlLinuxAppImage: "Linux · AppImage",
    dlLinuxDeb: "Linux · Debian / Ubuntu",
    dlAndroidPlay: "Android · Google Play",
    dlAndroidApk: "Android · APK",
    dlIosIpad: "iOS / iPadOS · App Store",
    dlDownload: "ダウンロード",
    dlOpen: "開く",
    dlComingSoon: "近日公開",
    dlRecommended: "推奨",
    dlForYourMac: "この端末向け",
    dlTotal: "累計 {n} ダウンロード",

    footerColophon:
      "Instrument Serif、Klee One、JetBrains Mono にて。ある火曜日、長い PDF の合間から生まれた vibe。",
    footerColophonKana: null,
    footerProduct: "プロダクト",
    footerChangelog: "変更履歴",
    footerResources: "リソース",
    footerKeymap: "ショートカット",
    footerPrivacy: "プライバシー",
    footerSupport: "サポート",
    footerTagline: "迷子になっても、読み続ける。",
    footerPrivacyShort: "テレメトリなし · ローカル限定",

    docBack: "← トップへ戻る",
    changelogKicker: "— リリースノート",
    changelogTitle: ["ひっそりと、", { em: "直してきたこと" }, "。"],
    changelogLede:
      "0.1.0 以降のすべて、普通の言葉で。デスクトップアプリで見える内容と同じ。",
    shortcutsKicker: "— ショートカット",
    shortcutsTitle: ["全キーを、", { em: "1 ページに" }, "。"],
    shortcutsLede:
      "アプリ内で ⌘ ? を押すと出るのと同じ表。一枚にまとめてあるので、印刷もしやすい。",

    privacyKicker: "— 04 / プライバシー",
    privacyTitle: [
      "1 ページで、",
      { em: "細字なし" },
      "。",
    ],
    privacyLede:
      "Shiori は完全にあなたのマシンの中で動きます。アカウントなし、テレメトリなし、解析なし、第三者スクリプトなし。",
    privacyKeep: "ディスクに残るもの",
    privacyKeepBody:
      "開いた PDF、書き加えた注釈、最近開いたリスト、テーマと言語の設定。端末のアプリデータフォルダに置かれます — Mac では Application Support/Shiori、Windows・Linux・スマホにも対応する場所があります。バックアップも複製も削除もあなた次第。",
    privacyKnow: "このサイトが見ているもの",
    privacyKnowBody:
      "ブラウザが静的ホストからこのページを取得するときの IP アドレス。どのウェブサイトと同じです。保存も記録も共有もしません。",
    privacyUpdate: "アップデート",
    privacyUpdateBody:
      "デスクトップアプリは起動時に一度だけ GitHub に新リリースを問い合わせることがあります。",
    privacyContact: "お問い合わせ",
    privacyContactBody:
      "Discord へ：https://discord.gg/G5uzmAaHY。メーリングリストはありません。購読するものもありません。",
  },
};
