# 事故复盘

诚实、简短地记录那些真实耗费时间才诊断出的 bug。
每条的结构：症状 → 根因 → 修法 → 能让它更早暴露的那一件事。
与 `CHANGELOG.md` 交叉引用。

---

## 2026-09-25 · 沙箱里 `tauri build` 签名失败：「A timestamp was expected but was not found」

**症状。** 编译完成，打包阶段给 `Frameworks/libpdfium.dylib` 签名时失败，重试不变；
`curl http://timestamp.apple.com/ts01` 却能通。

**根因。** Developer ID 签名要向 Apple 时间戳服务器取时间戳。命令沙箱允许 `curl`
联网，却挡住了 `codesign` 走的那条系统网络路径，`codesign` 只报「没拿到时间戳」。
同一条 `codesign --force --timestamp` 关掉沙箱立即成功。

**修法。** 签名打包在沙箱外跑（本机终端，或给 `codesign` 加放行规则）；代码无需改动。

**更早暴露。** 看到这句报错先在沙箱外单独签一个临时 dylib，一分钟就能分清是环境还是代码。

---

## 2026-09-13 · `/cli` 写了 Pages Function，但 `_routes.json` 没把它列入 include

**症状。** `curl -fsSL https://shiori.nagi.fun/cli | sh` 会把官网 `index.html`
喂给 shell。`-f` 救不了：SPA fallback 是 200。

**根因。** Cloudflare Pages 这个项目关了 function 自动发现，只跑
`site/public/_routes.json` 的 include。当时只有 `/download/*` 和 `/api/*`。
`functions/cli.ts` 编进了 worker，请求却进不了 worker。

**修法。** include 加上 `/cli`，并用测试锁住这份名单。tag 上传走
`cli-release.yml`。

**同一天的第二跳。** Windows 那条一开始是 `npx`，后来换成
`irm https://shiori.nagi.fun/cli.ps1 | iex`。注意 `/cli.ps1` 跟 `/cli`
的修法正好相反：它是静态资源，**不能**进 `_routes.json` 的 include，进了就同样
落进 SPA fallback。它需要的是 `site/public/_headers` 里一条
`Content-Type: text/plain`——`.ps1` 不在任何静态主机的 mime 表里，默认
`application/octet-stream`，PowerShell 的 `irm` 对它会返回 byte[]，`iex`
执行不了。两条路由两种错法，别把其中一种的修法套到另一种上。

**更早暴露。** 任何新的 Pages Function 先改 `_routes.json`，再写 handler。
本地 Vite middleware 会掩盖这条生产路由。

## 2026-09-08 · 26.9.8 上 PDF 滚成一片空白：为省一帧视觉瑕疵，给 `syncRange` 加了一道会卡死的门

**症状。** 26.9.8 装到安卓真机上，打开 11 页的 PDF，滚一会儿整个视口变成空白纸。
底部仍显示「第 04 / 11、76%」——滚动位置是对的，只是那一段没有任何页面挂载。

**根因。** 26.9.8 在 `Canvas.tsx` 的滚动处理里加了
`if (!gestureZoomingRef.current) syncRange()`。动机来自一次代码审计的建议：捏合期间
新挂载的页面没有预览 transform，会按基准比例画在放大的页面旁边一帧。那是一帧的
视觉瑕疵；这道门的代价是标志一旦卡住，滚动永远不再重算挂载范围。

标志会卡住，是因为触屏捏合**只在结束事件里提交**：`onPinchStart` / `onPinchMove`
都调 `markGestureZooming(null)`，而 `null` 的语义是「清掉定时器且不装新的」，所以
整条触屏路径没有任何兜底。结束事件则可能根本到不了——`attachTouchPinch` 当时挂在
scroller 上，而 touchend 投递给 touchstart 命中的那个节点，虚拟列表把它卸载之后事件
就到不了 scroller。这正是同日那条「幽灵手指」复盘的**投递侧**：我们修好了「以
`event.touches` 为准」的根因，却把 PDF 这条监听挂在了比 DOCX 更窄的节点上，于是换了
个方式复发。

**修法。** 三处。滚动永远 `syncRange()`（那一帧瑕疵不值得用白屏换）；捏合改用 3 秒
看门狗而不是无兜底；`attachTouchPinch` 挂到 window，`accepts` 继续把手势限制在文档
内——手指所在节点离开 DOM 后不再被 accept，捏合会自然结束而不是搁浅。

**能让它更早暴露的那一件事。** 两条。其一：给一个「快路径」加门之前，先问门卡住会
怎样；这道门的失败模式是整篇文档消失，而它换来的收益是一帧。其二，更根本的——
26.9.8 是在**零真机验收**下发的（`RELEASE-CHECKS.md` A0.8–A0.11 一项没做）。全部
「验证」是 Chrome DevTools 的安卓模拟，那是桌面 Chrome 改视口，既不是 Android
WebView，也没有事件投递给已卸载节点这种行为。这类 bug 在模拟里不可能出现。

## 2026-09-08 · Android 上 Word 文档越滚越宽直到 800%：Pointer Events 里滞留了一根"幽灵手指"

**症状。** 用户反馈 Android 上打开 .docx，往下翻的时候页面越来越宽，最后放大到字都
看不见。PDF 没有同样的报告，但"手感不对"。

**根因。** DOCX / PDF / Markdown 三个阅读器的双指捏合都是同一套写法：Pointer Events
自己维护 `activePointers`，pointerdown 加、pointerup / pointercancel 减，两根时开始
捏合。Android WebView 把一根手指的 pointerup 投递给 pointerdown 时的目标节点；Word
引擎在文字上 `setPointerCapture` 并重绘，那个节点已经不在 host 之下，抬起事件永远
到不了 host。列表里于是留下一根"幽灵手指"，之后每次单指上滑都成了两指：和幽灵的
距离随手指上移变大，每滑一次放大一截，直到 `DOCX_MAX_ZOOM = 8`。桌面浏览器复现：给
页面派一个永不结束的 touch 指针，再做一次单指上滑，页面宽从 1453 变 1453 × 3.7。

**修法。** `attachTouchPinch`（`documentViewerGestures.ts`）：改用 Touch Events，
以 `event.touches`——浏览器自己维护的"此刻在屏手指"列表——重建捏合状态，任何
事件都能自愈；三个阅读器共用。顺带把 touchmove 注册为非 passive，捏合时
`preventDefault` 能真正拦住浏览器的双指平移——pointermove 的 preventDefault 对滚动
无效，PDF 画布里"阻止捏合期间页面平移"的那行代码从来没起过作用。

**能让它更早暴露的那一件事。** 任何"自己数手指"的追踪器都要问：谁保证每根手指的
结束事件一定到我这？答不上来就该用平台给的在屏列表。测试层面：捏合测试之前只覆盖
Apple 的 gesture 事件流；给安卓路径回放"指针 + 触摸"混合序列的测试
（`DocxViewer.layout.test.tsx`）在旧代码上立刻红。

---

## 2026-09-08 · Android 底部 UI "有点错位"：原生 padding 留白 + `env()` 恒为 0 + AppCompat 再垫一遍

**症状。** Android 用户反馈底部界面错位。PDF 状态栏下方有一条颜色不对的空带；
DOCX / Markdown 标签底部直接压到手势条。

**根因。** 三件事叠加：

1. `MainActivity.applySystemBarInsets` 给 `android.R.id.content` 加原生 padding 留系统栏。
   留出的那条带子画的是 Activity 窗口底色（`Theme.MaterialComponents.DayNight` 的白 /
   夜间默认色），四套主题的状态栏色（`cream`）没有一个和它一样。
2. 前端为底部准备的安全区 CSS（状态栏 `calc(28px + var(--shiori-safe-bottom))`、抽屉、
   设置面板、阅读模式）在 Android 上全是 0：Android WebView 的
   `env(safe-area-inset-*)` 只报显示刘海，从不报状态栏 / 导航栏。`app.css` 的注释
   写着"Android gesture-bar insets"，前提本身是错的。
3. 监听器返回未消费的 insets。wry 通过 `AppCompatActivity.setContentView` 挂 WebView，
   AppCompat 的子 decor（`abc_screen_simple.xml`，根节点 `fitsSystemWindows="true"`，
   在 gradle 缓存里核实过）是那个 view 的子节点，对同一组 insets 再 padding 一次。

**修法。** WebView 铺满全屏（`enableEdgeToEdge` 的透明系统栏之下），原生侧只为键盘
缩视图；系统栏 inset 换算成 CSS px 推给页面（`shiori-android-safe-area` 事件），页面
启动时通过桥 `safeAreaInsets()` 拉一次；`installAndroidShellSync` 写进
`--shiori-safe-*`——和 iOS 用 env() 填的是同一组变量，状态栏、顶栏、阅读模式、抽屉
各自用自己的底色留位。监听器返回 `CONSUMED`。同一模块把页面 `color-scheme` 镜像到
系统栏图标明暗（`enableEdgeToEdge` 默认跟系统，Shiori 深色 + 系统浅色时图标看不见）。

**能让它更早暴露的那一件事。** 任何"在 X 平台 env() 会给值"的假设都要在那个平台的
WebView 上验一次，而不是照搬 iOS 的经验；本机没有 JDK / SDK，Kotlin 只有 CI 编译，
真机验收项在 `RELEASE-CHECKS.md` A0.8。

---

## 2026-09-08 · Android 检查更新一律 `release-check-failed-502`，桌面端正常：`/api/release` 匿名打 GitHub API，撞的是整个 CF 节点共享的 60 次/小时限额

**症状。** 用户反馈 Android 直装版（26.8.x 和 26.9.7 都是）点"检查更新"稳定报
`release-check-failed-502`，Windows / macOS 同期更新正常。从伦敦（LHR 节点）
`curl https://shiori.nagi.fun/api/release` 是 200，本地复现不了。

**根因。** 这个 502 是我们自己合成的：`site/functions/api/release.ts` 在
`getRecentReleases()` 返回空列表时回 `502 Upstream unavailable`，而
`_release.ts` 的 `fetchReleasesCached` 只要上游非 2xx 就返回空列表。上游是
`api.github.com`，请求**匿名**发出，走的是 Pages Function 所在 Cloudflare 节点的
出口 IP——那个 IP 和该节点上所有 Worker 共享，匿名限额 60 次/小时按 IP 计。繁忙节点
（服务国内用户的 HKG / SIN / NRT 一类）这个额度常年被别人用光，于是那里的冷缓存
**每次**都 403 → 空列表 → 502。桌面端 updater 读的是 `updates.shiori.nagi.fun/alpha/latest.json`
静态文件，根本不经过 GitHub API，所以桌面永远不会中招；Android 直装版是
`/api/release` 的唯一客户端，所以只有它坏、且两个版本一起坏、且和版本无关。

前一天 `2dd4f0c2` 已经在 `/api/downloads` 上撞过同一个坑（首页装机量偶发 502），
当时只给那一条路由加了"最后成功值"兜底，没有回头看同一个 helper 的另一个调用方。

**修法。** 两层：

1. **去掉匿名。** `_release.ts` 新增 `githubHeaders(token)`，`ctx.env.GITHUB_TOKEN`
   存在时带 `Authorization: Bearer`，请求走 token 自己的 5000 次/小时，和节点出口 IP
   无关。**token 是 Pages 项目上的 secret，代码里不存**：
   `wrangler pages secret put GITHUB_TOKEN --project-name shiori-promotion`，
   fine-grained PAT，只需 "Public repositories (read-only)"，不要任何额外权限。
   没设 secret 时代码退回匿名，行为同旧版。
2. **兜底统一。** `/api/release` 和 `/api/downloads` 的失败路径都走
   `upstreamFailureResponse()`：有最后成功值就 200 返回（带 `X-*-Stale: 1`），
   没有才 502；两种响应都带 `X-Upstream-Status`，下次线上出问题直接看响应头，
   不用再猜上游返回了什么。

**走过的弯路。** 本地 curl 200 差点把它当成用户网络问题。Cloudflare 的
`caches.default` 和出口 IP 都是**按节点**的，"我这里能用"对边缘函数几乎不构成证据；
要判断只能看响应头里带回来的上游状态——这也是为什么这次把 `X-Upstream-Status`
补到了每条失败响应上。

**教训 / 预防。**

- 边缘函数打第三方 API 一律带凭据。匿名配额是和整个节点共享的，等于随机失败。
- 一个 helper 的失败语义改了（"空列表 = 上游失败"），要 grep 它的**所有**调用方
  逐个看谁把空当成了 502 / 0 / 空页面。昨天只修了一个。
- 客户端只有一条更新路由的平台（Android 直装）出问题就是全平台事故，别按"只有一个
  用户反馈"的量级排期。
- 后续可选：让发版流程顺手往 `updates.shiori.nagi.fun` 写一份 `alpha/android.json`，
  Android 也读静态文件，彻底脱离 GitHub API。这次没做——先把 secret 设上。

## 2026-09-07 · 捏合缩放松手闪一下：换代式虚拟列表本身就是闪烁

**症状。** 缩放手势松手后画面"硬刷新"一下：高亮先出现、PDF 内容随后才画出来，位图先糊再清晰。用户以为是回退。基线并排对比（`22c736b7` 起在 1574 端口）证明基线同样闪，并不是当天的提交造成。

**根因。** `Canvas.tsx` 用 react-virtuoso 渲染页面列。Virtuoso 只在尺寸树为空时接受高度估计，所以每次 scale 变化都要给它换 `key` 重建一代：整列页面卸载，新一代空挂载约 15 帧，页面再逐个挂回。此前为掩盖这次替换叠了四层补丁：截图遮罩（veil）、初始位置种子、滚动守卫（吞掉 Virtuoso 的迟到 scrollTo）、锚点 refine，以及本轮先加后删的位图交接池。遮罩只截了画布像素，高亮层、文字层、页框都不在里面，撤下遮罩那一帧它们一齐重现——这就是闪。上一次交接池修掉的是"糊"，修不掉"换 DOM"。

**修法。** 页面尺寸本来就已知，改成按已知尺寸绝对定位的自有页面列（`pdfPageLayout.ts` 纯函数负责偏移、总高、可见范围、锚点 scrollTop、居中重映射）。缩放提交变成同一批已挂载页面换一套布局加一次 scrollTop 写入，在同一帧完成，再用真实页面矩形做一次残差校正。已挂载范围作为独立 state，relayout 的首帧只移动不卸载。四层补丁全部删除，`PageCanvas` 回到原有双缓冲。

**验证。** `Canvas.pageColumn.test.tsx` 渲染真实 `Canvas`，断言 scale 变化前后同一页面是同一个 DOM 元素且 scrollTop 落在算术目标；对旧实现是红的。用户在 Tauri dev 实机确认松手不再闪，dev 诊断日志 `commitApplied` / `rasterDone` 可复查时序。

**更早暴露的方法。** 用页面元素身份而不是像素来定义"闪"：一个换代式列表无论怎么遮罩，DOM 身份测试都会红。遮罩类补丁一旦叠到第二层就该回头问结构。

---

## 2026-09-07 · 扁平化高亮冲淡黑字：导出漏了正片叠底

**症状。** 同一个实际选区，应用中与可编辑 PDF 的黑字正常，扁平化导出后却变成棕灰色。

**根因。** 屏幕 SVG 与 Highlight 的批注外观使用 Multiply，扁平化 `drawHighlight` 仅设置透明度，默认 Normal 混合把高亮颜色混进黑字。同类问题也存在于 callout 的目标色块，包括它的可编辑外观。

**修法。** 给扁平化高亮、callout 目标矩形和 callout 的局部外观 graphics state 明确设置 Multiply。保持 graphics state 的 q/Q 作用域，批注标签、连接线和普通图形不受影响。

**验证。** 三条导出路径的回归在旧实现中均失败，修复后通过。用用户两份 PDF 中实际拖选生成的批注做扁平导出，再用 PyMuPDF 独立渲染，确认文字恢复原有深色，边界不变。

**更早暴露的方法。** 同一份有黑字的 PDF 同时导出可编辑与扁平版本，比较实际渲染，而不只检查 QuadPoints 和透明度数值。

---

## 2026-09-07 · PDF 选中与高亮越过相邻字：整行 DOM 宽度不能代表逐字位置

**症状。** 部分英文窄字、中文标点与大标题在拖选或保存后多盖住一截，缩小时极小字符甚至没有批注。

**根因。** 文本层用替代字体排版并整体伸缩；整行宽度吻合不代表每个字符都吻合。WebKit 下文本层继承界面的中文语言，PDF.js 的测量画布却使用 PDF 的语言或空语言，进一步放大字宽差。
旧实现丢弃 Range 的字符偏移，再给整行边界加 1.5–5px 留白、按手势修剪中文；保存时又把纵向重叠的不同字号/分栏统一到同一高度。2px 选区门槛及 0.75pt 合并容差也会吞掉窄字。

**修法。** 从已有 PDF.js operator list 读取字形 advance、Tc/Tw/TJ 和矩阵，按原始文字及位置严格对应 TextContent 的 UTF-16 偏移。兼容连字、插入空格、RTL 顺序和跨字体资源合并的链接；无法对应时保留逐 span 的原生选区回退。文本层语言与测量画布一致。鼠标命中、实时预览、工具拖选和浮动工具栏共用字形边界，保留原生 Selection 供复制、触摸和键盘使用。只合并上下边界一致的批注，不再扩大不同文字的色块。

**验证。** 恢复旧组件后，7 个浏览器边界回归全部失败；恢复修复后在 100%/200% 全通过。两份真实 PDF 共 67 页，1413 个非空文本段全部对应；用 PyMuPDF 独立核对 38,899 个非空白字形，最大基线/advance 端点差 <0.001pt。英文第 1/2 页、vocabulary.pdf 第 59 页实际正反拖选、跨行、浮动高亮与撤销，及导出后独立渲染均已检查。

**更早暴露的方法。** 用 PDF 写入引擎的明确字宽作 oracle，选择同一文本段的局部字符，并检查实时选区、存储和导出三处。只测整段框、只用默认语言或只在一个 PDF 引擎内部自证，都抓不到这个问题。

---

## 2026-09-07 · 保存了阅读页码，重新打开仍回第一页：列表初始化两次覆盖位置

**症状。** 重新打开 PDF 后显示第一页，尽管最近文档或工作区里已保存了后面的页码。
旧测试只覆盖页码选择与存储，没有走完虚拟列表的初始化。

**根因。** `Canvas.tsx` 中两条独立的初始化路径都会覆盖恢复位置：

1. 首次适应宽度先用预设容器宽度、再用实测宽度更新比例。Virtuoso 尚未完成初始滚动时，
   `remapInitialLocation` 就把 `scrollTop = 0` 当作阅读锚点，重新生成第一页的位置。
   Tauri 开发实例的探针记录到了 `activePageIndex = 12`、重建目标 `index = 0`，最终渲染第一页。
2. `initialScrollTop={value ?? undefined}` 显式传入了 `undefined`。当前 Virtuoso 的绝对位置
   管道以 `value !== 0` 判断是否启用，所以它仍会运行，并在按页码滚动成功之后发出
   `scrollTo({ top: NaN })`，浏览器因此回到顶部。只修第一条时，可见浏览器探针记录到
   `scrollTo(17436)` 后跟着 `scrollTo(NaN)`，症状仍然存在。

**修法。** 初次布局在保存页真正进入视口前保留目标页，不用临时的第一页更新阅读状态；
成功定位后恢复正常的页内锚点重映射。无绝对位置时向 Virtuoso 传它认可的惰性值 `0`。
恢复判断随文档身份重置，文件打开、最近文档和工作区恢复共用这一处 Canvas 修复。

**验证。** 回归测试先确认旧重映射逻辑失败；另一条测试挂载真实的 Virtuoso，先确认
第 13 页的滚动发生，再等待绝对位置管道，捕获旧实现的非有限目标，修复后通过。
可见浏览器在宽屏与 390px 窄屏均恢复第 13 页，分别停在 `scrollTop = 17436` / `5724`。
完整 Tauri 包通过原生选择器打开 24 页测试 PDF、跳到第 13 页，退出并确认进程消失后
重新启动，仍显示 `13 / 24`。构建、lint、1417 项测试和 Tauri 打包均通过；
Windows、Linux、iOS、Android 未做原生实机验证。
同类调用已检查：缩略图未传 `initialScrollTop`；DOCX 的入口已使用 `?? 0`，没有相同问题。

**能让它更早暴露的那一件事。** 页码存在、store 正确和首个滚动成功都不足以证明恢复成功。
回归检查必须覆盖首次适应宽度，以及虚拟列表延迟的第二条滚动管道；不能只测试页码工具函数。

---

## 2026-08-17 · CLI CI 六平台全红，其中一条是上游根本不打算修的

**症状。** `cli-verify` 在有记录的十二次运行里一次都没绿过，最早回溯到 2026-07-12。
六个平台一律挂在 `Build native CLI package`，看起来像同一个故障，实际是三个互不相干的
问题叠在一起，前一个挡住后一个，谁都看不见后面还有什么。

**根因。** 逐层剥开是三层：

1. **审计 pin 漂移。** 清理安全告警时把 nanoid 升到 5.1.16，但 `cli/build.ts` 的
   `AUDITED_DEPENDENCIES` 和 `cli/SBOM.md` 还写着 5.1.9。构建 fail closed，六个平台
   全死在这一步——包括后面两层问题所在的平台。
2. **Windows 换行符。** 仓库没有 `.gitattributes`，Git 在 Windows 检出时把
   `cli/licenses/**` 的 LF 改写成 CRLF。而 `auditedLicenseTreeDigest` 哈希的是原始
   字节，于是两个 win32 平台报 `CLI license texts changed`。这一层被第 1 层挡了很久。
3. **上游 Node.js 的 Mach-O bug。** `node --build-sea` 在 x86_64 上会破坏 Mach-O 的
   chained fixups，打包出的可执行文件在 dyld 阶段就段错误，JavaScript 一行都没跑到。
   100% 复现，且 Node.js 团队选择**跳过 x64 macOS 的 SEA 测试**而不是修
   （`nodejs/node#60250`，跟踪 `nodejs/node#62893`），理由是 x64 macOS 正在退场。
   pnpm 撞上同一个 bug，直接删掉了 darwin-x64 产物（`pnpm/pnpm#11455`）。

**修法。** 前两层各一处改动：pin 与 SBOM 同步到 5.1.16；新增 `.gitattributes` 把
`cli/licenses/**` 标为 `-text`，保证各平台检出字节一致。第三层不是我们能修的，按 Node
与 pnpm 的同一判断把 `darwin-x64` 从 `SUPPORTED_CLI_TARGETS` 和 CI 矩阵里移除——发一个
起不来的二进制比不发更糟。测试从「darwin-x64 映射到某个 canvas 包」改成「请求
darwin-x64 必须抛错」，避免它悄悄复活。

**能让它更早暴露的那一件事。** 中途我按文件里已有的 Linux ELF-note 先例，猜是
`strip -x` 破坏了 SEA 段，去掉 strip 推上去——CI 证明不带 strip 照样段错误，改动已撤回
（`41e2af13` → `655c0de4`）。教训有两条。其一：**症状相似不等于同因**，本仓库自己的
历史记录也可能把人引向错误方向，猜之前先去查上游有没有人报过同样的事。其二：
**fail-closed 的门禁会互相遮挡**。三个问题挤在同一条报错里，修完第一个才看得见第二个。
一条长期红着的 CI 不只是「有个问题没修」，而是「后面还有几个问题你根本不知道」。

---

## 2026-08-12 · Android 首次选文件无反应，第二次操作才打开上一份文件

**症状。** 在 Android 里点标签栏“+”并从系统选择器选中 PDF 后，Shiori 回到前台却不
打开文件；再次打开选择器或取消时，上一轮选中的文件才突然出现。Kotlin 已拿到有效的
`content://` URI，但在卡住期间没有任何 MediaProvider 读取，说明结果还没回到前端。

**根因。** Tao 0.35.3 的 Android event loop 调用 `ALooper_pollAll()`，却只在返回
`Poll::Wake` 时排空 `EventLoopProxy` 队列。Android NDK 明确说明：wake 与 lifecycle fd
等其他来源同时就绪时，poll 可以只返回那个 fd，所有返回值都必须视作“也可能发生过
wake”。文件选择器返回恰好同时触发 Activity resume 与 IPC response；Tao 消费了 wake、
处理了 lifecycle fd，却把已经入队的 `EvaluateScript` 留到下一次无关事件。第二次点“+”
只是制造了下一次 poll，所以症状看起来像 picker 要选两遍。

第一次修补只把 Tao 的 `try_send` 改成 `send`，并让 Wry 一次 wake 排空自己的消息队列；
这两处都在错误边界。Tao 使用的是 unbounded crossbeam channel，两种 send 最终走同一实现；
而 Wry 只有在 Tao 先派发 user event 后才有机会工作，因此都不能补回被 `pollAll` 吞掉的
那次 wake。

**修法。** 对齐尚未合并的 `tauri-apps/tao#1304` 方案：保留 Wake 分支的正常排空，并在
每一轮 poll 处理完任意来源后、`MainEventsCleared` 前再无条件 `try_recv` 到空。空队列只做
一次廉价检查；有等待中的 IPC response 时，则不再依赖另一条 wake。项目测试钉住这段
vendor 源码必须在 poll dispatch 之后、`MainEventsCleared` 之前存在；发布门禁另用最终
release APK 做 50 轮首次选择与 10 轮取消后重开，源码契约不能替代真实 Android 时序。

**能让它更早暴露的那一件事。** 异步 native bug 必须沿“ActivityResult → Rust responder →
Tao user event → Wry → WebView Promise”逐层看时间戳。看到 URI 已返回但 provider 未被读取，
就应先检查结果投递，而不是重试 picker、延时 200ms 或继续修 URI 权限。更重要的是，
`ALooper_pollAll` 的返回值不是单一事件真相；凡是依赖 Wake 分支消费队列的代码，都要按
Android NDK 的合并语义审计。

---

## 2026-08-11 · PDF 一有编辑，文档附件就从导出文件里消失

**症状。** 原 PDF 带着数据表、源文件或 Portfolio 附件时，无修改导出正常；只要加一处
高亮、合并文档或走紧凑导出，附件面板就变空。更危险的是，只导出当前页时，某些页级或
结构树关联的附件又会被悄悄带出去，界面却明确说附件已省略。

**根因。** 无修改路径直接返回原字节，所以掩盖了问题；有编辑后则用
`PDFDocument.create() + copyPages()` 重建文档。页面复制不会自动带上 Catalog 的
`/Names/EmbeddedFiles`、`/AF` 和 `/Collection`，原来的 Catalog 保真函数也只复制了
导航项。第一次修补只覆盖常见入口，随后反例又证明附件还能从 page `/AF`、
`FileAttachment`、`StructElem /AF`、跨页 `/IRT` 和文件动作进入对象图——入口白名单
不能证明最终输出安全。

**修法。** 完整文档导出显式保留附件容器，并用同一份对象克隆状态维持 Name Tree、
Catalog `/AF` 与页级引用的 FileSpec 身份；紧凑导出在栅格页写完后再复制附件。部分页面
导出先移除所有可达对象上的 `/AF`、页级附件及跨页依赖，再检查输出中不存在任何物理
EmbeddedFile 流。所有保留路径都比较源与输出的**可达 FileSpec 清单**（名称、描述、关联
关系、流元数据与 payload）；因此两个 FileSpec 即使共用一条 stream，也不能互相顶替。遇到
尚未支持的拓扑就以完整性错误失败，不允许回退成“更小但丢附件”的文件。不可达的历史孤儿
对象不算活附件，但 `omit` 会强制重写并把它们从交付字节中清掉。

**能让它更早暴露的那一件事。** PDF 保真测试不能只验“能重新打开、页数没变、文件更小”。
测试必须强制走重建路径，并逐字节读取附件 payload；同时构造 Catalog、页级、结构树、
间接对象、跨页回复和混合拓扑。保留策略比较源/输出清单，省略策略检查最终对象图为零——
把完整性断言放在出口，才不会每发现一种新入口就再漏一次。

