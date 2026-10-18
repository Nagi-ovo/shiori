# PLAN · 页面原生的 agent 交互

> 2026-07-27 讨论产出，2026-07-28 经对照代码的对抗性审查修订。
> **状态（2026-09-23 核对）：P0、P2、P3、P4 完成；P1 的 P1a 大纲/文件夹树（`dc78c173`、
> 多文件夹 `21ed9bc2`）、P1b 显式 pin（`9e4e1e25`）、P1c 过滤、P1e 切换器已落地。
> P1d 完整失效流程、P1f 移动投影、P0b 冲突检测、P2a-3 加载时重解析未确认/未做。**
> 一句话目标：**让问题写在页面上，答案也留在页面上——不必切回终端。**

**平台边界（初版遗漏的关键约束）**：Live 桥是 desktop-only
（`src/platform/index.ts:135`，`liveAnnotationBridge: IS_TAURI_DESKTOP`），
web / mobile 没有 Live 传输层，mobile 也没有内置终端。
所以 **P2–P4 的"页面上与 agent 对话"闭环首发只在桌面**。
web / mobile 的可行路径（CLI 离线写 spec → 打开时加载）是降级形态，
按 AGENTS.md 第 9 条，动工前必须把三端行为明确写进设计,而不是默认桌面。

---

## P3 · agent skill（CLI 说明书）—— 最先做

### 为什么提到最前

- **零代码。** CLI 的读写两侧今天就是通的：`shiori app context`（读当前上下文）、
  `shiori app annotate --spec` / `shiori annotate --spec`（写标注，原子、可回滚）。
- **最便宜的探针。** 真实 agent 用起来之后，"追问回路到底缺什么"
  （P2 的线程模型、P4 要不要 push）会用事实回答，而不是靠假设。

### 方向：不是"Shiori 接入 agent"，是"Shiori 被 agent 接入"

做「接入」要给 Codex、Claude Code、Cursor 各写适配器，永远追不完。
做「被接入」只维护一个稳定的本地能力面。这个能力面已在
`src/live/liveApiBridge.ts`：读侧 `buildLiveApiContext` / `createLiveContextPublisher`，
写侧 `applyLiveAnnotationRequest`。

### 做什么

- 一份 skill / 说明书：`shiori` 有哪些命令、annotation spec 长什么样、
  怎么读当前上下文、批量落标注的正确姿势（一个 spec 文件一条命令，
  不要拆成 N 次调用）。
- 工作区根目录放能力自述（`AGENTS.md`）。

### 上下文粒度（审查修正）

- **文件级：已通。**
- **页级：也已通** —— `LiveApiContext` 已含 `activePage`（页码、宽高、旋转），
  见 `src/platform/liveApi.ts:19`。初版说"缺页级"是错的。
- **真正缺的只有选区级**（"这段"指哪一段）。这是唯一要补的上下文接口。

### 明确不做

- 不让 Shiori spawn 或托管 agent 进程——登录态、模型、权限，agent 自己管得更好。
- ~~API key + base URL 支路~~ — **砍掉**。与主线无关，不做。

---

## P0 · 草稿从"每次询问"改为"静默恢复"

### 为什么

值得打断用户的只有「有没有冲突」，不是「有没有草稿」。
草稿的语义应该是**「就是你的当前状态」**，不是「一份待确认的备份」。

### 审查带来的修正

**hash-mismatch 冲突弹窗不是"现成分支"，是新基建。**
草稿按 bytes 的 SHA-256 键控（`src/storage/drafts.ts:48`），
原文件被外部改动后是新 bytes → 新 hash → 直接 miss——
**今天这个场景根本不弹窗**，旧草稿静默变孤儿。
要检测"文件变过了"，需要 path → 上次 hash 的映射；
目前只有 workspace tab 上有（`workspace.ts:54` 的 `hash` + `source`），
普通 picker / 拖放 / 移动端分享路径都没有。
→ **P0 拆两步：先做静默恢复（安全，hash 键控保证草稿与打开的 bytes 严格一致），
冲突检测作为 P0b 单独设计。**

### 验收

- 打开有草稿的文件：不弹窗，直接是上次状态；状态栏有持久标记，
  点「用原始文件打开」可随时切回。
