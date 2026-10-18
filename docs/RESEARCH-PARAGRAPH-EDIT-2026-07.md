# 段落级 PDF 原文编辑调研（2026-07）

本文面向 Shiori 的下一步“Edit original text”能力：从任意 sub-line 选择改为 paragraph/block 级编辑单元。背景假设：

- Shiori 仍以 `pdf.js getTextContent()` 做可见文本/几何提取。
- Shiori 已有 content-stream glyph removal pass：覆盖的源 glyph 必须真实删除，且 fail-closed。
- Shiori 已有同字体 re-encoder：通过 `/ToUnicode` inversion 尝试回写源 subset font。
- v1 目标更接近 Acrobat / PDF Expert / Foxit 的 “Edit Text” 局部 text box，而不是 Word 式全文档重排。

短结论：

- PDF 没有天然 paragraph；成熟工具都用几何启发式把字符合成 word/line/block。
- 商业 PDF editor 默认编辑的是局部 text box / paragraph box；文本在 box 内 reflow，不自动推动页面其他内容。
- Shiori v1 应先做“检测段落框 -> 删除源段落 glyph -> 在原框内重排重画”。不要尝试跨段落 push、复杂脚本 shaping、数学公式、vertical/CJK justification。

## 1. Paragraph / block detection from extracted text runs

### Findings

PDF extraction 的共同前提是：PDF 内容流只描述 glyph 的绘制位置，不提供 word、line、paragraph 的语义结构。成熟工具的做法基本一致：

1. char/glyph/run -> line：按 baseline / bbox vertical overlap / horizontal gap 聚合。
2. line -> text box / paragraph：按 vertical gap、x-overlap、indent、font/style continuity 聚合。
3. text boxes -> reading order：按 column/article/flow 做排序或层次合并。

各工具的核心信号：

- **PDFBox `PDFTextStripper`**
  - 默认 `indentThreshold = 2.0`，`dropThreshold = 2.5`。
  - 空格判断用 `spacingTolerance = 0.5` 与 `averageCharTolerance = 0.3`：word gap 取 word spacing 和 average char width 两套估计中的较小值。
  - paragraph separation 看：
    - 首行；
    - baseline drop 是否超过 `dropThreshold * maxHeightForLine`；
    - indent 是否超过 `indentThreshold * widthOfSpace`；
    - 当前行向左回退是否超过约 `widthOfSpace`；
    - list item pattern，例如 bullet、`1.`、`[1]`、`1)`、`A.`、`a.`、roman numerals。
  - 默认按 PDF article/thread beads 分栏；没有 beads 时就退回几何排序。

- **pdfminer.six `LAParams`**
  - 默认参数：`line_overlap = 0.5`，`char_margin = 2.0`，`word_margin = 0.1`，`line_margin = 0.5`，`boxes_flow = 0.5`，`detect_vertical = False`。
  - char -> line：
    - 两个字符 horizontal distance `< char_margin * max(char widths)`。
    - vertical overlap `> line_overlap * min(char heights)`。
  - word insertion：
    - 同一 line 内字符距离 `> word_margin * char width` 时插入空格。
    - `word_margin` 必须小于 `char_margin`，否则不会形成可读 word。
  - line -> text box：
    - line bbox 需要 horizontal overlap。
    - line 间 top/bottom gap `< line_margin * line height`。
  - text box ordering：
    - `boxes_flow = -1.0` 更重视 horizontal position。
    - `boxes_flow = +1.0` 更重视 vertical position。
    - `boxes_flow = None` 禁用高级 layout，按 box bottom-left 排序。

- **pdfplumber**
  - 继承 pdfminer 思路，但暴露了更实用的 char/word API。
  - `extract_text(x_tolerance=3, y_tolerance=3)`：`next.x0 - prev.x1 > 3pt` 插入空格；`doctop` gap `> 3pt` 插入换行。
  - 可用 `x_tolerance_ratio` 让 gap threshold 随上一字符字号变化。
  - `extract_words(..., extra_attrs=["fontname", "size"])` 可强制 word 内 font/size 相同。
  - `use_text_flow=True` 会跟随 PDF content stream flow，更像鼠标选中文本顺序，但可能不符合视觉阅读顺序。
  - table extraction 默认 tolerances 多为 `3pt`，并可用 word alignment 推导隐形表格线；这对段落编辑很重要，因为 table cell 不应被误并入正文段落。

- **MuPDF structured text (`fz_stext`, `mutool draw -F stext`)**
  - 直接输出 block / line / span / char 层级。
  - options 包含 `paragraph-break`、`dehyphenate`、`preserve-spans`、`preserve-whitespace`、`collect-styles`、`structured`、`segment`、`table-hunt`。
  - `StructuredText.walk()` 的 char callback 暴露 `utf`、origin、font、size、quad、color、flags。
  - 如果不启用 `preserve-spans`，mid-line style changes 可能不会按 span 暴露。

