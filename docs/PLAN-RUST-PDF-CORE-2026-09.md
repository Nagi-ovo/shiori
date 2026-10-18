# Rust PDF 核心（PDFium）：计划 · 路线图 · TODO

2026-09-07 立项（起点 `88ff0d70`，页面列不再换代之后）；2026-09-25 修订：重新盘点
pdf.js 调用、修正阶段 1 的前提、记录新决策、改成可逐项勾选的 TODO。

**这是 Rust 核心的唯一进度来源。** 做完一项就在这里勾掉，在文末「进度日志」记一行；
决策变了就改「已定决策」并写日期。HANDOFF 只指向本文件。

状态：**阶段 0–4 已完成，待环境的验收除外：3.6 的 Windows 实测，4.6c 的 Android 真机（测试包已出，待真机过 A0.13）。阶段 5：5.1 完成；5.2 Android 原生 PDFium 是性能优化，不阻塞任何发布，需要 Android 环境（见决策表）。pdf.js 已不在 App 里。**

## 原则

- **体验最好，长期主义。** 工程量和工期不是取舍理由（Jesse，2026-09-25）。取舍只看
  最终体验、一致性和长期维护。
- **一套核心，处处一致。** 桌面、Web、Android、CLI 最终都用同一个 `shiori-core`
  （Rust + PDFium）读和画 PDF：同一份文件在哪里打开，像素、文字位置、批注都一样。
- **每一步都能单独合并、单独回退。** pdf.js 在阶段 4 完成前一直留在树里，随时能停（4.7d 已移出 App）。

## 为什么

缩放松手的闪已经由架构修掉（页面常驻、去掉换代）。剩下两件事 pdf.js 做不到：

1. **高倍缩放不清晰。** 整页位图受 `MAX_CANVAS_PIXELS = 32e6`
   （`src/pdf/openPolicy.ts` 的 `clampScaleToCanvasBudget`）限制。Retina（dpr 2）上
   letter 页最多画到 4.06×，A4 到 3.99×；而 `Canvas.tsx` 允许缩到 `MAX_SCALE = 8`。
   所以 4× 以上看到的是 4× 位图被 CSS 拉大，永远不会变清晰；一张封顶的整页位图是
   128 MB RGBA，双缓冲切换时 ×2。（2026-09-07 的版本以为只是"先糊后清"变慢，
   2026-09-25 核对代码后更正。）
2. **手势中即时清晰。** Acrobat、Chrome 内置阅读器靠原生渲染器加分块（tile）渲染，
   每帧只画视口内几块。pdf.js 在 JS 主线程重放整页操作列表，做不到逐帧。

## 已定决策

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-09-07 | 不用 MuPDF | AGPL（与 MIT 分发不兼容）或付费商业授权 |
| 2026-09-23 | Web 版把同一个 `shiori-core` 编译为 WASM，阶段 4 后 pdf.js 在各端都退出 | 一套代码；Firefox、Safari、Chrome 都支持 WASM。许可：PDFium BSD-3/Apache-2.0，pdfium-render MIT/Apache，pdfium-binaries MIT，随包附许可文本 |
| 2026-09-25 | 体验最好、长期主义，不以工程量取舍 | Jesse |
| 2026-09-25 | **tile 的门槛是底图预算**：整页位图超过 8 MP（Retina letter 页约 2×）就铺 tile，不等超出 32 MP 的画布预算（原 R1） | 实测 fable 4×：整页 111 ms、252 MB，tile 67 ms、106 MB；3× 同样 65 ms、106 MB。旧做法在 3–4× 每滚进一页也要整页重画约 100 ms，期间同样显示拉伸预览，所以 tile 没有新增模糊（`docs/PERF-zoom-tiles.md`）。Jesse 把技术取舍交给「体验最好」的标准，按此定；可推翻 |
| 2026-09-25 | 技术选型按最佳实践定：R2（核心先落 CLI）、R3（CLI 保持 TS，读取经 napi-rs 插件）、R4（Android 在阶段 4 后）、R5（写入本计划内仍用 pdf-lib）采纳为决策 | Jesse：「我只知道我想做出体验最好的 App」，并以「按照最佳实践完成本计划」为目标；理由见下表，保留原文备查 |
| 2026-09-25 | `crates/shiori-core` 是独立 crate，不建根 Cargo workspace；各使用方（`src-tauri`、将来的 napi 插件）用 path 依赖把它编进自己的 `target/` | 根 workspace 会把 `src-tauri/target` 挪到仓库根，`scripts/build-signed.sh`、`release.yml` 的产物路径和缓存、AGENTS.md 里的 pkill 路径都要跟着改；独立 crate 只多编一次 pdfium-render |
| 2026-09-25 | PDFium 二进制由 `scripts/pdfium/fetch.ts` 取到 `vendor/pdfium/<平台>/`（gitignore），版本锁 7881，每个平台的 SHA-256 写死在脚本里 | 哈希取自 bblanchon/pdfium-binaries 的 `chromium/7881` release，取之前用 `gh attestation verify` 核对过构建来源；升级 PDFium 必须同时升 pdfium-render、重新核对、替换全部哈希 |
| 2026-09-25 | `shiori-core` 只把 pdfium-render 当 FFI 装载器（动态加载、C 类型、逐调用加锁的调用表、WASM 垫片）；所有 PDFium 语义按 C API 自己写。渲染用 `FPDF_RenderPageBitmap` / `FPDF_FFLDraw`，批注用 `FPDFAnnot_*`，不用它的 `PdfRenderConfig` 等高层类型 | 高层类型藏起取字宽、裁剪绘制表单、改批注标志要的句柄，`glyphs().get()` 还把 unicode 当字形序号（2.2 实测）；阶段 3、4 都要直接调这些 C 接口 |
| 2026-09-25 | 一份文档只由一个线程调用：`Document` 可 `Send`、不 `Sync`；桌面端所有文档归一个渲染线程 | pdfium-render 的 `thread_safe` 只保证单次调用不重叠，不保证一次读取的多步调用之间的次序 |
| 2026-09-25 | **读取层取整页、几何在 JS 算**：每页只取一次全部字形（`chars`，即 CLI 已在用的 `CoreGlyph[]`），缓存在 JS；选区、高亮、查找、锚点都在这份数组上计算，不做每次命中测试一次 IPC | 选区拖动每个 pointermove 都要算几何，逐次 IPC 是退化；一页一次调用与今天 pdf.js 的 `getTextContent` 相当。WASM 版返回同一种数组，JS 几何代码与引擎无关 |
| 2026-09-25 | **批注导入由 pdf-lib 直接读文件，不走 PDFium FFI，草稿不迁移 ID** | 原计划的前提是「PDFium 拿不到对象引用」，但 pdf-lib 拿得到，且 pdf.js 的 `annot.id` 就是 `Ref.toString()`（`12R`），直接字典是 `annot_p<页>_<n>`，两者都能原样复刻，`pdf-annotation-<页>-<id>` 草稿照常对上。导入器早已用 pdf-lib 扫原始字节，只是把「列出批注」也挪过来。pdf-lib 不能解密，加密文件的字符串仍需引擎读：4.7 前是 pdf.js，之后换核心 |
| 2026-09-25 | **Web Worker 的渲染队列用 TS 写**，不把 `src-tauri/src/pdf_core.rs` 的队列挪进核心 | Tauri 那份是 Rust 线程模型（渲染线程独占 Send 非 Sync 的文档、mpsc、ticket 取消），挪进核心后 wasm 单线程下只剩空转的锁；两份各约百行、语义相同，用同一组行为测试约束 |
| 2026-09-25 | **wasm 里的未嵌入字体由 PDFium 的 MEMFS 字体目录供给**，Noto SC / JP 以懒文件按需分块下载 | wasm 版 PDFium 没有系统字体，未嵌入的 CJK 会画成空白；pdfium-render 的 `FPDF_SetSystemFontInfo` wasm 实现调用后即释放结构体、函数指针也不在 PDFium 的表里，不可用；字体目录只需胶水里已有的 FS 与 `FPDF_InitLibraryWithConfig` |
| 2026-09-25 | **加密文件交给 PDFium 生成解密副本，pdf-lib 照常读**，不在 Rust 里再写一个批注读取者 | pdf-lib 只缺解密；`FPDF_REMOVE_SECURITY` 另存保留对象编号，4.4 的读取者与 ID 规则原样复用。同一能力日后可让导出支持加密源文件（今天 `ExportEncryptedSourceError` 直接拒绝），那是产品决定，另议 |
| 2026-09-25 | **删除「GPU 加速」设置项** | 它只是 pdf.js 画布的 `enableHWA` 开关（加一个设备探针兜底）；PDFium 自己画位图、再整块交给画布，开关没有作用对象，留一个无效开关比删掉更让人困惑。资源面板的 GPU 一行保留，改为显示厂商与渲染器 |
| 2026-09-25 | **Web 与移动端都用 WASM 版核心**，阶段 4 移除 pdf.js 后 Android WebView 也由它读和画；阶段 5 的 Android 原生 PDFium 只是性能优化，不是前提 | 否则阶段 4 删掉 pdf.js 会让 Android 在阶段 5 之前没有引擎 |
| 2026-09-25 | **`pdfjs-dist` 从 App 的产物移除，仍留在仓库的 `package.json`**：4.7 的「从 App 依赖移除」指 App 的 bundle，不是仓库 | CLI 从源码运行的默认读取与 `SHIORI_PDF_ENGINE=pdfjs` 退出路径用它；核心与 wasm 的对照测试、`scripts/pdfium/pdfjs-reference/`（选区测试的输入构造器、文字比对脚本）以它为 oracle。App 不导入它由 ESLint 保证，产物里 pdf.js 字样为 0（4.7d）。CLI 全面改用核心后再评估能否移出 |
| 2026-09-25 | **浏览器不收的嵌入字体按 PDFium 画出的字形重建**，不逐个格式修复（原 4.3e 计划：CFF 包 OTF、Type1 转 CFF、补 TrueType 表、按 ToUnicode 重建 cmap）| PDFium 的 FreeType 已把所有格式装好，`FPDFFont_GetGlyphPath` 按 Unicode 给出它实际画的轮廓；一条路覆盖所有格式、顺带生成 Unicode cmap，不必写字体解析器（pdf.js 为此写了数千行）。写 OpenType 用 opentype.js（MIT，按需加载）。代价：只含本页用到的字符，按页追加；合字拆开后反查不到的字符回退系统字体 |
| 2026-09-25 | **PDF 里的每个批注都显示，而且只显示一次。** Shiori 能编辑的（导入成可编辑对象的）由 Shiori 画，其余由 PDFium 画；表单控件在任何缩放、包括 tile 里都显示 | 别人不都用 Shiori，他们的批注必须完整可见；同一批注画两遍或表单在放大时消失都是缺陷 |

