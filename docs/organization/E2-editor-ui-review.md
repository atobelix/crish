# E2 编辑器原型 UI/样式/动效评审：composer-preview

> 评审对象：`docs/composer-preview/`（Tiptap/ProseMirror + React 编辑器原型，独立可运行）
> 评审方式：只读静态评审（17 个样式文件 + 5 个 UI 组件 + 3 个菜单组件 + 4 个共享视图组件逐行通读 + 硬编码色值/圆角/z-index/动效统计）
> 日期：2026-08-05
> 结论先行：**视觉 8/10，系统 7/10**。单点设计水准已达第一梯队（动效体系、代码块、数据库视图、live-preview 语法显隐是亮点）；但「Obsidian + Notion 结合」目前是 **90% Notion / 10% Obsidian**——Obsidian 的纸张感、衬线阅读态、暗色模式三个支柱基本缺席，且存在两代令牌/两份样式文件并存的系统性债务。

---

## 0. 评审范围与体量

| 对象 | 体量 | 说明 |
|---|---|---|
| 核心样式（tokens/typography/shell/prosemirror/live-preview/reset/index/animations/motion） | 9 文件约 1.9k 行 | 令牌 + 动效 + 编辑器核心 |
| blocks/ 样式 | 10 文件约 3.7k 行 | block-shell / code-block x2 / fenced / database / form / layout / media x2 |
| menus/ + ui/ 样式 | 2 文件约 700 行 | 斜杠/气泡菜单、通用组件 |
| UI 组件 | Button/DropdownMenu/ContextMenu/Popover/Tooltip | 5 个 |
| 菜单组件 | BlockMenu/BubbleMenu/SlashMenu/SlashCommandExtension | 4 个 |
| 共享视图 | BlockShell/BlockToolbar/EmptyState/FenceMarker | 4 个 |

评分拆解（细则见各节）：令牌完整度 8/10 · 排版成熟度 5.5/10 · 块视觉 8.5/10 · 编辑器体验样式 9/10 · 动效 8/10 · 一致性 5.5/10 · 无障碍 5/10。

---

## 1. 设计令牌（tokens.css）— 完整度 8/10

### 体系盘点

- **语义色**：背景 8 级（`--bg-primary #fff` → `--bg-tertiary #f0efeb` → 透明 hover/active/selected，tokens.css:12-19）、文字 7 级（primary #37352f → disabled #d3d1cb，tokens.css:22-30）、边框 4 级（0.09/0.16/0.24 阿尔法 + focus 蓝，tokens.css:33-36）、功能色 7 个（tokens.css:39-45）。全部取自 Notion 官方色板，色值 1:1（#f7f6f3 暖灰底、#37352f 深棕黑、#2383e2 蓝）。
- **属性色**：Notion 10 色前景 + 10 色轻背景 + 5 色 callout 背景 + 5 色 callout 边框（tokens.css:52-87），成对设计（`--color-x` 与 `--bg-color-x` 同源），可供 tag/status/callout/hljs 复用的单源色板。
- **间距**：4px 基线的 11 步（2/4/6/8/10/12/16/20/24/32/40/48，tokens.css:92-104）。命名 `--space-N` 以 px 值命名，无 `--space-7/9/11/14` 等跳号，实际使用时易误读（`--space-8` 是 16px 而非 8px）——Notion 系常用命名法，可接受。
- **圆角**：7 级 2/3/4/6/8/12/pill（tokens.css:109-115）。
- **字体**：sans 栈 = Notion 官方栈逐字复刻；serif = Lyon-Text（Notion 官方衬线）；mono = **iaWriterMonoS 打头**（iA Writer 系，Typora/Obsidian 谱系，tokens.css:120-124）。
- **阴影**：5 级，全部「1px 描边 + 多层柔影」结构（tokens.css:147-158），`--shadow-popover` 独立档，密度递进合理。
- **z-index**：8 级 0/100/200/300/400/500/600/700（tokens.css:171-178），语义命名（dropdown/sticky/overlay/modal/popover/toast/tooltip）且每 100 一档留足扩展余量。
- **编辑器专用令牌**：max-width 900px + 96px 侧边距、行高 1.6、代码块/围栏/语法标记全套（tokens.css:183-201）。