- 设置 → 存储能批量删除草稿。
- （P0b）外部改动过的文件能被识别并提示——依赖 path→hash 映射设计完成。

### 平台

三端一致。desktop 文件关联打开（macOS `Opened`、Windows/Linux argv）、
web picker / 拖放 / FSA、mobile picker / 分享，全部命中同一分支。

---

## P2 · 引线批注 = 与 agent 的对话载体

### 为什么是 callout

`CalloutSpec`（`src/pdf/annotations/spec.ts:92`）天生带齐
`targetRects` / `anchor` / `quote` / `text` —— 一个带出处的回答的全部构成。
别的产品要在聊天框里拼「答案 + 引用 + 跳转」，这里它本来就是一个对象。

`src/live/overlayReveal.ts` 的逐条揭示就是 streaming 的空间版本：
别人在聊天框里吐 token，这里在页面上逐个落锚点。

### 审查修正：锚定持久化才是 P2 的真门槛

初版宣称「文档改了，批注还在原句上」——**核查后不成立**。
anchor 在 `parseAnnotationSpec` 之前就被解析成坐标
（`resolveAnchors.ts:36`："parser、export、Live API 幂等机制从不见到
anchor——by construction"）；持久化的 `CalloutOverlay`
（`src/pdf/model/types.ts:160`）只存 `targetRects` 等纯坐标，
**不存 anchor、不存 quote**。文本锚定只活在创建那一瞬间。

要兑现「重排后依然指在原句上」这个核心卖点，P2 必须新增：

- 把 quote-anchor 持久化进 overlay（或平行的 sidecar 结构）；
- 加载时重解析锚点，失败时回退到存量坐标并明确标记"可能已错位"。

这与「三格式平等、文本锚定标注跟文件走」的既定方向一致，
但它是**新工程量**，不是现成资产。P2 排期按此估算。

### 导出降级：已被现有代码解掉大半（初版高估了难度）

`/IRT` 回复链机制已存在：import 把 `/IRT` 拷入 `sourceInReplyToId`
（`import/annotations.ts:588`），export 重连 `/IRT`
（`export/annotations.ts:225-263`），Shiori 私有 dict（SHIO）也已在写。
**线程 = 根 callout + `/IRT` 回复链，Acrobat 原生渲染为评论线程。**

剩余工作：

- Shiori 自建 overlay 目前从不写 `sourceInReplyToId`（`types.ts:13`，
  deliberate）——需要新增本地回复模型与角色归属（PDF 注释只有 `/T`，
  区分"你 / agent"要走私有 dict）。
- `/IRT` 限同页（`export/annotations.ts:227`），回复挂同页即可满足。

### 撤销与追溯（审查修正）

~~走 operationLog.ts~~ — 不成立。`src/storage/operationLog.ts:5` 是
localStorage 里的**整模型崩溃恢复快照**（一条 entry = 完整 DocumentModel），
不是逐操作日志，没有 agent 归属。agent 标注的撤销实际走 editor store 的
undo 栈（`liveApiBridge.ts:539` 已做 undo snapshot）。
若要"追溯哪条标注是谁落的"，归属信息应记在标注/线程结构自身上。

### 交互原则

- **不做自动。** agent 一直冒泡会烦，你问它才答。
- 「实时」指你一说它立刻知道，不是它一直在动。
- 一次回答落多条 callout 依靠已有的 seal 折叠控制页面密度。

### 平台

闭环首发桌面（Live 桥 desktop-only）。web / mobile 首发只保证：
CLI/agent 离线写入的线程能正确显示、能人工续写；实时回路后续再评估。

### 依赖

- 所有新文案进 `src/i18n/locales/{en,zh,ja}.json`。

---

## P1 · 工作区：从"一份 session"变成"可命名的多份"

### 现状

`src/storage/workspace.ts` 已有底座：tab 集合、每 tab 阅读位置与视图状态、
源 blob，全部持久化。但是**单份全局 session**（`loadWorkspaceState()` 无参），
i18n 里没有任何 workspace 面向用户的文案——用户看不见它。

### 方向：不做文件管理器，做"可命名的会话"

工作区只存**引用**（路径 / FSA handle）加上下文。
**定义：工作区 = 一组文件 + 你在它们之间的位置 + 你为这组文件积累的思考。**