---

## 2026-08-08 · 删除页面后大纲还在，目标页引用已经变成 null

**症状。** 一份有大纲的论文删到只剩第一页后，大纲标题仍然完整显示；选择指向后续页面的
条目没有任何反应，条目还会进入点击高亮状态。把文件导出后换一个阅读器打开，相关大纲和
内部链接同样无法跳转。

**根因。** 部分页面导出仍通过 `preserveNavigationCatalogEntries()` 深拷贝整棵
`/Outlines`、`/Dests` 和 `/Names /Dests`。`cloneRef()` 能把保留页面映射到新页，却只能把
已删除页面的引用替换成 `null`；上层条目没有同步删除，最终写出
`[null /XYZ ...]`。读取端 `OutlinePanel` 捕获目标解析失败后仍渲染普通按钮，点击路径随后
静默返回。

**修法。** 导出在目录复制完成后统一校验导航目标：清理失效的命名目标、OpenAction 和页内
链接；递归删除失效的大纲叶节点，并重建剩余节点的 `First/Last/Prev/Next/Count`。当前编辑
会话仍保留原 PDF 的标题层级，但目标页已从模型删除的条目改为非交互文本，不再伪装成可跳转
按钮。

**能让它更早暴露的那一件事。** 页面集合变化后，不能只验证页数和“PDF 能重新打开”；所有
以页面对象为目标的结构都要做可达性检查。回归测试同时覆盖“目标全部删除”“有效与失效兄弟
混合”“保留目标后正确重映射”，并用 pdf.js 重新读取导出字节确认失效大纲返回 `null`。

---

## 2026-08-07 · PDF 永远滚不到底：虚拟列表的高度估算只认挂载那一刻

**症状。** 在桌面版里快速往下滚一份 PDF，接近底部时视图反复被拉回去一段；再往下拖，
再被拉回，文档像是永远翻不完。慢慢滚不会发生。网页版用脚本改 `scrollTop` 也复现不出来——
只有真实的惯性滚动才触发，这一点一开始把注意力引向了错误的方向。

**根因。** 每一次回弹都是浏览器在夹 `scrollTop`，因为滚动容器的 `scrollHeight` 变小了，
不是哪段代码主动滚了页面（第一版猜的是 `activePageId` 变化触发 `scrollToIndex`，日志证明
它一次都没触发）。react-virtuoso 4.18 的 size tree 只在**为空时**吃 `heightEstimates` /
`defaultItemHeight`，一旦有了首批测量，后续 prop 更新会被过滤掉。而列表挂载发生在
fit-to-width 把 `scale` 算出来之前，于是每一页都按 scale 1.0 估高；快速滚动会整页整页地
跳过页面，那些页从未被挂载、也就从未被测量，一直保留着偏小的估算。总高因此长期短于真实
高度，浏览器就一次次把滚动位置拉回那个假的底部。

日志里的数字是决定性的：`8848 → 7553`，而 7553 = 3 × 1106（测量过的）+ 5 × 847（估算的），
847 正是 792pt × 1.0 + 55px 页面外框，1106 是 792pt × 1.327 + 55px。

**修法。** 页面几何本来就完全已知，所以直接算出每个 item 的精确高度（旋转后的页高 × 当前
缩放，加上外边距、页码标签和间距），把整个数组交给 Virtuoso。因为估算无法就地更新，高度
模型一变（缩放、页边距、旋转、混合页面尺寸）就给列表换 `key` 重建，并把视口中心映射回同一
页的同一位置；捏合 / 滚轮手势期间推迟重建，避免打断指针流。此外，Virtuoso 用 padding 补偿
被卸载的页，但那块 padding 晚一帧才到——所以再给列表元素钉一个等于真实总高的 `minHeight`，
让这一帧的空档传不到滚动位置上。

**能让它更早暴露的那一件事。** **组件挂载的时机，就是它把估算写死的时机。** 任何"只在初始化
时读一次"的属性（`heightEstimates`、`defaultItemHeight`、各种 `initial*`），都必须问一句：
挂载那一刻，我喂给它的值算完了吗？这里 `scale` 要等 fit-to-width 跑完，而列表早一帧就挂上了。
另外，这类 bug 用脚本设 `scrollTop` 复现不出来——它要的是"跳过中间项"的真实快速滚动；
自动化滚不出来不等于没有，别据此判定网页版没问题。

---

## 2026-08-05 · 官网滚不动：CSS 的启用条件比 JS 少一半

**症状。** 官网首页在桌面 Chrome 上打开后滚不下去。滚轮在页面上转，画面纹丝不动，
没有报错。把浏览器缩小（页面 zoom out）之后又能滚了——这条线索反而容易把人带偏，
让人去查响应式断点。

**根因。** `PageScroller` 的整屏翻页有两套开关，而它们写得不一样。JS 那边是
`!useReducedMotion() && matchMedia("(min-width: 980px) and (pointer: fine)")`；CSS
那边（`site/src/index.css`）只写了 `@media (min-width: 980px) and (pointer: fine)`，
**漏了 reduced-motion 这一半**。

于是开着「减少动态效果」的访客拿到的是两边最差的组合：组件判定自己该禁用，退回成
普通的纵向堆叠，不再翻页；但 CSS 仍然把每个 `.hero` / `.section` / `.footer` 钉死在
`calc(100dvh - 60px)`，还配上 `overflow-y: auto` + `overscroll-behavior: contain`。
结果每个 section 都成了独立的滚动容器，只能在自己内部滚那一百来 px；滚到底之后
`contain` 又不让滚动链传回文档。光标停在哪个 section，滚轮就被哪个 section 吃掉。

缩小页面之所以"好了"：内容装得下一屏后 `scrollHeight === clientHeight`，元素不再可
滚动，滚轮这才冒泡到 document。**症状随 zoom 变化，掩盖了它其实与断点无关。**

**修法。** 给那段媒体查询补上 `and (prefers-reduced-motion: no-preference)`，让 CSS
的条件和 JS 的 `enabled` 逐字对齐，并把"必须对齐"写进注释。

**能让它更早暴露的那一件事。** **同一个功能开关不要在两处各写一遍。** 只要条件被
复制成 JS 一份、CSS 一份，它们就会分头演化——这次是 JS 后加了 reduced-motion 分支而
CSS 没跟上。可靠的形状是让 JS 成为唯一裁决者，把结论写成一个 `data-*` 属性或类名挂到
根元素上，CSS 只匹配那个标记（`[data-pagescroller="on"] .section { … }`），条件就只剩
一处。另外：本机开着「减少动态效果」时，日常自测走的一直是这条降级路径，而它从没被
当作一种要验的形态——降级路径也是要看的形态之一。

---

## 2026-08-02 · 在 pointerdown 上处理激活，控件对键盘就是死的

**症状。** 选中文字后浮出的标注条（高亮／下划线／删除线／引线标注），四个按钮
用鼠标点全都正常。但它们能聚焦、焦点环也亮，按 Enter 却什么都不发生——不是报错，
是彻底静默。

**根因。** `PopupButton` 只绑了 `onPointerDown`。键盘的 Enter／Space 派发的是
`click`，而当时没有任何人监听 `click`。选在 `pointerdown` 上处理本身是有理由的
（触屏点击弹出条外面会 collapse 选区，`pointerdown` + `preventDefault` 才保得住
选区），注释也写清楚了——只是这个理由从没被推到"那键盘怎么办"。

更糟的是这条链路的位置：pdf.js 文字层是真的可读文本，Shift+方向键能选中，弹出条
也会自己出现。整条路只有最后一步按不动，而它是文字类标注**唯一**的非指针入口。

**修法。** 补 `onClick`，用 `event.detail` 区分来源：指针激活的 click 带
`detail >= 1`（已在 `pointerdown` 里处理过，直接返回），键盘合成的 click
`detail === 0`（在这里应用）。`OverlayDom` 的折叠按钮早就用同一个判别式，只是
没被推广。

**能让它更早暴露的那一件事。** **测试里用 `fireEvent.click` 而不是
`fireEvent.pointerDown`。** testing-library 的 `fireEvent.click` 默认 `detail`
就是 0——恰好是键盘激活的形状。也就是说，一个按"用户点了这个按钮"朴素写法写出来
的测试，天然测的就是键盘路径，这个 bug 根本活不下来。反过来，任何顺着实现去发
`pointerDown` 的测试，对这类缺陷永远是绿的。仓库里还有 60 多处 `onPointerDown`，
判断它们有没有同样的洞，只需问一句：**不用鼠标，这个东西怎么按？**

---

## 2026-08-02 · "这是唯一入口" —— 说了三次，三次都不对

**症状。** Live digest 要区分"读者自己写的标注"和"从 PDF 导入的标注"。这个判断
改了四轮，每一轮都以为找到了可靠依据，每一轮都被证明不成立：

1. **"有本地时间戳就是本地创建的。"** 不成立——导入 sticky note 走
   `createNoteOverlay(..., now)` 重建，一进来就带着当天的 `createdAt`；
   导入的回复把源文件 `/CreationDate` 抄进 `thread.at`。
2. **"没有 source 日期就是本地的。"** 不成立——`withSourceProvenance` 只在
   PDF 真的有 `/CreationDate` 或 `/M` 时才写，一个只有作者名的外来标注会被
   判成"我的"。
3. **"`annotationToOverlay` 是所有导入的唯一入口，在那里打标记就够。"**
   不成立——同一个文件里有**四处** `overlays.push(...)`，只有一处走它：
   raw FreeText callout 由 `importRawCallout` 构造，从两个独立的循环直接
   push；折叠回复的 note 又是第四处。
4. 就算标记对了，**复制品仍然继承来源**：`cloneOverlayWithId` 保留
   `origin`、作者、日期和 `/IRT` 回复链接，粘贴出来的标注顶着陌生人的署名。

**根因。** 前两轮的共同错误是**从可选的元数据反推事实**。PDF 里每一个
provenance 字段都是可选的，而导入过程本身又会写入"现在"——所以任何基于
"有没有某字段""时间戳早还是晚"的推断，都只是在猜。

第三轮的错误不同，也更值得记：**我断言了一个"唯一入口"，但没有去数**。
`annotationToOverlay` 看起来像唯一的构造点（它甚至有一句注释说"applied once
here rather than in each importer"），实际上同文件里还有两处 push 绕开它。

**修法。** 在**真正的唯一出口**记录事实，而不是在看起来唯一的入口推断：
`importPdfAnnotations` 的 `return` 处统一 `markImportedOverlay`——不管中间是
哪条路构造的，离开这个函数的每一个 overlay 都来自文件。同理，本地编辑的时间
戳写在 store 的两个 mutation 出口（`updateOverlay` / `updateOverlayNoHistory`），
而不是每个编辑调用点。复制品则显式剥掉 `origin` / `importedAt` / `source*` /
回复链接——理由和早就存在的 `delete copy.anchor` 完全一样。

**能让它更早暴露的那一件事。** 说"这是唯一入口"之前，**先 grep 一遍构造点，
数出来**。`grep -n "overlays.push" src/pdf/import/annotations.ts` 会立刻显示
有四处，只有一处经过那个函数。这条断言我在 commit message 里写过、在给复审的
说明里写过，两次都没验证——直到复审自己去数了。写这条复盘时我又凭印象写了
"三处"，grep 完才发现是四处：同一个毛病，隔了十分钟又犯一次。

**推论：入口是用来推断的，出口是用来记录的。** 一个函数"看起来是必经之路"
不构成保证；而所有分支汇合的 `return` 是结构性的保证。

## 2026-08-02 · 同一段文本，三层用三种单位度量

**症状。** Live digest（推给 agent 的标注摘要）的容量限制修了四次，每修一层
就在下一层暴露一个新的失败：中文文档整个 context 被 native 拒收 → 一个 emoji
让 Rust 反序列化失败 → 一个组合符序列让整个摘要变空 → 400 个 family emoji 让
CLI 丢弃全部内容。

**根因。** 同一个 payload 穿过三层，每层用**不同的单位**衡量"多长"：

| 层 | 度量 | 上限 |
|---|---|---|
| 前端 `annotationDigest.ts` | JS 字符串 `.length`（UTF-16 code unit） | 48,000 |
| Rust `live_api.rs` | `String::len()`（UTF-8 **字节**） | 64 KiB |
| CLI `liveApp.ts` 复核 | `value.length`（UTF-16 code unit） | 每字段 1024 |

三者对 ASCII 完全一致，所以一直没人发现。CJK 让前两者差 3 倍（一个汉字 1 个
code unit、3 个字节），emoji 让第三者也裂开（一个 family emoji 1 个 grapheme、
8 个 code unit、25 个字节）。

更麻烦的是**切**和**量**也可以用不同单位：一版实现用 UTF-16 长度判断"要不要
截断"、却用 grapheme 切，于是 300 个 emoji 明明一个都没删，仍然被加了省略号
并把整个摘要标成 truncated。

**修法。** 每一次切割同时受**所有**下游上限约束，取先到者；判断和切割必须用
同一个迭代器。另外 grapheme 没有字节上限——`"x"` 加 30,000 个组合符是**一个**
grapheme、60 KB，所以"按 grapheme 截"本身不构成任何字节保证。

**能让它更早暴露的那一件事。** 一个跨进程/跨语言的 payload，**把每一层的度量
单位写进注释，并在最紧的那一层写测试**。这轮真正抓到问题的测试都长一个样：
构造一个在某种单位下合法、在另一种单位下超限的输入（200 条中文标注、边界上的
一个 emoji、一个 30,000 组合符的 grapheme、400 个 family emoji），断言**最紧的
那层**能接受。纯 ASCII 的测试对这类 bug 完全无效——三种单位在 ASCII 下是同一
个数。

**附带。** 最后一层（CLI 的 1024）不是任何一轮 review 发现的，是修完 Rust 那层
之后顺手核对 `cli/src/liveApp.ts` 里那几个 mirrored 常量时发现的。跨层契约的
常量如果在多处各写一份，就值得定期对一遍——它们不会一起变。

## 2026-08-02 · 一轮修复里出现了三种"绿着的假测试"

**症状。** 26.7.31 审计后的修复链，每一轮都由独立复审（Codex）过一遍。四轮里
有三轮的主要发现不是"修错了"，而是**"测试根本没测到修的东西"**——测试是绿的，
把修复整个撤掉它还是绿的。

**根因。** 三种形态，成因各不相同：

1. **测试重写了一遍生产逻辑。** `pdfMergeOwnership.test.ts` 的 harness 自己
   实现了一份 `stillOwnsTarget`，于是即便 App 传进去的是 `() => true`，整组
   测试照样全绿——而那正是它要防的 bug。

2. **测试断言的是没改动的函数。** 修复发生在 `App.tsx`（从重建的 tab 回灌
   `lastExport`），测试却去断言 `replaceOrAppendWorkspaceTab`——那个函数这轮
   一行没动，而且上一条测试已经覆盖过它。删掉 App.tsx 里那三行，测试不红。

3. **测试因环境限制走了 early return。** iframe 重载的回归测试里，
   `refreshKey` 其实是 `DocumentViewer` 的内部 state（由刷新按钮递增），
   我当 prop 传进去根本没生效；更糟的是 happy-dom 把所有盒子报成零宽，
   overflow 触发器压根没渲染，测试撞上 `if (!trigger) return` 直接通过。
   它"绿"了两轮，实际一次都没打开过菜单。

**修法。** 三条各自的解法不同，但归到同一条规则：

- 判定逻辑导出成共享纯函数，生产和测试**调用同一个**，而不是各写一份。
- 测试要锚在**这次改动的那个函数**上；如果改动落在没有 harness 的地方
  （`App.tsx`），就把决策抽成一个能测的 seam，并明说"接线本身仍未覆盖"。
- 任何 `if (前提不成立) return` 的分支，都要改成**断言**前提成立。跳过等于
  说谎。

**能让它更早暴露的那一件事。** 写完测试**立刻把修复撤掉，看它是不是真的变红**。
这轮后半程每条新测试都做了这一步（改回旧实现 / 塞回旧值 / 摘掉 cleanup），
当场抓出了两个本来会溜过去的假绿。这个动作只要几十秒，比任何 review 都快。
它也不该外包给复审——复审能看出"这个测试没测到点上"，但只有写测试的人知道
自己刚才改了什么，撤起来最准。

**附带的一条。** `tsconfig.app.json` 里 `exclude: ["src/**/*.test.ts"]`，
所以 `bun run build` **从不类型检查测试文件**——这个仓库里任何
`@ts-expect-error` 形式的类型守卫在 CI 中都是空的。发现于给
`exportMergeBase` 加编译期约束时：探针拿掉后 build 依然是 0 错。真正拦住
运行时的是逐字段投影，不是类型。

## 2026-08-01 · 第二个实例覆盖门牌后崩掉，第一个实例就此永久失联

**症状。** 开着 Shiori，CLI 跑 `shiori app context` 回
`ERR_APP_UNAVAILABLE: Shiori live API descriptor belongs to a process that is
not running`。app 明明在前台开着。只有把它退掉重开，CLI 才恢复。

**根因。** Live API 的门牌 `live-api.json` 全局只有一份，后启动的实例直接覆盖。
A 启动写下自己的端口和 token；B 启动把文件覆盖成自己的；B 异常退出（崩溃或
`kill -9`）没跑到清理逻辑，于是文件里留着 B 的死 PID。CLI 读到死 PID 就报错——
这一步是对的，它确实识别了死进程。真正的问题是**没有自愈**：A 还活着，但关于
A 的一切（端口、token）已经被覆盖掉了，磁盘上不存在任何找回 A 的线索，而 A
自己也不知道门牌已经不是它的了。

**修法。** 每个实例除了共享门牌，再写一份以自己 PID 命名的
`live-api.<pid>.json`（`instance_descriptor_name`，先写它再写共享的，保证共享
指针不会指向一个不存在的后备记录）。共享门牌降级成"最近启动的那个"的快捷方式。
CLI 读到的共享门牌若是死 PID，就扫描目录里的 per-instance 文件、按 PID 判活：
恰好一个存活就直接用它，顺手 unlink 掉死掉的那些；多个存活则明确报错并列出
PID，让调用方用 `SHIORI_LIVE_API_DESCRIPTOR` 指定，而不是互相覆盖。显式指定了
descriptor 的调用方不参与重新发现——钉死了就该钉死。

**能让它更早暴露的那一件事。** 崩溃清理路径要按"清理没跑"来测，而不是按
"清理跑了"来测。原来的测试都在验证优雅退出时文件被正确删除，而这个 bug 恰恰
只在**清理没机会执行**时出现。回归场景就是那句话本身：A 启动 → B 覆盖 →
B 异常退出 → CLI 仍能连回 A。

## 2026-08-01 · 内部合并借用了用户可见的导出语义，粘贴一张图就删光全文档的链接和表单

**症状。** 打开一份带目录内链、或带已填 AcroForm 的 PDF，在页面上按 ⌘V 粘贴一张
图片追加成新页。合并本身看起来完全正常，但从这一刻起，文档里所有超链接和所有
表单域（连同用户已经填进去的值）都没了。界面没有任何提示，问题要到下一次保存或
导出、甚至换个阅读器打开时才被发现。

**根因。** `appendIncomingPdf` 需要一份"当前文档的字节基底"来接新页，于是调
`exportPdf(..., { mode: "none" })`。`"none"` 不是"什么都不做"——它是导出对话框里
**用户选的 "Original only"**，语义是整删 `/Annots`（这正是上一轮审计 P2-17 要求的
行为，改对了）。内部合并借用了这个面向用户的模式，就把"不要写入我的标注"错当成了
"删掉页面上的一切标注"。链接从来不进 overlay 模型（见 2026-07-24 那条），所以它们
一旦从字节里消失，app 内没有任何路径能恢复。真正的根因是：一条内部路径没有属于
自己的入口，只好去挑一个用户可见的枚举值。

**修法。** 给内部合并一个专用入口 `exportMergeBase(bytes, pages, fontOptions)`，
它不接受 `mode`。这里第一版写错了：当时只用 `Pick<>` 把 `mode` 排除在 options
类型外，就宣称"类型上传不进去"。**不成立**——TypeScript 的多余属性检查只作用于
**对象字面量**；一个已经声明为 `ExportOptions` 的变量照样能赋给 `Pick<>` 参数，
而当时的实现又把整个 options 原样转发给 `exportPdf`，`mode` 就这么漏过去了。
真正拦住它的是两道：类型侧加 `mode?: never`（字面量和变量都报错），运行时侧把
四个字体字段**逐个投影**出来，而不是整包转发——类型不会留到运行时。
默认模式恰好就是合并基底想要的：只剥离 overlay 模型已经拥有、稍后会重写的那几种
markup 子类型，链接、widget、未知子类型一概不碰。

**能让它更早暴露的那一件事。** 回归测试要断在**调用点**上，不是断在底层函数的语义上。
`exportPdf.test.ts` 里原本就有一条 "none mode removes links, widgets…"，它一直是绿的，
而且断言的东西完全正确——因为它测的是用户可见的 `"none"` 模式该做什么，根本不知道
有人在内部复用了它。新测试改成透过 `exportMergeBase` 断言，把 `mode` 塞回 helper 里
就会立刻变红。**一个枚举值同时服务于"用户选的"和"内部用的"，就该拆成两个入口。**

## 2026-08-01 · 只看端口和应用名，把一套 Tauri dev 变成了两个 dev 加安装版

**症状。** 为了验证一个前端改动，桌面上同时出现两个 `target/debug/shiori`
窗口，随后 `/Applications/Shiori.app` 也被拉起。用户无法判断正在看的到底是
当前源码、孤儿 dev，还是已安装的发布版。

**根因。** 第一个错误是把 1573 端口上的 Vite 进程直接认成“纯 Web dev”。它其实
属于已经运行的 Tauri dev；只杀 Vite 没有结束对应的 debug binary，反而留下了
`PPID=1` 的孤儿 `target/debug/shiori`。随后再跑 `bun run tauri:dev`，自然得到第二个
debug 实例。第二个错误是做 UI 检查时用 Computer Use 的模糊应用名 `Shiori`。
安装版和 debug 版同名、同 bundle id；工具没有可靠区分窗口，并会自动启动它解析到
的应用，于是 `/Applications/Shiori.app` 也被拉了起来。

**修法。** 启动前先用 `pgrep -fl target/debug/shiori` 找 debug 实例，再用
`ps -p <pid> -o pid=,ppid=,lstart=,command=` 核对父进程和启动时间；端口只能说明
Vite 存在，不能说明它属于谁。已有健康 dev 就复用；`PPID=1` 的旧 debug 实例只按
精确 PID 关闭。UI 自动化不得再用 `Shiori` 这个模糊显示名或 bundle id 去“验证 dev”；
工具不能按 debug 可执行文件/PID 精确命中时，就不要让它代替验证。任何时刻都应保持
一个受当前终端 session 管理的 `target/debug/shiori`，并确认
`pgrep -fl Shiori.app/Contents/MacOS/shiori` 为空。

**能让它更早暴露的那一件事。** 在每次启动或宣称“这是 Tauri dev”之前固定做一个
进程断言：**恰好一个** `target/debug/shiori`、**零个**
`/Applications/Shiori.app/Contents/MacOS/shiori`；不要从窗口外观、端口或应用名推断。

## 2026-07-30 · 两个 effect 从两端夹同一个 `railTab`，Web 端拉宽窗口就白屏

**症状。** 只在纯浏览器（非 Tauri）复现：把窗口收窄到 ≤959px、点顶栏大纲按钮打开右栏，
再把窗口拉宽过 959px，整个编辑器当场变白，控制台 `Maximum update depth exceeded`。
桌面版和移动端都没事，所以本地 `tauri:dev` 一路开发下来永远看不到。

**根因。** 同一份 `railTab` 被两个 effect 从相反方向"纠正"。RightRail 的 clamp 把不可用的
tab 拨到 `fallbackTab`；App 的 clamp 把没有 capability 的 tab 拨回 `"outline"`。桌面和移动端
两边总有一个可用值，所以两者一致、一次收敛。而 Web 桌面布局是唯一一个**没有任何可用 tab**
的组合：阅读类 tab 已经搬进左侧导航（`outlineInRail = isMobile`），终端和浏览器面板又都是
`IS_TAURI_DESKTOP`。于是 `fallbackTab` 落到 `"browser"` → App 拨回 `"outline"` → 又不可用 →
`"browser"`……两个 effect 各自依赖对方写的值，React 数十轮后放弃并卸载整棵树。
`if (tabs.length === 0) return null` 拦不住：它在所有 hook 之后，返回 null 的组件依然挂载、
effect 依然跑。这行还是这轮 diff 自己引入的回归——改动前 RightRail 写的是硬编码
`setTab("outline")`，和 App 写的是同一个值，永远不成环。

**修法。** clamp 之前先问 fallback 自己是否可用：`if (!tabAvailable(fallbackTab)) return;`。
没有任何可落脚的 tab 时就什么都不写——反正那种状态下这个组件本来就不渲染东西。

**能让它更早暴露的那一件事。** 一条断言"任何一个 effect 写进 store 的 tab，都必须是它自己
认可为 available 的值"。更一般的教训：**两处代码 clamp 同一份 state 时，收敛目标必须是同一个
函数**，否则只要存在一个两边都不认的取值，就是一个死循环——而这种取值往往只在某个平台组合
下出现，正好是本地跑不到的那个。AGENTS.md 第 9 条（平台差异是一等公民）在状态机上同样成立。

---

## 2026-07-24 · `AnnotationMode.DISABLE` 为了防重影，把画不了的注释也一并抹掉了

**症状。** 别的阅读器里能看到的箭头、椭圆、图章、附件图标、表单字段，在 Shiori 里整个消失；
但导出的 PDF 里它们**还在**。屏幕上看到的东西和文件里的东西不一致，而且没有任何报错。

**根因。** 页面画布一直用 `AnnotationMode.DISABLE` 渲染。这个模式的本意是防重影 ——
Shiori 会把它认识的注释（Highlight/Underline/StrikeOut/Text/FreeText/Square/Ink）导入成可编辑
overlay，画布再画一遍就会「一份平的 + 一份活的」叠在一起。但 `DISABLE` 是**全有全无**的：
它同时也抹掉了 Shiori 根本不导入、只是原样保留到导出的那些注释。

**修法。** 改用 `AnnotationMode.ENABLE_STORAGE`，并由 importer 逐条把「我接管了」的注释写进
`doc.annotationStorage` 的 `{ noView: true }`。pdf.js 的 `Annotation.mustBeViewed()` 会**先**查
storage 再看 /F flags，所以这是官方支持的「只藏这一条」的手段。归属权因此只有一个判定点：
importer 导入了什么，画布就跳过什么；剩下的全交给 pdf.js 画它自己的 appearance stream。
Link 和 Popup 额外由 `isShioriDrawnSubtype` 认领 —— 前者由 `PdfLinkLayer` 画成真正的 anchor，
后者被 Shiori 自己的便签 UI 取代。写入放在导入循环里逐条做（而不是最后统一提交一份清单），
这样即使导入中途抛异常，已经导入的那些页也不会重影。

**能让它更早暴露的那一件事。** 一条测试断言「importer 没有认领的 subtype 必须保持可绘制」。
现在 `annotations.test.ts` 的 `canvas ownership` 双向锁住了这条边界：漏认领 → 重影，
多认领 → 注释凭空消失。另外 `CANVAS_ANNOTATION_MODE` 一旦被改回 `ENABLE`，suppression 会**静默**
失效并让所有导入的注释重影 —— 改这个常量前先读 `src/pdf/render/canvasAnnotations.ts` 的顶注。

