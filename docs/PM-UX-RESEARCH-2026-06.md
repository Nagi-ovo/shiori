<!-- 由 2026-06-10 多 agent 调研生成：5 维代码审计(逐条对抗验证) + 5 路调研(代码UX/产品文档/竞品/ADHD证据/增长案例)。
本文档面向产品与增长。引用的代码路径是 2026-06 时的抽查结果。 -->
# Shiori 栞 · 破圈增长 PM 研究文档（2026-06）

> **2026-09-23 注：** 定位、JTBD、竞品空位、增长打法与指标（§1–2、§5–6）仍是有效的产品判断。
> 原 §3 代码摩擦点、§7 风险清单与「本双周行动清单」是 6 月的时点快照，已删除——现行优先级见 `HANDOFF.md`。

## TL;DR

- **定位**：免费、本地、约 26 MB，批注永不丢的 PDF 工具
- **空位**：批注往返 + 反订阅 + 隐私，三者无人同时占据
- **打法**：先攻研究者/程序员小圈，72 小时集中引爆
- **北极星**：周下载 + Web 打开数（无 cookie 统计）

---

## 🎯 1. 一句话定位 + 用户画像 JTBD

**一句话**：Shiori 栞 —— 约 26 MB、秒开、永不上传的免费 PDF 阅读·批注·导出工具，**你的高亮在 Acrobat / Preview / Chrome 里都打得开**。

三个画像的 jobs-to-be-done：

| 画像 | 当我…（场景） | 我想要…（任务） | 免得…（替代品之痛） | 击中卖点 | 主渠道 |
|---|---|---|---|---|---|
| 👨‍💻 程序员 | 要快速看/签/改一个 PDF | 秒开、无账号、键盘可达、离线 | 忍受 Acrobat 臃肿订阅（~$240/年）或 sioyek/Zathura 没批注 | 约 26 MB 安装包；断网可用 = 隐私证明 | HN、v2ex、GitHub |
| 🎓 技术群体（研究者/学生/数码爱好者） | 精读论文、教材、技术书 | 批注跨软件保留、自动续读、中日文导出不变豆腐 | Preview 吞批注、Zotero 批注锁在数据库导出还丢 | /Annot 真往返；CJK 字形导出；续读记忆 | 少数派、即刻、Zotero 社区 |
| 🙋 普通用户 | 要给 PDF 签名/高亮/合并 | 免费、不注册、不上传，2 分钟完成 | Smallpdf/Acrobat 收费墙、ChatPDF 类要上传云端 | 拖进网页就能用；中文母语级界面 | 小红书、bilibili |

**关键认知**：三个人群买的是同一个产品的**三种语言**——程序员买承诺与架构，技术群体买工作流，普通用户买任务结果（详见 §5）。

---

## ⚔️ 2. 竞品差距表 & 可吃下的空位