### 已采纳的建议（原「待确认」，理由保留）

| # | 建议 | 理由 |
|---|---|---|
| R2 | Rust 核心先落在 CLI（阶段 2），再进 App（阶段 3） | CLI 无界面，文字几何能用现成的无头比对脚本验证；验证过的核心再给 App 用 |
| R3 | CLI 保持 TypeScript，读取改调 `shiori-core` 的 napi-rs 插件；写入（pdf-lib + CJK 字体）不动 | CLI 已经这样带着 `@napi-rs/canvas`，路是通的；用户的安装方式和命令不变。整个改写成 Rust 程序收益不明显 |
| R4 | Android 在桌面完成阶段 4 之后再上 PDFium | 每个 ABI 多 6.5 MB；Tauri 在 Android 上传二进制的方式未验证；本机没有 Android SDK，只能走 CI |
| R5 | 写入（导出、CLI annotate）在本计划内继续用 pdf-lib | 导出按批注子类型剥离重写，读的是保留的原始字节，与读取引擎无关。写入是否也迁到 Rust，另立计划 |

## 路线图

| 阶段 | 用户能感受到的变化 | 引擎 | 状态 |
|---|---|---|---|
| 0 页面常驻 | 缩放松手不闪 | pdf.js | ✅ 已完成 |
| 1 视口 tile | 4× 以上第一次真正清晰；高倍缩放画布峰值从约 260 MB 降到 106 MB | pdf.js | ✅ 已完成 |
| 2 Rust 核心起步 | CLI `extract` 的文字位置与 App 一致（先在开关后面） | PDFium（CLI） | ✅ 已完成（Linux/Windows 待 CI） |
| 3 桌面画面换 PDFium | 桌面端手势中即时清晰，放大不再"先糊后清" | PDFium 画，pdf.js 读 | ✅ 已完成（3.6 Windows 实测待补） |
| 4 读取层迁移 + Web | 文字、批注、目录、查找全部走同一核心；Web 用 WASM；pdf.js 从 App 移除 | PDFium（桌面 + Web） | ✅ 已完成（4.6c Android 真机待验） |
| 5 CLI 全面接入 + Android | CLI `render` 与 App 同源；Android 同一引擎 | PDFium（全部） | 5.1 ✅；5.2 待 Android 环境 |

原 2026-09-07 版本的编号：旧阶段 2 = 新阶段 3，旧阶段 3 = 新阶段 4，旧阶段 4 拆进新阶段
2 和 5。

## 分阶段 TODO

每项独立可合并。「证明」一栏遵守仓库测试规则：在接缝处测行为，不写同义反复或
change-detector 测试；纯接线写明只由 smoke 覆盖。

### 阶段 1：视口 tile（pdf.js，引擎无关）

现有管线：`Canvas.tsx` 在手势结束时 `flushSync(setScale)` → `PageCanvas` A/B 双缓冲
→ `renderPageToCanvas` 整页绘制，封顶在 `pdfjs.ts` 里。`storePagePreview`（320 px
JPEG）和侧栏缩略图挂在同一个函数上。pdf.js 按 intent 缓存操作列表，但每次
`render()` 都在主线程重放整页，只有路径操作按 `clipBox` 裁剪，文字和图片不裁：N 块
tile = 1 次解析 + N 次完整重放。5.6.205 提供 `render({ recordOperations: true })` →
`page.recordedBBoxes` 和 `render({ operationsFilter })`，可用来跳过块外操作（bbox
类型是 `any`，用前先核实）。

接口放在 `PdfEngine` 上（文档句柄归引擎所有），经现有的 `PageCanvasRuntime` 注入，
阶段 3 的 PDFium 实现接在同一处：

```ts
renderRegion: (
  doc: PdfDocument,
  req: { sourceIndex: number; rotation: Rotation; scale: number; dpr: number;
         region: { x: number; y: number; width: number; height: number } }, // 整页在 scale·dpr 下的设备像素
  target: HTMLCanvasElement, // pdf.js 直接画；PDFium/WASM 用 putImageData，各一次像素拷贝
) => { cancel: () => void; done: Promise<void> };
```

- [x] **1.1 量基线。** `PageCanvas` 打点加 `rasterStart` 和位图宽高、dpr（tile 的
  `tileDone` / `tileCancel` 随 1.3 加）；用 fable.pdf（8 页）与 vocabulary.pdf（59 页）
  量 2×、4×、8× 的清晰耗时和画布峰值，记在 `docs/PERF-zoom-tiles.md`，探针是
  `scripts/perf/zoom-raster-probe.js`。
  结果：8× 实际位图是 4.06×（letter）/ 4.0×（A4），从不清晰；4× 起两页可见时画布峰值
  约 260 MB。
- [x] **1.2 8× 清晰度的测试。** 原写法（断言整页画布宽 `8·612·2`）与 tile 矛盾：tile
  之下不存在整页大画布，底图按 R1 仍会封顶。改为在区域渲染器上断言：letter 页 dpr 2、
  8× 的右下角 tile，画布大小等于区域，页角落在 tile 角上，每 pt 16 设备像素
  （`pageRegion.test.ts`，已随 pdf.js 渲染路径删除）。
  证明：把 tile 的倍数也送进 `clampScaleToCanvasBudget` 会变红。
- [x] **1.3 `renderRegion` + pdf.js 实现。** `PdfEngine.renderRegion`（引擎自己取页），
  pdf.js 实现是 `renderPageRegion`：整页 viewport 加平移 transform，画布即区域。
  `PageCanvas` 超出预算时底图降到 8 MP，上面由 `PageTiles` 铺 tile；预算内不变（R1）。
  R1 定案后门槛改为 8 MP 底图预算，3–4× 也走 tile。
  最近缩略图预览和空白诊断仍然读底图。纸色把底图和 tile 当作一组做 multiply，避免 tile
  盖住的地方墨色被乘两次。`Canvas.pageColumn.test.tsx` 未改仍绿。