- **Poppler `pdftotext`**
  - `-layout` 保持物理布局。
  - `-bbox-layout` 输出额外 layout bbox hierarchy；本机 Poppler 26.04.0 输出含 `flow -> block -> line -> word`。
  - `-raw` 保留 content stream order。
  - `-colspacing <fp>`：判断相邻文本是否属于新列的 spacing threshold，默认 `0.7 * font size`；旧版本默认 `0.3`。

### Concrete algorithm for Shiori v1

输入：`pdf.js getTextContent()` items，加上 Shiori 已能从 content stream 追踪到的 source font / glyph style metadata。所有几何先归一到 PDF user space。

#### 1. Normalize visible runs

对每个 `TextItem` 生成 `VisibleTextRun`：

- `text`
- `x0/x1/y0/y1`
- `baselineY`
- `fontName` / source font key
- `fontSizePt`
- `widthPt`
- `hasEOL`
- `dir`
- optional: color、rise、char spacing、word spacing、horizontal scale

v1 直接排除：

- rotated page / non-horizontal text；
- `dir === "ttb"` 或 pdf.js style `vertical`；
- glyph bbox 异常、缺 baseline、缺 source font mapping；
- whitespace-only item；
- 明显 OCR invisible layer 或 zero-height text。

#### 2. Run -> line

排序：先按 visual top-to-bottom，再按 x。实际实现建议按 baseline clustering：

- 同一 line 条件：
  - `abs(run.baselineY - line.baselineY) <= max(1.5pt, 0.25 * medianFontSize)`；或
  - bbox vertical overlap `>= 0.5 * min(runHeight, lineHeight)`。
- 同一 line 内 gap 分类：
  - `gap <= max(1pt, 0.30 * fontSize)`：同 word / run 续接。
  - `0.30 * fontSize < gap <= 0.60 * fontSize`：word gap / 插入普通 space。
  - `gap > 0.60 * fontSize`：tab、column break、table cell gap 或大缩进候选。
  - 如果能拿到 source `widthOfSpace`，用 PDFBox 风格阈值：`wordGapThreshold = min(0.5 * widthOfSpace, 0.3 * averageCharWidth)`，再叠加字号比例 fallback。

不要把 `hasEOL` 当成 paragraph break；它只能作为 line break 证据之一。

#### 3. Line -> paragraph block

对每个候选 line 计算：

- `lineLeft = min(x0)`，`lineRight = max(x1)`，`lineWidth`
- `baselineY`
- `fontSizeMedian`
- `dominantFont`
- `lineHeight` / source pitch
- `wordCount`
- `firstNonWhitespaceX`
- `styleChangeScore`

把相邻 line 合并为同 paragraph 的建议条件：

- vertical pitch：
  - `baselineGap` 在 `[0.75, 1.45] * medianPitch` 内；
  - 如果还没有 reliable pitch，用 `baselineGap <= 1.6 * max(fontSizeMedian)`；
  - `baselineGap > max(2.0 * fontSize, 1.5 * medianPitch)` 强制断段。
- horizontal relation：
  - line x-range 与上一行 x-range overlap `>= 0.35 * min(lineWidthA, lineWidthB)`；
  - 或同属一个 column band；
  - 不跨越 table cell 大 gap。
- indent：
  - `abs(lineLeft - blockLeft) <= max(1.5pt, 0.25 * avgCharWidth)`：普通续行。
  - `lineLeft - blockLeft` 在 `1.0-4.0 * widthOfSpace`：first-line indent 候选，只允许出现在 paragraph 第一行。
  - 后续行相对第一行向右，且第一行有 list marker：hanging indent 候选。
  - 参考 PDFBox：indent break 以 `2.0 * widthOfSpace` 为强信号。
- style continuity：
  - dominant font family 相同或兼容；
  - median font size change `<= 20%`。
  - 单行字号大 `> 1.25 * bodyMedian` 且上下 gap 偏大：heading，不并入正文。

断段强信号：

- line 是 heading：字号、weight、上下空白都明显不同。
- line 是 footnote：字号 `< 0.8 * bodyMedian`，且 y 位于页面底部区域。
- line x-range 落在不同 column cluster。
- line 有大量 symbol/math font，或 baseline rise 分布异常。
- table/cell alignment 明显：同一 y 附近存在多个 separated x clusters。
- list marker 模式变更：`1.` -> `2.` 可以合并为 list block，但不应和前后正文合并。

#### 4. Column detection

v1 不需要完整 document layout，但 paragraph hit-testing 必须避免跨列。建议：

- 在页面内按 line 的 `lineLeft` / `lineRight` 做简单 column band clustering。
- 若两行 vertical 相邻但 horizontal overlap `< 0.2 * min(widths)`，不要合并。
- 对 gap `> 0.7 * fontSize` 的相邻 text cluster 标记为 column/table separation 候选，参考 Poppler `-colspacing` 默认值。
- 如果存在 PDF article/thread beads，可作为强分栏信号；现实 PDF 很多没有。

