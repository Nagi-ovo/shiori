# 整段原文编辑（paragraph contentText）设计 — 2026-07

状态：**已实现**（`f6ab5b85`、`2be7e9b7`、`0607bc16`、`eac3b4d5`）。落地形态与下文「模型（v1）」草案不同：
扩展了 `ContentTextOverlay`（`sourceBaselinesPt`、`firstLineIndentPt`、
`align: left|center|right`），没有 `granularity` 字段，两端对齐（justify）未实现——
以代码为准。附录第 5 条 fsType 嵌入许可原则只记在这里，仍然有效。
原状态：已定稿。调研依据：
`docs/RESEARCH-PARAGRAPH-EDIT-2026-07.md`（2026-07-07，含
PDFBox/pdfminer/MuPDF 实际参数、商业编辑器行为观察、v1 阈值表）。

## 为什么换方案

子行级选区编辑（现 `ContentTextOverlay`）在 2026-07-06/07 连修七个几何
bug 后仍在出新的：行中起点缩进、混合字体投票失效（LaTeX 数学字体）、
粗体/正文混排宽度节奏、跨行选择的框对齐、选中着色遮挡……每个修复都在
给"任意子行矩形集合"这个模型打补丁。根因是模型粒度错了：**PDF 里视觉
稳定的排版单位是段落块，不是任意字符区间**。PDF Expert / Acrobat 的
Edit Text 都以段落为编辑单位，不是巧合。

已有的地基（保留复用）：
- 真删管线 `src/pdf/export/contentStreamEdit/`（tokenizer → textState →
  removeGlyphs → redactCoveredText），删整段字形 = 删一组行矩形，零改动。
- 同字体重写 `sourceFontEncoder.ts`（/ToUnicode 反解），段落内单字体时
  整段可用原字体重排。
- 精确基线/行距捕获（`sourceBaselinesPt`、`sourceLinePitchPt`）。
- 吸收合并、覆盖导出回落路径。

## 交互（v1）

- text 工具下，点击或拖选 → 高亮**整个段落块**（不再是字符区间），
  双击/回车进入编辑：textarea 覆盖整块，预填整段文本。
- 段内任意改动（含增删行）；提交后整段替换。
- 旧的子行编辑 overlay 继续被渲染/导出（legacy），新建一律走整段。

## 模型（v1）

新形态放进 `ContentTextOverlay`（加 `granularity: "paragraph"` 判别）或
新 overlay type —— 待定，倾向前者（导出/草稿/撤销管线全部复用）：

```
paragraph 编辑需要的字段：
  blockRect: PdfRect            // 段落块（编辑框 = 它）
  lines: Array<{                // 源行，top-first
    baselineY: number           // 精确基线（已有能力）
    startXPt: number            // 行起始 x（含首行缩进）
    widthPt: number             // 行宽（对齐检测/重排宽度用）
    text: string
  }>
  styleRuns?: Array<{           // v1 先按"段落主样式 + 例外 run 标记"
    start: number; end: number  // 相对整段文本的偏移
    bold?: boolean; italic?: boolean
    fontSizePt?: number; color?: string
  }>
  align: "left" | "justify" | "center" | "right"   // 从源行几何检测
  pitchPt: number               // 行距（中位数，已有 sourceLinePitchPt）
```

## 导出（v1）

1. 删除：coverRects = 全部源行矩形 → 现有 redact 管线原样跑。
2. 重排：greedy line breaking 到 `blockRect.w`，行距 `pitchPt`，首行
   缩进保留；行数超出源行数向下延伸（v1 允许溢出块底，不推挤后续内容）。
3. 写回：单字体且全部可编码 → 同字体路径；否则内置字体路径。
   对齐 v1 只做 left（justify 靠 Tw 调字间距，进 v2）。

## 明确不做（v1）

- 跨段落 reflow / 推挤页面其他内容。
- 段内逐 run 富文本编辑 UI（textarea 纯文本；styleRuns 只用于导出重绘）。
- 多栏、表格、列表项的特殊处理（检测失败时回落整块=选区包围盒）。
- 竖排/RTL。

## 调研结论落地（详见 RESEARCH 文档，此处只记决策）

- **段落检测**：run→line→block 三级聚合，信号 = 基线差、x 重叠、缩进、
  字号/样式连续性。v1 阈值采用调研的推荐表（同行基线容差
  `max(1.5pt, 0.25×中位字号)`、段落 pitch 连续带 `[0.75, 1.45]×中位
  pitch`、标题断点 `字号 > 1.25×正文中位` 等，全表见 RESEARCH 末节），
  参数放 debug config 可调。**只编辑高置信度块**——检测不自信的区域
  显式不可编辑，而不是猜。
- **溢出行为**（商业工具共识）：框内 reflow、不推挤周围内容；超出
  原框底时 UI 显示溢出状态，用户自行接受局部重叠。不缩字号。
- **justify**：检测做（左右缘 MAD ≤ 2pt 判定），v1 重排只实现
  left/center/right；justify 仅对"单样式、空格分词的拉丁文"用 Tw 实现，
  否则降级 left。
- **连字符**：源行尾 soft hyphen 还原为连续词再重排（MuPDF
  dehyphenate 同款）；硬连字符/负号/区间号保留。
- **数学/符号字体行**：默认整块不可编辑（检测到 math 字体 run 即拒绝），
  这直接消掉"LaTeX 字体失效"类 bug。
- **缺字**：同字体优先，缺 glyph 整段降级内置字体并内部标记降级，
  绝不静默混排。
- **导出后验证**：pdf.js 重提取确认旧段落文字消失、新文字存在
  （调研建议的 validation 步骤，接进现有导出完整性检查）。

## 迁移与回滚

- 数据模型只增不改：旧 overlay 字段全部保留，legacy 渲染路径不动。
- v1 若翻车，text 工具退回子行模式只是一个开关（交互层分叉点单一）。

---

## 附：字体保真阶梯（2026-07-07 全部落地）

商业编辑器的分层实践，Shiori 的对应实现：

1. **内嵌字体优先**（Acrobat/PDF Expert 同款）：屏上 = pdf.js FontFace
   前置（`ContentTextOverlay.sourceFontName` ↔ session 级
   `store.pdfFontFaces`，g_* 槽位名绝不持久化）；导出 = 主字体投票 +
   ToUnicode 反解逐字符校验（既有）。
2. **度量兼容替身**：Liberation Serif/Sans/Mono 随包（SIL OFL），
   contentText 专用栈 `contentFontFamilyCss` 与导出回退的 Standard-14
   逐字形同宽，跨平台行宽确定。
3. **缺字/溢出可见化**：编辑态琥珀徽标；屏上缺字用"文档已见字符集"
   启发式（`store.pdfFontChars`），精确 oracle 在导出侧。
4. **永不整页重排**（原则）：只重排被编辑的段落，页面其余字节不动。
5. **fsType 嵌入许可**（原则）：当前不重嵌字体故无风险；未来若做
   "从原字体文件补子集缺字"，必须先读 OS/2 fsType 嵌入位，禁止对
   restricted-license 字体做衍生嵌入。
6. 暂缓：在线字体匹配下载（Google Fonts 同族替身）——授权 + 工程成本
   高，等真实需求。