- [x] **1.4 tile 生命周期。** 只画滚动容器内可见区 ± 一块；缩放变化取消全部在途 tile，
  已画好的留着按比例拉伸，直到新倍数的可见 tile 画完；滚动只取消离开范围的；卸载时释放
  全部位图；缩放连续变化（窗口拖动）等 160 ms 再铺。
  证明：`PageCanvas.lifecycle.test.tsx` 新增 5 个测试，各自用 mutation 验证会变红
  （去掉外圈、不丢弃滚走的 tile、缩放时保留在途 tile、卸载不释放、预算内也铺 tile）。
- [x] **1.5 定 tile 尺寸。** 取 512：1024 快约 10 ms 但峰值多 25%。8× 清晰耗时
  vocabulary 52 ms、fable 66 ms（今天 4× 整页 169 / 276 ms）；峰值 106 MB（今天约
  260 MB）。`operationsFilter` 不做（见 `docs/PERF-zoom-tiles.md`）。
- [x] **1.6 统一最大缩放。** `Canvas.tsx` 与 `src/App/nativeMenu.ts` 都读
  `src/editor/zoomLimits.ts`（0.35–8），菜单「放大」不再停在 5。8× 的清晰度由 1.2 的
  测试和 1.5 的 tile 像素检查（每 256 CSS px 一块 512 px 的 tile）保证。

### 阶段 2：Rust 核心起步（CLI 先用）

- [x] **2.1 `crates/shiori-core`。** pdfium-render `=0.9.4`（关掉默认的 image 依赖），
  PDFium 7881（pdfium-render 0.9.4 的 `pdfium_latest` 就是 7881，已从 crate 元数据核实）。
  接口：`Core::bind(dir)`（每进程一次）、`open(bytes, password)`、`page_count`、
  `page_geometry`（裁剪框 ∩ 媒体框 + /Rotate，与 pdf.js 的 `page.view` 同义）、
  `chars`（文字、基线起点、按字宽的 loose 框、字号、角度、是否 PDFium 生成）、drop 即关闭。
  密码错误的消息含 "password"，损坏的含 "damaged"，`classifyPdfOpenError` 直接可用。
  证明：`bun run test:core`（取 PDFium、fmt、clippy、5 个测试）。fixture 用 pdf-lib 生成
  （`tests/fixtures/make-fixtures.ts`），期望值按 Helvetica AFM 字宽手算；密码、裁剪框、
  旋转方向、字宽框各做了 mutation，都会变红。不在 `bun run verify` 里：还没有 App 代码
  依赖它，改 `crates/` 时按 AGENTS.md 另跑。
- [x] **2.2 napi-rs 插件 + CLI `extract` 走核心（开关后面）**（R3）。
  - [x] **字形几何与 App 一致。** `shiori-core` 改为只用 pdfium-render 的原始 FFI 表：
    它的高层类型藏起了取字宽需要的句柄，且 `glyphs().get()` 把 unicode 当字形序号挡掉。
    终点 = 起点 + 字符矩阵 ×（`FPDFFont_GetGlyphWidth` × 字号）；PDFium 的 loose 框
    恒包含字宽框，落在框外即查错（两个编码映射到同一 unicode 时会发生），改用紧随其后、
    同一基线的字形起点，再不行用 loose 框远边。`/ActualText` 连字被 PDFium 拆成同起点
    的几个字，合回一个字形；行末连字符（U+0002 + `IsHyphen`）还原为 "-"；角度按基线
    逆时针（PDFium 的 `GetCharAngle` 是顺时针）。
    结果：`bun scripts/pdfium/compare-glyphs.ts` 对 fable、vocabulary 的 pdf.js 基准，
    38,899 个字形全部配对，起点与终点最大偏差 0.0006 pt（门槛 0.01）。
    证明：`bun run test:core` 10 个测试（加了连字、旋转、墨迹超出字宽、行末连字符、
    ToUnicode 歧义五种 fixture），每条规则的 mutation 都会变红。
  - [x] **napi-rs 插件与 CLI `extract` 的开关。** `crates/shiori-core-node`（napi 3，
    cdylib）；`cli/src/coreEngine.ts` 用 `process.dlopen` 加载，打包后从可执行文件旁的
    `native/` 取插件和 PDFium，源码里从 `crates/…/target/release` 与 `vendor/pdfium` 取，
    `SHIORI_CORE_DIR` 可覆盖。`SHIORI_PDF_ENGINE=pdfium` 时 `extract` 的页框和引文走核心，
    批注导入仍走 pdf.js（4.4）。
    **引文改为按字取**（原验收写的是「与 pdf.js 输出一致」，改为「除引文外一致，引文是
    高亮下的原文」）：pdf.js 路径只能返回整段文字项。实测：welcome.pdf 上只盖住
    "Local-First" 的高亮，pdf.js 给 "A Local-First PDF Reader and Editor"，核心给
    "Local-First"；中英混排样本 pdf.js 连带整行中文释义一起给出，核心
    只给 "prudent"；fable 样本 pdf.js 把连字断成 "fi nd"，核心给 "find"。其余字段两条路径
    完全相同。
    证明：`cli/test/coreQuote.test.ts`（纯函数，在 `bun run verify` 里：按字取、生成的
    断行变空格、跨行断字合并、页框原点偏移）；`crates/shiori-core-node/test/extract.test.ts`
    （在 `bun run test:core` 里，真插件端到端对比两条路径）。
- [x] **2.3 CLI 发布闸门。** `cli/build.ts` 在各平台自己的 runner 上编译插件、取锁定的
  PDFium，放进 `native/`（macOS 上与可执行文件同一签名身份签名；硬化运行时只加载同团队
  签名的库），manifest 记 PDFium 版本和归档哈希。许可：`cli/licenses/pdfium/`（16 个文件，
  各平台内容相同，只差换行和注释符）与 `rust-crates-NOTICES.txt`（`scripts/pdfium/rust-notices.ts`
  按五个发布平台的 `cargo tree` 并集生成，去掉编译期 proc macro；构建时比对，过期即失败；
  `napi`/`napi-sys` 包里没有许可文件，用审阅过的上游 LICENSE）；许可清单 32 → 49 个文件，
  目录哈希、`SBOM.md`、`THIRD_PARTY_NOTICES.md`（含 FreeType 署名）同步更新。
  CI：`cli-verify` / `cli-release` 装 Rust 并缓存插件依赖；`cli-verify` 的路径过滤加上
  `crates/**`、`scripts/pdfium/**`；发布时逐个校验 `native/` 的 Developer ID 签名，公证包
  含 `native/`。`SUPPORTED_CLI_TARGETS` 不变（仍无 darwin-x64），构建测试要求每个发布平台
  都有锁定哈希的 PDFium。
  验证：本机用审计版本（Bun 1.3.12、Node 26.5.0）完整跑 `cli:build` 与 `cli:smoke`，smoke
  在仓库外的隔离副本里以 `SHIORI_PDF_ENGINE=pdfium` 走通 extract；解压体积约 146 → 155 MB。
  **未验证**：Linux、Windows 的插件编译与 smoke 只能在 CI 原生 runner 上跑，等推送后
  `cli-verify` 的结果。

### 阶段 3：桌面 App 画面换 PDFium