### Known failure cases

- **Multi-column**：没有 beads、列间距小、跨页脚/图注时最容易错序。
- **Lists**：marker 与正文可能被拆成不同 runs；hanging indent 容易被误判成新 paragraph。
- **Headings**：单行 heading 和后续正文 bbox 可能 overlap，但 style / gap 应断开。
- **Footnotes / headers / footers**：字号小、位置规律，但视觉上接近正文尾部。
- **Tables**：line alignment 很像 paragraph；必须通过多 x cluster、垂直/水平 ruling、重复 cell gap 排除。
- **Math / symbol fonts**：baseline rise、symbol font、inline equation 会破坏 word gap 和 style continuity。
- **CJK**：无空格，word gap heuristic 不适用；line break 和 justification 要单独处理。
- **RTL / complex scripts**：pdf.js `dir` 可提示，但 paragraph reflow 需要 shaping engine；v1 应 punt。
- **OCR layer**：bbox 可能粗糙，文本顺序可能按 OCR engine 输出，不等于视觉段落。
- **Ligatures / ActualText**：可见 glyph 和 semantic text length 不一致，影响 edit offset 映射。

### Sources

- PDFBox `PDFTextStripper` source: <https://github.com/apache/pdfbox/blob/trunk/pdfbox/src/main/java/org/apache/pdfbox/text/PDFTextStripper.java>
- pdfminer.six layout analysis: <https://pdfminersix.readthedocs.io/en/latest/topic/converting_pdf_to_text.html>
- pdfminer.six `LAParams`: <https://pdfminersix.readthedocs.io/en/latest/reference/composable.html>
- pdfplumber README / API notes: <https://github.com/jsvine/pdfplumber>
- MuPDF structured text options: <https://mupdf.readthedocs.io/en/latest/reference/common/stext-options.html>
- MuPDF `StructuredText`: <https://mupdf.readthedocs.io/en/latest/reference/javascript/types/StructuredText.html>
- `mutool draw -F stext`: <https://mupdf.readthedocs.io/en/latest/tools/mutool-draw.html>
- Poppler project / `pdftotext`: <https://poppler.freedesktop.org/>；本机 `pdftotext -h` verified Poppler 26.04.0 options.

### 对 Shiori 的启示

- 不要从 `TextItem` 直接猜 paragraph；先建立 line model。
- Shiori 已有 `sourceBaselinesPt` / `sourceLinePitchPt` 的方向是对的：paragraph grouping 应以 source baseline/pitch 为主，而不是 DOM rect。
- v1 hit-test 应返回“可编辑 paragraph block”或“不可安全编辑”，不要返回半行。
- 参数必须可调并可记录 debug overlay：line clusters、paragraph blocks、column bands、rejection reason。

## 2. Commercial editors: scope and reflow

### Findings

商业 PDF editor 的公开文档几乎不讲内部算法，但行为模式很一致：

- 用户点击文本后，编辑的是一个 **text box / paragraph-like object**。
- 文本增长时，优先在 box 内 reflow。
- resize box 会改变 reflow width/height，但 font size 通常不自动改变。
- 默认不把后面的 PDF content 往下推；PDF 页面是绘图对象集合，不是流式文档。
- 如果需要跨多个 box 连续编辑，工具会提供 explicit linking/joining，而不是自动跨全文档 flow。

具体观察：

- **Acrobat**
  - Edit > Text 后选中 text box，出现 bounding box handles。
  - resize text box 时，文本在 box 内 reflow，font size 不变。
  - formatting 面板公开支持：font、size、color、bold、italic、underline、superscript/subscript、left/center/right/justify、line spacing、paragraph spacing after、character spacing、horizontal scaling、bulleted/numbered lists。
  - 这说明它的 edit model 至少保留了 paragraph-level text box、alignment、spacing、style spans。

- **Foxit PDF Editor**
  - TechRadar review 描述：PDF 被拆成多个 text boxes；box 可选中、移动、resize；box 内文本在修改尺寸或内容时自动 reflow。
  - 主体内容通常被拆成多个 boxes；文字不会自动从一个 box flow 到下一个 box。
  - Foxit 的 `Link & Join Text` 是显式把多个 boxes 连接起来，之后才能跨 box 连续写。
  - formatting 支持 font、size、color、alignment、bold/italic/underline/strike、character/line/paragraph spacing、character scale。

- **PDF Expert**
  - 官方 how-to 只说明：进入 Edit mode，选择一段 text 后编辑，点击空白处保存。
  - 它强调 PDF 本身不是为编辑设计，scanned PDF 需要 OCR。
  - 未找到公开 paragraph grouping / reflow algorithm。