**后续约束（2026-08-11）。** raw append 换出的 pdf.js document 有一份全新的
`annotationStorage`。base 页的 overlay 又可能已经被用户编辑或删除，所以既不能跳过 ownership
扫描，也不能重新导入并覆盖当前 model。正确边界是：让 importer 扫描所有物理页并执行完整
suppression，只返回新插入页的 overlays。只补 Link/Popup 会让 base 的 Highlight/FreeText/Square/Ink
等再次由原生层绘制，表现为重影，甚至让已经删除的批注“复活”。

---

## 2026-07-24 · 窗口 minWidth 960 与 MOBILE_MAX_WIDTH 959 差 1px，紧凑布局在桌面端从未跑过

**症状。** 桌面窗口缩到接近半屏（14" MacBook Pro 逻辑宽 1512，半屏 756）就再也拖不动了。
同时窄窗口下工具栏文字会折成两行 —— 而代码里明明写好了一整套紧凑布局。

**根因。** `tauri.conf.json` 的 `minWidth: 960` 是为了防止内嵌终端被挤扁而设的，但它是
**窗口级**约束。`useIsMobile` 的阈值是 `max-width: 959`，二者只差 1px：桌面窗口永远不可能
小于 960，于是 `isMobile === true` 这条分支在桌面 app 里**永远不成立**。抽屉式侧栏、四列工具
网格、隐藏快捷键提示等所有紧凑分支都是死代码，任何针对它们的改动在桌面端都无法验证。
更糟的是终端**本来就自带**约束（`TERMINAL_RAIL_MIN_WIDTH = 360`，且 `terminalRailMaxWidth()`
固定给文档预留 420），窗口那道锁纯属冗余，代价却是所有窗口、所有机器。

**修法。** `minWidth` 降到 600（主内容真正需要的下限）；终端改为**自己退让**：窗口窄于
`TERMINAL_MIN_VIEWPORT_WIDTH = 900` 时其 rail tab 隐藏并自动切回 Outline，宽度恢复后自动切
回终端。用 ref 记录「是自动折叠的」而非「上次是终端」，这样用户在窄窗口下主动选了别的 tab
之后，终端不会自己跳回来。工具栏另加 `COMPACT_TOOLBAR_MAX_WIDTH = 1180`，在标签被挤到换行
之前先隐藏快捷键字母。

**永久规则。** **窗口最小尺寸由主内容决定，不由可选面板决定。** 面板放不下就自己折叠，
不要反过来否决窗口尺寸（VS Code / Xcode / Figma 都是这个模式）。另外：**布局断点和窗口
约束是一对耦合常量**，任何一个改动都要回头检查另一个 —— 否则会像这次一样，整条分支静默失效
而没有任何报错。

---

## 2026-07-09 · Browser capability 注释写着“隔离”，自定义命令却没有 app manifest

**症状。** 内嵌 Browser 的远程 child webview 标记为 `web-panel`，桌面 capability 也确实只写了
`webviews: ["main"]`，代码注释因此一直声称远程网页拿不到文件、保存和终端命令。但
`build.rs` 仍调用裸 `tauri_build::build()`，从未注册 application command manifest。

**根因。** Tauri 2.10 的 capability 只有在 app ACL manifest 存在时，才会对自定义
`generate_handler!` 命令执行相应权限检查；插件命令自带 manifest，不代表应用自定义命令也
自动受控。因此 capability 文件里“只授权 main”的注释和 `webviews` 选择器都不是安全边界——
没有 app manifest 时，自定义命令根本没有进入这套 ACL。远程 child webview 又会获得 Tauri IPC
初始化脚本，于是可能调用 `terminal_spawn` / `terminal_write`，把网页内容边界升级成桌面命令执行。

**修法。** `build.rs` 用 `AppManifest::commands(APP_COMMANDS)` 注册全部 app commands；桌面与移动端
分别维护最小化的 `desktop-app-commands` / `mobile-app-commands` permission，并且只通过
`webviews: ["main"]` 的对应 capability 授权（mobile 明确没有 terminal/native-path commands）。
所有 command 入口再读取调用者 `Webview` 并硬拒绝非 `main` label，终端、文件打开和导航事件也只
定向 emit 给 main webview。测试强制 `generate_handler![…]`、`APP_COMMANDS` 和 permission 列表
保持同步，并断言 capability 不得使用 window-wide `windows` 匹配、`web-panel` 必须被 guard 拒绝。

**永久规则。** **Capability 注释不等于 app command ACL。** 任何新增 Tauri 自定义 command
必须同时进入 app manifest 和 main-only permission；remote child webview 永远不得获得任何
allow-app permission。权限配置是第一层，命令入口的 `label == "main"` 是第二层，两个都不能省。

---

## 2026-07-06 · 原文编辑错位的真因：精确基线在管线入口就被丢掉，三个消费方各自倒推

**症状。** contentText（原文编辑）长期存在的一组"差一点"：编辑虚线框和原文字
微错位、编辑完成后文字有肉眼可辨的"异样感"、Shiori 里对齐但导出到 Preview 又偏。
2026-05-16 那轮修复（gesture 裁剪 + 共享 placement）收敛了大部分，但残留一直没断根。

**根因。** pdf.js `getTextContent()` 每个 item 的 `transform[5]` 就是**精确的
glyph 基线**，但入口 `textItemToDisplayTextRun` 用它算出 ascent/descent 盒后就把
基线本身丢了（`TextRunDisplayBounds` 没这个字段）。此后三个消费方只能从盒子边缘
倒推"基线大概在哪"，各自演化出互相不知道的补偿常数：编辑框 0.45pt/2.2pt nudge；
DOM 渲染靠 `line-height:1` 的 CSS 基线（随替换字体 metrics 浮动）；导出用
`rect.y + rect.h − 0.8 − heightAtSize(...)`——0.8 和建框处的 expand 常数在**两个
文件里重复硬编码**，而且 `heightAtSize` 用的是**替换字体**的 ascent，不是原字体的。
字号还叠加一层：`Math.round(median(...))` 把论文常见的 9.96pt 取整成 10pt。

**修法。** 把每个源行的基线捕获成 `ContentTextOverlay.sourceBaselinesPt`（page
space、随 `overlayToPdfPageSpace` 平移），三方全部从它派生：DOM 用 canvas
`fontBoundingBox*` 度量把首行 CSS 基线 translateY 到位；导出直接把它作为文字矩阵
的 y（pdf-lib 的 y 本就是基线），替换字体 ascent 从此与落点无关；字号优先取 pdf
text-matrix 精确值、保留两位小数。**信不过就不猜**：DOM 兜底选区路径拿不到真基线
时整体不写该字段，所有消费方回落 legacy 数学——宁可保持旧的错位，也不引入估出来
的新错位。旧 overlay 同理，行为不变。

**能让它更早暴露的那一件事。** 审 `TextRunDisplayBounds` 这类中间类型时问一句：
**上游给的哪些精确值被这个类型"降采样"掉了？** 盒子是基线的有损投影；一旦有两个
以上消费方需要从投影里恢复原值，每一方都会长出自己的 fudge factor，且 CI 全绿。
grep 到重复出现的魔法常数（这里是 0.8 出现在两个文件）就是信号。

Changelog: `0.1.25`。参见 2026-05-16（同一战场的前一轮）。

---

## 2026-06-30 · macOS「打开方式」冷启动只启动 App：Tao 在 callback 就绪前丢了 Opened 事件

**症状。** macOS 上 Shiori 未运行时，在 Finder 里双击关联文件或「打开方式 → Shiori」，
第一次只会启动 Shiori，不会加载被打开的文件；保持 App 运行后再打开同一个文件，才会成功进入
编辑器。0.1.24a 仍能复现。容易误判成前端 listener 太晚、Rust pending queue 没 drain，或
LaunchServices 没把文件路径传进来。

**根因（两层 race，其中第一层才是主因）。**

1. **Tao 先丢了冷启动 open-document 事件。** macOS 会在 AppDelegate 装好后很早调用
   `application:openURLs:`，Tao 0.34.8 里这会走 `AppState::open_urls` →
   `Handler::handle_nonuser_event(Event::Opened { .. })`。但冷启动这一刻
   `EventLoop::run` 的 callback 还没通过 `set_callback` 装进去；原实现只在 callback 存在时
   派发事件，没有 callback 时既不排队也不报错，于是 `Opened` 被静默丢掉。Tauri 的
   `.run(|app, event| ...)` 根本收不到 `RunEvent::Opened`，所以 Shiori 自己的
   `PENDING_OPEN_PATHS` 没机会入队。App 已运行时 callback 已存在，所以第二次打开正常。
2. **前端还有一个窄窗口。** 0.1.24 的 Rust pending queue / replay 只能处理「已经进入
   Tauri run closure」的事件；而前端原顺序是先 `drain_pending_open_paths`、再
   `listen("file-open")`，如果事件刚好落在 drain 和 listen 中间，也可能被留到下次启动。
   这不是本次最主要的丢文件点，但修冷启动时必须一起收掉。

引入点是 `ea0d48ce Add PDF file association for macOS desktop`：它接上了 macOS file
association，但当时没有测「App 完全未运行时由 LaunchServices 打开文件」这条路。后续
`713d1bcc Fix file-open replay and encrypted PDF merge` 只补了 Shiori 层的 replay，无法恢复
已经被 Tao 丢掉的 early `Opened`。

**修法。**

- 用 `[patch.crates-io]` 指向本地 `src-tauri/patches/tao-0.34.8`，只改 Tao 的 macOS
  `AppState`：当 callback 还不存在时，仅把 `Opened` / `Reopen` 这类生命周期事件暂存进
  `pending_events`；`set_callback` 后立即 replay。不要无脑缓存所有事件，避免改变窗口/输入事件
  的时序语义。
- Shiori Rust 侧统一用 `enqueue_pending_open_target`，macOS/iOS 的 `RunEvent::Opened`
  仍同时「入队给冷启动 drain」和「emit 给 warm listener」。
- 前端改为先注册 `file-open` listener，再 drain Rust cold-launch buffer，并用短时间 path
  去重 + `ack_pending_open_path` 防止同一路径被打开两次。

**验证。** 不能只测「App 已运行时打开文件」。必须先杀掉 app，再从系统层冷启动：

```bash
pkill -9 -f "Shiori.app/Contents/MacOS/shiori" 2>/dev/null || true
open -a "./src-tauri/target/release/bundle/macos/Shiori.app" /tmp/some-new-test.pdf
```

实测时最好用一个新的文件名 / 新的 PDF 内容；Shiori 的草稿恢复按 PDF bytes 的 SHA-256 key，
重复拿同一份 PDF 复制成不同名字时，旧草稿标题可能干扰肉眼判断。最终修复提交：
`b939485b Fix macOS cold file-open handoff`。

**能让它更早暴露的那一件事。** file association 的验收矩阵里必须区分 cold launch 与 warm
launch。看到「warm 正常、cold 只启动」时，第一怀疑点不是前端 listener，而是 OS delegate →
window/event-loop crate → Tauri `RunEvent` 这段早期事件有没有在 callback 注册前被丢掉。

---

## 2026-06-29 · Android 0.1.24 直装更新下载后报“不比当前版本新”：release 名字涨了，versionCode 没涨

**症状。** Android direct-apk build 在设置里能检查到 `0.1.24`，点更新也开始下载正确的
`Shiori_0.1.24_android-direct_app-universal-release.apk`，但下载完成后报
`android-update-version-not-newer`（中文 UI：下载的 APK 不比当前版本新）。

**根因。** `/api/release` 返回的是 GitHub Release 元数据：tag / 文件名 / digest 都是
`0.1.24`，所以前端认为有新版本；但 Android 安装校验比较的是 APK manifest 里的
`android:versionCode`，不是文件名，也不是 `versionName`。线上 `0.1.24` APK 的包内元数据是
`versionName=0.1.24`、`versionCode=1018`。`1018` 来自 `src-tauri/tauri.android.conf.json`
里手写的 `bundle.android.versionCode`，它在 0.1.18/direct-apk 工作后没有继续随版本递增。
因此手机当前包只要已经是 `1018`，下载到的 0.1.24 就会被原生桥判定为“不新”。

**修法。** 删除过期的手写 `bundle.android.versionCode`，让 Tauri 按 semver 派生 Android
versionCode（例如 `0.1.24 -> 1024`）。同时在 release workflow 的 direct APK 构建后用 `aapt
dump badging` 校验包内 `versionName` 和 `versionCode`，不匹配直接 fail，避免“文件名新、包内
code 旧”的 APK 被上传到 `Nagi-ovo/shiori-releases`。

**能让它更早暴露的那一件事。** Android release 验收不能只看 tag、文件名、`versionName` 和
sha256。直装更新发布前必须读 APK 自己的 manifest，并确认 `versionCode` 比上一版 Android 包大。
`/api/release` 的 sha256 只能证明手机下载的是发布页那份字节，不能证明这份字节对 Android 来说
是可升级版本。

---

## 2026-06-15 · iOS 导出「假成功」：opener 对无 scheme 的缓存路径静默 resolve，文件落进不可达缓存

**症状。** iOS 上导出 PDF，点保存/分享后 toast 显示「已分享 xxx.pdf」、一切看似正常，但在「文件」app、相册、任何地方都找不到导出件——文件只躺在 app 的 `Library/Caches/exports` 里，随时被系统回收。Android 与桌面正常，唯独 iOS。

**根因。** `saveBytesMobile`（`src/platform/save.ts`）只有 Android 有真分享路径（`window.ShioriAndroid.shareExport`）；iOS 无此桥，落到 `@tauri-apps/plugin-opener` 的 `openPath(path)`。但 opener 在 iOS 上走 `UIApplication.shared.open(URL(string: path))`——`UIApplication.open` 是用来打开 URL scheme / 跳 app 的，对一个**无 scheme 的文件系统路径**既不报错也不做任何事，且 Promise **无条件 resolve**。于是 JS 收到 success，`saveBytesMobile` 返回 `{status:"saved"}`，UI 弹「已分享」。整条 iOS 导出链路是坏的，却伪装成功——比直接报错更糟：用户以为存好了，就把内存里的原编辑丢了。Rust 侧 `save_pdf_dialog`（mobile）把文件写进 `app_cache_dir/exports` 又加重了「不可达」。

**修法。** iOS 不该用 opener「打开文件」，该用系统**分享面板**。给 `tauri-plugin-shiori-browser`（本就是 Shiori 的 iOS 原生桥）加一个 `shareFile` 命令：Swift 端 `UIActivityViewController(activityItems:[fileURL])` 从 `manager.viewController` present（iPad 必须设 `popoverPresentationController` 锚点，否则 UIKit 崩）。前端 `saveBytesMobile` 的 iOS 分支改为 `invoke("share_exported_file", …)`，并**删掉 openPath 回退**——分享失败现在抛真错误，不再假报成功。Android 仍走自己的 JS 桥，不碰。

**能让它更早暴露的那一件事。** 「Promise resolve 了」≠「事情做成了」。原生 opener / `UIApplication.open` 这类 fire-and-forget API，对某些输入静默 no-op 是常态。凡是平台分享 / 打开 / 保存路径（AGENTS.md fact #9），每条路由都要追问「这个『成功』信号是真的吗」，并在真机上端到端验一次——iOS 导出此前从没有人在设备上确认过文件真能到用户手里。

---

## 2026-06-15 · Windows 内嵌浏览器第二次回归：首次真实导航后主线程整体卡死——`app.emit` 从 `on_navigation` COM 回调里重入 WebView2 消息泵

**症状（Windows 0.1.22，真实用户）。** 0.1.22 修掉 per-frame `show()` 卡死后**重新启用**了
Windows 内嵌浏览器（黑屏卡死消失）。但出现一组**新**症状，且**只在地址栏输入网址、发起第一次
真实导航之后**爆发，导航前面板空白时一切正常：

- 远程网页**打不开**（空白，永不渲染）；
- 主窗口按钮**点击无反应**（打开文件 / 继续上次会话 / 最近文档 ✕）；
- 窗口 / 整个软件**关不掉**；
- 内嵌**终端**若在触发浏览器 bug **之后**打开，永远停在「正在启动 shell…」
  （`terminal.connecting`）。

**根因（已坐实结构，未坐实确切阻塞原语）。** 四个症状联合**证明导航后主 UI 线程 / tao
事件循环 / IPC 响应投递被整体卡死**：`invoke("terminal_spawn")` 永不 resolve，所以终端状态
永远卡在 connecting（`RightRail.tsx` 的 `status` 仅在 `await spawnEmbeddedTerminal()` 返回后才
转 `ready`）；窗口关闭、命令往返、渲染同理。已用源码 + 外部证据**坐实**的那处 Windows 专属裂缝：

1. **`on_navigation` 就是同步的 WebView2 `NavigationStarting` COM 回调，跑在主 UI 线程**
   （wry `webview2/mod.rs`，`SetCancel` 在回调返回后才施加）。
2. **从回调里 `emit_web_panel_nav` → `app.emit` → 往 webview `eval` → wry `send_user_message`**，
   而 `send_user_message` 在「当前线程 == 主线程」时走**内联执行**分支
   （`tauri-runtime-wry`；本仓库 `Cargo.toml` 无 `tracing` feature，命中非 tracing 的
   `EvaluateScript` 臂）——也就是会**在导航 COM 回调还在栈上时重入**消息泵。
3. **macOS WKWebView 的 `evaluateJavaScript` 是异步派发**，`decidePolicyForNavigationAction`
   回调直接返回、从不重入 —— 所以同一份代码只有 Windows 炸。这解释了「为何第一次真实导航
   （= `on_navigation` 首次为远程页触发）才触发」。

**但「ExecuteScript 阻塞 → NavigationStarting 死锁」这一具体机制被证伪。** wry 的
`execute_script` 用**被丢弃的完成回调**（fire-and-forget，无 `.Get()`/嵌套泵）；`emit` 只往
**注册了 JS 监听器**的 webview eval，而只有 `main` 监听 `web-panel-nav`（`webPanel.ts`），
**不会重入正在导航的 web-panel 自身**；WebView2Feedback #1853 也表明导航期间的 `ExecuteScript`
只是**延迟**到 ~ContentLoading、并非死锁。故重入是**最可能、Windows 专属、可廉价拆除**的差异，
但其「足以卡死消息泵」的因果充分性**尚未证明** —— 确切阻塞原语可能在 WebView2/Chromium 内部，
需真机 WinDbg/ETW 抓导航卡死瞬间的主线程栈才能定案。

**修法（Windows 保持启用，按「拆掉首次 create+navigate 路径上每一处可证伪的主线程重入」
做防御式加固；用 vendored wry/tauri 源码逐条核实，见下「源码坐实」）。**

- **推迟所有同步 emit 出 COM 回调栈。** `on_navigation` 里、以及 `web_panel_open` /
  `web_panel_navigate` 末尾的 `emit_web_panel_nav` 全部改用 `tauri::async_runtime::spawn`
  推到 worker 线程：`send_user_message` 因此改走**排队**分支（`proxy.send_event`），eval 落在
  之后一个干净 tick，而不再在 WebView2 的 IPC / NavigationStarting COM 回调栈上内联执行。
  历史仍在 `on_navigation` 内同步记录、emit 时重读单次加锁快照，地址栏 / back-forward 仍正确，
  只晚一个 tick。**切忌改用 `run_on_main_thread`**：它从主线程调用同样内联，原样重现重入。
- **`creating` 门控中和创建期的重入几何命令。** 首次输入网址 = **创建子 webview（`add_child`）+
  首次导航**同时发生；Windows 上 `add_child` 在主线程跑**嵌套消息泵**（`webview2_com::wait_with_pump`
  → `GetMessageA(None)`/`DispatchMessageA`）等控制器建好，期间会**重入派发**并发排队的 IPC——
  前端独立的 rAF/ResizeObserver 正好在面板打开瞬间发 `web_panel_set_bounds`（首帧
  `lastReportedBoundsRef` 为 null，前端去重不拦），于是 `SetBounds`/`SetIsVisible` 会打到
  **半成品控制器**上。修法：`WebPanelInner` 加 `creating` + `pending_bounds`；进 `add_child`
  前置 `creating=true`（**锁必须在 `add_child` 之前释放**，否则重入的 set_bounds 自死锁），
  `add_child` 返回后清标志、`take()` 暂存的 bounds 并 flush 一次。`web_panel_set_bounds` 在
  `creating` 时只暂存最新 bounds 即返回；`web_panel_hide` 在 `creating` 时**不丢弃**而是记
  `pending_hide`。**这两个 `creating` 检查必须在 `get_webview()` 之前**：`add_child` 在把 webview
  插入 manager **之前**就已建好运行时 webview，故重入期 `get_webview()` 可能返回 `None` 而
  `creating` 仍为真——若门控写在 `if let Some(webview)` 里，意图会被整段跳过而**丢失**（门控只读
  state、不需要 webview handle）。注意 native webview 是 OS 顶层（不被 DOM 裁剪，见 2026-05-30），而前端**不轮询
  hide**——`shouldShow` 翻 false 只发一次 hide。若创建期把它丢了、创建后又无条件 `visible=true`，
  子 webview 会**一直浮在 Settings / 别的 tab 上不下来**。所以创建结束后由 `create_web_panel`
  按最终期望统一决定 `hide()`/`show()` 并设 `visible`（`web_panel_open` 不再在创建路径上无条件置
  visible）；`pending_bounds` 与 `pending_hide` 互斥、last-writer-wins（set_bounds 只在
  `shouldShow=true` 时发，会清 `pending_hide`；hide 会清 `pending_bounds`），与前端两者同由
  `shouldShow` 驱动一致。`add_child` 本身**必须留在主线程**
  （WebView2 控制器只能在 UI 线程建），加固是中和「泵能重入派发什么」，不是把创建挪走。
- **`IS_WINDOWS` 仍作一行 kill switch。** `src/platform/index.ts` 保留导出 `IS_WINDOWS`；若真机
  仍冻结，把 `embeddedBrowserPanel` 收窄回 `(IS_TAURI_DESKTOP && !IS_WINDOWS) || IS_TABLET`
  即可一行下线，不必回滚 Rust。

**仍欠的验证（重要）。** 上述重入是**结构性坐实**，但「足以卡死消息泵」的**因果充分性未证**——
真正的阻塞原语可能在 WebView2/Chromium 内部。macOS 无法驱动 WebView2，故仍需真 Windows +
WebView2：先在**未修**包复现四症状，再在**已修**包确认页面 / 按钮 / 关窗 / 终端均恢复；理想用
WinDbg/ETW 对比卡死瞬间主线程栈定位真凶。若已修包仍卡，用 kill switch 下线并按主线程栈继续查。

**源码坐实（vendored crates，已读非臆测）。**
- `tauri-runtime-wry/src/lib.rs`：`send_user_message` 在 `current_thread == main_thread_id` 时
  内联跑 `handle_user_message`，否则 `proxy.send_event`（排队）——内联与否纯看线程身份。
- `webview2-com/src/lib.rs`：注释明言「WebView2 线程模型一切在 UI 线程跑，含回调」；
  `wait_with_pump` 是 `GetMessageA(None)` 的嵌套循环，会重入派发该线程任意窗口的消息。
- `wry/src/webview2/mod.rs`：`on_navigation` 是 `add_NavigationStarting` COM handler、回调内联、
  返回后才 `SetCancel`（恒主线程）；`create_controller` 末尾 `wait_with_pump`（创建期嵌套泵）。
- `tauri-macros` command wrapper：sync `#[tauri::command]` body 是 `let result = $path(args);`
  内联、不 spawn；IPC 经 `add_WebMessageReceived` COM handler 到达——**故每个 `web_panel_*`
  sync command body 都在主线程跑**，末尾的同步 emit 同样在 IPC COM 回调栈上内联。

**能让它更早暴露的那一件事。** **「绝不从 wry 的同步回调 / sync command（`on_navigation` /
IPC handler）里调任何走 `send_user_message` 的 Tauri API（`emit` / `eval` / `navigate` /
`set_bounds`）」当成铁律** —— 这些在主线程内联执行、在 WebView2 上等于重入 COM 回调栈 /
创建嵌套泵。2026-05-30 复盘已记下「`send_user_message` 在主线程内联执行」，但当时只用它论证
「sync command 不会死锁」，没推论到「从回调里回调它 = 重入」这一面。把那条 insight 的**两个方向**
都写进约束，本类 bug 设计期即可避免。

**预防 / 教训。**

- 这是连续**第二次** Windows 内嵌浏览器回归；native-child-webview + 多 webview(WebView2) +
  逐帧几何同步这套设计在 Windows 上反复暴雷。本次按「拆掉首次 create+navigate 上每一处可证伪的
  主线程重入」做了**防御式深度加固**并保持启用，但在拿到能驱动 WebView2 的 Windows CI / 测试机
  之前，真机验证仍是硬门槛，`IS_WINDOWS` kill switch 必须一直留着。
- 跨平台 webview 回调的同步性差异（WKWebView 异步 / WebView2 同步重入）要当**第一约束**。

---

## 2026-06-15 · 移动端设置面板：CJK 文案被挤成「一字一行」竖排——横向 flex 里文本列 `minWidth:0` 撞上不收缩的宽控件

**症状。** 手机宽度下打开「环境设定」，日文最明显：「テーマ」标题竖排成 テ/ー/マ，「リモート画像」说明被压成一字一行的细长竖列；资源面板 GPU 那行的适配器字符串（`Google Inc. (Apple) · ANGLE …`）也一词一行往下堆。中英文没这么夸张，但同病同源。

**根因。** 设置行 `SettingRow` 是横向 flex：左文本列 `flex:1, minWidth:0`、右控件 `<div>{children}</div>` 不限制收缩。当右侧是三选项分段控件、且选项文案长（日文「システムに合わせる」「許可しない」），控件保持其固有宽度不收缩，把文本列挤到接近 0。**CJK 没有词边界**，浏览器可在任意两字之间断行，于是列宽一旦小于一个字，整段就退化成一字一行的竖排——不是「换行难看」，是「竖成一条」。`ResourceMetricRow` 的 GPU 行同理：value（`アクセラレーション無効`，`nowrap`）吃掉大半行宽，detail（适配器串，`flex:1 1 0` + `overflowWrap:anywhere`）只剩几十像素，长串便一词一行堆叠。

**修法。** ① `SettingRow` 加 `flexWrap:wrap`，文本列改 `flex:"1 1 150px"`（给一个宽度下限），控件 `flex:"0 0 auto"`——空间不够时控件整条折到下一行，文本列恢复满宽；窄控件（开关）仍同行。② `ResourceMetricRow` 增加 `detailBlock` 模式：长自由文本（GPU 适配器串）改为在 value 下方满宽换行，不再挤进右侧细列。三语在 ~320px 面板宽（手机上 settings 抽屉固定 320px）下逐屏目视通过。

**能让它更早暴露的那一件事。** 凡是「横向 flex + 文本列 `minWidth:0` + 同行有可能很宽且不收缩的兄弟控件」，在 zh/ja 下先按最长文案过一遍。给文本列一个 `flex-basis` 下限、让宽控件 `wrap`，比给文本列 `minWidth:0` 任其收缩更安全——后者在 CJK 下不是降级而是崩坏。

---

## 2026-06-15 · 安卓 app 内更新报「non-injected object」：桥方法被拆下来裸调，整条路又被构建 flag 藏了很久

**症状。** 安卓 app 内点「更新」失败：`Error invoking installDirectApk: Java bridge method can't be invoked on a non-injected object`，下载都没开始就报错。诡异之处：用户坚称「之前的版本没问题」。

