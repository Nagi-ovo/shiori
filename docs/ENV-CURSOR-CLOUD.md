# 在 Cursor Cloud Agent VM 里跑这个仓库

只有当前会话确实运行在 Cursor Cloud VM 上时才需要读本文。在 macOS 本机
开发的话整篇都不适用（PATH、toolchain、可跑目标都不一样）。

启动更新脚本已经替根项目和 `site/` 各跑过一次 `bun install`，所以每次会话
开始前依赖是新的。以下是这个环境里持久、不显然的上下文，不是一次性配置步骤。

- **`bun` 在 `~/.bun/bin/bun`。** 这里的非交互 shell 不 source `~/.bashrc`，
  所以普通命令里 `bun` 可能不在 PATH 上。要么写全 `~/.bun/bin/bun …`，要么
  起登录 shell（`bash -l`）。没走登录 shell 的 tmux pane 同理。
- **Web dev server 是这里的主要可跑、可测目标。** `bun run dev` 在
  http://localhost:1573 提供完整 React 应用（固定端口，`strictPort`）。Web
  构建和桌面/移动壳共用同一份代码，所以在浏览器里就能验核心的 PDF
  阅读 / 标注 / 导出。
- **官网是 `site/` 里的独立 Vite 项目**，有自己的 `bun.lock`；
  跑 `cd site && bun run dev`（默认 http://localhost:5174）。
- **Rust / Tauri：** 和 macOS 那套（要 source `~/.cargo/env`）不同，这里
  `cargo` 已经在 PATH 上（`/usr/local/cargo`）。默认工具链钉在较新的 stable
  上 —— Tauri 依赖树需要 Cargo ≥ 1.85 才有 `edition2024`，镜像自带的 1.83
  会失败。Tauri 需要的 Linux GTK/WebKit 开发库已装齐，`src-tauri/` 里
  `cargo check` 能过。
- **别指望在这里跑 Tauri 桌面 GUI。** `bun run tauri:dev` 需要桌面显示来开
  原生窗口，而这台 VM 是面向无头的。桌面侧改动用 `src-tauri/` 里的
  `cargo check` / `cargo test` 验，共享 UI 走 web dev server 验。
- **要一份用完就扔的样例 PDF**，可以跑
  `bun run site/scripts/build-welcome-pdf.ts`（它会写进被 git 跟踪的
  `site/public/welcome.pdf` —— 用完 `git checkout` 还原，或者先拷贝出来），
  用来手测打开 / 标注 / 导出流程。