- [x] **3.1 渲染命令。** `src-tauri/src/pdf_core.rs`：一个渲染线程拥有全部文档，消息
  队列按优先级（屏上 tile 0 > 整页底图 1 > 缩略图 2，同级先来先画）出队，按票号取消未开始
  的渲染；PDFium 在第一次打开时才绑定，找不到时 App 照常启动、所有页面退回 pdf.js。命令：
  `pdf_core_open`（原始请求体，密码走 base64 头）、`pdf_core_render`（`ipc::Response`
  回 RGBA）、`pdf_core_cancel` / `pdf_core_close` / `pdf_core_hide_annotations`（生成的
  类型绑定）；都只授予 `main` webview，移动端是 unsupported 桩。
  前端：`src/platform/pdfCore.ts`；`pdfiumDesktopEngine`（4.6b 起为 `pdfiumEngine.ts` 的 `createPdfiumEngine`；pdf.js 读取、PDFium 出像素，
  打不开或画失败的区域退回 pdf.js）；`appPdfEngine` 在桌面选它。`PageCanvas` 的整页底图、
  `PageTiles`、侧栏缩略图都经 `renderRegion`（`renderPageBackdrop`），同一引擎出像素。
  最近列表的缩略图（`thumbnail`）和导出的栅格化仍用 pdf.js。
  没有按「Rust 持有字节、JS 拿副本」做：拖入、缓存、合并出的文档没有路径，统一由前端把
  同一份字节传一次（macOS 上 64 MB 约 26 ms）。
  证明：`pdf_core.rs` 的队列次序测试；`pdfiumDesktopEngine.test.ts`（现 `pdfiumEngine.test.ts`）6 个测试（mutation：
  取消后仍上屏、失败不回退、打不开仍用 PDFium 各自变红）；tauri dev 实测见
  `docs/PERF-pdfium-desktop.md`（打开 fable.pdf 后底图与 tile 全由 PDFium 画出，无回退）。
- [x] **3.2 打包。** `scripts/pdfium/stage-app.ts` 由 `beforeBuildCommand` 按 Tauri 给的
  `TAURI_ENV_TARGET_TRIPLE` 把 PDFium 放进 `src-tauri/pdfium/`（gitignore），universal 版用
  lipo 合并两个架构，移动端跳过。macOS 走 `bundle.macOS.frameworks`（Tauri 用发布身份签名），
  Windows/Linux 走平台配置文件里的 `bundle.resources`，许可文本随包放在
  `licenses/pdfium/`；`THIRD_PARTY_NOTICES.md` 加 PDFium 一节和 FreeType 署名。
  验收：本地 release 包 dmg 23.39 → 26.79 MB（+3.4 MB，门槛 8 MB），App 解压 +7.7 MB；
  dylib 是 Developer ID 签名、整包 `codesign --verify --deep --strict` 通过；用
  `open -a` 打开 PDF 后进程映射了 `Contents/Frameworks/libpdfium.dylib`。universal 与
  Windows 暂存在本机试过；**Windows/Linux 安装包要等 CI 构建和 RELEASE-CHECKS A0.12**。
- [x] **3.3 批注按已定决策显示。** PDFium 画全部批注外观；导入器压掉的批注经新的
  `onSuppress` 回调报出子类型和 /Rect，桌面引擎按页交给 `hide_annotations`，在内存副本上设
  HIDDEN。按子类型 + /Rect 匹配，因为 PDFium 不给对象号（pdf.js 的 id 就是对象号）。
  证明：`tests/render.rs` 隐藏方框后圆仍在、方框消失；引擎测试检查按页分组交出。
  **未做**：App 里带外部批注样本的并排肉眼对比。
- [x] **3.4 表单在 tile 里显示。** 每个文档一个表单环境，`FPDF_FFLDraw` 与页面渲染同一
  组起点和整页尺寸，tile 里的控件与整页一致；有了表单环境后控件只经 `FFLDraw` 画一次。
  证明：`tests/render.rs` 1× 整页与 8× tile 里都有文本框的字；去掉 `FFLDraw` 两个测试变红。
- [x] **3.5 文字层对齐。** 同一区域两个引擎的墨迹包围盒差 ≤ 1 设备像素（8× 下 ≤ 0.06 pt），
  正文重心差 0.11 px；插图区重心差 1.45 px 来自图像平滑。文字层叠在 PDFium 像素上无可见错位，
  上主画布。非嵌入的标准 14 字体另测（`scripts/pdfium/compare-ink.ts`）：重心差中位数
  0.11 pt，离群值来自两边替代字体的字形形状，排版位置相同。
- [ ] **3.6 实测。** macOS 已测（`docs/PERF-pdfium-desktop.md`）：IPC 每次约 2 ms + 0.4 ms/MB；
  30 块 8× tile 逐块 69 ms（pdf.js 481 ms），并发 34 ms（pdf.js 70 ms）。**Windows 未测**：
  WebView2 的 IPC 开销要在 Windows 机器或 CI 上补，这项在补齐前不勾。

### 阶段 4：读取层迁移 + Web（pdf.js 退出 App）

- [x] **4.1 静态闸门。** `eslint.config.js` 的 `no-restricted-imports`：`src/pdf/engine/`、
  `src/pdf/render/` 以外不得导入 `pdfjs-dist` 或 `render/pdfjs`（类型导入也算）。按「每项独立
  可合并」做成**增量式**：还在直接读 pdf.js 的 13 个文件列在 `PDFJS_READERS_TO_MIGRATE`，每个
  标了由哪一项迁走，只减不增。只为类型导入 `PDFDocumentProxy` 的 11 个文件已改用
  `PdfDocument`。`PdfDocument` 变成不透明类型挪到 4.7：名单清空之前它必须仍是 pdf.js 的代理。
  证明：在名单外的文件里导入 `render/pdfjs`，lint 报错。
- [x] **4.2 目录与链接。** 引擎接口加 `outline` / `pageLinks`，目标统一为
  `PdfDestination { pageIndex, view, args }`（PDF 目标数组去掉页引用和视图名后的操作数，null
  保留）。pdf.js 实现是原来散在组件里的逻辑（`pdfjsNavigation.ts`）；PDFium 实现在
  `shiori-core`（`FPDFBookmark_*`、`FPDFDest_GetView` + `GetLocationInPage` 区分 XYZ 的 null、
  `FPDFLink_Enumerate`、GoTo/URI 动作，URI 兼容带 BOM 的 UTF-16），经渲染线程的通用读取
  消息给 `pdf_core_outline` / `pdf_core_links`。`OutlinePanel` 走引擎；`PdfLinkLayer` 不再用
  pdf.js 的 `AnnotationLayer`，自己按 /Rect 放 `<section><a>`（沿用原有 CSS），JavaScript
  动作在两条路径上都拿不到，`annotationLayerPolicy` 随之删除。
  另修：`FPDF_GetLastError` 是进程级的，`Core::open` 把加载和读错误码放进同一把锁（并行测试里
  乱码被报成「需要密码」，去锁 15 次复现 1 次，加锁 0 次）。
  证明：`tests/core.rs` 目录（嵌套、XYZ 的 null、中文标题、GoTo 动作）与链接（URL、UTF-16 URL、
  FitR）；`PdfLinkLayer.test.tsx` 4 个（位置、页框原点、旋转、点击导航，三处 mutation 变红）；
  引擎测试补目录与链接的 PDFium / 回退两条路。
  - [x] **命名动作。** PDFium 没有读 `/Named` 动作的接口；导入器本来就用 pdf-lib 扫原始批注，
    顺带把 `/A /S /Named` 的链接（`/N` 为 FirstPage / LastPage / NextPage / PrevPage）经
    `onNamedLinks` 报出，桌面引擎合并进 PDFium 的链接，与引擎无关。NextPage/PrevPage 是新支持的
    （原来 pdf.js 路径也只认首页、末页）。证明：导入器、引擎、链接层各一个测试，各自 mutation 变红。