**根因（两层）。**
1. **裸调丢了 receiver。** `src/platform/updater.ts` 把安卓桥方法抽成裸变量再调：`const installDirectApk = bridge?.installDirectApk` … 后面 `installDirectApk(JSON.stringify(request))`。安卓 WebView 的 Gin Java Bridge 靠**调用时的 receiver（`this`）**定位被注入的对象——脱离宿主对象调用，`this` 不再是注入对象，于是报「方法不能在非注入对象上调用」。铁证：报错前那个 `if (!installDirectApk)` 守卫**过了** = 方法确实注入好了（不是桥坏了、更不是某个插件的锅）；同一个桥的另外三个方法（`documentInfo` / `shareExport` / `drainPendingDocumentOpens`）都写成 `bridge.method(...)` 带着 receiver，所以一直正常，**只有更新这一处是裸调**。
2. **为什么"之前没事"——构建 flag 把整条路藏了。** 直装更新只在 `CAPABILITIES.androidDirectUpdater`（即构建为 `SHIORI_ANDROID_DISTRIBUTION=direct-apk`）时才走；否则点更新走的是浏览器下载回退（用户手动装，感知为"更新正常"）。之前一直是回退路径，从没真正跑到那行；这次第一次按 `direct-apk` 打包、第一次真走直装，藏了很久的裸调 bug 当场暴露。`git log -G installDirectApk` 证实那两行从引入它的 `4ba9f2e`（0.1.20 之前）起就是错的、中间没人动过——**不是这批平板 commit 的回归**。

**修法。** `bridge?.installDirectApk?.bind(bridge)` 把 receiver 绑回去，与其它三个桥方法一致（commit `0c5ceab`）。注意：修复在「更新发起方」那一版才生效——当前装着的旧版仍带 bug，必须**手动装一次带修复的新版**，之后直装才会好；而且直装整条路（下载→校验→FileProvider 安装 intent）此前从没在真机跑通过，第一次端到端要现场验。

**能让它更早暴露的那一件事。** ① 凡是 `@JavascriptInterface` / `addJavascriptInterface` 注入的方法，**永远 `obj.method(...)` 带宿主对象调**，别抽成裸引用——抽出来就丢 receiver，报的还是个看不懂的「non-injected object」。② 复盘"之前没问题"时，先问一句「之前那个包到底有没有走这条路」——被构建 flag（这里是 `direct-apk`）门控的代码路平时是暗的，"没报错"常常只是"根本没跑到"。

---

## 2026-06-14 · iPad 内嵌浏览器实测：TopBar 门控藏按钮、前端嵌入不刷新、openurl 被 Quick Look 抢

**症状。** 平板 Path B 内嵌浏览器（native WKWebView 插件）写完、Rust/Swift/Kotlin 全
编译通过，但在 iPad 模拟器上**怎么都点不到浏览器入口**，折腾很久看不到效果。

**根因（三个叠在一起）。**

1. **`TopBar` 浏览器按钮门控在 `!isMobile`。** 这是浏览器还是桌面专属时写的。现在它在
   平板启用了（`IS_TABLET`），但 iPad 竖屏 834pt < 960 → `useIsMobile=true`，于是**能力
   开着、按钮被藏** → 浏览器编译好、能跑，但用户够不到。
2. **iOS 把前端 `generate_context!` 嵌进二进制（dylib）。** 只改前端、Rust 不重编，嵌入
   的前端**不一定刷新**（iOS 增量构建对 rerun-if-changed 不可靠）→ 改了看不到效果。线索：
   app bundle 里 `assets/` 是空的、`Shiori.debug.dylib` 72MB。
3. **`xcrun simctl openurl file://…pdf` 被系统 Quick Look / Preview 抢走，不进 Shiori。**
   肉眼看的"编辑器"一直是**苹果的标注 UI（悬浮胶囊工具栏），不是 Shiori**——左上角
   "◀ Preview" 面包屑就是铁证。整套"浏览器按钮没出现"的分析因此全错。

**修法。**

- `TopBar.tsx`：浏览器按钮门控 `!isMobile` → `!isMobile || IS_TABLET`。
- iOS 前端改动后看不到效果时，`touch src-tauri/src/lib.rs`（或干净重编）强制重嵌。
- 测 **Shiori 自己的"打开文件"流程**，别用 `openurl`（会进 Quick Look）；要看的是 Shiori
  的右栏（Outline / Comments / Browser SegTab），不是系统预览。

**验证（iPad Pro 11" 模拟器，真 iOS WebKit/UIKit）。** 内嵌浏览器**端到端工作**：点
TopBar 的 🌐 → 右栏开 Browser tab → 地址栏输 `example.com` → **原生 WKWebView 加载并渲染
了 example.com**，左 PDF / 右网页真·分屏；地址栏回显 `https://example.com`（说明 agent 的
轮询式 `web-panel-nav` 也工作）。`IS_TABLET=true`——iPad WKWebView 报的是**桌面级身份**
（`platform=MacIntel`、UA 无 "iPad"），靠 `platform==='MacIntel' && maxTouchPoints>1` 兜底
命中。

**能更早暴露的那一件事。** 一开始就**从 Shiori 内部走一遍开 PDF → 开浏览器**，而不是靠
`openurl` + 默认"看到的就是 Shiori"。GUI 验证第一步要确认"现在前台到底是哪个 app"。

Changelog: 本次提交（平板浏览器 iOS 实测 + TopBar 门控修复）。

---

## 2026-06-14 · 平板内嵌浏览器：移动端没有子 webview，native→Rust 回传又卡在 pub(crate)

**背景。** 桌面端内嵌浏览器是 Tauri `unstable` 的原生子 webview（`Window::add_child`）。
但 `add_child`、`Webview::set_bounds/hide/show/close` 全是 `#[cfg(desktop)]`，移动端根本不
编译——平板的浏览器内容必须是一个「平台原生」web view（iOS WKWebView / Android WebView）
作为 Tauri webview 的兄弟视图，由一个 Tauri mobile 插件（`tauri-plugin-shiori-browser`）
托管。这部分是已知前提，详见 `docs/TABLET-BROWSER-HANDOFF.md`。

**真正耗时的坑：`web-panel-nav` 事件怎么从原生回到前端。** 桌面端在 Rust 的 `on_navigation`
里 `app.emit("web-panel-nav", …)`。移动端最自然的对应是：原生 nav delegate 通过一个 Tauri
`Channel` 把状态 push 回来。但**只有「源自 JS 的 channel」才能被原生→Rust 回传命中**——
注册函数 `tauri::plugin::mobile::register_channel` 是 `pub(crate)`，唯一调用点在
`JavaScriptChannelId::channel_on(webview)`（即 JS 把 channel id 当命令参数传下来时）。
Rust 侧 `Channel::new(...)` 造出来的 channel 永远进不了 `CHANNELS` 表，原生 `.send` 经
`send_channel_data_handler` 查表查不到，消息被静默丢弃。而冻结的前端用全局
`listen("web-panel-nav")`、从不往下传 channel，契约＋文件归属又不许改前端——push 这条路
被彻底堵死。

**修法。** 原生 delegate（WKNavigationDelegate / WebViewClient）只把 nav 快照写进一个带锁
缓存；Rust 侧开一个**仅在面板可见时**才工作的轻量轮询线程（150ms），调原生 `navState`
读快照，与上次比对有变化才 `app.emit("web-panel-nav", …)`。发出的事件与桌面逐字节一致，
只是传输从 push 换成 poll。`loading` 本就是 webPanel.ts 注明的 best-effort，<150ms 的快速
加载即便没闪 spinner 也可接受；url / canGoBack / canGoForward 的最终态总会在一拍内收敛。

**另外两个一次写对、但值得记下的移动端老坑**（与 2026-05-30「原生 webview 是 OS 顶层」同源）：
- **坐标换算两边不同。** JS 给的是 CSS 逻辑 px。iOS `UIView.frame` 是 point，对 Tauri
  webview ≈1:1，但要**相对 Tauri webview 的 frame 原点**摆放，否则状态栏/安全区会整体偏移；
  Android `View` 布局是物理 px，必须 `× resources.displayMetrics.density`——忘乘 density
  会让整个 WebView 缩到左上角 1/density 大小（最经典的 Android bug）。
- **z 序与模态。** 原生 web view 是 OS 层、无 DOM 裁剪/层叠，永远浮在 React UI 之上，只能在
  「没有任何东西该盖它」时可见。这条由冻结的前端负责（`shouldShow = active && !obscured`
  → `hideWebPanel()`），插件只忠实执行 hide/show，并在 show 时 bringToFront；页面保活不销毁。

**还有个工程坑。** 插件 `build.rs` 的 `tauri_plugin::Builder`（以及移动构建）会往插件目录里
**生成**一大堆产物：`android/.tauri/tauri-api`（拷贝的 Tauri 原生 API 包 ＋ 它的 Gradle 构建
输出，~280 个文件）、`permissions/autogenerated/`。第一次 `cargo check --target
aarch64-linux-android` 跑完它们就全冒进了工作副本。必须 gitignore（`**/.tauri`、
`/permissions/autogenerated`），只提交手写源码。

**能让它更早暴露的那一件事。** 决定「原生异步状态怎么回到 JS」之前，先查一句：你要用的回传
机制（channel / 事件）的注册入口是不是 `pub`、是不是只认 JS 来源。Tauri mobile 的 `Channel`
回传是「JS-channel only」，Rust 自造的 channel 注册不进表——push 走不通就老实 poll，别跟
`pub(crate)` 较劲。

---

## 2026-06-14 · 退出清理：只挂 ExitRequested，drain 释放 master 才能解阻塞 reader，收割要整棵进程树

**症状。** 退出 Shiori 后（尤其 Windows 任务管理器里）用户在内置终端跑的 shell
及其前台子进程（claude / codex / node / 构建）残留、随开关/退出循环不断累积；
macOS/Linux 同样产生孤儿。`.run()` 闭包只处理 `RunEvent::Opened`，其余事件一律
丢弃（`let _ = (app, event);`），没有任何退出清理；终端 reader 线程阻塞在
`reader.read()`，PTY master 与子进程都没人收。

**根因。**

1. **没有退出钩子。** `.run()` 闭包从不处理 `ExitRequested`，也没有
   `on_window_event` / `impl Drop`。退出时 `TerminalSession`（child + master Arc +
   writer）和每会话 reader 线程被直接抛弃。
2. **只 kill shell PID 不够。** `child.kill()` 只命中 shell 句柄；shell 是 `setsid`
   会话首进程（portable-pty），其前台子进程不会被带走——Unix 被 reparent，
   Windows `TerminateProcess` 不递归。于是「关终端 / 退应用」都漏杀子孙。
3. **reader 线程靠 master drop 解阻塞。** Unix 关 slave、Windows ConPTY 的
   `ClosePseudoConsole` 都在最后一个 master 引用 drop 时才发生——不释放 master，
   reader 永远卡在 `read()`。

**修法。**

- 新增单一 `shutdown_cleanup`，只从 `RunEvent::ExitRequested` 调用一次
  （`#[cfg(not(mobile))]`）。
- **只挂 ExitRequested，绝不挂 CloseRequested/Destroyed。** macOS 红点关窗 / Cmd+W
  触发后两者但 app 不退出，那样会误杀用户还在用的 shell、并拆掉本应保活的
  web-panel 子 webview——在唯一已验证可用的平台上制造回归。我们不 `prevent_exit`，
  所以 `ExitRequested` 触发即等于「确实在退」，此时收割永远正确。
- `shutdown_cleanup` **drain** sessions map（释放 master Arc → reader 解阻塞自然
  退出），drain 也让重入幂等；锁只在取出时短暂持有，收割在锁外做。
- `kill_session_tree` 跨平台收割整棵树：Unix `killpg(pid,SIGHUP)`→80ms→
  `killpg(pid,SIGKILL)`（pgid==pid，因 setsid）；Windows `taskkill /T /F /PID`。
  （2026-10 更正，audit B085：交互式 shell 把每个 job 放进自己的进程组，
  只 killpg shell 的组会漏掉它们。现在扫描进程表，对 sid == shell pid 的每个
  进程组都发信号，见 `src-tauri/src/terminal/reaper.rs`。）
  被 `terminal_kill`（显式关终端）和 `shutdown_cleanup`（退应用）复用。
- 有界收割：`try_wait` 轮询上限 ~300ms，避免病态子进程卡住退出（进程退出时 OS
  兜底回收）。`libc` 改为显式声明依赖（见 2026-06-12 base64 复盘），不吃传递依赖。

**能让它更早暴露的那一件事。** 一开始就把「长生命周期本地资源（PTY / 线程 /
子进程）的生命周期 = 用户是否关闭该能力 + 应用是否退出」当成第一约束，而不是只在
reader 自然 EOF 那条路径收尾——退出、显式关闭这两条「非自然」路径必须各自有人收。

**跨平台未决（需真机）。** `#[cfg(windows)]` 的 `taskkill` 块在 macOS 上不参与
编译，需 Windows CI / 真机确认；`ExitRequested` 触发时机与「关窗是否=退出」需真机
smoke（macOS：关窗 shell 应存活、Cmd+Q 应收割）。

Changelog: 本次提交（退出清理 + 进程树收割）。

---

## 2026-06-12 · Android 构建：被 cfg-gate 的是 crate 依赖本身，不只是 import

**症状。** 桌面三平台（mac/Win/Linux）全部构建通过、`v0.1.19` 已发版，但
`build-android` job 编译 `aarch64-linux-android` 的 lib 时挂在：

```text
error[E0425]: cannot find value `BASE64_STANDARD` in this scope
```

`cargo check`（桌面 host）一直是绿的，所以本地完全看不到。

**根因。** CJK 文件名导出修复（`76e3096`）把 IPC 头里的文件名改走 Base64，并让
共享辅助器 `suggested_export_name` 在 desktop *和* mobile 都解码——但 `BASE64_STANDARD`
的 `use` 被标了 `#[cfg(not(mobile))]`，**且 `base64` crate 在 `Cargo.toml` 里本就声明
为桌面专属依赖**（`[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`）。
于是 android target 上「有用法、无 import、连 crate 都不存在」。只改 import 的 cfg
不够——crate 本身得对 mobile 可用。

**修法。** 把 `base64 = "0.22"` 从桌面专属 target section 提到无条件 `[dependencies]`，
并去掉 `use base64::…` 上的 `#[cfg(not(mobile))]`。桌面产物零变化（本就有这个 import），
只是让 Base64 对 mobile 可用。(`4dda74bc`)

**能让它更早暴露的那一件事。** 当一个原本 desktop-only 的符号被挪进 desktop/mobile
**共享**的函数时，要顺藤查它的 `use` 和 `Cargo.toml` 依赖是否也被 `cfg(not(mobile))`
/ target-section gate 住。`cargo check` 只跑 host target，发版前对 mobile 改动应跑一次
`cargo check --target aarch64-linux-android`（或让 CI 的 android job 早于 tag。）

**教训。** 桌面 `cargo check` 绿 ≠ 移动端能编。跨平台共享的 Rust helper，import 与
依赖声明的 cfg 都要跟着用法的平台范围走。

---

## 2026-05-31 · DMG 打包：Rust 编译过了，不等于 Finder 美化也能跑

**症状。** 本地跑 `. "$HOME/.cargo/env" && bun run tauri build` 时，release Rust 编译、
`Shiori.app` bundle 和 codesign 都成功，但最后 DMG 阶段只报：

```text
failed to bundle project error running bundle_dmg.sh
```

没有更具体的 stdout/stderr；目录里留下 `rw.*.Shiori_0.1.15_aarch64.dmg` 中间镜像，但没有最终
`Shiori_0.1.15_aarch64.dmg`。

**根因。** Tauri 的 DMG bundler 使用 `create-dmg` 脚本，默认会跑 AppleScript 美化 Finder
窗口布局。Codex/CI/非完整 Finder 会话里这一步容易失败；Tauri 的 `output_ok()` 又会把
脚本细节折叠成一个泛泛的 `failed to run bundle_dmg.sh`。这次不是 Rust 编译、app signing、
`hdiutil` 缺失、残留挂载卷或磁盘空间问题。

**修法。**

- 先确认没有 Shiori 残留挂载卷：
  `hdiutil info | rg -B3 -A5 'Shiori|rw\\..*Shiori'`。
- 清掉失败留下的中间镜像：
  `rm -f src-tauri/target/release/bundle/macos/rw.*.Shiori_*.dmg`。
- 用 Tauri bundler 自带兜底路径重跑：
  `. "$HOME/.cargo/env" && CI=true bun run tauri build`。

`CI=true` 会让 Tauri 给 `bundle_dmg.sh` 加 `--skip-jenkins`，跳过 Finder AppleScript；产出的
DMG 仍可安装，只是 Finder 窗口布局不做美化。

**能让它更早暴露的那一件事。** 看到 `bundle_dmg.sh` 失败时，第一时间把它拆成两段判断：
`.app` 是否已签好、DMG 是否只是 Finder 美化失败。不要把 “最后打包失败” 误当成 “代码没编过”。

**教训 / 预防。**

- 本地验证代码改动时，`CI=true bun run tauri build` 是可接受的 DMG 兜底；正式面向其他 Mac
  分发仍用 `./scripts/build-signed.sh`，让 notarize/staple 走完整签名链路。
- 如果最终只需要确认 native 编译和 `.app` 行为，`.app` 已产出且可启动就足够说明代码层通过；
  DMG 美化失败要单独处理。

Changelog: 本次提交（Markdown/HTML 图片资源安全与本地相对图片）。

---

## 2026-05-30 · Android 发布：mobile Tauri 不是桌面 Tauri，小图标也不是小事

**症状。** 准备把 v0.1.15 的 Android 包补到 release 时，连续撞到几类问题：

- Android CI 在 `Build signed Android direct APK` 直接 Rust 编译失败：
  `no variant named Opened found for enum RunEvent`。
- App 内文件 picker 能弹出系统文件列表，但选择 PDF / Markdown 后看起来没反应；
  从系统文件管理器长按「用 Shiori 打开」也只是启动 App，不会真正打开文件。
- 打出来的 launcher icon 在 Android 桌面上「栞」字显得过大，像被放大裁切。
- 本地尝试 `bun run tauri android build` 失败，但 CI 能继续打包；一开始容易误判成
  代码问题。
- 修了图标后如果不取消已经在跑的旧 CI，旧 APK 可能后上传，把 release asset 又覆盖回旧图标。

**根因。**

1. **`RunEvent::Opened` 不能按 “mobile” 一概而论。** 桌面 / iOS 的 file-open 路径可走
   Tauri `RunEvent::Opened`，但 Android target 下这个 variant 不存在。把原先 macOS/iOS
   的处理扩大到 `#[cfg(mobile)]` 会让 Android 编译期失败。
2. **Android 的系统文件打开是 `Intent`，不是桌面路径事件。** `ACTION_VIEW`、`ACTION_SEND`、
   `ACTION_SEND_MULTIPLE`、`EXTRA_STREAM`、`ClipData` 都可能给 `content://` URI。Tauri
   Rust 侧不会自动把这些变成前端的 `"file-open"` 事件；需要在 `MainActivity` 的
   `onCreate` / `onNewIntent` 桥到 webview。
3. **Android Document Picker 常给没有文件名的 `content://`。** 旧逻辑靠后缀判断文档类型；
   URI 里没有 `.pdf` / `.md` / `.html` 时，就会误判 unsupported，或者早期被当 PDF 解析成
   “文件损坏”。
4. **Android 8+ launcher icon 走 adaptive icon。** `mipmap-anydpi-v26/ic_launcher.xml`
   由 foreground + background 两层组成。之前的 `ic_launcher_foreground.png` 是一整张蓝底
   圆角 Shiori tile，而不是透明前景字形；Launcher 再把它当前景层遮罩，于是视觉上被放大。
5. **Android 隐私默认值和本地优先定位相冲突。** `allowBackup` 默认是 `true`，不显式配置时，
   app 数据可能进入 Google Auto Backup / 换机迁移。`FileProvider` 如果用 `path="."`，
   分享暴露范围也过大。
6. **本地 Android SDK 不等于可发布构建环境。** 本机能找到 SDK，但缺 NDK 会让
   `tauri android build` 失败；这不代表 CI 会失败，因为 release workflow 会安装 NDK /
   build tools。反过来，本地过了也不代表签名和上传会过。
7. **Release asset 上传有竞态。** 同一个 tag 下重跑 CI 会覆盖同名 APK；如果旧 run 没取消，
   它可能在新修复之后晚一步上传，把刚修好的包覆盖掉。

**修法。**

- Rust file-open 事件只在 `#[cfg(any(target_os = "macos", target_os = "ios"))]` 下引用
  `tauri::RunEvent::Opened`；Android 不编译这段。
- Android `MainActivity.kt` 处理 `ACTION_VIEW` / `ACTION_SEND` / `ACTION_SEND_MULTIPLE`，
  收集 `content://` / `file://` URI，通过 `evaluateJavascript` 推到前端的
  `shiori-android-file-open` 自定义事件，并维护启动早于前端 listener 的 pending queue。
- 前端移动端 open path 统一读 `content://`，并对无文件名 URI 做 bytes sniff：
  `%PDF-` → PDF，HTML 头部 / 常见标签 → HTML，其余 UTF-8 文本 → Markdown。
- workflow 增加 `android_only` dispatch 输入：Android-only 时 Windows / Linux job 直接
  skipped；直装 APK 只打 `aarch64`，实际体积约 20MB（Gradle 输出名仍可能带
  `universal-release.apk`，名字有点误导）。
- Android manifest 显式关闭备份：`allowBackup="false"`、`fullBackupContent="false"`、
  `dataExtractionRules` 排除 cloud backup / device transfer；`FileProvider` 收窄到
  实际导出目录。
- Android adaptive icon 前景单独做：`ic_launcher_foreground.png` 必须是透明背景的白色
  「栞」字形，居中并留足 inset；同时更新源目录 `src-tauri/icons/android/...` 和生成目录
  `src-tauri/gen/android/...`。
- 每次发现 release 包缺一个关键修复，先取消正在跑的旧 workflow，再提交 / push / 重新触发，
  避免旧 artifact 抢后覆盖。

**能让它更早暴露的那一件事。** **把 Android 当成独立平台验收，而不是 “Tauri mobile 的另一半”。**
只要一开始列出 Android 独有入口（Intent、content URI、adaptive icon、Auto Backup、
Play AAB / direct APK、CI 签名环境），就不会把 iOS/macOS 的 `RunEvent::Opened`、桌面路径、
完整 tile 图标、或本地 SDK 状态误当成 Android 真相。

**教训 / 预防。**

- 平台能力矩阵比 `IS_TAURI` 更重要。Tauri desktop、iOS、Android 都是 Tauri，但文件打开、
  更新、路径、分享、权限和图标模型完全不同。
- Android 文件入口至少测三条：App 内 picker、系统文件管理器「打开方式」、分享 / send。
  只测 picker 不够。
- `content://` 不要假设有可读文件名或后缀；要么从 provider metadata 取 display name，
  要么对 bytes 做保守 sniff。
- 移动端发布包重跑前先看 run 的 head SHA 和 release asset 上传策略；必要时取消旧 run，
  不要让并发 workflow 争同一个 tag。
- Android 图标不要盲目用桌面 / iOS 的完整 tile 生成 adaptive foreground。foreground 是
  前景层，不是整张图标。
- 本地优先产品在 Android 上要显式写隐私默认值：backup、data extraction、FileProvider
  范围、Data Safety 文案都要对齐。

Changelog: `fdd8e36`、`ef132d8`、`c01744b`。

---

## 2026-05-30 · 内嵌 Browser 面板：native child webview 是 OS 顶层，不是 DOM 元素

**症状。** 给右侧 rail 加内嵌浏览器（child webview）时，连撞了好几类问题：

- 远程网页会**盖住**偏好设置 / 导出等弹层；
- 右栏左边缘的 resize 把手**拖到 webview 上就卡死**，拖不动；
- 切到大纲 / 评论再切回，或关栏重开，浏览器**当前页面被重载**；
- Google 等桌面站点在窄栏里**右侧被截断、要左右横滑**；
- `pkill` 重启「成功」但其实没换包，**一直在测旧版**（见根因 6）；
- 想自动化跑端到端 GUI 验证，**做不到**（见根因 7）。

**根因。**

1. **native child webview 是 OS 层，不参与 DOM 的裁剪 / 层叠 / 命中测试。** 它按物理矩形浮在
   React UI 之上：z-index 管不到它（盖住弹层）、DOM 事件到不了它下面（吞鼠标）、它也不随
   DOM 滚动裁剪。这是整组症状的总根因。
2. **iframe 不是选项。** 目标站点设 `X-Frame-Options` / `frame-ancestors`，且我们的 CSP
   `frame-src 'self'` 也挡跨域 frame。要渲染任意远程页，只能用 native child webview ——
   于是必须开 Tauri 的 `unstable` feature 才有 `Window::add_child`。
3. **WKWebView 给「没有移动 viewport meta 的桌面页」用 ~980px 布局视口。** 所以桌面版
   Google 在 ~440px 面板里按 980 排版再塞进来，必然横向溢出。
4. **capability 用 `windows:` 会把权限授予该窗口下所有 webview。** `windows:["main"]`
   等于把 Shiori 的 file/pdf/terminal commands 也给了远程页 webview —— 安全洞。必须改用
   `webviews:["main"]` 精确授权，远程页 webview 不挂任何 capability。
5. **React 组件生命周期 ≠ webview 生命周期。** per-instance 的 `useRef`（已 serve 的 nonce）
   会随组件卸载重置，关栏重开就重新导航 = 重载页面。
6. **macOS BSD `pkill -f` 默认 ERE，`"a\|b"` 里的 `\|` 是字面竖线。** 旧的
   `pkill -9 -f "shiori\|open-pdf-expert"` 匹配的是字符串 `shiori|open-pdf-expert`，
   什么都没杀；`open` 看到 app 已在运行就只是聚焦旧实例 —— 每次「重启」都没生效。
7. **macOS 上无法自动化驱动 WKWebView。** 它没有 WebDriver / CDP（tauri-driver 不支持
   macOS、release 也关了 devtools），合成输入（点击 / 敲键）又需要「辅助功能」授权。
   所以「在运行的 app 里点一遍」这步只能人工。

**修法。**

- webview 的几何由**前端**负责：Browser 面板把 host `div` 的 rect（CSS/逻辑像素，取整）
  报给 Rust，Rust `set_bounds` 同步；`ResizeObserver` + window resize/scroll 跟随。
- **可见性单一真相 = `active && !obscured`**：切走 tab、resize 拖拽进行中、或任意弹层
  （设置/导出/快捷键/跳页/查找/打印/beta）打开时，一律 `hide()` webview（保活、不 close）；
  条件解除再 `set_bounds` 重新显示。拖拽时隐藏顺带解决了「吞鼠标」。
- 创建时在 **rAF 里先测量** host 再 `add_child`，否则会用兜底尺寸（已从 800 降到 420）创建、
  比面板宽。
- 给 web-panel webview 设 **iPhone Safari UA**，让响应式站点按窄屏布局自适应面板宽度。
- 已 serve 的导航 nonce 存在**模块级变量**（非 per-instance ref），组件重挂不丢 → 关栏重开
  只 `set_bounds` 重显、不重载。
- 导航历史用 **URL-邻居匹配**（当前 / 前一个 / 后一个）判定 reload / back / forward / 新导航，
  对「reload 是否触发 on_navigation」不敏感，驱动地址栏的 canGoBack/Forward。
- `Window::add_child` / `navigate` / `set_bounds` 走 wry 的 `send_user_message`，它在主线程
  会**内联执行**，所以 Tauri command 用普通 sync `fn` 调用也不会死锁。
- `pkill` 改成两条、且匹配**完整二进制路径** `Shiori.app/Contents/MacOS/shiori`（不要裸
  `shiori`，否则会误杀仓库路径下的进程，包括开发会话）。已同步更新 AGENTS.md。

**能让它更早暴露的那一件事。** **一开始就把「native webview 是 OS 顶层、不被 DOM 裁剪」
当成第一约束**：那么「弹层会被盖」「拖拽会被吞」「切 tab 要 hide 保活」「几何要前端同步」
全都是设计期就能预见的，而不是逐个撞出来。

**教训 / 预防。**

- 任何把 native surface 浮在 web UI 上的特性，先列清单：谁画在它之上（弹层 / toast / 拖拽热区）？
  它的几何谁负责同步？它什么时候必须让位？
