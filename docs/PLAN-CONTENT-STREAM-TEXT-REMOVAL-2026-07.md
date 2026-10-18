# 原文编辑：从「盖白重绘」到「删旧字形」的路线（2026-07-06 调研定稿）

> **状态（2026-09-23 核对）：A、B 两期均已落地**（`3b696964`、`dcc657af`；B 的条件
> 真替换在 `src/pdf/export/contentStreamEdit/sourceFontEncoder.ts`）。仍未做：
> Form XObject 内文字的遍历（`redactCoveredText.ts` 的 follow-up 引用本文为规格）、
> `/ActualText` 清理。下文「为什么不做全面真替换」的取舍理由只记在这里。

背景：contentText 导出目前是 cover rect 盖白 + 重绘新字，**原 show-text 算子仍留在
content stream 里**——搜索、复制、屏幕阅读器读到的还是旧文字。本调研评估两条路：
(A) 导出时删除被覆盖的字形绘制（= redaction 的文本移除半边）；(B) 条件性原地真替换。
结论：**A 立项、分期做；B 只作为 A 之上的严格条件优化；全面真替换不做**。

调研来源：网络调研（qpdf/pikepdf、PDFBox、MuPDF、pdfcpu、HexaPDF、iText
pdfSweep、pdf-lib/pdfjs 生态、Adobe 文档）+ 本仓 pdf-lib 能力勘察。

## 为什么不做全面真替换

1. **字体子集缺字是硬墙。** 内嵌字体几乎都是子集，只含文档用过的字形；写新字符
   要求它在 font program、Encoding/CMap、ToUnicode、宽度表里全部可表示，缺任何
   一环都写不出。给现有 subset 补字形 = 重写字体程序，不做。
2. **PDF 不回流。** 邻近文字绝对定位，替换变长/变短一样露馅；Acrobat 也靠字体
   替代 + 拉伸压缩硬扛（Adobe 文档确认）。
3. TS 生态没有成熟的 content-stream 重写库（pdf-lib 无算子级 parser，pdfjs 的
   operator list 不保留原始 token 映射，npm 提取类包都不做重写）——必须自建，
   所以范围要窄。

## 第一期（A）：glyph removal pass

**目标**：导出时，被 contentText 覆盖的字形不再出现在文本层——搜索/复制/朗读
只见新文字。**明确非目标**：不是合规脱敏（metadata、附件、结构树、隐藏层不管），
不承诺"安全 redaction"。

**架构**（PDFBox `RemoveAllText` + MuPDF redact filter 为蓝本）：

1. **工具链用 pdf-lib 现成零件**（已勘察，均公开导出）：`decodePDFRawStream`
   解码、`PDFObjectParser` 解析操作数、`PDFOperator` + `PDFContentStream`
   重序列化、对象图读写 + full save。自建的只有两层：
   - **算子分词器**：把字节流切成（操作数…, 算子）序列；数字/名字/字符串/hex
     字符串/数组/字典/注释/inline image。注意 qpdf 坑：`/Contents` 为数组时
     流可能在 token 中间断开，**必须先 coalesce 再解析**。
   - **文字状态机**：`q/Q/cm/BT/ET/Tf/Tm/Td/TD/T*/Tc/Tw/Tz/TL/Ts/Tr/Tj/TJ/'/"`，
     glyph bbox 经 TRM×CTM 变换后与 cover rect 相交判定（MuPDF 做法；零宽
     diacritic 用 valid-rect 兜底）。
2. **逐字形删，不是删整条 Tj/TJ**：命中的 glyph 从 show 串里去掉，但**推进量
   必须保留**——转成等效 TJ numeric adjustment，否则同一 text object 后面的
   文字整体左移。
3. **宽度查询**：simple font 走 `/FirstChar` + `/Widths`；CID/Type0 走
   descendant 的 `/W` + `/DW`（竖排 `/W2`/`/DW2`，第一期直接跳过竖排）。
   宽度都在 PDF 字典里，不需要解析字体程序。
4. **Form XObject**：递归处理；共享 XObject **先 copy-on-write** 再改（多页
   复用同一 XObject 时原地改会误伤别页）。第一期跳过 Type3 / tiling pattern，
   命中即整页 fallback。
5. **安全边界（不可妥协）**：任何解析失败、不认识的算子组合、几何存疑 →
   **该页放弃删除，维持现状纯覆盖导出**。宁可留旧文字也不产坏页。导出走
   full rewrite（本来就是），不用增量保存。
6. **残留注意**：`/ActualText`、MCID/StructTree 里可能还有旧文字符串——第一期
   在命中的 marked-content 序列上顺手清 `/ActualText`，结构树不动（记入已知
   限制）。

**验证**（三层，fixture 全套）：
- `pdfjs getTextContent()` 前后对照：旧文字消失、新文字在、**未命中文字一字不差**。
- 渲染像素 diff：编辑区域外零漂移。
- fixture 覆盖：`Tj`、`TJ` 带 kerning、split `/Contents` 数组、rotated/cropbox
  页、CID 中文、共享 Form XObject、`/ActualText`、零宽 diacritic、Type3
  （断言 fallback 生效）。

## 第二期（B）：条件真替换（已落地）

仅当**全部**满足才启用：simple LTR、同字体、目标字符已在子集且可反查编码、宽度
可得、无 shaping 需求。宽度差用 TJ 微调吸收，超阈值或缺字 → 回落「删旧 + 重绘」。
永不给现有 subset 补字形。

## 与现有代码的衔接

- 入口在 `exportPdf.ts` 的 `drawContentTextEditsForPage`（逐字重绘仍是 `drawContentText`）：先跑 removal pass，成功则 cover
  rect 可以只留背景色修补（甚至试点去掉盖白），失败走现状。
- 命中区域直接用 `coverRects`（page space），与 2026-07-06 基线修复共用坐标语义。
- 新模块建议 `src/pdf/export/contentStreamEdit/`（tokenizer / textState /
  glyphWidths / removeGlyphs 分文件），全部纯函数 + 单测。

## 工作量估计

第一期是本项目迄今最大的导出侧子系统（tokenizer + 状态机 + 宽度表 + COW +
fixture 集），估 2–3 个专注 session；建议 tokenizer/状态机先行、带完整单测落地，
再接 exportPdf。