- [ ] **4.3 文字。** 在 PDFium 逐字框上重写 `TextLayer`，选区对齐按 PDFium 字形度量重做
  （本阶段最大的工作）。分三步：
  - [x] **4.3a 文字类型与 pdf.js 解耦。** `src/pdf/engine/text.ts`：`PdfPageTextContent`
    （结构与 pdf.js 的 TextContent 一致，pdf.js 的值直接可赋）、`PdfTextGlyph`。选区、语义复制、
    锚点、字形映射、Live 桥改用它；`getBoundedTextContent` 的参数改成结构类型；读操作列表的
    `textGlyphsFromOperators` 移到 `src/pdf/render/pdfjsGlyphs.ts`；画布释放函数移到
    `render/canvasMemory.ts`；渲染诊断改记当前引擎（`PdfEngine.label`）而不是 pdf.js 版本。
    白名单 13 → 3（`TextHighlightLayer`、`FindPanel`、`compactRasterPdf`）。行为不变。
  - [x] **4.3b 自己的文字层，`pageText` 进引擎。** `src/pdf/render/textLayer.ts`
    （`ShioriTextLayer`，移植 pdf.js `TextLayer`，Apache-2.0 署名写进 `THIRD_PARTY_NOTICES.md`）；
    `PdfEngine.pageText` 返回页面文字、字形和字体真名，pdf.js 实现是原路径（`pdfjsText.ts`）；
    `TextHighlightLayer` 不再直接碰 pdf.js（出白名单）。与 pdf.js 的差别只有旋转：旋转算进每个
    span，旧层在旋转页上与字形框 IoU 为 0（既有 bug，顺带修了）。
    证明：浏览器里同一内容交给两个实现，0° 下 3 页 × 2 倍数 DOM 逐字节相同；0/90/180° 下新层
    span 与字形框 IoU 0.95–0.96，旧层 90/180° 为 0。`textLayer.test.ts` 5 个测试（旋转、空文字项
    计数、换行、marked content、缩放重测），4 处 mutation 各自变红。测量画布补了隐藏样式
    （`.hiddenCanvasElement`，pdf.js 一直往 body 挂一个没隐藏的 300×150 画布）。
  - [x] **4.3c 桌面页面文字走 PDFium。** 核心给每个字形补字体名、描述符标志（去掉 PDFium 私有位
    0x80000）、按字号换算的上下沿，文档读 `/Lang`（`FPDFCatalog_GetLanguage`）；
    `pdf_core_page_text` 一次取整页字形（上限 200 万字，与语义文字上限一致）。
    `src/pdf/engine/pdfiumText.ts` 按字体、字号、基线和位置连续性把字形并成 item（缺口阈值沿用
    pdf.js 的 0.6 em / −0.2 em），PDFium 推断的空格和换行变成行内空格、跨缺口的空格项和
    `hasEOL`。不按文字对象切：PDFium 每个 Tj 一个对象，逐字定位的文本会碎成单字 span。
    PDFium 按行排序时会把斜排水印插进单词中间；被打断的 run 在插入物不在同一基线时可以续上。
    页面文字新增 `faceFamilies`（引擎真正装进 `document.fonts` 的字体面），`FontFaceSet.check()`
    对不存在的字体族也返回 true（Chrome 实测），不能拿它判断。
    证明：`scripts/pdfium/compare-page-text.ts` 在高亮样本上对比 pdf.js：fable 168/168 段映射、
    复制文本 8/8 页相同；vocabulary 1182/1182 段映射、54/59 页相同，其余 5 页里 2 页是 pdf.js 丢字
    （「2026」读成「202」）、3 页是水印前多一个空格。`tauri dev` 探针：桌面文字层来自 PDFium，
    整页 695 字 11–13 ms，span 数等于 item 数。`pdfiumText.test.ts` 9 个测试（10 处 mutation
    各自变红），`tests/core.rs` 字体度量与语言，引擎测试补 PDFium / 回退两条路。
    已知缺口：竖排（PDFium 不报书写方向，按旋转的横排处理）；marked content（PDFium 已把
    /ActualText 代入字形）；RTL 未验证。
  - [x] **4.3d 嵌入字体注册（浏览器能直接用的部分）。** 核心 `embedded_fonts(page)`：遍历页面对象
    （递归进表单 XObject，深度上限 32），按字体去重，只取 PDFium 确实用上了的嵌入字体
    （`FPDFFont_GetIsEmbedded`；FreeType 加载失败而改用替代字体的不算，那时拿到的数据是替代
    字体的），按文件头判格式（TrueType / OpenType / CFF / Type1）。`encode_embedded_fonts` 打成
    一个容器（长度前缀 JSON 头 + 各字体程序），桌面经原始字节命令 `pdf_core_page_fonts`、Worker
    经 `fonts` 传；引擎 `fontContainer.ts` 解开，`fontFaces.ts` 把 TrueType/OpenType 注册为
    `FontFace`（按内容哈希每个程序只注册一次，浏览器拒绝的静默跳过），`pageText` 在非
    `textOnly` 时为本页尚未解析过的字体名取一次，按字体名映射样式键 → 字体族。
    证明：`tests/core.rs`（fixture：TrueType 列出、未嵌入与 FreeType 装不上的不列；去掉嵌入判断
    变红）；wasm 测试（核心打包、引擎解包得到完整的 TrueType 程序）；引擎测试（样式映射到注册的
    字体族、同一字体跨页只取一次、`textOnly` 不取；两处 mutation 变红）；浏览器里打开的真实文档
    （field-guide）把「STSongti-SC-Regular / Bold」注册进编辑器字体表。
    **当时未覆盖**：pdf-lib 这类工具生成的 TrueType 子集缺浏览器字体校验要求的表，`FontFace`
    拒绝（fixture 即如此），与裸 CFF、Type1 一样退回按名字匹配——由 4.3e 补上。
  - [x] **4.3e 嵌入字体重建。** 浏览器不收的嵌入字体（裸 CFF、Type1、删减过的 TrueType 子集，
    Chrome 与 WebKit 拒收的范围还不同）不再按格式逐个修，而是**按 PDFium 画出的字形重建**（见
    已定决策）：核心 `font_outlines(page, names)` 遍历本页文字，对每个指名字体的每个字符用
    `FPDFFont_GetGlyphPath` / `FPDFFont_GetGlyphWidth`（按 Unicode 查，经 FreeType 已加载的程序）
    取轮廓（1/1000 em，y 向上）和 /Widths 步进；桌面经原始字节命令 `pdf_core_font_outlines`、
    Worker 经 `fontOutlines` 传 JSON。引擎先试原程序，`FontFace` 拒收的记为重建字体，每读一页只为
    **本页新出现**的字符取轮廓，`fontOutlines.ts` 用 opentype.js（按需加载的独立块，gzip 67 KB）
    写成 CFF 版 OpenType，以只含这些字符的 `unicode-range` 加进同一字体族，其余字符照旧按字体栈
    逐字回退；关闭文档时这些面随之移除。cmap 由 Unicode 直接生成，所以没有 ToUnicode 的 TeX
    字体也映射得上。
    证明：fixture 新增以裸 CFF（`/FontFile3 /Type1C`、WinAnsi、无 ToUnicode）嵌入的 Foxit Serif；
    `tests/core.rs` 两个测试（字符顺序与去重、/Widths 步进、T / o / p 的轮廓形状与朝向、文字层字体名
    与重建名一致、只返回指名的嵌入字体）；wasm 测试把重建字体交给 Skia 排同一段文字，与 PDFium
    渲染逐像素比，裸 CFF 与 TrueType 子集差异 15% 以内（只在笔画边缘），度量兼容的 Times 超过 100%，
    步进、字符映射、y 轴三处变异各自变红；引擎测试（本页字符才取、已取的不再取、新字符只加新面、
    关闭时移除；三处变异变红）。浏览器实测：Chrome 与桌面 WKWebView 都以 `loaded` 接受重建字体，
    与 PDFium 渲染差异 11–17%（Chrome）/ 26%（WebKit），Times 对照 125–135%；WebKit 直接接受了
    Chrome 拒收的 Liberation 子集，印证「先试原程序」的顺序。
    **未覆盖**：没有真 Type1 程序做 fixture（本机无 TeX；pdf.js 的 `.pfb` 其实是裸 CFF），Type1 与
    CFF 走同一条 FreeType → 轮廓路径；合字（ﬁ）由 PDFium 拆成字母，拆开的字母按各自 Unicode
    反查字形，查不到的回退系统字体。
