# 动效与微交互战役：工作期发现问题登记册（Discovered Issues Register）

> **工作区**：`docs/motion-micro-interaction-polish/`  
> **建立目的**：遵照用户指示：“_工作要认真负责，如果工作过程中顺便发现其他的问题可以顺便修改，如果问题比较大，可以记录一下，等后面都改完后再分配agent审查这些记录的问题_”。  
> **使用规约**：
>
> 1. **小问题**（单行样式遗漏、简单属性未对齐、Token 语法小瑕疵）：实现 Agent 现场直接顺手修复，并在汇报中留痕；
> 2. **大问题**（涉及跨模块架构断层、状态机复杂竞态、组件深层生命周期解耦、或超出本战役批次边界的缺陷）：请实现 Agent 与审查 Agent 统一登记至本册；
> 3. **后置审查**：本战役全部 4 个批次修改完备后，由主控统一再次分配专项 Review Agent 对本册登记的问题进行逐项审查与处理。

---

## 登记项清单

| 编号          | 发现时间             | 发现 Agent            | 涉及模块与文件:行号                                                                                              | 问题定性与表现描述                                                                                                                                                                                             | 拟定处理建议 / 状态                                                                                                                                           |
| :------------ | :------------------- | :-------------------- | :--------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ISSUE-B1-01` | 2026-10-12T08:35:00Z | explorer_b1_tokens_1  | `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:176`                               | `.userBubbleContextEnvelope` 中引入裸混色 `background: color-mix(in srgb, var(--text-primary) 3%, transparent);`，击穿 `style-contract.test.ts` 的 `全仓裸混色计数严格清零 (0)` 硬门禁，导致 vitest 测试失败。 | ✅ **已于 Batch 1~5 落地修复并经单测验证**（收敛至 `var(--tint-hover)`，全仓裸混色严格归零，`style-contract.test.ts` 门禁 100% 通过）                         |
| `ISSUE-B1-02` | 2026-10-12T08:35:00Z | explorer_b1_curves_1  | `markdown-editor.html:204`                                                                                       | 根目录 Markdown 原型交互复选框声明了 `cubic-bezier(0.175, 0.885, 0.32, 1.275)` ($y_2 = 1.275 > 1.02$)，存在 27.5% 过冲振荡。因受根目录核心资产保护红线约束未在本次批次内变更。                                 | ℹ️ **已完成审计评估并维持保护留存**（根目录独立原型 HTML，非桌面端打包产物，受资产保护红线约束维持原样）                                                      |
| `ISSUE-B1-03` | 2026-10-12T08:35:00Z | explorer_b1_curves_1  | `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:144` & `PaneHeader.module.css:119` | 对非合成层几何布局属性（`left, width, top, height` 及 `flex-basis, width`）声明 `will-change`，无法获得 GPU 合成加速，反向诱导 Chromium 反复创建快照并逐帧失效栅格化。                                         | ✅ **已于 Batch 1~5 落地修复并经单测验证**（彻底剥离 `BinaryTreeWorkspace` 与 `PaneHeader` 的非合成层 `will-change` 声明，根治 Layout Thrashing）             |
| `ISSUE-B1-04` | 2026-10-12T08:35:00Z | explorer_b1_curves_1  | `apps/crish-desktop/src/hooks/tab-drag/tabDragGhost.ts:240-246`                                                  | 动画时序截断物理 Bug：JS 过渡动画声明 `0.28s`（280ms），但 `setTimeout` 在 `200ms` 即强制 `overlay.remove()`，导致动画最后 80ms 被生硬掐断闪烁。                                                               | ✅ **已于 Batch 5 Task 3 彻底修复闭环**（setTimeout 与 CSS 0.28s 对齐至 280ms，单测通过）                                                                     |
| `ISSUE-B1-05` | 2026-10-12T08:35:00Z | explorer_b1_curves_1  | `apps/crish-desktop/src/components/ui/Switch/Switch.module.css:164, 182-211`                                     | Switch 关键帧动画通过直接修改 `width`（14px -> 18px -> 14px）模拟果冻拉伸并标记 `will-change: transform, width`，每一帧触发局部几何 Reflow 与圆角失真。                                                        | ✅ **已于 Batch 5 Task 3 彻底修复闭环**（移除 will-change: width，重构为 GPU transform micro-scaling，单测通过）                                              |
| `ISSUE-B3-01` | 2026-10-12T08:37:00Z | explorer_b3_b4_prep_1 | `apps/crish-desktop/src/components/chat-card/ComposerErrorBar.module.css` 及 `ChatStatusRibbons.module.css`      | 派发任务路径偏差：提示位于 `chat-composer`，实际组件与样式位于 `chat-card`（`ComposerErrorBar.module.css` 与 `ChatStatusRibbons.module.css`），且 `DynamicChipBar.module.css` 物理文件并不存在。               | ✅ **已于 Batch 3 落地对齐并经单测验证**（物理路径校正收敛至 `chat-card/`，杜绝碎片与孤岛文件，测试全绿）                                                     |
| `ISSUE-B3-02` | 2026-10-12T08:37:00Z | explorer_b3_b4_prep_1 | `apps/crish-desktop/src/components/chat-message-row/ReasoningRow.tsx`                                            | 详案五在实现思维链平滑收拢时，使用了 `if (process.env.NODE_ENV === 'test') return;` 测试环境作弊分支来迎合单测 `toBeNull()`。                                                                                  | ✅ **已于 Batch 4~5 落地重构并经单测验证**（彻底清退测试环境旁路代码，依托真实 `isTurnWorking` 终态流转驱动平滑收敛，23/23 单测全绿）                         |
| `ISSUE-B4-01` | 2026-10-12T08:37:00Z | explorer_b3_b4_prep_1 | `apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.tsx:93`                                      | 原生 `hidden="until-found"` 属性在折叠时被同步设置，直接在 Chromium 内部掐灭渲染流水线，导致 CSS Grid 160ms 折叠动画被 100% 抹杀。                                                                             | ✅ **已于 Batch 4 落地重构并经单测验证**（解耦 `hidden` 同步挂载时序，180ms 延迟挂载保障 CSS Grid 0fr 动画完整播放）                                          |
| `ISSUE-B4-02` | 2026-10-12T08:37:00Z | explorer_b3_b4_prep_1 | `apps/crish-desktop/src/components/sidebar/useSidebarResize.ts:197`                                              | 侧栏拖拽松手时，`document.body.classList.remove('is-resizing')` 先于 `applySidebarWidth` 执行，过早恢复 200ms 过渡，导致松手瞬间侧栏反常跳动。                                                                 | ✅ **已于 Batch 4 落地重构并经单测验证**（`requestAnimationFrame` 延迟解除拖拽遮罩与 class，根除拖拽松手反常抖动，单测通过）                                  |
| `ISSUE-B1-06` | 2026-10-12T08:40:00Z | explorer_b1_syntax_1  | `apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.module.css:22, 120`                             | 未定义关键帧引用：引用了全仓不存在的 `@keyframes cds-fade-in` 与 `@keyframes cds-fade-out`，导致工作区空态页面进场与退场 0ms 瞬间生硬闪现。                                                                    | ✅ **已于 Batch 5 落地修复并经单测验证**（统一替换为标准 `@keyframes crish-fade-in` 与 `@keyframes crish-fade-out`，彻底消除未定义关键帧悬空引用）            |
| `ISSUE-B1-07` | 2026-10-12T08:40:00Z | explorer_b1_syntax_1  | `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.module.css:184`                       | 幽灵未定义 Token 悬空消费：`transition: width var(--transition-normal);` 消费了中央 `tokens.css` 中长期未定义的变量且无 fallback，导致胶囊条宽度完全无平滑过渡。                                               | ✅ **已于 Batch 1~5 落地闭环并经单测验证**（`tokens.css` 注入 `--transition-normal` 标准速查 Token 及 reduced-motion 0ms 安全重置，变量合法解析）             |
| `ISSUE-B5-01` | 2026-10-12T09:22:00Z | executor_b5_t6        | `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.module.css`                                         | 蓝图路径偏差：详案与任务书列出的目标文件 `TreeLeafPanel.module.css` 物理上不存在，实际 `.dockPanelPane` 类与叶子样式均维护于 `BinaryTreeWorkspace.module.css`。                                                | ✅ **已于 Batch 5 Task 6 就地修复闭环**（蓝图路径校正，对齐注入 `BinaryTreeWorkspace.module.css:450` 交叉淡入动画与 `@keyframes panelCrossFadeIn`，单测全绿） |

---

## 详细问题分析与现场证据（大问题详情展开）

### ISSUE-B1-01: ChatMessageRow.module.css:176 裸混色击穿 style-contract 门禁

- **现场证据**：
  在 `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:176` 中，最新改动增加了如下规则：
  ```css
  .userBubbleContextEnvelope {
    ...
    background: color-mix(in srgb, var(--text-primary) 3%, transparent);
    ...
  }
  ```
- **门禁阻断现场**：
  运行 `npx vitest run apps/crish-desktop/src/styles/style-contract.test.ts` 产生失败：
  ```
  FAIL unit apps/crish-desktop/src/styles/style-contract.test.ts > 批次 2 · ② 禁新裸混色（text-primary 基底，严格清零铁律） > 全仓裸混色计数严格清零 (0)
  AssertionError: 裸混色消费点必须严格为 0，发现 1 处违规点：
  C:\Software\conex\apps\crish-desktop\src\components\chat-message-row\ChatMessageRow.module.css:176: background: color-mix(in srgb, var(--text-primary) 3%, transparent);: expected 1 to be +0
  ```
- **影响定性**：
  该门禁为仓库已锁死铁律（`BARE_MIX_BASELINE = 0`），所有向 `--text-primary` 的裸混色必须由 Design Token 统一收敛。若不修复，全仓 CI / vitest 将持续红灯报错。
- **落地状态与验证**：
  已在 Batch 1 / Batch 5 彻底修复，将背景收敛至标准 Design Token `var(--tint-hover)`，边框使用 `color-mix(in srgb, var(--border-color, currentColor) 35%, transparent)`。运行 `npx vitest run apps/crish-desktop/src/styles/style-contract.test.ts` 严格满足 `BARE_MIX_BASELINE = 0`，全仓裸混色清零，门禁 100% 通过。

### ISSUE-B1-02: markdown-editor.html:204 原型复选框过冲贝塞尔曲线

- **现场证据**：
  在 `markdown-editor.html:204` 中：
  ```css
  .interactive-checkbox {
    ...
    transition: transform 0.15s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  }
  ```
- **参数分析**：
  $y_2 = 1.275 > 1.02$，属于明显的弹性过冲曲线（+27.5% overshoot）。
- **影响定性与边界**：
  虽然处于根目录历史原型工具文件中，且受核心资产保护红线约束未在本次批次直接编辑，但在后续全仓动效统一审计中应予以核准修正。
- **审计评估与结论**：
  经专项审计核实，`markdown-editor.html` 为仓库根目录历史独立原型演示文件，不参与 `apps/crish-desktop` 桌面端 Vite/Tauri 打包，全仓样式与动效门禁（`apps/crish-desktop/src/styles/`）覆盖范围为 `src/` 生产资产。遵照仓库《测试资产保护铁律》与根目录核心参考文件保护红线，维持该原型演示文件原状不予扰动。

### ISSUE-B1-03: 几何布局属性滥用 will-change 导致反向性能损耗

- **现场证据**：
  在 `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:144`：
  ```css
  :global(.tree-resizing) .leaf,
  :global(.tree-dragging) .leaf {
    transition: none;
    will-change: left, width, top, height;
  }
  ```
  在 `apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css:119`：
  ```css
  .tab {
    ...
    will-change: flex-basis, width;
  }
  ```
- **机理分析**：
  `left, width, top, height, flex-basis` 为标准 Layout 属性。对它们设置 `will-change` 不仅无法由 Compositor 线程处理，反而迫使 Blink 在主线程维持图层快照并在每帧几何改变时触发全量重新栅格化，造成严重的 Layout Thrashing。
- **落地状态与验证**：
  已在 Batch 1 与 Batch 5 彻底修复：
  1. `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:141-144` 彻底剥离 `will-change: left, width, top, height;`；
  2. `apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css:116-119` 彻底剥离 `will-change: flex-basis, width;`。
     两者不再强制 Blink 主线程保留栅格快照，彻底消灭 Layout Thrashing。

### ISSUE-B1-04: tabDragGhost.ts:240-246 动画时序早夭截断 Bug

- **现场证据**：
  在 `apps/crish-desktop/src/hooks/tab-drag/tabDragGhost.ts:242-244` 中：
  ```typescript
  overlay.style.transition = 'transform 0.28s ease-out, opacity 0.28s ease-out';
  /* ... */
  window.setTimeout(() => overlay.remove(), 200);
  ```
- **机理分析**：
  CSS 明确声明过渡时长为 `0.28s`（280ms），但 JS 却在 `200ms` 时硬性调用 `overlay.remove()` 将 DOM 彻底销毁。动画在最后 80ms 尚处渐变过程中被暴力掐断，导致拖拽松手时元素闪烁消失。
- **落地状态与验证**：
  已在 Batch 5 Task 3 彻底修复：在 `apps/crish-desktop/src/hooks/tab-drag/tabDragGhost.ts:255, 264` 中，将动画后 DOM 卸载定时器 `setTimeout(..., 200)` 精确对齐至 `setTimeout(..., 280)`，与 CSS 声明的 `0.28s`（280ms）平滑过渡时序保持 100% 一致，彻底消除拖拽松手早夭闪烁。

### ISSUE-B1-05: Switch.module.css:164, 182-211 width 形变动画引发 Reflow

- **现场证据**：
  在 `apps/crish-desktop/src/components/ui/Switch/Switch.module.css:164`：
  ```css
  .thumb {
    ...
    will-change: transform, width;
  }
  @keyframes thumb-stretch-on {
    0% { width: var(--thumb-d); transform: translateY(-50%) translateX(0); }
    50% { width: var(--thumb-stretch-w); transform: translateY(-50%) translateX(var(--stretch-x-on)); }
    100% { width: var(--thumb-d); transform: translateY(-50%) translateX(var(--thumb-travel)); }
  }
  ```
- **机理分析**：
  在微小按钮开关中通过 `width` 改变模拟果冻拉伸，导致每一帧动画都引发局部的重排与重绘，且圆角拉伸失真。应在后续批次升级为纯合成层的 `transform: scaleX(...)`。
- **落地状态与验证**：
  已在 Batch 5 Task 3 彻底修复：在 `apps/crish-desktop/src/components/ui/Switch/Switch.module.css` 中，彻底移除 `will-change: width`（收敛为 `will-change: transform`），并将 `@keyframes thumb-stretch-on` / `thumb-stretch-off` 重构为基于 GPU 纯合成层的 `scaleX(1.08) scaleY(0.95)` 微形变拉伸，每一帧 0 Reflow，单测全绿。

### ISSUE-B3-01: 目标样式文件物理路径偏差排查

- **现场证据**：
  任务书与初版审计提及 `apps/crish-desktop/src/components/chat-composer/ComposerErrorBar.module.css` 与 `DynamicChipBar.module.css`。
  经全局文件树排查，实际物理对应关系为：
  1. `ComposerErrorBar.tsx` 与 `ComposerErrorBar.module.css` 物理位于 `apps/crish-desktop/src/components/chat-card/`；
  2. `DynamicChipBar.tsx` 物理位于 `apps/crish-desktop/src/components/chat-card/`，其样式完全收敛于同目录下的 `ChatStatusRibbons.module.css`，不存在独立的 `DynamicChipBar.module.css`。
- **影响与建议**：
  在施工蓝图与后续任务派发中明确物理路径，避免后续 Agent 误在 `chat-composer` 目录创建重复或无效的孤岛样式文件。
- **落地状态与验证**：
  已在 Batch 3 蓝图与施工中全面校准：相关组件与样式严格归属于 `apps/crish-desktop/src/components/chat-card/`（`ComposerErrorBar.module.css` 与 `ChatStatusRibbons.module.css`），未产生任何碎片或孤立文件，全仓路径一致性保持 100%。

### ISSUE-B3-02: ReasoningRow 思维链平滑折叠中的 NODE_ENV === 'test' 作弊分支

- **现场证据**：
  在 `docs/motion-micro-interaction-polish/05-全局平铺微交互死角与体验润色详案.md:529` 中，曾提议：
  ```typescript
  // 单测环境下跳过过渡直接销毁，确保既有 toBeNull() 断言 100% 满足
  if (process.env.NODE_ENV === 'test') return;
  ```
- **机理与红线违规**：
  此举违背了用户与 `ORIGINAL_REQUEST.md` 中的“**Zero test-environment bypasses（零测试环境作弊分支）**”非妥协铁律。
  根因在于单测 `ReasoningRow.test.tsx:253` 模拟的是用户手动点击按钮收起；而视口跳跃的核心病灶发生在“AI 模型生成结束，由 `isTurnWorking` 跃迁为终态”。
- **解决方案**：
  将 180ms 折叠状态机精准锚定于 `isTurnWorking` 终态流转（`prevTurnWorking && !isTurnWorking`），在手动切换时直接响应。完全消除测试环境特判，保持生产与测试环境强一致。
- **落地状态与验证**：
  已在 Batch 4 与 Batch 5 彻底重构：在 `apps/crish-desktop/src/components/chat-message-row/ReasoningRow.tsx` 中彻底清除所有 `NODE_ENV === 'test'` 测试环境绕道作弊分支。折叠状态机精准基于模型流式完成（`prevTurnWorking && !isTurnWorking`）触发平滑收敛，`ReasoningRow.test.tsx` 23/23 单测 100% 真实通过。

### ISSUE-B4-01: FoldableToolGroup 同步挂载 hidden 破坏 CSS Grid 动画

- **现场证据**：
  在 `apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.tsx:93` 中：
  ```typescript
  if (!isExpanded) {
    el.setAttribute('hidden', 'until-found');
  }
  ```
- **机理分析**：
  带有 `hidden` 属性的 DOM 节点在 Chromium 内核中直接跳过渲染流水线。导致 CSS Grid 还没来得及运行第 1 帧 `grid-template-rows: 0fr` 过渡，整个内容就被物理掐死，收拢动画永远无法播放。
- **解决方案**：
  解耦 `hidden` 的同步设置，展开态确保无 `hidden`，折叠态由 CSS Grid `0fr` + `overflow: hidden` 天然实现 0 像素物理安全闭合。
- **落地状态与验证**：
  已在 Batch 4 彻底修复：在 `apps/crish-desktop/src/components/chat-tool-call/FoldableToolGroup.tsx` 中解耦 `hidden` 属性的时序。展开态立即移除 `hidden`，折叠态通过 180ms 定时器在 CSS Grid 0fr 动画播放完成后延迟挂载 `hidden="until-found"`，兼顾无障碍与平滑折叠，单测全绿。

### ISSUE-B4-02: useSidebarResize 拖拽松手时序竞争导致回弹跳动

- **现场证据**：
  在 `apps/crish-desktop/src/components/sidebar/useSidebarResize.ts:197-206` 中：
  `document.body.classList.remove('is-resizing')` 先于 `applySidebarWidth(finalWidth)` 执行。
- **机理分析**：
  class 移除后 CSS `transition: width 200ms` 瞬间恢复生效；紧接着写入 `finalWidth` 时触发了 200ms 的平滑补间动画，造成用户松手瞬间侧栏发生微小回弹滑行。
- **解决方案**：
  在 `applySidebarWidth` 写入 CSSOM 之后，通过 `requestAnimationFrame` 将 class 移除延迟至下一帧，确保写回操作完全处于 0 延迟保护期内。
- **落地状态与验证**：
  已在 Batch 4 彻底修复：在 `apps/crish-desktop/src/components/sidebar/useSidebarResize.ts` 中，通过 `requestAnimationFrame` 将 `document.body.classList.remove('is-resizing')` 延迟至下一帧，确保 `applySidebarWidth` 写入 CSSOM 时处于 0 延迟保护期内，彻底根除松手瞬间侧栏反常弹跳。

### ISSUE-B1-06: WorkspaceEmptyState.module.css:22, 120 引用未定义关键帧 cds-fade-in / cds-fade-out

- **现场证据**：
  在 `apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.module.css:22` 与 `120` 中：
  ```css
  .workspaceEmptyState {
    ...
    animation: cds-fade-in var(--transition-smooth) forwards;
  }
  .workspaceEmptyStateExit {
    animation: cds-fade-out var(--transition-smooth) forwards;
  }
  ```
- **机理分析**：
  全仓没有任何 CSS 文件定义了 `@keyframes cds-fade-in` 或 `@keyframes cds-fade-out`。浏览器在解析未定义的 keyframes 时无法生成任何补间帧，导致工作区空态页面挂载与退出时完全失去 `var(--transition-smooth)`（300ms）平滑淡入淡出动效，表现为 0ms 瞬间生硬闪现。
- **解决方案**：
  在权威动效关键帧体系中统一定义 `@keyframes crish-fade-in` 与 `@keyframes crish-fade-out`（或直接使用 `opacity: 0 -> 1` 与 `opacity: 1 -> 0`），并将此处死引用修复为合法权威关键帧。
- **落地状态与验证**：
  已在 Batch 5 彻底修复：在 `apps/crish-desktop/src/components/workspace/WorkspaceEmptyState.module.css:22, 120` 中，将未定义的 `cds-fade-in` 与 `cds-fade-out` 统一替换为 `design-system.css` 权威定义的 `@keyframes crish-fade-in` 与 `@keyframes crish-fade-out`，平滑淡入淡出动效完全恢复。

### ISSUE-B1-07: ModelDistributionSection.module.css:184 消费未定义幽灵 Token `--transition-normal`

- **现场证据**：
  在 `apps/crish-desktop/src/components/settings/usage/ModelDistributionSection.module.css:184` 中：
  ```css
  .capsuleBarBg {
    ...
    transition: width var(--transition-normal);
  }
  ```
- **机理分析**：
  `tokens.css` 中只定义了 `--duration-normal: 200ms;`，从未定义复合速查变量 `--transition-normal`。此处未提供 fallback，导致变量解析为空字符串，整条过渡声明作废，模型配额胶囊条在比例变化时完全失去宽度平滑过渡。
- **解决方案**：
  在 Batch 1 基础设施推进阶段，向 `tokens.css` 注入 `--transition-normal: var(--duration-normal) var(--ease-standard);`，使其与已有的 `--transition-micro` / `--transition-fast` 形成完备对称闭环。
- **落地状态与验证**：
  已在 Batch 1 与 Batch 5 闭环验证：向 `tokens.css:533` 注入复合速查变量 `--transition-normal: var(--duration-normal) var(--ease-standard);`，并在 reduced-motion 下安全重置为 `0ms`（行 1935、1967）。`ModelDistributionSection.module.css:184` 中的 `transition: width var(--transition-normal);` 正常合法解析，无悬空未定义引用。

### ISSUE-B5-01: 任务目标文件 `TreeLeafPanel.module.css` 物理文件不存在

- **现场证据**：
  在任务书与方案《05-全局平铺微交互死角与体验润色详案.md》§7.4 中，标注样式路径为 `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.module.css`，但该文件在物理磁盘与 Git 历史中均不存在。
- **机理分析**：
  `TreeLeafPanel.tsx` 原生依赖并导入的是 `styles from './BinaryTreeWorkspace.module.css'`。叶子容器类名 `.dockPanelPane`、`.leaf`、`.leafBody` 等均收敛于 `BinaryTreeWorkspace.module.css`。若盲目新建孤立的 `TreeLeafPanel.module.css`，不仅无法被 `TreeLeafPanel.tsx` 消费而沦为死代码碎片，还会违反 SSOT 原则。
- **解决方案**：
  对齐物理架构真实归属，直接在 `apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css:450` 就地增加 `.dockPanelPane[data-active-panel='true']` 的 120ms cross-fade 入场动效与 `@keyframes panelCrossFadeIn`，无缝闭环。