### P1a — 左栏：两棵树，一冷一热

`TabStrip.tsx` 把扁平的 `tabs` 横着铺开，超过 5、6 个文件就失控。

| | 大纲 | 文件夹 |
|---|---|---|
| 内容 | 你真正在读的文件 | 挂进来的磁盘目录 |
| 结构 | **扁平**，按最近阅读排序 | 镜像磁盘，有嵌套 |

1. 文件不再「打开/关闭」，只有「展开/折叠」。
2. 切换文件和跳转位置是同一个动作（点文件名＝打开，点锚点＝跳页）。
3. 大纲不镜像目录嵌套；溯源用文件名下的灰色路径。

### P1b — 晋升（审查后简化）

~~读满 10 秒 / 首个标注才晋升~~ — **砍掉**，过度设计。
改为**显式加入**：文件夹里点开只是预览，点「加入大纲」（pin）才进工作区。
一个按钮，意图清晰，零启发式。

### P1c — 无关文件的三道过滤

1. 只显示打得开的格式，其余不显示（不是灰掉）。
2. 默认隐藏点开头文件与 `node_modules` / `.git` / `__pycache__` 类目录。
3. 懒加载，绝不递归扫全盘。空目录折叠时不显示。

注意：「挂载目录」在 Safari（无 FSA 目录句柄）和 mobile 不存在，
文件夹模式是 desktop + Chromium-web 的能力，其余平台只有大纲模式。

### P1d — 引用失效（审查后修订）

**路径不是主键，内容哈希才是**——但有两个修正：

- **可编辑文本文档的 hash 会过期。** 文本文档走 working copy
  （`workspace.ts:60`），save-back 只清 `textDirty`（`App.tsx:1162`），
  **不更新 tab.hash**。不修这个，用户自己的正常编辑会被误报成
  "文件被外部改过"。→ **每次 save-back 后必须刷新记录的 hash**，
  这是 P1d 的前置修复。
- ~~全根目录哈希扫描~~ — **首发砍掉**（2000 篇论文 × 5MB = 10GB IO）。
  找不到时直接走手动重定位；确有需求再加 size+文件名预筛的扫描。

保留的处理流程：

1. 按路径找，命中即结束。
2. 找不到 → 条目留在树上灰掉标「找不到」，**绝不自动删**，
   标注/位置/锚点全保留。点它 → 「重新定位…」，哈希一致静默接上。
3. 哈希对不上（文件真被外部改过）→ 唯一出声的分支：
   「文件变过了，标注可能对不上位置」，用户决定。

**不上文件系统 watcher**：与零同步冲突。打开工作区时惰性校验，
且只校验大纲里的文件。

### P1e — 快速切换器（审查后降级）

与大纲树互补：树是慢速全景，切换器是肌肉记忆。

- MRU 排序；按住循环、松手落定；`Ctrl+Tab`；只做最近 6 个。
- ~~实时页面缩略图~~ — **降级为缓存的静态缩略图**。
  后台 tab 的文档不保证驻留，实时渲染要么强制驻留（内存代价）要么砍。切换/翻页时抓一帧存起来即可，
  轻微过期完全可接受。
- 整个 P1e 是锦上添花，排在 P1a–P1d 之后，砍它不影响主线。

### P1f — 移动端

同一份 `WorkspaceState` 的两种投影：桌面 split view，移动层级导航
（树是首页，返回手势回到树）。**按宽度分（≥768px split view），不按平台判断。**
注意 P2–P4 的对话闭环移动端没有（无 Live 桥、无终端），
移动端工作区只做"读 + 树 + 已有标注展示"。

### 验收

- 能新建/命名/切换多个工作区，重开位置全部恢复。
- 挂载真实大目录不卡顿，展开才加载。
- 把已加入的文件在 Finder 里改名 → 树上灰掉、手动重定位能接回。
- 在 Shiori 里编辑文本文件并 save-back → 不误报"外部改动"。

---

## P4 · 追问回路（审查后重新选型）

### 目标场景

用户在页面上点开一条 callout、输入追问，agent 得知道有人在跟它说话。
pull 解决不了——agent 不可能轮询「有人回我了吗」。

### 审查发现：MCP push 唤不醒空闲 agent

