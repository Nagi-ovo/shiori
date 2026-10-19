# 维护者更新日志

> 本文件面向维护者，记录完整技术细节。**App 内显示给用户的**是
> `docs/changelog/{zh,en,ja}.md` 三份精简版，不含 SHA / postmortem 链接 /
> 开发术语。两边的条目要保持对应。

每条目附对应 commit SHA。有深度复盘的条目会链接到 `docs/POSTMORTEMS.md`。

---

## [26.10.20]

### 开源

- **Shiori 与 Shiori CLI 开源（2026-10-18，`7874bc8`）。** `Nagi-ovo/shiori`（原
  `shiori-releases`）成为公开源码仓库：代码 MIT（`LICENSE`），品牌素材见 `TRADEMARK.md`；
  旧私有仓库改名 `shiori-dev`。开源快照把 26.9.27 之后的 96 个私有提交合成一个提交，
  下面「新增」「修复」各条的 SHA 只在 `shiori-dev` 里。发布、tag 与 `gh-pages` 更新清单仍在
  同一仓库；Cloudflare Pages 改从公开仓库部署（`shiori-site`、`shiori-web`）。新版 Android
  只认 `Nagi-ovo/shiori` 的 APK 路径（`8c77877`），`/api/release` 不带 `apkRepo=shiori` 时
  仍把 APK 地址改写回 `shiori-releases`，给 26.9.27 及更早的版本自更新。

### 新增

- **加密 PDF 导出保留原加密（`c2c1760a` `2b020169` `5ce7952a` `30a5f4dd` `882a2128`
  `c3b45f9e` `015fcfba`）。** 以前导出带密码的 PDF 直接失败（"先用别的工具去掉密码"）。
  现在从 PDFium 明文重建，再用源文件的 Standard 安全处理器（同一 /Encrypt、文件密钥、
  /ID[0]）重新加密，并用同一密码重开校验；用户密码与所有者密码都还能打开。编辑按 /P 授权：
  批注 bit 6，页面内容 bit 4，页面结构 bit 4（R3 起 bit 11）；未知安全处理器一律拒绝，
  重新加密失败即导出失败，不回退明文。
- **加密 PDF 可插入页面、可打印（`344eb4e9` `a94b695e` `b25a91d1` `7af35a4c` `ec7f1f77`
  `11d76a7a`）。** 插入页并入引擎明文后按源文件重新加密，受 "pages" 权限约束；打印从引擎
  明文重建，明文只进隐藏的打印 frame；/P 不许打印（bit 3）时拒绝并给出翻译后的提示。

### 修复

- **Canvas 视口层（`docs/PLAN-CANVAS-VIEWPORT-2026-10.md` 5 个阶段）。**
  - 触控板 pinch 收不到 gestureend 时停在预览：每个 gesturechange 重设 900 ms 兜底提交
    （`e6e83604`），兜底提交后把滚轮还回去（`1d39e326`）；PDF、Word、文本、HTML 视图共用
    一条缩放手势流（`2f38d05d` `d217f5f2` `6fa28d43` `5b1312dc` `af4c64e8` `4a95013f`）。
  - 按下页面会把它平滑滚到顶部（E2E 中 747 px）：activePageId 不再触发滚动，导航统一走
    `goToPage`（`256265e1`）；活动页改由页面追踪模块推导（`db6a337c` `80c34a5d` `2877c1f1`）。
  - 重开 PDF 落点偏 474 px：打开时钉住目标页顶部直到首次滚动或缩放（`89dbfdf8` `c9256b3f`），
    resize / fit / 缩放提交收进视口控制器（`b57d2085`）。
  - 键盘与菜单缩放固定 ±0.1，与工具栏档位不一致：统一走 `zoomStepUp/Down`（`5040b87c`）。
  - 弹窗打开时 Delete、工具字母、J / K 仍作用于后面的 Canvas：有 modal 时 Canvas 忽略所有
    按键（`d11e85a9` `bddba564`）。
- **标签页拖动（`a7dee5c8` `81424e30`）。** 拖动中的标签只平移不缩放、限制在标签栏轴向与
  范围内，以活动标签的外形整体移动（此前 scaleX 1.5 拉伸、非活动标签变淡成裸文字）。
- **CI 上 ToastHost 关闭测试失败（`voxsrprn`，仅测试）。** dnd-kit 结束拖动后 50 ms 才移除
  document 上吞点击的 capture 监听；happy-dom 全程共用一个 document，CI 上
  `TabStrip.keyboard.test.tsx` 紧挨 `ToastHost.test.tsx`，Close 的点击被吞。拖动测试的
  `afterEach` 现在等到探针点击能到达页面再交出 document。

### 改动

- **`src-tauri/src/lib.rs` 拆分（`docs/PLAN-TAURI-MODULES-2026-10.md`，`3bf33ab2` … `668eb50f`）。**
  约 5900 行拆到 563 行加按领域分的模块；`bindings.ts` 与 ACL manifest 逐字节不变。

- **pdf.js 移出仓库（计划 5.3；jj change id，提交 SHA 会随整合变动）。** App 自 4.7 起已不含
  pdf.js，这一批让 CLI 和测试也不再依赖它，`pdfjs-dist` 与随它装进来的 `@napi-rs/canvas`
  离开 `package.json` 与 `bun.lock`。
  - 核心绑定补上 CLI 需要的读取（`kqsuskvo`）：`Document::metadata()`（/Info 原文、版本、
    /Lang、加密时 `EncryptFilterName: "Standard"`）；`chars(index, max)` 在分配前拒绝字符数
    超过 `MAX_PAGE_CHARS`（2,000,000）的页，Tauri 去掉事后长度检查、wasm 补上原本缺的上限；
    napi `links()`。
  - CLI 每条命令只用核心打开一次（`zouknknq`），文字经 App 的 `pageTextFromPdfiumGlyphs`；
    跨行连字符的单词照常可搜。错误码：超大页 `ERR_TEXT_UNAVAILABLE`，pdf-lib 读不了批注时
    `extract` 报 `ERR_ANNOTATIONS_UNAVAILABLE`（不再是空列表），缺插件
    `ERR_PDF_ENGINE_UNAVAILABLE`；`ERR_RENDER_UNAVAILABLE` 与 `SHIORI_PDF_ENGINE` 删除
    （`nypvqkxw`）。CLI 包不再带 pdf.js 的 CMap、标准字体、wasm 解码器与 canvas 原生绑定，
    许可树 48 个文件、摘要与 `cli/SBOM.md` 重算；darwin-arm64 压缩 54 MB、解开 131 MB
    （此前 68 / 156 MB）。打开 PDF 的 CLI 测试移到 `test:core`，`cli-verify` 先编插件再跑。
  - 测试的独立依据换掉 pdf.js：写入方由 qpdf 检查（`ouruzotp`，CI 装 qpdf 并设
    `SHIORI_REQUIRE_QPDF`）；导入测试以构造参数为期望值（`okqqqltt`）；render 以 fixture
    推出的参考图比对，字体重建由同一 PDFium 画出比较（`tywwqnnt`）；页面插入的命名目标经
    核心 `links()` 读落点（`mtonwyvy`）；core extract 测试按 fixture 的字形位置放高亮并要求
    引文恰为 "Shi"（`yvrslmyn`）。Foxit Serif 随 fixtures 入库，fixture 可脱离 pdf.js 重生成
    （`xsxmtrlw`）。
  - 删除只为 pdf.js 存在的代码：`scripts/pdfium/compare-*` 与 `pdfjs-reference/`、
    `scripts/import/compare-annotation-readers.ts`、`annotationReader: "pdfjs"`（`tpkzoxzz`
    `okqqqltt`），pdf.js 形状的 `importPdfAnnotations` 入口（`kyoxolnk`），只剩自身测试在用的
    `getBoundedTextContent`（`wuutyrpl`），ESLint 的 pdf.js 围栏（`zuxkwzmp`）。注释里仍说
    pdf.js 在读、画、解密的地方改成引擎（`mxqprkso`）。
  - 已知缺口：竖排与 tagged 文本既无 fixture 也无对照读取者（pdf-lib 写不出 Identity-V）。
    THIRD_PARTY_NOTICES 保留移植自 pdf.js 的代码（文字层、批注列表）的署名。
  - Codex review 之后的修复：`/Info` 字符串中间的 NUL 不再截断（`svokyzzp`）；插件存在但
    加载失败也报 `ERR_PDF_ENGINE_UNAVAILABLE`（`nxsrmyrl`）；`extract` 用 strict 导入，
    `/Annots` 不是数组或 pdf-lib 页树缺页时报 `ERR_ANNOTATIONS_UNAVAILABLE`，App 仍宽松
    （`rquopxzt`）；删除永远匹配不到的 `isPdfJsInternalFontName`（`ysllqyrl`）。
  - CLI bundle 重复模块：`cli/src/main.ts` 首行 `#!/usr/bin/env bun` 让 Bun 以
    `target: "node"` 打包时把入口的依赖再链接一遍，6 个错误类各有两份，`instanceof`
    只在打包后的二进制里失败（如超大页报 `ERR_PDF_UNKNOWN`）。去掉 shebang，`cli/build.ts`
    拒绝重复定义错误类的 bundle（`zlwlrtrt`）；临时的按名称识别回退随之删除（`sqvktypl`
    `wqvyuwum`）。

## [26.9.27]

### 界面

- **Windows 自绘标题栏（`cfb9459d`）。** `tauri.windows.conf.json` 重述主窗口并关掉
  `decorations`（Merge Patch 整体替换数组，`windowChromeConfig.test.ts` 锁住与主配置
  一致）；`WindowCaption` 挂在 `main.tsx`（App 之外，过期/错误屏也有），z 45 高于
  弹窗遮罩，关闭走 `close()` → `onCloseRequested` 守卫。顶栏、错误/过期屏页眉、首页
  最近列表（滚动区外的 48px cream `borderTop`）、设置抽屉、窄窗口 rail 抽屉、阅读模式
  inset 与退出按钮都给右上角让位。权限加 `window:allow-minimize/-toggle-maximize/-close`。
  丢失 Snap Layouts 悬停浮层（需 `tauri-plugin-decorum`）。**未在 Windows 真机验证**，
  清单见 HANDOFF。
- **Windows 隐藏原生菜单栏（`d2467696`）。** 菜单仍挂着，只 `hide_menu()`：tauri 在
  msg hook 里用菜单的 HACCEL 翻译加速键，muda 在窗口子类里分发 `WM_COMMAND`，都不依赖
  HMENU 挂在窗口上，快捷键行为不变。Linux 保留：GTK 不激活不可见菜单项的加速键。
- **Windows/Linux 细滚动条（`c248c08f`）。** `<html data-shiori-scrollbars="classic">`
  （按 OS，web 同样适用），`:where()` 零优先级的 `scrollbar-width: thin` +
  墨色 `scrollbar-color`；macOS overlay 滚动条不动。

### 修复

- **toast 有了真正的关闭按钮（`8ae44dab`）。** 错误 toast 左侧的 X 只是状态图标；
  换成 `CircleAlert`，每条 toast 右上角加带 `common.close` 标签的关闭键，关闭不触发
  toast 的操作。
- **文件不存在时不再透出 OS 原文（`97fed4b8`）。** `*_at_path` 命令把
  `io::ErrorKind::NotFound`（ENOENT、Windows error 2/3）映射为
  `document-path-unavailable`，其他错误保留原文；`showPlatformOpenError` 对该码显示
  `toast.recentMissing`，不再误报"权限范围内无法读取"。

- **弹窗打开时窗口能拖动了。** 遮罩盖住了顶栏（窗口唯一的 `data-tauri-drag-region`），
  背景又被 `inert`，任何 `Modal` 打开时窗口都拖不动；遮罩顶部加一条 48px 的拖拽条，只在
  桌面壳（`nativeWindowChrome`）渲染，面板画在它上层照常可点。

### 构建与发布

- **更新提示改用 changelog 原文渲染。** `notes/<version>.json` 新增 `markdown`
  字段（该版 changelog 小节原文），之后的更新提示直接交给 `MarkdownView`，表格和粗
  体都保留；顶层纯文本字段照旧留给 26.9.26 及更早的客户端。选取逻辑抽到
  `src/release/updateNotes.ts`。
- **Play 用的 AAB 不再带 32 位 x86（`i686`）。** 每个 ABI 都是一整遍 Rust
  构建，而 32 位 x86 只剩老模拟器在用；`x86_64`（Chromebook）和 `armv7`（老
  手机）保留。直装 APK 本来就只有 arm64，不受影响。
- **发版 CI 提速。** 直装 APK 和 Play AAB 拆成并行、互不取消的两条 matrix
  （26.9.26 串行 7.7 + 12.8 分钟，且 AAB 那步失败连带挡住了 APK 上传）；Rust
  缓存只从 `main` 保存（tag 存的缓存别的 tag 读不到，Windows 白花 5.9 分钟）；
  wasm core 作为独立 workspace 进缓存，不再每次冷编译。

## [26.9.26]

### 改动

- **手机把阅读和标注拆成两个状态（`annotationMode`，`650ff443`）。** 手机没有
  地方常驻工具格子，于是阅读是默认态、格子完全不占布局（~85px 还给文档），点
  「标注」才把它浮到文档上方。退出标注会把工具钉回 `select`：阅读态没有格子，
  留着一个 armed 的 markup 工具既看不见也改不回来，而 `select` 正是
  TextHighlightLayer 那个「选中文字→标注」popover 的前提（规则单独提成
  `selectionMarkupGate.ts`，附带解释为什么只有 `select` 给 popover——markup
  工具在 pointer-up 就提交了，再给 popover 会重复应用）。撤销/重做在手机上同理
  只在标注态出现；平板不进这个模式，宽度够常驻。

- **Web 与移动端改由 wasm 版 PDFium 读和画（计划 4.6，`9cf41002` `c3a05242`
  `1f650a35`）。** 同一个 `shiori-core` 编到 wasm32，与 PDFium 的 Emscripten 构建一起跑在
  module Worker 里（`src/pdf/engine/wasm/`），渲染队列按优先级、以 MessageChannel 让出事件循环；
  与原生核心逐字形、逐像素一致。未嵌入的 CJK 由 MEMFS 字体目录里懒加载的 Noto SC / JP 补上
  （`FPDF_SetSystemFontInfo` 的 wasm 实现不可用）。桌面包不带 wasm。**Android 只剩 wasm 引擎，
  未在真机验证：发布前必须过 RELEASE-CHECKS A0.13。**

- **pdf.js 退出 App（计划 4.7，`fbe8c81d` `b433e24f` `83600305` `5395ff1e`）。** 加密文件的
  批注经 PDFium 的解密副本（`FPDF_SaveAsCopy` + REMOVE_SECURITY）交给 pdf-lib 读；紧凑导出经
  引擎光栅化（`annotations: false` 渲染不画批注）；`PdfDocument` 改为不透明句柄，引擎打开文档
  不再经 pdf.js；最后删掉 pdf.js 引擎、`render/pdfjs.ts` 一系与静态资源。入口静态 JS
  2,374,224 → 1,900,823 字节（gzip 791,041 → 646,821）；Web 首开 PDF 要多下载 PDFium
  5.73 MB（gzip 2.52 MB）。引擎启动失败归入新增的 `engineUnavailable`。`pdfjs-dist` 仍留在仓库，
  供 CLI 与测试 oracle 用。

- **删除「GPU 加速」设置（`19682dc2`）。** 它只是 pdf.js 画布的 `enableHWA` 开关；资源面板的
  GPU 一行改显示厂商与渲染器，删掉 5 个 i18n 键。

- **桌面页面文字改由 PDFium 字形合成（计划 4.3c，`41e95e61` `1b51778b` `42d92f3b`）。**
  `pageTextFromPdfiumGlyphs` 按基线与字体组 run，可恢复的 run（被水印打断的单词接回）以同基线为
  前提。高亮样本映射率 100%，复制文本与 pdf.js 一致或更准。查找与 Live 桥也经引擎读字
  （`2402ccf2`）。

- **编辑框用回文档自己的嵌入字体（计划 4.3d / 4.3e，`c00315b8` `a8659ab7`）。** 浏览器能直接
  装的 TrueType / OpenType 程序原样注册为 `FontFace`；拒收的（裸 CFF、Type1、pdf-lib 这类删减过
  表的 TrueType 子集）按 PDFium 画出的字形重建：核心用 `FPDFFont_GetGlyphPath` 按 Unicode 取本页
  字符的轮廓与 /Widths 步进，引擎用 opentype.js（按需加载，gzip 67 KB）写成 CFF 版 OpenType，
  每页只为新字符加一个带 `unicode-range` 的面。Chrome 与 WebKit 都接受，与 PDFium 渲染逐像素
  相符。

- **CLI `render` 走核心，打包版 CLI 默认用核心读与画（计划 5.1，`ff606b5b`）。**
  `SHIORI_PDF_ENGINE=pdfjs` 退出；从源码运行仍默认 pdf.js。

### 性能

- **性能对照（本节与「改动」里 PDFium 各条的汇总，用户版同表）。** Apple M5 Pro、
  Retina（dpr 2），fable.pdf（8 页 Letter）；缩放数字取 `docs/PERF-zoom-tiles.md` 的
  R1 定案表（Chrome，pdf.js tile，PDFium 之前），8× 一屏取 `docs/PERF-pdfium-desktop.md`
  （30 块 512 px tile 并发），入口 JS 取 `scripts/perf/inspect-entry.ts`（4.7d）。

| | 26.9.9 | 本版 |
|---|---:|---:|
| 8× 实际清晰度 | 4.06×（`MAX_CANVAS_PIXELS` 封顶后拉伸） | 真 8×（tile） |
| 4× 清晰耗时 | 87–121 ms（整页） | 66–68 ms（tile） |
| 高倍画布峰值 | 252–259 MB | 106 MB |
| 8× 一屏 30 块 tile（桌面） | pdf.js 70 ms | PDFium 34 ms |
| 入口静态 JS | 2,374,224 B（gzip 791,041） | 1,900,823 B（gzip 646,821） |
| Web 首开 PDF 额外下载 | — | PDFium 5.73 MB（gzip 2.52 MB） |

- **缩放超过约 2× 改为视口 tile（Rust PDF 核心计划阶段 1）。** 整页位图受
  `MAX_CANVAS_PIXELS = 32e6` 封顶，Retina 上 letter 页最多 4.06×、A4 4.0×，
  所以 `MAX_SCALE = 8` 的后一半一直是拉伸的位图。现在整页超过 8 MP 的底图预算
  （`TILED_BACKDROP_MAX_PIXELS`，Retina letter 页约 2×）时，底图停在 8 MP，`PageTiles` 在上面按真实倍数铺 512 设备
  像素的 tile，只画滚动容器内的可见区加一圈；缩放时旧 tile 拉伸垫着，直到新倍数
  的可见 tile 画完。新接口 `PdfEngine.renderRegion`（pdf.js 实现
  `renderPageRegion`），阶段 3 的 PDFium 接在同一处。纸色改成底图和 tile 一组
  multiply，避免重叠处墨色乘两次。实测 8× 清晰耗时 52–66 ms，画布峰值约 260 MB →
  106 MB（`docs/PERF-zoom-tiles.md`）。`pageRegion.test.ts` 与
  `PageCanvas.lifecycle.test.tsx` 的 tile 测试各自经 mutation 验证。

### 修复

- **旋转页上的文字层对齐（计划 4.3b）。** pdf.js 的 `TextLayer` 按未旋转页面排 span，把旋转
  留给它查看器的样式表（`[data-main-rotation]`），Shiori 从没有这条规则，且根节点的内联缩放
  transform 也会盖掉它，所以 90°/180°/270° 页上原生选区与文字完全错开（span 与字形框 IoU 为 0）。
  自带的 `ShioriTextLayer`（移植 pdf.js，Apache-2.0）把旋转算进每个 span 的位置和角度：三种旋转
  IoU 都是 0.95–0.96；未旋转时生成的 DOM 与 pdf.js 逐字节相同（3 页 × 2 个倍数核对）。

- **PDF 的 Named 动作链接（NextPage / PrevPage / FirstPage / LastPage）。** 链接层原来只认
  pdf.js 报出的 FirstPage / LastPage，桌面换 PDFium 后连这两个也没了（PDFium 没有读 Named
  动作的接口）。现在导入器的 pdf-lib 原始扫描把这类链接经 `onNamedLinks` 报出，桌面引擎并入
  PDFium 的链接，前后翻页也跟着支持。导入器、引擎、链接层各有测试。

- **桌面端页面改由 PDFium 绘制（计划阶段 3）。** Tauri 里一个渲染线程拥有全部 PDFium
  文档（`src-tauri/src/pdf_core.rs`），屏上 tile > 整页底图 > 缩略图排队，滚走的 tile 按
  票号取消；前端 `pdfiumDesktopEngine` 让 pdf.js 继续负责读取，PDFium 出像素，打不开或画
  失败时退回 pdf.js。导入器压掉的批注经 `onSuppress` 按子类型 + /Rect 在 PDFium 里设
  HIDDEN；表单经 `FPDF_FFLDraw`，tile 里也在。PDFium 7881 由 `beforeBuildCommand` 暂存进
  包（macOS Frameworks，签名；Windows/Linux 资源），dmg +3.4 MB。实测 30 块 8× tile 逐块
  69 ms（pdf.js 481 ms），并发 34 ms（70 ms）；文字层与 PDFium 像素差 ≤ 1 设备像素
  （`docs/PERF-pdfium-desktop.md`）。Windows 的 IPC 开销未测，见 RELEASE-CHECKS A0.12。

- **原生菜单「放大」的上限从 5 提到 8。** `src/App/nativeMenu.ts` 自带一份
  `MAX_SCALE = 5`，与 `Canvas.tsx` 的 8 各写各的；两处现在都读
  `src/editor/zoomLimits.ts`，不会再分叉。没有加测试：共享常量让分叉在结构上
  不可能，而断言 8 本身只会钉住一个数值。

- **「编辑将覆盖暂存草稿」的对话框能关掉了。** 草稿暂存（选了「打开原文件」）
  后第一次编辑会弹出这个对话框；按 Esc 或点背景本应把草稿继续暂存，但
  `DeferredDraftEditWatcher` 只看撤销栈是否非空，而触发它的那次编辑还在栈里，
  于是对话框关掉的同一拍又被弹回来，只能选恢复或丢弃。现在记下草稿暂存那一刻的
  文档模型，只有之后的新编辑才再问。`DeferredDraftEditWatcher.test.tsx` 守着。

- **关掉当前 tab 不再闪一下首页（`845798d4`）。** 关闭时先把 tab 移出列表，再等
  IndexedDB 删掉它的运行时会话和预览，最后才激活相邻 tab；等待的几帧里当前 tab
  指向一个已不存在的 tab，关 Markdown / Word 时就画出了首页。现在相邻 tab 与移除
  同一拍上屏，被关 tab 的 editor store 在第一个 await 前离开 registry。这个顺序
  早于工作区重构，`tabLifecycle.test.ts` 守着它。

- **挂起后切回的 PDF 不再被误标「未导出」。** 超过 3 个常驻 PDF 时最久没看的会
  挂起；切回来时 `openPdf` 用这次新生成的页面 id 算导出基线，模型却从挂起快照
  恢复、带着原来的页面 id，两个快照 key 永远不等：没改过的文档也亮未导出的点、
  顶掉 tab 上的关闭按钮，关闭时还提示「未导出就关闭」。从快照恢复时改用 tab
  记录里的基线。`openDocument.test.ts` 两条：没改的不标，挂起前改过的仍标。

