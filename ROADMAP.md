# Roadmap

> **Guiding principle.** Default to Web. Only migrate a module to Rust when
> it hits a ceiling Web can't clear. Code that does move to Rust is
> compiled twice — native for Tauri, WASM for the browser — so the web
> build never falls behind the desktop one.

This document is a living plan, not a backlog. It names the modules,
explains why each belongs where it is today, and writes down the explicit
triggers that would move it elsewhere.

Shipped surfaces today: web, desktop (macOS / Windows / Linux), Android
(direct APK), and the public CLI (`cli-v0.1.25`, 2026-09-13).

---

## Product direction (decided 2026-07-05)

Settled in an interview with Jesse — flag conflicts with code reality rather
than re-litigating them:

1. **定位：多格式平等的 agent 阅读器**（当时定的是 PDF / md / html 三格式，之后又加了 DOCX）。
2. **不做同步**：零后端、无账号，文件靠系统分享 / 网盘流转。
3. **md/html 也要标注**，文本锚定（quote + 上下文，类 Hypothesis），agent 重新
   生成文件后尽量存活。
4. **标注跟文件走**：导出 / 分享时嵌入（PDF 标准注释）或打包（md/html 方案待设计）。
5. **纯打开器**：不引入「库 / 监听文件夹」概念。
6. **入口只抢 PDF 系统默认**（对手是预览 / Edge）；md/html 靠 PDF 带动，不抢浏览器 /
   编辑器的默认。
7. **差异化主赌注：本地优先 + 轻快干净**；agent 工作流是附加项。
8. **平台保障先架构后 CI**：能力矩阵进类型系统（缺实现编译不过），再补多平台 CI 冒烟。

当时盘点的缺口（现状未复核）：md/html 文本锚定标注、iOS 分享 / 打开、能力矩阵的
编译期强制。

---

## Layer 0 · Web forever

No foreseeable reason to touch these in Rust. UI and pure data logic are
cheap to iterate on in TypeScript and expensive to marshal across an IPC
boundary.

- React components, CSS, animations
- Zustand store, undo/redo history, selection state
- Annotation data model (overlays, pages)
- Drag & drop, keyboard, focus management
- i18n, theme, Settings panel
- IndexedDB draft storage
- Top bar, thumbnails, right rail, status bar chrome

---

## Layer 1 · Web today, Rust when triggered

These features currently have a pure-JS implementation that works well
enough. Each row below lists an explicit **trigger** — when a concrete
signal fires, migrate that specific module. No trigger, no migration.

| Module | Current impl | Trigger to move | Target stack |
|---|---|---|---|
| PDF rendering and reading | PDFium via `crates/shiori-core` (**shipped 2026-09**; `docs/PLAN-RUST-PDF-CORE-2026-09.md`) | Done | `pdfium-render` (MuPDF ruled out: AGPL) |
| PDF export | `pdf-lib` + `@pdf-lib/fontkit` | Font or encryption bugs surface, or export of >200 MB PDFs takes >3 s at P95 | `lopdf` or `pdf-writer` (Rust) |
| Font subsetting | `@pdf-lib/fontkit` | Chinese exports routinely exceed 5 MB; or we need OpenType variable font support | Same Rust library chosen for export |
| Hash of PDF bytes | Web Crypto `SHA-256` | Never — platform primitive is already optimal | — |

**How to decide a trigger actually fired.** Before touching any of these,
instrument the hot path with `performance.mark()` and collect real P95
numbers. Subjective "feels slow" is not a trigger.

---

## Layer 2 · Rust-first — new capabilities

When a new capability enters the roadmap, evaluate against this list
first. Some capabilities are fundamentally unsuited to a pure-JS
implementation; start them in Rust from day one.