- **PDFgear**
  - 官方页面称 desktop app 支持 direct text editing、保留 original formatting、可改 font 和 size。
  - 同页明确 online editor 的 text editing 只支持 add text boxes；desktop direct editing 与 online text boxes 是不同能力。
  - 对 scanned/image PDF：官方说明可以 OCR 转 Word/Excel/PPT/TXT；直接转 editable PDF 仍在 development。

- **SDKs: Apryse/PDFTron、PSPDFKit/Nutrient**
  - 公共资料主要是产品/API 层能力描述；没有找到可复用的 paragraph detection 或 reflow 参数。
  - 结论上只能把它们视为黑盒：SDK 能编辑 page content，但具体 grouping/reflow 仍需 Shiori 自己实现或通过商业 SDK 授权使用。

### How they handle specific cases

- **Text grows**
  - 常见行为：box 内 reflow；box 可手动 resize。
  - 不默认 push 下方图形/段落。
  - 开源 PyMuPDF redaction replacement 的 behavior 更硬：fit 不下就缩小字号到下限，仍不行就不插入。这印证“局部 box 内 fit”是主模型。

- **Justified text**
  - Acrobat / Foxit UI 都暴露 justify。
  - PDF 层通常通过 word spacing (`Tw`)、character spacing (`Tc`) 或 `TJ` 数组调整实现。
  - 现实中 mixed fonts、CID fonts、CJK justification 会更复杂；商业工具可能有私有 layout engine。

- **Hyphenated line ends**
  - MuPDF structured text 提供 `dehyphenate` option，说明 extraction/reflow 端会显式处理 source line-end hyphenation。
  - 编辑器体验上更合理的是把 source soft hyphenation 还原为连续 word，再按新 width rewrap。
  - 不应盲删所有 `-`：硬连字符、范围号、负号、ISBN、compound words 都要保留。

- **Mixed bold/italic runs**
  - Acrobat/Foxit 暴露 rich text formatting，说明其 edit model 不是纯 paragraph-wide style。
  - 但 v1 可降级：保留 dominant style，只有未改动 substring 尽量保留原 style spans。

- **Inline math / symbol fonts**
  - 商业工具一般可选中和移动，但真正“重排数学公式”不是普通 text edit。
  - 对 Shiori，math-heavy line 应默认不进入 paragraph edit，或只允许整段替换为 fallback font text。

- **Embedded subset font 缺字**
  - 商业工具通常会 fallback 到系统/内置 font，或替换成相近字体。
  - 对 Shiori，同字体 re-encoder 应继续做 first choice；缺 glyph 时要明确降级为 embedded fallback font，而不是 silent corrupt。

### Sources

- Acrobat adjust text boxes: <https://helpx.adobe.com/acrobat/desktop/edit-documents/edit-text-in-pdfs/adjust-text-boxes.html>
- Acrobat format text: <https://helpx.adobe.com/acrobat/desktop/edit-documents/edit-text-in-pdfs/format-text.html>
- Acrobat edit lists: <https://helpx.adobe.com/acrobat/desktop/edit-documents/edit-text-in-pdfs/edit-lists.html>
- PDF Expert how-to: <https://pdfexpert.com/how-to-edit-pdf>
- PDFgear editor page: <https://www.pdfgear.com/pdf-editor-reader/>
- Foxit behavior, secondary review source: <https://www.techradar.com/reviews/foxit-pdf-editor-12>
- PyMuPDF page/shape docs for open-source fit behavior: <https://pymupdf.readthedocs.io/en/latest/page.html>, <https://pymupdf.readthedocs.io/en/latest/shape.html>

### 对 Shiori 的启示

- Product contract should be explicit: “edit this detected paragraph box”, not “edit the PDF like Word”.
- Text growth should not push surrounding content in v1.
- If text exceeds original paragraph box, UI should show overflow/overlap state and let the user resize or accept local overlap.
- Cross-box linking, list renumbering, and full document reflow should be future work.

## 3. Minimal re-layout algorithm

### Findings

Open-source libraries do not offer a drop-in “edit existing paragraph in-place” solution for the Shiori stack. Useful references are:

- PyMuPDF `Shape.insert_textbox()`:
  - fills a rectangle with lines/words;
  - supports align left/center/right/justify;
  - returns unused vertical space if fit succeeds, negative deficit if fit fails;
  - justify support is limited for simple fonts.
- PyMuPDF `Page.add_redact_annot()` replacement:
  - after redaction, replacement text is inserted via `insert_textbox`;
  - if text is too large, it tries decreasing font size down to a floor around `4pt`; if still no fit, nothing is inserted.
- PyMuPDF `insert_htmlbox()`:
  - uses a Story/HTML layout path;
  - line breaks at word boundaries;
  - supports soft hyphen `&shy;`;
  - returns `(spare_height, scale)` and can fail if content does not fit.
- OCRmyPDF:
  - creates invisible text layers aligned to OCR boxes; this is not visible paragraph editing.
  - Its docs warn that some rendered text layers are poor for editing and may interact badly with PDF.js / Preview text segmentation. Good cautionary evidence, not a v1 algorithm.