| 竞品 | 模式/价格 | 致命痛点（带来源） | Shiori 的对位 |
|---|---|---|---|
| Adobe Acrobat | 订阅 ~$240/年，AI 另收费 | 臃肿卡顿、2026 连续涨价、强推云端（[redresscompliance](https://redresscompliance.com/adobe-price-increase-2026-impact)） | 免费 + 约 26 MB + 本地 |
| PDF Expert | $79.99/年；"终身版"仅限 Mac | 转订阅 + 强制注册引发 MacRumors 反弹（[链接](https://forums.macrumors.com/threads/pdf-expert-switching-to-subscription-model-forces-account-creation-even-if-paid-v2-customer.2350184/)） | 无账号、全平台同一代码 |
| Apple Preview | 免费内置 | **出名地损毁批注**：高亮重开消失、注释跨软件变空泡（[eclecticlight](https://eclecticlight.co/2020/04/07/how-preview-mangles-annotations/)） | 标准 /Annot 往返 |
| UPDF / ChatPDF | $59 终身 / ~$5/月 | AI 必须把 PDF 上传到云端（[updf.com/privacy-policy](https://updf.com/privacy-policy/)、[scispace](https://scispace.com/resources/ai-pdf-chat-security-privacy/)） | 文件永不离机 |
| Foxit | ~$16.99/月 | 自己也臃肿了 + 试用升级弹窗轰炸（[pdfpro](https://pdfpro.com/blog/general/foxit-vs-adobe)） | 零弹窗零推销 |
| Stirling-PDF | 自托管开源 | 1.6 GB Docker、512 MB 闲置内存、要跑服务器（[HN 40242639](https://news.ycombinator.com/item?id=40242639)） | 浏览器/约 26 MB 客户端即用 |
| sioyek / Zathura | 免费 OSS | 批注存本地 DB 需手动嵌入 / 完全无批注；仅极客（[HN 31691769](https://news.ycombinator.com/item?id=31691769)） | 键盘流 + GUI 批注兼得 |
| Okular | 免费 OSS | Windows 版 400+ MB KDE 依赖（[accuratereviews](https://www.accuratereviews.com/pdf-reader-software-software-reviews-list/okular/)） | 跨平台一等公民 |
| Zotero 阅读器 | 免费 | 批注锁库内，导出有丢失 bug（[官方论坛 2025-02](https://forums.zotero.org/discussion/121962/how-to-export-pdf-with-annotations)） | 批注写进 PDF 本体 |
| 浏览器内置 | 免费 | 只读不编，批注子集、无连续性（[pdfa.org](https://pdfa.org/browsers-battle-over-pdf-capabilities/)） | Web 版直接升维 |

**Shiori 可吃下的空位（按杠杆排序）**：

1. **「你的高亮能活下来」**——周边所有免费工具都吞/锁批注，Shiori 的标准往返是唯一可演示的硬差异（GAP 1）
2. **反订阅、零推销**——Acrobat 涨价潮的现成接盘者（GAP 2）
3. **本地优先 = 可证伪承诺**——断网照常用，对打所有 AI-PDF SaaS（GAP 3）
4. **约 26 MB vs 全行业臃肿**——"小但能编辑"是无人区（GAP 4）
5. **程序员/普通人分裂市场的桥**——键盘流 + 干净 GUI 没有直接对手（GAP 6）

---

## 🧠 4. ADHD-friendly 功能提案（映射证据强度）

**证据等级**：强 = 元分析/重复对照实验 ｜ 标准 = W3C 规范/共识 ｜ 中 = 多项研究 ｜ 弱 = 临床共识 ｜ 无效 = 实测无作用

| 提案 | 证据（强度） | 来源 | 优先级 | 工作量 | 人群 | 状态 |
|---|---|---|---|---|---|---|
| TTS 朗读 + **当前句画布同步高亮** | 元分析 22 研究 n=2,942，d=0.35（**强**） | [Springer 2025](https://link.springer.com/article/10.1007/s11145-025-10738-5) | P1 | L | 全员 | 朗读本体「已在计划：L3」；同步高亮为新增范围 |
| **阅读尺 Line Focus**（遮罩 1/3/5 行，按页记忆） | Immersive Reader 同类 +10% 理解（**中**） | [Microsoft](https://learn.microsoft.com/en-us/training/educator-center/product-guides/immersive-reader/research) | P1 | M | 技术群体/学生 | 新提案 |
| **honor prefers-reduced-motion**，禁一切循环动画 | WCAG 2.3.3（**标准**） | [W3C](https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions.html) | P1 | S | 全员 | 新提案（a11y 批次未含） |
| **记住上次导出设置 + 一键"重复上次导出"** | WCAG 2.2 SC 3.3.7 冗余输入（**标准**） | [W3C](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/) | P1 | S | 全员 | 新提案 |
| 大纲栏 **分章节进度刻度**（"本章还剩 n 页"） | COGA 分块 + ADHD 奖赏折扣（**标准+中**） | [COGA](https://www.w3.org/TR/coga-usable/design_guide.html) | P2 | M | 技术群体 | 新提案 |
| **累计型阅读统计，永不清零、绝不做 streak** | 即时反馈留存 +48%；streak 对 ADHD 反噬（**中**） | [helloklarity](https://www.helloklarity.com/post/breaking-the-chain-why-streak-features-fail-adhd-users-and-how-to-design-better-alternatives/) | P2 | M | 全员 | 新提案 |
| 弹性专注会话（可调 15–60min，**永不锁文档**） | 小样本正向，固定番茄会切断超专注（**弱–中**） | [audhdpsychiatry](https://www.audhdpsychiatry.co.uk/insights/does-pomodoro-really-work-for-adhd/) | P2 | M | 技术群体 | 新提案 |
| 时间盲视角落计时环（默认关） | OT/临床共识，无 RCT（**弱**） | [timetimer](https://www.timetimer.com/blogs/news/time-blindness) | P2 | S | 技术群体 | 新提案 |
| Bionic Reading | Readwise n=2,074 实测 -2.6wpm；眼动 n=53 无差异（**无效**） | [Readwise](https://blog.readwise.io/bionic-reading-results/) | **不做** | — | — | 明确拒绝，省下即赚 |

**已有即资产**：续读记忆、双层自动保存、阅读模式（⌘\）——这三项**已是 COGA「零摩擦重入/永不丢数据」的实现**，应直接进营销文案而非再开发。

---

## 📣 5. 增长 / 发布打法

### 5.1 一套产品，两种语言

| 人群 | 框架 | 话术示例 | 案例依据 |
|---|---|---|---|
| 程序员/技术 | 承诺 + 架构 + 退路 | "本地优先，文件**永远**不上传——这是承诺不是功能" | Bruno "no cloud-sync ever" 被用户逐字引用（[usebruno.com](https://www.usebruno.com/)）；Obsidian "file over app"（[stephango.com/vault](https://stephango.com/vault)） |
| 普通用户 | 任务结果 + 零门槛 | "我做了一个免费小工具：PDF 签名/高亮，不上传不注册" | 小红书独立开发更新贴 2 天 11 万浏览；TinyWow 月 240 万访问全靠"真免费无账号"（[nologin.tools](https://nologin.tools/blog/tinywow-review-free-tools-no-signup/)） |

### 5.2 渠道与节奏

| 渠道 | 动作 | 案例 | 优先级/量/人群 |
|---|---|---|---|
| **Show HN** | 周一发；谦逊标题 + 60s demo；全天泡评论区 | sioyek 同一产品 **5 次上首页**（[27893303](https://news.ycombinator.com/item?id=27893303)、[42440024](https://news.ycombinator.com/item?id=42440024)）；机制见 [markepear](https://www.markepear.dev/blog/dev-tool-hacker-news-launch) | P0 / M / 程序员 |
| **v2ex 分享创造 + 少数派投稿 + 小众软件自荐** | 与 HN 同 72h 窗口发，叙事＝"数据不出本机" | AFFiNE 72h 千星即靠多渠道同窗引爆（[知乎复盘](https://zhuanlan.zhihu.com/p/651626890)）；渠道数据见 [1000UserGuide](https://github.com/naxiaoduo/1000UserGuide) | P0 / S / 技术群体 |
| **对比页常备**（vs Acrobat / PDF Expert / Smallpdf） | 现在就建，等对手涨价日同步发帖 | Bruno 在 Postman 砍免费版当月星数 25k→44k，因对比页早已就位（[github.com/usebruno/bruno](https://github.com/usebruno/bruno)） | P0 / M / 全员 |
| **「批注往返」测试矩阵 demo** | Shiori→Acrobat/Preview/Chrome 打开实录，钉死 GAP 1 | Preview 吞批注是可复现公案（[eclecticlight](https://eclecticlight.co/2020/04/07/how-preview-mangles-annotations/)） | P0 / S / 全员 |
| **Product Hunt** | HN 之后第二波，复用素材 | AFFiNE 当日 #2 作为二级脉冲 | P1 / S / 技术群体 |
| **小红书 / bilibili** | "免费小工具"框架，单任务短视频 | 见 5.1；前置条件：移动端导出对话框适配 | P1 / M / 普通用户 |
| **Obsidian / Raycast / Zotero 插件** | "用 Shiori 批注此 PDF" 入口 | obsidian-excalidraw 单人项目 530 万下载（[obsidianstats](https://www.obsidianstats.com/plugins/obsidian-excalidraw-plugin)） | P2 / L / 技术群体 |

### 5.3 三条纪律

- **深耕 2–3 个渠道，拒绝撒网**：laike9m 实测 20 渠道广撒 ≈ 零转化，2 个深耕渠道贡献几乎全部（[复盘](https://laike9m.com/blog/tui-yan-du-li-kai-fa-chan-pin-wo-zuo-liao-na-xie-chang-shi,159/)）
- **Web 版就是漏斗**：拖入 shiori.nagi.fun 2 秒内进入编辑，先给价值再给下载——Excalidraw 制胜点（[HN 29109995](https://news.ycombinator.com/item?id=29109995)）

---

## 🧭 6. 北极星指标 + 先行指标

**硬约束**：应用永久零遥测——唯一合规测量是官网无 cookie 计数（「已在计划：L14」）+ SEO 预渲染（「已在计划：L13」）。

| 类型 | 指标 | 定义 | 为什么 |
|---|---|---|---|
| ⭐ 北极星 | **周获取量** = 官网下载数 + Web 版打开会话数 | L14 无 cookie 计数 | 零遥测下最接近"被使用"的合法代理 |
| 先行 1 | 渠道帖互动量 | HN 分数 / v2ex 回复 / 小红书收藏，每波发布记录 | 叙事是否击中，48h 内可读 |
| 先行 2 | 落地页 → 下载转化率 | 对比页/首页 UV 到下载的比率 | 检验"两种语言"文案有效性 |
| 先行 3 | Featurebase 周新增反馈数 | 现有 Feedback 入口 | 唯一来自真实使用深度的信号 |
