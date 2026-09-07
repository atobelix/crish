# 对话流消息行周边组件 CSS Module 硬编码与暗黑闪白纯缺陷审计报告

> **权威路径**：`docs/chat-flow-systemic-remediation/audits/10-消息行组件CSS硬编码与暗黑闪白缺陷审计.md`  
> **审计对象**：
> 1. `apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css`
> 2. `apps/crish-desktop/src/components/chat-message-row/FlowArtifactChip.module.css`
> 3. `apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css`
> 4. `apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css`
> 5. `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css`
> 6. `apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css`
> 7. `apps/crish-desktop/src/components/chat-message-row/FlowPlanMilestone.module.css`

---

## 缺陷 01：【暗黑模式反色与失明隐患】Tooltip 文字与气泡采用亮色 Slate 裸色 Fallback 引发浅色模式文字隐形
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css:50-58`
- **断层事实**：
  在 `CacheMetricsBadge.module.css:50-58` 中：
  ```css
  .tooltipTitle {
    font-weight: 600;
    color: var(--text-primary, #f8fafc);
    margin-bottom: 2px;
  }

  .tooltipRow {
    color: var(--text-secondary, #cbd5e1);
  }
  ```
  CSS 变量声明了针对深色模式的 Tailwind Slate 硬编码 Fallback：`--text-primary` 的 fallback 为 `#f8fafc`（Slate-50，极亮白灰），`--text-secondary` 的 fallback 为 `#cbd5e1`（Slate-300，浅亮灰）。
- **危害后果 / 真实运行期隐患**：
  一旦在浅色主题环境、CSS 变量初次水合未决期或离线独立渲染测试中触发 Fallback，在默认纯白/浅米色 Tooltip 底板（`--bg-card: hsl(0 0% 100%)`）上，文字将呈现 `#f8fafc`（纯白对纯白）与 `#cbd5e1`（浅灰对纯白），对比度暴跌至 1.05:1 与 1.48:1，文字内容彻底隐形湮灭，导致用户在悬停缓存命中率徽章时完全无法阅读任何指标解释。

---

## 缺陷 02：【暗黑模式反向失真隐患】思维链扫光渐变混入近黑 Fallback `#111827` 导致暗黑主题瞬间黑块闪烁
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css:171-184`
- **断层事实**：
  在 `ReasoningRow.module.css:171-184` 中：
  ```css
  .sweepShine {
    background: linear-gradient(
      90deg,
      var(--text-tertiary, #9ca3af) 0%,
      color-mix(in srgb, var(--text-primary, #111827) 75%, transparent) 50%,
      var(--text-tertiary, #9ca3af) 100%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: sweep-shine 2.6s ease-in-out infinite;
    font-weight: 500;
  }
  ```
  在扫光文字的关键帧文字裁切渐变（`-webkit-background-clip: text`）中，高光中心点混入了硬编码的 Tailwind Gray-900 `#111827`（极深炭黑）。两端则使用了硬编码的 `#9ca3af`（Gray-400，亮灰）。
- **危害后果 / 真实运行期隐患**：
  在暗黑模式下，前景色基准应当是亮白/浅灰（`--text-primary: #dddddd`），但此处中间高光混合的 Fallback 居然是接近全黑的 `#111827`。当变量兜底触发时，流式扫光动画会在暗色底板上形成反向的“黑洞擦除效果”——文字不是在闪亮，而是在周期性变黑吞噬，造成剧烈的光感闪烁和视觉污染；而在浅色模式下，两端的 `#9ca3af` 在白底上的对比度仅 2.6:1，严重违反 WCAG 2.1 AA 4.5:1 的硬性标准。

---

## 缺陷 03：【Zero-Blue 铁律违背】硬编码饱和冷蓝 `#0288d1` 突破系统调色盘与全局设计中性契约
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css:24-33`
- **断层事实**：
  在 `CacheMetricsBadge.module.css:24-33` 中：
  ```css
  .write {
    color: var(--accent-primary, #0288d1);
    background: color-mix(
      in srgb,
      var(--accent-primary, #0288d1) 12%,
      transparent
    );
    border: 1px solid
      color-mix(in srgb, var(--accent-primary, #0288d1) 25%, transparent);
  }
  ```
  针对缓存写入态（`.write`），连续 3 处直接使用硬编码高饱和冷蓝 `#0288d1`（Material Blue 700）作为 `--accent-primary` 的 Fallback。
- **危害后果 / 真实运行期隐患**：
  仓库权威规范 `tokens.css:241` 与 `tokens.css:991` 明确下达铁律：“Zero-Blue 铁律：--accent-blue / --accent-primary 收敛为高对比中性墨阶与翡翠绿”。在整个 Conex 设计系统中严禁出现此类外挂的高饱和度纯蓝，此处硬编码直接击穿全局主题系统；并且在暗黑模式下，`#0288d1` 搭配 `color-mix 12%` 底衬，在暗底（`#242424`）上对比度仅 3.2:1，破坏了 Conex 纯净中性灰与翡翠绿活态签名的品牌色彩纯度。

---

## 缺陷 04：【违背 Conex §14 与暗黑模式脊柱消亡】旧式 `rgba()` 裸写致使暗黑模式里程碑轴线失明
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/FlowPlanMilestone.module.css:25-35`
- **断层事实**：
  在 `FlowPlanMilestone.module.css:25-35` 中：
  ```css
  /* 纵向 0.75px 脊柱线，精准居中于 16px 圆点下 (left: 7.625px) */
  .flowPlanStep::after {
    content: '';
    position: absolute;
    top: 30px;
    bottom: calc(var(--plan-gap) * -1);
    left: 7.625px;
    width: 0.75px;
    background-color: var(--border-color, rgba(0, 0, 0, 0.15));
    z-index: 0;
  }
  ```
  直接使用了旧式 `rgba(0, 0, 0, 0.15)` 作为 `--border-color` 的 Fallback。
- **危害后果 / 真实运行期隐患**：
  1. 违背 Conex §14 条款：“避免散落旧式 rgba(r,g,b,a)；UI 与 Design Token 优先 hsl(h s l / a) 或 hsla(...)，用斜杠 / 分隔不透明度或者 color-mix”；
  2. 运行期致命隐患：Fallback 假定了浅色底板（黑透明度 15%），一旦在深色模式（`--bg-card: #242424` 或 `--bg-primary: #1b1b1b`）下触发兜底，黑色 15% 透明度叠加在黑灰底板上，所绘制的 0.75px 纵向脊柱线与背景对比度几乎为 0，导致计划树的连线瞬间彻底“隐形消失”，节点悬空孤立。

---

## 缺陷 05：【悬空幽灵 Token 与旧式 `rgba()` 混合】产物下划线引用未定义变量与脏旧透明度
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/FlowArtifactChip.module.css:36-39`
- **断层事实**：
  在 `FlowArtifactChip.module.css:36-39` 中：
  ```css
  .flowArtifactChip {
    ...
    color: var(--brand-deep, #059669);
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-color: var(--brand-line, rgba(16, 185, 129, 0.35));
  ```
  1. 引用的 `--brand-line` 在整个 `tokens.css` 以及全局任何样式表中均**根本未定义**（全局 grep 结果为 0）；
  2. 其 Fallback 使用了裸写的旧式语法 `rgba(16, 185, 129, 0.35)`。
- **危害后果 / 真实运行期隐患**：
  由于 `--brand-line` 恒为空，浏览器在每一帧渲染时都必须退化为执行 Fallback 解析；而 `rgba(16, 185, 129, 0.35)` 在暗黑模式（底色 `#242424`）下呈现为缺乏对比度的脏绿色浑浊横线；同时 `--brand-deep` 的 Fallback `#059669` 是深翠绿（Light 专用色），在暗黑模式底色上的对比度仅 2.8:1，造成文字可读性严重下降，无法满足无障碍规范。

---

## 缺陷 06：【流式表格悬空 Token 链】4 处 `--stream-table-active-*` 幽灵变量导致动态边框全量走死兜底
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:86-110`
- **断层事实**：
  在 `StreamingTableContainer.module.css:86-110` 中：
  ```css
  @keyframes md-table-pulse {
    0%, 100% {
      outline-color: var(--stream-table-active-border, color-mix(in srgb, var(--brand, #10b981) 48%, var(--border-color)));
      box-shadow: var(--stream-table-active-glow, 0 0 0 1px color-mix(in srgb, var(--brand, #10b981) 18%, transparent));
      background-color: var(--stream-table-active-bg, color-mix(in srgb, var(--brand, #10b981) 6%, transparent));
    }
    50% {
      outline-color: color-mix(in srgb, var(--stream-table-active-border, color-mix(in srgb, var(--brand, #10b981) 48%, var(--border-color))) 35%, transparent);
      box-shadow: 0 0 0 0 transparent;
      background-color: color-mix(in srgb, var(--stream-table-active-bg, color-mix(in srgb, var(--brand, #10b981) 6%, transparent)) 25%, transparent);
    }
  }

  .tableContainerRoot[data-table-streaming='true'] .tableScrollViewport table tbody tr:last-child td:last-child,
  ... {
    position: relative;
    outline: 1px dashed var(--stream-table-active-border, color-mix(in srgb, var(--brand, #10b981) 48%, var(--border-color)));
    outline-offset: -1px;
    box-shadow: var(--stream-table-active-glow, 0 0 0 1px color-mix(in srgb, var(--brand, #10b981) 18%, transparent));
    background-color: var(--stream-table-active-bg, color-mix(in srgb, var(--brand, #10b981) 6%, transparent));
    animation: md-table-pulse var(--stream-table-pulse-duration, 1.6s) var(--stream-table-pulse-timing, cubic-bezier(0.16, 1, 0.3, 1)) infinite;
  }
  ```
  在 `tokens.css` 中只声明了 `--stream-table-active-bg` 和 `--stream-table-intrinsic-h`，而：
  - `--stream-table-active-border` **不存在**；
  - `--stream-table-active-glow` **不存在**；
  - `--stream-table-pulse-duration` **不存在**；
  - `--stream-table-pulse-timing` **不存在**。
- **危害后果 / 真实运行期隐患**：
  1. 四个核心变量全部悬空，CSS 解析器在流式生成高频脉冲动画执行时，必须进行多达 3 层嵌套 `color-mix()` 的动态代数求值；
  2. 变量中反复硬编码了多达 8 次 `#10b981` 裸写；
  3. 在暗黑模式下，由于缺少设计系统层级的暗色活跃边框定义，50% 关键帧中混合出的轮廓色在黑色表头和深黑卡片中几乎消失，产生“闪烁式抖动（Stuttering Flicker）”而非平滑呼吸感。

---

## 缺陷 07：【违背全局缓动正典】组件层私自内联 `cubic-bezier` 贝塞尔曲线
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:108`
  - `apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css:144`
- **断层事实**：
  1. 在 `StreamingTableContainer.module.css:108` 中：
     ```css
     animation: md-table-pulse var(--stream-table-pulse-duration, 1.6s) var(--stream-table-pulse-timing, cubic-bezier(0.16, 1, 0.3, 1)) infinite;
     ```
  2. 在 `TimelineThoughtSection.module.css:144` 中：
     ```css
     .thoughtAccordion {
       display: grid;
       grid-template-rows: 0fr;
       transition: grid-template-rows 200ms cubic-bezier(0.16, 1, 0.3, 1);
     }
     ```
- **危害后果 / 真实运行期隐患**：
  直接违背 `tokens.css:402-404` 铁律纪律：“缓动正典二元组：standard 服务色彩/透明度常规过渡，emphasized 服务几何位移（快出型）。全仓 transition/animation 的曲线只允许引用这两个名字（或下方别名）；组件文件禁止内联 cubic-bezier。”  
  此处组件文件私自硬编码写死 `cubic-bezier(0.16, 1, 0.3, 1)`，导致全局统一阻尼调节与 Reduced Motion 降级机制无法全局掌控折叠动效，且破坏了单一真理源（SSOT）原则。

---

## 缺陷 08：【无障碍致命违规】思维链头部折叠控件直接剔除焦点环且零补偿
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css:42-45`
- **断层事实**：
  在 `TimelineThoughtSection.module.css:42-45` 中：
  ```css
  .thoughtHeaderBtn:focus-visible {
    outline: none;
    color: var(--text-primary);
  }
  ```
  作为用户可以键盘 Tab 聚焦并按 Enter/Space 展开思维链的交互按钮（`<button className={styles.thoughtHeaderBtn}>`），其 `:focus-visible` 样式不仅将原生外边框硬性设为 `outline: none`，且没有提供任何 `box-shadow` 或微环（`var(--focus-ring)`）补偿，仅仅变动了字体颜色为 `--text-primary`。
- **危害后果 / 真实运行期隐患**：
  直接违背 WCAG 2.1 Success Criterion 2.4.7（Focus Visible 严格准则，Level AA）以及 Conex §13（焦点态微环规范）。键盘导航用户在消息流中 Tab 切换时，焦点光标完全凭空消失，用户根本无法感知当前是否聚焦在思维链折叠头上，造成严重的键盘可访问性阻断。

---

## 缺陷 09：【焦点规范撕裂与重复造轮子】私自手写 0.5px/2px 双层混合环违背系统 Token
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css:56-62, 275-280`
- **断层事实**：
  在 `ReasoningRow.module.css:56-62, 275-280` 中：
  ```css
  /* Conex §13 双层微弱焦点软环规范（对比度上限约 10%） */
  .reasoningRow:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 0.5px color-mix(in srgb, var(--text-primary) 6%, transparent),
      0 0 0 2px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
    border-radius: var(--radius-sm, 4px);
  }

  .copyButton:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 0.5px color-mix(in srgb, var(--text-primary) 6%, transparent),
      0 0 0 2px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  }
  ```
- **危害后果 / 真实运行期隐患**：
  代码注释声称遵守“Conex §13 双层微弱焦点软环规范”，但系统正典在 `tokens.css:167-177 / 914-918` 中早已确立了经过精确调优的语义 Token：`var(--focus-ring)`、`var(--focus-ring-subtle)`、`var(--focus-ring-strong)`。组件层脱离 Token 系统，在两处选择器中内联手写魔术数字 `0.5px` 和硬编码计算，既冗长又在后续全局设计系统调整微环半径或透明度时产生死角和漂移断层。

---

## 缺陷 10：【多处关键交互控件完全缺失焦点态定义】键盘导航焦点盲区
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:727-750`（`.iconBtn`）
  - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:219-235`（`.planApproveChip`）
  - `apps/crish-desktop/src/components/chat-message-row/FlowArtifactChip.module.css:22-56`（`.flowArtifactChip`）
  - `apps/crish-desktop/src/components/chat-message-row/FlowPlanMilestone.module.css:46-61`（`.flowPlanStepHead`）
- **断层事实**：
  1. `ChatMessageRow.module.css:727-750` 中的 `.iconBtn`（承载复制消息、固定置顶、撤回等高频操作按钮），仅书写了 `.iconBtn:hover`，完全未定义 `:focus` 或 `:focus-visible`；
  2. `ChatMessageRow.module.css:219-235` 中的 `.planApproveChip`（计划审批按钮），仅书写了 `:hover`，完全未声明 `:focus-visible`；
  3. `FlowArtifactChip.module.css:22-56` 中的 `.flowArtifactChip`（代码产物交互胶囊），声明了 `cursor: pointer;` 与 `:hover`，但无任何 `:focus-visible`；
  4. `FlowPlanMilestone.module.css:46-61` 中的 `.flowPlanStepHead`（折叠步骤头），声明了 `cursor: pointer;`，但完全缺失焦点样式。
- **危害后果 / 真实运行期隐患**：
  上述 4 类均为界面中的核心可交互节点。缺失 `:focus-visible` 导致浏览器要么展示极其粗糙违和的默认高对比黑色粗框，要么在特定 Chromium 宿主下无法呈现焦点指示，全键盘操作流在此处彻底“失明”，直接违反 Conex 基本交互契约。

---

## 缺陷 11：【跨层级容器底色错配】里程碑使用 `--bg-page` 导致深色模式卡片产生“穿孔黑洞”
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/FlowPlanMilestone.module.css:63-93`
- **断层事实**：
  在 `FlowPlanMilestone.module.css:74, 82, 88` 中：
  ```css
  .flowPlanStepNum {
    ...
    background: var(--bg-page);
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
  }

  .flowPlanStep.isDone .flowPlanStepNum {
    background: var(--bg-page);
    color: var(--text-primary);
  }

  .flowPlanStep.isRunning .flowPlanStepNum {
    background: color-mix(in srgb, var(--brand, var(--color-success)) 12%, var(--bg-page));
  }
  ```
- **危害后果 / 真实运行期隐患**：
  在 Conex 规范中，`--bg-page` 是窗口最外层的基础底色（在暗黑模式下 `tokens.css:920` 为 `#0c0c0b`，接近极黑），而消息卡片与对话流容器的背景是 `--bg-card` 或 `--bg-secondary`（`#242424`）。  
  当 `FlowPlanMilestone` 嵌套在 Assistant 消息卡片内部渲染时，步骤序号圆圈（`.flowPlanStepNum`）强行取用 `--bg-page`，导致步骤圆圈呈现为 `#0c0c0b`，仿佛在 `#242424` 的卡片底板上被硬生生抠出了一个深黑色的圆形空洞（Visual Punch-through），在暗黑模式下呈现明显的色彩断层和视觉穿孔。正典应使用宿主卡片底色 `var(--bg-card)` 或 `var(--bg-elevated)`。

---

## 缺陷 12：【死层代码残留】`ReasoningRow.module.css` 遗留无消费者 `@keyframes reasoning-row-sweep`
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css:162-169`
- **断层事实**：
  在 `ReasoningRow.module.css:162-169` 中：
  ```css
  @keyframes reasoning-row-sweep {
    0% {
      background-position: -200% 0;
    }
    100% {
      background-position: 200% 0;
    }
  }
  ```
  在第 153-160 行已经声明了 `@keyframes sweep-shine`，且下游第 182 行绑定的正是 `animation: sweep-shine ...`。全局代码中没有任何选择器引用 `reasoning-row-sweep`。
- **危害后果 / 真实运行期隐患**：
  纯粹的死代码与冗余垃圾规则，增加样式表解析与内存开销，违背 Conex 治理关于死层代码必须净收敛的铁律。

---

## 缺陷 13：【性能反模式】`copyButton` 盲目使用 `transition: all` 触发无效重排开销
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/ReasoningRow.module.css:253-267`
- **断层事实**：
  在 `ReasoningRow.module.css:264` 中：
  ```css
  .copyButton {
    ...
    transition: all var(--transition-fast, 150ms ease);
    line-height: 1.4;
    user-select: none;
  }
  ```
- **危害后果 / 真实运行期隐患**：
  `transition: all` 是经典的前端性能反模式。当组件状态发生变化（如重新渲染、边距变动、类名切换）时，浏览器渲染引擎会对该元素的所有计算样式（包括布局与几何属性）进行逐一补间插值计算，不仅导致主线程样式重计算开销成倍上升，还在高频对话更新场景下极易诱发掉帧，必须收敛为具体的硬件加速属性清单（如 `color, background-color, border-color, box-shadow`）。

---

## 缺陷 14：【Token 契约撕裂与数值二义性】`--button-radius` 与 `--radius-lg` Fallback 数值逆向漂移
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:120, 755`
- **断层事实**：
  1. 在 `ChatMessageRow.module.css:755` 中：
     ```css
     .retractBtn {
       ...
       border-radius: var(--button-radius, 7px);
     }
     ```
     而 `tokens.css:26, 454` 权威规范明确锁定：`--button-radius: 8px;`，注释着重标明：“几何尺寸与圆角契约 (锁定 8px 按钮圆角与 9999px 胶囊圆角)”；
  2. 在 `ChatMessageRow.module.css:120` 中：
     ```css
     .userImageWrapper {
       ...
       border-radius: var(--radius-lg, 10px);
     }
     ```
     而 `tokens.css:366` 权威规范明确定义：`--radius-lg: 8px;`。
- **危害后果 / 真实运行期隐患**：
  Fallback 数值（7px、10px）与 CSS 变量真实定义（8px）直接冲突对立。在变量解析异常、微前端沙箱隔离或离线测试单测中，按钮圆角会出现 7px 与 8px 的形变抖动，图片圆角会在 10px 与 8px 之间跳跃，破坏了 Conex 系统级圆角契约的一致性。

---

## 缺陷 15：【未声明悬空变量】`--transition-base` 幽灵引用绕过系统缓动正典
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:124`
- **断层事实**：
  在 `ChatMessageRow.module.css:124` 中：
  ```css
  .userImageWrapper {
    ...
    transition: transform var(--transition-base, 150ms ease), border-color var(--transition-base, 150ms ease);
  }
  ```
  在 `tokens.css` 中检索，仅存在 `--transition-fast`、`--transition-smooth`、`--transition-micro`，**根本不存在 `--transition-base`**。
- **危害后果 / 真实运行期隐患**：
  由于 `--transition-base` 恒为空，此处的 transition 恒定降级使用 `150ms ease`，导致图片缩放交互完全无法享受到 Conex 缓动正典 `--ease-emphasized`（`cubic-bezier(0.16, 1, 0.3, 1)`）带来的弹性高级质感，沦为浏览器默认的线性呆板 ease 过渡。

---

## 缺陷 16：【脆弱魔术亚像素 Hack 与硬编码排版】脊柱连线依赖 7.625px 浮点硬定位
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/FlowPlanMilestone.module.css:25-35`
- **断层事实**：
  在 `FlowPlanMilestone.module.css:25-35` 中：
  ```css
  /* 纵向 0.75px 脊柱线，精准居中于 16px 圆点下 (left: 7.625px) */
  .flowPlanStep::after {
    content: '';
    position: absolute;
    top: 30px;
    bottom: calc(var(--plan-gap) * -1);
    left: 7.625px;
    width: 0.75px;
    background-color: var(--border-color, rgba(0, 0, 0, 0.15));
    z-index: 0;
  }
  ```
- **危害后果 / 真实运行期隐患**：
  开发人员试图通过 `(16px - 0.75px) / 2 = 7.625px` 的代数计算强行将伪元素绝对定位。在 100%、125%、150% 等 Windows DPI 缩放下，Chromium 光栅化引擎对 `7.625px` 和 `0.75px` 的浮点舍入会产生严重的抗锯齿模糊或左右 1px 的周期性肉眼可见偏差（Pixel Jitter），连线与 16px 圆圈呈现“肉眼可见的不居中错位”；必须改用基于父级 Flex/Grid 相对居中或标准发丝线（`--hairline-width, 1px`）物理居中架构。

---

## 缺陷 17：【同文件焦点环语法分裂】三套互不相容的焦点环实现方式并存
- **代码文件与精确行号**：
  - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:108, 317, 485`
- **断层事实**：
  在同一个 `ChatMessageRow.module.css` 文件中：
  1. 行 108（`.userBubble:focus-visible`）：
     ```css
     box-shadow: 0 0 0 2px color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
     ```
  2. 行 317（`.followupChipMain:focus-visible` 等）：
     ```css
     box-shadow: var(--focus-ring);
     ```
  3. 行 485（`.assistantText :global(.md-path-link:focus-visible)`）：
     ```css
     box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--brand) 20%, transparent);
     ```
- **危害后果 / 真实运行期隐患**：
  同一个组件模块内部，针对聚焦态的实现出现了 3 种完全不同的设计语言：一种是 2px 灰黑混合环，一种是系统全局 Token `var(--focus-ring)`（1.5px 6% 主文本色混合），一种是 1.5px 20% 翡翠绿光晕。这种分裂导致用户在一条消息中从用户气泡导航到路径胶囊、再导航到追问按钮时，焦点环的粗细、色彩和扩散范围剧烈跳变，视觉体验极度粗糙不连续。