### Concrete v1 layout model

#### Paragraph block

```ts
type EditableParagraphBlock = {
  pageIndex: number;
  rect: PdfRect;              // source paragraph visual bounds, in PDF user space
  lines: SourceLine[];
  text: string;               // dehyphenated logical text for edit UI
  styleRuns: ParagraphStyleRun[];
  dominantStyle: ParagraphStyle;
  align: "left" | "center" | "right" | "justify";
  firstLineIndentPt: number;
  hangingIndentPt: number;
  linePitchPt: number;
  sourceHyphenation: SourceHyphenationMark[];
  confidence: "high" | "medium" | "reject";
};
```

#### Alignment detection

Use robust statistics and ignore pathological lines:

- Define `blockLeft` as median/min of non-short line left edges.
- Define `blockRight` as median/max of non-short line right edges.
- Exclude:
  - last line of paragraph;
  - lines with `lineWidth < 0.65 * medianLineWidth`;
  - list marker-only fragments.

Rules:

- **Left**
  - `MAD(lineLeft) <= 2pt` or `<= 0.01 * blockWidth`;
  - right edges vary `> 3pt`.
- **Right**
  - `MAD(lineRight) <= 2pt`;
  - left edges vary `> 3pt`.
- **Center**
  - `MAD(lineCenter) <= 2pt`;
  - both left and right edges vary.
- **Justify**
  - at least 2 interior lines have:
    - `abs(lineLeft - blockLeft) <= max(2pt, 0.02 * blockWidth)`;
    - `abs(lineRight - blockRight) <= max(2pt, 0.02 * blockWidth)`;
  - final line is shorter: `lastLineWidth < 0.90 * blockWidth`;
  - interior word gaps have elevated mean or variance compared with natural space width.
- **Fallback**
  - ambiguous cases default to left.

Do not classify a one-line paragraph as justify.

#### Dehyphenation

Source paragraph text for editing should remove line-break artifacts only when safe:

- If line ends with soft hyphen (`U+00AD`) or MuPDF-style dehyphenation signal: remove it.
- If visible line ends with `-` and next line starts lowercase / same word continuation, mark as candidate.
- Keep hard hyphen when:
  - previous/next token is numeric (`2024-2026`, `ISBN-...`);
  - next line starts uppercase;
  - hyphen is surrounded by spaces;
  - the source character is not at line end;
  - dictionary check is unavailable and confidence is low.

v1 recommendation：只自动删除 high-confidence line-end hyphenation；其余保留。

#### Greedy line breaking

Input is edited logical text plus style spans.

Algorithm:

1. Split on explicit user newline. Existing source line breaks become spaces unless marked as hard paragraph/list break.
2. Tokenize into words and spaces. For CJK, v1 can treat each grapheme cluster as break opportunity only if CJK support is explicitly enabled; otherwise reject/left as single line fallback.
3. For each output line:
   - width limit = `blockWidth - indentForLine`。
   - measure candidate tokens with source-font metrics if all chars encodable。
   - if token does not fit:
     - break before token if current line non-empty；
     - if single token exceeds width，v1 should show overflow/fail rather than arbitrary glyph scaling。
4. line height:
   - default `linePitchPt = median(sourceBaselineGap)`；
   - fallback `1.2 * dominantFontSizePt`；
   - preserve original line pitch if source paragraph has stable pitch.
5. vertical origin:
   - first baseline = source first baseline；
   - subsequent baselines = previous baseline - `linePitchPt` in PDF user space。

#### Re-justification

For each output line:

- Natural width = sum glyph advances + source char spacing / horizontal scale effects.
- Left/center/right:
  - x = blockLeft + indent
  - center: x += `(availableWidth - naturalWidth) / 2`
  - right: x += `availableWidth - naturalWidth`
- Justify:
  - apply only to non-final visual line in a paragraph;
  - require at least 2 word spaces;
  - `extra = availableWidth - naturalWidth`;
  - if `0 <= extra <= 0.25 * fontSize * numberOfSpaces`, set `Tw = extra / numberOfSpaces`;
  - if per-space extra is too high, left-align that line instead of producing huge rivers.

Important PDF detail:

- `Tw` only affects space character in text showing. With CID/CJK or no literal spaces, use `TJ` position adjustments or punt.
- Mixed fonts inside one line can make global `Tw` insufficient. v1 can emit separate runs but should avoid per-run `Tw` conflicts by keeping justification only for simple single-style lines.
- Reset `Tw` / `Tc` / `Tz` / `Ts` at the start/end of inserted paragraph text object so later PDF content is not contaminated.

#### Fit / overflow policy

Best v1 behavior:

- Delete source glyphs only inside the original detected paragraph block.
- Draw edited paragraph from the original first baseline.
- Do not push other page content.
- If output lines exceed original block height:
  - show overflow in UI;
  - export should either:
    - allow local overlap if user accepts; or
    - fail with “text does not fit” until user resizes the edit box.
