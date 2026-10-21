# 构建与发布：签名、公证、Android 分发

只在真正出包/发版时需要读。日常迭代走 `bun run tauri:dev`，与本文无关。
发版的完整流程（bump → tag → CI → macOS 本地签名构建 → updater manifest →
校验）在 `shiori-release` skill 里，本文只讲构建本身的机制。

## 签名构建

`bun run tauri build` 出的是 ad-hoc 本地包（签名身份是占位符 `-`）。任何要
交给另一台 Mac 的产物 —— 自动更新包、dmg 分发、任何要过 Gatekeeper 的东西
—— 都必须走签名包装脚本：

```bash
./scripts/build-signed.sh
```

`src-tauri/tauri.conf.json` 刻意把 `bundle.createUpdaterArtifacts` 保持为
`false`，这样普通本地构建不需要 updater 签名密钥。发布入口必须显式打开它，
签名包装脚本已经带了 `--config '{"bundle":{"createUpdaterArtifacts":true}}'`。

脚本会加载 `.env.tauri.local`（gitignored，存 Apple 凭据）和 `~/.cargo/env`，
然后跑标准 Tauri 构建。Tauri 2 会自动读取 `APPLE_ID` / `APPLE_PASSWORD` /
`APPLE_TEAM_ID`，一趟跑完 `codesign` + `notarytool` + `stapler`。

新检出的仓库如果没有 `.env.tauri.local`，从 `.env.tauri.local.example` 复制
一份填上：

- `APPLE_ID` —— Apple Developer 账号邮箱
- `APPLE_PASSWORD` —— app 专用密码，在 appleid.apple.com →
  Sign-In and Security → App-Specific Passwords 生成（**不是** Apple ID 登录密码）
- `APPLE_TEAM_ID` —— 10 位 Team ID，在 developer.apple.com/account 右上角

签名身份本身硬编码在 `tauri.conf.json` 里：
`Developer ID Application: Zexi Zhang (PJM828YBFJ)`。只有底层的 Apple
Developer 证书变了（比如续期）才需要改它。

## CI：发布到本仓库

源码、release 和 updater manifest 都在同一个公开仓库 `Nagi-ovo/shiori`
（原 `shiori-releases`，旧 URL 由 GitHub 重定向）。没有跨仓库 PAT：各 workflow
用自己的 `GITHUB_TOKEN` 和 `--repo "$GITHUB_REPOSITORY"` 上传，顶层
`permissions: {}`，只有真正发布的 job 拿 `contents: write`。

- `ci.yml`：每个 PR 和每次 push 到 `main` 跑 `bun run verify` 与
  `bun run test:core`（job 名 `verify`，`main` 的 ruleset 要求它通过）。
  AGENTS.md 里那两条 timing-sensitive 测试单独跑，失败重试一次并留 warning。
  缓存只由 `main` 的 push 写入。
- `release.yml`：推 `v*` tag 构建 Windows / Linux / Android 并上传到同名
  release。签名 secret 只放在 `release` environment 里：
  `TAURI_SIGNING_PRIVATE_KEY`（+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）和 `ANDROID_UPLOAD_KEYSTORE_BASE64` / `ANDROID_UPLOAD_KEYSTORE_PASSWORD`
  / `ANDROID_UPLOAD_KEY_ALIAS` / `ANDROID_UPLOAD_KEY_PASSWORD`。每周一的
  `warm-cache` job 不进 environment、不打 updater 包，拿不到任何签名 secret，
  只负责让 tag 构建能恢复 `main` 上的依赖缓存。
- `cli-release.yml`：推 `cli-v*` tag 打包五个目标的 CLI 并发布到同名
  release。macOS 签名与公证用的 `MACOS_CERT_P12`、`MACOS_CERT_PASSWORD`、
  `MACOS_SIGN_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` 也在
  `release` environment；没配时 macOS 产物退回 ad-hoc 签名。
- `release` environment 的部署规则要放行 `v*`、`cli-v*` tag 和 `main`：
  修 workflow 后用 `workflow_dispatch`（`tag=vX.Y.Z`、
  `publish_to_release_repo=true`）补发时，run 挂在 `main` 上、用 `main` 的
  workflow 文件，但各 job 检出并构建的是 tag 本身的代码（tag 必须已推到远端）。
  不发布的分析 run 仍构建发起 dispatch 的那个分支。同一个 tag 的 run 共用一个
  concurrency 组，后来的排队等前一个跑完，不会交错 `--clobber` 同一批资产。
  三个平台 job 在 `release-{windows,linux,android}.yml` 里，由 `release.yml`
  以 reusable workflow 调用。