- **Word 引擎 @docx-editor.dev/* 2.15.1 → 2.21.1，英文模板贴中文不再溢出页边。**
  主题东亚字体为空（`a:ea typeface=""`）时引擎退回拉丁字体，行比纸宽 158px；
  上游 eigenpal/docx-editor#787（PR #804）修复。Web 版实测 `cjk-theme-empty-ea.docx`
  左右页边 96/99px，`two-images.docx` 跨页图片两张都加载。中间版本无 major、
  Shiori 未使用被移除的 `dateInputOrder`。

- **桌面端无外观批注画两遍（计划 4.4，`a979b09c`）。** 批注导入改由 pdf-lib 直接读文件
  （`sourceAnnotations.ts`，ID 与 pdf.js 的 `12R` / `annot_p<页>_<n>` 一致，草稿不迁移）；被
  导入为可编辑对象的批注按子类型 + 文件里的 /Rect 交给 PDFium 隐藏，无外观的高亮、便签、墨迹不再
  由页面再画一遍。

- **导出时 INVISIBLE 批注重复（`a5406ddf`）。** 导出与导入共用 `isListedForImport`，导入器接管过
  的不可见批注在导出时一并替换。

- **Markdown 编辑视图的代码块与高亮（`56c4c785`）。** 编辑器里 FencedCode 原样显示成源码行，
  两个视图都没有语法高亮。编辑器接 `@codemirror/language-data`（每种语言首次用到时加载）、
  `syntaxHighlighting(classHighlighter)`，代码块成框、围栏折成语言标签（光标在块内时显示）；
  预览用同一套 Lezer 解析器、同一组 `tok-*` class，逐块在接近视口时高亮（整篇先高亮使 1 MB、
  1800 块的文档从 0.17 s 变 1.6 s）。顺带修了 React 19 按对象身份比较
  `dangerouslySetInnerHTML`：内联对象让预览每次重渲染都重写整篇 innerHTML。

- **首次进入 Markdown 编辑的约 350 ms 停顿、切换模式丢位置。** 停顿来自 `React.lazy` 首次必定
  挂起，加上 React 19 对已显示的 Suspense fallback 约 300 ms 的节流；预加载编辑器后直接渲染，
  桌面实测 350 → 41 ms。位置：预览与编辑器共用一个像素 `scrollTop`，两边排版高度不同，预览第 4
  节切过去落到第 7 节；切回时编辑器卸载的 cleanup 晚于预览挂载，清空了共享的 scroller ref。
  现在按源码行交接（预览块带 `data-source-line`），编辑器只清自己的 scroller。

- **选中标签与下方工具栏连通（`879645cf` `9a1e8b60` 及其后一条）。** 选中标签是 paper 色、
  想用 -1px margin 盖住标签栏底线，但底线是容器的 border，在 strip 与 tablist 的 overflow
  裁剪之外，任何标签都画不到；下方工具栏（PDF ContextualToolbar、DocumentControlBar）又是
  cream，与标签不同色。现在工具栏改 paper，底线改为 band 内的 inset box-shadow，选中标签
  盖住它；底角加 7px 的反向圆角过渡到底线。


---

## [26.9.9]

### 改动

- **手机端 chrome 从 303px 减到 189px，文档从 62% 涨到 75%。** 四块，都不依赖
  交互方向的取舍，是三个候选方向共同的前置清理（提案见 artifact，尺寸量自真机）。
  - **底部状态栏在手机上整条撤掉。** 六项里只有页码是持续状态，改成滚动时浮出、
    停下 1.2s 淡出的 `PageIndicatorPill`；缩放百分比是瞬时的（`liveZoomIndicator`
    已在做）、「未导出」是导出按钮上那个圆点说过的、「已保存」几乎恒真，本地优先
    的应用只在失败时才需要开口；草稿恢复与暂存是一次性事件，各变成一条带动作按钮
    的 toast，把原来那行常驻按钮持有的回头路原样接住。桌面不动。`3d511b87` `86e6f2c7`
  - **安全区改由文档行自己留。** 状态栏原本替 PDF 挡着系统导航条，它一走内容就会
    压到导航条下面——正是 26.9.8 挨骂的那个坑。`pdfDocumentRowStyle` 抽成可测
    seam（App.tsx 无 harness，按 CLAUDE.md 第 11 条）。净收益因此是 28px 不是
    52px。`5650d89e`
  - **文件名行与标签栏互斥。** `documentIdentityRow` 返回枚举而非两个布尔，所以
    「两条都渲染」和「两条都不渲染」在类型层面不可达——手机上顶栏没有内联标题，
    两条都没有就等于不知道在看哪份文档。顺带发现 PDF 分支从来没给顶栏传过
    `onOpen`，一直靠标签栏那个「+」，标签栏一藏就断路，已按需补上。`f16753fa` `88c879fb`
  - **检查器改为浮在文档上的固定面板。** 选择模式下它只写着「选择」，而工具栏上
    那颗已经是高亮的。但不能直接删：26.9.7 让它常驻正是为了占位，删回去文档就会
    在切工具时跳 47px。改成不在流里，跳动从构造上不可能发生，选择模式下彻底不渲染。
    面板与页码丸通过一个 `liveZoomIndicator` 形状的微 store 协调底边；选中的批注
    碰到底部带时面板改挂顶边，免得盖住正在改的东西。不变量测试遍历每个工具，断言
    流里的行数不变且恰好为 1。`ed48fa66`

### 修复

- **26.9.8 回归：安卓上 PDF 滚着滚着变成一片空白。** `Canvas.tsx` 里
  `if (!gestureZoomingRef.current) syncRange()` 这道门是 26.9.8 加的，防的是
  「捏合中挂载的页面会按基准比例画一帧」这种视觉瑕疵；代价是标志一旦卡住，滚动
  就不再重算挂载范围，读者滚过挂载窗口后看到的是空白纸。标志会卡住是因为触屏捏合
  只在结束事件里提交，`markGestureZooming(null)` 不装兜底。三处一起改：滚动永远
  重算范围、捏合加 3 秒看门狗、捏合监听移到 window（touchend 投递给 touchstart
  命中的节点，虚拟列表卸载它之后事件到不了 scroller——这是幽灵手指问题的投递侧，
  DOCX 修了根因却把 PDF 挂在了更窄的节点上）。回归测试回放「结束事件丢失后滚动」，
  在 26.9.8 上只挂着前两页。`cec73fea` `2f2cc5df`
- **26.9.8 回归：手机状态栏文字换行溢出。** 行高固定 28px，内容却是变长的：草稿
  恢复会多出提示、打开原始文件、未导出三项。flex 子元素默认可收缩，于是标签换行
  挤出了栏外，26.9.8 加的安全区 padding 又让它更明显。改成不换行、横向滚动、子元素
  禁止收缩——只在容器上写 nowrap 不够，真正让它换行的是子元素的收缩。这一条在
  26.9.8 发版前的移动端排查里就写明了，当时没修。`e415a3f3`

---

## [26.9.8]

### 修复

- **Android 上 Word 文档越滚越宽，直到 800%。** DOCX / PDF / Markdown 三个阅读器的
  双指捏合都用 Pointer Events 自己维护手指列表；Android WebView 把某根手指的
  pointerup 投递给 Word 引擎已 `setPointerCapture` 并重绘掉的节点，host 永远收不到
  抬起，之后每次单指上滑都成了"和幽灵手指捏合"，一滑放大一截。改为共享的
  `attachTouchPinch`：以 `event.touches`（浏览器自己的在屏手指列表）为准，不可能
  滞留；touchmove 非 passive，捏合时能真正取消浏览器的双指平移（pointermove 的
  preventDefault 从来挡不住滚动）。测试回放安卓的指针 + 触摸事件序列，旧代码红。
  `0a1933dc`，复盘见 `docs/POSTMORTEMS.md`。
- **Android 底部 UI "错位"：导航栏下方露出一条不属于任何界面的底色。**
  `MainActivity` 用原生 padding 给系统栏留白，那条带子画的是 Activity 窗口底色
  （白 / 夜间默认色），不是 Shiori 的状态栏色；前端所有 `--shiori-safe-bottom` 预留在
  Android 上全是 0——WebView 的 `env(safe-area-inset-*)` 只报刘海，从不报系统栏；
  insets 还未消费，AppCompat 子 decor（`abc_screen_simple.xml` 的
  `fitsSystemWindows`）再垫一遍。现在 WebView 铺满全屏，原生侧把系统栏 inset 推给页面
  （启动时 `safeAreaInsets()` 拉一次，旋转 / 沉浸 / 键盘变化时推送），写进 iOS 用
  env() 填的同一组 `--shiori-safe-*`；状态栏图标明暗跟随应用配色而非系统。键盘仍缩
  视图。仅 CI 编译 Kotlin，**需真机验收**。`7cb49f0e`，复盘见 `docs/POSTMORTEMS.md`。
- **PDF 触屏单指拖动不再和原生滚动打架。** 选择工具的空白处 pointerdown 起一个 JS
  平移逐帧写 scrollTop，安卓上和 compositor 的原生平移同时跑：每次轻扫开头跳一下、
  没有惯性。平移改为仅鼠标。`22c7733a`

### 改进

- **docx-editor 引擎升到 2.15.1，中文 Word 文档不再溢出页边。** 2.1.3 只读
  `w:rFonts` 的 ascii / hAnsi，整段中文按 Carlito 度量，汉字量成 .notdef 宽度而浏览器
  画成 1em，混排行右侧被裁。2.14.0 起按 script 切片解析 `eastAsia` 槽位（含主题
  `a:ea` 与 docDefaults）；2.15.1 同时带上游 #251（跨页第二张内联图片永远停在占位
  符）的修复——那是我们自己 08-17 合进去的，本地却一直跑着没修的 2.1.3。fixture
  验证：微软雅黑 / 等线 / 宋体 槽位都在页内，跨页双图片都能画出。**仍会溢出**：主题里
  东亚字体为空的文档（en-US 模板贴中文），引擎退回拉丁字体，已整理成上游 issue 草稿。
  同时删掉引擎不再输出的 `.docx-editor-one-surface__page(s)` 选择器；DOCX 懒加载块
  1.58 → 2.0 MB（gzip 449 → 575 KB）。`a2eaab87`
- **打开 .docx 只加载它用到的字体。** 之前每份 Word 文档首绘前都要先加载 20 个 Word
  替代字面（7.4 MB）加 Noto Sans SC / JP（12 MB）。现在 `scanDocxFontFamilies` 直接从
  包内 XML（run / 样式的 `w:rFonts`、主题 typeface）读字体名，只加载命中的 Word 替代
  （Carlito 作为引擎默认字体常驻）和命中别名的 CJK 字面；纯拉丁文档只拉 Carlito 四个
  字面。保留零参 loader 形式——它是唯一"字体就绪后才首绘"的路径，页面仍只分页一次。
  fixture 生成脚本进仓库：`scripts/fixtures/make-docx-fixtures.ts`。`f4063a64` `48cc71a6`
- **PDF 缩放提交后立刻重绘、文字层就地重排。** `PageCanvas` 对任何缩放变化先等
  160ms 再重栅格，捏合松手 / 工具栏加减都白等一段模糊；现在只有两次变化间隔小于
  settle 的"流"（窗口拖拽逐帧 refit）才等。`d99927c5`。文本层与链接层之前按
  `layerScale` 重建（getPage / 文本流 / getOperatorList / 字体注册 / 批注抓取），每次
  松手每页数百毫秒不可选中、链接失效；改为 `TextLayer.update` /
  `AnnotationLayer.update` 就地重排并从缓存重算显示几何。`238dc0e7`
- **PDF 触屏手感。** 双击缩放（适宽 ↔ 2×，以点击点为锚，180ms 动画，走捏合同一条
  预览 + 提交路径）；手势状态不再是 React state（唯一消费者是一个 class，两次
  setState 让每次手势第一帧整列重渲染）；手势中滚动不再 re-range（新挂的页没有预览
  transform，按基准比例画在放大页旁边）；scroller 加 `overflow-anchor: none`（Chrome 滚动
  锚定叠在提交修正上）与 `overscroll-behavior: contain`。`4989cd4f`
- **手机上相邻页始终挂载。** 紧凑视口 200px overscan 不变（内存），但
  `minOverscanItemCount: 1`：适宽下一页高于 200px，之前翻页总先看到模糊预览。`e8ccc9c8`
- **去掉 Android 点击高亮闪光。** `html, body` 加 `-webkit-tap-highlight-color: transparent`。`11810f92`

## [26.9.7]

### 改动

- **四套主题的辅助文字与工具文字全部达到 WCAG 4.5:1。** `dim` 在 paper /
  cream / surface / tint 四个实际背景上校验；Everforest 两套同时校正 `ink2`，
  浅色 Everforest 的 ink 本身只有 4.66:1，所以次级色接近 ink，层次靠字号与字重。
  `theme.test.ts` 断言四预设全部达标，旧值会红。`3af2eaef`
- **NumField 加减按钮改为并排 24×24，空闲时不再隐藏；值按钮支持 ↑/↓ 步进。**
  文字标记的不透明度与文字框字号接通 `onCommit` 直接输入并按真实范围钳制。
  `abc47532`
- **标题栏文件名改为原生按钮。** 点击 / Enter / Space 走同一复制路径，tooltip 带
  完整文件名；文案不再写“双击”。`082bf50c`
- **窄布局（≤959px）选择模式保留 inspector 行。** 之前返回 `null`，切到标记工具
  或点选批注会多出 46px 行 + 1px 边线，文档下移 47px。`InspectorRow` 只在有控件
  时渲染分隔线与控件槽。`027eb5b4`
- **大模型导出签名移出 render。** `useExportSnapshotKey`：≤1500 条 overlay 仍同步
  计算，超过则 `requestIdleCallback`（500ms 上限），期间 key 为 `null` 并只读作
  “待导出”；模型引用变化即取消，过期结果按引用过滤。`resolveExportStatus`
  接受 `null`。`295934c1`
- **状态栏去掉 500ms 轮询。** `useDeadlineClock` 只在下一个会改变显示的时刻重渲染
  一次（撤销提示 2.5s 到期、相对时间跨越 45s / 分 / 时 / 天边界，见
  `nextRelativeChangeAt`），隐藏时停表。空闲 1.2s Profiler 断言 1 次 commit。
  `d95204f8`
- **更新日志、更新弹窗、设置面板改为首次打开时加载。** `deferModal` 不用
  `React.lazy`（失败会被永久缓存），失败可重试、可关闭，>400ms 显示加载提示。
  入口静态 JS 闭包 2,490,134 → 2,319,360 字节（gzip 831,483 → 769,823）。
  `2c402fd0`
- 删除 Canvas 中无读取方的 `containerHeight` state。`80e5a20f`
- **捏合缩放松手不再闪：PDF 页面列不再换代。** `Canvas.tsx` 从 react-virtuoso 改为
  按已知尺寸绝对定位的自有列（`pdfPageLayout.ts`）；缩放提交只换布局并写一次 scrollTop，
  同一帧完成，页面元素身份不变。删除 veil / seed / guard / refine 与位图交接池，
  `PageCanvas` 回到双缓冲。`Canvas.pageColumn.test.tsx` 断言 DOM 身份跨 scale 不变。
  复盘见 `docs/POSTMORTEMS.md` 2026-09-07。

- **更新日志弹窗重排 + markdown 渲染器补齐。** `markdownView.tsx` 的块模型和解析器
  拆到 `markdownBlocks.ts`（同文件混合导出会让 Fast Refresh 失效）。版本标题从
  18px sans 改为「27px 衬线版本号 + 主题色代号 + 发丝线」的一行，`###` 降级为
  安静的 sans 小标签，条目去掉 bullet、间距 8→15px、正文降到 `ink2` 让加粗首句成为落点。
  新增 `>` 引用块；紧跟在 `##` 后的引用被折进版本行右侧（`aside`）。
  两个既有缺陷一并修掉：markdown 软换行此前被当成新段落，把一条 changelog 拆成两块；
  合并软换行时无条件补空格，中日文里会出现「页内 批注」这种断词。`joinWrapped`
  只在 CJK/CJK 边界省掉空格，CJK/Latin 保留。官网解析器 `site/src/content/changelog.ts`
  同步同一条规则。

- **版本代号（题记）机制。** `src/release/epigraphs.ts` 是一个有序池 + 消费账本：
  20 条《混沌武士》分集标题（四字熟语，日文原题 / Bangumi 官方中文 / 官方英文），
  每条带可选 `version`。`scripts/prepare-release-notes.ts` 取第一条没有 `version`
  的条目盖上版本号、写进三份用户日志的版本标题下、并生成 `notes/<version>.json`，
  发版时零决策。`epigraphs.test.ts` 守住：已消费条目连续且不可改写、一版只消费一条、
  标题三语齐全且不重复、余量低于 3 条时变红。`src/release/notes.ts` 把某个版本的
  changelog 段落压成 release notes 纯文本（去掉加粗标记前先折软换行，否则跨行的
  加粗首句会漏一个 `**` 到句中）。

- **官网显示累计装机量。** `site/functions/api/downloads.ts` 走已有的
  Cloudflare Pages Function + 边缘缓存管道（`per_page=100` 单独 cache key，TTL 30 分钟），
  只统计 `.dmg` / `.msi` / `.deb` / `.AppImage` / `.apk`，排除 `.sig` 与
  `.app.tar.gz`——那两类是 updater 机器流量，占原始总数的 45%（678 中的 307）。
  上游失败返回 502 而不是 `total: 0`，前端拿到 null 就整行不渲染。

审计来源与验收标准：`docs/READER-AUDIT-2026-09-07.md`。⑧（目标页优先的渐进式
打开准备）未实施：两份真实 PDF 的准备链中位数 <100ms，需先在更大文件上补测。

## [26.8.12]

### 新增

- **提供本地 PDF 页面插入。** 缩略图栏的“+”可把另一份 PDF 的全部页面插到
  当前页后；来源文件保持不变，页内批注、内部页链接、named destinations、
  page labels 与当前文档的编辑历史可继续工作。基础或来源 PDF 若含数字签名、
  加密、脚本/媒体动作、无法安全重映射的导航或附件拓扑，整次操作 fail closed，
  不做有损 fallback。`45f45a08` `2c5892dd` `eba77d85` `1c6e3793`

### 改进

- **DOCX 移动端排版按实际页面与字体收敛。** 自动适配允许降到 10%，可容纳 OOXML
  最大宽度页面；渲染器同时加载并映射常见中日文无衬线字体，让 HarfBuzz 测量、
  DOM paint 与换行一致。宽表格和内容绘制也被裁在白纸边界内。`4b394aab`
  `3db399aa` `835609b7`

- **移动端标签恢复原生横向滚动。** compact 布局不再把标签折进桌面溢出菜单；
  tab 不收缩，swipe 直接滚动，长按才启动排序，固定“+”与安全区不会跟随内容
  滑出视口。`4490704c` `dbbc639d`

- **页面菜单与 Landing 响应式布局重做。** 菜单统一 Lucide 图标、分组、焦点恢复、
  transient hover 和 visualViewport / safe-area 定位；Landing 的引语与 footer 进入
  真实布局流，矮窗可滚、移动端不再覆盖最近文件。`08d0cdce` `ad151232`
  `2d078f74` `2a3bbab2`

- **大型 PDF 打开与导出的内存峰值下降。** export engine 延迟加载；预览只计算当前
  画质并复用 in-flight 结果；栅格页完成后立即释放 canvas；pdf.js 打开失败会销毁
  loading task，成功路径不再额外保留第二份完整字节。`a5c12f33` `9f7d40bc`
  `8e6ad814` `28158953` `514ee4a8`

### 修复

- **编辑后的完整 PDF 导出保留文档附件。** 复制 `/Names/EmbeddedFiles`、Catalog
  `/AF`、`/Collection` 与 `/UseAttachments` 时按 FileSpec 身份、metadata、payload
  和共享对象关系核对；页范围导出明确 omit，并要求输出不残留物理附件对象。
  `38c5b408`

- **删除页面后的附件完整性按逻辑页投影。** 只移除未导出页的 FileAttachment / page
  `/AF` ownership edge 与跨页 Parent/IRT 依赖；仍被 Catalog 或保留页引用的对象
  保持。Compact 只把文档级附件复制进真正的栅格结果，避免复活删除页附件。
  `272cdc90` `328bf7aa`

### 安全与依赖

- **升级到 Tauri 2.11 修复线并刷新前端/Rust 依赖。** macOS 的 early Opened/Reopen
  replay 补丁已移植到 Tao 0.35.3；PDF annotation scripting 继续固定为关闭；可定点
  修复的 frontend、serde_with 与 event-listener advisory 已清理。`7a846d81`
  `a2fd89db` `ebf7e888` `0f0d5704`。PDF.js 6 的 Safari 18 平台下限与 CLI
  原生打包迁移风险记录在 `docs/DEPENDENCY-AUDIT-2026-08-12.md`，本版不做静默
  兼容性降级。

- **回移植 Android 事件投递与 Wry 主队列排空。** 由于 Tauri 2.11 仍约束 Tao
  0.35 / Wry 0.55，本地 vendor 同步上游 publish-before-wake 与一次 wake 排空所有
  可见消息的实现；并对齐尚未合并的 Tao #1304 方案，在每次 Android looper poll 后
  排空 user event，覆盖 lifecycle fd 与 wake 同时就绪时 `pollAll` 不返回 Wake 的情况。
  本项只作为候选修复记录；公开更新日志必须在 release APK 真机 50 轮 picker 门禁
  通过后才能宣称已修复。`739d7e3b` `3a4f01af` `5664279d`

## [26.8.9]

> `26.7.31` 与 `26.8.2` 都是未公开的本地候选，其内容合并到本次正式候选；
> 日期版本号本身已经表达发布日期，因此不再重复附日期。

### 新增

- **DOCX 只读预览补齐为完整文档入口。** Web 文件 input / File System Access、
  桌面原生 picker / 文件关联、Android picker / share intent、iOS document type
  均接受 `.docx`；最近文件、工作区恢复、重复打开去重、滚动位置和缩放状态走统一
  文档生命周期。预览使用官方度量兼容字体，并保持大渲染器 lazy-load。
  `d484a9b9`

- **隐藏标签菜单补齐批量管理和就地预览。** 溢出菜单改为跟随主题的组件，支持
  逐个连续关闭和一次关闭全部隐藏标签；关闭请求串行执行，保存确认不会互相抢占，
  菜单也不会每关一个就消失。悬浮或键盘聚焦可预览 PDF 上次停留的页面与缩放，
  文本格式显示安全摘要，不会为了预览唤醒已挂起的文档。侧边栏文件列表复用同一
  份缓存。`f2016fb0` `dd943f5e` `09b5451f` `9f49f0ee`

### 改进

- **缩放手势只在结束时触发一次真实排版。** Markdown / HTML 的手势过程改走
  compositor transform，缩放读数实时更新，停止后才提交新倍率并校正锚点；避免
  每一帧都让整篇文本 reflow。`eaa1e45f`

- **大量标签下的预览缓存不再反复读取截图正文。** 16 MiB LRU 配额改由
  IndexedDB 复合索引中的时间、大小和 tabId 计算；88 个标签接近上限时，切换
  标签只扫描元数据，不再 structured-clone 全部截图字符串。`34c11ec6`

### 修复

- **非 PDF 文档不再改变 Shiori 的窗口骨架。** DOCX 打开时四个导航按钮始终保留，
  不支持的 PDF 视图原位变灰；设置、快捷键、toast、文件 input 与密码 host 不再因
  格式分支消失。修复 `chrome=false` 后预览容器按内容收缩导致的高度/裁切问题，
  并为 chunk / 解析失败增加可恢复错误边界。DOCX 现复用 Shiori 缩放条，切换标签
  后恢复缩放与滚动位置。`d484a9b9`

- **截断 PDF 后残留的大纲不再表现成“灰了但不知道为什么”。** 指向已删除页面的
  条目保持禁用，并在悬浮或键盘聚焦时显示主题化说明；导出时同步清理失效的大纲、
  named destination、OpenAction 和页内跳转链接，避免把死导航带进新文件。
  `de4df700` `5be8ec8a`

- **侧边栏预览会跟随真实的鼠标移动方向换边。** 鼠标向下时卡片放上方、向上时
  放下方，即使列表滚动条没有移动也会立即切换；到视口边缘时仍自动避让。
  `26c96023`

- **虚拟化页面卸载后立即释放 canvas backing store。** 页面、缩略图和缩放过渡层
  离开 DOM 时把画布归零，让 WebKit 及时回收图形内存，长时间切换或滚动大量
  文档不再等不确定的 GC。`7ddb539a`

### 安全

- **DOCX 在解压前执行包预算。** 压缩文件上限 50 MB、展开总量 128 MB、最多
  4096 个 ZIP entry、单 entry 压缩比上限 100，并拒绝 ZIP64、加密或结构缺失的
  Word 包；已知大小的 Web / native / mobile 路径会在读取前拒绝。工作区 blob
  改为真实字节计费和硬上限，非活动 DOCX 释放 resident bytes，避免重复标签和
  同步解压把内存成倍放大。`d484a9b9`

### 发版审计

- **终端追问不再可能落回 shell 执行。** 自动提交的 follow-up 现在使用不可执行的
  终端文本协议，并覆盖引号、分隔符、重定向、变量展开等 ASCII shell 语法；即使
  agent 已退出、PTY 回到提示符，也只会得到一行数据而不是命令。`b6704cc5`

- **批量打开与标签切换遵循最新的用户意图。** 多选中某一项损坏只单独报错，其余
  文件继续按顺序打开；加载期间切去已有标签时，新文件仍会在后台完成，不再丢失
  或抢回前台，也会清理无引用缓存。关闭、激活、文本回写和原生退出保护的异步
  边界均改为串行并重新读取最新状态。`2ba0195d` `cd4729a4` `a06da8ab`
  `14e3eac5` `ca38146e`

- **病态 PDF 的导入与导航成本被限制。** Callout reply 和 FreeTextCallout 改为索引
  查找，单条注释的文本、数组和墨迹点数有硬上限；部分导出会把数值型 destination
  从源页序号正确映射到目标页序号。`5621ec93` `aef751a5` `4627aaaf`

- **大工作区的主线程热点被移除。** 标签规划在排序后线性折叠；大 Markdown 输入
  不再每次按键编码整篇文档；工作区元数据写入合并到 250 ms，并在 pagehide / 卸载
  时同步收尾；Live 摘要用堆选择最近 200 条，而不是完整排序。`c9592fec`
  `fff202d6` `a6750027` `4ebe2479`

- **运行时存储和文件夹扫描的预算覆盖真实工作量。** 挂起 PDF 的模型与撤销历史
  现在计入 1 GB 上限；原生文件夹列举在扫描阶段就截断，并移到 blocking worker，
  不再先遍历和排序任意宽目录后才裁到 5000 项。`99effe4f` `023dadc8`

对 26.7.31 候选做了一次全面审计（62 条原始怀疑，45 条经对抗验证成立），随后是
四轮修复与独立复审的往返。下面按影响排序。复审发现的问题在正文里标注为
"复审补" —— 那些是第一版修复本身不成立或不完整的地方。

### 数据丢失

- **粘贴图片会删光文档的全部超链接和表单域（含已填值）。** `appendIncomingPdf`
  用 `mode:"none"` 造合并基底，而那是导出对话框里用户选的 "Original only"，
  语义是整删 `/Annots`。链接从不进 overlay 模型，所以 app 内没有任何恢复路径。
  修法不是给 `none` 加例外，而是给内部合并一个专用入口 `exportMergeBase`，
  它不接受 `mode`。复审补：`Pick<>` 只约束对象字面量，一个声明为
  `ExportOptions` 的变量照样能穿过去且被原样转发——补 `mode?: never` 和
  逐字段投影两道。`50ad06b1` `52836f27`

- **合并期间的编辑会被旧快照覆盖。** ownership 只比 generation / tabId / hash，
  而在同一 tab 上新增标注不改变这三者。改为同时持有 model 对象引用
  （`store.commit` 每次换新对象，引用即 revision）。复审补两次：guard 校验的
  model 和合并实际消费的 model 不是同一个对象（等于自己跟自己比）；以及
  `activeTabId`/`activeHash` 仍是闭包值，排队的第二次粘贴拿合并前的 hash 去比
  合并后的 store。`a9614fe0` `52836f27` `77e1b8aa` `68a259fd`

- **连续粘贴两张图会静默丢掉一张。** 两次合并各自抢 open generation，后者取消
  前者，没有任何提示。改为串行化（用户要的是两页都进去）。复审补：串行化后
  第二次合并会把页面投递到用户中途切过去的**另一个文档**并报成功——目标 tab
  是按下粘贴那一刻的意图，不该在出队时重新解析。`0e118a75` `d259f506`

- **首页拖入一批文件，其中一个读不了就会中断整批**，且是唯一没有逐文件
  catch 的入口。`a7e91106`

### 状态恢复

- **导出记录在退出和恢复两条路上都会丢。** 导出只写 React state，唯一把它落到
  tab 的写入者在切 tab 时才跑；恢复时 `finalizeOpen` 又清空且无人回灌。结果是
  已导出的文档每次重启都报"未导出"，关闭时弹假警告。复审补：加密文档解锁后
  重进 `handleBytes` 会再清一次——回灌点移到所有路线的唯一汇合处。
  `342ac5fd` `f199b00b` `cccdd4f0`

- **桌面端除密码外的所有 unavailable tab，"重新选择"都是死路。** 选中同一个
  文件会命中那个坏 tab 然后早退，无对话框无提示。web 一直有带 tabId 的重选，
  桌面和移动端缺这一半。`42ea88c1`

### 本地服务发现

- **第二个实例覆盖门牌后崩溃，第一个实例永久失联。** 门牌全局只有一份，CLI
  读到死 PID 就报错——识别是对的，缺的是自愈。每个实例改为额外写
  `live-api.<pid>.json`，CLI 扫描后接上唯一存活者、清掉死的、多个存活时明确
  要求指定。复审补：PID 会被复用，所以"活着"不等于"是 Shiori"——连接失败时
  再发现一次；且重试路径原本会在多实例时静默任选一个。`f2c3e39c` `53115768`
  `739f40ca`

### 交互

- **HTML 文档的触控板缩放会失控冲到上限。** 监听器 effect 依赖 `zoom`，而它
  正是产生 zoom 变化的那个——每一步都自我拆装，teardown 清掉手势基准，下一次
  缩放就以已放大的值为基准累乘。触屏路径则是指针表被清空后一步冻结。
  复审补两次：iframe 重载会留下失效 pointer；`loadTick`（慢资源的迟到 load）
  会在 pinch 中途清基准。`6b050e8d` `f3591b15` `435ab630`

- **缩略图右键菜单和标签溢出菜单的 Escape 会漏进 Canvas**，顺手把 armed 的
  标注工具重置成 Select。两者各写了一套只 `preventDefault` 的监听器，改为走
  统一的 overlay 栈（capture 阶段 + 停止传播）。`764ba0c1`

- **键盘焦点会掉到 `<body>`**：右键菜单关闭不还焦点；页面操作按钮在活动页
  变化时卸载。两者都让缩略图栏的方向键导航失去起点。`3d447194`

- **内嵌终端的滚动条没走应用的滚动条约定**，是一条方角、常驻、全宽的系统条。
  颜色改用 xterm 自己的 ITheme slider 字段（跟随终端主题），圆角与内缩用 CSS，
  两处都复用缩略图栏的参数。`cfbc71ef`

### Live 通道

- **中日文重标注文档会整个废掉 agent context。** 前端按 UTF-16 code unit 记
  预算，`live_api.rs` 按 `String::len()`（UTF-8 字节）记，CJK 差 3 倍：实测
  200 条中文标注产出 117,290 字节，撞 65,536 上限被 native 整个拒绝，前端只有
  一条 console warning。`46b81795`

- **摘要截断丢的是最新的标注**，而追问几乎总是关于刚写的那条。改为从新往旧
  填、按文档顺序输出。`9fa301c8`

- **注入终端的追问文本未中和。** 反引号和 `$( )` 在 agent 已退出、会话回落到
  shell 提示符时会被求值；控制字符原样透传给终端渲染器。`1707bc7a`

### 平台

- **导航栏的"+"在三个平台上说谎。** 标签写着"添加文档或文件夹…"，但只有
  macOS 的 NSOpenPanel 能在一个对话框里混选两者——Windows 的 IFileOpenDialog
  和 GTK/portal chooser 是二选一。修法是让标签说实话，不是加第二个入口：
  分类目标是 app 的职责，不是读者的。文件夹在各平台继续通过拖放、文件关联和
  argv 进入。`d2282c03`

- **Web 上拖入文件夹是无声的空操作**，而三语文案 `mountUnsupported` 早就存在、
  从未被渲染过。`a7e91106`

- **原生 intake 监听器每次按键重装。** 文件关联和移动端 share-intent 两个
  effect 依赖每次渲染都换身份的回调，在 Markdown 里打字会导致每秒数百次
  unlisten/listen + `drainPendingOpenPaths()`，且每次都有一个从 Finder 打开的
  文件恰好落在两者之间被丢弃的窗口。`59f502a9`

### 工具链

- **`skill:sync-public` 的 remote 校验能被相似域名绕过。** 后缀正则把
  `evilgithub.com/Nagi-ovo/shiori-releases.git` 也判为合法。改为解析后精确比对
  host / owner / repo，覆盖 https、ssh:// 与 scp-like 三种形态。同时把
  `main()` 收进 `import.meta.main`——导入该模块做测试会真的执行一次同步。
  `d8f92d69`

### 新增

- **锚定持久化（P2a，agent-native 计划）：文本锚定的标注现在把锚记在身上。**
  此前 anchor 在 `parseAnnotationSpec` 之前就被解析成坐标丢弃（"parser 从不见
  anchor — by construction"），落地的 overlay 只有几何——「文档重排后批注仍指
  原句」无从谈起。现在 `OverlayCommon.anchor = {quote, page, occurrence}`
  （quote 为**实际命中**的文本，非请求原文；occurrence 为页内序号）持久化进
  overlay。实现为 side-channel：resolver 经 `onAnchorResolved` 回调吐出证据，
  parse 之后 `attachResolvedAnchors` 按 index 附着——spec 字节、公共 schema、
  parser 严格性、operation id 推导全部不动。CLI 文件模式与 Live bridge 两路
  均接线；导出写入 SHIO 私有字典 `Anchor:{Q,Pg,Occ}`（callout 并入既有 dict，
  markup/note 新建 `{V:1}` dict），导入经 raw pdf-lib pass 按 pdfjs id 接回，
  草稿随整模型自动携带。防御性语义：`operationOverlayShape` 排除 anchor
  （旧 build 落的 overlay 重试不误报 OPERATION_CONFLICT）；
  `cloneOverlayWithId`（粘贴/duplicate/alt-拖）剥离 anchor——副本不在锚定
  文本上，继承即说谎；导入侧 quote 上限 8192 字符，畸形锚降级为无锚。

- **P2a-2：in-app 划选创建的标注也捕获锚。** `occurrence` 放宽为可选
  （划选时算不出诚实的页内序号，宁缺勿假；SHIO 的 Occ 条件写入，import
  侧 Occ 缺席合法、存在则必须 ≥1 否则整锚降级）。划选建 highlight/
  underline/strikethrough/callout 时记 `{quote, page}`（quote 截 2048 字符，
  超长跳过）；工具划选与长按弹窗（`applyMarkupToCurrentSelection`）两条路
  都接。诚实性三规则进 `applyHighlightGesture`：跨栏聚类被过滤时不捕获
  （文本会大于几何）；手势与既有高亮**合并**时新旧锚一起丢（合并结果
  覆盖的文本超过任一来源的主张）；擦除/异色裁切**重塑**了某 overlay 的
  几何时其锚同步剥离。尚未做：加载时重解析（P2a-3）。

- **P2b-1：callout 线程数据层——引线批注可以承载多轮对话了。**
  `CalloutOverlay.thread?: CalloutThreadEntry[]`（`{id, role: user|agent,
  author?, text, at?}`），根 callout 的 `text` 仍是第一条消息（兼容不变）。
  导出：每个 turn 展开为标准 `/IRT` Text 回复（`/RT R`，同页，挂在根 callout
  ref 上）——Acrobat 原生渲染为评论线程，pdf.js 把 R 回复并进父 popup 不另画
  图标；角色进 SHIO `{V:1, Kind:"Reply", Role, ReplyId}`；agent turn 写 /T
  （author），user turn 不写 /T（沿用「不替用户发明作者」原则）；`at` →
  CreationDate/M。导入：raw pass 认出自家 Reply 元数据，pdf.js 侧的对应
  note 折叠回父 callout 的 thread（顺序=Annots 顺序=导出顺序）；**父被外部
  删掉的孤儿回复降级为独立 note 保内容**；外部工具写的普通 /IRT 回复行为
  不变。`cloneModel`/`cloneOverlay` 对 thread 深拷贝。flatten 模式下 thread
  与其他评论一样不入画（视觉快照语义）。

- **P2b-2：callout 线程 UI——选中引线批注即展开对话面板。**
  `CalloutThreadPanel`（卡片的兄弟节点：卡片 `overflow:hidden` 驱动收印
  morph，面板放里面会被裁掉；wrapper 复制卡片几何与旋转，旋转页也贴合）。
  仅选中/编辑时显示——打印与导出仍只有标签，阅读密度由印章机制负责。
  轮次显示角色（agent 显 author，用户显「你」），锁定的 callout 只读不给
  输入框。回复框**非受控**（沿用 `collapseCallout` 读 DOM 的先例；happy-dom
  下 React 受控 onChange 不触发，真浏览器行为一致），Enter 发送、
  Shift+Enter 换行、IME 组合中的 Enter 不发送（`isComposing` 判断，中文
  日文输入安全）；追加走 `onCommitEdit({thread: [...]})` → `updateOverlay`
  = 可撤销。测试发现并记录：本 DOM 测试环境键盘事件只送达聚焦元素。

- **P2b-3：agent 可以往 callout 线程里写回合——对话闭环的 agent 侧打通。**
  spec 新类型 `calloutReply {replyTo, text, author?}`，**仅 live**（`shiori
  app annotate --spec`），不可与其他类型混用；纯 reply spec 在 bridge 内
  `prepareLiveAnnotationRequest` 的 parse 之前分流（`calloutReplySpecAnnotations`
  → `prepareLiveCalloutReplies`），产出与 overlay 路径相同的
  `PreparedLiveAnnotationRequest`——deadline、原生授权、receipts、
  remote-write 提示全部复用，**wire 协议零改动**（spec 在线协议里本就是
  不透明 JSON，Rust 侧无感）。幂等：turn id 由 operationId+index 派生，
  丢响应重试发现自己的回合已在线程上→added 0。提交时选中目标 callout——
  选中即展开对话面板，**agent 的回复落地瞬间用户就能看见**。文件模式给
  精确报错（live-only 指引）；`shiori help spec` 增补 calloutReply 文档；
  skill 说明书教 agent「用户在 callout 里追问就回 calloutReply，别开新标注」。

- **P4：追问回路——面板追问注入内嵌终端 stdin，对话闭环收口。**
  `src/live/followUpLoop.ts`：终端会话注册表（RightRail spawn/exit/清理
  三处接线，most-recent 优先），用户回合落线程后
  `sendCalloutFollowUp` 把单行格式
  `[shiori] Follow-up in callout <id> (page N): <text> (answer via
  calloutReply)` 写进 pty（`\r` 提交；多行压平——嵌入换行会提前触发
  prompt；4000 字符封顶）。注入的行在终端里明着可见，无隐藏通道；
  没有活跃终端时 toast 提示一次，追问仍在批注上，零丢失。
  MCP 方案维持否决（通知唤不醒空闲 agent，见 plan P4 节）。
  测试环境坑：`platform/index` 经 embeddedTerminal 链在模块加载期读
  `__APP_VERSION__`，独立单测需先 import `test/setupDom`。

- **P1e：Ctrl+Tab 卡片切换器（macOS Cmd+Tab 式）。**
  `WorkspaceSwitcher.tsx`：按住 Ctrl 连按 Tab 在 MRU 前 6 个 tab 间循环
  （active 恒排首位，其余按 `updatedAt` 降序——对照阅读九成切换是两文件
  往返，按一下必须回到上一个），松 Ctrl 落定、Shift 反向、←→/Enter/Esc、
  hover 即选、窗口失焦自动收起（防 Cmd+Tab 切走后 overlay 卡死）。
  缩略图走 recents 已有的 page-1 缓存帧（`recentEntryKey` 对齐
  path/handle/cacheId/title），无帧时落 kind 徽章——审查决议「缓存帧,
  不做实时渲染」。终端聚焦时完全让路（`.xterm` 内 activeElement 直接
  return——agent 会话里的 Tab 不能被劫持）。切换动作复用 TabStrip 的
  `activateLoadedTab`，行为与点 tab 完全一致。上限 6：再多该走大纲树
  （P1a），硬塞只是把不可读的 tab 条换件衣服。

- **P1a：左栏合并成一个「导航器」——文档 / 页面 / 标记三视图共用一条 gutter。**
  此前缩略图栏和文档列表各占一条侧栏，窗口再宽，正文也只拿到中间剩下的那条。
  三个视图现在并进同一列（`c92d7e5`），视图切换出到图标栏（`beeee71`）、后来
  又折进导航器自己的 header band（`4694f97`）；PDF 大纲从右栏搬进导航器
  （`65383ee`）；标记不再挂在文档节点下面，升为独立视图（`287eb60`）。文档
  视图是真正的树：文件，以及文件里有什么（`dc78c17`）——行重做成单列、只截断
  一样东西（`42a7c60`），kind 标签贴右边（`0ba9c65`）并跨两个列表对齐
  （`543f25c`），hover 预览从 tooltip 换成卡片（`52788bd`，`2366cdf` 修掉裁
  切并画出真的树形结构）。header band 改为每列自己的 header 而不是横跨全窗
  的 banner（`9adb014`），形状跨视图固定（`fb2f686`），且不再重复写视图名
  （`f548b8b`）。上下文工具栏与 tab 条一并移进文档列（`9057ff2`、`c60c9e6`、
  `9ca9a7a`），右栏也变成整列（`41dd7f7`），便签 tab 下架（`bf5ca2e`，并给
  空右栏加保护）。文档视图拆成「工作区 / 未归档」两段，附显式的 pin
  （`9e4e1e2`）；导航器不再画那个没导出过的小圆点，行也不再在 hover 时位移
  （`a08f4fe`、`dcd260e`）。

- **可以把一个真实文件夹挂成工作区。** 原生侧选文件夹并列出一层
  （`db70113`），挂载后它就是导航器的工作区（`dcd260e`）；取消挂载从行内按钮
  移到右键菜单（`8e332cc`），并补上键盘可达的关闭路径（`bbdcd59`）。成员判定
  不再假设 POSIX 分隔符（`d45e137`），「是不是 Windows 路径」只认盘符或 UNC
  前缀而不是见到反斜杠就算（`d8e00f9`）。

- **右栏可以同时开好几个终端。** 会话列表化（`dd8239c`），并配合 P4 的注册表
  按最近使用挑注入目标。

- **P2c：agent 读得到批注正文了。** 此前 app context 只报几何与类型，agent
  能写不能读，「先看看页面上已有什么」无从谈起；现在批注正文进 context
  （`cde1c1d`），实现锁定的三条约束记在 `9bc4c5a`。

- **shiori CLI 配套的 agent skill。** 把 CLI 的用法、spec 写法与「用户在
  callout 里追问就回 calloutReply」的约定打包成 skill（`f4c901f`），agent 不
  必靠猜。

### 变更

- **草稿改为静默恢复，不再每次打开都弹窗。** 判断标准从「有没有草稿」改为
  「有没有冲突」：草稿就是用户的当前状态，打开即恢复；状态栏出现常驻提示
  「已恢复 N 前的编辑 · 用原始文件打开」。「用原始文件打开」把草稿**搁置而
  不删除**（进入原 deferred 状态：autosave 挂起、Live not-ready），此时编辑
  才会弹出旧对话框——它从「每次打开必弹」降级为「仅覆盖冲突时出现」。
  开原始文件的入口只在恢复后未编辑时显示（`model === committedModel` 引用
  判等）：一旦编辑，磁盘草稿已领先于开档快照，此时切基线会静默丢新编辑，
  且基线本就一步 Undo 可达。新增 store action `restoreBaselineModel`（换到
  基线并清空历史——若保留历史，Undo 回草稿态会立刻触发覆盖冲突重弹）。
  状态栏不再显示「未产生草稿」（实现细节泄漏，删除 `drafts.notSaved`）。
  P0 于 docs/PLAN-agent-native.md；冲突检测（外部改动过的文件）是 P0b，
  依赖尚不存在的 path→hash 映射，本次不含。

- **缩放改为一次成像，且再不会露出被清空的 canvas。** 此前一次缩放要经历
  「清 canvas → 重排 → 重画」，中途有一帧是空白页；改为画完再换（`fa70a65`），
  同一提交里把缩放从「让 App 整体重渲染」摘出去。右栏的 React 挂载点改为连续
  存在（`c42b393`）——此前它随文档切换反复卸载重建，终端跟着重开。

- **拖动面板宽度改走 DOM，跟手不再慢半拍。** 拖拽期间冻结列宽、把更新合并到
  帧（`b3993b6`），随后整条路径彻底绕开 React（`0f1c396`）；终端的 refit 延到
  拖拽结束再做（`90f85cd`），拖动过程中不再每帧重排字符网格。窗口 resize 只在
  尾沿重新 clamp，而不是每帧（`96e7d8e`）。

- **页面在栅格化的过程中显示自己上一帧的模糊图，而不是空白纸。** 一页栅格化约
  62ms，快速滑动总能跑赢虚拟化的预取；现在先铺一张缩小过的上次成像
  （`8c75cf5`），并且优先显示这一页本身而不是它背后的底色（`68ce009`）。

- **tab 条重做：标签就是它的标题。** 从「压扁成小方块」改为按标题定宽、多出来
  的折叠收纳（`293e57d` → `1e68059` → `40545c0` → `bbc0130`，最后一步同时去掉
  标签之间的分隔细线），tab 条本身也拍平了一层（`c4a788f`，并修掉一处漏 key
  导致直接显示英文原文的 bug）。

- **换成原生滚动条，三条接缝线收成一条（`9f54e4d`）。** 工具组去掉胶囊背景、
  去掉快捷键小标签，选中态改为安静的表达（`17f7eb6`）。图标全部按 24 网格重
  画，并停止一个字形到处复用（`6429e07`）。批注预设配色整体调向复古文具
  （`2329e03`），对话面板按「它画在纸上」上色而不是按窗口 chrome（`e27b274`）。
  缩放控件钉在工具栏可见的那一边（`cb7749f`），右栏打开时把它的位置还回去
  （`caa2574`）。检查器行的空档收掉（`2734253`），文字默认值放回它自己的色板行
  （`0b9209b`）。

### 修复

- **「适应页面」下架（`241ff5d`）。** 文字工具的提示词解释的是另一回事，删掉
  （`83d7e6a`）。

- **对话面板：可以折叠，回合可以删除（`41f807f`）；面板不再跑出页面
  （`0c2a92f`）。** 追问回路修了三处：面板点得动、提交是真的提交、注入终端的
  那行人能读懂（`bdea641`）。

- **不再无视用户实际在用的终端、一律预选 Apple Terminal（`28e7ce5`）。**
  反馈链接指向了错的 Featurebase org（`fd52b61`）。

- **右栏在切换文档时被关掉——修了三次才真正修完。** `e6ccc6e` → `4ac57c7` →
  `38578f6`（最后一次连同三条路径一起用测试钉住）。另有一处只在某个分支里挂载
  chrome、其他分支欠着的问题（`4f72fbb`）。

- **窗口变窄时的一批布局问题。** 阅读区变窄时页面跟着缩小，并修掉一处 render
  阶段的 setState（`553be1e`）；工具栏在侧栏压窄它那一行时可以滚动
  （`277b7ec`）；两侧 gutter 改为对同一个窗口宽度做预算并在 resize 时重新
  clamp（`fc85198`），web 端侧栏的 tab clamp 不再和 App 的打架（`1f85f3b`）；
  纯文本文档也预留侧栏宽度，而不只是有页面的 PDF（`5f6d9dc`）；工具栏行在收起
  再展开后重新 observe（`cd63c1b`）。浏览器的空白框跟随主题，侧栏拖拽把手放进
  自己的盒子（`deebf4d`），侧栏 header 与文档 chrome 对齐（`4fba749`）。

- **文件夹菜单的 Escape 只作用于菜单自己（`d717b3a`）。** 切换器的页码补上
  本地化，带数量的字符串补上复数形式（`0832523`）。一次 unlisten 失败不再让
  整个 teardown 的其余部分半途而废（`d90c18d`）。文本 tab 存回后刷新内容
  哈希（`ea0c397`，P1d 的前置）。

---

## [26.7.27]

> 自 0.1.25（2026-07-07）以来 154 个提交、305 个文件。主线是三块：Shiori CLI +
> Live API（让 agent 能读写正在打开的文档）、Markdown 从「能看」变成「能编辑并存
> 回原文件」、以及一轮 ship-readiness 审计带来的保真与安全修复。

### 新增

- **Shiori CLI + Live API：agent 可以读写「正在 Shiori 里打开的那份文档」。**
  桌面端起一个本地 Live API（Unix socket / named pipe，仅可信 webview 可调
  用），CLI 通过它对当前打开的文档下批注，不经过磁盘往返。命令面：
  `shiori inspect` / `search` / `annotate` / `render` / `app ...`。写入按
  operation id 幂等，冲突映射 HTTP 409，响应体积与墙钟时间双重设限，输出经过
  控制字符剥离；accept 循环改事件驱动，瞬时 accept 错误不再拖垮服务，webview
  销毁时清理上下文，owner 死亡后回收泄漏的 pending 槽位。CLI 与 bridge 共用同
  一套 live operation 规范化逻辑，并有跨语言 wire type 契约测试。
  (`21cfd66`、`9868bf1`、`991a9ed`、`ce9ea07`、`1b339ef`、`45d8ccb`、`584d39e`、
  `45ee64d`、`8e77b2c`、`003f150`、`9e3d594`、`e5ed525`、`b343322`、`258ca93`、
  `618758b`、`48c5c76`、`627e856`、`9965659`、`ecb7d6c`、`8180ed5`、`aa7f753`、
  `056ec68`、`b35ee57`、`cb92635`、`f3d116d`)
- **引用锚点（quote anchor）：批注按「原文是什么」定位，而不是按坐标。**
  spec 里写 `anchor: { quote, page?, occurrence? }`，Shiori 自己在文档里找到这
  段文字并算出全部几何。匹配忽略大小写、归一化空白（CJK 同样支持）；0 个或多个
  命中会带候选（页码 + 第几处）报错而不是猜。支持 highlight / underline /
  strikethrough / note。配套 PDF-space text-run 几何、跨行匹配、字形带对齐、
  过期锚点搜索中止与内存上限。(`bc54967`、`cd969a9`、`0ce92f5`、`8a26342`、
  `c4704c3`、`2bade16`、`15a33c4`、`c65e100`、`ed21f23`、`13b1766`、`cf46729`、
  `94642d9`、`11b80a1`、`e1fe84d`)
- **`shiori app annotate --highlight "原文"`：一条命令标一句话。** 不写 spec 文
  件，flag 可重复（上限 16，与 `--spec` 互斥），内部合成无版本号的锚点 spec；构造
  时键序固定，同样的 flag 组合推导出同样的 operation id，重试安全。
  (`5e86119`)
- **`shiori render`：把一页 PDF 光栅化成 PNG。** 给扫描页和图表这类「文本和搜索
  都无话可说」的页面兜底，用 pdf.js 自带的 node canvas 路径，源码版 CLI 零新依
  赖。`-o` 强制要求（渲染结果是文档内容的完整副本，绝不能落进隐式缓存），
  `--scale` 默认 2 并按 app 的画布像素预算钳制。打包的 SEA 二进制暂未内置原生
  canvas，会稳定返回 `ERR_RENDER_UNAVAILABLE` 而不是裸 require 栈。(`f6c1d79`)
- **`shiori help spec`，且所有 annotate 文档以锚点开头。** 起因是原始 agent 会话
  靠一次次 `--dry-run` 报错反推 schema。(`7f653e6`)
- **Live 批注按人类节奏回放。** CLI 写入的批注不再瞬间出现，而是按书写轨迹分批
  绘制；每批可独立撤销，回放严格串行，回执独立于草稿持久化。(`298137a`、
  `b690158`、`eab22e0`、`cdc2515`、`e7831e3`)
- **外部终端启动器。** 可在系统自带终端里打开当前目录，记住上次成功选择的终端
  App，重复启动有防抖；使用已安装终端的真实图标；Command Prompt 拒绝不支持的
  UNC 路径。(`1069577`、`48e6945`、`c9d80d1`、`1b488f2`、`cd16a7d`、`62dc6ea`)
- **Markdown 编辑可以存回原文件。** 此前编辑只写进 app 本地工作副本，磁盘上的文
  件原封不动且界面毫无提示，⌘S 还会落到 PDF 导出对话框。现在 ⌘S（以及仅在有未保
  存修改时出现的保存按钮）把文本写回来源：桌面走新增的
  `write_text_document_at_path` 命令，浏览器走 File System Access 句柄。
  (`be83832`、`f31f1cb`)
- **Markdown 阅读外观控制。** 正文字体 / 代码字体 / 标题颜色 / 字号 / 行高 /
  内容宽度可调，并有对比度安全的标题配色。(`1fbe978`、`c7bd5d7`、`5d3f750`、
  `c1836c7`)
- **自定义主题色与自定义纸色，新增 Everforest 纸色。** 两者都做了对比度安全钳
  制。(`2cab769`、`f016f6a`、`e9d8252`、`420b2b8`)
- **Windows / Linux 原生窗口菜单栏。** `build_app_menu` 及其 `set_menu` 调用点
  原本是 macOS 专属（`#[cfg(target_os = "macos")]`），其余桌面平台没有菜单、所有
  快捷键只挂在 JS keydown 上；现在放宽到 `#[cfg(not(mobile))]`，四个 Cocoa 专属
  条目单独分支。(`0b5777a`)
- **窗口位置与尺寸跨启动记忆。** 接入 `tauri-plugin-window-state`（仅桌面）；
  刻意不保存 VISIBLE——隐藏状态下退出的窗口下次必须重新出现。(`f14c4c8`)
- **批注可以收起成一枚印章。** 收起后是 24px 实心圆（批注色 + 纸白外圈 + 文字首
  字素簇），圆心与原标签框**同心**——`calloutConnectorGeometry` 的两个端点都由标
  签中心推导，圆心不变 ⇒ 箭头端逐位不变、起点沿同一条射线外移，引线只变长不改
  向，多出的一段正好落在旧卡片覆盖范围内，而 DOM 层画在 SVG 层之上，于是收起时
  引线是「从缩小的卡片底下让出来」的：不需要 path 插值，也不需要动画库。展开方向
  引线需滞后一个过渡（`useCalloutLeaderCollapsed`），否则印章与线之间会露缝。收起
  是纯展示状态（`collapsedCalloutIds`，照搬便签那套），不进模型 / 撤销栈 / 草稿 /
  导出；缩略图刻意不接入——那个 compositor 与 `compactRasterPdf` 共用，属于导出路
  径。(`d048058`)
- **单击页面任意位置即可创建批注。** 此前只能选中文字或拖框，图表、公式、扫描件
  这些最值得批注的东西反而没法指。现在批注工具下单击 = 指向该点（12pt 见方的目
  标）。有文字层的页在 pointerdown 记的是 text gesture、无文字层记的是 drag
  origin，判定「单击」时两者都读。(`96ff6eb`)
- **官网：CLI 安装动画与多语言 PDF 批注演示。** (`e0b9435`、`d5d4f88`、`eefba87`、
  `291d994`、`76943e2`、`35d948c`、`a3ea62a`、`153eb1e`、`e449af7`)

### 改进

- **工具栏重组。** 矩形并入「绘制」组（与画笔同组）、签名与印章并入「签章」组、
  便签工具从工具栏下架、callout 更名为朴素的「批注 / Comment」；无保存签名时签章
  组的印章模式仍可达；工具检查器在墨迹与矩形之间高度固定（移动端同样），标签快要
  换行时先丢掉键盘提示而不是压字。(`4f9da24`、`16d7635`、`6e842d5`、`44c0ca7`、
  `36cb421`、`d7bbaa8`、`8c5aca3`、`924b773`、`2c54c48`)
- **文字选区用工具将要施加的颜色着色。** 拖选时就能看出高亮会是什么颜色。
  (`ae31bc0`)
- **批注框不再压在正文上。** `placeCalloutLabel` 原本只知道被引用的矩形和已有批
  注框，8 向环形候选经常把 144pt 的卡片停在正文段落上。现在接入 `paragraphsRef`
  的逐行几何（display px @ `layerScale`）作为第三类占位。打分全部改为无量纲：覆盖
  率按**候选自身面积**归一、位移按页面对角线归一——否则 ~60 个行盒按原始面积计分
  会盖过「跑出页面」这条最强信号。新增 `verticalMiss`（权重 2.6）是「批注贴在它标
  注的那行旁边」的数值化表达。文字几何已知时追加候选：两侧页边（全宽 + **收窄到页
  边空白实宽**两种）、以及整个文字块**外侧**的上下空白带——只取外侧，页面中部的文
  字空洞几乎都是图表，而本仓库没有图片区域提取。无文字几何时候选集与之前逐字节相
  同。(`075e9ad`、`8acb3fe`)
- **批注框贴页边时自动收窄，并按文字自动长高。** 收窄到正文栏旁空白的实际宽度
  （Letter 一英寸页边 = 62pt，LaTeX article = 123pt），低于 54pt 不提供。高度在输
  入时跟随文字：直接量渲染中的 textarea（先把 height 收到 0 再读 scrollHeight，否
  则只能测到变长测不到变短），上边缘固定（PDF y 向上 ⇒ 保持 y + h），高度并入该次
  按键已开启的历史步骤。(`8acb3fe`)
- **选中手柄改成圆点。** 原本是 7px 方块 + 深墨色 1.2px 描边，像贴在纸上的对话框
- **签名板有了签名引导线，清除 / 保存按钮换到更顺手的位置。** 空白签名板画一条淡
  横线作为「在这儿签」的暗示，落笔即消失；清除 / 保存从签名板下方移进「已保存签
  名」那一行的右端，底部不再左右各空一块。(未提交工作区改动，随本版发布)
  控件；改为 8px 圆盘 + 发丝级 rule 色描边 + 极淡投影。(`db05e32`)
- **便签折叠状态更稳。** 折叠后的便签可直接拖动而不会误展开，折叠状态跨页面旋转
  与重载保留，折叠控件对键盘与读屏可达。(`ed7722a`、`dc317e1`、`cc8dd31`、
  `b3115a0`)
- **应用外壳默认不可选中。** 根级选择策略 + 缩略图栏不再被卷进 PDF 文字选区；阅读
  器 chrome 抑制浏览器右键菜单；交互 chrome 有统一的 focus-visible 焦点环。
  (`a51dc7e`、`4c066d1`、`92fe2bb`、`5761aad`)
- **栞 品牌标记改为矢量绘制**，不再依赖字体字形，并在 ShioriTile 里垂直居中。
  (`0ecb634`、`53f5be3`)
- **终端不再否决窗口尺寸。** 内嵌终端从「窗口不能小于我」改成自己让位。
  (`2b2d686`)；缩放时不再触发重绘风暴（`2006221`）。
- **安全加固。** app 命令限制在可信 webview 才能调用（`3a3271e`）；升级有漏洞的
  文档解析依赖（`e633437`）。
- **内部结构。** App God-component 按职责拆成 hooks（appearance / auto-update /
  shortcuts / draft / live bridge / document intake / workspace persistence /
  dialogs），DocumentViewer 与 TextHighlightLayer 的纯几何与同文件组件拆出去；
  接入 tauri-specta，让 Rust 命令签名成为 IPC 契约的唯一来源。
  (`11d2ef3`、`5d6721f`、`b870ee8`、`d4537a4`、`42ba308`、`0a900f7`、`9cfbec4`、
  `d44223f`、`c7a96f2`、`07583a3`、`84839cc`、`482f03d`、`3ff10c2`、`980c28c`)

### 修复

- **90° / 270° 页面旋转映射左右颠倒。** `coords.ts` 把 rotation 90 用成了 pdf.js
  的 270 矩阵，反之亦然。canvas 走 `page.getViewport({scale, rotation})`、覆盖层走
  `coords.ts`，两边读同一个 `page.rotation` 且无补偿变换，于是旋转页上每一个高亮 /
  便签 / 墨迹 / 矩形都偏 180°（关于页心点对称）。文件自带 `/Rotate 90|270` 的页
  （扫描件、横版）一打开就是错的；在 app 内旋转后画的标注屏幕上看着对，存下来的坐
  标却是镜像的，导出后偏 180°。(`38e32e4`)
- **导出会静默丢弃源 PDF 的一部分。** 导出用 `PDFDocument.create()` 重建文档，没
  有显式搬运的东西一律丢失，而这四类丢失在导出当时都不可见：加密源文件
  （`ignoreEncryption: true` 能解析但不解密，密文内容流被复制进一个没有 `/Encrypt`
  的文档，页数和 `/MediaBox` 都对，完整性断言通过、界面显示「已保存」、脏标记清
  除——而磁盘上的文件已经坏了）等。(`db84cbf`)
- **Shiori 不能编辑的批注不再消失。** 页面 canvas 原本以 `AnnotationMode.DISABLE`
  渲染，为的是避免导入的批注被画两遍；但 DISABLE 是全有全无的，连 Shiori 不导入、
  仅在导出时原样保留的批注也一并抹掉——Preview 的箭头、椭圆、多边形、图章、附件、
  表单域在屏幕上凭空消失，文件里却还在。改用 `ENABLE_STORAGE`，并让导入器为自己接
  管的批注写入 pdf.js 自己的 `{ noView: true }`。(`3426d6a`)
- **导入 / 导出往返的批注保真。** FreeText 的控件与富文本样式在 pdf.js 往返后保
  留。(`7fd3b98`、`a64d81a`、`c57895e`)
- **草稿自动保存在存储压力下会丢工作。** 三个存储层缺陷，症状都是「我的修改没
  了」。其一：启动时删掉了崩溃恢复日志——而它是唯一的副本。一次编辑 250ms 后写
  localStorage op-log、800ms 后才写 IndexedDB 草稿行，这个窗口里「有日志没草稿行」
  **就是**用户的工作，正是第二层要救的那种崩溃，`cleanup()` 却把它当作陈旧证据在下
  次启动清掉；靠时间也分辨不出来：崩溃前 500ms 写的日志，用户一周后回来看就是一周
  前的。(`525a1b7`)
- **工作区标签状态跨导航与重启保持诚实。** (`0130ac1`)
- **手势与按键不再提交用户没做的编辑。** (`6df54a9`)
- **桌面对话框里选中的多个文件会全部打开**，不再只开第一个；冻结的历史不再被反复
  重新测量。(`e2f468b`、`cd69e34`)
- **macOS 菜单栏本地化**，且桌面端 PDF 写入改为原子写。(`5ab22a1`)
- **危险操作与禁用状态的 UI 表述变诚实。** (`3be2c21`)
- **补齐漏翻译、仍以英文暴露给用户的字符串。** (`2fd34bf`)
- **CLI 失败从静默 / 未分类变为明确。** (`9f0d40e`)
- **拖拽缩放批注框时卡片滞后于指针。** 收起/展开的过渡把 `left/top/width/height`
  无条件纳入，而这四个值在每一帧缩放拖拽和每次页面缩放时都在变，于是卡片用 190ms
  缓动追指针，而没有过渡的引线跟得死死的。现在几何过渡只在收起/展开真正进行的那
  190ms 内启用（`useCalloutDisclosureMorph`）。(`db05e32`)
- **PDF 搜索的版面与几何契约加固**，跨行匹配更准。(`d031679`、`2bade16`)
- **签名对话框的导入按钮与姓名字段对齐。** (`f539f19`)
- **官网导航、打印与无障碍缺陷。** (`0510136`)

---

## [0.1.25] — 2026-07-07

### 新增

- **草稿撤销历史跨会话保留。** 自动保存把内存 undo 栈一并落盘（最新 50 步 且 序列化 ≤10MB，先到为准；字节护栏防内联签名 dataUrl 在每步快照重复膨胀），恢复草稿时灌回为撤销目标：关掉 app 明天重开，仍能一步步退回昨天的编辑。历史随 model 过同一套页面 reconcile、计入 LRU 存储配额；旧格式记录读回空历史不崩。Dexie 免版本升级（非索引字段）。实测最坏现实体积 3.6MB / 每次保存核算 8.6ms。(`c8d3495`)

### 改进

- **手写笔画落盘前简化 + 量化。** 笔画落入 PDF user space 时跑一次 RDP（0.4pt epsilon）+ 2 位小数量化：实测单笔 600→122 点、27.5KB→2.9KB，最大几何偏差 0.399pt（<0.14mm，肉眼不可分辨）。只作用于新笔画，老 draft 原样兼容。也是上面撤销历史体积账的前提。(`ff61901`)
- **Android：阅读模式隐藏系统状态栏。** 进入阅读模式全屏沉浸，下滑可临时呼出系统栏（`ShioriAndroid.setImmersive` 桥接）。⚠️ 平板真机验证仍欠（P4）。(`f2ae025`)
- **iOS/iPad：阅读模式同样隐藏状态栏 + Home 条。** iOS 的系统栏归 tao 的
  root view controller 管——wry 在 Rust 侧建 VC，没有可编辑的 Swift 入口，
  Android 式"改生成的原生工程"走不通。走 Rust：新命令
  `set_reader_immersive`（iOS 实现 + 其余平台 no-op 孪生），
  `run_on_main_thread` 里经 raw-window-handle 0.6 拿 UiKit VC 指针，
  objc `msg_send!` 发 tao 自家的 `setPrefersStatusBarHidden:` /
  `setPrefersHomeIndicatorAutoHidden:` selector（tao 0.34
  platform_impl/ios 同款）；前端 `immersive.ts` 按 IS_IOS 分支动态
  invoke。顺带修存量：终端 `configure_terminal_locale` 的非 macOS 孪生
  引用桌面专属 `CommandBuilder` 没排除 mobile，iOS target 编译早已红——
  `cargo check --target aarch64-apple-ios` 现在过。⚠️ iOS 真机/模拟器
  运行验证仍欠（本机只做了编译验证）。

### 新增（整段编辑，2026-07-07 凌晨）

- **整段原文编辑 v1 落地（点击即编辑段落）。** 方案与调研：
  `docs/PLAN-PARAGRAPH-CONTENT-TEXT-2026-07.md` +
  `docs/RESEARCH-PARAGRAPH-EDIT-2026-07.md`（Codex web 调研，PDFBox/
  pdfminer/MuPDF 真实参数）。段落检测器
  `src/editor/textSelection/paragraphDetect.ts`：runs→lines→blocks，信号=
  基线容差/pitch 连续带/硬断/x 重叠/字号连续/标题独立，MAD 对齐检测
  （justify 末行校验），异常块标 low-confidence 记原因、**拒绝编辑不猜**；
  旋转文本按基线方向角排除（`dirAngleDeg`，pdf.js 把旋转 run 的宽度水平
  铺开、盒形判据抓不到 arXiv 侧栏）。debug 可视化：
  `localStorage.setItem("shioriDebugParagraphs","1")` 画块（绿=可编辑/橙
  =拒绝+原因）。交互：text 工具单击高置信块 → 整块进现有
  `addContentTextEdit`（run 拼接文本带 0.2em 词距启发式、每行矩形、精确
  基线/行距/首行缩进/吸收合并全复用）；拖选子行、双击选词路径保留。
- **公式段落拒绝整段编辑 + 拒绝时给 toast 说明。** 整段编辑把全段压平成
  单一样式，段里混着数学字体时（"48× faster" 的 × 来自 CMSY，即便 48 是
  CMR）屏上和导出都会毁掉公式——检测器新增 `isMathFontName()`（剥
  `ABCDEF+` 子集前缀后匹配 CMMI/CMSY/CMEX/AMS msam·msbm/script·fraktur
  各族 + 自述 Math/Symbol 的字体名），命中的块标 low-confidence
  （`hasMathFont` 字段供 UI 分文案）。同时修"点了没反应像坏了"：单击落在
  被拒块上时弹 toast 说明原因（公式段/版式复杂两种文案，zh/en/ja），指引
  用拖选局部编辑；2.5s 内不重复弹。坑：react-hooks purity 规则禁止 render
  期闭包里调 `Date.now()`，限流时钟改用 pointerup 的 `event.timeStamp`。

### 改进（字体保真，2026-07-07）

- **编辑框上屏直接用文档内嵌字体。** 位移观感的最后一块拼图：几何早已
  对齐（基线误差 0.16px 实测），但编辑框用 Times 顶替原文字体（如
  Garamond），x 高度/笔画突变读起来就是"位移/重叠"。pdf.js 渲染 canvas
  时本就把内嵌字体注册为 FontFace（`g_d{doc}_f{n}`）——现在
  `registerLoadedPdfFontFaces` 在 textContent 解析后把
  归一化 BaseFont（剥 `ABCDEF+` 子集标签）→ 当前会话 face 名写入 store
  `pdfFontFaces`（session 级，g_* 槽位名跨会话含义会变，**绝不持久化**；
  `document.fonts.check` 在 effect 里做，render 期受 purity lint 限制）；
  overlay 新字段 `sourceFontName` 存稳定 BaseFont（跨会话草稿恢复后照常
  映射，多数派选举与导出侧主字体聚合同口径）；OverlayDom 把 face 前置到
  CSS 栈，textarea/提交 div/基线度量（canvas fontBoundingBox）全部随之
  切换，子集缺字由 CSS 按字形回退。浏览器实测：整页 reload 后 doc 槽位
  d3→d0 仍正确映射；编辑框与原文肉眼无差。
- **编辑态实时预警：溢出 + 疑似缺字。** OverlayDom 在 contentText 编辑态
  用 rAF 节拍的 effect（canvas 度量与 setState 均被 render-purity /
  set-state-in-effect 两条 lint 禁止在 render/同步 effect 里做）逐行
  measureText（用实际渲染字体栈，含内嵌 face；首行扣 firstLineIndentPt）
  对比框宽出溢出警告；缺字判定用"文档已访问页面中该字体出现过的字符集"
  （`store.pdfFontChars`，注册字体 face 时顺带累积）做启发式——精确 oracle
  （ToUnicode 反解）在导出侧，屏上启发式措辞用"可能"。两类警告合并为编辑
  框下方琥珀色徽标，i18n ×3。实测："中" 在 Garamond 文档中触发缺字提示，
  加长文本触发溢出提示。
- **内置 Liberation 度量兼容替补字体（+429KB woff2 ×3）。** contentText
  的屏上回退栈此前落到 UI 字体（sans→Inter Tight、mono→JetBrains Mono），
  宽度与导出回退的 Standard-14 完全不符；serif 栈虽已引用 Liberation
  Serif 但从未随包分发，Android WebView/裸 Linux 上一路漂到 Georgia。
  现在：官方 liberation-fonts 2.1.5 release 的三个 Regular 经 ttf2woff2
  转换入包（SIL OFL 1.1，LICENSE 随资产存放），`fonts.css` 懒加载声明
  （无 unicode-range，仅在栈匹配时才拉取）；新 `contentFontFamilyCss`
  给 contentText 专用 Helvetica/Courier 优先 + Liberation 兜底的栈
  （UI 的 `fontFamilyCss` 不动，普通文本框观感不变）。Liberation 与
  Times/Helvetica/Courier 逐字形同宽（Red Hat 度量兼容设计目标），屏上
  回退从此与导出宽度一致。
- **整段编辑导出集成测试补齐。** 段落形态 overlay（每行一个 cover rect +
  精确基线 + 替换行数多于原文）全链路断言：三行原字形真删（无 TJ 残留
  hex）、四行替换全部以源字体 GID 书写、第 4 行按实测 40pt 行距外推落位
  （不是 fontSize 派生行高）、cover 全部判净跳过盖板。坑：bun test 不做
  类型检查，overlay 漏写 `pageId` 时静默走了"无 overlay 快路径"（导出原
  样返回），断言只看到原文——集成测试若见"导出完全没动"先查 model 字段
  完整性。

### 修复

- **行中起选的跨行编辑：输入态整框右移 = 父级 text-indent 推动了行内级
  textarea。** firstLineIndentPt 的 CSS `text-indent` 挂在内容 div 上，
  提交态只缩进首个格式化行（正确）；但编辑态的 textarea 是 div 首行上的
  **行内级替换元素**，被 text-indent 把整个控件推右 300+px——用户看到
  "编辑时所有行整体右移/错位"。修复：编辑态下父 div indent 归零（textarea
  全行贴左，为既定取舍——首行编辑时暂与未覆盖的原文前半重叠），提交/导出
  仍用真实缩进。取证链：debug payload 证明模型 rect.x/covers 全对 →
  渲染框 x 却在行中 → computed style 定位到父级 indent。同 commit：字体
  度量采样 100px→1000px（Chrome fontBoundingBox 返回整数，0.01em 量化
  在正文字号上放大成 ~0.3px 的系统性"偏上"，现降到 ~0.03px）。
- **原文编辑不再错位：编辑框、屏上文字、导出落点共用同一条基线。** 病根是 pdf.js 明明给了精确的 glyph 基线（`item.transform[5]`），但入口 `textItemToDisplayTextRun` 转成 ascent/descent 盒后就把它丢了，编辑框（0.45pt/2.2pt 手调 nudge）、DOM 渲染（`line-height:1` 的 CSS 基线）、导出（`rect.y+rect.h−0.8−heightAtSize`，0.8 在两个文件重复硬编码，且用的是**替换字体**的 ascent）三方各自从盒子边缘倒推、互相用常数补偿。现在把每个源行的基线捕获为 `ContentTextOverlay.sourceBaselinesPt`（page space，随 `overlayToPdfPageSpace` 平移），DOM 用 canvas fontBoundingBox 度量把首行 CSS 基线平移到位、导出直接以它为 `Tm` 的 y——替换字体 ascent 从此与落点无关。字号改为优先取 pdf text-matrix 精确值且保留两位小数（9.96pt 不再被取整成 10pt）。旧 overlay / DOM 兜底选区路径无基线可信值时整体不存该字段，走原 legacy 数学，行为不变。详见 POSTMORTEMS 2026-07-06。

- **编辑原文导出后，旧文字被真正从 PDF 里移除（glyph removal 第一期）。** 此前导出只是「盖白 + 重绘」，旧 show-text 算子仍在 content stream 里——搜索/复制/朗读读到的还是旧文字。现在带 contentText 编辑的页面会在导出时解码 `/Contents`（裸拼接分段流，qpdf 坑）、自建分词器（字节区间精确、改写只拼接不重序列化）+ 文字状态机（CTM/全套 text state，逐 glyph 推进盒）+ 字体宽度表（simple `/Widths`、Type0 Identity-H `/W`+`/DW`，纯字典无需解析字体程序）定位被覆盖字形，**逐字形删除并以等效 TJ 调整量保留推进**（后续文字不移位；`'`/`"` 的换行与 Tw/Tc 副作用显式重发）。命中策略保守（四角全在 cover rect 内才删）；Type3/竖排/非 Identity CMap/裁剪模式/ExtGState 可能改字体等一律整页放弃、回落纯覆盖导出，绝不产坏页；重写进新 stream 对象，复制页共享流不受影响。已知边界：Form XObject 内文字暂不处理（仍被盖住），XObject 递归 + COW 为后续。方案与调研：`docs/PLAN-CONTENT-STREAM-TEXT-REMOVAL-2026-07.md`。(`50dfc73` `a4f8e51` `5a84d41` `3b69696`)
- **同字体真替换（glyph removal 第二期 B）：替换文字尽量用原字体书写。** 被删字形都来自同一个 /Font 资源、且该字体的 `/ToUnicode` CMap 反解后能编码替换文本的每个字符时，导出不再用内置 Helvetica/Noto 重绘，而是以原字体资源名直接发 raw text 算子（q/BT/Tf/Tm/Tj，text state 全部显式归零），落在捕获的源基线上——编辑处字体、字重、字距与周围完全一致，视觉上不可分辨。管线：`GlyphPlacement` 记录字形的 /Font 资源名 → 删除报告按 rect 归因（none/mixed/font）→ overlay 聚合出唯一源字体 → 新模块 `sourceFontEncoder.ts` 解析 `/ToUnicode`（bfchar/bfrange/数组式 range，UTF-16BE 目标）反转为 unicode→code 并配合宽度表算行宽。子集字体的 ToUnicode 只列子集里真实存在的字形，反解即"字形是否可用"的可靠判据。回落保守：无/坏 ToUnicode、混合字体、用户开了粗体/斜体、缺 sourceBaselinesPt 的旧 overlay、行宽超编辑框（内置路径要换行）一律走原内置字体路径。坑：CMap 头部 `CIDSystemInfo <<…>>` 的孤立 `>` 曾让自写 tokenizer 空 token 死循环，已修并入夹具。
- **同字体替换按"主字体"聚合，混入少量他字体不再整段回退。** 原聚合要求
  overlay 全部 cover rect 归因到同一个 /Font 资源名、任一 rect mixed 即
  否决——现实段落几乎总混着一个斜体词/符号，结果整段编辑导出时统统退回
  内置基础字体（用户看到的"48× faster 编辑后变丑"）。改为按 rect 票数选
  主字体：mixed/none 的 rect 不投票也不否决，平票才放弃；正确性不受影响
  ——编码器仍逐字符对选中字体的 ToUnicode 反查，任何缺字整体回退。屏上
  编辑框本就压平成单一样式，导出与屏上从此一致。集成测试坑：pdf-lib 每次
  `drawText` 给同一字体生成新的页资源名（票会被摊平成 1-1-1），真实 PDF
  writer 会复用资源名——夹具改用单次多行 drawText。
- **真删干净的 cover rect 不再盖白，编辑处完全无痕。** glyph removal 的顺手收尾：`redactCoveredTextOnPage` 从返回删除计数升级为 per-rect 报告（`{ removedCount, cleanRects }`），导出时"干净"的矩形跳过背景色盖板——有底色/纹理的页面上编辑不再留补丁。"干净"判定保守（全部满足才算）：walk 成功、与矩形相交的字形全部 fully-inside 且已删、无 XObject 压住矩形（Form 用 BBox×Matrix×CTM、Image 用单位方×CTM 求包围盒，算不出包围盒或其他 subtype 一律按脏处理——v1 不遍历 XObject 内容，扫描件的可见文字在图里，保留盖板正确）。任何失败路径 cleanRects 全 false，行为退回今日的盖白+重绘。Codex 实现，含 per-rect 单测 + 真字体集成测试（删净页无旧字形也无盖板填充算子、脏矩形仍有）。
- **发布前审计低危项清账（×4）。** ① 桌面拖入不支持类型 → 补
  `error.unsupportedDocument` toast（与 web picker 对齐）；② 移动端打开
  前先 `plugin-fs stat` 查 200MB 上限（fail-open：content:// 不支持
  stat 就回落读后校验），避免整读大文件 OOM；③ 移动端
  `app_cache_dir/exports` 按 mtime>24h 清理（不整目录清空——上一次分享
  的 chooser 可能还在读文件）；④ 删死代码：`openPdfFromPlatform` +
  Rust `open_pdf_dialog`（无调用方）、`__SHIORI_ANDROID_PENDING_OPEN__`
  （只读不写的遗留通道）。延后仅剩 Android"chooser 弹出即算导出成功"
  （无可靠取消信号，生态级限制）。门禁含 iOS cargo check + 桌面
  tauri build。⚠️ 移动端两项（②③）无真机验证，验证债与沉浸式同批。
- **原文编辑：词中切口的盖板不再吃掉邻字（"像素残留"真凶）。** cover
  rect 一直对四边盲扩 0.8pt（≈267% 下 2.1px），选区起/终点落在词中间时
  会盖掉邻字的一条边——屏上出现 "foundation-m|odel" 变 "foundation-mːdel"
  式的残缺字母，且 coverRects 原样进导出，残缺字被**烧进导出的 PDF**（用
  户手里 edited1-edited.pdf 里的"- 附近像素残留"即此）。修复：
  `selectedRunRectsWithEdges` 在选区几何生成处按 run 内字符判定每条水平边
  是否安全（邻字符为空白/行边=安全 0.8pt；词中切口=只扩 0.15pt 盖 AA 边），
  merge 时右边界随最右片段走；`expandPdfRectSides` 支持分边扩张。旋转页
  的 display↔PDF 轴向映射未处理，非 0 旋转回退旧的均匀扩张。浏览器实测：
  切口两侧 pad 由 2.13px 收到 0.40px，邻字 "o" 完整保留。顺带排除了两个
  伪 bug：SoGReg 下沉、部分残影是**旧版本导出时烧进这份测试 PDF 的**，非
  当前渲染问题；新建编辑的基线经 canvas 像素采样验证与原文差 0.16px。
- **原文编辑：选中/编辑态不再产生 1px 级文字位移。** 真因：选中框用的是 CSS `border`，在 `box-sizing: border-box` 下边框向内吃掉内容区——未选中 `none`、选中 `1px dashed`、编辑 `1.5px solid`，三态切换文字就跟着挤动；竖直方向此前靠 `borderPx` 参数在 baselineShift 里补偿，水平方向从没补过（历史上的三处微调常数就是在追这个差）。改用 `outline`（不占布局、支持虚线）后三态布局完全一致，`borderPx` 补偿参数整个删除。
- **原文编辑：行中起选的跨行编辑，第一行不再顶到编辑框左缘。** 模型只有一个 rect + 每行基线，没有"第一行起始 x"——从行中间选到后续整行时，editRect 左缘取的是整行的左缘，第一行替换文字被画到框左，和未覆盖的前半行原文叠加。新增 `ContentTextOverlay.firstLineIndentPt`（相对 rect.x，平移不变；首行 rect 带 min-x 推导，>0.5pt 且小于框宽才存）：屏上用 CSS `text-indent`（天然只作用于首个格式化行）、导出两条路径（内置字体 + 原字体）首行 x 各加 indent，原字体路径的行宽校验对首行扣掉 indent。选中着色 SVG zIndex 2→4 也在本组（盖过 overlay 层）。
- **原文编辑：编辑过的区域可以重新选中。** 文字工具下 contentText overlay 此前 `pointerEvents: auto`，选择拖动一碰到就被 overlay 吃掉——现在 text 工具下已有 contentText 对指针透明（正在编辑中的那个除外，textarea 还要接收点击），选择扫过后由吸收合并接手；选中着色的 SVG 从 zIndex 2 提到 4（盖过 OverlayLayer 的 3），扫过已编辑区域时 tint 可见。单独重改某处走选择工具双击。
- **原文编辑：新编辑吸收重叠的旧编辑。** 两个 contentText 编辑区域重叠时，两份替换文字会叠画在一起。现在 `addContentTextEdit` 在建 overlay 前找出同页 coverRects 相交（PDF 空间、要求 0.5pt 实穿透，避免相邻行 0.8pt pad 误判）的旧 contentText：删除旧 overlay，并把它的 `text` 代入新编辑框初始文本（`originalText` 保持源文本——导出照常盖/删源字形）；旧 originalText 在新文本里找不到时仍然吸收（用户正在重编这块，叠加显示更糟）。已知余项：纯选择高亮阶段，旧编辑处仍没有选中着色（overlay 盖在文本层高亮之上），后续再处理。
- **吸收合并的文本代入改为空白容忍匹配 + `$` 安全替换。** 旧 overlay 的
  `originalText`（DOM 选区捕获）和新编辑的合成文本（run 拼接）对同一段源
  文常有空白差异（换行 vs 空格、几何词距合成的空格），字面 `includes` 一
  失配旧替换文本就静默回退成原文；且 `String.replace(str, str)` 会解释替
  换文本里的 `$&`/`$1`。抽出纯函数 `substituteAbsorbedText`
  （`src/editor/textSelection/absorbText.ts`）：正则转义 + `\s+` 归一匹配、
  按索引拼接不走替换模板、空白 originalText 不匹配一切，单测 8 例锁行为。
- **原文编辑：多行编辑的行距按原文实测值渲染。** 屏上 contentText 行高一直是常量 `fontSize × 1`，但原文 leading 通常是 1.15–1.4 倍——整段/整句编辑从第二行起逐行漂移。新增 `src/pdf/model/baselines.ts` 的 `sourceLinePitchPt()`（相邻 sourceBaselinesPt 差值取中位数，抗单个异常行距），OverlayDom 行高改为 `pitch / fontSize`（夹在 0.75–3），导出侧 `contentTextBaselineY` / `contentTextSourceBaselineY` 对超出源行数的外推行也改用实测 pitch。单基线/旧 overlay 回落原行为。
- **原文编辑：下伸部不再被裁、编辑框禁止拖动。** 两个屏上 bug：(1) 基线对齐的 translateY 把首行下移后，内容 div 的 `overflow: hidden` 会裁掉 p/g/y 的下伸部——contentText 改为 `overflow: visible`，编辑态的 textarea（表单控件必然按自身边界裁剪）额外给 `calc(100% + 1em)` 的透明底部余量；(2) contentText 的语义是"钉在被覆盖的原文上"，拖动会把编辑文字从盖板处拖走、新旧文字同屏——OverlayLayer 的 move 手势对 contentText 直接返回（多选拖动也过滤掉），OverlayDom 不再渲染缩放/旋转把手，光标从 move 改 default。
- **macOS：冷启动双击 PDF 不再丢文件。** 系统 `Opened` 事件在前端就绪前到达时会被暂存转发，且对原生 open 握手去重加固，冷/热启动实测均正常。(`b939485` `55591f6`)
- **画笔：画完一笔不再被自动框选。** 此前每画完一笔就切到选择态，连续书写被打断。(`a537f1c`)
- **画笔模式下已有笔画/标注对指针透明。** 此前落笔容易误选中、误拖走已有标注。(`6579573`)

## [0.1.24] — 2026-06-22

### 新增

- **可复用手写签名。** 新增签名工具：用户可在本地签名面板手写保存签名，也可导入 PNG/JPEG；签名保存在独立 IndexedDB（`shiori-signatures`），选择后可点击或拖拽放到 PDF。手写签名落页后转为 `ink` overlay，图片签名转为 `image` overlay，复用现有编辑、选择、导出管线；annotations 模式下保留为可编辑 Ink / 页面图片，flatten 模式烧进页面。(`ad84984`)
- **Everforest / 常青主题。** 新增跟随系统明暗的 Everforest 调色板、三语设置文案和主题单测；`applyTheme` 能按所选主题而非仅 effective light/dark 写入 CSS 变量。(`7655322`)
- **终端主题可独立选择。** Settings 增加 Terminal theme：可跟随应用，也可固定 Paper / Night / Everforest；xterm 配色、宿主背景、边框、选区和 cursor 现在从同一主题 palette 派生，切换时不重启当前 shell。(`5f6d264`)

### 改进

- **Web 工作区恢复更像授权续期。** web file handle tab 恢复失败时，会优先尝试重新读取同一 handle；权限丢失时提示“重新授权”并在当前 tab 重试，而不是直接让用户重新选一个文件。不可用 tab 中央也显示具体原因和重试按钮。(`7655322`)
- **资源监控小数显示和采样更诚实。** CPU 在 0～0.1% 间显示 `<0.1%`，避免被四舍五入成 0.0%；桌面 sysinfo 采样复用同一个 `System`，避免每次刷新都冷启动采样状态。(`5f6d264`)
- **官网英文页排版收敛。** 英文首页去掉日文副文案，降低装饰性 italic，正文改用更安静的 prose 字体栈；页脚品牌 kana 仅在对应语言显示。(`a84c15c`)

### 修复

- **Tab / 标题文本不再被裁切。** 顶栏、TabStrip、通用按钮容器补齐 `minWidth: 0` / overflow 约束，长文件名和窄窗口下不再互相挤坏。(`7655322`)
- **导出 / 分享桥接失败诊断更清楚。** Android bridge 的畸形返回和 Tauri command 的 string rejection 会被归一成可读错误，方便定位移动端导出问题。(`7655322`)

## [0.1.23] — 2026-06-16

### 改进

- **桌面端可单独收起标注工具栏。** 此前仅手机 / 平板；桌面工具行末端加折叠箭头，收起仅藏工具行 + inspector，留细条展开，标签页 / 顶栏保留。(`7024834`)
- **资源监控面板如实显示占用。** 内存按来源标注、CPU 归一 0-100、面板自门控；桌面 sysinfo 采进程树 CPU/内存，iOS 用 Mach `task_info`（`phys_footprint`）、Android 原生插件，新增存储用量 / 配额与驱逐态。(`bfa48ab` `3f5d700` `4fbbf15` `0d06aa7` `359e597` `a077fb9` `4842055`)
- **滚动 / 拖动标注更流畅。** 每页渲染叶子（PageCanvas / TextHighlightLayer / PdfLinkLayer / OverlayLayer）包 `React.memo`，滚动换页与拖标注不再整列重渲染。(`93f2a47`)
- **适应宽度 / 适应整页改为一次性动作。** 去掉持久"选中"高亮（`fitMode` 默认 width、只随手动缩放清除，看着像卡住）；每次点击重新应用，模式仍存内部以便窗口缩放自动重适配。(`86ed33e`)
- **更新通知按更新日志渲染，不再盒装文本堆。** (`a111408`)
- **手机设置面板分段控件整行宽度。** (`07f327e`)
- **GPU 加速开启时由设备探针把关，不再渲染空白（默认仍关）。** pdf.js 的 `enableHWA`（`willReadFrequently:false`，请求把渲染好的页面位图留在 GPU 显存）开启后，某些 macOS/WKWebView/GPU 组合会接受这个 hint 然后渲染**空白 canvas**，且无从恢复。现加一个**同步设备探针**（`src/pdf/render/hwaProbe.ts`）：用与 pdf.js 一致的上下文属性 `{alpha:false, willReadFrequently:false}` 在离屏 canvas 上画蓝底 + 旋转红块 + `drawImage` 绿块，再 `getImageData` 回读校验；读回颜色不对（空白）说明该设备加速 canvas 路径坏了，自动回退软件。探针**同步、记忆化**，无异步时序、无文档重载、无闪烁。生效 `enableHWA = 用户意图 && hwaCanvasOk()`，集中在 `loadPdfFromBytes`（唯一 `getDocument` 处，连缩略图一并覆盖）。效果：**手动开启不再可能空白**——坏 GPU 静默走软件。资源面板如实显示 关闭 / 开启 / **此 GPU 不支持（软件）**，替换原先含糊的"（已请求）"。默认仍保持**关闭**：要真正默认开还需运行时自愈（探针漏判时自动恢复）+ 真机验证，作为后续。注：探针测的是 `enableHWA` 控制的加速 2D canvas 机制，但无法证明某个 pdf.js 绘制操作不会在病态驱动上空白；`PageCanvas` 的渲染后空白检测仍作遥测兜底，任何疑虑一律偏向软件。

### 修复

- **网页版：文件拖到已打开文档不再跳走丢会话。** HTML5 drop 处理器只在 Landing（文档一开即卸载），拖到已开文档落到浏览器默认 = 导航走、拆掉 SPA + 未 flush 的编辑。加 window 级 dragover/drop sink（web/mobile），`defaultPrevented` 去重 Landing 已处理的。(`1bf32fe`)
- **macOS：⌘C / ⌘A 复制 / 全选标注。** 预定义编辑菜单在 key-equivalent 层吞掉 ⌘C/⌘A，webview keydown 看不到。改自定义项 emit menu:copy/select-all，按焦点分支（文本上下文走 execCommand）；⌘V/⌘X 保持原生（否则破坏文本框粘贴 + 图片贴成页）。(`228dc87` `c36414e`)
- **iOS：导出弹真系统分享面板。** 此前落到 opener `openPath`，对无 scheme 缓存路径静默 no-op 却 resolve → 假报"已分享"、文件留在不可达缓存。加 shiori-browser 插件 `shareFile`（`UIActivityViewController`），用户完成才算导出。(`f86a0b6` `71d8055`)
- **小屏手机"导出"按钮不再被挤出屏幕。** 移动 TopBar 11 个定宽控件单行无 wrap，改横向滚动 + find/settings/Export 用 sticky 钉右缘。(`269b352`)
- **手机设置面板 CJK 文案不再竖排成一字一行。** (`0f02612`)
- **Windows 内嵌浏览器第二次回归：首次真实导航后主线程整体卡死（修复，Windows 保持启用）。** 0.1.22 修掉 per-frame `show()` 卡死后重启用 Windows 浏览器，但出现新症状，且只在地址栏输入网址、发起第一次真实导航后爆发：远程页打不开、主窗口按钮点击无反应、窗口关不掉、之后打开的终端永远卡在「正在启动 shell…」。四症状联合证明导航后主 UI 线程 / tao 事件循环 / IPC 响应被整体卡死（`invoke` 永不 resolve）。根因：首次输入网址 = **创建子 webview（`add_child`）+ 首次导航**同时发生；Windows 上 `add_child` 在主线程跑嵌套消息泵建控制器，期间初始导航的 `on_navigation`（同步 `NavigationStarting` COM 回调）重入触发，而回调内 `app.emit` → `eval` → wry `send_user_message` 在主线程**内联执行** = 在创建嵌套泵 / COM 回调栈上再叠一层重入；同时嵌套泵会重入派发并发排队的 `web_panel_set_bounds`，把 `SetBounds` 打到半成品控制器上。macOS WKWebView `evaluateJavaScript` 异步、`add_child` 无嵌套泵，故同代码只 Windows 炸。**修法（防御式，拆掉首次 create+navigate 路径上每一处主线程重入）：** ① 把 `on_navigation` 及 `web_panel_open` / `web_panel_navigate` 末尾的 emit 全部用 `tauri::async_runtime::spawn` 推迟出 COM 回调栈（改走排队分支，落在干净 tick；切忌 `run_on_main_thread`，主线程上同样内联）；② `WebPanelInner` 加 `creating` 门控 + `pending_bounds` 暂存：`add_child` 期间 `web_panel_set_bounds` 只暂存、`web_panel_hide` 直接返回，创建返回后再 flush 一次几何（锁在 `add_child` 前释放，避免重入自死锁）。源码侧用 vendored wry/tauri 逐条坐实（`send_user_message` 内联判据、`wait_with_pump` 嵌套泵、sync command 在主线程跑）。`IS_WINDOWS` 仍导出作一行 kill switch。注：「ExecuteScript 阻塞死锁」机制经源码 + WebView2Feedback #1853 证伪；重入为结构性坐实但因果充分性未证，仍需真机 WinDbg/ETW 主线程栈终验。详见 POSTMORTEMS 2026-06-15。

### 文档 / 内部

- **多维度代码审计报告（2026-06-15）。** 性能 / UI 错位 / 平台适配 / 正确性 / 重构五维多智能体审计，本批多条修复源于此。(`3aeb821`)
- **忽略嵌套 plugin 的 target/ 构建产物。** `src-tauri/.gitignore` 锚定的 `/target/` 漏掉 `plugins/*/target/`，曾把 ~115MB 编译产物带进对象库（已成孤儿）。(`aaea1f9`)
- **记录并行 workspace 工作流。** (`2f76000`)

## [0.1.22] — 2026-06-15

### 改进

- **可单独收起标注工具栏。** 替换原本常驻悬浮、本质 = 专注模式、且浮在弹窗（设置 / Changelog，z-index 46）之上的 `MobilePdfChromeToggle` pill：在标注工具行加内联折叠箭头（chevron），收起只藏该行 + 样式 inspector，留一条细条用于展开；Tab + 顶栏保留。专注模式（藏全部 chrome）仍走顶栏的 reader 按钮，两者彻底区分。工具段从 `width:100%` 改 `flex:1` 给折叠箭头让位。(`757020a9`)
- **平板桌面式顶栏 + 工具栏。** 平板（`isMobile` 为真但 `IS_TABLET`）此前走手机窄屏布局：文件名占第二行、工具按钮 `flex:1 0 25%` 在 ~768px 被撑爆把 Note/Text 挤出屏幕。新增 `useIsPhone`（窄屏且非平板）门控这些手机专属布局，平板改走内联文件名 + 内容宽度工具按钮。(`024e3636`)

### 修复

- **CJK 文档查找。** `semanticUnitsToSearchIndex` 在每个 PDF 文本单元后无条件插分隔空格；英文是整词单元不受影响，但 pdfjs 常把 CJK 拆成逐字单元，索引变成 `中 文 文 档`，`findMatches` 的 `indexOf("中文")` 永不匹配 —— 全平台中文/日文/韩文查找静默失效，数字/拉丁正常。两个相邻 CJK 字符之间不再插分隔空格（CJK↔拉丁边界仍保留）。加单测。(`b60c7727`)
- **Android 应用内自更新。** direct-apk 的应用内更新调用 `ShioriAndroid` 桥接时 receiver 不对，导致更新失败。(`0c5ceab4`)
- **移动端更新通知滚动条。** 更新弹窗 notes 框 `overflowY:auto`，安卓 WebView 显示粗的桌面式滚动条；移动端套 `.shioriTouchScroll`（隐藏滚动条 + 惯性滚动），桌面保留。(`cf5fe28e`)

### 文档 / 内部

- **Android direct-apk 分发 flag + JS 桥接 receiver 踩坑文档。** 记录 `SHIORI_ANDROID_DISTRIBUTION` 的影响面与 direct 路径长期潜伏的坑。(`1f8b3eb7`)

## [0.1.21] — 2026-06-14

### 新增

- **平板内嵌浏览器（iOS / Android，Path B 原生插件）。** iOS 用原生 `WKWebView`（Swift）、Android 用原生 `android.webkit.WebView`（Kotlin）作为 Tauri webview 同级子视图，frame/layout 跟踪 React 测得的 rail 矩形；非 Tauri webview、无 IPC 桥，远端页面继承零 Shiori 命令。Rust↔JS 契约冻结，Rust 侧轮询 nav state 再 emit `web-panel-nav`。`detectFormFactor`（屏幕尺寸 + 触摸点 + UA）判定 IS_TABLET 才启用，手机（IS_PHONE）不给；终端两端都不给。(`137be582`、`e65c8d93`、`60fac0fd`、`8f9b68c4`、`9d0bcc62`)

### 修复

- **Windows 内嵌浏览器卡死 / 崩溃 + 显存飙升。** `web_panel_set_bounds` 每帧 `apply_web_panel_bounds` 后都调 `webview.show()`，而前端在每次 scroll/resize/RAF 都报 bounds。Windows WebView2 每次 `Show()` 强制 visibility/occlusion 重算（macOS WKWebView 廉价合并，故只有 Windows 卡）。在 `WebPanelInner` 跟踪 `visible`，仅在 hidden→visible 跳变 `show()`。据此回退 Windows 浏览器禁用 stopgap（`embeddedBrowserPanel && !IS_WINDOWS`），重新启用。需真 Windows + WebView2 验证。(`b27136e6`、`114e3fe9`)
- **退出残留进程树 / 黑屏。** `.run()` 闭包只处理 `RunEvent::Opened`，退出时不回收内嵌终端 → 用户 shell 及其前台子进程（claude/codex/node/builds）成孤儿（Windows 任务管理器可见），分离的 PTY reader 线程永久阻塞在 `read()`。新增 `shutdown_cleanup`（仅 `RunEvent::ExitRequested`，绝不在 macOS 非退出窗口关闭的 CloseRequested/Destroyed 触发）drain session map（释放 PTY master Arc 让 reader 解阻塞退出）+ `kill_session_tree`（Unix `killpg` SIGHUP→SIGKILL；Windows `taskkill /T /F`，带 bounded try_wait）。显式声明 `libc`。需 Windows on-device 验证。详见 POSTMORTEMS。(`dfa918c3`)
- **合并 PDF 孤儿文档。** `appendIncomingPdf` 仅在 catch 路径销毁合并前文档，每次 append/merge 泄漏旧文档的 worker、字节缓冲、解码页缓存。try 顶部捕获 `previousDoc`，仅成功且非 merged doc / 未被其他 tab session 引用时销毁。(`a1d1f476`)
- **阅读栏标签 clamp。** 持久化的右栏 tab 若失效会被纠正到有效值，不再卡在无效标签。(`f0395f3a`)
- **（平板）拒绝内嵌浏览器页内非 web 导航。** 桌面 `on_navigation`（`parse_web_url`：仅 http/https）的等价物在 iOS/Android 原生侧缺失，页内链接/脚本跳转 `file:`/`intent:`/`tel:` 会无校验进 webview（本地文件泄露 + deep-link 逃逸面）。补 `decidePolicyFor`（WKWebView）/ `shouldOverrideUrlLoading`（Android）：http(s)/内容 scheme 放行，通讯 scheme 交系统 opener，其余拒绝。(`9d0bcc62`)

### 改进

- **紧凑视口 PDF overscan 减半。** 每个 overscan 页挂一个 devicePixelRatio 缩放 canvas，Virtuoso 600px render-ahead 让大量重 canvas 常驻——峰值 canvas/VRAM 主因，也是手机滚动中触发 jetsam kill 的内存压力。compact viewport（isMobile）降到 200px；桌面不变。PDF 内存修复的安全一半；pdf.js worker page-cache sweep 待 on-device 滚动 QA。(`3a25beaa`)

### 文档 / 内部

- **移动端 PDF chrome 切换 + 安全区重构（WIP 底座）。** 携入稳定性修复 session 的在制工作；含被后续真正 WebView2 生命周期修复替代的 Windows 浏览器 stopgap，以及 `docs/TABLET-BROWSER-HANDOFF.md`。不入用户 changelog。(`f4b126e7`)
- **iOS bundle 版本 source-of-truth 对齐。** `Info.plist` 手改成 0.1.20 而 XcodeGen 源 `project.yml` 仍 0.1.18；统一并用单调整数 build number，避免将来 TestFlight 卡版本。(`224b0d79`)
- **iPad 内嵌浏览器实测 + TopBar 门控修复 + 踩坑记录。** 记录 Quick Look 抢 openurl、generate_context! 前端不刷新等。(`06d4dd23`)

## [0.1.20] — 2026-06-13

### 修复

- **Android 直装更新下载旧 APK。** v0.1.19 release 一度缺少 Android 直装
  APK，旧客户端会看到 0.1.19 更新提示但下载到 v0.1.18。补齐 v0.1.19 APK
  资产，并修正 Android 直装包 manifest 生成：direct APK 包含
  `REQUEST_INSTALL_PACKAGES`，Google Play 包不带该权限，避免 `tools:node`
  占位符在 CI manifest merger 中崩溃。(`656c4f2`)
- **Android mobile target 编译失败。** CJK 文件名导出修复复用了 Base64 解码
  helper，但 `base64` crate 被 `cfg(not(mobile))` 错误限制，Android 构建缺
  `BASE64_STANDARD`。改为无条件依赖。(`4dda74b`)
- **重新打开 PDF 恢复到上次阅读页。** 默认 view state 的 page 0 会覆盖最近文档
  记录里的 last page，导致重新打开先回第一页。现在只有调用方显式传入 view state
  时才覆盖页码。(`8c8deda`)

### 改进

- **官网首屏展示调整。** 文案从 PDF-only 改为更贴近 Markdown / HTML / PDF 的
  文档工作流；demo 保持在首屏内，主题色高亮更克制，右下工具按钮间距更稳。
  (`87c6841`、`088935e`、`63b1695`、`3dd7b2c`、`294bc87`)

### 文档 / 内部

- **Shiori CLI 原型。** 新增 CLI 方向文档和 Bun 原型，支持 inspect、文本提取、
  搜索、agent JSON 输出和机器可读 help。暂作为内部 / agent-facing 能力，不放入
  用户 changelog。(`42f9643`、`1b3aef0`)
- **跨平台 review 规则。** CLAUDE.md 明确要求涉及打开、保存、recents、storage、
  IPC、拖拽、文件关联、分享等路径时同时追踪 web / desktop / mobile。(`b859528`)
- **Android build postmortem。** 记录 Android base64 依赖 gating 的构建问题。
  (`38a9dcf`)

## [0.1.19] — 2026-06-11

### 新增

- **HTML 运行模式：远程依赖披露 + 按来源授权。** Run 模式沙箱的 CSP 会静默丢弃
  远程加载，拉 CDN 脚本的页面（three.js 等）无声失败。新增横幅扫描并汇总被拦的
  外部脚本 / 样式 / 图片 / frame / 媒体来源（经 frame bridge 的
  securitypolicyviolation 事件合并去重），用户可逐项勾选放行并重新生成可执行
  HTML，放行项严格追加到对应 CSP 指令、绝不放宽 connect-src。(`d635d5d`、`c72635e`)
- **适应整页缩放模式。** `fitWidth` 布尔升级为 `fitMode` 枚举（width | page | none），
  整页模式按视口高度边界化 scale，幻灯片 / 横向扫描件不再过度放大；含工具栏按钮、
  macOS View 菜单项和 legacy 布尔的前向迁移。(`a936a10`)
- **赞助入口。** Settings About 卡片和 changelog 页脚新增低调的心形「支持 Shiori」
  链接，打开含微信 / 支付宝二维码、GitHub Sponsors、Buy Me a Coffee、爱发电的
  小模态框；不占用工具栏。(`e154c5b`)
- **Windows / Linux 双击打开 PDF。** `RunEvent::Opened` 仅 macOS/iOS 触发，桌面端
  双击 `.pdf` 或「用 Shiori 打开」此前只开空窗口。注册 `tauri-plugin-single-instance`
  （仅 Win/Linux），二次启动把 argv 投给运行中实例并 focus；冷启动在 setup() 解析
  argv 入队供前端 drain。需 CI 构建 + 双击烟测验证。(`6d92ba3`)
- **移动端 PDF 导出 / 分享与原生文件打开。** 移动构建从「导出是 stub、退回 blob 下载」
  改为真实导出：写字节到 app cache（消毒文件名、大小 + 过期守卫）经 FileProvider
  交系统分享面板；文件打开改 pull-based `drainPendingDocumentOpens()` bridge，与桌面
  共享同一 pending-open 队列。Android 分享与 `#[cfg(mobile)]` 臂不被桌面 / web 测试
  覆盖——需真机。(`0183a77`)