- Do not silently shrink font size in v1. Shrinking changes fidelity and is hard to explain.

### Sources

- PyMuPDF `Page.add_redact_annot`, `Page.insert_htmlbox`, `Page.add_freetext_annot`: <https://pymupdf.readthedocs.io/en/latest/page.html>
- PyMuPDF `Shape.insert_textbox`: <https://pymupdf.readthedocs.io/en/latest/shape.html>
- OCRmyPDF advanced features / text layer notes: <https://ocrmypdf.readthedocs.io/en/latest/advanced.html>
- MuPDF structured text dehyphenation option: <https://mupdf.readthedocs.io/en/latest/reference/common/stext-options.html>

### 对 Shiori 的启示

- v1 可以完全不引入 heavyweight layout engine；一个 deterministic greedy breaker 足够。
- Justification detection/export 要分层：
  - detect justify；
  - simple Latin single-style paragraph 用 `Tw`；
  - mixed/CJK/complex cases降级 left/原 alignment 或 reject。
- Hyphenation 应作为 paragraph extraction 阶段的 metadata，而不是在用户保存时猜。
- Fit failure 是正常编辑状态，不是异常：UI 应把它显示出来。

## 4. Per-run style model

### Findings

能 round-trip 的最小 style model 需要覆盖 PDF text state，而不仅是 `fontName + size`。原因：

- Acrobat/Foxit 都公开 character spacing、horizontal scaling、line spacing、super/subscript。
- PDFBox/pdfminer/pdfplumber/MuPDF 都把 font、size、position 当作 layout 的核心信号。
- pdf.js `styles` 字典不包含 fill color、char spacing、word spacing、horizontal scale、text rise、rendering mode；这些必须来自 content stream text-state tracking。

### Minimal style record

建议 Shiori v1 内部保存：

```ts
type ParagraphStyleRun = {
  start: number; // text offset; UI 可用 grapheme index，serialization 可用 UTF-16 offset
  end: number;

  sourceFontKey: string;       // PDF resource key / indirect ref, not only pdf.js fontName
  pdfjsFontName: string;
  fontSizePt: number;

  fillColor?: {
    space: "DeviceGray" | "DeviceRGB" | "DeviceCMYK" | "Pattern" | "Other";
    values: number[];
    alpha?: number;
  };

  textRisePt?: number;         // Ts, superscript/subscript
  charSpacingPt?: number;      // Tc
  wordSpacingPt?: number;      // Tw
  horizontalScalePct?: number; // Tz
  renderMode?: number;         // Tr; v1 supports fill text only

  baselineY?: number;
  lineIndex?: number;
  dir?: "ltr" | "rtl" | "ttb";

  sourceEncoderId?: string;    // ToUnicode inversion / encoding path
  canEncodeOriginalText?: boolean;
  flags?: {
    bold?: boolean;
    italic?: boolean;
    syntheticBold?: boolean;
    underline?: boolean;
    strike?: boolean;
    symbolLike?: boolean;
  };
};
```

Line-level record:

```ts
type SourceLine = {
  textStart: number;
  textEnd: number;
  x0: number;
  x1: number;
  baselineY: number;
  fontSizeMedianPt: number;
  pitchToNextPt?: number;
  dominantStyleKey: string;
  isLastLineInParagraph: boolean;
};
```

Paragraph-level style:

- `dominantStyleKey` by character count, not by run count。
- `linePitchPt` from median source baseline gaps。
- `firstLineIndentPt` / `hangingIndentPt`。
- `alignment`。
- `sourceHyphenation` marks。

### Mapping edited text back to styles

v1 如果使用 plain textarea，没有 rich text style UI。仍有三种可用策略：

1. **Dominant style strategy**
   - 保存时整段用 dominant style。
   - 最简单、最稳定。
   - 适合先验证 paragraph detection + reflow + source removal。

2. **LCS/diff style preservation**
   - 对原 paragraph text 与 edited text 做 diff。
   - 未改动 ranges 继承原 style runs。
   - 插入字符：
     - 在 run 内：继承左侧字符 style；
     - 在 run boundary：优先继承左侧非 whitespace style，否则右侧；
     - 替换 range：继承被替换 range 的第一个主 style；
     - paragraph 末尾追加：继承前一字符 style。
   - 这是 v1.5 的合理升级。

3. **Rich spans UI**
   - contenteditable 或 ProseMirror-like rich text model。
   - 可显式 bold/italic/color，但复杂度明显高。
   - 不建议 v1。

### Missing glyph / subset font policy

Shiori 现有 same-font re-encoder 应继续是首选：

- 若 edited text 所有字符都能通过 source font encoding 写回：使用 source font。
- 若只有少数字符缺失：
  - v1 最安全：整段 fallback 到 bundled embedded font，保留字号/颜色/alignment。
  - 更精细但更复杂：只对缺字 spans fallback；需要 mixed-font measuring 和 line breaking。