- 所有第三方 action 都钉在 commit SHA 上（后面注释版本号），由 Dependabot
  每周提 PR 升级。

## Updater manifest 与 release notes：`gh-pages` 分支

`https://updates.shiori.nagi.fun` 是本仓库 `gh-pages` 分支的 GitHub Pages：
`alpha/latest.json`（updater manifest）和 `notes/<version>.json`（应用内更新
提示的三语说明）都提交在那个分支上，不在 `main`。在仓库旁边留一个 worktree：

```bash
git worktree add ../shiori-pages gh-pages
```

`bun run scripts/prepare-release-notes.ts` 把 `notes/<version>.json` 写进
`../shiori-pages`（`--pages <dir>` 可换路径，不在 `gh-pages` 上的目录会被拒绝）。
`alpha/latest.json` 怎么从最终产物生成、怎么校验，见 `shiori-release` skill。

## Web 版：Cloudflare Pages（app.shiori.nagi.fun）

Web 版是 Cloudflare Pages 上的一个项目，Git integration 连本仓库 `main`，从仓库
根目录构建，产物是 `dist/`。构建命令：

```bash
curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target wasm32-unknown-unknown && . "$HOME/.cargo/env" && V=$(grep -o 'WASM_BINDGEN_VERSION = "[^"]*"' scripts/pdfium/build-wasm.ts | cut -d'"' -f2) && mkdir -p vendor/tools/bin && curl -sSfL "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/$V/wasm-bindgen-$V-x86_64-unknown-linux-musl.tar.gz" | tar xz --strip-components=1 -C vendor/tools/bin "wasm-bindgen-$V-x86_64-unknown-linux-musl/wasm-bindgen" && bun install && bun run build
```

Pages 的 v3 构建镜像没有 Rust，而 `bun run build` 要把 shiori-core 编译成
wasm。所以命令先装最小 profile 的 Rust 和 `wasm32-unknown-unknown` target，再从
`scripts/pdfium/build-wasm.ts` 读出钉死的 `WASM_BINDGEN_VERSION`，把同版本的
预编译 wasm-bindgen 放进 `vendor/tools/bin`，免得 `build-wasm.ts` 在构建机上
现场 `cargo install`。Web 版部署从 2026-09-25 起一直失败，直到 2026-10-16 换成
这条命令才恢复。改 wasm-bindgen 版本只需改 `build-wasm.ts`，这条命令不用动。

Web 版开了 Cloudflare Web Analytics（2026-10-16 起）：不设 cookie，只做聚合的
访问计数，已写进隐私政策（`site/src/content/legal.ts` 第 4 节）。它是在
Cloudflare 那边开的，仓库里没有对应的脚本；桌面端和移动端没有任何统计。

## Android 分发是一个影响很远的构建期开关

`SHIORI_ANDROID_DISTRIBUTION` 是 gradle 环境变量（在
`src-tauri/gen/android/app/build.gradle.kts`），默认 `google-play`，只认
`google-play` | `direct-apk` 两个值。它会流到前端变成
`__SHIORI_ANDROID_DISTRIBUTION__` → `CAPABILITIES.androidDirectUpdater`
（`src/platform/index.ts`）。

**只有 `direct-apk` 构建才会跑应用内侧载更新器**
（`installDirectAndroidUpdate` → `MainActivity.kt` 里的
`window.ShioriAndroid.installDirectApk`）；`google-play` 构建把更新交给商店，
整条直装路径完全不执行。

后果：一个 Android 更新器的 bug 可以在每一个商店构建里静默潜伏，直到你第一次
发 `direct-apk` 才炸出来。所以测应用内更新时必须带上这个环境变量构建，别让
「之前是好的」替代对直装路径的实测。根因复盘见 `docs/POSTMORTEMS.md`
2026-06-15 与 2026-06-29 两条。

## 应用图标

`src-tauri/icons/*` 下所有栅格图标（icns、ico、各尺寸 PNG、iOS / Android）都由源
SVG 生成：改完 `public/brand/shiori-tile.svg` 后跑
`bun tauri icon public/brand/shiori-tile.svg`，一次重生成全部尺寸。