- **Android 直装更新安装器 bridge。** 直装 APK 构建可在应用内下载最新 APK、校验
  release 元数据并交系统包安装器；Play 构建仍走商店更新。(codex, `4ba9f2e`)
- **Markdown / HTML 文档进入最近列表 + 页面预览。** 打开过的 Markdown / HTML 记入
  recents，主页「最近」按 PDF 同样方式展示；HTML 渲染为缩放页面预览而非源码文本；回
  主页时已打开的文本标签回填进 recents。(`2e84f3f`、`64a55d2`、`8c80138`、`d2359c4`)

### 改进

- **macOS Cmd+Z 落到文档撤销。** 预设 Undo/Redo 菜单在 key-equivalent 层声明
  Cmd+Z，WebView 文本撤销抢先拦截，Canvas 永远收不到。改为自定义 menu:undo/redo
  事件，App.tsx 分发到 store 撤销 / 重做，文本字段内回退 execCommand；Cut/Copy/Paste/
  Select All 仍用预设。(`b5fa251`)
- **导出文件在应用内打开。** 导出完成的 toast 改为在应用内新增 tab 打开，而非 shell-open
  拉起系统默认应用（会启动第二个 Shiori 实例）；保留 fallback。(`03688bf`)
- **共享资源导出体积 / 速度修复。** `exportPdf` 逐页 `copyPages` 让每次调用新建
  `PDFObjectCopier`、去重缓存清零，共享字体按页数翻倍。改为一次性批量 copyPages
  （重复页 `/Annots` 单独 clone 防串页）：59 页样本 39.74 MB → 2.53 MB、快 ~4×。
  回归测试限制共享资源文档 < 源 ×1.3。(`153befb`)