- 不允许 silent substitution 到 viewer/system font；PDF 必须 embed fallback font。
- 如果 source font 是 symbol/math font，不要把普通 Unicode 文本写回该 font。

### Sources

- Acrobat formatting options: <https://helpx.adobe.com/acrobat/desktop/edit-documents/edit-text-in-pdfs/format-text.html>
- pdfplumber char properties and `extra_attrs`: <https://github.com/jsvine/pdfplumber>
- MuPDF `StructuredText` char/style callbacks: <https://mupdf.readthedocs.io/en/latest/reference/javascript/types/StructuredText.html>
- PDFBox text state and paragraph heuristics source: <https://github.com/apache/pdfbox/blob/trunk/pdfbox/src/main/java/org/apache/pdfbox/text/PDFTextStripper.java>

### 对 Shiori 的启示

- `pdf.js styles[fontName]` 不能作为 export style source of truth。
- 段落编辑需要一个 source text-state capture layer：font ref、size、color、Tc/Tw/Tz/Ts、baseline。
- v1 可以用 dominant style，配合明确的 fallback font indicator；不要假装保留了所有 mixed styling。
- Style preservation 应由 text diff 驱动，不应按新 line break 重新猜。

## 5. Pitfalls specific to Shiori / pdf.js / pdf-lib

### pdf.js `getTextContent()` quirks

- `TextItem` 是 layout extraction artifact，不是 word/run/paragraph。
  - 可能 mid-word split。
  - 也可能把多个 glyph 合成一个 string。
  - `hasEOL` 是 pdf.js 的 line-flow heuristic，不是 hard paragraph marker。
- Public API surface:
  - `items`
  - `styles`
  - `TextItem.str`
  - `dir`
  - `transform`
  - `width`
  - `height`
  - `fontName`
  - `hasEOL`
  - `getTextContent({ includeMarkedContent, disableNormalization })`
- 当前 pdf.js worker 内部 spacing constants（从本 repo `node_modules/pdfjs-dist` 读取）：
  - `TRACKING_SPACE_FACTOR = 0.102`
  - `SPACE_IN_FLOW_MIN_FACTOR = 0.102`
  - `SPACE_IN_FLOW_MAX_FACTOR = 0.6`
  - `VERTICAL_SHIFT_RATIO = 0.25`
  - 这些解释了为什么 pdf.js 有时插入 fake spaces / flush text item / 设置 `hasEOL`。
- `styles[fontName]` 通常只有 fallback family、ascent/descent、vertical 等 viewer 信息；不是 PDF source font resource。
- `includeMarkedContent: true` 会让 marked content / ActualText 参与 extraction。ActualText 适合 semantic selection/search，不一定适合 visible glyph deletion/rewrite。
- `disableNormalization` 默认 false 时，ligature / Unicode normalization 可能改变 string length；offset 映射到 source glyph 时要小心。

### pdf-lib writing pitfalls

- `pdf-lib` 很适合写 PDF operators 和嵌入 font，但不是完整 content-stream parser/rewrite engine。
- high-level `page.drawText()` 不足以表达：
  - source font re-encoding；
  - per-run `Tc/Tw/Tz/Ts/Tr`；
  - `TJ` spacing；
  - mixed style paragraph；
  - precise cleanup/reset of text state。
- 段落重画建议用 lower-level operators：
  - begin/end text object；
  - set font；
  - set fill color；
  - set character spacing / word spacing / horizontal scaling / text rise；
  - show text / `TJ`；
  - reset state。
- 删除源 glyph 与插入新 paragraph 应是两个清晰阶段：
  - 先 fail-closed 删除 paragraph block 内所有 source glyph；
  - 再 append 新 text drawing；
  - 验证 `getTextContent()` 和 pixel diff。

### Stack-specific failure cases

- 当前 Shiori text selection 已对 rotation / vertical text 保守；paragraph v1 应沿用这个边界。
- 如果 paragraph block 检测错，把两列合成一段，glyph removal 会真实删除大量内容；所以低 confidence 必须 reject。
- 如果 source text uses `TJ` kerning / custom spacing，简单 `drawText` 会造成文字宽度漂移；layout measurement 必须考虑 source width metrics。
- 如果 source line 有 mixed rise（上标/下标），paragraph baseline pitch 不能直接由 bbox 高度推断。
- CJK justification 和 no-space scripts 不能用 `Tw`；需要 glyph spacing / `TJ` 或专门排版。
- Arabic/Indic/Thai 等 complex scripts 需要 shaping；`pdf-lib` 字体宽度测量不等于 shaped glyph sequence。
- OCR invisible text layer 可能被当成可编辑文本；应检测 render mode / opacity / bbox mismatch。
- Page crop/rotation 坐标必须统一到 PDF user space；不要把 DOM pixel rect 当 source-of-truth。

