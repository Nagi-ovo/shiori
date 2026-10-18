# Changelog 维护约定

Shiori 维护 **两层** changelog：

| 文件 | 面向 | 包含 |
|---|---|---|
| `/CHANGELOG.md`（根） | **维护者** | 完整技术细节：commit SHA、postmortem 链接、Keep-a-Changelog 式分区注释。Git 历史追踪用 |
| `docs/changelog/zh.md` | **用户**（中文） | 纯人话说明，无 SHA、无技术术语。App 内 changelog modal 读取 |
| `docs/changelog/en.md` | **用户**（英文） | 同上 |
| `docs/changelog/ja.md` | **用户**（日文） | 同上 |

中文版（`zh.md`）是用户向内容的**权威版**，英 / 日两份由它翻译。

## 为什么分两层

App 的 changelog modal 显示给用户，用户看 SHA、postmortem 路径、"Keep a Changelog 格式" 这类内容会**不明所以且出戏**。所以：

- 开发过程留下的完整细节（SHA、修复的技术根因、工程复盘链接）留在 `/CHANGELOG.md`
- App 内**只显示** `docs/changelog/{zh,en,ja}.md`——写成"什么变好了、什么被修好了"的人话

Modal 代码里**绝对不要 import** 根目录的 `CHANGELOG.md`；只 import `docs/changelog/{zh,en,ja}.md`。

## 更新流程

每落地一批 commit 后：

1. **先写 `/CHANGELOG.md`**（维护者版）。新条目放 `[未发布]` 下的 `修复` / `新增` / `改动` 之一，附上 commit SHA；有复盘的加 `docs/POSTMORTEMS.md` 链接。
2. **同步用户版** `docs/changelog/zh.md`：把同一变动翻译成**给用户看的一句话**（不是搬原样）。举例：
   - 维护者版：`polyfill ReadableStream.prototype[Symbol.asyncIterator] at bootstrap, pdf.js text layer now renders on WKWebView (1309118)`
   - 用户版：`**Mac 上的高亮工具终于可以选中文字了。**`
3. **镜像到 en.md 和 ja.md**。保持条目数量和顺序一致。

## 版本发布时

当 `src-tauri/tauri.conf.json` / `Cargo.toml` 升版号时，所有 4 份文件：

1. 把 `[未发布]` / `[Unreleased]` / `[未リリース]` 重命名为新版本号，不带日期：
   用户版写 `## 26.9.9`，维护者版写 `## [26.9.9]`。
2. 跑 `bun run scripts/prepare-release-notes.ts`：它在三份用户版的版本标题下写入
   `> <代号>`（`src/release/epigraphs.test.ts` 强制要求这一行），并生成
   `notes/<version>.json`。
3. 下一条未发布的变动落地时，再在顶部新建 `[未发布]` 节；不要留空节。

## Claude 使用提示

一个 session 里只读一份语言版本，避免把三份都拉进 context 浪费 token：
- 默认读 `/CHANGELOG.md`（维护者版，中文）
- 查用户向措辞 / 翻译一致性时读对应的 `docs/changelog/{zh,en,ja}.md`