- **CJK 文件名导出修复。** Tauri IPC 头里的文件名改走 Base64，绕开 WebKit Headers
  拒绝非 ISO-8859-1 值导致的 TypeError；Rust 侧共享解码辅助器覆盖桌面 / 移动。(`76e3096`)
- **Settings About 重设计 + 实时版本。** 单行关于信息改为紧凑品牌卡片（品牌 tile +
  wordmark、点击复制版本、本地优先承诺、website/releases/changelog/反馈链接与更新检查）；
  版本号从硬编码 "0.1.6" 改为实时插值。(`053f5be`、`8443f97`)
- **macOS 自定义菜单本地化。** muda 无菜单 i18n，改为读 `AppleLanguages` 在运行 / 编译期
  选 zh/ja/en 标签，措辞与应用内 locale 镜像一致。(`1ecccb9`)
- **顶栏整理。** 移除冗余「本地 / LOCAL」徽章；文本文档顶栏重构为与 PDF 一致（品牌主页
  按钮、居中文件名、元数据、整体不可选）；chrome 整体 user-select: none，双击文件名
  复制并提示。(`527aa98`、`f1ff433`、`b1ce6c0`)
- **缩放图标重绘。** 适应宽度改为指向两侧栏的水平双箭头、适应整页改为视口角括号内的页面，
  与阅读模式的外向箭头区分。(`c246508`)
