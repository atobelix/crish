# DeepSeek-Harness 工具行与专有视图深度架构分析

> **报告标识**：`docs/linear-chat-stream-study/analysis/05-deepseek-tool-rows-and-specialized-views.md`
> **研究对象**：`reference/deepseek-harness`
> **核心模块**：`packages/client/ui-tool` 与 `packages/client/ui-primitives`
> **分析员**：A05 - DeepSeek 工具行与专有视图分析员
> **编写日期**：2026-09-06

---

## 目录

1. [执行摘要与设计哲学变革](#1-执行摘要与设计哲学变革)
2. [ToolRow 24px 单行极简规范与几何布局剖析](#2-toolrow-24px-单行极简规范与几何布局剖析)
3. [运行态高光扫光动效（Shimmer Sweep Glare Band）深度逆向](#3-运行态高光扫光动效shimmer-sweep-glare-band深度逆向)
4. [状态圆点（StateDot）与全链路无障碍（A11y）设计](#4-状态圆点statedot与全链路无障碍a11y设计)
5. [专有视图（Specialized Views）在折叠/展开态的差异化架构](#5-专有视图specialized-views在折叠展开态的差异化架构)
   - [5.1 Bash 终端卡片与交互模型](#51-bash-终端卡片与交互模型)
   - [5.2 Diff 差异代码块与文件变更模型](#52-diff-差异代码块与文件变更模型)
   - [5.3 Read 代码预览与语法高亮模型](#53-read-代码预览与语法高亮模型)
   - [5.4 文件路径联动与键盘事件冒泡防御](#54-文件路径联动与键盘事件冒泡防御)
   - [5.5 Search / Todo / AskQuestion 专有视图横向对比](#55-search--todo--askquestion-专有视图横向对比)
6. [设计哲学对比：为什么“单行折叠 + 原生卡片”远优于传统“厚重气泡卡片”？](#6-设计哲学对比为什么单行折叠--原生卡片远优于传统厚重气泡卡片)
7. [对 Conex / Crish 桌面端正文界面的重构与工程落地建议](#7-对-conex--crish-桌面端正文界面的重构与工程落地建议)

---

## 1. 执行摘要与设计哲学变革

在当今主流 AI 客户端（如传统的 Chat 界面、各种 Web 套壳应用）中，工具调用（Tool Call）往往被设计成**大型独立气泡卡片**：
- 哪怕只执行了一条 `cat file.txt` 或 `git status`，界面上都会弹出一个带有厚重阴影、粗边框、醒目卡片头部、大号折叠箭头的独立容器；
- 这种厚重设计把“AI 的中间思考/工具执行过程”摆在了与“用户意图”和“最终交付成果”对等的视觉层级上；
- 随着复杂 Agent 任务的展开（一次任务可能串行触发 10~30 次工具调用），整个视口被巨型卡片完全淹没，正文对话严重断裂，用户必须频繁大幅滚动屏幕才能找到真正关心的最终输出。

**DeepSeek-Harness** 彻底颠覆了这一范式，提出并实现了**基于单行流式折叠（Inline Disclosure Row）的极简工具架构**：
1. **工具调用是一等流式公民，但默认呈现为极简的单行过程附注（24px Single Line）**：遵循严格的 Figma 122:9479 几何约束，折叠时高度仅 24px，无任何外边框与重背景，信息密度极高；
2. **轻量柔和的运行态光效（Subtle Sweep Shimmer）**：不使用花哨的旋转加载动画或高对比度闪烁，而是使用 2.6s 的 CSS 背景冲淡扫光带（Sweep Glare Band），优雅呈现计算在途感；
3. **精雕细琢的像素级状态标记（StateDot）**：静态圆点采用内核心加外光晕的双层结构，运行态采用 10x10 像素空间下的 8 单元复古跑马灯动画，全链路贯彻 `aria-hidden` 与专有屏幕阅读器语义分离；
4. **渐进式展开的原生级专业视图（Specialized Native Views）**：展开后并非简单的 JSON 倾倒，而是按领域定制出媲美 IDE 与原生终端的高性能专用组件（`TerminalBlock`、`DiffBlock`、`ReadBlock`、`SearchBlock`）；
5. **系统级交互贯通**：文件路径具备点状下划线链接属性，点击或键盘激活直接唤起宿主系统的默认编辑器，彻底打通 Agent 与开发者本地工作流的壁垒。

---

## 2. ToolRow 24px 单行极简规范与几何布局剖析

### 2.1 Figma 122:9479 几何规范

在 [`packages/client/ui-tool/src/client/tool/components/ToolRow.module.css:1-7`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.module.css#L1-L7) 中，源码开篇明确给出了设计稿锚点与严格的布局排布公式：

```
[16px leading 图标]  gap: 6px  [title 13/24px 标题]  gap: 8px  [2x2px dot 分隔点]  gap: 8px  [summary 13px 截断摘要 FILL]  [suffix 尾缀]
```

整个单行的高度被绝对锁定在 **24px**（在基础字号设置下）。其各个布局槽位的尺寸、弹性与字体层级如下表所示：

| 槽位 | 元素 / Class | 尺寸 / 样式规则 | 弹性行为 (Flex) | 语义与设计考量 |
|---|---|---|---|---|
| **Leading** | `.leading` | `16px × 16px`（内嵌 `14px` SVG 图标） | `flex: none` / `flex-shrink: 0` | 承载工具类型图标（如 Search、Browse、Bash、Edit）或运行/错误状态点。 |
| **Gap 1** | margin / gap | `margin-right: 6px` | 静态间距 | 图标与文字的紧凑黄金间隔。 |
| **Title** | `.title` | 字号 `13px`，行高 `24px`，`font-weight: 400`（Cordis 工具为 `500`） | `flex: none` | 工具动作名称（如“搜索”、“读取”、“执行终端”），不截断。 |
| **Separator** | `.sep` | `width: 2px; height: 2px; border-radius: 1px;` | `flex: none`；外边隙 `margin: 0 8px` | 极细的实心圆点，色彩为 Caption 级，仅在摘要非空时呈现。 |
| **Summary** | `.summary` | 字号 `13px`，行高 `24px`，单行溢出省略 (`text-overflow: ellipsis`) | `flex: 1 1 auto; min-width: 0;` | 占据整行剩余空间的主摘要（路径、命令、参数或错误行）。 |
| **Suffix** | `.summarySuffix` | 字号 `13px`，行高 `24px`，`white-space: nowrap` | `flex: none; margin-left: 4px;` | 关键数值后缀（如 Todo 的 `+n` 并行任务数），**豁免截断**。 |
| **DiffStat** | `.diffStat` | 代码等宽字体，字号 `11px` (`13px - 2px`)，`transform: translateY(0.5px)` | `flex: none; margin-left: 10px;` | Diff 特有的 `+A -R` 增删统计，颜色降阶为 Caption，基线下沉对齐。 |

### 2.2 基础字号联动动态轴（Font Scale Axis）

DeepSeek-Harness 允许用户在设置中自定义正文字号。为了保证在不同字号下工具行依然保持完美的视觉比例，`ToolRow` 没有将 24px 写死为不可变的魔法数字，而是基于 **二次字体阶梯（Secondary Tier）与偏移增量（Font Delta Axis）**：

在 [`packages/client/ui-primitives/src/DisclosureRow.module.css:21-34`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/DisclosureRow.module.css#L21-L34)：
```css
.row {
  display: flex;
  align-items: center;
  height: calc(24px + var(--dsh-content-font-delta, 0px));
  min-width: 0;
}

.leading {
  width: calc(16px + var(--dsh-content-font-delta, 0px));
  height: calc(16px + var(--dsh-content-font-delta, 0px));
  margin-right: 6px;
}

.leading svg:not([data-state]) {
  width: calc(14px + var(--dsh-content-font-delta, 0px));
  height: calc(14px + var(--dsh-content-font-delta, 0px));
}
```
- **行高与图标框同步拉伸**：随着 `--dsh-content-font-delta` 浮动，图标保持其在单行中的光学占比；
- **排外规则 `svg:not([data-state])`**：状态圆点 `StateDot` 带有 `data-state` 属性，强制**不参与**字体缩放，保持设计稿固定的 10px 状态标印比例（[`DisclosureRow.module.css:44-51`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/DisclosureRow.module.css#L44-L51)：“*StateDot stays at its fixed figma size — it is a status mark, not text furniture.*”）。

### 2.3 悬停交互：无布局抖动的 Chevron 平滑替换（Hover Chevron）

传统 UI 在实现“可展开行”时，通常在尾部常驻一个 Chevron 箭头，或者在鼠标悬停时突然挤入一个图标，导致整行文字产生明显的左右位移抖动。

DeepSeek 采用了极其巧妙的 **重叠渐隐渐现方案（Overlay Crossfade）**（见 [`packages/client/ui-primitives/src/DisclosureRow.tsx:60-71`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/DisclosureRow.tsx#L60-L71) 及 [`DisclosureRow.module.css:57-77`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/DisclosureRow.module.css#L57-L77)）：
1. 在折叠状态且可展开（`previewChevron = true`）时，`leading` 容器内部同时渲染两个图标：
   - `<span className={css.iconIdle}>{icon}</span>`：工具类型图标
   - `<IconChevronDownOutline14 className={clsx(chevronClassName, css.chevronHover)} />`：绝对定位居中的向下 Chevron
2. 样式控制：
   ```css
   .iconIdle {
     display: inline-flex;
     opacity: 1;
     transition: opacity 100ms ease;
   }
   .chevronHover {
     position: absolute;
     inset: 0;
     margin: auto;
     opacity: 0;
     transition: opacity 100ms ease;
   }
   .row:hover .iconIdle { opacity: 0; }
   .row:hover .chevronHover { opacity: 1; }
   ```
3. **视觉效果**：鼠标移入行内时，原有的工具小图标（如搜索放大镜）在原地 100ms 柔和淡出，同时向下箭头在完全相同的位置原地淡入！**右侧的标题、分隔点、路径摘要没有丝毫像素级抖动**，行内空间完全守恒。

### 2.4 摘要截断与关键后缀防挤压（Suffix Protection）

在空间狭窄（例如侧边栏分屏、移动视口）时，单行摘要必须截断，但有些关键信息若被截断，用户将无法感知执行状态。
例如：
- Todo 工具：当前执行到任务 A，但同时还有 3 个任务在后台并行执行（`+3`）；
- Diff 工具：修改了文件，产生了 `+42 -8` 行变更。

DeepSeek 在 CSS 和布局上做出了精妙的非对称弹性设计（[`ToolRow.module.css:91-119`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.module.css#L91-L119)）：
```css
.summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summarySuffix {
  flex: none;
  margin-left: 4px;
  white-space: nowrap;
}
```
- `.summary` 声明 `min-width: 0` 和 `flex: 1 1 auto`，当容器收缩时，**优先牺牲摘要文字的尾部**；
- `.summarySuffix` 声明 `flex: none` 与 `white-space: nowrap`，**绝对不收缩、绝对不换行**；
- 这确保即使行宽被压缩到极限，用户也必定能看到最右侧的 `+3` 或 `+42 -8`！

---

## 3. 运行态高光扫光动效（Shimmer Sweep Glare Band）深度逆向

在 AI 驱动的工具调用过程中，工具处于“正在运行”状态（`running`）可能持续数十毫秒到数分钟。业界常规做法往往是让图标旋转（Spinner）或让整行透明度循环呼吸（Pulse）。旋转动画过于抢眼，多行工具同时旋转时会引发严重的视觉认知过载。

DeepSeek 借鉴并深化了其 `deepsuite ShimmerText` 模式，在单行上实现了一种极具高级感的**高光反向扫光动效（Reverse Sweep Glare Band）**。

### 3.1 核心 CSS 实现与关键帧节奏

在 [`packages/client/ui-tool/src/client/tool/components/ToolRow.module.css:23-43`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.module.css#L23-L43)：

```css
/* Running sweep (deepsuite ShimmerText pattern): a fixed-width glare band —
   theme background at 60% — glides over the row content from off-left to
   off-right, washing glyphs and icon toward the background as it passes.
   ease-out with a 10% end hold gives each pass a beat before the next. */
.root[data-state='running'] .row::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 300px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%,
    transparent 100%
  );
  animation: dsh-tool-row-sweep 2.6s ease-out infinite;
  pointer-events: none;
}

@keyframes dsh-tool-row-sweep {
  0% { left: -300px; }
  90%, 100% { left: 100%; }
}
```

### 3.2 技术机理与光学美学分析

这一设计有三个极其老练的技术细节：

1. **反向冲淡而非正向加亮（Washing toward background）**：
   - 常见的 Shimmer（如骨架屏）通常是在灰色背景上扫过一条纯白 `rgba(255,255,255,0.4)` 的亮光带；
   - 但在对话正文中，工具行本身文字为 Secondary 文本色，若用白光扫射，在亮色模式下会产生强烈的刺眼感；
   - DeepSeek 采用了 `color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%`！它扫过的实际上是**含有 60% 底层背景色的半透明遮罩**。当扫光带划过文字与图标时，不是让它们更亮，而是**将前景字符暂时性地向背景色“冲淡/清洗（wash）”**，仿佛一层柔和的水光波纹漫过文字，极其宁静优雅。

2. **300px 固定光带宽 + 视口穿透**：
   - 扫光带宽度固定为 `300px`，起始点设为 `left: -300px`，终止点为 `left: 100%`；
   - 结合 `.row { overflow: hidden; position: relative; }`，光带无论单行宽度长短，都能匀速完整掠过整个视觉容器。

3. **90%~100% 时间段的静止节拍（End Hold Beat）**：
   - 动画总时长为 `2.6s`，缓动函数为 `ease-out`；
   - 注意看关键帧：`0%` 到 `90%` 完成从 `-300px` 到 `100%` 的平滑划过；而从 `90%` 到 `100%`，`left` 保持在 `100%` 不动！
   - 这意味着在每次扫光结束后，画面会保留 **0.26 秒（10%）的纯静止间歇**。这种“划过 -> 停顿一拍 -> 再次划过”的物理节奏，避免了高频循环带来的机械焦虑感，赋予界面一种沉稳的计算生命体呼吸感。

---

## 4. 状态圆点（StateDot）与全链路无障碍（A11y）设计

### 4.1 四态色彩矩阵与视觉结构

在 [`packages/client/ui-primitives/src/StateDot.tsx`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/StateDot.tsx) 和 [`StateDot.module.css`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/StateDot.module.css) 中，DeepSeek 定义了独立的 `StateDot` 原语组件，具备四种核心状态语义：
1. `done`：绿色成功态（`--dsw-alias-state-success-primary`）
2. `warning`：琥珀色警示/中断态（`--dsw-alias-state-warn-primary`）
3. `ongoing`：深浅适中的业务运行蓝（`--dsw-static-deepseek-450`）
4. `error`：红色失败态（`--dsw-alias-state-error-primary`）

#### 静态状态（`done` / `warning` / `error`）的双层光晕设计
在 CSS 实现上（[`StateDot.module.css:8-34`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/StateDot.module.css#L8-L34)）：
- 整体大小为 `10px × 10px`；
- `::before` 伪元素：`inset: 0; border-radius: 50%; background: currentColor; opacity: 0.1;`（形成直径 10px、透明度 10% 的外层漫射光晕）；
- `::after` 伪元素：`inset: 20%; border-radius: 50%; background: currentColor;`（形成直径 6px 的 100% 实心内部核心）；
- 颜色完全由外部赋予的 `currentColor` 统一驱动。这种“60% 实体核心 + 10% 外层光晕”的结构，比单调的单色实心圆点具备更深邃的光学质感。

#### 动态状态（`ongoing`）的 8 像素环复古机械跑马灯
当状态为 `ongoing` 时，DeepSeek 没有使用常见的转圈 SVG 环（Spinner），而是渲染了一个由 8 个独立矩形组成的 3×3 矩阵像素环（[`StateDot.tsx:8-48`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/StateDot.tsx#L8-L48)）：
```tsx
const MATRIX_CELLS: readonly (readonly [number, number])[] = [
  [0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4],
]
// 顺时针环绕 10x10 网格上的 8 个 2x2 像素单元
```
在动画实现上（[`StateDot.module.css:47-68`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/StateDot.module.css#L47-L68)）：
```css
.cell {
  fill: currentColor;
  opacity: 0.15;
  animation: dsh-state-dot-chase 1s infinite;
}

@keyframes dsh-state-dot-chase {
  0%, 12.4%   { opacity: 1; }
  12.5%, 24.9% { opacity: 0.6; }
  25%, 37.4%  { opacity: 0.35; }
  37.5%, 100% { opacity: 0.15; }
}
```
- **阶梯式跳变（Flat keyframe holds, no tweening）**：各关键帧之间没有线性渐变平滑过渡，而是硬切。点亮时为 `1`，随后两级衰减到 `0.6`、`0.35`，最后归于底噪 `0.15`；
- **负延迟相位控制（Negative Delay Phasing）**：
  `style={{ animationDelay: `${(index - MATRIX_CELLS.length) * 125}ms` }}`。
  8 个单元，每个相隔 125ms，刚好凑满 1 秒周期。使用负延迟可以确保**组件挂载的第一瞬间，8 个像素就已经处于各自的衰减相位中**，杜绝从空白突然启动的动画闪跳！
- 这种像素跑马灯赋予界面一种独特的复古黑客/工业级终端美学（Retro terminal feel）。

### 4.2 全链路无障碍（Accessibility / A11y）设计

单行折叠和视觉光效很容易陷入“仅对视力正常用户可见，屏幕阅读器完全失聪”的陷阱。DeepSeek-Harness 在此设立了堪称典范的无障碍规范：

1. **视觉元素彻底与读屏隔离**：
   - `StateDot` 内部无论是 SVG 还是 span，均显式标记 `aria-hidden="true"`（[`StateDot.tsx:33, 55`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/StateDot.tsx#L33-L55)）；
   - 分隔圆点 `<span className={css.sep} aria-hidden />`（[`ToolRow.tsx:208`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx#L208)）；
   - 扫光动画纯由 CSS `::after` 绘制，天然脱离 DOM 读屏树。

2. **专有屏幕阅读器文本注入（Visually Hidden Semantic）**：
   在 [`ToolRow.tsx:99-106`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx#L99-L106) 中：
   ```tsx
   function stateStatus(state: ToolRowState, t: TranslateNS<'conversation'>): string | null {
     switch (state) {
       case 'running': return t('row.running')
       case 'error': return t('row.failed')
       case 'stopped': return t('row.stopped')
       default: return null
     }
   }
   ```
   并在 DOM 中插入（[`ToolRow.tsx:191`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx#L191)）：
   ```tsx
   {status !== null && <span className={css.visuallyHidden}>{status}</span>}
   ```
   配套的屏幕阅读器专用隐藏类（[`ToolRow.module.css:350-357`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.module.css#L350-L357)）：
   ```css
   .visuallyHidden {
     position: absolute;
     width: 1px;
     height: 1px;
     overflow: hidden;
     clip: rect(0 0 0 0);
     white-space: nowrap;
   }
   ```
   视障用户在使用辅助技术时，能极其明确地听到“正在运行”、“执行失败”或“已终止”，而不会受到视觉圆点和无意义符号的干扰。

---

## 5. 专有视图（Specialized Views）在折叠/展开态的差异化架构

DeepSeek-Harness 对工具卡片的设计遵循一个严密的分层：
`ToolCallTree` -> 检查是否命中专有 View 插件（如 `bashToolviewSample`、`fileMutationToolview`、`readToolview`、`searchToolview`、`todoToolview`、`askQuestionToolview`） -> 未命中则回退到 `GenericToolCard` -> 最终全部挂载到通用的 `ToolRow` 骨架容器中。

无论哪个工具，在折叠态下都压缩为符合 Figma 122:9479 的单行，而一旦展开，则呈现高度定制的领域卡片：

```
折叠态 (24px) ─────────► [Leading 图标/StateDot] · [Title 标题] · [Summary 摘要] · [Suffix 统计]
                              │
                              ▼ 展开点击 (Expand)
展开态 (Card Surface) ──► ┌────────────────────────────────────────────────────────┐
                          │ 专业视图卡片 (TerminalBlock / DiffBlock / ReadBlock 等) │
                          │ 包含：专属 Banner、独立滚动区、Head-Tail 截断、一键 Copy │
                          └────────────────────────────────────────────────────────┘
```

下面深入剖析各个专有视图在折叠态与展开态的技术实现与代码证据。

---

### 5.1 Bash 终端卡片与交互模型

- **核心源码**：
  - `packages/client/ui-tool/src/client/tool/toolviews/bash-sample.tsx`
  - `packages/client/ui-primitives/src/TerminalBlock.tsx` & `TerminalBlock.module.css`

#### 折叠态表现
- **Title**：本地化文案“终端命令”（`bash`）或“PowerShell”；
- **Summary**：优先提取命令的语义化描述（`description`），若无则展示命令首行（`command`）；
- **失败拦截**：若终端执行产生非 0 退出码或被 Signal 中断，即使底层协议判定调用成功，`terminalFailed` 也会强制将单行状态标记为 `error`，Leading 图标由 API 徽标变为红色 `StateDot`，Summary 则替换为失败输出的第一行（[`bash-sample.tsx:49-53, 107-109`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/toolviews/bash-sample.tsx#L49-L53)）。

#### 展开态表现 (`TerminalBlock`)
展开后呈现完整的类原生终端卡片（[`TerminalBlock.tsx:198-254`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/TerminalBlock.tsx#L198-L254)）：
1. **多行命令与 Working Directory（CWD）Prompt**：
   - 提取 CWD 的最后一段（若为用户 Home 目录则智能折叠为 `~`）；
   - 若命令为多行，**只在首行标注 CWD 和状态圆点**，后续行以 `$` 符号对齐，避免给用户造成“每行都在新目录执行”的误导（[`TerminalBlock.tsx:205-220`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/TerminalBlock.tsx#L205-L220)）；
   - 使用 `white-space: pre` 保留多行 Shell 脚本的缩进结构。
2. **退出码状态胶囊（Status Pill）**：
   - 当 `exitCode !== 0` 或存在 `signal` 时，在右上角渲染红色胶囊，如 `Exit 1` 或 `SIGKILL`（[`TerminalBlock.tsx:92-100, 223`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/TerminalBlock.tsx#L92-L100)）。
3. **ANSI 颜色与样式解析**：
   - 借助 `parseAnsiLines` 完整保留终端输出的 16 色/256 色/TrueColor 及加粗/下划线样式（[`TerminalBlock.tsx:135-139, 168-173`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/TerminalBlock.tsx#L135-L139)）。
4. **头部与输出区双独立滚动（Gutter & Scroller Isolation）**：
   - 传统卡片把滚动条加在最外层，导致滚动时命令头部和 Copy 按钮被推走；
   - `TerminalBlock` 将滚动条锁定在内部的 `.output` 容器上（`max-height: 224px`），头部 Prompt Banner 固定置顶，且滚动条带有 `border: 2px solid transparent; background-clip: padding-box;`，使滑块浮动在卡片内侧，绝不挤压 12px 的外圆角（[`TerminalBlock.module.css:44-59, 152-178`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/TerminalBlock.module.css#L44-L59)）。

---

### 5.2 Diff 差异代码块与文件变更模型

- **核心源码**：
  - `packages/client/ui-tool/src/client/tool/toolviews/file-mutation-row.tsx`
  - `packages/client/ui-primitives/src/DiffBlock.tsx` & `DiffBlock.module.css`

#### 折叠态表现
- **Title**：本地化文案“编辑文件”或“写入文件”；
- **Summary**：显示相对工作区的干净文件路径，作为可点击的链接；
- **增删行统计（`diffStat`）**：
  ```tsx
  const diffStat = useMemo(() => {
    if (diffBody === null) return null
    const { added, removed } = diffTotals(diffBody.card.diffs)
    return `+${added} -${removed}`
  }, [diffBody])
  ```
  在单行折叠态的最右侧，以等宽字体和淡灰 Caption 色直接显示 `+12 -3`。用户无需展开卡片，一眼就能获知该工具调用所带来的代码修改量级（[`ToolRow.tsx:165-170`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx#L165-L170)）。

#### 展开态表现 (`DiffBlock`)
展开后呈现精炼的行内 Diff 卡片（[`DiffBlock.tsx:181-205`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/DiffBlock.tsx#L181-L205)）：
1. **多 Hunk 与多文件扁平流（Flattened Hunk Stream）**：
   - 若一次写入涉及多个文件，首行显示粗体文件名（`padding-right: 56px` 避让右上角复制按钮）；
   - 同一文件内的非连续修改（Scattered Edits），在两个 Hunk 之间插入轻量的 `⋯` 分隔行（[`DiffBlock.tsx:97-101`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/DiffBlock.tsx#L97-L101)）；
2. **色彩与符号双保险无障碍**：
   - 增加行：`.add { color: var(--dsw-alias-state-success-primary); }`，伪元素 `.add::before { content: '+ '; }`；
   - 删除行：`.del { color: var(--dsw-alias-state-error-primary); }`，伪元素 `.del::before { content: '- '; }`；
   - 严格避免仅依靠红绿色区分（符合 WCAG 色盲友好标准），且复制时 `copyText` 函数也会自动带上 `+ ` 和 `- ` 前缀（[`DiffBlock.tsx:136-147`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/DiffBlock.tsx#L136-L147)）。
3. **Head-Tail 中部折叠（`DEFAULT_DIFF_MAX_LINES = 16`）**：
   - 当 Diff 总行数超过 16 行时，绝不无节制纵向撑开页面，而是对半切片：前 8 行（Head）和后 8 行（Tail）正常显示，中间插入 `FoldToggle` 按钮，提示“展开剩余 N 行变更”（[`DiffBlock.tsx:172-180, 190-198`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/DiffBlock.tsx#L172-L180)）；
4. **底部汇总脚标（Footer）**：
   - 输出统一的终端格式脚标：`└ +42 -8 · 2 个文件`（[`DiffBlock.tsx:203`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/DiffBlock.tsx#L203)）。

---

### 5.3 Read 代码预览与语法高亮模型

- **核心源码**：
  - `packages/client/ui-tool/src/client/tool/toolviews/read-row.tsx` & `read-family-row.tsx`
  - `packages/client/ui-primitives/src/ReadBlock.tsx` & `ReadBlock.module.css`

#### 折叠态表现
- **Title**：“读取文件”；
- **Summary**：文件的相对路径（或截断路径），呈现点状下划线，支持点击与快捷键直接调用宿主应用。

#### 展开态表现 (`ReadBlock`)
1. **独立 Banner 与窗口范围标注（Windowed Note）**：
   - 卡片顶部包含专属深色 Banner，左侧显示文件名，右侧显示语言标识（如 `tsx`）与拷贝按钮；
   - 若仅读取了文件的一个区间（如第 100~150 行），Banner 明确提示 `显示 50 / 共 820 行`，避免用户误以为文件就此结束（[`ReadBlock.tsx:109, 124-137`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/ReadBlock.tsx#L109-L137)）。
2. **固定 48px 行号槽与禁止选中（Gutter Chrome Isolation）**：
   - `.gutter { width: 48px; text-align: right; user-select: none; }`；
   - 行号固定宽度，无论从 1 行跨越到 9999 行，右侧内容边界始终绝对整齐；
   - 最关键的是 `user-select: none`：用户在展开的代码中拉选复制文本时，**绝对不会把行号杂质复制进剪贴板**（[`ReadBlock.module.css:82-91`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/ReadBlock.module.css#L82-L91)）。
3. **视口可见性驱动的高性能语法高亮（Shiki Lazy Highlighting）**：
   - 在 [`ReadBlock.tsx:76-88`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/ReadBlock.tsx#L76-L88) 中，代码接入了 `useViewportHighlighting`，只有在代码块滚动进入可视视口后，才触发语法高亮；
   - 结合 `useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount)`，冷启动时即使复杂的 TextMate 语法包还在网络下载，卡片先以干净的纯文本渲染，语法包就绪后无缝刷新为彩色高亮代码，**零掉帧、零主线程卡顿**。

---

### 5.4 文件路径联动与键盘事件冒泡防御

在 `ToolRow` 中，只要工具调用涉及本地文件系统路径（`read`、`write`、`edit`、`read_image`），其单行中的路径文字就会被渲染为一个特殊的交互按钮：`.fileLink`（[`ToolRow.tsx:210-217`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx#L210-L217)）。

#### 视觉设计（点状下划线）
在 [`ToolRow.module.css:126-151`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.module.css#L126-L151)：
```css
.fileLink {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  text-decoration: underline dotted;
  text-decoration-color: var(--dsw-alias-label-tertiary);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  cursor: pointer;
}

.fileLink:hover {
  color: var(--dsw-alias-label-primary);
  text-decoration-color: currentColor;
}
```
- **点状下划线（`underline dotted`）**：既明确传达“这是一个可点击的超链接”，又足够轻盈，避免长路径在行下形成一道沉重刺眼的黑实线；
- **自适应收缩（`flex: 0 1 auto`）**：按钮的物理点击判定区**只到路径文字末尾为止**，行内右侧剩余的空白区域依然保持为整行的“折叠/展开”热区。

#### 事件冒泡隔离铁律（Event StopPropagation）
这是最容易被普通工程师忽视的严重交互陷阱：
因为整行本身具备 `onClick`（点击折叠/展开），如果用户点击了路径超链接，点击事件如果向上冒泡，会导致：**一边在系统打开了文件，一边工具行又被展开或折叠了！**

DeepSeek 在鼠标和键盘两个维度做到了绝对严密的事件隔离（[`ToolRow.tsx:175-185`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx#L175-L185)）：
```tsx
const openFile = (event: MouseEvent<HTMLButtonElement>) => {
  event.stopPropagation() // 严禁冒泡到 DisclosureRow
  if (filePath !== undefined) onOpenFile?.(filePath)
}

// 键盘无障碍防御：
// 当焦点在路径链接上时，敲击 Enter 或 Space 会触发原生 button 点击，
// 但如果不阻止冒泡，该按键事件会冒泡到行外层的 onKeyDown，
// 从而触发 preventDefault() 并切换折叠状态！
const fileLinkKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
}
```
通过这两个 `stopPropagation()`，用户无论是鼠标点击路径，还是通过 Tab 键聚焦到路径并按回车，都只会精准触发系统的 `onOpenFile`（打开 VS Code / 操作系统默认关联编辑器），而绝不误触外层的折叠状态机。

---

### 5.5 Search / Todo / AskQuestion 专有视图横向对比

除了上述三大主力视图外，DeepSeek-Harness 还对其他高频交互场景实现了专属特化：

| 专有视图 | 注册工具 Key | 折叠态特化行为 | 展开态卡片能力 | 核心源码位置 |
|---|---|---|---|---|
| **Search 搜索** | `grep`, `glob` | Title 细分为“文本检索”（grep）与“文件检索”（glob）；Summary 智能合并多 query 为以逗号分隔的单行。 | 区分 `matches` 与 `paths` 两种形态；Grep 按文件分组，Glob 扁平列表；支持中间截断；**带有 Recovery 找回尾注**（显示被截断数据的磁盘恢复路径）。 | [`search-row.tsx:18-38`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/toolviews/search-row.tsx#L18-L38)<br>[`SearchBlock.tsx:62-90`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-primitives/src/SearchBlock.tsx#L62-L90) |
| **Todo 待办** | `todo_write` | Title 显示“任务规划”；Summary 解析出 `已完成 M / 共 N 项 · 当前活跃任务`；**尾部固定挂载 `+K` 后缀（绝对防截断）**。 | 展开后直接以结构化清单或 IN/OUT 代码块展示任务状态变迁。 | [`todo-row.tsx:26-67`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/toolviews/todo-row.tsx#L26-L67) |
| **AskQuestion 询问** | `ask_user_question` | 根据状态机实时演进：待输入显示“等待确认”，用户取消显示“已取消”，执行中断显示“已终止”，回答后显示“已回答 X / 共 Y 个问题”。 | 渲染 `AskQuestionCard`：区分已回答状态（`<dl>` 问题与选中答案列表）与未回答/中断状态（`<p>` 结论原因 + 未决问题列表）。 | [`ask-question-row.tsx:140-195`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/toolviews/ask-question-row.tsx#L140-L195)<br>[`AskQuestionCard.tsx:11-40`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/AskQuestionCard.tsx#L11-L40) |
| **Generic 兜底** | 任意未注册工具 | 自动推导参数首行，若是文件类工具依然尝试提取可点击路径；在 `others` 变体下将工具原始名置入摘要区。 | 展开后渲染通用的 **IN/OUT 双分栏卡片**（`ioCard`）：输入区（IN）与输出区（OUT）中间以 0.5px 分隔线切分，独立滚动。 | [`GenericToolCard.tsx:30-67`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/toolviews/GenericToolCard.tsx#L30-L67)<br>[`ToolRow.tsx:292-312`](file:///c:/Software/conex/reference/deepseek-harness/packages/client/ui-tool/src/client/tool/components/ToolRow.tsx#L292-L312) |

---

## 6. 设计哲学对比：为什么“单行折叠 + 原生卡片”远优于传统“厚重气泡卡片”？

为直观展示两者的体验差异，先列出系统级对比矩阵：

| 对比维度 | 传统厚重气泡卡片（Traditional Heavy Bubbles） | DeepSeek 单行极简折叠（Minimal 24px Inline Disclosure） |
|---|---|---|
| **默认视高占用** | 80px ~ 240px（占据半屏至一整屏） | **严格 24px**（仅相当于单行正文高度） |
| **视觉边界感** | 粗边框、外层大阴影、外层卡片渐变底色，极度厚重 | **无外边框、无底色、无阴影**，完全融入文本流 |
| **视线连续性（Scan-ability）** | 对话流被巨大色块切得支离破碎，正文阅读严重断裂 | **线性纯粹**，一目十行顺畅通读，工具行如同 Git 日志中的一条 commit |
| **大量工具并发表现** | 10 次调用导致屏幕必须滚动 3~5 屏，产生强烈的认知迷失 | 10 次调用仅占用 240px，在单个视口内一览无余 |
| **运行态动效** | 旋转加载环（Spinner）、高对比度脉冲闪烁，多卡片并发时晃眼 | **2.6s 柔和反向背景扫光**，优雅、安静、不喧宾夺主 |
| **展开时信息组织** | 粗暴倾倒整个 JSON 字符串或简单带行号的 pre 块 | **领域特化视图**：Terminal（ANSI+CWD）、Diff（+/-增删）、Read（视口语法高亮） |
| **交互与生产力** | 纯网页式孤岛，无法与本地环境共鸣 | 路径点击/快捷键**直通宿主系统默认编辑器**，生产力极强 |
| **屏幕阅读器无障碍** | 读屏软件被各种无意义的容器 div、状态点标签轰炸 | 视觉元素一律 `aria-hidden`，专供 1px 屏幕阅读器摘要文本 |

### 深度剖析：认知负荷与流式节奏的重构

#### 1. 工具调用的本质是“过程附注”，而非“最终交付物”
在人机对话中，用户的核心诉求是获得 AI 的回答与工作成果。
工具调用（如读文件、查代码、跑测试）属于 **推理实施的中间脚手架（Ephemeral Scaffolding）**。
- 传统厚重卡片错误地将这些“脚手架”赋予了与正文相同甚至更高的视觉权重（巨大的容器、沉重的背景）；
- DeepSeek 的 24px 单行规范，在认知心理学上属于 **渐进式披露（Progressive Disclosure）** 的典范：
  “**平时静如止水，需要时雷霆万钧**”。在平时只占用 24px 的安静单行，向用户报备“我正在/已经读取了什么文件”；只有当用户产生疑问、需要审查细节时，轻轻一点，即可就地展开媲美专业 IDE 的高质量原生卡片。

#### 2. 流式体验（Streaming Rhythm）的物理稳定性
在流式对话中，AI 边思考、边吐字、边调用工具。
如果使用厚重卡片，每触发一个工具，视口就会瞬间被剧烈撑大上百像素，触发浏览器的强制重排与滚动跳动（Scroll Jitter），极易引发用户的眩晕与焦躁。
而 24px 的单行工具行，其高度严格稳定（高度恒定为 `calc(24px + fontDelta)`），即使快速插入 5 个工具行，视口也仅仅是平缓推进 120px，配合稳定的滚动锚定（Scroll Anchoring），阅读节奏行云流水。

---

## 7. 对 Conex / Crish 桌面端正文界面的重构与工程落地建议

Conex / Crish 作为基于 Rust + Tauri 的现代化 Agent 工作台，当前在正文工具调用呈现上仍存在卡片偏重、行高与边界不够克制、工具状态反馈不平滑等痛点。参考 DeepSeek-Harness 的成熟经验，提出以下三步走落地建议：

### 阶段一：引入 24px 单行骨架与 CSS 规范（收敛视觉层级）
1. **移植 `DisclosureRow` 原语**：
   - 在前端 UI 原语包中实现类似 `DisclosureRow` 的标准化 24px 组件；
   - 严格遵循 `[16px leading] gap 6 [title 13px] gap 8 [2x2 dot] gap 8 [summary 13px fill truncate]` 几何布局；
   - 引入鼠标悬停时的 `Hover Chevron` 交叉淡入淡出（100ms 纯 CSS 无位移替换），彻底替换粗糙的固定箭头。
2. **清除工具行默认重阴影与粗边框**：
   - 彻底贯彻仓库根目录 `ANTI_OVERENGINEERING_GUARDRAILS.md` 和 `AGENTS.md` §13 规范：折叠态严禁重阴影与深黑边框，背景保持扁平轻量。

### 阶段二：实现 Shimmer 扫光带与 StateDot 体系（重构状态表达）
1. **替换 Spinner 为 CSS Shimmer Sweep**：
   - 采用 `color-mix(in srgb, var(--bg-base) 60%, transparent) 55%` 的反向背景冲淡渐变，配以 `2.6s ease-out` 周期；
   - 让长时间运行的命令或扫描工具在视觉上安静运行，大幅降低用户视觉疲劳。
2. **落地标准 StateDot 与无障碍标记**：
   - 封装 `StateDot` 原语，静态态采用 `::before`（光晕 10%）+ `::after`（核心 60%）双层结构；
   - 运行态引入 8 单元像素矩阵跑马灯，给桌面端注入极客终端美感；
   - 严守 `aria-hidden` 与 `.visuallyHidden` 规范，杜绝无障碍回归。

### 阶段三：专有视图卡片与系统级联动（提升生产力深度）
1. **文件路径直通系统**：
   - 将工具输出中的路径统一加上 `.fileLink` 样式（点状下划线 `underline dotted`）；
   - 绑定 Tauri 命令（如 `open_path_in_editor` 或 `show_in_folder`），并在 React 层做好 `stopPropagation`，杜绝触发展开折叠。
2. **升级 DiffBlock 与 TerminalBlock**：
   - 弃用简单的 pre 代码输出，引入类似 `DiffBlock` 的 `+A -R` 折叠态前置统计和 Head-Tail（中部折叠）算法；
   - Terminal 展开区实施独立纵向滚动（Banner 固定、滚动条内缩），保持桌面端操作的高质感。

---

## 8. 结论

DeepSeek-Harness 在工具行与专有视图上的设计，不是简单的“把组件做小”，而是一次**深思熟虑的人机协同交互重构**。它以 24px 极简单行为基石，通过克制优雅的扫光动效、复古科技感的状态圆点、精巧的防挤压与事件防御机制，以及展开后极其专业的差异化卡片，完美兼顾了**日常阅读的高信噪比**与**深度排查的高专业度**。这一套经过生产验证的代码与设计模式，对 Conex / Crish 打造下一代桌面级极简 AI 对话流具有极高的吸收与借鉴价值。