| Capability | Why it needs Rust | Library candidate | Priority |
|---|---|---|---|
| **OCR** for scanned PDFs | `tesseract.js` exists but is ~5–10× slower than native Tesseract; selection and highlight UX depends on throughput | `tesseract-rs` / `ocrs` | ★★★★★ most likely first Rust module |
| **Full-text search index** | In-memory JS inverted indexes explode on large corpora; Cmd-F on a 500-page doc needs a real engine | `tantivy` | ★★★★ |
| **Semantic search** ("where does this paper discuss low-rank?") | Embedding inference through WASM works but saturates at small models; native is needed for real-time | `candle` + `sqlite-vec` | ★★★★ |
| Local LLM for summarize / translate / annotation assist | 4–8B quantized models run at 30 tok/s on Apple Silicon; cloud is optional | `candle`, `mistral.rs`, or shell out to Ollama | ★★★ |
| Streaming parser for >500 MB PDFs | Browser `ArrayBuffer` hits practical limits; must stream from disk | `lopdf` in streaming mode | ★★ |
| True text editing (not overlays — modify the original content stream) | Requires robust font mapping, content-stream rewriting, ligature handling; JS libs can't do it safely | `lopdf` + custom layout | ★ high ambition, high risk |

---

## Layer 3 · Desktop-only (Rust inside Tauri)

Capabilities that the browser fundamentally can't provide. These go in
`src-tauri` and are not part of the web build.

Shipped: `.pdf` file association (`tauri.conf.json` `fileAssociations`) and
the native menu bar (`src-tauri/src/lib.rs`).

Still open:

- macOS Spotlight indexing, Quick Look, Share Extension
- System tray
- Native printing pipeline (printing is still an iframe `print()` today)
- System-level drag-drop out of the app (drag a page into Finder/Explorer)

Watch folders are deliberately out: they conflict with direction #5 (pure
opener).

---

## WebAssembly

**Shipped 2026-09:** `crates/shiori-core` builds natively for Tauri and the
CLI and as wasm for web and mobile (`crates/shiori-core-wasm`, run in a Web
Worker). New Rust capabilities follow the same core / native / wasm split, so
the web build never lags the desktop build.

When a prebuilt WASM library (`tesseract.js`, `sqlite-wasm`, …) covers a need
adequately, reach for it first and only invest in a custom Rust crate if
performance or customization demands it.

---

## Horizon

| Horizon | Scope | Contains no… |
|---|---|---|
| **Now** | Split `cli/src/main.ts` (~2.8K lines); device-verified releases. | New Layer 2 crates. |
| **Next** | Android native PDFium (performance only; plan item 5.2). | — |
| **Later** | OCR, search index, semantic search — only when a Layer 2 trigger fires. | Cloud sync, SaaS, accounts — deliberately. |

Every arrow forward is optional. If the current surfaces serve users well
without any of the Layer 2 work, that's a feature, not a gap.

---

## References · Rust PDF library candidates

Tracked here so the decision isn't rediscovered from scratch the day a
trigger fires. Numbers snapshotted 2026-04-21.

| Library | What it is | Good for | Notes |
|---|---|---|---|
| [**lopdf**](https://github.com/J-F-Liu/lopdf) | Pure-Rust PDF toolkit (2.1k★, last release v0.39.0 · 2026-01, MIT) | Read/write PDFs, manipulate content streams, merge/split, extract text | Lower-level than pdf-lib — you work with content-stream operators directly. **The strongest current candidate for true text editing** because it exposes what the higher-level crates abstract away. Expect to build your own layout helpers on top. |
| [**pdf-writer**](https://github.com/typst/pdf-writer) | Typst's write-only PDF library | Producing fresh PDFs from scratch | Faster and cleaner than lopdf for export-only flows; not an option if we need to mutate existing PDFs. |
| [**pdfium-render**](https://github.com/ajrcarey/pdfium-render) | Rust bindings over Google's PDFium (the Chrome PDF engine) | Rendering fidelity, battle-tested parser | Requires shipping the PDFium binary (~8 MB). Best candidate if the trigger is a rendering bug rather than an editing need. |
| [**mupdf-rs**](https://github.com/messense/mupdf-rs) | Rust bindings over MuPDF | Rendering + limited editing | Industry-grade parser. Licensing is AGPL, which is incompatible with shipping Shiori under MIT; ruled out. |
| [**pdf-rs / pdf**](https://github.com/pdf-rs/pdf) | Pure-Rust reader-leaning crate | Parsing, extraction | Less focus on authoring than lopdf. Worth a look when search/indexing lands. |

**Working hypothesis.** When the "real text editing" row in Layer 2 moves
from parked to active, `lopdf` is the default pick. If it proves to lack
coverage for a specific edge case (e.g., certain CMap encodings),
fall back to `pdfium-render` for read + `lopdf` for write in a split
pipeline.