### Sources

- PDF.js API docs: <https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html>
- PDF.js text extraction implementation reference: <https://github.com/mozilla/pdf.js/blob/master/src/core/evaluator.js>
- pdfminer warning about lack of PDF paragraph/word semantics: <https://pdfminersix.readthedocs.io/en/latest/topic/converting_pdf_to_text.html>
- OCRmyPDF text layer caveats: <https://ocrmypdf.readthedocs.io/en/latest/advanced.html>
- Prior Shiori plans:
  - `docs/PLAN-PARAGRAPH-CONTENT-TEXT-2026-07.md`
  - `docs/PLAN-CONTENT-STREAM-TEXT-REMOVAL-2026-07.md`

### 对 Shiori 的启示

- pdf.js is good enough to seed paragraph candidates, but not enough to export safely.
- Paragraph edit export must depend on Shiori's content-stream text-state/glyph mapping, not only `getTextContent()`.
- Use confidence gates aggressively. A false negative is acceptable; a false positive deletes real content.
- Debuggability is product-critical: show why a paragraph is editable or rejected.

## Recommended v1 scope

### Build first

1. **Paragraph detection pipeline**
   - Convert pdf.js items + source glyph metadata into line records.
   - Cluster lines into paragraph blocks using baseline gap, x-overlap, indent, style continuity, and column bands.
   - Attach confidence and rejection reasons.

2. **Paragraph edit UX**
   - Click text -> select whole detected paragraph block.
   - Show one editable box over the paragraph.
   - Plain textarea is acceptable for v1.
   - Preserve source line breaks only as visual hints; edit text is logical paragraph text.

3. **Conservative export**
   - Remove all source glyphs inside the paragraph block using existing fail-closed removal.
   - Reflow edited text inside the original block width with greedy line breaking.
   - Use dominant source style first.
   - Use same-font encoder only when all edited chars are encodable.
   - If not encodable, embed fallback font for the whole paragraph and mark style fidelity downgrade internally.

4. **Alignment**
   - Detect left/center/right/justify.
   - Implement left/center/right first.
   - Implement justify only for simple Latin, single-style, space-separated paragraphs using `Tw`; otherwise downgrade or reject.

5. **Validation**
   - After export, run pdf.js extraction to confirm old paragraph text is gone and new text exists.
   - Pixel-diff only the edited block plus small padding.
   - Add fixture PDFs for:
     - single-column left-aligned body;
     - justified body;
     - first-line indent;
     - hanging list;
     - two-column article;
     - heading/body boundary;
     - mixed bold/italic word;
     - subset font missing glyph.

### Explicitly punt

- Full-page / cross-paragraph reflow.
- Automatically pushing surrounding content.
- Cross-text-box linking like Foxit's `Link & Join Text`.
- Rich text editing UI.
- List renumbering.
- Table cell editing.
- Math formula editing.
- Vertical text.
- Rotated/skewed text.
- RTL and complex-script shaping.
- CJK justification.
- Automatic font matching beyond source font or bundled fallback.
- Editing OCR invisible layers as if they were real visible text.

### Suggested v1 thresholds

Start with these defaults, expose in debug config:

- same-line baseline tolerance: `max(1.5pt, 0.25 * medianFontSize)`
- same-line vertical overlap: `>= 0.5 * minHeight`
- word gap:
  - source space known: `min(0.5 * widthOfSpace, 0.3 * avgCharWidth)`
  - fallback same-word upper bound: `0.30 * fontSize`
  - in-flow space upper bound: `0.60 * fontSize`
- paragraph pitch continuation: `[0.75, 1.45] * medianPitch`
- paragraph hard vertical break: `> max(2.0 * fontSize, 1.5 * medianPitch)`
- x-overlap for paragraph continuation: `>= 0.35 * min(lineWidthA, lineWidthB)`
- column/table gap candidate: `> 0.70 * fontSize`
- heading font-size break: `> 1.25 * bodyMedian`
- style size continuity: `<= 20%` median font-size change
- align edge stability: `MAD <= 2pt` or `<= 0.01 * blockWidth`
- justify edge tolerance: `max(2pt, 0.02 * blockWidth)`
- short/last-line exclusion for alignment: line width `< 0.65 * medianLineWidth`
- justify final-line check: final line `< 0.90 * blockWidth`
- justify per-space extra cap: `<= 0.25 * fontSize`

### Final recommendation

Shiori should ship paragraph editing as a conservative, local box editor:

- detect only high-confidence paragraph blocks;
- remove exactly that paragraph's source glyphs;
- reinsert edited text with deterministic local reflow;
- never silently modify neighboring content;
- make unsupported paragraphs visibly non-editable instead of trying to be clever.

This matches the public behavior of Acrobat/Foxit-style PDF editing while staying compatible with Shiori's existing fail-closed removal and source-font re-encoding architecture.