- [x] **4.4 批注导入。** `src/pdf/import/sourceAnnotations.ts` 用 pdf-lib 直接从文件列出每页
  批注，产出与 pdf.js `getAnnotations({ intent: "display" })` 同形的记录，1473 行转换逻辑
  原样复用。逐项照 pdf.js 5.6 源码复刻导入器读到的字段：显示过滤（NoView；已知子类型忽略
  INVISIBLE；四边形不可用的文字标记不显示）、顺序（Popup 殿后）、ID（`12R`、直接字典
  `annot_p<页>_<n>`）、颜色（灰 / RGB / CMYK 多项式，经 Uint8ClampedArray 取整）、边框宽度
  （/BS、/Border、虚线与超宽回退）、四边形与墨迹（Float32）、无外观 Square 的 float32 rect、
  Text 图标尺寸、Group 回复取父批注的作者 / 正文 / 日期 / 颜色、字符串解码（BOM 与
  PDFDocEncoding、语言转义）、FreeText 的 /DA（可继承，退到 AcroForm）与外观流里实际的字号
  和颜色、/RC 根样式。**ID 与 pdf.js 一致，草稿不需要迁移**（见已定决策）。加密文件仍由
  pdf.js 列出。
  另修两处：抑制上报改用文件的 `/Rect`——pdf.js 对无外观的标记、便签、墨迹会把 rect 换成
  它自绘外观的外框，桌面端 PDFium 按 `/Rect`（容差 0.01 pt）隐藏，于是这类批注被画两遍；
  导出端「这条是否被导入过」改用同一个判断（`isListedForImport`），原来的镜像把 INVISIBLE
  的 Square 等当成未导入，导出后原批注和 overlay 各一份。
  证明：`sourceAnnotations.test.ts` 以真 pdf.js 为 oracle，同一份字节两条路导入，overlay、
  被接管的 ID、上报的 rect 全等（文字标记 / 便签与回复 / 形状与墨迹 / FreeText 四组，
  另一个测加密文件回退）；13 处 mutation 里 11 处变红，存活的 2 处（四边形规整、便签图标
  尺寸）对导入结果不可见。`scripts/import/compare-annotation-readers.ts` 跑 `test-artifacts`
  全部 13 个文件逐页一致，文件读取者多数更快（fable-annotations 8 ms → 1 ms）。
  导出测试「INVISIBLE 不动」改为「INVISIBLE 的 Square 被替换」，回退旧规则即变红。
  未覆盖：第三方工具（Acrobat、Preview、Foxit）写出的真实批注样本本机没有，只有合成用例。
- [x] **4.5 查找与 Live 桥。** `FindPanel` 与 Live 桥的页面文字改走 `appPdfEngine.pageText`，
  桌面上随之由 PDFium 读（4.3c 已验证复制文本与 pdf.js 一致或更准）。`pageText` 加
  `textOnly`：只要文字的整文档扫描不取字形，pdf.js 实现跳过 operator list 并在读完后释放页面
  （原来 `FindPanel` 自己做的 `cleanup`）。`FindPanel` 出白名单，pdf.js 直接导入只剩
  `compactRasterPdf`。证明：查找与 Live 的既有 104 个测试照过；关掉 `textOnly` 分支其中 8 个
  变红（假文档没有 operator list）。
- [ ] **4.6 Web：WASM 在 Worker 里。** pdfium.wasm 约 5.3 MB / gzip 2.4 MB，单线程；
  替换今天约 2.7 MB JS + 3.3 MB 资源。
  - [x] **4.6a 核心编到 wasm 并与原生逐项对齐。** `crates/shiori-core-wasm`（wasm-bindgen，
    结果以桌面 IPC 同形的 JSON 返回，像素为 RGBA 字节，389 KB）；核心只有两处
    `cfg(target_arch = "wasm32")`：绑定走 pdfium-render 的 wasm 桥、位图经一次拷贝取出
    （在 PDFium 自己的线性内存里）；wasm 下不开 `thread_safe`。
    `scripts/pdfium/build-wasm.ts` 生成 `src/pdf/engine/wasm/generated/`（gitignore）：
    钉死版本的 wasm-bindgen CLI 装进 `vendor/tools/`；PDFium 的经典脚本胶水包成 ES 模块函数
    （不需要 eval，CSP 不加 `unsafe-eval`），并把闭包里的 `wasmExports`、`FS` 挂到 Module 上。
    `bun run build` 先跑它；发布 CI 三个任务加 wasm32 target 与 wasm-bindgen 缓存。
    `src/pdf/engine/wasm/loadCore.ts`（Worker 与测试共用）：pdfium-render 初始化时找
    `PDFium_Init`，本构建没有，由加载器代之以 `FPDF_InitLibraryWithConfig`（字体目录见下）。
    实测：**堆可增长到 2 GB**（`getHeapMax`），原计划的未验证项关闭；fable 页面文字
    10–20 ms/页（原生 11–13 ms），1224×1584 整页渲染 58 ms。
    **未嵌入字体**：wasm 版 PDFium 没有系统字体，未嵌入的 CJK 文字整页空白（0 个深色像素，
    原生 1866）。字体放进 PDFium 的 MEMFS 作为用户字体目录后正常（1671）。
    证明：`crates/shiori-core-wasm/test/core.test.ts`（进 `test:core`）——fixture 9 页字形与
    原生核心逐字一致；嵌入字体页面在 1× 与 2.5× 下与原生逐字节相同；未嵌入的中文经字体目录
    画出（去掉字体目录配置即变红）。样本上 fable、vocabulary 67 页 44,641 个字形与原生一致
    （坐标差 ≤ 0.00004 pt）。已知缺口：pdfium-render wasm 层每次打开文档泄漏约 100 B 的
    表单环境结构（其源码注释自认）。
  - [x] **4.6b Worker 引擎。** `src/pdf/engine/wasm/coreWorker.ts`（模块 Worker）加载核心；
    打开、关闭、读取、隐藏批注一到即做，渲染进 TS 队列（`renderQueue.ts`，规则同桌面渲染线程：
    优先级、到达顺序、取消的 ticket 轮到时跳过、队列清空时清掉残留取消），每画一块让出一次
    事件循环。`coreClient.ts` 实现与 Tauri 相同的 `PdfCoreBridge`，引擎工厂泛化为
    `createPdfiumEngine(bridge, pdfjs, label)`，桌面与 Web 共用同一套回退逻辑。`appEngine`：
    桌面原生核心，Web 与移动端 wasm，都不行时 pdf.js。Vite define `__SHIORI_WASM_CORE__`，
    桌面构建经插件整体替换 `pdfiumWebEngine.ts`——Vite 一见 `new Worker(new URL(...))` 就产出
    Worker，tree-shaking 来不及去掉——桌面包因此不带 5.6 MB wasm（已核对产物）。
    CJK 替代字体以懒文件进字体目录：嵌入字体的文档一个字节都不拉（实测 fable 零请求），只有
    需要替代字体的文档才取。分块依赖主机回 `Accept-Ranges: bytes`，否则 Emscripten 退为整份
    下载（Vite dev server 能响应 Range 但 HEAD 不带这个头）。CSP 早已有
    `'wasm-unsafe-eval'` 与 `worker-src 'self'`，无需改动。许可：Web 构建输出
    `licenses/pdfium/*` 与 `licenses/rust-crates-NOTICES.txt`（由 build-wasm 生成）。
    证明：`renderQueue.test.ts` 3 个、`coreClient.test.ts` 4 个（路由、字节不被转移走、取消、
    Worker 崩溃后挂起与后续请求都失败——后两处 mutation 变红）；浏览器实测：Web 版引擎
    `PDFium 7881 wasm`，fable 页面由 wasm 画出、0 次回退，页面文字 27 ms；未嵌入的中文画出
    1741 个深色像素；30 块 512×512 的 4× tile 共 1229 ms（41 ms/块）。Worker 在两块之间经
    `MessageChannel` 让出（嵌套 `setTimeout(0)` 会被钳到 4 ms）。
  - [ ] **4.6c 移动端。** Android WebView 上跑通同一引擎并实测内存与首屏。**需要 Android 设备
    或模拟器，本机没有**（2026-09-25 查：无 SDK、无 AVD、`adb devices` 为空）。引擎逻辑与 Chrome
    同一套 V8 wasm，4.6b 已验证；真机上要验的是：(1) Worker 与 wasm 在 WebView 中加载、页面由
    wasm 画出（诊断标签 `PDFium 7881 wasm`）；(2) 低端机内存：一份 50 页以上的扫描件翻页与
    8× 缩放时 wasm 堆不触发 OOM；(3) Tauri Android 的资源协议是否回 `Accept-Ranges: bytes`，
    这决定未嵌入 CJK 的字体是分块取还是整份（约 13 MB，读自本地 APK）；(4) 冷启动到首页出图的
    时间与 pdf.js 版对比。对应 RELEASE-CHECKS A0.13。