### 缺口

1. **无多级色阶**：全部单色值，无 50/100/…/900 分级。忠实于 Notion（本尊也是扁平色），但作为设计系统深度不及 shadcn/Radix 的 12 级色阶——若要自己演化暗色主题或 hover 阶梯，需要重建。
2. **`--font-serif` 声明后从未被引用**（全仓 grep 仅 tokens.css:122 一处）——衬线阅读态 token 是死的，见 §2。
3. **对比度**：`--text-tertiary #b4b0a8`（≈2.6:1）与 `--text-placeholder #c8c6c1`（≈1.8:1）低于 WCAG AA 4.5:1。Notion 原版同款，装饰性文字可接受，但要注意别把次级信息（如统计数字、描述行）用到正文必需信息上。

### 与第一梯队对照

- **Notion**：色/间距/圆角/阴影近乎逐 token 复刻，这是「极简卡片感」的正确打开方式。
- **Obsidian**：仅字体栈（iaWriterMono）与 `--code-bg #f7f6f3` 的暖灰呼应了纸张感；没有纸张纹理、没有阅读态衬线、没有暗色（Obsidian 的另一个本体）。
- **Typora**：无继承。

---

## 2. 排版（typography.css + prosemirror.css）— 成熟度 5.5/10

### 做得好的

- **标题层次**：36/24/20/16/15/13px 六级（typography.css:9-66），字重 700→600，字距 `-0.03em → +0.03em` 逐级收敛再展开，h6 大写 + 0.03em 字距（typography.css:64-65）——Notion 标题语感抓得很准。h1 与 h2 之间 2em/1.4em 的间距阶梯是 Notion 式「标题与正文拉开」。
- **行内细节**：`u` 用 `text-underline-offset: 3px`（typography.css:99-103）；`mark` 黄油黄 #fdf3c7 + 2px 圆角；行内 code 0.9em/0.15em 0.4em/3px 圆角（typography.css:115-123）；链接 0.05em 透明下边框过渡（typography.css:128-137）——所有小部件都做了圆角/内边距/过渡三件套，观感精致。
- **任务列表**：16px 自绘 checkbox，`clip-path` 画勾 + 120ms scale 展开（prosemirror.css:234-265），勾选动画细腻（配合 animations.css:141-150 的 250ms spring 回弹）。
- **live-preview 链接下划线**：用 `background-image` 渐变画 1px 下划线而不是 text-decoration（live-preview.css:155-177）——能精确控制粗细、不会被降序字母切断、hover 可增粗到 1.5px，这是第一梯队编辑器才有的细节。

### 硬伤（P0）

- **无序/有序列表不显示任何标记**：`reset.css:34-36` 全局 `ol, ul { list-style: none }`，而 prosemirror.css:190-194 只恢复了 `padding-left`，全仓无 `list-style-type` 恢复、无 `content: '•'`、无 `counter-reset`（对比 code-block-view.css:186 是有 counter 的）。结论：**markdown 文档里的项目符号和序号在当前 CSS 下不可见**，只剩一段段首行缩进的文字——这是排版观感最直接的一块残缺，优先级最高。
- **段落零间距**：`.ProseMirror p { margin: 0 }` + `.ProseMirror > * + * { margin-top: 0 }`（prosemirror.css:116-123），连续段落完全靠 1.6 行高撑开。Notion 也是零间距（块模型），但目标里还有「Obsidian 纸张感」——阅读态下段落间无 2-4px 呼吸，长文档会显得像一整块墙。建议在渲染态给 `p + p` 加 2-4px（Obsidian 阅读视图的做法），编辑态保持 Notion 式。
- **h1 上边距 2em**（prosemirror.css:67）对 markdown 文档过重——文档首个标题会距离页首 32px×字号，且连续两个标题之间的 2em 断裂感明显（Obsidian 是 ~1em/1.4em 均匀递进）。

