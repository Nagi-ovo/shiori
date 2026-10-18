# 桌面端 PDFium 渲染：实测

阶段 3（`docs/PLAN-RUST-PDF-CORE-2026-09.md`）的实测记录。计时是人工证据，不是 CI 门槛。

## IPC 吞吐（2026-09-25，写 `render_tile` 之前）

- 机器：Apple M5 Pro，macOS 26.4.1；`bun run tauri:dev`（WKWebView，debug 构建）。
- 方法：临时注入的探针模块（`node_modules/.cache/shiori-performance/ipc-probe.js`，
  用完即删，index.html 已还原）对现有的 `read_pdf_bytes_at_path` 连续调用 9 次，
  这条命令用 `tauri::ipc::Response` 回传原始字节，与 tile 走同一条路；计时含 Rust 读文件
  和 JS 端 `new Uint8Array(raw)`。文件是 `%PDF-1.7` 开头加零字节。

| 大小 | 中位数 | 最快 | 最慢 |
|---:|---:|---:|---:|
| 1 MB | 3 ms | 2 ms | 5 ms |
| 4 MB | 5 ms | 4 ms | 7 ms |
| 16 MB | 10 ms | 9 ms | 19 ms |
| 64 MB | 26 ms | 23 ms | 50 ms |

结论：每次调用约 2 ms 固定开销，之后约 0.4 ms/MB。一块 512 px 的 RGBA tile 是 1 MB，
约 3 ms；8× 下 30 块串行约 90 ms，重叠渲染时更少。macOS 上 IPC 不是瓶颈，不需要改走
自定义 URI 协议。**Windows 未测**（WebView2 的 IPC 开销是计划里的已知风险，只有非官方
说法：10 MB 约 200 ms），要在 Windows 机器或 CI 上补。

## tile 渲染：PDFium 与 pdf.js（2026-09-25，阶段 3.1 接上之后）

- `bun run tauri:dev`，同一个 WKWebView 里用临时探针（用完即删）调用两个引擎的
  `renderRegion`：fable.pdf 第 2 页，8×、dpr 2，同一组 30 块 512 px tile。计时含 PDFium
  渲染、IPC、`putImageData`；pdf.js 含操作列表重放和画布绘制。

| | 逐块（总计 / 单块中位数 / 最慢） | 并发 30 块（总计） |
|---|---|---|
| PDFium | 69 ms / 2 ms / 4 ms | 34 ms |
| pdf.js | 481 ms / 13 ms / 88 ms | 70 ms |

- 真实打开：探针在 WebView 里发出 `file-open` 事件（与双击文件同一条路），打开
  fable.pdf 后 3 张整页底图、放大到 8× 后 15 块 tile 全部由 PDFium 画出，没有退回 pdf.js，
  15 块中 11 块有墨迹（其余是页边空白）。

## 文字层对齐（3.5）

同一区域分别用两个引擎画（8×、dpr 2，16 设备像素/pt），比较墨迹包围盒与重心：

| 区域（设备 px） | 包围盒差 | 重心差 |
|---|---|---|
| 512, 1024（标题行） | ≤ 1 px | 0.5 px |
| 1536, 2560（正文） | 0 px | 0.11 px |
| 2560, 5120（插图） | ≤ 1 px | 1.45 px（图像平滑不同，墨迹像素数差 7%） |

pdf.js 文字层与 pdf.js 像素对齐，所以文字层叠在 PDFium 像素上的偏差 ≤ 1 设备像素，
即 8× 下 ≤ 0.06 pt，肉眼不可见。字形几何本身在阶段 2.2 已对到 0.0006 pt。

### 非嵌入字体（2026-09-25 补测）

`scripts/pdfium/compare-ink.ts`：pdf-lib 生成一页未嵌入的标准 14 字体（Helvetica、Times、
Courier、Helvetica Bold，14 pt），两个引擎在 Node 里各画一次（4 px/pt；pdf.js 经
@napi-rs/canvas，PDFium 经 CLI 插件），在每个字形的字宽框内比较墨迹重心。

| 样本 | 字形数 | 重心差中位数 | 最大 |
|---|---:|---:|---|
| 未嵌入标准 14 字体 | 171 | 0.44 px（0.11 pt） | '1'、':' 纵向约 5.7 px |
| fable.pdf 第 2 页（嵌入字体） | 1009 | 0.37 px | 约 1 px |

未嵌入时两个引擎用各自的替代字体（pdf.js：随包的 Foxit/Liberation；PDFium：内置字体），
字形形状不同（数字 1、冒号的位置），但字距和排版位置相同：两边都用标准 14 字体的同一套
字宽，阶段 2.2 的字形几何比对也覆盖了这点。阶段 4.3 起文字层直接建在 PDFium 的字形几何
上，与 PDFium 的像素天然对齐；这不阻塞阶段 4。