- [x] **4.7 完成标志。** `pdfjs-dist` 从 App 依赖移除；用 `scripts/perf/inspect-entry.ts`
  记入口体积前后对比；现有高亮回归和 `test-artifacts` 全绿。拆成：
  - [x] **4.7a 加密文件的批注经 PDFium 解密副本读取。** 核心 `decrypted_copy`
    （`FPDF_SaveAsCopy`，`FPDF_NO_INCREMENTAL | FPDF_REMOVE_SECURITY`），字符串与流改为明文、
    对象编号不变，所以批注 ID 仍是文件的对象引用；桌面经原始字节命令
    `pdf_core_decrypted_copy`，napi 插件同名方法；wasm 下 pdfium-render 只认它私有的写入结构，
    由加载器直接调 PDFium 模块的 `_FPDF_SaveAsCopy`，写回调经 `addFunction` 注册。
    导入器新增 `decryptedBytes`：源文件加密时 raw pass 与文件读取者都改读副本，`encrypted`
    照实上报原文件。PDFium 引擎把核心的副本交给导入器，pdf.js 不再参与加密文件的导入。
    证明：`tests/core.rs`（owner 密码 AES-128 的 fixture：副本无 `/Encrypt`、UTF-16 正文与作者
    为明文、`4 0 obj` 未变；去掉 REMOVE_SECURITY 即变红）；`importEncrypted.test.ts`（导入时
    不给可读的 pdf.js，只靠解密副本读出便签与高亮，结果与真 pdf.js 逐项相同；去掉副本即变红）；
    wasm 副本与原生除每次保存新生成的 `/ID` 外逐字节相同；浏览器 Worker 实测同上；引擎测试
    一个（去掉接线变红）。
  - [x] **4.7b 导出光栅化走引擎。** `compactRasterPdf` 整页用 `renderRegion` 画（优先级
    backdrop），引擎作参数便于测试。原样导出（mode none）不画源批注是既定决定（有测试守着），
    为此渲染请求新增 `annotations`：核心关掉 `FPDF_ANNOT` 并跳过表单绘制，Tauri、wasm、napi、
    pdf.js 引擎（DISABLE 模式）一路贯通，默认开。pdf.js 的迁移名单清空并删除：引擎层与渲染层之外
    已无直接读 pdf.js 的文件。证明：`tests/render.rs` 关掉批注后第 7 页无方块、圆与表单文字
    （表单开关、批注标志两处 mutation 各自变红）；生命周期测试改用假引擎（5 个：释放画布、
    渲染失败原样上报、JPEG 失败、空白页不画、整页区域与 annotations 随模式）；浏览器里经 wasm
    引擎导出 2 页 193 KB、316 ms。
  - [x] **4.7c `PdfDocument` 不透明。** `PdfDocument` 成了只能交还引擎的品牌类型。PDFium 引擎
    打开时只走核心：核心打开并取回整份页面几何（新命令 `pdf_core_page_geometry`、Worker 的
    `geometry`）后返回自己的句柄，pdf.js 不再解析；页数、几何、缩略图（第一页，2 倍 CSS 宽，
    同 pdf.js）都由核心给。核心打不开（非密码）时整份交给 pdf.js；密码错误包成 `Error` 如实上报，
    不再试 pdf.js。已由核心打开的文档若某项操作失败，第一次需要时才让 pdf.js 从保留的字节
    打开并作答（4.7d 删 pdf.js 时一并去掉）。导入器拆出 `importFileAnnotations`（只读文件，
    加密时读解密副本，无 pdf.js），pdf.js 路径的 `importPdfAnnotations` 参数改为它实际读的
    结构类型；CLI 用核心时同样传入解密副本。`Canvas`、`OutlinePanel` 的 `numPages` 改走
    `pageCount`。pdf.js 形状的测试 fake 仍经 pdf.js 引擎有效，改写留给 4.7d。
    证明：引擎测试重写为 15 个（核心打开时 pdf.js 零次加载、密码错误不试 pdf.js、打不开交给
    pdf.js、单项失败懒加载且只加载一次、导入读真实文件字节并按页隐藏含命名链接、加密走解密副本、
    缩略图比例；四处 mutation 各自变红）；浏览器里恢复的标签页以核心句柄打开，pdf.js Worker
    零加载，文字层与批注照常。
  - [x] **4.7d 移除 pdf.js。** 删 pdf.js 引擎、导航、渲染模块、画布批注抑制、加载任务、HWA 探针
    与 Vite 的 pdf.js 静态资源（cmaps、标准字体、wasm、ICC）；PDFium 引擎不再有任何回退。
    打不开的文件如实报错：核心的「damaged PDF」归为 damaged，「PDF password」为 password，
    PDFium 缺失或 wasm Worker 起不来归入新增的 `engineUnavailable`（三种语言文案）；单页画不出
    或读不出只让那个请求失败（tile 本就处理拒绝）。`appEngine` 持有当前引擎：桌面原生、Web 与
    移动端 wasm，都不可用时是一个只会报 `engineUnavailable` 的实现；`setAppPdfEngineForTest` +
    `src/test/fakePdfEngine.ts` 让组件测试直接给出引擎的回答，替代原来 pdf.js 形状的假文档
    （`mock.module` 会在测试文件间泄漏，不用）。`pdfjs-dist` 仍在仓库：CLI 用它（源码运行的默认、
    `SHIORI_PDF_ENGINE=pdfjs` 退出），部分测试用真 pdf.js 做 oracle；pdf.js 的文字读取参照挪到
    `scripts/pdfium/pdfjs-reference/`（验证脚本与选区测试的输入构造器用）。
    体积（`scripts/perf/inspect-entry.ts`，只算入口静态 JS）：2,374,224 → 1,900,823 字节
    （gzip 791,041 → 646,821），少 20%。产物里 pdf.js 字样为 0。**完整下载量**如实记：去掉 pdf.js
    Worker 1.3 MB 与按需取的静态资源约 3.35 MB；加上 PDFium 引擎 5.73 MB（gzip 2.52 MB：
    pdfium.wasm 5.23 MB / 2.38 MB、核心 wasm 389 KB / 106 KB、Worker 111 KB / 30 KB），它在打开
    第一个 PDF 时就要下载。计划原文「替换约 2.7 MB JS + 3.3 MB 资源」：资源一侧属实，JS 一侧
    入口只少了 0.47 MB（pdf.js 主体原本在懒加载块里）。Web 首开 PDF 的下载因此变大，桌面包
    不受影响（不带 wasm）。
    **风险**：Android 从此只有 wasm 引擎，4.6c 未在真机验证；发布前必须过 RELEASE-CHECKS A0.13。
    证明：verify 1760 通过（少的 20 个是随 pdf.js 模块删掉的测试与合并的回退用例）；引擎测试 13 个
    （打开失败按类上报、区域失败计数、文字失败上报等）；组件测试改用假引擎（查找、文字层、链接层、
    目录、Canvas、Live 桥），导入归属测试改为断言交给 PDFium 的隐藏清单；浏览器里以 wasm 引擎
    打开、选字、目录照常。

### 阶段 5：CLI 全面接入 + Android

- [x] **5.1 CLI `render` 走核心**，与 App 同源像素。`renderCorePageToPng`：页框与 /Rotate 取自
  核心，缩放上限与页面尺寸限制与 pdf.js 路径相同，PNG 由 `cli/src/png.ts` 用 Node 自带 zlib
  编码（Up 滤波），不依赖 canvas。**打包的 CLI 默认用核心**（`native/` 在可执行文件旁，或
  `SHIORI_CORE_DIR`）读与画，`SHIORI_PDF_ENGINE=pdfjs` 退出；从源码运行默认仍是 pdf.js，
  测试结果不随本机是否编过插件而变。证明：`crates/shiori-core-node/test/render.test.ts`
  经 CLI 渲染 fixture 第 2 页（裁剪 + 旋转 90°），核心与 pdf.js 尺寸相同、角标同在左上、
  差异像素 < 100（去掉旋转或 PNG 滤波各自变红）；Bun 1.3.12 重新打包后 `cli:smoke`
  以核心默认跑通 extract 与 render（1224×1584），并覆盖 pdf.js 退出路径。
