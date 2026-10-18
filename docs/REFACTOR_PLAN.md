# Shiori 重构计划：Native-feel + 代码健康

> 依据：一次 native-feel / ship-readiness 审计 + `App.tsx` God component 分析。目标是**可增量执行**，不是一次性重写。

---

## 执行状态（更新于 2026-07-22）— 全部完成

> 2026-09-23 注：本计划已完结，保留是因为代码注释里的「REFACTOR_PLAN A2/A3/B1 hook N」
> 指向这里。后续拆分见 `docs/PLAN-APP-ARCHITECTURE-2026-09.md`（App.tsx 现约 450 行）。

一刀一 commit，每步 `bun run build` + `bun run lint`（Rust 加 `cargo check`）绿后 seal，均已推送。当时 App.tsx **5009 → 4346 行**；`DocumentViewer` 1878 → 395、`TextHighlightLayer` 3283 → 1701。

**Part A — Native-feel**
- **A1 窗口状态**：`tauri-plugin-window-state`（排除 `VISIBLE`，防隐藏退出后复原成看不见）。
- **A2 右键菜单**：`useSuppressBrowserContextMenu`（全局吞浏览器右键，编辑框除外）。
- **A2 focus-visible**：`app.css` 全局键盘焦点环基线。
- **A2 跨平台菜单**：`build_app_menu` 从 macOS-only 放宽到 `#[cfg(not(mobile))]`，Win/Linux 也有原生菜单栏；macOS 专属项（services/hide/…）用 `Vec` + `#[cfg(macos)]` 条件 push，macOS 输出逐字节不变。*Win/Linux 运行时未从 macOS 验证；那边菜单暂显英文（`system_menu_language` 读 macOS defaults，回退英文）。*
- **A3 trade-off**：品牌字体 / 不透明背景 / 品牌 accent 三处就地注释「有意保留」。
- **A4 IPC codegen**：`tauri-specta` 上线——Rust 命令签名成 IPC 唯一真源（改签名 TS 编译即报错，已验证）。34 命令 `#[specta::specta]` + 14 类型 `#[derive(Type)]`，生成 `src/platform/bindings.ts`，36 处调用点改走生成绑定（`src/platform/ipc.ts` 薄封装保持 throw-on-error 语义）；3 个用 `tauri::ipc::Request/Response` 的命令 specta 不兼容，保留手写 invoke，与 specta handler 组合分发。*build + 51 测试绿、app 干净启动；逐命令全量运行验证仍欠。*

**Part B — App.tsx God component**
- **阶段 1：7 个 hook 全抽出**（`src/App/hooks/`）：`useAppearance` · `useAutoUpdate` · `useAppShortcuts` · `useDraftPersistence` · `useLiveBridge` · `useDocumentIntake`（最大一刀，含前置 `src/App/openErrors.ts`）· `useWorkspacePersistence`（**hook 6**：做成泛型 hook + 注入 tab 映射器，绕开 `WorkspaceRuntimeTab` 的 ~50 处级联，不必搬中心类型）。每个逐字搬移、deps 不变。
- **阶段 2：`AppDialogs`**——9 个 overlay dialog 收进 `src/App/render/AppDialogs.tsx`。*主 `WorkspaceLayout`（40+ props）与 Landing 分支（共享未导出常量）有意留在 App——按「别过度拆」。*

**Part C — 顺带清理**
- `DocumentViewer.tsx` → `DocumentViewerHtml` / `DocumentViewerParts` / `documentViewerGestures`（纯搬运）。
- `TextHighlightLayer.tsx` 抽 89 个纯几何函数到 `textHighlightGeometry.ts`（105/105 几何测试过）。

**顺带修**：`ShioriTile` 的 栞 之前偏下（`-2%` 光学微调太小），实测后改 `-8%` 垂直居中。

**验证欠账（真机 / 跨平台，本 macOS box 测不到）**：`useDocumentIntake` 移动端路由（iOS/Android 分享打开、Android bridge，逐字搬移）；A2 Win/Linux 菜单运行时 + 本地化；A4 逐命令运行（open/save/export/terminal/fonts/live-api + 移动端 arm）。

---

## A3. 有意保留（trade-off，别动，记录理由）

以下按 skill 是"失分项"，但对一个有设计身份的 PDF 文档 app 是**合理选择**——写进计划是为了明确"不做"，避免以后有人误判为 bug：

- **chrome 用 web 字体**（Inter Tight / Instrument Serif / JetBrains Mono，`app.css:16-21`）：品牌身份的一部分，且 CJK 已回落系统字体。保留。
- **窗口无 vibrancy、纯不透明背景**（`app.css:94-100`）：PDF 阅读要稳定的实心画布，材质透过来反而干扰内容。保留。
- **accent 用自选品牌色，不跟系统强调色**：app 有自己的视觉语言，`prefs.accentColor` 是特性不是缺陷。保留。
- **对话框是 DOM 模态**（Export/Password/GoToPage…）：Export 这类需要富交互，原生 sheet 反而受限。保留；仅在"纯确认"类可选择性原生化，非必须。