MCP 通知不会让 Claude Code / Codex 发起新的一轮——agent 只在自己的 turn 内
拉取工具结果，协议本身没有「发起 turn」的能力。
**单靠 MCP server 做不成这个功能。**

### 首选方案：终端 stdin 注入

Shiori 已内嵌终端托管 agent 会话。把追问作为文本注入该终端的 stdin
（等价于用户在终端里打了这句话），零协议成本，真正能唤醒 agent。
桌面首发正好与内嵌终端的平台边界一致。

需要设计的点：

- 追问文本如何携带上下文（callout id、页码、引文）——大概率是
  注入一条带引用路径的自然语言 + 让 agent 用 CLI 读线程详情。
- 终端里没有活跃 agent 会话时的降级（提示用户启动，或排队等待）。

### MCP 的处置

**推迟立项。** 等 stdin 注入方案被证伪、或出现"agent 主动长驻监听"的
生态能力后再评估。P3 的 skill 探针会给出事实依据。

---

## P2c · agent 的读侧 ✅ 2026-07-29

首次端到端跑通时，终端里的 agent 主动指出：「CLI 没法读出 callout 自己的
正文和追问那句话，我只能确认 ID 有效。」——**它能写不能读。**

- 注入行只带当前一句，无历史（`src/live/followUpLoop.ts`）。
- `buildLiveApiContext` 只返回文档级信息，**不含任何标注内容**。
- 后果：第二句追问的指代无法解析；新终端零上下文。

**已做的修法**：扩展 `shiori app context`，不新增子命令。live context 里多了
一份**只含内容、不含几何**的标注摘要（id / type / page / 正文 / 锚定引文 /
线程轮次），`app context` 打印它，`--json` 返回它。带上 id 是关键——它正是
`calloutReply` 的目标，读和回因此是同一个动作。

注入行仍然只带当前一句，只是多指了一句「先跑 `shiori app context` 读线程」。
**没有**把历史塞进注入行（会撑爆 4000 字符上限，终端全是噪音）。

三个约束当时就定死了，改这块前先读懂：

1. **只推内容，不推几何。** live context 是**推**给 native 的，每次模型变更
   都推一次；带上 rect 就等于拖动时每帧重推整份文本。agent 也用不上坐标，
   它用的是引文和 id。
2. **摘要的身份要稳。** `App.tsx` 先 `JSON.stringify` 再 `JSON.parse`，用字符串
   当变更探针：移动/缩放标注不改任何正文，JSON 不变，对象身份不变，于是不
   重推。删掉这层就退回每帧一次 IPC。
3. **三层各自设上限，截断要说出来。** 前端 `src/live/annotationDigest.ts` 设帽
   （单条 400 字、线程 12 轮、整体 48000 字），`live_api.rs` 校验，CLI 再查一
   遍。截断时置 `annotationsTruncated`——一份看起来完整的残缺列表比没有列表
   更糟。

赛道调研与其余缺口见 `docs/RESEARCH-AGENT-NATIVE-READERS-2026-07.md`。

## 待解决的问题（还没答案）

1. 锚定持久化的存储形态：进 overlay 本体，还是 sidecar？（P2 第一道门槛）
2. 线程角色归属在 PDF 私有 dict 里的具体编码（区分你 / agent / 其他工具）。
3. 选区级上下文接口的形状（P3 唯一要补的接口）。
4. P0b 的 path→hash 映射建在哪一层（recents？workspace？独立表？）。
5. 大纲树变深后的键盘导航。
6. 跨文件笔记挂在树上，还是独立成第四层。

---

## 明确否掉 / 砍掉的方向

- 右侧聊天栏问文档——同质化，云端方案，与本地优先冲突。
- 全库语义检索——Zotero 插件已做。
- 文件系统 watcher——与零同步冲突，惰性校验足够。
- Shiori 托管 agent 进程——重做别人做得更好的事。
- （审查新增）晋升启发式（10 秒/首标注）→ 显式 pin。
- （审查新增）切换器实时缩略图 → 缓存静态帧。
- （审查新增）全根哈希扫描 → 手动重定位。
- （审查新增）API key + base URL 支路 → 不做。
- （审查新增）MCP server → 推迟，首选终端 stdin 注入。