### 对照 Notion 排版细节

| 细节 | Notion | 本原型 |
|---|---|---|
| 列表标记 | 圆点/数字 | **缺失（P0）** |
| 引用块 | 3px 左边框 + 灰字 | 3px + 主色字（prosemirror.css:176-181），色差略强 |
| 表格 | 细线、表头粗体 | 1px border-light + th 加粗灰字（prosemirror.css:312-340），达标 |
| 段落间距 | 0（块模型） | 0（一致） |
| 标题字距 | -0.02~-0.03em | 同款 |

---

## 3. 块视觉（blocks/）— 完成度 8.5/10

### 代码块（双实现，一旧一新）

- **新实现 code-block-view.css**：头部（语言下拉 + 文件名内联编辑 + 复制按钮）→ 正文，行号用「CSS counter + 46px 背景网格侧栏」方案（code-block-view.css:196-214），注释明确解释了「ProseMirror pre 内伪元素无法逐行编号，用背景网格保证与行高严格对齐」——方案正确且理由充分。`is-wrapped` 换行态、`has-line-numbers` 侧栏态齐备。
- **hljs 主题刻意收敛 5 色相**（code-block-view.css:223-262）：紫 #9065b0 关键字 / 绿 #448361 字符串 / 橙 #d9730d 数字 / 蓝 #337ea9 属性 / 灰 #9b9a97 注释，与 Notion 属性色 token 同源。比 VS Code 系 8+ 色更克制——观感统一、不抢正文，代价是语法识别度略降。注释里写明「避免代码块变成调色盘」，是明确的设计决策。
- **旧实现 code-block.css**（.code-block-wrapper 头 + 行号列 + diff 块）仍存在且被 blocks/index.css:14 引入，与新实现并存——见 §6 一致性问题。
- Diff 块：add/del 行 8% 阿尔法底色 + 红绿前景 + 行号列，GitHub 式配色，达标。

### Callout

5 色变体，背景/左边框成对（fenced.css:19-38）；**编辑态切白底 + 灰色左边框 + 等宽内容**（fenced.css:72-80）——「所见即所得」与「源码态」的反差清晰，这是 live-preview 思想的正确延伸。唯一的妥协：编辑态内容用 mono 小字，长 callout 编辑时可读性弱于正文，可接受。

### Database（database.css，877 行，体量最大）

- 表格视图：列 resize 手柄 3px 悬停变蓝、表头 hover、行 hover、`cell:focus-within` inset 2px 焦点框（database.css:90-105, 140-143）——Notion 表格交互细节全覆盖。
- 属性渲染器 10 色 tag（database.css:189-199）、status 圆点、checkbox（复用 clip-path 勾）、date/url/person 头像/number 右对齐 tabular-nums。
- 看板（280px 列 + 卡 hover 抬升）、画廊（auto-fill grid + cover 140px）、列表、日历（今日红圆点日号）、时间轴（今日红线 + 端点圆点 + 240px 侧栏）——「全 10 视图」从 CSS 层面就位。
- 行详情右滑面板 480px + shadow-lg + 评论区（database.css:749-877）——Notion 截图级复刻。

### BlockShell 选中/悬浮态（block-shell.css）

- 选中：`box-shadow: 0 0 0 2px accent` 描边（block-shell.css:19-21）——不占布局、贴合圆角，比 outline 高级。
- 悬浮：`::after` 2px 外扩淡底色 + 圆角 2xl（block-shell.css:24-36）。
- 手柄/badge/工具条全部走 `.motion-affordance`（opacity+visibility+位移滑入），`focus-within` 时常驻（block-shell.css:59-61, 127-129）——键盘用户不会失去工具条。BlockShell.tsx 头注释把「交互规范只实现一次」作为存在理由，架构判断正确。