- [ ] **5.2 Android 原生 PDFium（性能优化，不阻塞发布）。** 按决策表，Android 已由 wasm 引擎
  覆盖；本项只为速度，需要 Android 环境，留作后续。pdfium-binaries 有 arm64/arm/x64/x86 构建（arm64 6.5 MB）；
  放进 `jniLibs/<abi>/`，`bind_to_library(path)`。Tauri 在 Android 上始终走
  postMessage，读不了原始请求体，原始响应的编码未验证：tile 可能要走自定义协议
  （`register_asynchronous_uri_scheme_protocol`），先实测。只能在 CI 构建，装到真机测。

## 风险与未验证的事实

- **PDFium 串行**：缩略图批量渲染会挡住可见 tile，必须有优先级。
- **pdfium-render 的 `thread_safe` 是逐调用加锁**，不是逐文档：多线程共享一份文档不安全（见已定决策）。
- **未验证**：Android 上原始响应的编码；Windows IPC 开销（只有
  一条非官方说法：10 MB 在 macOS 约 5 ms、Windows 约 200 ms）。
- 出处：pdfium-render（crates.io、github.com/ajrcarey/pdfium-render）、
  pdfium-binaries releases、pdfium-lib（WASM）、v2.tauri.app（calling-rust、macOS 打包）、
  tauri discussions #11915、Node SEA 文档。

## 不做的

- MuPDF（见已定决策）。
- 一次性重写：pdf.js 在阶段 4 完成前一直留在树里。
- `bun build --compile` 换掉 Node SEA：`bun:ffi` 仍标记为实验性。
- Markdown 迁到 Rust（2026-09-25 评估）：编辑器必须留在 WebView 里的 CodeMirror 6，它的高亮、
  装饰和增量解析都建在 JS 的 Lezer 语法树上；只把预览换成 Rust 解析器（如 comrak）会让两个视图
  用两套语法、分歧更多。实测也不是计算瓶颈：1 MB 文档 marked 解析约 40 ms，编辑器挂载约 60 ms；
  首次进入编辑的 350 ms 来自 React.lazy 挂起加 React 19 约 300 ms 的 Suspense 节流，已修。
  重新评估的条件：Markdown 需要在 WebView 之外处理（CLI 解析 / 导出、全文索引），或出现实测
  卡顿的超大文档。届时把 comrak 放进 shiori-core，桌面、CLI、wasm 共用。

## 进度日志

- 2026-09-07 立项；阶段 0（页面常驻）完成。
- 2026-09-23 定 Web 走 WASM。
- 2026-09-25 App 架构重构完成：文档加载、挂起、释放都只经过 `PdfEngine`
  （`docs/PLAN-APP-ARCHITECTURE-2026-09.md`）。本文件修订为计划、路线图和 TODO；
  阶段 1 前提更正；批注显示规则定下。
- 2026-09-25 1.1 完成：dpr 2 下 8× 实际只画到 4.06×，画布峰值约 260 MB（`docs/PERF-zoom-tiles.md`）。
- 2026-09-25 1.2–1.5 完成：tile 上线（超出预算时），8× 真清晰，52–66 ms、峰值 106 MB。实测推翻 R1 的前提，R1 改为建议降门槛，待定。
- 2026-09-25 1.6 完成：缩放范围收成一处；阶段 1 完成。
- 2026-09-25 2.1 完成：`crates/shiori-core` 读页框与字符，PDFium 7881 按哈希取用；2.2（CLI 走 napi-rs）按 R2/R3 等 Jesse 确认。
- 2026-09-25 R1 定案：tile 门槛降到 8 MP 底图预算，3–4× 也走 tile（65–68 ms、106 MB）。R2–R5 按最佳实践采纳。
- 2026-09-25 2.2 前半完成：核心字形几何与 App 一致（38,899 个字形，最大偏差 0.0006 pt）。
- 2026-09-25 2.2 完成：CLI `extract` 可经 napi 插件走核心，引文改为按字取。
- 2026-09-25 2.3 完成（macOS 本机验证；Linux/Windows 待 CI）：CLI 发布包带上插件与 PDFium，许可与 SBOM 更新。阶段 2 完成。
- 2026-09-25 3.1、3.3、3.4、3.5 完成：桌面端页面、tile、缩略图由 PDFium 画；30 块 8× tile 69 ms（pdf.js 481 ms）。打包（3.2）前发布版找不到 PDFium，自动退回 pdf.js。
- 2026-09-25 3.2 完成：PDFium 随桌面包分发（macOS dmg +3.4 MB，已签名、已确认加载）。
- 2026-09-25 4.1 完成：pdf.js 只能在引擎层导入，13 个旧读取点列入逐项缩短的名单。
- 2026-09-25 4.2 完成：目录与链接经引擎读取，链接层不再依赖 pdf.js；命名动作经 pdf-lib 补上并加了前后翻页。
- 2026-09-25 4.3a 完成：读取层的文字类型与 pdf.js 解耦，pdf.js 直接导入只剩 3 个文件。
- 2026-09-25 4.3b 完成：自带文字层替换 pdf.js TextLayer，旋转页选字修复；pdf.js 直接导入只剩 2 个文件。
- 2026-09-25 4.3c 完成：桌面页面文字由 PDFium 字形合成，高亮样本映射率 100%，复制文本与 pdf.js 一致或更准。发布包签名因沙箱内连不上时间戳服务器未完成，待本机补打包。
- 2026-09-25 4.4 完成：批注导入改由 pdf-lib 读文件，ID 与 pdf.js 一致故草稿不迁移；桌面端无外观批注重复绘制、导出 INVISIBLE 批注重复两处一并修复。
- 2026-09-25 4.5 完成：查找与 Live 桥经引擎读文字，桌面走 PDFium；pdf.js 直接导入只剩 1 个文件。
- 2026-09-25 5.1 完成：CLI render 走核心，打包版 CLI 默认用核心读与画。
- 2026-09-25 4.6a 完成：核心编到 wasm，与原生逐字形、逐像素（嵌入字体）一致；堆可增长到 2 GB；未嵌入 CJK 需字体目录，已验证可行。
- 2026-09-25 4.6b 完成：Web 与移动端经 Worker 用 wasm 核心读与画，桌面包不带 wasm；未嵌入 CJK 按需取字体。
- 2026-09-25 4.7a 完成：加密文件的批注经 PDFium 解密副本由 pdf-lib 读取，导入不再依赖 pdf.js。
- 2026-09-25 4.7b 完成：紧凑导出经引擎光栅化；引擎层之外不再有 pdf.js 读取者。
- 2026-09-25 4.7c 完成：`PdfDocument` 不透明；PDFium 引擎打开文档不再经 pdf.js，Web 端不再启动 pdf.js Worker。
- 2026-09-25 4.7d 完成：pdf.js 从 App 移除，入口静态 JS 少 20%；阶段 4 除 4.6c（需 Android 设备）外完成。
- 2026-09-25 4.3d 完成：浏览器能直接用的嵌入字体经 PDFium 注册为编辑框字体；需要修复的格式列为 4.3e。
- 2026-09-25 收尾验证：`tauri:dev` 冷启动，桌面引擎为原生 `PDFium 7881`，读文字、目录正常；`annotations: false` 经 Tauri 命令生效（批注像素 2256 → 0）。CLI 以 Bun 1.3.12 重新打包、许可审计与 smoke 通过。
- 2026-09-25 4.3e 完成：浏览器不收的嵌入字体按 PDFium 画出的字形重建为 OpenType，Chrome 与 WebKit 均接受，与 PDFium 渲染逐像素相符；编辑框的字体回到 pdf.js 时代的覆盖。阶段 4 除 4.6c（需 Android 设备）外完成。
- 2026-09-25 桌面发布包本机重新打包：Developer ID 签名带时间戳，`codesign --verify --deep --strict` 通过（此前沙箱内连不上时间戳服务器）。
- 2026-09-25 2.3 在 CI 上验收：cli-verify run 36197348107 五个目标（darwin-arm64、linux x64/arm64 gnu、win32 x64/arm64）打包、冒烟全部通过。途中修了两处只在 Windows 出现的问题：`napi-rs` 许可文本被 CRLF checkout 改了字节（标 `-text`），冷启动 pdf.js 的锚点测试在 x64 runner 上超过 5 s 默认超时。
