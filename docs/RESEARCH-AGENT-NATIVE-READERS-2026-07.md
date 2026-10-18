# 调研 · AI-Native 阅读器赛道与我们的缺口（2026-07-29）

> 触发：P2/P4 闭环首次真机跑通后，想确认这是不是最佳实践、有没有别人在做同样的事。
> 状态：**桌面调研 + 一次真机观察**。没有做用户访谈、没有装竞品实测，
> 结论的可信度见文末「这份调研还缺什么」。

---

## 一句话结论

**没有人在做「agent 的回答写回文档本身」这件事。** 现有工具全都把 PDF 当成
只读输入，答案落在聊天框里。我们的差异点是真的；但我们在**库规模**上是零，
而那正是 Zotero 生态已经赢下的地方。

---

## 赛道现状（四类）

| 类别 | 代表 | 做法 | 与我们的关系 |
|---|---|---|---|
| 聊天侧栏 | ChatPDF / PDF.ai / SciSpace / Denser / UPDF / Adobe Acrobat AI | 云端，右侧聊天框问文档 | **已明确否掉**（见 PLAN-agent-native「明确否掉的方向」） |
| 文献库 + MCP | `zotero-agent`（47 个 MCP 工具）、`zotero-research-assistant`（32 个）、Beaver 插件 | 把**整个文献库**暴露给 agent；能力**以读为主**（检索、元数据、综述） | **我们完全没有**；对应未开工的 P1 工作区 |
| 纯阅读器 | Sioyek | 键盘流、为论文优化，无 AI；其标注与其他阅读器**互不兼容** | 我们在标注兼容性上更强（标准 PDF 注释 + `/IRT`） |
| PDF MCP server | `pdf-reader-mcp`（Rust、local-first、「给 agent 一双眼睛」）、`pymupdf4llm-mcp` | 把 PDF 内容喂给 agent | **全是读侧**，没有写回 |

### 调研中最值钱的一句

检索结论原文（关于 PDF 相关 MCP 生态）：

> 现有方案「专注于**读取、提取和标注** PDF，而不是把带高亮和引线批注的标注
> **真正写回 PDF 文件**这一完整能力」。

即：**读侧已经很拥挤，写回侧基本空着。**

### 唯一形态相近的

MarkUp（Chrome 扩展）：给网页加引线批注，再经 MCP 发给 Claude / Cursor。
形态相近（标注即输入），但方向单一（网页 → 编码 agent），不是阅读器，
也不把回答写回原文。

---

## 我们独有的（差异点，成立）

- **回答是文档的一部分，不是聊天记录。** agent 用 `calloutReply` 写回同一条
  引线批注，导出后是标准 PDF 评论线程（`/IRT`），Acrobat 原生显示。
- **锚定跟着文本走。** `OverlayCommon.anchor` 持久化，配合文本锚定重解析，
  文档重排后引用不失效——聊天记录里的引用做不到。
- **被 agent 接入，而不是接入 agent。** CLI + skill，Codex / Claude Code /
  任何会跑 shell 的 agent 都能用，不绑单一厂商。

## 我们落后的（要认）

- **库规模 = 0。** 竞品能跨几百篇检索、去重、做综述；我们连多文件工作区都
  还没做（2026-07-29 时 P1 只做了 P1e 切换器 + P1d 前置修复；之后工作区树、
  pin、多文件夹已落地，见 `PLAN-agent-native.md` 状态行）。
- **移动端与 web 没有实时闭环。**（`liveAnnotationBridge: IS_TAURI_DESKTOP`）
- **没有语义检索**，只有精确/模糊文本匹配。

---

## 这份调研还缺什么（不要把上面当定论）

1. **没有实测任何竞品。** 上述对 Zotero 插件 / SciSpace / UPDF 的描述来自
   检索摘要与项目自述，没有装过、没验证过实际体验与写回能力。
   **尤其要亲自确认**：`zotero-agent` 的「annotation synthesis」到底是
   生成综述文本，还是真的写回标注——如果是后者，我们的差异点要重新评估。
2. **没有用户访谈。** 「读者想让答案留在页面上」目前是产品直觉 + 一次自用
   验证，不是需求证据。
3. **没查学术/法律/合规垂直领域的专用工具**（如合同审阅、专利分析），
   那些领域可能已有「标注即回答」的形态。
4. **MCP 生态变化快。** 本次检索只覆盖到 2026-07；MCP tool annotations
   等规范仍在演进，半年后需复查。

---

## 参考来源

- AI PDF 阅读器综述：<https://denser.ai/blog/best-ai-pdf-reader/>
- Zotero AI agent 框架：<https://github.com/psiQAQ/zotero-agent>
- Zotero AI 插件概览：<https://citationstyler.com/en/knowledge/ai-plugins-for-zotero/>
- Sioyek / Zotero 集成讨论：<https://github.com/ahrm/sioyek/discussions/363>
- PDF MCP server（local-first Rust）：<https://github.com/SylphxAI/pdf-reader-mcp>
- pymupdf4llm-mcp：<https://artifex.com/blog/pymupdf4llm-mcp-enhancing-llm-agents-with-high-quality-pdf-context>
- Paperpile 与 agent 工具集成方向：<https://paperpile.com/blog/pdf-ai-assistant/>