### 其他亮点

- tabs 滑动指示条：transform+width 180ms emphasized 曲线，注释写明「位置由 JS 测量写进 transform，切换成本恒定」（layout-blocks.css:129-148）——组件里最值得做动画的地方给了动画。
- toggle 折叠：max-height 250ms + opacity 200ms 双过渡（animations.css:155-166）。
- 音频块：进度 fill 用 scaleX（注释：60fps 更新只走合成器，media-data-blocks.css:70-82），thumb 悬浮 spring 弹出。
- 空状态：图标卡 + 主行动按钮，不是「一行灰字」而是「下一步该做什么」（BlockShell.tsx:132-137）。

### 问题

- **`.video-block` 背景硬编码 #000**（media-layout.css:115）——合理但属硬编码白名单外。
- **media-layout.css 与新版块样式大量冲突**：`.ai-block` 两套（media-layout.css:715 紫色渐变头部式 vs media-data-blocks.css:413 渐变底 composer 式）、`.tabs-block` 两套（下划线式 vs 滑动指示条式）、`.audio-block` 两套、`.column-layout` 两套、`.toc-block` 两套。靠 import 顺序让新版覆盖旧版（index.css:33-34 先 layout 后 media-data），但旧文件未删——见 §6。

---

## 4. 编辑器体验样式（live-preview / 光标 / 围栏 / 工具栏）— 9/10

这是全项目最见功力的部分：

- **语法标记显隐**：`md-syntax` 默认 `display:none`，光标进入后 `.is-revealed` 以 opacity 0.34 等宽灰显形（live-preview.css:42-65）。设计注释（live-preview.css:12-16）写明「占位瞬时切换、只对颜色淡入——零 layout 成本」——用 display 切换免重排、用 opacity 动画保柔和，性能与观感双赢的决策。0.34 的对比度刻意轻于 Obsidian 的高亮式语法，更贴合 Notion 的「隐藏式」审美。
- **当前行标尺**：`.is-active-block::before` 左侧 2px 圆角竖线，opacity+scaleY 过渡，且只在 `has-syntax`（当前行处于源码态）时出现（live-preview.css:202-224）——Obsidian「光标行感」的安静版实现，只在真正需要时出现，克制得恰到好处。
- **转义符降噪**：`[data-escape]` 的显形 opacity 再降到 0.22（live-preview.css:191-193）——层级意识。
- **光标/选区**：caret 主色 + 1.1s step-end 闪烁（animations.css:327-334）；选区 `rgba(35,131,226,0.14)`（animations.css:320-322）比 token 的 --bg-selected 更淡——正文中不刺眼，正确。
- **围栏标记 FenceMarker**：可编辑 `<input>`（Enter 进内容、Escape 退出、变更走 updateAttributes 参与 Undo/Redo，FenceMarker.tsx:66-105）；样式上 top/bottom 圆角接续代码块、底部 1px 分隔线（prosemirror.css:465-483）——「围栏是块的一部分」的视觉暗示清楚。
- **代码块行号**：46px 背景网格侧栏（code-block-view.css:205-214），与代码行高严格对齐，见 §3。
- **块工具栏**：BlockToolbar 统一壳（左语言/右操作），`fade-switch 180ms` 切换淡入（animations.css:44-48）。
- **小瑕疵**：`.drag-handle`（prosemirror.css:510-533）与 `.block-drag-handle`（animations.css:255-284）双套拖拽手柄，同 -28px 定位但细节不同（24px vs 20px）——重复代码，见 §6。

---

## 5. 动效（motion.css + animations.css）— 8/10

### motion.css 是亮点