- **Windows/Linux 键帽本地化。** locale 串里的 ⌘⇧⌥ 经全局 i18next 后处理器统一转
  Ctrl/Shift/Alt（k() 在 macOS 为恒等），不再有 call site 漏包。(`f7c4bfa`)
- **落地页提示 Markdown / HTML。** drop 提示此前只写 PDF，掩盖了已有的文本文档支持。(`c87dba4`)
- **无文件句柄浏览器的恢复文案。** Safari/Firefox 此前被告知「无法自动重开」却不提
  「重选同一文件即可找回批注」（草稿按 hash 存）。(`63d64b8`)
- **标签恢复失败错误码翻译。** `workspace-source-ephemeral` 等内部码不再裸奔进 toast，
  四个已知码映射为本地化指引，并附「重新选择文件」操作。(`ed25210`)
- **移动端顶栏回填文件名。** 按钮行下方加一条细行显示文件名 + 页数 / 大小，手机上终于
  能分辨当前文档。(`4d7e83f`)
- **Find 索引缓存。** 任何面板都会强制关闭 Find，重开会重建整本文本索引，长 PDF 上保留
  的查询会先显示 0 匹配。改为按 (doc, pages) 身份缓存，重开时选中保留的查询。(`cebd1d4`)
- **⌘S 映射到导出 + 关闭未导出标签提示。** 本地优先编辑器无独立保存步骤，⌘S 此前落空；
  改为打开导出对话框。关闭含未导出修改的 PDF 标签时弹轻量 toast 说明「草稿已存、导出才
  得可分享 PDF」。(`5cadde8`)