- 多 webview 的权限**按 webview label 隔离**，永远别用 `windows:` 给「窗口下全部 webview」放权。
- 跨平台 shell 命令注意正则方言（BSD ERE vs GNU）；「重启脚本」这种东西要验证它**真的**生效，
  别只看退出码。
- 桌面 GUI 的端到端验证在 macOS 上对 agent 不可自动化时，退而求其次做**分层验证**：纯逻辑单测、
  shim/FIFO 离线测、编译产物 ACL 检查、运行截图，再加人工点检。

Changelog: 本次提交（嵌入式 Browser 面板 + 终端 `open` 路由）。

---

## 2026-05-29 · 右侧内嵌终端：外部 Terminal 不是嵌入，PTY 不是普通字符串

**症状。** 给 Shiori 右侧 rail 加“终端”入口时，第一版方案走偏了几次：

- 先打开 Ghostty / Terminal.app，只是拉起了外部 app，并没有把终端嵌进 Shiori。
- UI 还让用户先选终端应用、Shell / Claude Code / Codex、颜色配置，入口显得像设置页，
  而不是“点一下就有 shell”。
- 真正嵌入 PTY 后，zsh autosuggestion 的第一个字符变绿、后面发白；一些 ANSI 颜色
  看起来也像全被刷成白色。
- 切到大纲 / 评论后再切回终端，早期实现会卸载 `TerminalPanel`，直接 kill 掉 shell。
- 用 `display: none` 保活后，隐藏态的 `ResizeObserver` 又可能把 PTY resize 到 2×2，
  TUI / agent 界面会被挤坏。
- 终端 header 还显示 `/Users/...` 工作目录，和用户心理模型不符：路径应由 shell prompt
  自己表达，不应在 Shiori chrome 里重复一遍。

**根因。**

1. **“打开系统终端”不等于“嵌入终端”。** Ghostty / Kitty / Terminal.app 都是独立窗口。
   除非走平台私有窗口 reparenting，否则它们不属于 Shiori 的 DOM / WebView 布局系统，
   也无法自然跟随 right rail resize、tab 切换、主题和安全边界。
2. **终端输出不是普通 UTF-8 string chunk。** PTY 会吐 ANSI escape、OSC、UTF-8
   多字节字符、zsh 插件的样式序列；Rust 侧如果每个 chunk 都
   `String::from_utf8_lossy()`，跨 chunk 的多字节字符会被替换，样式序列也更容易被拆坏。
3. **Tauri event 的 `Vec<u8>` 会变成 JSON number array。** 这能保真，但大输出时会把
   IPC payload 放大得很厉害；构建日志、`cat` 大文件、Claude / Codex 输出都会放大主线程
   解析压力。
4. **React 组件生命周期不是终端生命周期。** `RightRail` 内部 tab handler 能设置
   `terminalMounted=true`，但顶部 toolbar 直接 `setRailTab("terminal")` 会绕过这个 handler。
   如果只靠组件当前 tab 条件挂载，切走时 cleanup 就会 kill 掉 PTY。
5. **隐藏不等于没有 resize。** xterm 的 fit addon 在隐藏 / 0 尺寸容器下可能算出极小
   cols/rows；后端再 clamp 到 2×2，看似“安全”，实际会把正在运行的 TUI 状态弄乱。
6. **effect 依赖里放 `t` 会把语言切换变成终端重启。** `t` 身份变化会触发 cleanup，
   cleanup 里 kill PTY；用户只是改语言，shell 却没了。

**修法。**

- 终端能力拆成窄平台抽象：前端只调用 `spawnEmbeddedTerminal` /
  `writeEmbeddedTerminal` / `resizeEmbeddedTerminal` / `killEmbeddedTerminal`；
  Rust 侧用 `portable-pty` 真正创建 PTY，xterm.js 只负责渲染和输入。
- 默认就是打开用户 shell，不给首次入口加 Ghostty / Kitty / Terminal.app / Claude Code /
  Codex 选择。用户需要跑 agent，就在 shell 里自己输入 `claude` / `codex`。
- Rust PTY 输出用 base64 chunk 过 Tauri event；前端 `atob` 成 `Uint8Array` 后用
  `TextDecoder.decode(..., { stream: true })` 喂给 xterm。这样保留 ANSI 颜色，也避免
  UTF-8 分片损坏，同时比 JSON number array 轻。
- PTY 环境显式设 `TERM=xterm-256color`、`COLORTERM=truecolor`、`CLICOLOR=1`；
  autosuggestion 默认给 `ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE=fg=8`，避免建议文字像正常输入。
- 写入 / resize 时只短暂拿全局 sessions map，取出每个 session 自己的 writer/master lock
  后再做 IO，避免全局 mutex 被慢 IO 卡住。
- reader thread 自然退出时从 session map remove 后调用 `child.wait()`，避免子进程变 zombie。
- `TerminalPanel` 一旦打开就保持 mounted；切到其他 rail tab 只隐藏 DOM，不杀 PTY。
  同时隐藏态不执行 xterm fit / PTY resize，避免 2×2 resize。
- 终端 rail 的宽度状态独立保存，并在窗口 resize 时重新 clamp；拖拽只在桌面端启用。
- 终端 header 里去掉“图标 + 终端”和路径展示；上方 segmented tab 已经表达当前视图，
  终端内容应该尽快进入 shell。

**能让它更早暴露的那一件事。** **先定义“嵌入”的验收标准：终端必须在 Shiori
右侧 rail 内自动启动、可拖拽、tab 切换不丢会话、能显示 ANSI 颜色，不能出现外部 app
窗口。** 只要这个标准一开始写清楚，“打开 Terminal.app”这条路会立刻被淘汰；PTY
字节流、组件生命周期和隐藏 resize 这些问题也会成为第一轮设计约束，而不是边试边撞。

**教训 / 预防。**

- 任何“内嵌开发工具”都先区分：是**系统 app launcher**，还是**app 内可控 surface**。
  只有后者才符合 Shiori 这种 right rail UI。
- PTY / terminal / shell 不要做字符串思维。输出按 byte stream 处理，渲染交给成熟终端
  emulator；不要自己解释 ANSI。
- 对长期运行的本地资源，生命周期要跟“用户是否关闭这个能力”绑定，而不是跟当前 React
  tab 是否可见绑定。
- `display: none` 保活组件时，所有 layout observer / fit / resize 都要知道 active 状态。
- UI 上不要让高级配置挡住默认路径。默认打开 shell；agent、颜色、默认 shell 以后都应该在
  Settings 里渐进暴露。

Changelog: `a23f703`。

---

## 2026-05-29 · “撤销跳页”其实是聚焦的离屏 textarea 劫持了 Ctrl+Z

**症状。** 在某一页编辑文字后滚动到别的页，按 Ctrl+Z 撤销，视图会自动跳回
刚才编辑的那一页。这和之前修过的「undo / redo 不再误把视图滚回当前页顶端」
是**不同的现象**——这次是跳到“正在编辑的那一页”。

**根因。** 文字编辑框是一个 `autoFocus` 的 `<textarea>`，而滚动并不会让它
失焦。滚到别的页时它仍然聚焦、只是离屏了。此时按 Ctrl+Z：因为焦点在
textarea 里，`Canvas` 的键盘处理被 `inInput` 守卫提前 return → 这个 Ctrl+Z
被 **textarea 的原生撤销**接管 → 浏览器把这个“聚焦且内容刚发生变化”的
textarea 滚回视口 → 视图跳回编辑页。app 自己的撤销逻辑（已提交路径）其实
**不会**滚动视图。

**修法。** 当 active page 离开正在编辑的那一页时，让编辑框失焦
（`OverlayLayer` 里一个 effect，`blur` 会走正常的 `onBlur` 提交；文字是
`updateOverlayNoHistory` 边打边存的，失焦不丢内容）。失焦后 Ctrl+Z 就交回
app 撤销，不再跳页。

**能让它更早暴露的那一件事。** 分清「app 撤销」与「输入控件原生撤销」。当
`document.activeElement` 是某个输入控件时，全局快捷键会被 `inInput` 守卫跳过，
按键其实由控件处理——所以跳页不是撤销逻辑的锅，而是“聚焦的离屏控件 +
浏览器 scroll-into-view”。复现时第一步先看 `document.activeElement` 是不是那个
textarea。

---

## 2026-05-16 · PDF 原文编辑的最后一公里 — 视觉选区、语义文本、覆盖层和导出不是同一个坐标问题

**症状。** v0.1.11 的 Text 工具支持编辑 PDF 原文后，连续出现几类看似
独立、实际同源的问题：

- 用户视觉上只框了 `dimension` / `normality`，但创建编辑 overlay 后会带入
  前一个词尾（例如 `e-dimensi`）或漏掉目标词尾。
- 在 Shiori 里调到看起来对齐，导出到 macOS Preview 后文字会轻微上/下/左/右
  偏移。
- 替换文字一开始没有保留原文的字体、字号、粗细、斜体。
- 完成编辑后还残留浅灰轮廓，看起来像普通阅读视图里有一个编辑框。

**根因。** 这里有三套边界，不能互相当作真相：

1. **浏览器 Selection / Range 边界。** pdf.js textLayer 为了可选中文本，会用
   DOM span、CSS transform、两端对齐宽度等手段近似原文。`nativeSelectionText`
   和 `Range.getClientRects()` 经常反映的是 textLayer 的可选区，不是 PDF
   canvas 上可见 glyph 的真实边界。用户调试里出现过 `nativeSelectionText:
   "e-dimensi"`，但用户真正想编辑的是 `dimensional`。
2. **PDF text content glyph offsets。** pdfjs `getTextContent()` 里的 run、字体、
   transform 和 glyph advance 更接近原文绘制位置，但它没有用户这次拖拽的
   语义意图，需要结合 gesture bounds 裁剪。
3. **Shiori overlay / pdf-lib export 坐标。** overlay 坐标是 PDF user space；
   预览是 DOM/CSS；导出是 pdf-lib content stream。只修其中一边会出现
   “Shiori 里看着好，Preview 里偏了”的错觉。

**修法。**

- 选区不再信任单一 native Range。用 gesture bounds 找到候选 text runs，再用
  glyph offset 对英文词、连字符、标点附近做语义裁剪 / 扩展。
- debug payload 直接打印完整 JSON 到 console，包含 native selection、gesture、
  text run、cover rect、overlay rect、font 推断等字段；用户可以复制一次日志，
  直接定位是“选区错了”还是“覆盖/导出错了”。
- content text edit 的预览和导出共用相同的 placement / font routing 逻辑：
  字体族、字号、bold / italic、颜色、背景采样、cover rect 都从原文 text run
  推断，再用 pdf-lib/fontkit 写回页面 content。
- 普通视图下不显示 content text edit 的 editor outline；outline 只属于选中 /
  编辑状态。

**能让它更早暴露的那一件事。** **不要只看截图，要保留可复制的 text edit
debug payload。** 这一版真正开始收敛，是因为日志同时给出了
`nativeSelectionText`、`selectedText`、`gestureTrimmedRunTexts`、
`coverPdfRects`、`overlay.rect` 和字体推断。没有这份结构化日志，只靠截图会把
“用户视觉选区不准”“文本 run 推断不准”“导出 placement 不准”混成同一个问题。

**教训 / 预防。**

- PDF 原文编辑不是普通 textarea overlay。它是“遮盖旧 glyph + 绘制新 glyph”的
  仿真编辑；任何看似 1px 的误差都会在高缩放或 Preview 里放大。
- pdf.js textLayer 的选择结果只能当输入信号之一。对论文 PDF，尤其是两端对齐、
  连字符、标点相邻的英文，必须回到 text content / glyph offsets。
- 预览和导出要共享 placement 语义。否则用户会在 Shiori 里调得很满意，导出后
  才发现另一个渲染器里偏移。
- 对“原文编辑”这种高风险功能，开发期就应该保留一键复制诊断，而不是等用户发
  多张截图后再临时加日志。

Changelog: `0.1.11`。

---

## 2026-05-16 · Web 最近文档刷新后点击即消失 — localStorage 记录了无法 reopen 的文件

**症状。** Web 端打开 PDF 后刷新页面，Landing 最近文档里能看到记录；点击该
记录后，记录直接从列表消失，文件没有打开。

**根因。** Web 端有两种打开路径：

- File System Access API picker：可以持久化 `webFileHandleId`，刷新后能通过
  IndexedDB 里的 handle 重新读取文件。
- 普通 `<input type=file>` / fallback：浏览器只把本次选择的 `File` 对象给
  当前页面，刷新后没有 path，也没有持久化 handle。

旧逻辑把两者都写进 `recentDocs`。刷新后 Landing 显示了 pathless /
handleless entry；点击时 `pickFromRecent()` 既找不到 Tauri path，也找不到
`webFileHandleId`，于是走 stale 分支 `forgetRecent(entry)`，用户看到的就是
“点击后记录消失”。

**修法。** 引入 `canReopenRecent(entry, IS_TAURI)`：

- Desktop：只有带 native `path` 的 recent 可展示 / 记录。
- Web：只有带 `webFileHandleId` 的 recent 可展示 / 记录。
- fallback `<input type=file>` 打开的文件不再写入最近文档；它不是可恢复的
  recent，只能算当前会话打开记录。

**教训 / 预防。**

- MRU / recent list 不是“最近发生过的事”的日志，而是“用户可点击恢复的入口”。
  不可恢复的 item 宁可不展示，也不要展示后点击删除。
- Web 文件能力要按 capability 分层，不要把 `File`、native path、
  File System Access handle 当成同一种 reopen anchor。
- 删除 recent 应该只发生在“曾经可 reopen，但现在失效”（文件被移动、权限失效）
  的路径；从未有 reopen anchor 的记录不应该进列表。

Changelog: alpha 期 web bug，记录在 postmortem，不进 0.1.11 release notes。

---

## 2026-05-16 · 手机端文字工具弹出层被屏幕裁掉 — 绝对定位绑在横向滚动 toolbar 里

**症状。** Web 手机端在 Text 工具里展开字体 / 颜色相关控件时，弹出层左侧会被
屏幕截掉一半。横向滚动 inspector 越靠近左边，越容易出现。

**根因。** 弹出层用 `position: absolute; left: 0` 挂在 toolbar 控件局部
容器下。手机端 inspector 本身为了避免工具栏占半屏，使用横向滚动承载控件；
局部 absolute popover 只知道 anchor 的局部坐标，不知道 viewport 边界，也会受
父级 overflow / scroll 影响。结果是控件在横向滚动内容里展开，而不是在屏幕可见
区域里展开。

**修法。**

- 字体选择从原生 `<select>` 改成 Shiori 自己的 fixed-position dropdown。
- `ExpandableColorPicker` 和 `FontPicker` 复用同一套 `useFixedPopoverPosition()`：
  读取 anchor 的 `getBoundingClientRect()`，按 viewport margin clamp `left/top`，
  空间不够时向上展开。
- 弹出层用 fixed backdrop 处理点击外部关闭，Escape 继续走 `useEscapeClose()`。

**教训 / 预防。**

- 放在横向滚动 toolbar / inspector 里的 popover，不应使用局部 absolute
  定位。只要目标是“覆盖在屏幕上”，就应该按 viewport 定位并 clamp。
- 手机端 UI 不是桌面工具栏缩小版。任何弹出层都要检查窄屏、横向滚动、safe area
  三件事。
- 原生 `<select>` 在不同浏览器上的弹出层不可控；如果要和自定义工具栏视觉 /
  位置行为一致，宁可用自己的 dropdown。

Changelog: alpha 期 web bug，记录在 postmortem，不进 0.1.11 release notes。

---

## 2026-05-16 · Release body 漏写 — updater notes 不是 GitHub Release 页面

**症状。** v0.1.11 发完后，updater manifest、`notes/0.1.11.json`、本地
changelog 都正确，但 GitHub Release 页面 body 仍是占位文字：
“Closed-alpha build...”。用户从 release 页面看不到这版具体改了什么。

**根因。** Shiori release flow 同时有四个“说明文字”出口：

- `CHANGELOG.md`：维护者技术日志。
- `docs/changelog/{en,zh,ja}.md`：App 内 changelog modal。
- `shiori-releases/notes/<version>.json`：updater dialog 多语言 release notes。
- GitHub Release body：公开 release 页面正文。

旧 `.agents/skills/shiori-release/SKILL.md` 只强调了 assets、`notes/<version>.json`
和 `alpha/latest.json`，没有把 GitHub Release body 作为 release blocker。
所以 updater 验证全绿，但页面说明漏了。

**修法。** 补写 v0.1.11 GitHub Release body，并把 skill 改成发布前必须检查：

- release 不是 draft；
- release body 不是 placeholder，且和 `notes/<version>.json` 的用户可见内容一致；
- asset list 包含所有平台安装包和 updater signature。

**教训 / 预防。**

- updater 能更新，不代表 release 完整。发布检查应该覆盖“机器消费的 manifest”
  和“人阅读的 release page”。
- 多个 changelog / notes 出口要显式列在流程里，否则最容易漏的是不会影响 CI 的
  那一个。

Changelog: 流程修正，已写入 `.agents/skills/shiori-release/SKILL.md`。

---

## 2026-04-28 · 个别 PDF 页画布全白 — pdf.js v5 的 `canvasContext` deprecated path 在 WKWebView 上静默不画

**症状。** beta 用户在某份 PDF 的第 22 页（pageIndex 21）上看到一片纯白。`PageCanvas.tsx` 的 `render-succeeded-but-blank` 诊断弹窗弹出来：render task 没抛异常、`done` promise 正常 resolve、canvas size 1880×2433 + viewport 940×1216 + dpr 2 全部对得上 —— 唯一异常是 7×7=49 个采样点全部是 (255,255,255,255)。也就是说 **bitmap 从未被画过**。

**根因。** `renderPageToCanvas` 调用走了 pdf.js v5 的 deprecated path：

```ts
page.render({ canvasContext: ctx, viewport, transform, ... });
```

v5 [RenderParameters API 文档](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) 原话：

> `canvasContext` — 2D context of a DOM Canvas object **for backwards compatibility**; it is recommended to use the `canvas` parameter instead. **If the context must absolutely be used to render the page, the canvas must be null.**

陷阱在最后那句：v5 的新代码路径 expects either `canvas: HTMLCanvasElement` 或 `canvas: null`。如果继续用 `canvasContext` 但**没有显式传 `canvas: null`**，所有权进入 ambiguous 状态 —— render task 仍会成功 resolve，但在某些页面（图像 mask、透明 group 等）上 bitmap 不会被实际写入，而且没有任何报错。

WKWebView 上还多一层 amplifier：诊断里 `imageDecoder: false`（WKWebView 没有 WebCodecs ImageDecoder），pdf.js v5 在新 canvas path 里有针对这种环境的 fallback，旧 path 没有。

**修法。** 一处文件、两个调用点（`renderPageToCanvas` + `renderPageThumbnail`），把 `canvasContext: ctx` 直接换成 `canvas`：

```ts
page.render({
  canvas,                  // 让 v5 新 path 接管所有权
  viewport,
  transform,
  annotationMode: ...
});
```

`getContext("2d")` 仍然作为可获得性 sanity check 保留 —— 拿不到 2D context 说明 WebView 整个画不了，提前 bail。

**能让它更早暴露的那一件事。** **PageCanvas.tsx 里那套 `render-succeeded-but-blank` 诊断（49 个采样点全白判定 + 一份带环境信息的 JSON 弹窗）就是这件事**。如果没有这个诊断，用户大概率只会反馈"那一页是空白的"，连根本不会想到 render 实际上 resolve 成功了。诊断把 invisible failure 变成 visible payload，省下来的时间是数量级的。**类似地，所有「success path 但实际无 side effect」的失败模式都值得放一个轻量诊断**（一次性采样 + 上限 N 条 LS 记录的代价远低于多轮调试时间）。

**教训 / 预防。**

- 第三方库的 "deprecated 但仍可用" 参数是**最危险的一类陷阱** —— 编译时不报错、运行时大多数 case 还能跑、就在某些边角 case 上静默失败。任何 v5 / v4 / v3 的 major bump 都要去看 RenderParameters / CreateOptions 这类入参的 deprecation 备注，不能假设旧调用形状继续等价。
- pdf.js 的 `transform: [s, 0, 0, s, 0, 0]` DPR 写法在新 canvas API 下仍然有效，**没有被自动接管** —— 升级 API 的时候要小心区分「换签名」和「换语义」，前者直接改，后者要重新做一遍 DPR 处理。
- 「render task 成功 = bitmap 已写入」这个推断对 pdf.js v5 不成立。任何渲染管线都该在最后一步加一次 sample-based sanity check（pure-white check 是穷人版的，但有效）。

修法 commit: 见本次。Changelog: alpha 期 bug，进 user-facing changelog（用户可能已经在不同 PDF 上踩到）。

---

## 2026-04-27 · Landing 桌面端 LOGO 紧贴窗口顶端 — React 内联样式里 `padding` 简写 + `paddingTop: undefined` 长写并存，长写清空覆盖了简写

**症状。** 给 Landing 加移动端适配时，hero 面板上做了条件 padding：手机用 `"32px 22px 28px"` 顶部加 safe-area，桌面保持原来的 `"clamp(40px, 6vw, 112px) clamp(32px, 5vw, 96px)"`。同时为了在手机分支单独 override 顶 padding，写了第二条 `paddingTop: isMobile ? "calc(32px + var(--shiori-safe-top))" : undefined`。

实际跑起来桌面端的栞 LOGO **直接顶到窗口顶端**，Tauri 上更糟（叠到 macOS Overlay 标题栏的 traffic lights 区域）。原以为是 mobile 分支误判 / safe-area 变量取错，浪费了一会儿才意识到 `isMobile === false` 的桌面路径 padding-top 实际计算成了 0。

**根因。** React 内联 style 的实现：把 style 对象逐键迭代，对每个 key 调 `el.style[key] = value`；遇到 `undefined` 的 value，会执行 `el.style[key] = ""`——也就是**清除**该 longhand 的内联声明。问题在于 CSS `padding` 简写设值时，浏览器内部会展开成 4 条 longhand（padding-top/right/bottom/left）。当 React 后跑到 `paddingTop` 这一键、看到 undefined、调 `el.style.paddingTop = ""` 把这条 longhand 清掉，padding-top 回落到默认 0。简写已经被拆没了，longhand 一清，整个上 padding 也就没了。

**修法。** 不要混用「shorthand + conditional longhand=undefined」这个组合。把上 padding 直接合进同一条 `padding` 简写，按分支整条切换：

```ts
padding: isMobile
  ? "calc(32px + var(--shiori-safe-top, 0px)) 22px 28px"
  : "clamp(40px, 6vw, 112px) clamp(32px, 5vw, 96px)",
```

桌面分支的 padding-top = `clamp(40px, 6vw, 112px)`，再不会被另一条 longhand 清空。

**走过的弯路。** 第一反应去检查 useIsMobile 的 matchMedia 是不是误触发；又去看 `var(--shiori-safe-top)` 是不是没回退到 0；用 DevTools 看 computed style 才看到 `padding: clamp(...) clamp(...)` 在那儿、`padding-top: 0`——简写在、长写被清——这才把锅定位到 React 的样式合并行为。

**教训 / 预防。**

- React 内联 style 把 `undefined` 当"清除"信号，不是"忽略"。和 CSS 简写 + 长写共存时，**简写设的 longhand 会被同 style 对象里 `undefined` 的同名长写擦掉**。如果非要给 longhand 写条件值，那条件分支两边都要给确定值（包括桌面那边显式给 `clamp(40px, 6vw, 112px)`），不要用 `undefined`。
- 或者更稳：**永远不要在同一个 style 对象里把简写 + 长写同时写**。要么全用 shorthand 按分支整条切，要么全用 longhand 一项一项写。两条路子都不会出这种"看似 no-op 实则擦除"的状态。
- 这种 bug 在 desktop / mobile 两端各看一眼是会被立刻发现的——HMR 出来后第一时间在两个 viewport 都过一遍，比让用户截图反馈快得多。

修法 commit: 见本次 mobile 适配 commit。Changelog: 不进 user-facing changelog（开发期 bug，未发布）。

---

## 2026-04-27 · 落地页 `/download/<plat>` 一直 fall back 到首页 — GitHub `/releases/latest` 在仓库**全是 prerelease** 时返回 404