- **结构**：缓动 6 条（standard/decelerate/accelerate/emphasized/spring/linear，motion.css:35-40）→ 时长 5 档 + 退场 3 档（70ms→380ms，退场 = 进场 ×0.6，motion.css:51-60）→ 位移幅度 5 档（1-8px）+ 抬升/按下/交错步长（motion.css:78-92）→ 10 个通用关键帧 + 5 个工具类（stagger/lift/tap/affordance/panel-in）。
- **三条硬规则写进注释**（motion.css:7-21）：只动 transform/opacity、进出不对称、时长跟随位移距离——这不是口号，stagger 上限 12 项（motion.css:221-240）、lift 阴影瞬时切换只动画位移（motion.css:243-246）、affordance 用 visibility 延迟切换防元素消失仍吃事件（motion.css:284-298），全部有落地细节。
- **prefers-reduced-motion**：全局 1ms + 位移归零（motion.css:101-131），且注释说明「不是全部置零——保留极短透明度过渡，让状态切换保持因果感」——这是业界（Material/Radix）级的处理，原型里少见。

### 问题（两代动效系统并存）

1. **animations.css 的 `menu-enter` 覆盖 motion 的 `motion-rise-in`**：index.css 先引 motion.css（:10）后引 animations.css（:25），两者对 `.slash-menu` 特异性相同，后者胜出——菜单入场实际生效的是 animations.css:85 的 `150ms cubic-bezier(0.16,1,0.3,1)`，而 motion 体系里同元素的 `motion-rise-in`（180ms decelerate）是死的。SlashMenu.tsx:150 的类名看似在走新体系，实际被旧文件劫持。
2. **`--transition-*` 老令牌（tokens.css:163-166）有 73 处引用，不在 reduced-motion 的覆盖列表内**（motion.css:101-131 只改 --dur-*/--shift-*）——73 处过渡在「减弱动态效果」下仍保留原时长，与全局 1ms 并置会闪出「大部分 1ms、少量 150-250ms」的不一致。
3. **`--transition-spring` 300ms cubic-bezier(0.25,0.1,0.25,1.0)` 与 `--ease-spring` cubic-bezier(0.34,1.56,0.64,1.00)` 是同名不同曲线**（tokens.css:166 vs motion.css:39）——两代体系各自为政的典型证据。
4. **`block-exit`/`menu-exit` 关键帧定义了但零引用**（animations.css:20,64）——退场动画缺失，菜单/面板关闭是瞬时消失的，与「进出不对称」的规则自相矛盾。
5. **`block-enter 200ms` 施加于所有 `.ProseMirror > *`**（animations.css:32-34）——长文档首屏每个块都重放入场，无 viewport 判断无 stagger，与 motion 体系「stagger 最多 12 项」的纪律矛盾（虽然只播一次，性能尚可，但属双体系噪音）。

---

## 6. 一致性 — 5.5/10

### 硬编码统计（token 纪律）

| 类别 | 统计 | 评价 |
|---|---|---|
| 硬编码 hex | ~50 处，集中在三类镜像：`#1a6dbf`×4（应为 --text-link-hover）、`#fff`×6（应为 --text-inverse）、hljs 五色×3-4（应为 --color-* 引用） | 可收敛，观感无害但违背单源 |
| rgba 阿尔法漂移 | `rgba(35,131,226,*)` 八档（0.04/0.08/0.14/0.15/0.3/0.34/0.50/0.85）、`rgba(55,53,47,*)` 六档 | 链接下划线/选区/边框阿尔法未收成 token，是最大漂移源 |
| border-radius | 硬编码仅 `0 / 3px / 50% / inherit`（50% 为圆形合法） | **优秀**，圆角纪律全项目最好 |
| z-index | 弹层全 token（100-700），仅局部 0-20（column-resize-handle 等） | 良好 |
| font-size | em 相对值为主，10px（kbd）/12/16/28/32px 少量绝对值 | 良好 |
| 时长 | 硬编码 5 处（100ms/120ms/200ms/250ms 等），其余全走令牌 | 良好 |

### 结构性问题（比硬编码更严重）