- **尊重 prefers-reduced-motion。** toast / 设置面板 keyframe 及所有 CSS 过渡在系统
  减少动态时近乎瞬时（WCAG 2.3.3，留 0.01ms 让 animationend 仍触发）；落地墨滴已在 JS
  自行 gate。(`96040b5`)
- **记住上次导出模式 / 画质。** 导出对话框不再每次重置为 annotations+original，模式与
  画质持久化到 localStorage 并在读取时校验（WCAG 2.2 SC 3.3.7）。(`9ce9aa8`)
- **落地页 kicker / value props / 快捷键提示渲染。** 这些字符串久存于 i18n 字典却从未挂载。(`edf1a76`)
- **选择标记 popover 跨页去重 + 跨页 gate。** 跨两个已挂载页的选择不再每页渲染一个 popover；
  跨页选择时禁用标记按钮并提示。(`fff32c8`)
- **触控打磨。** resize/rotate 手柄在粗指针上扩大 30px 透明命中区；tap 已选中未锁定的
  text/note 进入编辑；长按选词弹出 Highlight/Underline/Strikethrough popover；移动顶栏
  新增阅读模式切换。(`bb5b375`、`bcffac0`、`fe6f787`、`c78feda`)
- **站点下载资产跨多个 release 解析。** 移动 / 桌面产物可能来自不同 CI run，单一最新
  release 未必含每平台资产；改为扫近期 release 按平台各取含匹配资产者；`/api/release`
  单次拉取推导。(`e12d08a`、`f09dcdf`)
- **结构化 toast 载荷。** `showSaved` 改用 { kind, path } 判别式载荷由 ToastHost 经 t()
  本地化，去掉英文哨兵串；三平台覆盖并有测试。(`0abfc26`)
- **焦点陷阱堆栈化。** useFocusTrap 改为模块级陷阱栈，多个模态叠加时只有顶层作用，消除
  Tab 焦点乒乓。(`f4dee0a`)
- **文本文档顶栏终端 / 浏览器入口。** 文本文档（Markdown / HTML）顶栏新增终端 / 浏览器
  按钮并左移与 PDF 顶栏对齐；落地页隐藏标签条；tab 关闭按钮缩小防溢出；fit-width /
  fit-page 图标再调以免看着像选中态。(`f784f39`、`f774998`、`e7f4c54`、`4564fe6`、`656243f`)
- **落地文案去 PDF-only 框定。** 首屏标题与 kicker 改为涵盖文档（Markdown / HTML）而非
  仅 PDF，避免掩盖已有的文本文档支持。(`f2cba99`、`fd3b26b`)

### 修复

- **取消恢复草稿对话框后首次编辑静默覆盖草稿。** 关闭对话框丢弃内存载荷但磁盘草稿仍在
  （按内容 hash），首次编辑经同 hash 的自动保存覆盖之。改为「延迟决定」：暂存载荷、挂起
  自动保存，用户真正编辑时把对话框弹回。drafts 变更总线从 EventTarget/Event 改为普通
  listener set（适配混合测试 realm）。含回归测试 + postmortem。(`31f115f`、`3d5e057`)
- **配额错误穿透 Dexie 包装。** `db.transaction()` 失败被包成 DexieError，旧检测要求
  instanceof DOMException，真实配额失败被错判为 transient、驱逐重试不跑。改为遍历错误链
  匹配配额错误名。(`77f0975`)
- **导出状态按内容快照比对。** 移动导出工作此前用 undo 深度（capped 100）判定，导出后永远
  报 'exported'、undo 后不同编辑误报。改为快照 key 为唯一权威。(`82bd258`)
- **导出完整性守卫。** `exportPdf` / compact-raster 在 save 后重新 load 校验可解析性、
  页数与几何，失败前于保存重抛 ExportIntegrityError；未改源快速路径不重验。(`48c5b1b`、`02acd0e`)
- **草稿存储硬化。** LRU 驱逐改为可见（Settings → Storage 列出被清文件，可 dismiss）；
  put() 在写入成功后即使 sweep 失败也算成功；op-log 超大模型跳过而非抛、跳过 / 失败时清
  stale 条目让恢复回退到最新 IndexedDB；旧 v1 行在驱逐时一并删除防复活。(`5214e2a`、`1ebae3a`、`f053c39`、`5c30ffa`、`80f2773`、`b67cf94`)
- **Android 待开队列竞态。** enqueue 与 drain 锁各自实例，toList() 与 add() 竞争抛
  ConcurrentModificationException。改为所有队列访问同步在同一 list、drain 为原子
  copy-and-clear。(`3d2e311`)
- **新装不自动弹 changelog。** 首次启动无记录版本回退显示发布笔记；改为视 undefined 为
  首运、静默播种当前版本，仅升级时自开。(`f8c7a76`)
- **沙箱 run-frame 的 storage / cookie shim。** 无 allow-same-origin 的沙箱 iframe 里
  localStorage/cookie 抛 SecurityError；real API 抛错时安装 per-frame 内存 shim；cookie
  shim 支持 Max-Age=0 / 过期删除；记录 shim 故意的方法影子化偏差。(`582548a`、`dad8226`、`3b8f805`)
- **死代码清理。** 移除从未消费的导出密码管线。(`4efaf4d`)
- **嵌入式终端光标对齐。** 分离测量主机与视觉帧 padding，滚动 / fit 后刷新视口。(codex, `d2cbbc1`)
- **bridge nonce 测试助手定位修复。** lazy `[\s\S]*?` 会跨 script 边界靠巧合变绿，改为锚定到
  run-frame marker 间。(`b58ae0e`)
- **文本查看器 flex 行内向右偏移。** 文本查看器在 flex-row 父容器里被挤向右侧，已修正。(`bbc6204`)

### 文档 / 内部

- **jj colocated 工作流文档化** 与 seal-as-you-go 提交纪律写入 CLAUDE.md。(`978eed3`、`70da9e7`)
- **PM/UX 研究文档**（`docs/PM-UX-RESEARCH-2026-06.md`）并修正过时的体积声明（~16 MB dmg /
  ~18 MB app）。(`2c175a1`、`645f7d8`)
- **HANDOFF 刷新** 至 2026-06-10 硬化批次状态。(`a94ae9e`)

---

## [0.1.18] — 2026-06-06

### 改进

- **缩略图栏虚拟化。** 左侧缩略图列表改用 `react-virtuoso`，长 PDF 不再一次性创建所有
  缩略图组件；移动端同时禁用整本文档预渲染，只渲染屏幕附近的缩略图，降低打开大文档时的
  CPU / 内存压力。（本次）
- **窄屏默认不挡正文。** PDF 打开 / tab 恢复时按当前 viewport 尺寸决定初始侧栏状态：
  小于 960px 的紧凑布局默认关闭缩略图和右侧栏；大屏平板 / 桌面宽屏仍保留桌面式页导航。
  用户手动点开的侧栏不受影响。（本次）
- **移动端和安全区打磨。** TopBar、TabStrip、设置面板、查找面板、阅读模式和上下文工具栏
  补齐安全区、触控尺寸与可访问性标签，减少 iPhone / iPad / Android edge-to-edge 下的遮挡。
  （本次）

### 修复

- **workspace cache 生命周期。** 关闭 tab、切换 tab、回首页和重新打开最近文档时，PDF / 文本文档
  的 cache 引用不再被过早清理；Markdown / HTML 的 debounced 写入会在关键路径 flush，
  降低重启后丢内容或 stale tab 抢占的风险。（本次）
- **Android 文件入口兼容。** Android `text/plain` / `application/octet-stream` 文档入口补齐，
  对没有后缀或 provider 名称不稳定的文件会按内容 sniff，同时明确拒绝不支持的扩展名。
  （本次）
- **PDF 初始页恢复更稳。** 从 workspace / 最近文档恢复时优先使用已保存的 tab 视图，
  并避免先闪到第一页再滚动到上次阅读位置。（本次）

## [0.1.17] — 2026-06-05

### 修复

- **Android 直装 APK 更新按钮。** Android WebView 中的 APK 下载链接改走 Tauri opener
  插件交给系统浏览器 / 下载器，避免点「下载 APK」后无响应。(`f46d51a`)
- **移动端最近文档保留。** iOS / Android 没有桌面路径时，最近文档现在使用 workspace cache
  作为可重开锚点；从首页「最近的文档」可以重新打开上次导入的 PDF / Markdown / HTML。
  (`f46d51a`)

## [0.1.16] — 2026-05-31

### 新增

- **Markdown 编辑模式。** Markdown tab 现在可以在预览 / 编辑之间切换，默认保持预览；
  编辑态使用纯文本编辑器并支持 Tab 缩进，内容会写入 workspace cache，重启后恢复当前 tab
  内容和模式。(`77f5a98`)