**症状。** v0.1.7 release 发完、Cloudflare Pages Function 部署成功
（build log 里 "Found Functions directory at /functions. Uploading. ✨
Compiled Worker successfully"）后，`https://shiori.nagi.fun/download/
mac-silicon` 仍然返回 200 + 首页 HTML，没有 302 到 GitHub asset。
`/api/release` 也返回我自己写的 fallback `"Upstream unavailable"`。
排查中误以为是 functions 没被 CF 识别（结合 Build watch paths
误判一起打转了一阵），但 build log 明确显示 worker 已上线。

**根因。** Function 里调的 endpoint 是 `https://api.github.com/repos/
Nagi-ovo/shiori-releases/releases/latest`。**这条 endpoint 在所有 release
都是 prerelease 时返回 HTTP 404**——这是 GitHub API 的隐式过滤：
"latest" = 最新的*非*-prerelease release。`shiori-releases` 仓库整个
beta 周期（v0.1.4–v0.1.7）每个 tag 都标了 prerelease，于是
`/latest` 永远 404，function 走 `if (!upstream.ok) return null` 分支，
向客户端返回 fallback。

**修法。** 改用 `https://api.github.com/repos/Nagi-ovo/shiori-releases/
releases?per_page=1` 拿列表第一项。这条 endpoint 不过滤 prerelease，
返回的是按发布时间倒序的列表，`[0]` 就是最新的——无论 prerelease
flag。代价：响应是 `Release[]` 不是 `Release`，`_release.ts` 里
`getLatestRelease()` 多一行 `list[0]` 解引用。`per_page=1` 把 payload
压到最小。

**走过的弯路。** 第一反应是 CF Pages 没把 `site/functions/` 检测出来——
连续花了几次 push 调 `_routes.json`、`wrangler.toml`、build watch
paths。直到读 build log 看到 "Found Functions directory at /functions"
+ "Compiled Worker successfully"，才意识到 worker 是部署的，**function
确实在跑**——只是 fetch 失败了。本地 `curl` GitHub endpoint 一次性
看到 `HTTP 404` 才把方向掰回来。

**教训 / 预防。**

- 一个 endpoint 在文档没明示的情况下沉默地 filter 掉一类资源（这里
  是 prerelease）是经典的"隐式契约"陷阱。`/releases/latest` 看名字
  像是 "give me the newest one"，实际语义是 "give me the newest
  non-prerelease one"。**任何"latest" / "current" 类 endpoint 都值得
  本地 `curl` 一次确认它对当前数据形态的行为**，再在 function 里依赖。
- function 的 fallback 信息量不够。`return null` 然后向客户端只回
  `"Upstream unavailable"`——丢失了 upstream 的状态码、响应头、错误
  body。考虑给 fallback 路径附上 `console.error()`（CF Workers 的日志
  在 dashboard → Real-time logs 可见）或者把状态码 echo 到响应里
  （以 `X-Upstream-Status` header 形式），下次诊断不用本地复现。
- beta 阶段把所有 release 标为 prerelease 是 release.yml 默认
  行为；任何依赖 `/releases/latest` 的下游（落地页、scripts、CI 脚本）
  都要先 audit 一遍。`Nagi-ovo/shiori-releases` 仓库的 `alpha/latest.json`
  manifest 是手动维护的，不走 GitHub API，所以 unaffected——但下次
  接其他依赖时记得这个语义。

修法 commit: `ac8287b`。Changelog: 不进 user-facing changelog（基础设施
bug，对 app 用户透明）。

---

## 2026-04-26 · v0.1.6 CI 没产 .msi.sig / .AppImage.sig — `createUpdaterArtifacts` 在 conf 里关着、本地脚本却用 `--config` 强行打开

**症状。** v0.1.6 tag push 后 release.yml 的 build-windows / build-linux
两个 job 都跑 `success`，artifacts 也按预期上传到了 shiori-releases，
但盘点资产时发现只有 `.msi` / `.AppImage` / `.deb`，缺了
`Shiori_0.1.6_x64_en-US.msi.sig` 和 `Shiori_0.1.6_amd64.AppImage.sig`。
两个 sig 是 Tauri updater 认证安装包的依据，没了它们 Windows / Linux
client 自动更新会被打回。本地 macOS 那条管线 sig 完整。

**根因。** `src-tauri/tauri.conf.json` 里 `bundle.createUpdaterArtifacts`
被关成 `false`（v0.1.5 处理某个 case 时改的）。本地 `scripts/build-signed.sh`
最近补了 `--config '{"bundle":{"createUpdaterArtifacts":true}}'` 的
override，所以本地 mac dmg 还能正常拿到 sig；CI 那两个 job 跑的是
裸 `bun run tauri build`，吃的是 conf 里的 `false`，silently 不产 sig。
upload 步骤里的 glob 是 `*.msi.sig` / `*.AppImage.sig`，配 `nullglob`
匹配空集合后 `for` 循环什么也没传给 `gh release upload`——既不报错也
没东西上传，logs 看上去就是 "Uploading <main artifact>" 单独一行。
用 v0.1.4 / v0.1.5 release 的 asset 列表对照才能发现少了两条。

**修法。** `tauri.conf.json` `createUpdaterArtifacts` 改回 `true`，让
全部入口（本地 + CI 两个 job）都默认产 sig；force-move v0.1.6 tag 到新
commit，CI 重跑，`--clobber` 覆盖 Win / Linux artifacts，sig 这次跟着上
传。本地 mac dmg 不需要重 build，它的 sig 早就对。

**走过的弯路。** 看 CI logs 时第一反应是 upload step 哪里写错——
\`shopt -s nullglob\` + \`*.sig\` glob 是过去 v0.1.4 / v0.1.5 验证过的
模式，不是嫌疑犯。差点去改 workflow yaml 加 \`set -x\` debug 输出，最
后注意到 release upload step 整段不打印任何 ".sig" 文本——证明
\`appimage_sigs\` / \`msi_sigs\` 数组是空，问题在它们之前的 build step
就没生成 sig 文件，回头去查 \`createUpdaterArtifacts\`。

**教训 / 预防。**

- `createUpdaterArtifacts` 是个**全局 toggle**，关掉后 sig 文件直接
  消失而 build 仍 success——这是 silently 失败的最差情形。任何"为了
  本地 debug 临时关 updater"的行为，**绝对不能 commit 进 conf**；要
  么用 \`--config\` 命令行 override（CI 不动），要么 git stash 改动。
  本次坑是对方的修复路径走的是改 conf 然后让 build-signed.sh override
  回来——CI 没走 build-signed.sh 这条路。
- release flow 的 acceptance test 应该校验**预期 asset 集合**而非
  job 是否 success。`.agents/skills/shiori-release/SKILL.md` 已经写了
  release 后跑 `verify-updater-manifest.mjs`——把它扩成"检查
  release 上的 sig 文件是否存在"会是更早的报警。
- Tauri build step 的 logs 里 sig 生成是**沉默的**（不报错也不报成
  功），只能看 `target/release/bundle/` 里有没有文件。可以在 workflow
  里 sig glob 之前加一句 `ls target/release/bundle/{msi,appimage}/` 让
  期望物可见。

---

## 2026-04-26 · 平滑缩放第一帧卡顿 — Zustand 同步 vs React state 异步的反应度错位

**症状。** 触摸板 pinch 缩放，**手势刚开始的那一帧明显卡，甚至不跟手**，
之后才顺。Cmd+滚轮也一样。

**根因。** `scale` 走 Zustand（`useSyncExternalStore`，**同步**当帧推到
订阅者），`gestureZooming` 是 `useState`（React 调度器**异步批处理**）。
gesturestart 触发 `setGestureZooming(true)` 排队等下个 commit；紧接着
第一个 gesturechange 调 `setScale(...)`，Zustand 立刻把新 scale 推到
`PageCanvas`——此时 `gestureZooming` prop 还是 `false`。effect 看到
scale 变了、prop 没说在缩放，跑了一次完整 pdfjs 重渲染（~100 ms 主线程
占用），后续 gesture 事件全堵在后面。等 React commit 上来已经晚了。

**修法。** `Canvas.tsx` 维护的 `gestureZoomingRef`（同步赋值）也透到
`PageCanvas`，effect 顶端用 `gestureZooming || gestureZoomingRef?.current`
双重 gate。Zustand 推 scale 的瞬间 ref 已经是 true，直接 skip。

**教训。** 同一组件里有两套反应度系统（Zustand 同步 + React state 异步）
时，**任何依赖"两个值同时是新的"的逻辑都要用 ref 做同步兜底**，不能假
设 React 把它们 commit 到一起。

---

## 2026-04-25 · 自建高亮右侧溢出 — justified text 让 selection rect ≠ 可见 glyph

**症状。** 学术 PDF 上拖文字加高亮，每行右边缘越过最后一个 glyph 几个到
几十像素，**每行溢出量不同**——行尾是 "on" 几乎不溢出、是 "avoid" /
"the" 那种则溢出最多。

**真因。** 学术 PDF 是**两端对齐 (justified)**。pdfjs textLayer 把每行
渲染成一个 `<span>`，`canvasWidth` = 边距到边距的整行宽度，再用
`transform: scaleX(...)` 把透明文字拉伸去填满；但 canvas 上实际绘制的
glyph 停在 PDF 原始 char position（不延伸到右边距）。`Range.getClientRects()`
返回的是 textLayer span 的右边界（= canvasWidth），**不是 canvas 上
glyph 的真实位置**。每行溢出量 = 最后一个 glyph 到右边距的距离，变量。
所以**任何基于 selection rect 几何做的后处理都解不了**。

**走过的弯路（值得记一笔）。** 改了 4 轮才走到真因：(1) 纵向 + 横向固定
比例 trim、(2) `canvas measureText().actualBoundingBoxRight` 算 ink 右边、
(3) 给 `.textLayer` 隔离 `font-family: system-ui`、(4) 加诊断日志。每轮
都 build/lint/test 全过、用户实测仍溢出——CI 绿色给了**虚假的安全感**。

**修法。** 改用上游真实数据：pdfjs `page.getTextContent()` 返回的每个
`TextItem` 都有 `transform` 矩阵和 `width`，能算出每个 text item 在
display space 的**真实边界**。新增 `textContentToDisplayTextRuns()`
做转换，`TextHighlightLayer` 渲染 textLayer 时按 `textDivs` index 缓
存 runs，提交高亮时 `snapDisplayRectsToTextRuns()` 把每行 rect 的高度
对齐到该行 glyph ink 边界（拿不到 glyph metrics 时回退到 pdfjs
ascent/descent），并把右边界 cap 到 text run 的真实右边缘。半行/词中
结束的选区天然不裁错——cap 只在 `rect.right >= textRun.right` 时生效。
后续补坑：`i` / `l` / `t` / `:` 这类窄 glyph 或半角标点容易被硬 cap
切半，selection rect snapping 的左右边缘都要留一点随字号变化的余量。

**已知的 cosmetic 不修。** 浏览器**原生选区蓝框拖动时**仍越过 glyph
（pdfjs 官方 viewer 也是这行为）；要修得用 `selectionchange` 算虚拟
选区覆盖原生，代价大、和上游不一致，接受现状——松手 commit 后保存
的 rect 是对的。

**教训。**

- pdfjs textLayer 的 DOM 几何**故意**和 canvas 视觉几何脱钩（为了 Cmd+A
  全选 / 跨行选这类正确性）。基于 selection rect 后处理的高亮逻辑在
  justified 文档上一定会失败；要拿视觉真值就用 `getTextContent()` /
  `TextItem.transform`。
- 回归排查的第一动作应该是 `git log --oneline | head` 找疑犯 commit，
  不是直接改代码。
- "build pass + lint pass + 用户没数据" ≠ 修好了。修对的唯一证据是
  用户在真实场景复现一次。

---

## 2026-04-25 · 缩略图 overlay compositor 在 rail 较窄时只画出页面左上角

**症状。** 给 thumbnail rail 加了 overlay 合成层之后（`thumbnailCompositor.ts`），
有 overlay 的非空白页 thumbnail 看上去像是只显示了 PDF 页面**左上角的一小块**——
ink 曲线的下半段、靠右的 stamp、靠下的文字框全部被裁掉。空白页和无 overlay
的页（比如第一页只显示原 PDF 内容）看上去正常，所以一开始误以为是 overlay
绘制坐标算错了。

**根因。** 不是坐标，不是 DPR，不是 `pdf.js` 的 transform 残留。**是 canvas
的 DOM 显示尺寸合约和 tile 的响应式尺寸合约不一致**。

- `pdfjs.ts` 里 `renderPageToCanvas()` 在每次渲染时会把 canvas 的 inline
  style 写成**固定像素**（比如 `style.width = "168px", style.height = "217px"`）。
  这是为主画布 `PageCanvas` 设计的——主画布有固定尺寸的页面容器，绝对定位
  贴上去。
- thumbnail tile 是**响应式宽 + aspectRatio**：`width: 100%` 占满 rail
  cell，高度由 `aspectRatio: ${w}/${h}` 推算。rail 有 `padding: 10` 内边距，
  实际 tile 宽度 = rail 宽度 - 20px，可能小于 168px。
- canvas 作为 tile 内的 flex 子项，靠 `maxWidth: 100%, maxHeight: 100%`
  尝试缩放回 tile 内。但 `maxHeight: 100%` 在 flex/aspectRatio 上下文里
  解析到 definite block-size 不可靠；当 canvas 的 inline 固定 px 比 tile
  实际尺寸大、又不能可靠缩回时，canvas 就从 tile 的右下溢出，再被 tile
  的 `overflow: hidden` 裁成左上一块。
- pdfjs 渲染的内容和 overlay 都会被一起裁，但 overlay 暴露得更明显，因为
  用户对自己加的标注是"应该全部能看到"的预期；论文 PDF 第一页底部留白多，
  裁不裁不容易察觉。

**修法。** 分离两个职责：

1. `prepareThumbnailCanvas()` 只负责 canvas 的 **bitmap 尺寸**（按 DPR
   建立 `canvas.width / canvas.height`）。不再写 `style.width / height`
   的固定 px。
2. 新增 `fitThumbnailCanvasToTile()`，把 `style.width / height` 设成
   `100%`。空白页用 paper 直接调用它；非空白页在 `renderPageToCanvas()`
   之后**立即重新调用**——因为 pdfjs 会覆盖 inline style。
3. thumbnail canvas 的 DOM 布局改成 `position: absolute; left: 0;
   top: 0; width: 100%; height: 100%`，不再做 flex 子项依赖 max-* 缩放。
4. 加单测锁住"bitmap = viewport × dpr / CSS = 100%"这个合约
   （`thumbnailCompositor.test.ts:37`）。

**教训 / 预防。**

- `renderPageToCanvas()` 这种工具函数对调用方的 DOM 布局假设是**隐式的**
  ——它替你写 inline style 是为了某种场景方便，但搬到另一种布局里就会
  打架。引入这种工具到新场景时，先看它对 canvas style 做了什么，再决定
  是否要立即覆盖。
- "bitmap 尺寸" 和 "DOM 显示尺寸" 是两件事。canvas 的 `width`/`height`
  属性是位图，`style.width`/`style.height` 是显示。混着一起写最容易踩
  布局合约不一致的坑——尽量让一个函数只做一件事，加测试锁合约。
- `maxHeight: 100%` 在 flex 子项 + 父容器只用 `aspectRatio` 推高度的场
  景里行为不可靠（不同浏览器、不同 CSS 解析阶段表现不一）。需要严格填
  满父容器时，用 `position: absolute; inset: 0; width: 100%; height: 100%`
  更稳。

---

## 2026-04-25 · ChangelogModal 关闭按钮被嵌套滚动条挤到看不见的几十像素里

**症状。** 用户点 Settings → 版本号打开 ChangelogModal，看完想点底部"关闭"
按钮关掉，发现按钮要么贴到 modal 右下角几乎看不出来，要么完全要把鼠标
放在底部某个特定位置滚动一段才能露出来。日文 / 中文 changelog 内容比英文
更长时尤其明显。用户最初以为是按钮位置写错了，反复反馈"卡到屏幕外"。

**根因。** ChangelogModal 自己在 `<Modal>` 里又套了一层固定高度的滚动
容器：

```tsx
<Modal>
  <div lang={...} style={{
    maxHeight: "min(70vh, 720px)",
    overflowY: "auto",
    paddingRight: 4,
  }}>
    {markdown}
  </div>
  <div style={{ marginTop: 18 }}>
    <button>关闭</button>
  </div>
</Modal>
```

而 `Modal` 自己的 body 也是 `flex: 1 1 auto, overflowY: auto`。两层
`overflow: auto` 在同一条 flex 列里同时存在 + Modal box 有
`maxHeight: 90%`，让数学变得很糟：

- viewport 较小时（比如 700px），Modal 高度 ~ `90vh - header`，body 可用
  高度只比内层 `70vh` 多几十像素
- 内层那个 div 已经吃满 70vh，按钮 + `marginTop: 18` 又要 ~50px
- body 自己的剩余空间装不下按钮，于是按钮被压到 body 自身的滚动区里
- body 上没有可见的滚动条提示（被 Modal box 的 `overflow: hidden` 吞了），
  用户只能用鼠标滚轮在按钮所在区域硬滚几十像素才看得到

第二个相关坑：Modal 的 `maxWidth: "100%"` 只防御父 flex 容器，flex
item 默认 `min-width: auto` 等于 min-content，长不可断 token 仍可能
把 modal box 撑过 viewport，让右上角 × 视觉上贴边或被截。

**修法。** 三处改动，全在 `src/editor/components/ui.tsx` 和
`ChangelogModal.tsx`：

1. 把 `Modal` 加 `footer?: ReactNode` 可选 slot。footer 用 `flex: 0 0
   auto` 钉死在 modal 底部，body 滚动多远都不影响 footer 可见。
2. ChangelogModal 拿掉嵌套滚动 div（连同 `maxHeight: min(70vh, 720px)
   / overflowY: auto / paddingRight: 4`），让 Modal body 当唯一滚动容
   器。"关闭"按钮挪进 footer prop。
3. Modal box 加 `maxWidth: "min(100%, calc(100vw - 40px))"` +
   `minWidth: 0`，body 加 `overflowX: hidden` + `minWidth: 0`，防止
   长不可断内容把 modal 撑过 viewport。
4. 顺手把右上角 × 改成 `position: absolute; top: 14; right: 14` 钉死
   在 modal 框 corner，不再依赖 header flex 右内边距。

**教训 / 预防。**

- **嵌套滚动是 modal 类组件的反模式**。一个 modal 里只该有一个滚动
  容器。当 modal 自身已经是 `overflow: auto + max-height: 90vh` 的
  flex 列时，children 再加任何 `overflow: auto + max-height` 都会
  和外层抢空间，并且**外层那条隐形剩余滚动**对用户完全不可发现。
- 行动栏（关闭、保存、确认）这种永远要可见的元素必须用
  `position: sticky/absolute` 或 footer slot 的 `flex: 0 0 auto`
  从滚动容器里拎出来，不能跟可滚动内容混在同一 flex 列。
- flex item `min-width: 0` 几乎是布局调试万能补丁。任何时候 flex
  item 莫名其妙比父大，先试 `min-width: 0`；这是 CSS 默认
  `min-width: auto` 在历史包袱下唯一合理的应对方式。

---

## 2026-04-25 · v0.1.2 release 页意外挂上了 v0.1.1 的 Windows 安装包

**症状。** 推 `v0.1.2` tag 后 Windows release workflow 跑成功，但
`Nagi-ovo/shiori-releases` 上的 `v0.1.2` release 同时出现了
`Shiori_0.1.1_x64-setup.exe` 和 `Shiori_0.1.1_x64_en-US.msi`。文件名带的
是上一个版本号 `0.1.1`，和同时上传的 `Shiori_0.1.2_x64_en-US.msi` /
`Shiori_0.1.2_aarch64.dmg` 混在一起。用户下载时容易拿错版本。

**根因。** `.github/workflows/release.yml` 的 cache 配置：

```yaml
- uses: actions/cache@v4
  with:
    path: |
      ~/.cargo/registry
      ~/.cargo/git
      src-tauri/target