1. **两代令牌并存**：`--transition-*`（73 处引用）与 `--dur-*/--ease-*`（56 处）双轨，见 §5。
2. **双实现文件**（旧文件未删，靠 import 顺序压盖）：`.ai-block`、`.tabs-block`、`.audio-block`、`.column-layout`、`.toc-block` 在 media-layout.css/layout-blocks.css 与新文件里各有完整一套（§3）；`.drag-handle` 与 `.block-drag-handle` 双套；`.editor-content` 在 shell.css:67 与 prosemirror.css:17 重复定义。这是「看起来不一致」的定时炸弹——任何一个新样式若写成旧类名，就会悄悄被覆盖。
3. **暗色模式：0 处 prefers-color-scheme**。纯浅色设计。Notion 2024 年才补暗色、Obsidian 默认双主题——目标「Obsidian 结合」却完全没有暗色，是系统性缺口（P1）。
4. **跨组件一致性亮点**：圆角语言有层级（块 6px → 面板 8px → 菜单 12px）、hover 反馈全站统一 `--bg-hover`/`--bg-active`、悬浮工具条全站右上角 + affordance、危险操作全站 `--bg-color-red` 底红字——组件之间的「手感」是统一的。

---

## 7. 无障碍 — 5/10

### 做得好的

- **SlashMenu 键盘导航是全项目最佳**：↑↓/Home/End/Enter/Tab/Escape 完整（SlashMenu.tsx:79-116）、`scrollIntoView({block:'nearest'})` 防整表跳动（:63-65）、`keyboardModeRef` 实现「键鼠状态不打架」——鼠标移动不抢键盘选中（:153-176）。这是可进入产品级的菜单交互。
- aria 基础到位：BubbleMenu 10 处（aria-pressed/aria-haspopup/aria-expanded/aria-label，BubbleMenu.tsx:153-219）、SlashMenu listbox/option + aria-selected、BlockShell 工具条按钮带 aria-label 且 focus-within 常驻。
- focus-visible 全局有兜底（animations.css:241-250）。

### 缺口

1. **两套 focus-visible 定义互踩**：animations.css:241 全局 `:focus-visible { outline: 2px solid }` 与 motion.css:306 的 `box-shadow` 双层环（bg 间距 + focus 色，能贴合圆角）同特异性，animations.css 后加载胜出——motion 的精致环是死的，且 outline 不贴合圆角、`border-radius: var(--radius-sm)` 对 outline 无效。
2. **Tooltip 键盘不可达**：仅 onMouseEnter/Leave（Tooltip.tsx:36），无 onFocus/onBlur——键盘用户永远看不到 tooltip；且无 aria-describedby 关联。
3. **ContextMenu 无键盘导航**：highlightIndex 只随 onMouseEnter（ContextMenu.tsx:79-82），无 ↑↓/Enter；且触发侧（BlockMenu 的 useContextMenu）只监听 contextmenu 事件，无 Shift+F10 键盘触发。
4. **DropdownMenu 的 ARIA 模式不合规**：`role="listbox"` 内嵌 `<button role="option">`（DropdownMenu.tsx:80-90）——option 不应是可聚焦 button，正确做法是 roving tabindex + aria-activedescendant。功能上可用（↑↓/Enter/Escape 齐），语义上不合格。
5. **EmptyState 可点击态**：role=button + tabIndex=0 但无 Enter/Space 处理（EmptyState.tsx:42-45）。
6. **对比度**：见 §1（tertiary 2.6:1）。26-28px 图标按钮小于 44px 触控建议——桌面编辑器可接受，Notion 同款。

---

## 8. 对照与结论

### 三维度对照

| 维度 | Obsidian 纸张感 | Notion 极简卡片感 | Typora 排版感 |
|---|---|---|---|
| 继承度 | **弱**：仅语法标记淡入、当前行标尺、可编辑围栏、iaWriter 字体、暖灰底 | **强**：token 1:1 复刻、块 chrome 统一、database 10 视图、表单/书签截图级 | **无**：无衬线阅读态（font-serif 死 token）、段落零间距、列表无标记 |
| 关键缺失 | 暗色模式、衬线阅读态、纸张纹理、阅读/编辑双视图 | （几乎无） | 排版密度、列表标记 |