- **可运行 HTML 沙箱。** HTML 文档在安全静态预览之外增加显式 Run 模式，脚本只在
  opaque-origin iframe 中运行，断开 Shiori DOM、storage、Tauri IPC、文件系统和网络连接。
  (`eeebdc6` + `b16ff6a` + `38aea7b`)
- **移动端 Markdown / HTML 打开。** iOS / Android 的文件入口补齐 PDF、Markdown、HTML
  类型识别；Android content URL、Open In / Share Target 路由不会再把文本文件误当 PDF。
  (`0fbfa87` + `fdd8e36` + `ef132d8`)

### 改进

- **文本文档缩放和性能。** Markdown / HTML 支持独立缩放、触控板缩放手势和更稳的滚动恢复；
  Markdown 预览渲染减少重复工作，编辑模式下不会持续跑 Markdown parser。(`eeebdc6` +
  `b16ff6a` + `8ad6f54` + `77f5a98`)
- **HTML 运行首次白屏修复。** Run 模式的 blob URL 改为在 effect 生命周期内创建，并延迟回收，
  避免首次点击运行时 iframe 加载到已释放资源、必须再点刷新才显示。(`77f5a98`)
- **文档图片安全策略。** Markdown / HTML 中的本地相对图片可解析为安全 data URL；远程图片默认
  阻止，并由用户显式加载，减少 IP / 文档打开行为泄露。(`7f57dd4`)
- **内置浏览器可选保留登录态。** Browser panel 的用户数据 / 登录凭证是否保留改为用户可选，
  默认仍符合本地优先和最小持久化心智。(`a87dcd4`)

### 平台 / 发布

- **Android 发布链路补强。** 修复 Android 文件导入、launcher adaptive icon 前景裁切问题，
  并给 release workflow 增加 APK-only / AAB-only 选项和 Gradle cache，便于只重打移动端包。
  (`c01744b` + `ef132d8` + `fdd8e36` + `b53e353` + `906de2c`)
- **官网 / 商店下载文案调整。** 移动商店入口在官网三语中标记为 coming soon，避免用户把
  App Store / Google Play 误认为已经公开可下载。(`514948a`)

## [0.1.15] — 2026-05-30

### 新增

- **多标签页文档工作区。** 主阅读区新增 document tabs，可同时打开多个 PDF / Markdown /
  HTML；每个 tab 保留自己的页码、缩放、侧栏、标注编辑状态和脏状态。tab 可关闭、可拖拽
  调序，重启后恢复上次打开的工作区；关闭过的 tab 不会再自动恢复。打开已存在的同一 PDF
  会切到已有 tab，不再重复插入。(`7870778` + `ade3457` + `3f5cec2`)
- **Markdown / HTML 查看。** 增加安全的文本文档打开策略，Markdown 支持 front matter
  metadata 展示；HTML 改为隔离 iframe 渲染，尽量保留原文档自己的样式，同时阻断脚本执行。
  不支持的文件类型现在给出后缀不匹配提示，不再误报“文件损坏”。(`05c1095` + `a16be4a` +
  `2ea1b97` + `e790f96`)
- **iOS / iPadOS / Android 发布适配。** 初始化 Tauri mobile 工程，注册移动端 PDF / Markdown /
  HTML 打开方式，修复 iPad 文件选择器无响应、Open In / Share Target 路由和顶部安全区；
  移动端默认隐藏 Terminal / Browser / updater / reveal-path 等桌面专属能力。(`859be1d` +
  `5f6e68b` + `c5276f3` + `9864094`)
- **Android 双分发渠道。** Release CI 同时构建 Google Play AAB 和官网直装 APK；直装 APK
  版本在应用内检查官网最新包并打开 APK 下载，Google Play 版本交给商店更新。(`d86bab8` +
  `79b586b` + `531ffd2` + `bc2be80` + `b5bfd31`)

### 改进

- **阅读聚焦按钮归位。** 聚焦预览 / 全屏入口移到对齐按钮附近，并处理 macOS 红绿灯遮挡。
  (`6beb99e` + `d217c04`)
- **Tab 栏滚动更轻。** 横向 tab 区可滚动但隐藏粗滚动条，移动端布局也避开刘海 / 状态栏。
  (`ac4f0f3` + `c5276f3`)
- **深色主题品牌修正。** 左上角 logo 字形在夜间模式下保持浅色，不再被透明字形反成黑色。
  (`adc3e7d`)
- **发布与商店文案。** 官网下载卡、隐私政策、支持页、App Store / Play Store 所需说明同步
  移动端渠道和本地优先定位。(`6639318` + `47651a9` + `9864094` + `531ffd2`)

### 内部

- **Release CI 和签名修复。** 修复跨平台 release CI 的构建失败；macOS signed build 现在
  会对最终 DMG 执行 notarize + staple，避免 Gatekeeper 把已签 app 外层 DMG 判为未公证。
  (`9372341` + `25b9370`)
- **公共 beta 不再默认过期。** 构建过期检查改成显式 opt-in，商店/公开发布版本不会 60 天后
  自毁；closed beta 仍可用环境变量开启。(`47651a9`)

## [0.1.14] — 2026-05-30

### 新增

- **右栏内嵌终端。** 右侧 rail 新增「终端」tab，用 `portable-pty` 在 Shiori 内启动
  用户 shell，xterm.js 渲染输入输出；PTY 输出走 base64 chunk 过 Tauri event 保真
  ANSI / UTF-8；tab 切换保活、不杀 PTY，rail 可调宽。详见
  [POSTMORTEMS](docs/POSTMORTEMS.md)。(`a23f703`)
- **右栏内嵌 Browser 面板。** 新增「浏览器」tab（顶栏 globe 入口也可直达），用 Tauri
  `unstable` 多 webview 的 native child webview 渲染远程页（非 iframe — 站点的
  `X-Frame-Options` 与本地 CSP 都挡 frame）。地址栏 + 后退 / 前进 / 刷新 / 复制链接 /
  在系统浏览器打开；http(s) 进面板，其余回退系统。PDF 超链接、以及内嵌终端里的
  `open https://…` 都路由到面板。远程页 webview 按 `webviews:["main"]` 精确隔离、
  零授权，拿不到 Shiori 的 file / pdf / terminal commands。窄栏用移动 UA 自适应宽度。
  详见 [POSTMORTEMS](docs/POSTMORTEMS.md)。(`e900828`)

### 内部

- **修复 macOS 重启脚本的 `pkill` 模式。** BSD `pkill -f` 用 ERE，旧的
  `"shiori\|open-pdf-expert"` 里 `\|` 是字面竖线，静默匹配不到、每次「重启」其实没生效。
  改为两条、匹配完整二进制路径 `Shiori.app/Contents/MacOS/shiori`。(`77e9762`)

---

## [0.1.13] — 2026-05-29

### 新增

- **标注自由旋转。** `text` / `note` / `stamp` / `rect` / `contentText` 增加可选
  `angle`；overlay 改为中心锚定、按 `page.rotation + angle` 旋转渲染。选中后拖
  顶部圆手柄旋转，按住 Shift 自由角度、否则吸附 15°；移动 / 缩放 / 框选命中都
  合成元素角度。**注意：导出尚未把 element angle 写进 PDF（仅屏幕生效），
  作为后续。** (`8a6713d`)

### 改进

- **标注随页面旋转。** 页面旋转 90 / 270 时，文字框 / 边框 / 印章的朝向现在跟随
  页面（此前只转位置、没转朝向，且与导出 `/Rotate` 不一致）。与自由旋转共用同
  一套中心锚定旋转机制。导出方向由页面 `/Rotate` 保证。(`8a6713d`)
- **Ctrl / 触控板缩放更平滑。** 钳制每次事件的 deltaY（`clamp(-deltaY,-40,40)*0.005`），
  一格滚轮约 5–20% 平滑缩放，不再从 158% 突跳到 429%。(`8a6713d`)
- **缩放百分比可编辑 + 精确 100%。** 工具栏百分比改为可输入数值的字段；+/- 吸附到
  含 1.0 的倍率梯子；最大放大提到 8×（渲染位图有 `clampScaleToCanvasBudget` 上限，
  不会因此空白）。(`8a6713d`)
- **打开文档默认适应宽度。** 初始 `fitWidth: true`，不再以实际像素 100% 打开（宽
  窗口里只占约 3/5）；100% 仍是实际像素大小。(`8a6713d`)
- **拖动平移。** select 工具下空白处左键拖动平移画布，Shift+拖动为框选；按住 Shift
  时光标从 grab 切回箭头。`OverlayLayer` 经新增的 `ScrollerContext` 拿到滚动容器。(`8a6713d`)
- **缩略图旋转时不跳动。** 缩略图框锁定未旋转页面长宽比，旋转页面不再改变框尺寸 /
  旋转按钮位置，可连续点击。(`8a6713d`)

### 修复

- **大纲跳转高亮缩放后不再错位。** 高亮锚点改存 PDF 用户空间 Y，每次渲染按当前
  scale 重投影，缩放后始终贴着标题。(`8a6713d`)
- **撤销不再跳回编辑页。** 滚到别的页时让正在编辑的文字框失焦，避免聚焦的离屏
  textarea 劫持 Ctrl+Z 并被浏览器 scroll-into-view 拉回。详见
  [POSTMORTEMS](docs/POSTMORTEMS.md)。(`8a6713d`)

---

## [0.1.12] — 2026-05-19

### 改进

- **桌面端 PDF 渲染兼容性。** 修复部分 PDF 在桌面端无法渲染或渲染异常
  的问题；规避 pdfjs-dist worker 在 Tauri 环境下的若干差异。(`8f17a36`)
- **查找时滚到当前匹配。** 切换到下一个 / 上一个 find 结果时自动滚动
  到对应位置；如果当前匹配已经可见则不再抖动重排。(`fb05cfa` +
  `77e2096`)
- **CJK 文字导出退到向量轮廓。** 没有匹配字体时，flatten 导出不再把
  CJK 字符替换为 `?`，而是以 vector glyph path 形式写入 PDF；导出前
  对 path 做 sanitize 防止非法坐标。(`e8b6e26` + `d0e95d6`)
- **CJK 导出缺字符时提示用户。** vector path 不可用时 toast 报告缺失
  glyph，行为对齐既有的 sanitizeFor lostChars 警告。(`333ab1d`)
- **编辑保留原 PDF 页面坐标系。** 编辑 / flatten 后导出的页面不再因
  origin 变化而错位，annotation 坐标与原页面对齐。(`5f78193`)
- **导出后提供后续动作。** 导出完成 toast 增加「打开 / 在 Finder 中
  显示」之类的快捷按钮，便于继续工作流；同时 track 编辑是否已经导出
  以避免重复 dirty 提示。(`cddaa70` + `764ba56`)

### 修复

- **Web 最近文档恢复。** 浏览器 File System Access handle 失效（页面
  长时间未活动 / 权限被回收）时，最近列表不再静默清空或跳错文件；
  会尝试温和恢复，保留入口与 UI 反馈。(`b49e4ab` + `3fa3a5b` +
  `b65c24e` + `7c7f944`)
- **CJK 导出 PDF token 非数值时损坏文件。** flatten 路径在
  vector glyph 包含非有限 (NaN / Inf) token 时直接拒绝输出，避免
  生成无法被 Preview / Adobe 打开的 PDF。(`4fd5f6d`)

### 内部

- **Overlay 渲染拆模块。** 把 overlay 渲染拆成独立模块，gesture
  helpers 单独抽出，方便后续维护。(`73fb0d9` + `6a5987d`)

---

## [0.1.11] — 2026-05-16

### 新增

- **PDF 原文编辑（Text 工具下）。** 用户选中 PDF 页面文字后可直接创建
  content text edit overlay，通过就地输入或工具栏文字框修改；导出时写回
  PDF page content，而不是 FreeText annotation。覆盖原文使用 sampled
  background cover rect，并复用 pdf-lib/fontkit 写入字体。(`d934467` +
  `0ecfcb7` + `f2122c4`)

### 改进

- **文字编辑样式保真。** 从 pdfjs text content 推断 `fontName`、字号、
  weight / italic、颜色和背景，导出时优先路由到可用 PDF 标准字体或内置
  Noto / Liberation 字体；预览和导出共用 placement 偏移，减少 Shiori
  视图与 Preview 中的错位。(`b746bbb` + `e87c8a2` + `03437b6` +
  `ad93558` + `d65c84b` + `7998d1e` + `4e645f9`)
- **英文单词选择更接近视觉选区。** 对两端对齐论文、连字符前后、标点相邻
  的文字，改为结合 gesture bounds 与 text-run glyph offsets 来裁剪 /
  扩展选区，避免把前一个词尾带进来或漏掉目标词尾。(`57a6774` +
  `5ae2239` + `7f3cd30` + `8e5591e` + `5589bee` + `256db80` +
  `1d0ab19` + `c8a940b` + `808fdab`)

### 修复

- **空白文字插入清理。** 用户插入空文字后按 Esc、切换编辑对象或点击别处
  新建文字时，自动移除空 overlay 和对应 undo step。(`f131acf` +
  `cfb4521`)
- **普通视图不再残留文字编辑轮廓。** 非选中 content text edit 不再显示
  editor outline。(`96323e1`)
- **Linux release build 编译失败。** macOS 文件关联使用的
  `RunEvent::Opened` 只在 macOS 编译路径下引用，避免 Linux / Windows
  release target 找不到该 variant。(`本次`)
- **Beta 过期处理。** Tauri build 注入编译时间，beta 过期后显示
  `ExpiredScreen` 并指向下载页。(`02328ac`)

---

## [0.1.9] — 2026-05-04

### 新增

- **打印功能。** `Cmd+P`、TopBar 打印按钮、macOS File > Print 菜单。
  通过 export pipeline 生成 flatten PDF，用隐藏 iframe 调浏览器原生
  打印对话框——页面布局正确、无 UI 水印、默认文件名为 PDF 文件名。
  Web + Tauri 双端可用。(`f9b0467` + `3009342` + `1369c33`)
- **PDF 文件关联（macOS）。** 双击 `.pdf` 或 Finder "Open With" 可直接
  用 Shiori 打开。`tauri.conf.json` 注册 file association，Rust 端
  `RunEvent::Opened` 缓存路径 + emit 事件，前端 drain 去重。(`ea0d48c`
  + `713d1bc`)
- **密码保护 PDF 解锁。** 打开加密 PDF 时弹出密码输入对话框，支持
  错误密码重试。密码通过 `OpenedPdf.password` 贯穿导出 / 合并流水线，
  `pdf-lib` 端用 `ignoreEncryption` 处理。三语 i18n。(`c7d51fc` +
  `f8435f3`)

### 改进

- **导出不可编码字符警告。** `sanitizeFor` 返回 `lostChars` 计数，
  flatten 导出后如有字符被替换为 `?` 则 toast 提示用户。preview cache
  同步保留 `lostChars`。Unicode 拆分改用 `[...text]` 正确处理
  emoji。(`f581cc3` + `f8435f3`)
- **导出页面复制失败抛错。** 不再静默跳过无法复制的页面。(`cbe2b16`)
- **测试覆盖 +5。** `isPrintHotkey`、`classifyPdfOpenError` password /
  damaged 分类、`exportPdf` lostChars 非零 / 零。(`c299207`)

### 修复

- **`draftState` effect 依赖。** `pagehide` listener 不再因对象引用
  不稳定反复注册 / 卸载。(`6171f79`)
- **缩略图渲染失败不再被静默吞掉。** 改为 `console.warn`，仅在
  非 cancelled 时输出。(`03ec607`)
- **加密 PDF 合并。** `appendPdfBytes` 加 `ignoreEncryption`，避免
  合并操作因加密标志崩溃。(`713d1bc`)
- **文件关联重复打开。** drain 与 listener 去重，同一路径不会被打开
  两次。(`713d1bc`)

---

## [0.1.8] — 2026-04-28

### 新增

- **阅读进度恢复到上次阅读页。** Recent 文档记录 `lastViewedPageIndex`，
  从首页重新打开同一 PDF 时回到上次停留页；新增 8 个 store 单测覆盖
  recents 更新 / restore 边界。(`577ee17`)
- **大纲节点可逐项折叠。** Outline 面板支持二级及以下目录按节点展开 /
  折叠，并用 chevron 显示状态。(`e2c1549`)
- **删除 / 复制操作带 Undo toast。** 删除页面、删除批注、复制等高风险 /
  剪贴板操作完成后给出带操作按钮的 toast，三语 i18n 同步。(`35d1cf6`)

### 改进

- **Modal 统一接管 Escape。** Settings / Export 等 Modal 通过 capture-phase
  `useEscapeClose` 关闭，并在打开期间用 `data-shiori-modal-open` 阻止
  canvas 层把 Esc 当作工具切回 Select。(`de0db67` + `15eae9a`)
- **缩略图滚动条常驻且深色主题可见。** Thumbnails rail 的滚动条改为可抓
  取的常驻样式，并用 `color-mix(--opx-ink)` 适配 Night theme。(`085b36e`
  + `5985d27`)
- **页面边距预设切换时保持阅读锚点。** 修改 page margin 后按当前视口
  anchor 重新定位，不再偶发跳页或看起来没有生效。(`e7bc03b`)

### 修复

- **便签拖动后无法继续编辑。** 对编辑中便签的拖动 / blur 竞态加
  `editDragBlurSuppressionRef` 与纯函数单测；空白新便签禁用拖动，避免
  pointer drag 抢走 textarea focus。时间比较统一使用 `event.timeStamp`，
  不再和 wall-clock 混用。(`2a1d1c7` + `3aa5a5b` + `15eae9a`)
- **中文 / 中英混排高亮边界过宽或裁字。** 移除 CJK 水平 padding，保持
  pdf.js / browser selection rect 主路径；对单行 CJK 且 DOM Range 明显
  比用户拖拽范围宽的 case 增加 conditional soft clip（`over-extension /
  raw >= 20%`，带字号相关 margin），避免大标题左右明显溢出，同时不裁短
  普通正文。(`a9e23a8` + `15eae9a`)
- **标记选中时横幅状误选。** `filterDistantClusters` 按 cluster 距离过滤
  远离选区锚点的 rect，减少跨栏 / 离群 selection rect 被合成进高亮。
  (`000fae8`)
- **pdf.js v5 下 render 成功但 canvas 全白。** 切换到 v5 `canvas` API，
  并把 blank detector 改为两阶段采样：先 49 点快检，再 dense scan 降低
  误报；记录 `checkedPixels` / `nonWhiteSamples` 便于后续定位真实白屏。
  Postmortem 见 `docs/POSTMORTEMS.md`。(`9226b38` + `15eae9a`)

### 平台

- **版本号升到 0.1.8。** `package.json`、Tauri 配置、Cargo package /
  lockfile 同步更新；macOS aarch64 与 universal release artifacts 已按
  0.1.8 重新签名、notarize、staple。(`15eae9a`)

## [0.1.7] — 2026-04-27

### 改进

- **桌面文件读写收紧到专用 Rust 命令。** 前端不再持有 generic fs scope；
  所有 PDF 读 / 写都走窄接口（`open_pdf` / `save_pdf`），
  `capabilities/default.json` 同步收缩。(`bfa5390`)
- **Beta 大小 / 页数 / canvas 预算前置校验。** 超过 200 MB / 500 页 /
  canvas 像素上限的 PDF 在打开前直接拒绝，避免触发慢路径或 OOM；
  `src/pdf/openPolicy.ts` + 单测覆盖 edge case。(`bfa5390`)

### 平台

- **macOS 双产物：Apple Silicon 原生 + Universal。** `build-signed.sh`
  顺序跑 `aarch64-apple-darwin` 和 `universal-apple-darwin` 两 pass。
  Apple Silicon Mac 拿小的原生 ARM dmg（~16 MB），Intel Mac 继续拿
  universal（~30 MB，aarch64-only 不能在 Intel 上跑）。总构建时间约
  1.5–2× 单 universal。(`2af5259`)
- **落地页下载按钮通过 Cloudflare Pages Function 跳转。** `https://
  shiori.nagi.fun/download/<platform>` 命中时实时查 GitHub API 拿
  latest release 资产 URL 并 302，5 分钟 cache。版本变了不需要重新
  发布站点。(`2af5259`)

---

## [0.1.6] — 2026-04-26

### 新增

- **删除线（StrikeOut）text markup 工具。** 沿 v0.1.5 underline 的同一条
  pipeline 加 `StrikeOutOverlay` / Tool enum / OverlayLayer 渲染（线在
  rect 中线，约 50% 高度位置）/ TextHighlightLayer commit handler /
  pdf-lib `/Subtype /StrikeOut` 写入 / pdfjs `subtype === "StrikeOut"`
  解析 / flatten 路径 / Thumbnails compositor / ContextualToolbar 按钮 /
  i18n（en "Strikethrough" / zh "删除线" / ja "取り消し線"）。PDF 标准
  4 种 text markup（Highlight / Underline / StrikeOut / Squiggly），
  Shiori 现支持 3 种。(`feb8e15`)
- **Landing 引文随机轮播。** 不再固定显示传道书 12:12，按 UI locale
  从 `src/editor/quotes.ts` 静态池里 `useMemo` 一次挂载选一条；池子按
  `en` / `zh` / `ja` 三组分，每组 ~40 条来自 `docs/quotes-pool.md` 的
  curated literary aphorism（公版 + 短引用为主——Pliny / Seneca /
  Petrarch / Bacon / Borges / 庄子 / 苏轼 / 陶渊明 / 西行 / 兼好 /
  漱石 / 良寛 等等）。`landing.quote` i18n key 已移除。(`9f2b9a4`)

### 改进

- **HighlightOverlay 和 NoteOverlay 工具栏改用 ExpandableColorPicker。**
  之前两者锁固定 5 色 swatch；现在弹出色板支持任意 hex + recent colors
  记忆。`ContextualToolbar.tsx` 替换两处 `<ColorSwatches>` 为
  `<ExpandableColorPicker>`，传 `recent` / `onCommit` props。`ui.tsx`
  里 ExpandableColorPicker 的注释更新匹配新用途。(`9b9c50c`)
- **ResourceMetricsPanel 自适应 grid。** 用 wrapping content layout 替
  换固定列数，避免长 localized pressure label 与 memory value 视觉碰
  撞。(`b1c6139`)

### 修复

- **PDF imported annotations 不再产生 undo entry。** 之前 `setOverlays`
  在初始化时也走 `commit` 路径产 undo snapshot，导致用户打开带注解的
  PDF 后按 Cmd+Z 会"撤销"原 PDF 的注解（实际只是 overlay 列表回退一
  格，文件不动）。改为初始化跳过 commit；同时 undo / redo 在恢复 cloned
  page array 但 active page 不变时不再 scroll 回当前页顶端。(`0d554e0`)
- **markup mode 按钮 pointer focus 残留。** 切换 highlight → underline
  等场景下 Chromium native focus ring 不会自动清除，导致前一个工具按
  钮还戴着浅色框。改为 mousedown 后主动 blur。(`4ce1aca`)
- **dark mode 下 inactive markup mode 按钮的 ring。** 用专门的 markup
  mode button style，只让 active 模式填充，inactive 模式不再保留浅色
  outline。(`a21cdad`)

### 平台

- macOS 自 v0.1.5 起为 **Universal Binary**（Apple Silicon + Intel 共用
  同一份 `.dmg`，~30 MB）。
- **Linux 平台**自 v0.1.5 起正式支持：`.AppImage`（便携版 + auto-update）
  和 `.deb`（Debian / Ubuntu 安装包）。两者通过 GitHub Actions ubuntu-22.04
  runner 构建。

---

## [0.1.5] — 2026-04-26

### 新增

- **下划线工具。** Highlight 之外的第二种文本标注：在文字层选区后渲染
  glyph 下方的精确底线。Snap 到 PDF 真实 text run 边界，可调样式 /
  拖拽编辑 / 导出为标准 PDF Underline 注解。(`35ea936` + `4be2127` +
  `dc4ab96`)