```

整个 `src-tauri/target` 被缓存 / 恢复来加速 Rust 增量编译，但这个目录里
同时也包含上次 release 构建产出的 `target/release/bundle/msi/*.msi` 和
`target/release/bundle/nsis/*.exe`。Tauri bundler 每次 build 只**追加**
新版本的产物到 `bundle/` 子目录，不会清理上一次留下的旧版本文件。于是
缓存恢复后 bundle 目录里共存两个版本的 MSI / EXE。上传步骤用的是

```bash
msi_files=(src-tauri/target/release/bundle/msi/*.msi)
nsis_files=(src-tauri/target/release/bundle/nsis/*.exe)
```

glob 匹配到所有 MSI 和 EXE，全部一并 `gh release upload` 到同一个
release tag 上。额外的坑：`b2b5aa6`（Drop NSIS）已经把 NSIS 从 bundle
targets 里拿掉，本次 build 根本不产 NSIS，但上次 v0.1.1 产出的
NSIS .exe 仍然躺在缓存里被 glob 扫到。

**修法。** build 前主动清 `src-tauri/target/release/bundle`。这个目录
总是由 tauri bundler 从头生成，不承担增量编译的价值；清掉零代价。
Rust 的增量编译缓存在 `target/debug` 和 `target/release/deps` 等子目录，
不受影响。

```yaml
- name: Clear stale bundle outputs from restored cache
  shell: bash
  run: |
    rm -rf src-tauri/target/release/bundle
```

对已发布的 v0.1.2 release，旧文件用
`gh release delete-asset v0.1.2 <filename> --repo Nagi-ovo/shiori-releases`
手工清除。

**教训 / 预防。**

- 缓存粒度要和"会被清零的构建产物"对齐。`target/release/bundle` 是每
  build 全量产物，不该进 cache 覆盖窗口。下一轮优化可以把
  `bundle/` 从 cache path 里排除掉（actions/cache 支持 `!` 排除），或者
  像现在一样每次 build 前 `rm -rf`。
- 上传 release 产物的 glob 不应无差别匹配整个目录。即使 build 产出被
  清理过，只要存在两个版本的可执行文件，glob 仍会一并上传。未来加强
  的话可以在 shell 里读当前 `Cargo.toml` / `tauri.conf.json` 里的版本
  号，`if [[ "$f" == *_${VERSION}_* ]]` 过滤一遍。
- release CI 成功 != release 内容正确。workflow 的 exit code 只证明
  脚本跑完，不证明上传的文件清单是预期值。下一轮可以在脚本尾部打印
  最终 `gh release view --json assets` 的资产列表，便于人工 review。

---

## 2026-04-23 · 中文 LaTeX PDF 里全部 CJK 字符静默丢失

**症状。** 用户用 Shiori 打开一份 LaTeX 编译的中英混排 PDF，**所有中文字符
都渲染不出来**，只剩拉丁字母（"AI"、"LLM"、"Tech Lead"、"taste"）。同一份
PDF 在 macOS Preview / Chrome 里一切正常。

**根因。** `src/pdf/render/pdfjs.ts` 的 `loadPdfFromBytes` 里调用
`pdfjsLib.getDocument({ data: forPdfJs })`——**没有传 `cMapUrl` /
`cMapPacked` / `standardFontDataUrl`**。

pdfjs 对 CID 字体的解码依赖这些外部资源：
- `cMapUrl` + `cMapPacked: true`：指向 `pdfjs-dist/cmaps/`，里面的
  `.bcmap` 文件是 CID → Unicode 的映射表，CJK CIDFont 几乎全靠它
- `standardFontDataUrl`：指向 `pdfjs-dist/standard_fonts/`，提供 14 个标准
  PostScript 字体的 fallback 数据

不传这三个参数时，pdfjs **不会报错**，会 "尽力而为"：拉丁字符用浏览器内置
fallback 能画出来，但 CJK CIDFont 找不到 CMap 后直接返回空字形，页面里
一大片空白——而且不触发任何错误回调，排查时容易被 "没报错所以字体没问题"
的假象误导。

**修法。** 在 `vite.config.ts` 里加一个本地插件
`pdfjsStaticResources`，不引入第三方依赖：

- `configureServer` 中间件：拦截 `/cmaps/*` 和 `/standard_fonts/*`
  两个请求前缀，直接 stream `node_modules/pdfjs-dist/` 下的对应文件。
  `.bcmap` 和 `.pfb` 用 `application/octet-stream`，`.ttf` 用 `font/ttf`。
- `buildStart`：遍历两个目录，用 `this.emitFile` 把文件作为 asset 发到
  `dist/cmaps/` 和 `dist/standard_fonts/`，保持字节一致。

`getDocument` 改为：

```ts
pdfjsLib.getDocument({
  data: forPdfJs,
  cMapUrl: new URL("cmaps/", location.href).toString(),
  cMapPacked: true,
  standardFontDataUrl: new URL("standard_fonts/", location.href).toString(),
});
```

**教训 / 预防。**

- pdfjs-dist 的"开箱即用"默认配置**只对拉丁字母和系统字体完整**。任何 CJK、
  数学符号（Type 3 bitmap）、嵌入 CIDFont 的场景都要显式传 cMap 和
  standard font 资源 URL。接入 pdfjs 的第一件事就应该把这两条 URL 配上。
- 这类 "部分字形静默失败" 的 bug 看起来像字体缺失，但 console 不会有异常，
  网络面板也能看到正常返回——因为根本没去 fetch 资源。排查时先检查
  `getDocument` 的 options，再查 font fallback。
- 代码审读无法发现这类问题。见下一条。

## 2026-04-23 · Codex 代码审读漏掉 runtime-only bug

**症状。** 第一轮让 codex 对 "Shiori 显示 LaTeX PDF 是否完整" 做代码审读，
它的结论表里 **Visual rendering: Works**，证据引到
`src/pdf/render/pdfjs.ts:66`、`Canvas.tsx:446`，说 "pdf.js 用 `getDocument`
+ `page.render` 走标准路径，Type 3 / CIDFont / 嵌入字体都没被绕过"。
但用户实际打开中文 LaTeX PDF，**所有 CJK 字符全丢**（见上条复盘）。
也就是说审结论明确错了。

**根因。** Codex 只读了代码、核对 API 调用形状，**没有用一份真实文档
在 runtime 里验证过**。`getDocument` 的调用写法规范、没有可疑的 bypass，
但缺一个 options 就触发了静默失败。这类 bug 在源码里看不出来——你得真
把一份 CJK PDF 喂进去才会表现。

**修法。** 修法是上一条。这条记录的是**流程教训**，不是技术修法。

**教训 / 预防。**

- 对以下类别的问题，Codex 纯代码审读的结论**必须**由用户或自动化测试
  在真实场景里验证一次，才允许打勾：
  - 外部资源加载（字体、CMap、worker、wasm、远端 asset）
  - 平台依赖 API 行为（Tauri plugin / BrowserKit / WebKit 差异）
  - 第三方库的 "未传参数时的默认行为"——尤其是没有编译期报错的配置坑
  - 与真实文档格式的兼容性（PDF 的数千种边角、字体嵌入方式等）
- 在派 codex 审读时写进 prompt：`对于涉及外部资源 / 平台依赖 / 第三方
  默认配置的条目，结论里要明确标注 "needs runtime verification"，不要
  直接判通过`。
- 更广义的规则：**"API 调用形状正确" ≠ "功能正确"**。配置参数不足、默认行为
  静默、环境假设等都是源码里看不到的失败模式。

## 2026-04-23 · 大纲点击高亮让同页兄弟条目一起变暗

**症状。** 给右侧栏 outline 加"点击 5.2 后 5.2 亮起来"的选中指示之后，
用户发现**点 5.2 还会把 5.1、5.3 等同页兄弟条目一起涂暗**——看起来像
"一片都被选中"，而不是只点了一个。Night 主题下尤其明显，整排变成
陷下去的深色面板。

**根因。** `RightRail.tsx` 的 `OutlineItem` 并存两套视觉状态：

- `active = node.pageIndex === activeSourceIdx`——视口当前所在页的
  全部同页条目都满足，**这是在跟踪位置的**；
- `clicked = itemKey === lastClickedOutlineKey`——只有被点击的那一条
  满足，**这是在跟踪选择的**。

两者都对 background、border、粗体字生效，但没有定义优先级。于是点
5.2 之后：

- 5.2：`clicked = true, active = true` → 走 clicked 的 `T.accentGhost`
  分支；
- 5.1 / 5.3（如果同页）：`clicked = false, active = true` → 拿到 active
  的 `T.paper` 背景（Night 下 `#111418` 比侧栏 `T.cream` 还暗）+
  `T.ink` 边框 + 粗体字。**也就是"被激活的兄弟条目"拿到了仅次于
  clicked 的次强视觉。**

用户接收到的信号是"这一片都被选中"，实际上只是 active 状态在同页上
扩散。

**修法。** 把 active 变成 clicked 的**降级回退**，而不是并列：

```ts
const active =
  !hasClickedOutlineSelection &&
  node.pageIndex != null &&
  node.pageIndex === activeSourceIdx;
```

只要当前文档作用域里存在任何被点击的 outline 条目，**整棵树的 active
页级样式都被抑制**；换文档 / 关文档后旧 `lastClickedOutlineKey` 与新的
`outlineScopeKey` 不匹配，等效清空 clicked 状态，此时 active 回来做轻量
页级提示。

**教训 / 预防。**

- 往一个已经有"跟踪位置"视觉状态的 UI 上叠加"跟踪选择"视觉状态时，
  **两者必然会在选中项的同页兄弟上相撞**。写代码时要显式定义谁吃谁；
  没显式优先级 = 最弱的被激活兄弟视觉上跟选中状态难以区分。
- 判断这类坑的一句话：**"一次点击会让多少个元素视觉上发生改变？"**
  如果答案不是 1（或者不是一个你预期能明确说出的集合），大概率是
  两套状态系统碰了头。
- 对将来要加的 hover / active / selected / current / focus 等状态也
  适用：设计时先写谁优先级高、谁被别的状态强制 off，比事后靠
  `&&` 打补丁要便宜得多。

---

## 2026-04-23 · trackpad pinch zoom 让 active page 乱跳

**症状。** 给 PDF 视图加 macOS trackpad 双指 pinch zoom 后，用户慢慢缩放时，
左侧 active-page 指示、右侧 outline 的当前页 fallback 会在多页之间快速跳；
视口也像是在被随机拖走。用户只是想围绕手指下方内容缩放，不是在翻页。

**根因。** `Canvas.tsx` 同时做了两件互相打架的事：

- pinch 触发 `setScale()`，页面高度随 scale 改变；
- `react-virtuoso` 在 item 高度重测和 scrollTop 调整过程中反复触发
  `itemsRendered`，而 `itemsRendered` 会按当前可见页写 `activePageId`。

缩放期间这些 `itemsRendered` 事件是布局重测噪声，不是用户导航。把它们当成
导航，就会导致 active page 在中间态页之间来回跳。

另一个坑是滚动锚点。初版用：

```ts
scrollTop = contentY * ratio - anchorY;
scrollLeft = contentX * ratio - anchorX;
```

这个公式假设整个虚拟内容高度同步线性缩放。但 Virtuoso 的 item offset 会在
React render / DOM layout / 虚拟列表重测之间分阶段更新，`requestAnimationFrame`
之后也不一定已经有稳定的全局 content 坐标。

**修法。**

- 本地加 `gestureZoomingRef`，wheel-with-`ctrlKey` pinch 时置 true，并用
  `gestureZoomEndTimerRef` 在最后一次 wheel 后约 250ms 清掉；WebKit
  `gesturestart/change` 置 true，`gestureend` 立即清掉。
- `itemsRendered` 里如果 `gestureZoomingRef.current` 为 true，直接跳过
  `setActivePage`。缩放结束后正常滚动再恢复 active-page 追踪。
- 锚点从"全局 scrollTop 比例"改成"页内锚点"：缩放前找到 cursor 最近的
  `[data-shiori-page-id]` 和 cursor 在该页 rect 内的偏移；缩放后找到同一页的
  新 DOM rect，用 `pageRect + offset * ratio` 把 cursor 下方内容拉回原处。
  如果该页被虚拟列表卸载，再退回全局 ratio 公式。

**教训 / 预防。**

- 在虚拟列表里，**缩放不是普通滚动**。scale 改变会触发布局重测、item offset
  重算、scroll 修正；这些中间态不能直接驱动"当前页"这类语义状态。
- 任何会改变 item 尺寸的交互（zoom、fit width、旋转、页面 margin 调整）都要问：
  "这个过程中 `itemsRendered` 是用户导航，还是布局噪声？" 如果是后者，要有
  本地 in-flight guard。
- 对 PDF 视图做 cursor-centered zoom 时，优先用**页面 ID + 页内偏移**做锚点；
  少依赖虚拟列表的全局 scrollTop 线性比例。

---

## 2026-04-23 · 高亮合并 y-band 容差把相邻行吞成一条

**症状。** macOS Preview 风格的高亮合并/切换 (`src/editor/highlights/merge.ts`)
刚上线，在 arXiv 论文上拖选一行局部文字，结果画成整行铺满；跨两行拖选，画成
两行之间一整块跨行矩形。输入选区是正确的窄 rect，输出被无故撑开。

**根因。** `merge.ts` 初版把 "同一行" 判成 "y-band 间隙 ≤ 2pt"：

```ts
const LINE_TOLERANCE_PT = 2;
function sameLineRange(y1, y2, band) {
  return Math.min(y2, band.y2) - Math.max(y1, band.y1) >= -LINE_TOLERANCE_PT;
}
```

`overlap >= -tolerance` 等价于 `gap <= tolerance`。LaTeX / 密集科学排版的行距
常常正好落在 2pt 附近，相邻真实文本行因此被 `buildBands` 合并进同一个 band；
band 的 `y2 = max(band.y2, y2)` 把带高度拉成跨行；横向的
`EDGE_TOLERANCE_PT = 0.75pt` 又顺手把相邻行的 x-interval 做 union。最终一个
跨行大块 rect 取代了真实选区。

**修法。** `sameLineRange` 改成要求 **正的 y overlap**，且至少覆盖较短带高度
的一半：

```ts
const LINE_OVERLAP_EPS_PT = 0.1;
const LINE_OVERLAP_RATIO = 0.5;
function sameLineRange(y1, y2, band) {
  const overlap = Math.min(y2, band.y2) - Math.max(y1, band.y1);
  const shorter = Math.min(y2 - y1, band.y2 - band.y1);
  return overlap >= LINE_OVERLAP_EPS_PT && overlap >= shorter * LINE_OVERLAP_RATIO;
}
```

横向 `EDGE_TOLERANCE_PT` 不动——跨字的 0.75pt 字符间距仍然需要融合。

**教训 / 预防。**

- PDF 文本行的 y-band 判等**用 overlap（相交），不要用 gap（间距）**。行距
  本来就在 0-3pt，gap-based 容差对密排版永远会误报。写代码时的直觉
  "再宽松点就更稳" 在这里是反的。
- `LINE_TOLERANCE_PT` 这个名字会骗人——听起来像 "同行判定的宽松度"，实际含义
  是 "吞掉行间距"。改成 `LINE_OVERLAP_*` 从命名层面就锁死了语义方向，下次
  若有人觉得 "相邻行应该合并得更积极些"，至少要先改名才能调参。

---

## 2026-04-23 · PDF 导出体积、可编辑批注、Preview 兼容性连环坑

**症状。**

1. 原始 PDF 只有约 500 KB，用户只加了几个中文文字批注、几笔画、框和高亮，
   可编辑导出后变成约 7.6 MB。
2. 打开 Shiori 导出的 PDF 再导出一次，体积会继续线性上涨：约 7 MB →
   14 MB → 21 MB。
3. 用户恢复草稿后把新增内容全部删除，再导出，文件仍然比原始 PDF 大几 MB。
4. Chrome PDF viewer 中 stamp 对勾只显示成一个有颜色的框；macOS Preview /
   Safari 中中文 FreeText 显示成乱码或感叹号；高亮在部分外部编辑器里不像
   可编辑文本标记。
5. 删光编辑后下次打开仍提示“恢复上次的编辑”；底部缓存占用在设置里删除草稿后
   不刷新，还可能留下 orphan operation log。

**根因。**

- **DA-only FreeText 不是真正的外观。** 只写 `/FreeText` 的 `/Contents` 和
  `/DA`，没有 `/AP /N` appearance stream 时，各个 viewer 会自行生成外观。
  Chrome、Preview、Acrobat/PDF Expert 的行为都不完全一致。stamp 用 Zapf
  glyph 走 FreeText 尤其不稳定，Chrome 会只画出注释框/背景。

- **CJK 字体路径有两个相反的坑。** 早先为了绕开
  `pdf-lib + @pdf-lib/fontkit` 在“CJK subset 字体只被 `/DA` 引用、没有画进
  content stream”时卡死的问题，把 editable annotations 改成整字体嵌入。
  这避免卡死，但一个中文字批注就会把 `NotoSansSC-Regular.otf` 整包带进 PDF，
  体积直接涨到约 7 MB。后来改回 subset 后，macOS PDFKit / Preview 又不能稳定
  渲染 pdf-lib 生成的 CJK subset 字体，即使 Chrome 能显示。

- **`copyPages()` 会忠实复制旧批注和旧字体资源。** Shiori 打开自己导出的 PDF
  时，会把 PDF annotation 导入成 overlay；再次导出时，如果不先剥离源页上的
 旧 Shiori annotations，`copyPages()` 会带着旧 `/Annots`、旧 `/AP`、旧字体资源
  一起进新 PDF，然后 exporter 又写一份新的 annotation。annotation 数量和字体
  资源都会重复。

- **“没有 overlay”不等于“可以重写 PDF”。** 即使 overlays 被删空，若继续用
  pdf-lib load/copy/save 原 PDF，某些压缩良好的源文件会因为对象重写、xref/object
  stream 结构变化而膨胀几 MB。没有实际改动时应该直接返回原始 bytes。

- **草稿存在不等于有真实编辑。** autosave 之前只看“是否曾经有过编辑历史”，
  不判断当前 `pages + overlays` 是否已经回到打开时的源模型。加了一个东西又删掉，
  会留下一个 overlays 为空的 draft，从而下次继续提示恢复。

**修法。**

1. **FreeText 写语义 + 外观分离。**
   `/Contents` 保留真实 Unicode 文本，供 Shiori 和外部编辑器读取；`/AP /N`
   负责显示。

2. **CJK FreeText 的 appearance 用矢量轮廓。**
   editable annotations 模式下不再嵌入 CJK subset 字体给 `/DA` 用；只用
   fontkit 解析字形轮廓，把中文字画进 `/AP` 的 Form XObject。这样 Preview
   正常显示，文件也不会回到整字体 7 MB。注意：这意味着可见外观不是可复制文字流，
   但 `/Contents` 仍然是可恢复的真实文本。

3. **stamp 和 highlight 都写 `/AP /N`。**
   stamp 的对勾/叉号用矢量线条画外观，不再依赖 FreeText glyph；highlight
   写 normal appearance stream，并把 `QuadPoints` 改成 PDF spec 顺序：
   top-left、top-right、bottom-left、bottom-right。外观负责视觉，QuadPoints
   给外部编辑器一个更标准的 text-markup target。

4. **导出前剥离可替换源批注。**
   Shiori 自己导出的 annotation 写 `/NM (shiori:<overlayId>)`。再次导出前，
   对源 PDF 页先移除 Shiori 支持并会重写的 annotation 类型（FreeText、
   Highlight、Ink、Square、Text）和对应 Shiori 字体资源，再 copy page。避免重复
   annotation 和重复字体。

5. **空改动导出短路。**
   当 overlays 为空、页面数量/顺序/旋转/尺寸都和源 PDF 一致、源页也没有需要剥离
   的批注时，`exportPdf()` 直接返回原始 bytes，不经过 pdf-lib 重写。

6. **clean model 删除 draft。**
   打开文档时保存源页面签名；autosave 时如果当前模型与源模型等价，就删除 draft
   和 operation log，而不是保存一个空草稿。设置里的存储管理删除/清空草稿时，也
   同步清理 operation log，Status Line 通过 draft storage subscribe 刷新占用。

**教训 / 预防。**

1. **PDF annotation 必须同时考虑语义和外观。** `/Contents`、`/DA`、`/AP` 是
   不同职责。只写语义字段，viewer 兼容性不可控；只 flatten 外观，又会失去编辑
   语义。

2. **不要只用 Chrome PDF viewer 验收导出。** Chrome 能显示不代表 macOS
   Preview / PDFKit 能显示。涉及中文、日文、FreeText、stamp、highlight 时，至少
   要用 Chrome 和 macOS QuickLook/Preview 各跑一次。

3. **不要用“导出能打开”作为唯一测试。** 必须测体积上限、重复导出幂等、
   annotation 数量、删光编辑后的 no-op 导出、以及页面重排时不能误走 no-op。

4. **不要把历史编辑当作当前脏状态。** 用户加了东西又删除，当前模型已经 clean，
   就不应该影响导出，也不应该继续提示恢复。

5. **缓存管理必须清理所有恢复入口。** IndexedDB draft、legacy draft rows、
   pdf blob、draft model 和 localStorage operation log 是一组东西。清空草稿只删
   IndexedDB 会留下“幽灵恢复”入口。

相关提交：`9dc4da3`、`53d9ae8`、`54a656e`、`be156cb`、`0c13d31`。

---

## 2026-04-22 · macOS WKWebView 文字选中血泪史

**症状。** macOS 的 Tauri 桌面版高亮工具：文字怎么都选不中。在 PDF 文字上
拖拽没有任何反应，高亮工具总是走到 fallback 矩形模式。一位 alpha 用户在
Windows 上报告同一个功能正常。

**错误的最初判断。** 前两轮代码阅读得出结论 "Shiori 的高亮是
文字感知的，基于 pdf.js `TextLayer` + 原生 `window.getSelection()`"。
代码**看起来**是对的。围绕症状修了几次：

1. 文字层 CSS 缺 `-webkit-user-select: text`。加上。没效果。(`9b74d22`)
2. pdf.js 的 `endOfContent` 选区边界补丁没移植过来。照抄了一份。没效果。
   （同一 commit）
3. pointerdown 处理器在文字 target 上也会进入 fallback-drag 模式、干扰原生
   选区。改成遇到文字 target 时让路给浏览器。对 Mac 没效果，不过这个修改本身
   是个合理的清理。(`d0ce596`)

每次 fix 落地后，用户都回复 "Mac 上还是选不了文字"。

**是什么真正暴露了根因。** 从 `bun run tauri build` 切换到
`bun run tauri:dev` 并打开 WebKit DevTools。控制台几秒钟内就冒出来：

```
[Error] text layer render failed – TypeError: undefined is not a function
    (near '...value of readableStream...')
    at (TextHighlightLayer.tsx:63)
```

DOM 检查器确认 `.textLayer` 是个**空 div**——里面一个 `<span>` 都没有。
`TextLayer.render()` 在启动阶段就抛异常，被我们的 `.catch()` 静默吞掉，
所以 DOM 里根本没挂上任何文字节点。**用户没有东西可选**。

**根因。** 当时 Tauri 捆绑的 WKWebView 缺
`ReadableStream.prototype[Symbol.asyncIterator]`。pdf.js v5 的
`getTextContent()` 内部用 `for await (const value of readableStream)`
读取文字流，旧版 WebKit 上直接抛 TypeError。Safari 26.4 才终于原生支持
这个方法，但 Tauri 在旧 macOS 上用的 WKWebView（以及 Linux 的 WebKitGTK）
仍然没有。Windows 能用是因为 WebView2 是 Chromium，2019 年就支持了。

**修法。** 在 `src/pdf/render/pdfjs.ts` 做一次守卫式 polyfill，
在 app 启动时、任何 pdf.js 调用之前执行一次。实现用 `getReader()` +
循环 `read()`：

```ts
Object.defineProperty(proto, Symbol.asyncIterator, {
  configurable: true, writable: true,
  value: async function* () {
    const reader = this.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally { reader.releaseLock(); }
  },
});
```

Commit `1309118`。macOS 上选中文字终于工作了。

**衍生问题：只有在选中真的能用之后才会暴露。**

- 在文字层空白区域双击，整个文字层被选中（WebKit 的 fallback 行为）。
  修法：对零位移、起点在非 span target 上的手势拒绝提交。(`777a29f`)
- 在文字上连续点击 4 次以上也会选中整个文字层（点击次数升级）。修法：
  对位移 <4px 的手势，如果点击次数 ≥4 或选区面积 > 85%，拒绝。
  (`73fd30c`)
- 同一个高亮里的多段 client rect 垂直重叠，半透明叠加出现明显深色带。
  修法：提交前按视觉行合并 rect。(`71e32eb`)

这些 bug 一直都在，只是在 polyfill 让 render 不再抛错之前都被 "没有文字
可以选中" 这个更上游的问题遮住了。

**教训 / 预防。**

1. **看代码只能捕捉意图，不等于运行时行为。** 当一个功能依赖平台相关的
   Web API 时，读源代码判断 "X 功能可用" 是不可靠的。要么在每个目标平台
   实际跑一次，要么加一条最小的 debug 日志让用户跑一次并汇报输出。

2. **"Windows 能用、Mac 不能用" ⇒ WebKit bug。** Tauri 在 macOS 是
   WKWebView、在 Windows 是 WebView2/Chromium。平台间行为差异几乎总是
   WebKit 落后某个 feature。先从 feature-detect / polyfill 角度入手，
   不要先怀疑 CSS 或库内部。

3. **先打开 DevTools。** 前三轮诊断都在围绕 CSS 和选区补丁打转。一句
   `bun run tauri:dev` + Cmd+Option+I 就能在一分钟内看到控制台里的
   `TypeError`。新规则：用户报告任何 "Mac 上不工作"，第一动作是切到
   `tauri:dev` 打开控制台看。

4. **静默吞错误会把真故障盖住。** `textLayer.render()` 外面包的
   `catch(err) { console.error(...) }` 对容错是对的，但结果是错误只在
   DevTools 打开时才可见。对于这种 render 关键路径的初始化错误，考虑
   在 dev 构建里把捕获的错误升格到可见的横幅提醒，这样即使用户跑的是
   未开 DevTools 的包，也会立刻注意到。

---

## 2026-04-21 · 可编辑导出卡死在 "Exporting"

**症状。** "editable annotations" 模式下的导出，如果文本标注里包含中文，
会一直卡在 "Exporting..." 不结束。

**根因。** `pdf-lib` + `@pdf-lib/fontkit` 组合在一种特定场景下会静默
挂起：CJK 字体以 subset 方式嵌入，而这些字形又只被 PDF 注释字典
（`/FreeText` 的 `/DA`）引用、没有被画进任何 content stream。失败时
会抛 `RangeError: "value" argument is out of bounds`，之后 promise 不
resolve 也不 reject，UI 卡死。

**当时的修法。** 对 editable annotations 模式，**整字体嵌入**（不 subset）。
仅在 flattened 模式、字形真的画进页面内容流时才 subset。导出用的字体
改为本地打包，字体加载失败直接报硬错，不再偷偷把中文降级成 `?`。

**后续修正。** 这个修法只是止血，会让一个中文 FreeText 把 PDF 拉大约 7 MB。
2026-04-23 已改成 FreeText 保留 `/Contents` 语义、`/AP` 用矢量轮廓绘制 CJK
外观，避免 DA-only subset 卡死，也避免整字体嵌入。见上面的 2026-04-23 复盘。

**教训 / 预防。** 带中文 FreeText 的导出要在离线条件下跑一遍两种模式。
flattened 模式能导出成功不代表 editable 模式安全——它们走的是两条
不同的字体路径。

---

## 2026-04-21 · Tauri "plugin dialog not found"

**症状。** 前端调用 `@tauri-apps/plugin-dialog` 的 `save()`，Tauri 回
`plugin dialog not found`。桌面版上导出 PDF 看起来什么都没发生。

**根因。** `src-tauri/src/lib.rs` 是原封不动的 `tauri init` 脚手架——
没有 `.plugin(tauri_plugin_dialog::init())`，也没有
`.plugin(tauri_plugin_fs::init())`。前面围绕 CSP IPC scheme、window
label 不匹配、capability 通配符的各种假设*本身*确实都需要正确配置才能
让构建工作，但在 plugin 没在运行时注册之前，这些全都不是关键。

**修法。** `lib.rs` 加两行：

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .setup(|app| { … })
```

**侦查陷阱。** `strings <binary> | grep plugin:dialog` 能搜到
`plugin:dialog|save` 之类字串，看起来像是 plugin 已经激活。但其实不是——
这些字串来自 crate 源码里的 `tauri::generate_handler!`。一个 crate 被
**链接**不等于它的 plugin 被**注册**。

更麻烦的是，Tauri 把 **"plugin X not found"** 用在两种完全不同的失败上：

- plugin 根本没在 builder 链里注册
- plugin 注册了，但 capability 拒绝了当前 window

前端错误信息无法区分这两种。

**教训 / 预防。** 在 release 构建里打一条明确的启动面包屑。
`src-tauri/src/lib.rs` 现在做了：

```rust
eprintln!("[shiori] starting, registering plugins…");
// …在 .setup() 之后：
log::info!("[shiori] setup complete — dialog + fs plugins registered");
```

外加一个持久文件 logger，写在
`~/Library/Logs/fun.nagi.shiori/Shiori.log`。下次再遇到 plugin invoke
失败，这条日志要么出现（→ capability / CSP 问题），要么不出现
（→ plugin 注册问题），本来要走弯路 15 分钟的诊断可以压缩到 30 秒。

## 2026-04-28 · Sticky note 拖拽后的 WebKit late blur

**症状。** 新建 sticky note 后不输入文字，直接拖动这个 note，再尝试输入，
文字进不去；空 note 有时会被删掉，看起来像 textarea 失焦或被卸载。

**根因。** 之前的修法只覆盖了“pointerdown 后 blur 立刻发生”的路径：
`onOverlayPointerDown` 同步设置 ref，`onCommitEdit` 看到 ref 后跳过空文本
删除，`finalizeDrag` 再 refocus textarea。运行时 trace 证明 Tauri
WKWebView 还有另一条路径：`finalizeDrag` 已经 refocus 成功后，WebKit
仍可能延迟发出 textarea `focusout/blur`。当时 `finalizeDrag` 已经把 ref
清掉，late blur 进入普通 empty commit，于是把刚拖好的 note 删除。

**修法。** 把“当前拖拽需要 finalize 后 refocus”的标记，和“下一次由
edit-drag 引起的 blur 应该跳过 commit”的标记拆开。拖动编辑中的 note/text
时同时设置两者；`finalizeDrag` 只消费 refocus 标记，blur suppression 保留
到下一次 textarea blur。这个 blur 被消费后会再 refocus textarea。用户真正
输入、点另一个 overlay、或点工具栏/侧栏等编辑层外部时，suppression 会清掉，
避免永久吞掉后续 commit。

**教训 / 预防。** 对焦点、blur、pointer capture 这类 UI bug，不要用
“标准浏览器事件顺序”推导 WebKit/Tauri 行为。至少记录 native capture 事件、
React handler、`document.activeElement`、textarea mount/focus 状态，再判断
哪一个事件真的先发生。

## 2026-06-10 · 运行沙箱里 localStorage 抛 SecurityError 把整页带崩

**症状。** 用「运行」模式打开一个普通 HTML（例如一个小游戏），脚本一启动就报
`SecurityError: The operation is insecure.`，整页跑不起来。

**根因。** 运行模式的 iframe 是 `sandbox="allow-scripts"` 且**不带**
`allow-same-origin`（Lock 1，见 `runnableHtml.ts`），所以处于不透明源。在不透明
源里**光是访问** `localStorage` / `sessionStorage` / `document.cookie` 就会抛
`SecurityError`（WebKit 的固定文案）。而大量 HTML 会在顶层就读存储（例如
`let LANG = localStorage.getItem('lang')`），于是第一行直接抛错、整段脚本中止。
这不是个别文件的问题，是一整类「用了存储的 HTML」都会中招。

**修法。** 在 bridge 之前、所有用户脚本之前注入一段 storage shim
（`runnableHtml.ts` 的 `STORAGE_SHIM`）：当真实 storage 不可用（访问即抛）时，用
内存版替换 `localStorage` / `sessionStorage`（Proxy 实现，方法 API 和
`localStorage.foo` 属性访问都支持）以及 `document.cookie`。数据只活在该 frame 的
堆里，不落地、不碰用户真实存储/cookie/文件、刷新即清——Lock 1 的安全保证不变，
只是把「一碰就崩」换成「临时可用」。只在真实 API 确实不可用时才装，正常同源环境
里它是惰性的。

**教训 / 预防。** 给不可信内容做沙箱时，「关掉某能力」和「让访问该能力抛异常」
是两回事：后者会把依赖该能力的正常内容直接打挂。安全的做法是提供一个**良性、
隔离、不落地**的替身（storage / cookie 都用 in-memory），既守住边界又不让常见
内容崩。`runnableHtml.test.ts` 锁住了 shim 的注入顺序和 Storage 语义。

---

## 2026-06-10 · Dexie 包装错误让配额检测永远失效

**症状。** 存储满了以后草稿自动保存一直失败，每次都只弹通用的「稍后重试」toast，永远不会触发「清理旧草稿再重试」，也看不到任何配额相关的提示——autosave 从此死循环失败。

**根因。** `drafts.ts` 的 `isQuotaExceededError()` 要求 `err instanceof DOMException`。但 `put()` 里的错误全部经 `db.transaction()` 冒出来，Dexie 会把底层 IDB 错误重新包装成 DexieError（普通 Error 子类）：`name` 保留原名（`"QuotaExceededError"`），原始 DOMException 挂在 `.inner` 上。于是生产环境里真正的配额错误全部被判成 `'transient'`：80% 驱逐重试路径从不执行，`DraftSaveError.kind` 永远不是 `'quota'`，App.tsx 只能展示通用错误。

**修法。** 检测器改成沿错误链（err → err.inner，限深防环）匹配 `name === "QuotaExceededError"`（连同 `QUOTA_EXCEEDED_ERR` / `NS_ERROR_DOM_QUOTA_REACHED`，以及遗留 DOMException code 22 / 1014）。测试通过 `__draftsTest.db` 把 Dexie 形状的包装错误注入真实写入路径，锁住「驱逐后重试成功」和「重试仍失败时 kind === 'quota'」两条行为。

**教训 / 预防。** 凡是按「错误类型」分支的代码，不能假设拿到的是底层原始错误：中间库（Dexie、ORM、fetch 包装层）几乎都会重新包装，`instanceof` 平台类会静默漏判。应基于错误链上的 name/code 判断；写测试时要模拟「经过库包装后」的错误形状，而不是手抛一个裸 DOMException。另一个坑：`db.table("x")` 返回的 Table 实例和 `db.x` 属性不是同一个对象，给测试打补丁要打在生产代码实际引用的那一个上。

---

## 2026-06-10 · 用 undo 栈长度当「已导出」证据，脏状态在 100 次编辑后永久丢失

**症状。** 导出过一次之后继续编辑，标签页脏点和工具栏「需要导出」提示有时不再出现，状态一直停留在「已导出」；长编辑会话（100+ 次编辑）后必现。另一个变体：导出 → 撤销 → 做一个不同的编辑，状态错误地显示「已导出」。

**根因。** 移动端导出改造（0183a77）把导出状态判据从「内容快照 key 相等」换成「undo 栈长度（editCount）相等」，且调用点不再传 snapshotKey，内容比较分支成了死代码。但 undo 栈在 store 里被 `.slice(-100)` 截断：(a) 100+ 次编辑后长度饱和在 100，导出后再编辑长度不变，状态永远「已导出」；(b) 在深度 N 导出、撤销、再做不同编辑，深度回到 N，内容不同却判相等；(c) `hasExportableChanges = editCount > 0` 在撤空一个曾被截断的栈后同样失真。长度相等从来不是内容相等的证据。

**修法。** 恢复内容派生的 snapshot key（`exportSnapshotKey` 序列化 pages+overlays）作为唯一判据：导出时记录、渲染时比较；删掉 `editCount` 字段和长度相等分支；`hasExportableChanges` 改回当前 snapshot 与 baseline 的内容比较。回归测试锁住「超过 undo cap 后导出再编辑」和「撤销后做不同编辑」两个场景（`exportStatus.test.ts`）。

**教训 / 预防。** 任何「计数器相等 ⇒ 状态未变」的推断都要先问两件事：计数器会不会饱和（被 cap 截断），会不会走回头路（undo 后换条路径回到同一值）。有界计数器在 cap 处失去单调性，回退+重做会复用同一深度。脏/同步状态的判据应当派生自内容本身（hash / snapshot key）；计数器最多做优化提示，不能做正确性依据。

---

## 2026-06-10 · Kotlin @Synchronized：注解相同，监视器未必相同

**症状。** Android「用 Shiori 打开」偶发两类故障：JS 侧调用 `drainPendingDocumentOpens()` 抛 `ConcurrentModificationException`；或者 intent 明明进来了，文件却悄悄没打开。

**根因。** `MainActivity` 的 `enqueueDocumentIntent` / `notifyPendingDocumentUris` 标了 `@Synchronized`，锁的是 activity 实例；内部类 `ShioriAndroidBridge.drainPendingDocumentOpens` 也标了 `@Synchronized`，锁的却是 bridge 实例。两把锁互不相干，等于完全没有互斥：enqueue 跑在主线程（onCreate/onNewIntent），drain 跑在 WebView JavaBridge 线程，裸 `ArrayList` 上 `toList()` 迭代可被 `add()` 打断（CME 直接穿透到 JS 调用），而 `toList()` 与 `clear()` 之间入队的 payload 会被清掉且从未送达。

**修法。** 所有访问统一 `synchronized(pendingDocumentOpens)`，drain 的 copy-and-clear 收进同一临界区；删掉误导性的 `@Synchronized`。前端 `drainAndroidPending` 把 bridge 调用挪进解析 JSON 的 try/catch（改传 thunk），Java 侧异常穿过 JavaBridge 边界时不再炸掉整个 mobile open 流水线的初始化。

**能让它更早暴露的那一件事。** 看到 `@Synchronized` 先问一句「锁的是哪个对象」：实例方法锁 `this`，内部类方法锁内部类实例，companion/`@JvmStatic` 锁类对象。分布在不同类型上「成对出现」的 `@Synchronized` 几乎一定是两把不同的锁，等于没锁。

---

## 2026-06-10 · 测试用正则抓 <script> 属性：lazy [\s\S]*? 会跨越元素边界，靠巧合变绿

**症状。** imageResources.test.ts 的 bridgeScriptNonce 用 `/<script\b([^>]*)>[\s\S]*?marker[\s\S]*?<\/script>/` 提取 bridge 的 nonce。一旦 bridge 前面注入了别的脚本（storage shim），lazy 匹配从文档第一个 `<script` 起步、跨过 shim 的 `</script>` 直到 bridge 体内的 marker，捕获组 1 实际是 shim 的属性表。CSP 测试仍然绿——只因 shim 和 bridge 恰好共用同一个 per-document nonce。

**根因。** lazy 量词只保证「最短」，不保证「同一元素内」；正则起点是全文第一个候选，不是包含 marker 的那个标签。

**修法。** 用 tempered pattern：`/<script\b([^>]*)>(?:(?!<\/?script\b)[\s\S])*?marker/`，禁止匹配区间跨越任何 script 标签边界；再用 DOM 解析交叉验证（找 textContent 含 marker 的元素读 nonce），并加一条 shim-在前、nonce-不同 的回归测试。

**能让它更早暴露的那一件事。** 凡是断言「某元素的属性」，要么直接用 DOM 查询，要么给正则配一个属性值刻意不同的反例输入——共享值会把抓错元素掩盖成绿灯。

---

## 2026-06-10 · 原生菜单本地化：Tauri 菜单读不到 webview 里的 i18n 偏好

- 现象：macOS 原生菜单的自定义项（Fit Page 等）全是英文，而系统注入项（服务、进入全屏）跟随系统语言，中日文用户看到混语言菜单栏。
- 坑：Tauri/muda 没有菜单 i18n；应用内 i18next 的语言偏好存在 webview localStorage 里，Rust 侧读不到，而且菜单在任何前端 JS 跑起来之前就已构建完。仓库也没有任何 locale crate（sys-locale / tauri-plugin-os 都没装），别想当然 `t()` 能覆盖到原生层。
- 解法：启动时 `defaults read -g AppleLanguages` 读一次系统首选语言（Cocoa 本地化菜单用的同一份列表），在 lib.rs 里查 zh/ja/en 小表；措辞照抄 src/i18n/locales/{zh,ja}.json，原生菜单与应用内 UI 同词。
- 残留：muda 预定义项（Hide/Quit/Cut/Copy/Paste）仍是英文 — 那是 muda 内置文案，彻底解决需要给 bundle 加本地化资源或给预定义项传自定义 label。

---

## 2026-06-10 · backdrop-filter 会把嵌套的 fixed 弹层重新锚定到宿主盒子上

- 现象：在设置面板 / 更新日志弹窗里再打开一层小弹窗（赞助卡片），新弹窗不再相对视口居中，而是锚到 440px 的面板盒子里；面板滑入动画期间位置还会跟着跳。
- 坑：`backdrop-filter`（和 `transform` 一样）会让该元素成为后代 `position: fixed` 的 containing block——把 Modal 渲染在另一个 overlay 的 DOM 之内，它就不再相对视口定位。另外 `useEscapeClose` 的多个实例都在同一次按键里触发（没有 preventDefault 链），Esc 一下会把上下两层一起关掉。
- 解法：层叠的 overlay 必须渲染成宿主 overlay 的 **React fragment 兄弟节点**，永远不要做它的子节点；下层在有东西压在上面时挂起自己的 Esc/背景点击（`useEscapeClose(!stackedOpen, …)` 或 Modal 的 `closeDisabled`）。设置面板拆成「开关壳 + 视图体」让关闭即卸载，层叠状态自然复位。

---

## 2026-06-10 · macOS 预定义菜单项在 key-equivalent 层吃掉快捷键，webview 里的同款快捷键静默失效

- 现象：桌面版按 ⌘Z/⇧⌘Z 撤销/重做没有任何反应（只对文本框里的输入生效），按 Ctrl+Z 反而可以——但没有任何 UI 提示过 Ctrl+Z 的存在。
- 坑：`PredefinedMenuItem::undo/redo` 在 macOS 上把 ⌘Z/⇧⌘Z 注册成菜单 key equivalent，Cocoa 在事件分发**早于 webview** 的阶段就截走按键，并把它路由成 WKWebView 的原生*文本* undo（first responder 链上的 `undo:` selector）。于是 Canvas.tsx 里 `metaKey||ctrlKey` 的 keydown 处理器永远收不到 ⌘Z，文档级 undo 栈只剩 Ctrl+Z 这条没人认领的路能到达。预定义项也不走 `on_menu_event`（由 Cocoa 直接处理），前端完全无感知。推论：**任何在 webview 里实现的快捷键，只要同一组合键存在于某个预定义菜单项上，在桌面端就是静默死的**——代码看起来正确，web 版也正常，只有桌面端坏。
- 解法：把 Undo/Redo 换成自定义 `MenuItem::with_id`（保留同样的加速键，菜单显示不变），经 `on_menu_event` 发 `menu:undo`/`menu:redo` 事件；App.tsx 侧按焦点分流——焦点在 INPUT/TEXTAREA/contentEditable 时 `document.execCommand("undo")` 保住原生文本撤销，否则调 store 的 undo()/redo()。Cut/Copy/Paste/Select All 维持预定义（它们本来就该是原生动作）。
- 排查口诀：桌面端快捷键失灵而 web 端正常时，先 `grep PredefinedMenuItem src-tauri/src/lib.rs` 对一遍组合键，再怀疑前端 keydown 逻辑。

---

## 2026-06-10 · IPC fetch header 装不下中文：WebKit Headers 拒绝非 ISO-8859-1 值

- 现象：导出中文文件名的 PDF 在桌面端直接失败，诊断报告只有一句 `Type error` 加 `Headers@[native code] / sendIpcMessage` 栈——请求根本没发出去。
- 坑：Tauri 2 的 raw-bytes invoke 走 fetch 自定义协议，参数只能塞 header。`saveBytesTauri` 把 `suggestedName` 原文放进 `x-shiori-suggested-name`，而 fetch 规范要求 header 值是 ISO-8859-1：中文文件名让 WebKit 的 `new Headers()` 当场抛 TypeError。英文文件名永远复现不了，测试全绿。
- 解法：JS 侧把 UTF-8 文件名 base64 后再进 header（base64 字母表永远安全），Rust 侧 `suggested_export_name()` 统一解码（桌面/移动两个 command 共用）。`save.test.ts` 锁住「中文名编码后是 ASCII」和「base64 round-trip 无损」。
- 排查口诀：跨 IPC/HTTP 边界传用户可控字符串时，先问一句「这个通道的字符集是什么」——header、URL、cookie 都不是 UTF-8 安全通道，要么编码要么走 body。

---

## 2026-06-10 · 逐页 copyPages 让共享资源按页数翻倍：3 MB 导出成 39.7 MB

- 现象：59 页、3 MB 的 PDF 加一个高亮后用「可编辑批注 · 原画质」导出，产物 39.7 MB（×13.86）。另一个 39.5 MB 的扫描件导出只到 39.7 MB（正常）。
- 坑：`exportPdf` 在 per-page 循环里逐页调用 `out.copyPages(source, [i])`。pdf-lib **每次 copyPages 调用都新建一个 `PDFObjectCopier`**，对象去重缓存随之清零——被全部页共享的资源（这里是两个 ~670 KB 的内嵌字体程序）每页复制一份，59 页 ≈ 59 份。扫描件每页一张独立图片、无共享资源，所以从不暴露。13 个 standard font embed、object streams、完整性守卫都量过，全是噪音（合计 < 1%）。
- 解法：所有非空白模型页一次性批量 `out.copyPages(source, indices)`（重复页索引允许，页叶仍逐项克隆）；重复页的 `/Annots` 数组单独 clone（`PDFPageLeaf.normalize` 会复用同一数组对象，批注会串页）。实测 39.74 MB → 2.53 MB（比源文件还小：只搬页面可达对象，死对象自然丢弃），导出快 ~4×。回归测试：6 页共享一个 200 KB XObject，导出体积必须 < 源 ×1.3。
- 排查口诀：循环里调用任何「带内部缓存的批量 API」（copyPages、embedFont、structuredClone…）先问一句缓存的生命周期是 per-call 还是 per-instance——per-call 的要把循环翻转成一次批量调用。

---

## 2026-06-10 · 取消「恢复草稿」对话框后，首次编辑会静默覆盖未恢复的草稿

- 现象：打开一个有草稿的 PDF，弹出「恢复上次批注？」对话框，按 Esc / 点背景关掉（既没恢复也没丢弃）。之后随手改一笔，原来的草稿就永久没了——直击「永不丢数据」承诺。
- 坑：草稿按 PDF 内容的 SHA-256 存（见 AGENTS.md 架构事实 4）。关闭对话框只做了 `setPendingRestore(null)`，把内存里的草稿载荷丢了，但**磁盘上的草稿还在**，键就是这个 hash。`useDraftSync(activeHash)` 用的是同一个 hash，首次编辑（`undoStack.length` 0→1）后 800ms 防抖一到，`drafts.put({id: hash})` 就把未恢复的草稿原地覆盖，无任何二次确认或可恢复路径。维护者此前（`3d5e057`）特意让 Esc 走「保留不销毁」，却没堵住这条「首次编辑即覆盖」的暗路。
- 解法：把「关闭对话框」改成**延迟决定**而非丢弃。关闭时把载荷存进 `deferredDraft` 并给 `useDraftSync` 传 `disabled=true`，挂起一切持久化（防抖 put + op-log 都不写），磁盘草稿原封不动。等用户真正开始编辑（`undoCount>0`）时把对话框**重新弹回来**——决定点正好落在「再不选就要覆盖」的那一刻。恢复 / 丢弃都清掉 `deferredDraft`，自动保存随即恢复。回归测试断言：`disabled` 期间过了防抖窗口磁盘仍无草稿，置回 `false` 后才落盘。
- 测试基建小坑：给 `useDraftSync` 写 hook 测试要同时具备 happy-dom（`renderHook` 需要 document）和能跑的 Dexie。`setupDom` 把全局 `Event` 换成了 happy-dom 的，却没换 `EventTarget`，而 `drafts.ts` 在 `new EventTarget()` 上 `dispatchEvent(new Event())`——两者必须同源。在 import `drafts` 之前把全局 `EventTarget` 对齐到 happy-dom 的（`window.EventTarget`）即可；Dexie 还要单独喂 `Dexie.dependencies.{indexedDB,IDBKeyRange}`。
- 排查口诀：凡是「按内容 hash 自动保存」的设计，遇到任何「先展示旧数据、让用户决定要不要用」的入口，都要问一句：如果用户既不接受也不显式拒绝，下一次写入会不会拿同一个键把旧数据盖掉？

## 2026-07-07 · "编辑后文字位移"是三层不同问题叠出来的观感，用像素采样分层后才拆开

用户连续多轮报告"选中/编辑原文后文字有位移、有残影"。逐一验证后发现这
不是一个 bug，而是三层互不相关的现象叠加，任何单独的修复都"看起来没修
好"：

1. **测试文件本身是旧版本导出的二次产物**（`…-edited1-edited.pdf`）。
   旧代码烧进文件里的下沉文字、半截字母是 canvas 内容本身，任何渲染端
   修复都不可能让它们消失。查证方法：`document.querySelectorAll` 找不到
   对应 overlay + text layer span 显示这些字来自文件 item。
2. **真渲染 bug 只有一个**：cover rect 对四边盲扩 0.8pt，选区在词中间
   切开时把邻字盖掉一条边（"foundation-m|odel" 显示成 "…m ːdel"），且
   同一批 rect 进导出，残缺字被永久写进导出文件。修复：切割边只扩
   0.15pt（`selectedRunRectsWithEdges`）。
3. **剩下的"位移感"全部是字体面差异**：编辑框用 Times 栈顶替原文字体
   （如 EB Garamond），x 高度/笔画对比突变，肉眼读成"位移/重叠"——canvas
   像素采样实测新建编辑的基线与原文差 0.16px（对齐正常）。修复：pdf.js
   已把内嵌字体注册为 FontFace，编辑框直接前置该 face（`sourceFontName`
   + `store.pdfFontFaces`）。

教训：位移类报告先分层——烧入（文件内容）vs 几何（基线/盖板）vs 字体面
（渲染栈），分别用「隐藏 overlay 看 canvas」「canvas 像素行采样量基线」
「隐藏 canvas 看 DOM」三个实验隔离，别靠肉眼在截图上猜。顺带：拿导出品
当测试件会把旧 bug 的尸体误诊为活 bug，验收一律用原始未编辑文件。

## 2026-07-07 · bun test 不做类型检查：model 字面量漏字段会静默走快路径

导出集成测试里 overlay 字面量漏写 `pageId`，TypeScript 能查出的错误
bun test 不查（只有 `bun run build` 的 tsc 会）——导出因 "该页无 overlay"
走了原样返回的快路径，断言只看到未动的原文，方向完全误导（像"删除/重绘
全没跑"）。若集成测试看到"导出对页面零改动"，先 diff model 字面量与类型
定义，再怀疑管线。


## 2026-07-07 · 绝对页坐标的 overlay 字段：contentText 必须被所有移动手势排除，否则静默损坏导出

`ContentTextOverlay.sourceBaselinesPt` 是**绝对页坐标**（page space），屏上
渲染和导出都直接以 `baselines[i]` 落位、**无视 `rect.y`**。因此平移 overlay
时只搬 `rect`/`coverRects`、忘了搬 `sourceBaselinesPt`，文字会竖直卡在原处
而盖板和框都移走——导出时盖板去删**错误位置**的字形、替换文字画在旧基线新
x 上，产出乱码，且**全程无提示**。

坑在于 translate 有 5 条路径，只有 `pageSpace.ts`（页原点平移）当初更新了，
另外 4 条漏了：`geometry.ts` 的 `translateOverlay`（喂给拖拽/方向键 nudge/
Cmd+D 复制/剪贴板粘贴）、`store.duplicateSelected` 手写的偏移。语义上
contentText 本就该"钉死在它删掉的那些字形上"，任何移动都无意义——所以正解
是**所有移动手势都排除 contentText**（复制/粘贴两端都过滤，防陈旧剪贴板夹带），
外加 `translateOverlay` 补搬 `sourceBaselinesPt`（+dy）做双保险。

教训：给 overlay 加"绝对坐标"字段时，必须审计**每一条** translate/duplicate/
clone/page-space 路径是否都搬运它——漏一条就是一个静默损坏点。发布前审计才
抓到，属发布阻塞级。

## 2026-07-07 · iOS target 会静默烂掉：cfg 孪生引用桌面专属类型，本机没人跑 iOS check

给内嵌终端加的 `configure_terminal_locale` 有个 `#[cfg(not(target_os =
"macos"))]` 孪生实现，签名里引用了桌面专属的 `CommandBuilder`（portable-pty，
mobile 根本不编译它）。裸 `not(macos)` 没排除 mobile，于是
`cargo check --target aarch64-apple-ios` 红了好几周——因为本机日常只跑
macOS 构建，没人跑 iOS check，编译错误一直潜伏。加 iOS 沉浸式命令时才撞见。

和 2026-06-15 的 Android updater 潜伏坑同类：**平台专属能力的编译红只在你真
去 build 那个平台时才暴露。** 教训：改 `src-tauri` 里任何 cfg-gated 代码，
除了 `bun run tauri build`（桌面），至少跑一遍
`. "$HOME/.cargo/env" && cargo check --target aarch64-apple-ios`（在 src-tauri
下）。cfg 门要写 `all(not(mobile), not(target_os = "macos"))` 这种，别只写单条。

## 2026-07-07 · 字体度量量化：Chrome fontBoundingBox 返回整数，100px 采样 → 0.3px 系统性偏上

用 canvas `measureText().fontBoundingBoxAscent/Descent` 度量字体、再换算基线
时，Chrome 这两个值返回**整数像素**。在 100px 采样下，em 比值被量化到 0.01em
——放到正文字号（如 10–14pt）就是约 0.3px 的**系统性"文字偏上"**，肉眼可辨、
反复被当成对齐 bug 追。

修法：采样字号从 100px 提到 **1000px**，量化误差降到 ~0.03px（0.001em）。
任何靠 canvas 字体度量做基线/垂直居中的计算都可能中招——一律用大字号采样。

## 2026-07-07 · Chrome 把 text-indent 施加到整个 textarea，而非只首行

`ContentTextOverlay.firstLineIndentPt` 用 CSS `text-indent` 实现"行中起选"的
首行缩进。在提交态的 `<div>` 上，text-indent 只作用于**首个格式化行**（符合
规范，正确）。但编辑态的 `<textarea>` 是 div 首行上的**行内级替换元素**，
text-indent 把**整个控件**往右推 300+px——表现为"行中起选的多行编辑，一输入
所有行整体右移"。修法：编辑态把父 div 的 indent 归零（textarea 全行贴左，
为既定取舍），提交/导出仍用真实缩进。

## 2026-07-08 · Spotlight 索引 build .app 副本：Command+Space 搜到一堆 Shiori

`.app` bundle 无论在哪都会被 Spotlight 当应用索引。构建产物散落在
`src-tauri/target/`（macOS 打包）、`~/Library/Developer/Xcode/DerivedData`
+ `gen/apple/build`（iOS 编译）、以及每个 jj worktree（如 `shiori-ws3`）
各自的 target——发一次版下来 Command+Space 里能搜到 ~11 个 Shiori，还夹着
0.1.22 这种老版本，误导"是不是装了好几个"。真正的安装只有 `/Applications`
一个，其余全是 build 垃圾；官网重装**不解决**这个（只换 `/Applications`）。
永久修法：给各 build 根目录放 `.metadata_never_index` 空文件排除出索引
（`rm -rf target` 后要记得在重建的空 target/ 里补回该文件，否则下次 build
又冒出来）。

## 2026-07-30 · 右栏第四次"被关"：store 修完了，React 树本身还在重挂

右栏（内置终端 + 浏览器）"切文档就关/闪"这个症状连续修了三轮
（e6ccc6e、4ac57c7、38578f6），每轮都是 store 层某条路径覆写了
`showRail`。三轮修完 store 状态确实不丢了——但症状还在，因为还有
**第四种机制在 React 层**：App.tsx 按文档类型返回四棵互斥的顶层树
（文本 / PDF 加载中 / PDF / Landing），装 rail 的那行 flex row 在
各分支根节点下的**子元素索引不同**（文本分支上面多一个
DocumentTopBar + WorkspaceSwitcher），React 无 key 时按索引配对，
跨分支切换必然卸载整行重挂。卸载 = TerminalPanel cleanup 杀掉 pty
（scrollback 丢失）+ 原生 browser webview hide/show 闪一下。另外
"PDF 加载中"分支当时压根没渲染 rail，所以切到未加载的 PDF tab
必闪。修法：三个分支的 row 共用 `key={DOCUMENT_ROW_KEY}`（key 让
React 跨索引配对复用同一 fiber），加载分支补上 rail。

教训：**"同一个症状修了 N 次还复发"时，别再在同一层找第 N+1 条路径，
换一层看。** store 层的修复用 store 测试 pin 住了，但组件树的挂载
连续性没有任何测试覆盖——它是"结构"而非"状态"。现在
`src/editor/railMountStability.test.tsx` 用两个测试 pin：
(1) 机制测试证明 keyed row 在分支变形下保住子组件 state；
(2) 源码形状测试断言 App.tsx 三个分支都有 keyed row + RightRail。
顺带的第二个坑：App 订阅了 `scale`/`fitMode` 却只在防抖持久化
effect 里用，等于每滚一档缩放就白白重渲染整棵 ~4600 行的 App 树，
缩放时右栏跟着闪。订阅挪进专门的 null 渲染组件
（PdfViewStatePersister），RightRail 加 memo 兜底。

## 2026-07-30 · 侧栏拖拽卡顿修了三轮：丝滑的答案是"拖拽期间别进 React"

同一句"拖拽侧栏很卡"修了三轮才到位，每轮都只削掉了一部分开销：
第一轮砍掉了 fit-width 每像素重栅格化（PageCanvas 尾随防抖）；
第二轮把宽度更新 rAF 合帧 + 拖拽期间冻结 Canvas 的容器尺寸 state
（`chromeResizing`）；用户仍反馈"拖动经常没反应，松手才跳过去"——
因为**每帧仍有一次大子树 React 重渲染**（左栏=整个文件树/缩略图，
右栏=整个 rail），WKWebView 主线程一堵，mousemove/rAF 全部排队，
表现就是指针跑出去很远、面板不动。终解（Obsidian 的做法）：拖拽
期间完全绕开框架——`ref.style.width` 直写，浏览器只做 layout；
React 只在松手时拿到一次提交值。教训：**实时跟手的交互，帧循环里
不允许出现 setState**，无论那个 setState 看起来多"便宜"——它的
代价是它触发的整棵子树，且在低速 WebView 里以百毫秒级停顿呈现。

## 2026-08-08 · 捏合缩放 compositor 预览的两个坑：position:fixed 逃出裁剪 + settling session 复用

为了让触摸板捏合期间 Virtuoso 几何完全冻结，4c39139 把每个正在
绘制的 PDF 页内层设成 `position: fixed` 再打 transform。结果一放大
页面直接盖住侧边栏和其他 chrome——**fixed 盒子的包含块是视口，
不受滚动容器 `overflow` 裁剪**，zIndex 一垫就画到文档区外面去了。
其实出流根本没必要：transform 本来就不进 layout，内层留在文档流里
只改 compositor transform，外层测量盒、size tree、scrollTop、原生
滚动条照样一字节不动，而 scroller 的 overflow 继续把预览裁在文档区
内。教训：**"只想要视觉效果"时永远先试纯 transform；position:fixed
的真实语义是"换包含块 + 逃出所有祖先裁剪"，不是"钉在原地"。**
`Canvas.pageHeight.test.ts` 现在 pin 住 arm 后的 layer 必须留在文档流。

DOCX 侧的"跳来跳去"是另一个机制：commit 之后 session 进入
settling（等 Word 引擎重排才拆预览，b811b39），这期间用户紧接着再
捏一次，`beginZoomPreview` 直接复用了这个带**旧 layout 几何**
（layerLeft/anchorLocal/baseZoom）的 session——transform 按过期基准
算，引擎重排一落地预览就整体错位，settle 观察器又会在新手势中途
finish 掉 session，滚动修正叠着乱跳。修法：settling 的 session 在新
手势开始时立刻 finish + 重新快照；commit 对 settling session 一律
no-op（否则滚动修正会用旧锚点跑第二遍）。顺带：ctrl+wheel 捏合的
settle 从 140ms 提到 250ms（一次连续捏合中的手指停顿就够 140ms，
每次误 commit 都是一整次 Word 重排的可见卡顿）。

当天追击的第三坑（自己修出来的）：为防两路打架加的"gesture 流活跃
期间忽略 ctrl+wheel"，判定条件用的是 gesturestart..gestureend 括号
——结果 macOS WKWebView（Tauri 壳）的捏合恰恰是**只发括号，真正的
增量全走 ctrl+wheel**（gesturechange 不一定带 scale），guard 一挂，
捏合期间预览纹丝不动，松手后残余 wheel 才 commit 一步，变成"一段
一跳"。事件拓扑三家三样：Chromium 只发 ctrl+wheel；iOS Safari 的
gesturechange 带 scale；WKWebView 是括号 + wheel。所以忽略 wheel
只能在"本次手势里 gesturechange 真的带着 scale 出现过"之后
（driving 标志），不能看括号开没开。第二刀：预览帧从 rAF 合帧改成
事件内同步应用——现在每帧只写一条 compositor transform（不进
layout），rAF 合帧已无收益，而 WebKit 可能在原生手势期间整段暂停
rAF，推迟的预览一帧都出不来。教训：**"gesture 事件存在"≠"gesture
事件在驱动"，给手势写的任何 guard 都必须按"哪路流真的在发增量"
判定；且手势期间的每帧工作要便宜到不需要 rAF 合帧，因为 rAF 在
原生手势里未必会来。**

第四坑（用户描述"倍率一样但聚焦的地方完全不一样"钉出来的）：预览
的不动点是**当前**指尖质心下的内容（锚点每帧更新，缩放+平移一体），
但 commit 的滚动修正用的是**手势开始时**捕获的 pageAnchor——两个基
准差 (指尖漂移 × 缩放比)，触摸板捏合质心随手漂 50–150px 时，松手
瞬间视图整体平移一两百像素。修法：commit 时先把预览 transform 还原
（PDF 直接还原后量，DOCX 用 layoutHasCaughtUp 的"关一帧 transform
量自然布局"技巧），按**最后的锚点位置**对基准布局重新取
pageAnchor/contentX/Y，让落点精确接住预览最后一帧。教训：**预览和
commit 必须钉同一个内容点；凡是"手势里持续更新、结束时一次结算"
的交互，结算用的每个基准都要问一句"这是开始时的还是结束时的"。**
顺带补了 UI 缺口：手势中缩放倍率只活在 visualScaleRef，右上角读数
要等 commit 才跳——加了 liveZoomIndicator 微型 store（只重渲染读数
本身），ZoomControls 手势期间跟着预览走。

第五、六坑（headless Chrome 探针钉出来的，肉眼永远猜不到）：
(1) commit 的 flushSync 返回瞬间，新一代 Virtuoso **一个 item 都没挂载**
（mountedPages: 0），"量真实 rect 做滚动修正"的分支从未执行过，一直
在走含固定 chrome 误差的 content 兜底公式——这才是"松手后聚焦点不
对"的祖传根因；且新实例还会在之后几帧里自己补一笔初始定位（location
的 offset 被丢、initialScrollTop 会被中途几何 clamp），把任何修正覆写
掉。修法三层：纯几何数学先落点（canvasCommitScrollTop/Left，横向要
算居中 gutter，它不随 ratio 缩放）→ scroll 事件同帧守卫（400ms 窗口
内非用户输入的滚动一律拉回，用户一动立即解除）→ 锚点页真正挂载后
（rAF 轮询 ≤15 帧）用实测 rect 精修一次并重设守卫。
(2) 某条样式把 transition 盖到了预览层上：每帧 transform 都在缓动
（getAnimations() 看到 transform/transform-origin 两个 CSSTransition），
restore 后 computed transform 仍是中途矩阵，commit 的重取锚量到的全
是动画中途位置。arm 时 layer.style.transition = "none"。教训：**合成层
预览有三个隐形敌人——迟到的写者、量不到的新生代、悄悄接管的 CSS
transition；每一层"我写完了"都要有"谁会在我之后再写/我量到的是不是
真值"的答案。**

第七坑（真机才暴露）：守卫的"时间启发式"挡不住真实惯性——触摸板松
手后不带 ctrl 的惯性滚轮**连续几百毫秒不断流**，Virtuoso 那笔"页顶
对齐+横向归零"的迟到写入落在流里任何一刻都会被当成用户滚动放行/采
纳，"自动摆正"照样赢。终解是架构级判别，不再猜时间：**用户的原生
滚动永远不经过 JS 的 scrollTo()/scrollBy()，而程序化写入只走这两个
方法**——交接窗口内把 scroller 实例上的两个方法遮蔽成空操作（delete
即还原原型方法），指针/键盘输入立即解除。教训：**区分"谁在滚动"要
用调用路径这种结构性事实，别用时间窗；凡是和连续输入流赛跑的启发
式，在真机上都会输。**

终章（真机探针一锤定音）：用户机器的捏合走 gesturechange(带 scale)
路线，守卫和 scrollTo 吞噬都工作正常——但 commit 时"重取锚点"量到
的坐标恰好等于 原始锚点 × 缩放比（例：137,440 → 347,1115），目标被
二次放大，落点因此整体甩向右下。根因是 CSS 规范细节：**transition
是否启动，判定依据是"变更后"的样式**。还原顺序哪怕是"先 transform
后 transition"，只要两次写入落在同一次 style recalc 里，浏览器一并
结算时 stylesheet 的 transition 已经生效，transform 归零照样起 tween，
随后的 getBoundingClientRect 读到的全是 tween 起点（完整放大态）。
修法：还原 transform 后先 `void layer.offsetWidth` 强制一次 recalc
（此刻 inline transition 仍是 none），再还原 transition。教训：
**"按顺序写样式"不等于"按顺序生效"；凡是"改样式→立刻测量"的代码，
中间必须有 forced reflow，且要知道 transition 用 after-change 样式
判定。** 这次能定位全靠 dev-only 的 zoomDebugTap 事件回传（vite 内
存收集器，curl 可读）——远程猜了七轮的东西，真实事件流一屏就看穿。