### 一句话结论

> 这是「**Notion 的皮肤 + Obsidian 的编辑手感**」——live-preview 的语法显隐、当前行标尺、围栏编辑、性能驱动的动效决策（display 切换零重排、scaleX 进度条）都达到了 Obsidian 级别的编辑质感，但**观感层完全站在 Notion 一侧**；Typora 的排版成熟度（列表标记、段落呼吸、衬线阅读）和 Obsidian 的纸张/暗色支柱尚未落地。

### 评分

- **视觉 8/10**：单点质感第一梯队（代码块行号方案、hljs 五色相收敛、tab 指示条、链接下划线画法、checkbox clip-path、数据库全套）；扣分：列表无标记、段落零间距、无暗色让「完整观感」打了折。
- **系统 7/10**：token 齐全、圆角/z-index 纪律优秀、动效体系是原型级的范本；扣分：两代令牌并存（73+56）、双实现文件压盖、菜单入场被旧动画劫持、退场动画缺失、reduced-motion 覆盖不全。

---

## 9. 差距清单（按优先级）

### P0 — 破损级，先修

1. **列表无项目符号/序号**：reset.css:34-36 全局清掉 list-style 后未恢复。给 `.ProseMirror ul` 恢复 `list-style-type: disc/none`（或 ::before 圆点）与 `ol` 的 counter 序号，并补嵌套缩进层次感。
2. **删除旧样式双实现**：media-layout.css 与 code-block.css 是旧版残留（.ai-block/.tabs-block/.audio-block/.column-layout/.toc-block/.drag-handle 与新文件冲突），删除后全站回归。
3. **动效双系统归一**：删掉 animations.css 的 menu-enter/menu-exit/block-enter（或改造为引用 motion 令牌），统一走 motion.css；`--transition-*` 73 处迁移到 `--dur-*/--ease-*`，删 `--transition-spring` 旧曲线。

### P1 — 系统级

4. **暗色模式**：0 处 prefers-color-scheme。先用 CSS 变量层加 `[data-theme=dark]` 覆盖（Notion 暗色色板现成：bg #191919、text #fffffff2 等），这是「Obsidian 结合」最大的补课。
5. **补退场动画**：menu-exit/block-exit 已定义未用，给菜单/面板关闭加 110-160ms 加速曲线退场（时长已备好）。
6. **硬编码收敛**：`#1a6dbf → var(--text-link-hover)`、`#fff → var(--text-inverse)`、hljs 五色 → `var(--color-*)`；rgba 阿尔法漂移（链接下划线 8 档、滚动条 2 档）收为语义 token。
7. **段落间距与 h1 上边距**：渲染态 `p + p` 加 2-4px（Obsidian 阅读感）；h1 上边距 2em → 1.4em。
8. **focus-visible 双定义清理**：删 animations.css:241 的 outline 版，让 motion.css:306 的 box-shadow 环生效（贴合圆角、有 bg 间隙）。

### P2 — 打磨/无障碍

9. Tooltip 加 onFocus/onBlur + aria-describedby；ContextMenu 加 ↑↓/Enter 与 Shift+F10 触发；EmptyState 加 Enter/Space。
10. DropdownMenu 改 aria-activedescendant 模式（或至少把 option 改为不可聚焦元素）。
11. `--font-serif` 接入阅读态（渲染模式或「阅读模式」开关切换 serif 排版）——这是拿到 Typora 排版感的最短路径。
12. 删 shell.css:67 与 prosemirror.css:17 的 .editor-content 重复定义，统一归 shell。
13. 评估 text-tertiary/placeholder 对比度：关键 UI 文案（如代码块 meta、表格操作提示）避免用 tertiary。