- **macOS 原生菜单栏。** Tauri 2 默认不生成 macOS app menu，应用栏只
  剩 OS 兜底的 "Quit Shiori"。新增 Shiori / Edit / View / Window 四级
  菜单：About、Check for Updates、Settings (⌘,)、Zoom In/Out (⌘=/⌘-)、
  Actual Size (⌘1)、Fit Width (⌘0)、Services / Hide / Quit、
  Cut/Copy/Paste/Select All、Minimize/Zoom/Close Window。自定义项通
  过 Tauri event 回到 React 触发已有 store action；预定义项由 Cocoa
  直接处理。cfg-gated 仅 macOS 编译。(`d8a690a`)
- **资源监控面板。** Settings → Performance 显示 Shiori 进程的 CPU /
  RSS。Rust 侧 `get_process_metrics` Tauri command（macOS / Linux 走
  `ps -o %cpu= rss=`，Windows 给空值）；前端 `platform/metrics.ts`
  封装、`ResourceMetricsPanel` 渲染、低频轮询。(`196eeb1`)
- **GPU 加速开关。** Settings → Performance 加 toggle，关掉后 pdfjs
  `enableHWA: false` 走软件渲染。默认开。Prefs schema 加 `gpuAccel`
  字段。(`5b9d166`)
- **错误诊断报告。** ErrorScreen + ExportDialog 提供 "Copy diagnostic"
  按钮，把 file size、error code、runtime 上下文打成可粘贴块。
  `runtime/diagnostics.ts` 新增 `buildDiagnosticReport()` /
  `copyDiagnosticReport()`。(`196eeb1`)

### 改进

- **平滑缩放 (smooth zoom)。** 触控板 pinch / Cmd+滚轮缩放期间不再每
  帧 pdfjs 重渲染。`PageCanvas` 跟踪 `renderedScale`，手势中通过
  `transform: scale(scale/renderedScale)` CSS 拉伸现有位图（GPU
  bilinear，60 fps），settle 后才触发完整重渲染。`gestureZoomingRef`
  同步透到 PageCanvas 双重 gate（state 走 React 批处理可能慢一帧，ref
  同步赋值，避免第一帧因 Zustand 同步推 scale 而 React state 还没
  commit 触发的 ~100 ms pdfjs render 卡顿）。Postmortem 见
  `docs/POSTMORTEMS.md` 2026-04-26 条目。(`9ecbc2a`)
- **最大缩放 300% → 500%。** 单 canvas 架构下不会触碰 webview 像素上
  限。MAX_SCALE 同步更新。(`ec5ef9d`)
- **单文件上限 50 MB → 200 MB；总缓存 200 MB → 1 GB。**
  `MAX_PDF_BYTES` / drafts 仓库 `CAP_BYTES` 双调；`formatBytes` 加 GB
  档。(`2dc0624`)
- **Windows 任意路径打开 PDF。** Tauri capabilities `fs:scope` 从五个
  用户文件夹改成 `[{path: "**"}]`。之前 Windows 用户从其他盘 / 自定义
  目录打开 PDF 会被拦。(`2dc0624`)
- **公开主页 site/。** Vite + React，en/zh/ja 三语，部署 GitHub Pages
  到 shiori.nagi.fun（暂为占位）。(`ae50803`)

### 修复

- **论文 PDF (justified text) 自建高亮越过最后一个字。** 沿 v0.1.4
  的 cap 思路进一步收紧：`snapDisplayRectsToTextRuns()` 用 pdfjs
  `getTextContent()` 真实 text item transform + width 算出每行 glyph
  ink 的实际右边界，把高亮 / 下划线 rect cap 到这个边界。Postmortem
  见 `docs/POSTMORTEMS.md` 2026-04-25 条目。(`4be2127` + `dc4ab96` +
  `4478eea` + `928135e`)
- **行尾窄字符 (`,`、`.` 等) 被裁。** Snap 时给左右边缘留按字号缩放的
  余量，不再硬 cap 切半。(`4478eea`)
- **高放大倍率下横向滚动行为不正确。** Canvas 容器 / Virtuoso 滚动
  逻辑修。(`928135e`)
- **导出 CJK 文本换行 / 对齐错位。** 把 `wrapText` / `measureTextWidth`
  抽到 `src/pdf/export/textWrap.ts`，FreeText appearance 和 flatten
  路径都通过 fontkit pathFont 测量 glyph advance width。pdf-lib
  `widthOfTextAtSize` 对未在 codepoint 表里的 CJK 字符用 fallback 宽
  度估算导致 wrap / center / right alignment 错位；用 fontkit 真实
  glyph 宽度后所有路径一致。(`cce8e75`)
- **CJK FreeText 注解导入字号丢失。** pdf.js 解析不出自定义 CJK 字体
  时 `appearance.fontSize` 返回 0，原代码兜底到 14。新增
  `parseDefaultAppearanceFontSize()` 从 DA string `/Name <size> Tf`
  正则回收尺寸；加 regression test。(`4b3ffc6`)

### 内部

- **store 单元测试。** `editor/store/store.test.ts` 锁住 `deletePage`
  会同步删掉绑定到该页的 overlay 这个合约。(`5e4bdf4`)
- **平滑缩放第一帧卡顿 postmortem。** Zustand 同步 vs React state
  异步反应度错位记入 `docs/POSTMORTEMS.md`。(`9ecbc2a`)

---

## [0.1.4] — 2026-04-26

### 新增

- **Tauri auto-updater 全链路上线。** Ed25519 签名 + 自托管 manifest
  (`updates.shiori.nagi.fun/alpha/latest.json`) + UpdateModal UI（启动
  4 s 后自动检查 + Settings → Updates 手动按钮）。Per-locale release
  notes 通过 `notes/<version>.json` 在线获取，UpdateModal 按 UI 语言
  挑对应字段。(`3a6456a` + `e723a34`)
- **macOS 签名 + notarize。** Developer ID Application 证书签名 +
  notarytool 提交 Apple Notary + stapler；`scripts/build-signed.sh`
  封装。Beta kill-switch 期延长到 60 天。(`a2a0bd8`)
- **Windows 签名构建。** GitHub Actions release workflow 跑 Windows
  MSI 打包 + .msi.sig（Tauri Ed25519）+ 上传到 shiori-releases。同时
  CI cache 清 `bundle/` 子树以免上次 release 残留 artifact 误传
  （v0.1.2 撞过这个坑，见 POSTMORTEMS 2026-04-25 条目）。(`6b8c417` +
  `c5390c6`)

### 修复

- **Cmd+A 把整页染蓝。** `selectAllOnPage` 之前会让 OverlayLayer 在
  PDF 之上铺一层 selection rect 覆盖整页；改成只在 textLayer 选区时
  全选文字，画布上时全选当前页 overlay 对象。(`16a1fa5`)
- **滚动判定不准。** 以前用 Virtuoso `itemsRendered` 仅 mount/unmount
  fire，overscan 期间触发不到，结果向下滚跳页、向上滚卡页。改成
  scroll listener + rAF + DOM querying 算每帧视口重叠度。(`1d483de`)
- **Shiori 自建高亮越过最后 glyph。** Cap 高亮 rect 的右边界到该行
  PDF text item 的实际右边缘（pdfjs `getTextContent`），论文 PDF
  justified text 上溢出问题首次解决。v0.1.5 进一步用 glyph metrics
  snap。(`9dd1224`)
- **重叠高亮 quad 叠成深色色带。** 同区域多次 quad 自动 merge；从
  其他编辑器导入的高亮 opacity cap 到 0.6。(`3538952`)
- **缩略图栏不显示批注。** 新增 `thumbnailCompositor` 把 ink / text /
  stamp / highlight overlay 合到 thumbnail tile 上。注意 canvas DOM
  尺寸合约坑（`renderPageToCanvas` 写死 inline px style 与响应式 tile
  布局打架）—— 见 `docs/POSTMORTEMS.md` 2026-04-25 条目。
  (`18c7dc4` + `c16f23b`)
- **Modal 关闭按钮被滚动条挤出视野。** Modal 加 `footer` slot 用
  `flex: 0 0 auto` 钉死底部；ChangelogModal 拿掉嵌套滚动 div。
  Postmortem 见 `docs/POSTMORTEMS.md` 2026-04-25 条目。(`74301ce`)
- **高亮选中状态视觉不可见。** 选中边框走 mixBlendMode multiply 被
  自身高亮颜色吞掉；把选中边框移出 multiply 组、用 T.accent 蓝单条
  padded outline；同时移除高亮的 resize handle（语义上不该有：高亮
  rect 跟着 glyph 走，不应可拖动）。(`d34de8f`)

### 改进

- **更新说明跟 UI 语言走。** UpdateModal 按 `pickLocaleKey()` 选 zh /
  ja / en，从 `notes/<version>.json` 拿对应字段；fallback 到
  `update.body`。(`e723a34`)

---

## [0.1.3] — 内部里程碑（未发布）

仅 tag 不发布的内部 milestone。Auto-updater 基础设施先 land，再走
v0.1.4 的签名 + notarize 后第一次正式 ship。(`3a6456a`)

---

## [0.1.2] — 2026-04-25

### 修复

- **Windows mono 文本锯齿。** TopBar meta 行、`kbd`、页码等 monospace
  文本在 Windows 上因为系统无 JetBrains Mono / IBM Plex Mono / SF Mono /
  Menlo，全 miss 后兜底到 generic `monospace` = Courier New，10.5px 渲染
  锯齿严重。字体栈补 Cascadia Code / Cascadia Mono / Consolas 作 Windows
  fallback，并把 JetBrains Mono Regular + Medium 作为 woff2 自托管进包，
  彻底移除对系统字体的隐式依赖。(`3bbbe0a`)

### 改进

- **UI 字体栈真正跟 UI 语言切换。** 原先 `T.sansJa / serifJa / monoJa`
  只在 ChangelogModal 里用，其他 UI 无视语言一律走 Latin 栈，中日文字
  符靠浏览器 per-glyph fallback，连 Han 字形的地区变体都不可控。改造成
  CSS 变量 `--opx-font-sans / -serif / -mono`，根节点按 `html[lang^="zh"]`
  / `html[lang^="ja"]` override，`i18n.languageChanged` 时同步
  `document.documentElement.lang`。`index.html` 的 `lang="en"` 之前是
  死的。(`966fb86`)
- **UI 主力字体自托管打包。** Inter Tight（400/500/600/700，后者给
  FindPanel 匹配高亮用）、Instrument Serif（Regular + Italic）、Klee One
  （Regular + SemiBold）、Shippori Mincho（Regular）全部以 woff2 打进
  bundle。Inter Tight 和 Instrument 用 Google Fonts 官方 Latin / Latin-ext
  `unicode-range` 切分；品牌字 Klee 和 Shippori 用 `subset-font`（HarfBuzz
  WASM）切到只含实际渲染的字符 —— Klee 只要 `S h i o r` 5 个字母、
  Shippori 只要 `栞` 一个字，产物 <4KB 被 Vite 内联进 CSS。Bundle 增量
  约 368KB。(`3bbbe0a`)
- **品牌字 subset 脚本。** `scripts/subset-brand-fonts.ts` 读 `src/assets/
  fonts/source/` 下的源 TTF，用 `subset-font` 生成 woff2 到 `src/assets/
  fonts/ui/`。源 TTF 被 `.gitignore`，woff2 产物进仓库；brand mark 换字
  符时重跑脚本重新生成。(`3bbbe0a`)
- **小字 display serif 的预处理。** Instrument Serif 是 display 味很重
  的衬线，原先 Landing / TopBar / Thumbnails / ContextualToolbar /
  SettingsPanel / ChangelogModal 有 14.5-15px 的使用点，Windows 上 Georgia
  兜底刚好能读；自托管后真 Instrument 生效会让小字可读性下降。这些位
  置提前改走 `T.sans` 或 `T.bodySerif`（Times New Roman 栈），然后再打
  包字体。(`3bbbe0a`)
- **Windows 日文字体 fallback 补齐。** `T.sansJa / serifJa` 补上 Yu Gothic
  UI / Meiryo UI / MS PGothic / MS Gothic / MS PMincho / MS Mincho，纯
  英文 Windows 未装 Japanese Supplemental Fonts 的用户切到日文 UI 也
  不会变豆腐。(`966fb86`)

---

## [0.1.1] — 2026-04-24

### 新增

- **Landing 整页重设计。** 新首页铺成单屏布局：hero 标语 + 最近文档列表
  （每条带 PDF 首页缩略图，`ec80153`），右下角聚拢语言 / 主题 / 版本号小
  部件（`5a71dc7` / `1d7958f` / `c143b20`），Drop-zone 换成更像一张纸的
  SVG tile（`9d36451`），首页按 `?` 能直接弹出快捷键面板而不用先打开
  文档（`811d87d`）。整体落地见（`f230e00`）；配色配套换成冷白纸面 +
  #3388BB accent 蓝（`91ee4e8`），连同 OS 图标 / brand tile 也重刷成
  accent 蓝的（`eab08bc`）。
- **触控板捏合缩放 PDF。** 双指捏合手势直接驱动缩放，以手势中心所在的
  那一页为 anchor 反向调整滚动位置，避免缩放后视线跳到文档别处。原先
  只支持 Ctrl+滚轮，trackpad 捏合没有响应。(`d2d9dcd`)
- **文本查找 Find 面板 + 直接拖选 + 主题色高亮。** `Cmd/Ctrl+F` 打开
  in-document 搜索，结果按当前主题 accent 色高亮；在任何工具下都能直接
  在 PDF 文字上拖选，松手弹出 quick action 做高亮，不需要先切到高亮
  工具。(`9512cca`)
- **PDF 超链接可点击。** 通过 pdfjs AnnotationLayer 渲染原 PDF 里的外部
  URL 和文档内跳转链接，点击外部链接走 platform open，点击内部链接走
  内部 named-destination 路由。(`24b0902`)
- **大纲精准跳转 + in-PDF 跳转标记。** 在 PDF 上点一处，outline 会跳到
  最近的那条、自动展开祖先；反向点 outline 也会在 PDF 对应位置闪一条
  标记条；标记条 hitbox 拉宽覆盖整行标题，视觉对齐也更稳。(`ab82b8e` +
  `2908543`)
- **导出保留 outline 和 named destinations。** 之前 pdf-lib 重写时会
  丢书签和内部命名链接，编辑后的 PDF 打开就"没目录了"。现在把 outline
  树与 named destination 字典一起搬运过去。(`0fc9406`)
- **复制和搜索读 ActualText。** pdfjs 在 marked content 上暴露 ActualText
  时优先用它，对扫描件 OCR、复杂脚本、合字（ﬁ / ﬂ）都能拿到正确的
  底层文本，复制出去和搜索匹配都不会再是乱码。(`6022a6d`)
- **缩略图栏方向键翻页。** 焦点落在 thumbnail rail 时 `↑ / ↓` 直接切页，
  不需要鼠标再点一次缩略图。(`bc49c84`)
- **勾叉印章工具。** 表单填写时可以点击或拖拽放置暖色手绘风的 ✓ / ✗，
  可调颜色与线宽；展平导出保持矢量笔画，可编辑导出用 Zapf Dingbats
  FreeText 注释便于回读。(`63f2524` / `067e43d`)
- **扫描件高亮的拖动预览。** 扫描件 PDF，以及任何 pdf.js 无法提取文字的页面，
  拖动时会显示半透明预览矩形；一旦有原生文字选区就自动隐藏。(`eeda59d`)
- **Changelog 三语体系 + 点版本号弹窗。** Changelog 从一份合并文件拆成
  maintainer 本（本文件）加 `docs/changelog/{zh,en,ja}.md` 三份用户精简版
  （`b49c480` / `f31bfdc` / `c0259f2`），点右下角版本号按当前 UI 语言打开
  对应文件（`f118e19` / `247e8b5` / `c143b20`）。

### 修复

- **macOS 高亮工具可以选中文字了。** 之前 pdf.js 的文字层在 WKWebView 上静默
  渲染失败：内部用 `for await (stream)` 读取，而 WKWebView 缺 `ReadableStream.
  prototype[Symbol.asyncIterator]`，直接抛错，文字 span 根本没挂上。在 app
  启动时 polyfill 这个方法，Mac 上的高亮现在能正常贴文字。
  详见 [WKWebView 高亮血泪史](docs/POSTMORTEMS.md)。
  (`1309118`，配套 `9b74d22` / `d0ce596` / `429c06c`)
- **高亮工具：连续点击不再触发整页高亮。** WKWebView 会把连续快速点击升级成
  "选中整个元素"，4 次以上点击会把整个文字层选中。现在对位移 < 4px 的手势，
  如果点击次数 ≥ 4 或选区面积 > 85%，直接拒绝提交。(`73fd30c`)
- **高亮工具：空白区双击/三击不再触发整页高亮。** 记录手势起点是否落在真实
  文字 span 上；起点在空白区且没拖动的手势直接拒绝。(`777a29f`)
- **高亮工具：重叠矩形不再出现深浅色带。** 浏览器选区返回的多个 client rect
  在垂直方向上常有微小重叠，半透明渲染会叠加变深。现在在提交前按视觉行
  合并重叠 rect。(`71e32eb`)
- **高亮工具：空白点击取消选中。** 高亮工具下点击空白区会清除当前标注的选中
  状态，与 "选择" 工具一致。(`20457a4`)
- **跨栏高亮正确分段。** 双栏 / 三栏版面里，浏览器 selection 的 client rect
  会返回一个贯穿栏间距的大矩形，高亮贴上去就会把栏间的空白也涂成颜色。
  现在检测栏间 gap 并按栏切分 rect。(`1ebf049`)
- **同色高亮涂叠自动合并、重涂取消；异色叠涂正常合并。** 在已有同色高亮上
  再涂一次不是把颜色叠深，而是把重叠区 toggle 掉；不同色之间仍然按几何并集
  合并，符合纸上荧光笔的直觉。(`2b100c7`)
- **文本光标不再显示 move-grab。** 高亮本质上贴着底下的文字跑，不是可自由
  拖动的对象，鼠标悬上去不该再变成抓手。(`9afbb0b`)
- **文本高亮不能再被拖动移位。** Move-drag 分发路径里直接把 text highlight
  类型剔除，避免高亮被拖离底下文字造成错位。(`a13c38a`)
- **捏合缩放时文本选择暂停。** 手势进行中 text layer 的 selection 被短路，
  避免双指捏合时 WebKit 把沿途经过的一整段文字一起选中。(`17892c4`)
- **大纲条目去掉页码后缀 + 标记条 hitbox 拉宽到完整标题。** outline 文本
  不再拼"· 23"那种尾巴；视觉上标记条也覆盖整行，不再只框中文字的左半部分。
  (`23fd2bc` + `2908543`)
- **当前页判定改按视口重叠度最大的那一页。** 之前取"第一条尚未滚出视口
  上沿的页"，快速滚动时会在两页都部分可见的瞬间跳到下一页、松手后又跳
  回来。现在直接算每一页与视口的重叠像素并取 argmax。(`7aba3dc`)
- **CJK 字体优先级修复。** 按系统 locale 走母语字形变体（中文 locale 优先
  中文字形，日语 locale 优先日语字形）来排 fallback；顺带修了 Japanese
  changelog 语言选择问题，给 Changelog modal 挂上 CJK fallback，pdfjs 的
  CMap 与 standard font assets 打进 bundle。(`89b3a26` / `c3c37c1` /
  `da1f8f9` / `f504fc1` / `69af1ce`)
- **导出 PDF 的阅读器兼容性拓宽。** 调整了注释字典结构和字体引用写法，
  现在在 Preview / Acrobat / 三方 Reader 上都能无警告打开。(`be156cb`)
- **编辑为空时跳过 PDF rewrite。** 只是打开浏览而没做任何改动时不再走一次
  pdf-lib 的 save 路径，避免原文件被无理由重写（时间戳、结构都会变）。
  (`53d9ae8`)
- **CJK 标注导出保持紧凑。** 之前为了显示 CJK 字形会把整套字体嵌进去，
  几个字的注释就能让文件涨几 MB。现在只嵌用到的字形子集。(`9dc4da3`)
- **Landing 语言切换的字形残影修复。** WebKit 在大号 serif `<h1>` 上直接换
  字时会留下一帧上一语言的 glyph 残影。现在切语言时整个 Landing 先淡出
  140ms 再替换文本，切回来时淡入。(`78805ff` / `1560335` / `4243937`)
- **Windows 快捷键标签按 Ctrl+Shift+Z 习惯排序。** 快捷键面板之前在 Windows 上
  显示 `Shift Ctrl Z`（从 macOS 的 `⇧⌘Z` 直接逐字符替换）。非 Mac 平台现在按
  Ctrl → Alt → Shift 重新排序。键盘监听本来就与修饰键顺序无关。(`5936d3e`)
- **Beta 阶段高亮运行时调试日志清理。** v2 修复稳定后把 `[shiori-hl-debug]`
  console.warn 拆掉，不再污染用户控制台（原埋点来自 `9eb8d4f`）。

### 改动

- **Draft 缓存上限 100MB → 200MB，状态栏可直接管理。** 新增 drafts 面板
  按 size 倒序列出所有 draft，可单条删也可一键清空，不用再去浏览器
  devtools 里手动清 IndexedDB。(`8859193` + `0c13d31`)
- **PDF 首页缩略图用 pdfjs offscreen canvas 采集，存 IndexedDB。** Landing
  最近文档列表优先展示真实缩略图；尚未采集到的回退到 mock 纸面图案，
  下次打开同一文件时补齐。(`ec80153`)
- **配色切换到冷白纸面 + #3388BB accent 蓝。** chrome 级 token 全量重铺
  （背景、边框、hover、焦点环），brand tile / OS 图标同步改 accent 蓝。
  （`91ee4e8` / `eab08bc`）
- **字体加载继续收紧，去掉运行时拉 Google Fonts 的残留路径。** 0.1.0
  已经把主路径改成内置字体；0.1.1 沿着 CJK 修复又收紧了一轮 fallback
  顺序，见上面 CJK 字体优先级修复条目。
- **画笔拖动预览跟随用户选的颜色和粗细。** 实时笔画之前固定用一个设计 token
  颜色 + 硬编码 `strokeWidth={2}`，松手后才跳成正确颜色。现在预览样式和最终
  落笔完全一致。(`9b5b8b7`)
- **画笔：改已选中笔画的样式会同步更新默认。** 匹配文本工具已有的 "最近使用
  样式胜出" 模式。之前改完选中笔画的颜色后，下一笔又退回旧默认色。(`5119567`)
- **荧光笔 / 矩形 / 便签也继承 "最近使用样式胜出"。** 覆盖选中分支下的颜色、
  线宽、透明度控件。(`e1e7f7b`)
- **所有标注工具的拖动预览都是 WYSIWYG 的。** 矩形、荧光笔、便签、文本框的
  预览现在用当前工具的默认颜色 / 线宽 / 字体 / 填充透明度渲染，不再是统一的
  虚线占位框。(`d7362e0`)
- **设置页画笔色板支持自定义颜色。** 从固定 4 色升级为完整的
  `ExpandableColorPicker`，接入 `prefs.recentColors`。(`73ec8fc`)
- **设置页便签色板扩充到 5 色。** 与工具栏调色板对齐。(`e3412dc`)
- **文本字号控件上限统一为 144pt。** 之前选中文本的加号能加到 144、默认工具
  的加号卡在 96，会把升上去的默认值压回来。现在两边共用 `TEXT_FONT_SIZE_MAX`。
  (`8b6b050`)

---

## [0.1.0] — 2026-04-21

Beta。从 "Open PDF Expert" 改名为 Shiori（`fun.nagi.shiori`）。构建带
7 天有效期（从编译时间起算）；发布工作流仅 Windows，产物发送到
`shiori-releases`；去掉了运行时拉取 Google Fonts，改用内置字体。
（此之前的 commit 未记入本 changelog，参见 `git log 919ff30..`。）
