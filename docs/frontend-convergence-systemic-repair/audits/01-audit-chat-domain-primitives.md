# Chat 消息交互域原子组件收敛深度审计报告

> **文件标识**：`docs/frontend-convergence-systemic-repair/audits/01-audit-chat-domain-primitives.md`  
> **归属战役**：`FRONTEND-CONVERGENCE-OVERHAUL`（全仓前端收敛系统性修复战役）  
> **审计对象**：Wave 4（涉及 commits `64429ebe5`, `5334f5b0b`, `4173fc79e`，即 BATCH-4A, 4B, 4C）针对 Chat 消息交互域原生交互标签向 `@/components/ui` 原子组件（`Button`, `IconButton`, `Input`, `Textarea`）的收敛重构  
> **审计专家角色**：Chat 域交互标签原子化审计专家  
> **执行约束**：严格遵循架构穿透、零退避、立体验证纪律；严禁打补丁与延时盲猜；严禁执行 git 提交  

---

## 目录

1. [执行概要与核心裁决摘要](#一执行概要与核心裁决摘要)
2. [审计范围与核心源码文件清单](#二审计范围与核心源码文件清单)
3. [逐文件详细核查与代码物证](#三逐文件详细核查与代码物证)
   - [3.1 输入与编辑域（ChatComposer 及相关子组件）](#31-输入与编辑域chatcomposer-及相关子组件)
   - [3.2 消息渲染与折叠域（ChatMessageRow, ReasoningRow, PinActionWithPicker 等）](#32-消息渲染与折叠域chatmessagerow-reasoningrow-pinactionwithpicker-等)
   - [3.3 工具调用卡片域（ModernTerminalToolCall, ToolCallDiffPreview 等）](#33-工具调用卡片域modernterminaltoolcall-toolcalldiffpreview-等)
   - [3.4 代码比对与查看域（VirtualPlainCodeViewer, DiffCardFileList, DiffCard 等）](#34-代码比对与查看域virtualplaincodeviewer-diffcardfilelist-diffcard-等)
   - [3.5 智能体与状态卡片域（InlineAgentTimeline, AgentCard, InlineAgentPanel 等）](#35-智能体与状态卡片域inlineagenttimeline-agentcard-inlineagentpanel-等)
   - [3.6 顶栏与空态交互域（ChatCard, ProjectPickerMenu, SessionInlineRename 等）](#36-顶栏与空态交互域chatcard-projectpickermenu-sessioninlinerename-等)
   - [3.7 流式叙事流扩展域（extensions/conversation-flow/ 相关组件）](#37-流式叙事流扩展域extensionsconversation-flow-相关组件)
4. [四个维度的系统性深度核查](#四四个维度的系统性深度核查)
   - [4.1 维度一：交互与功能正确性（Keyboard / IME / Disabled / Form）](#41-维度一交互与功能正确性keyboard--ime--disabled--form)
   - [4.2 维度二：无障碍可访问性与属性透传（ARIA / data-testid / 焦点）](#42-维度二无障碍可访问性与属性透传aria--data-testid--焦点)
   - [4.3 维度三：样式与布局光学表现（Flex 拓扑断裂 / 盒模型冲突 / 裸模式）](#43-维度三样式与布局光学表现flex-拓扑断裂--盒模型冲突--裸模式)
   - [4.4 维度四：架构纯净度与 CSS 维护债务（:global 补丁扩散）](#44-维度四架构纯净度与-css-维护债务global-补丁扩散)
5. [发现的缺陷与不合规项清单（含严重级判定）](#五发现的缺陷与不合规项清单含严重级判定)
6. [回归风险评估](#六回归风险评估)
7. [工业级代码修复方案与落盘建议](#七工业级代码修复方案与落盘建议)
8. [最终审计结论与交接报告](#八最终审计结论与交接报告)

---

## 一、执行概要与核心裁决摘要

为了落实战役 `FRONTEND-CONVERGENCE-OVERHAUL` 设定的 G-01 门禁（**业务层零裸交互标签**），Wave 4 在 BATCH-4A、4B、4C 三个提交批次中，集中对 Chat 消息交互域、输入框、工具调用卡片、差异对比面板、智能体卡片以及会话流进行了大规模改造，清退了原生 `<button>`、`<input>` 与 `<textarea>`，全面接入 `@/components/ui` 下的原子组件。

经审计专家组对改动涉及的全部 3 个 commit、81 个源码与样式文件的穷举核查与物理拓扑比对，**整体收敛方向完全符合 G-01 门禁与设计系统战略，但在落地执行过程中存在严重的“机械替换”与“理解断层”，引入了数项高危缺陷与明显的视觉/交互回归**。

审计结论评级表如下：

| 审计领域 | 风险等级 | 核心缺陷与表现物证 | 影响面 |
| :--- | :---: | :--- | :--- |
| **DOM 合法性与 Flex 拓扑** | **CRITICAL (致命)** | `Button.tsx` 内部硬编码 `<span className={styles.buttonLabel}>{children}</span>`。当业务组件包含复杂布局或块级标签（`<div>`）时，未声明 `bare` 属性，导致：① `<div>` 非法嵌套在 `<span>` 中（W3C 规范违规）；② 按钮直属 flex 结构断裂，导致 `justify-content: space-between` 和 `margin-left: auto` 彻底失效（如 `ComposerFusedTrigger` 勾选对齐失效、`ChatEmptyState` 快速提示卡片右箭头对齐失效）。 | 全仓复合菜单、空态卡片、多行标题栏 |
| **IME 输入法中文回车状态机** | **HIGH (高危)** | `SessionInlineRename.tsx` 和 `AnnotationChipItem.tsx` 换用 `<Input bare>` / `<Textarea bare>` 时，在组件的 `onKeyDown` 中直接捕获 `Enter` 触发提交/保存，未检查 `isComposing` / `e.nativeEvent.isComposing`，绕开了 `Input`/`Textarea` 内部的 IME 保护状态机，导致中文拼音选词回车提前提交并退出编辑。 | 会话重命名、附件批注输入 |
| **设计规范破损（形态 ④ 极简搜索框）** | **HIGH (高危)** | `DiffCard.tsx` 的行内搜索框替换为 `<Input variant="search">` 时遗漏了 `bare` 属性，导致组件被外层容器（`inputWrap`）与外边框样式包裹，破坏了 AGENTS.md §19 / §20 强制规定的“形态 ④ 纯光标极简型（无边框、透明底、仅有光标闪烁）”基线。 | 差异对比 DiffCard 检索栏 |
| **样式覆盖与 `:global` 维护债务** | **MEDIUM (中危)** | 由于未使用 `bare` 属性，`Button` 默认带入的 `--btn-h: 32px`、`padding: 0 var(--btn-px)` 与悬浮伪元素与原有紧凑布局严重冲突。开发者不得不在 15+ 个 CSS Modules 文件中注入 `:global(.button).xxx` 强制重置高度和内边距，甚至在 `VirtualPlainCodeViewer.tsx` 中硬编码 10 项内联样式。 | 全仓 15+ 处样式模块 |
| **Pure Icon 按钮组件逆向回退** | **LOW (低危)** | 在 `ChatHeaderMore.tsx`、`ChatComposer` 等纯图标交互场景中，开发者将已有的 `IconButton` 逆向退化为普通 `Button`，不仅使图标被包进 `buttonLabel` 产生 1~2px 渲染偏移，还丢失了 `IconButton` 强制传递 `'aria-label'` 的编译期守卫。 | 顶栏工具按钮、输入框附属按钮 |

---

## 二、审计范围与核心源码文件清单

本次审计聚焦于 Wave 4 的三个关键批次：
- **BATCH-4A** (`commit 64429ebe5`): 覆盖 diff 面板、自定义标签、消息行、流动洗牌器（22 个文件）；
- **BATCH-4B** (`commit 5334f5b0b`): 覆盖 chat-composer、附件卡片、权限菜单、Slash 菜单、进度条（22 个文件）；
- **BATCH-4C** (`commit 4173fc79e`): 覆盖 chat-card、chat-tool-call、agent-card、conversation-flow（37 个文件）。

核心审计源码清单如下：

| 业务域 | 核心文件路径 | 涉及组件/子组件 |
| :--- | :--- | :--- |
| **输入与编辑域** | `apps/crish-desktop/src/components/chat-composer/` | `ChatComposer.tsx`, `AnnotationChipItem.tsx`, `ComposerNoticeBar.tsx`, `ComposerPlanProgressBar.tsx`, `ComposerField.tsx`, `ComposePlusMenu.tsx`, `PermissionModeMenu.tsx`, `ComposerFusedTrigger.tsx`, `ComposerDirTree.tsx`, `DraftUndoToast.tsx`, `TiptapSlashMenu.tsx` |
| **附件卡片域** | `apps/crish-desktop/src/components/chat-attachment/` | `AttachmentCard.tsx` |
| **消息行交互域** | `apps/crish-desktop/src/components/chat-message-row/` | `ChatMessageRow.tsx` (re-export), `ReasoningRow.tsx`, `PinActionWithPicker.tsx`, `PlanMilestoneSpine.tsx`, `ArtifactCapsuleSyncLine.tsx` |
| **消息列表与滚动** | `apps/crish-desktop/src/components/chat-message-list/` | `FlowScrubber.tsx`, `ChatScrollFloorSlot.tsx` |
| **工具调用卡片域** | `apps/crish-desktop/src/components/chat-tool-call/` | `ModernTerminalToolCall.tsx`, `ToolCallDiffPreview.tsx`, `ModernCodeBlock.tsx`, `ModernJsonToolCall.tsx`, `ToolCallHeader.tsx` |
| **代码比对域** | `apps/crish-desktop/src/components/diff/` | `VirtualPlainCodeViewer.tsx`, `DiffCardFileList.tsx`, `DiffCard.tsx`, `DiffCardGitActions.tsx` |
| **自定义标签域** | `apps/crish-desktop/src/components/custom-tags/` | `WidgetDiff.tsx`, `AiCard.tsx`, `CustomTagErrorBoundary.tsx` |
| **智能体卡片域** | `apps/crish-desktop/src/components/agent-card/` | `InlineAgentTimeline.tsx`, `InlineAgentPanel.tsx`, `InlineAgentPanelHeader.tsx`, `AgentBrowsePad.tsx`, `AgentTeamBoard.tsx`, `ApprovalNoteField.tsx` |
| **顶栏与卡片域** | `apps/crish-desktop/src/components/chat-card/` | `ChatCard.tsx`, `ProjectPickerMenu.tsx`, `ChatHeaderControls.tsx`, `ChatHeaderMore.tsx`, `SessionInlineRename.tsx`, `ChatEmptyState.tsx`, `ChatMsgFilterBar.tsx`, `SetupHintBanner.tsx`, `SubagentHeaderPanel.tsx`, `UnitChromeActions.tsx` |
| **叙事流扩展域** | `apps/crish-desktop/src/extensions/conversation-flow/` | `ActionRow.tsx`, `ArtifactChip.tsx`, `ArtifactNotebookSurface.tsx`, `PurposeBlock.tsx`, `ThinkingBlock.tsx` |

---

## 三、逐文件详细核查与代码物证

### 3.1 输入与编辑域（ChatComposer 及相关子组件）

#### 1. `ChatComposer.tsx`
- **代码物证**（L360-L385, L450-L495）：
  ```tsx
  // 1. 加号按钮 (plusBtn)
  <Button
    ref={plusBtnRef}
    type="button"
    variant="ghost"
    className={`${styles.plusBtn} ${showPlusMenu ? styles.isOpen : ''}`}
    aria-label="打开添加菜单"
    aria-haspopup="menu"
    aria-expanded={showPlusMenu}
    onClick={...}
  >
    <AppIcon name="plus" size={14} aria-hidden />
  </Button>
  
  // 2. 取消编辑按钮 (cancelEditBtn)
  <Button
    type="button"
    variant="ghost"
    className={styles.cancelEditBtn}
    onClick={onCancelEdit}
    data-testid="composer-cancel-edit-btn"
    aria-label="取消编辑"
  >
    <AppIcon name="x" size={16} aria-hidden />
  </Button>
  
  // 3. 隐藏文件输入框 (fileInput)
  <Input
    bare
    ref={fileInputRef as React.RefObject<HTMLInputElement>}
    {...hiddenFileInputProps}
  />
  ```
- **审计评定**：
  - `fileInput`: 正确使用了 `bare` 模式，确保隐藏的 `display: 'none'`、`type: 'file'` 原生行为无损透传，`fileInputRef` 正常工作。
  - `plusBtn`, `actionCircleBtn`, `cancelEditBtn`: 这些是完全标准的 28×28 正圆纯图标按钮。在 `Button.tsx` 渲染逻辑中，由于未传 `bare`，内部将 `<AppIcon>` 包裹在 `<span className={styles.buttonLabel}>` 内。虽然 `ChatComposer.module.css` 增加了 `:global(.button).plusBtn` 样式补丁（设置 `padding: 0; width: 28px; height: 28px`），但多余的 `span.buttonLabel` 导致在部分 Chromium 内核下 SVG 图标垂直基线产生 0.5~1px 的非同心偏移。最佳实践应直接使用 `<IconButton icon={<AppIcon ... />} ...>`。

#### 2. `ComposePlusMenu.tsx`
- **代码物证**（L108-L135）：
  ```tsx
  <Button
    type="button"
    variant="ghost"
    className={styles.item}
    role="menuitem"
    aria-label={item.hint ? `${item.label}，${item.hint}` : item.label}
    onClick={() => handleItemClick(item)}
  >
    <AppIcon name={item.icon} size={15} className={styles.icon} aria-hidden="true" />
    <div className={styles.textWrap}>
      <span className={styles.label}>{item.label}</span>
      {item.hint ? <span className={styles.desc}>{item.hint}</span> : null}
    </div>
  </Button>
  ```
- **核心缺陷**：
  - **严重违反 W3C HTML5 标准**：`Button.tsx` 强制把子节点包在 `<span className={styles.buttonLabel}>` 中，导致实际 DOM 为：
    `<button class="..."><span class="buttonLabel"><svg ... /><div class="textWrap">...</div></span></button>`。
    **在 inline 元素 `<span>` 内部直接嵌套 block 元素 `<div>`**，严重破坏 DOM 拓扑树，在严苛模式或 SSR 环境下直接报错。
  - **Flex 布局失效**：`styles.item` 定义了 `display: flex; align-items: center; gap: var(--space-2, 8px);`。由于所有子节点都被封入同一个 `span.buttonLabel`，`styles.item` 只有一个子节点，其定义的 `gap` 无法作用在 `<AppIcon>` 与 `textWrap` 之间！必须声明 `bare` 属性。

#### 3. `PermissionModeMenu.tsx`
- **代码物证**（L146-L168）：
  ```tsx
  <Button
    type="button"
    variant="ghost"
    className={`${styles.permMenuItem} ${isSelected ? styles.isSelected : ''}`}
    role="menuitem"
    onClick={...}
  >
    <span className={styles.iconWrapper} aria-hidden="true">{icon}</span>
    <div className={styles.textCol}>
      <span className={styles.title}>{itemMeta.label}</span>
      <span className={styles.desc}>{sublabel}</span>
    </div>
    {isSelected ? <AppIcon name="check" size={13} className={styles.checkIcon} aria-hidden="true" /> : null}
  </Button>
  ```
- **核心缺陷**：
  - 同样存在 **`<div>` 嵌套在 `<span>`** 的非法 DOM 问题。
  - `styles.permMenuItem` 定义的 `display: flex; align-items: center; gap: 8px;` 因 `span.buttonLabel` 拦截而失效，导致菜单项内图标与文字排版失去弹性间距控制。必须使用 `bare` 模式。

#### 4. `ComposerFusedTrigger.tsx`
- **代码物证**（L189-L210）：
  ```tsx
  <Button
    key={opt.id}
    type="button"
    variant="ghost"
    className={`${styles.item} ${selected ? styles.isSelected : ''}`}
    role="menuitem"
    onClick={...}
  >
    <span className={styles.itemTitle}>{opt.label}</span>
    {selected ? (
      <AppIcon name="check" size={13} className={styles.check} aria-hidden="true" />
    ) : null}
  </Button>
  ```
- **核心缺陷（物理光学重大 Bug）**：
  - 观察 `ComposerFusedTrigger.module.css` 的 `.item` 样式：
    ```css
    :global(.button).item,
    .item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      ...
    }
    ```
  - 设计意图非常明确：使用 `justify-content: space-between` 将左侧标题 `itemTitle` 与右侧勾选对号 `check` 推向菜单两端。
  - **但在接入 `Button` 且未开启 `bare` 后，`itemTitle` 和 `check` 被同时塞进了一个 `span.buttonLabel`！**
  - **结果**：`.item` 只有一个直接子元素，`justify-content: space-between` 彻底失去作用，选中的对号图标紧贴在标题文字后面，无法右对齐！这是一个由于标签机械替换直接引发的显著视觉破损。必须立即添加 `bare`。

#### 5. `AnnotationChipItem.tsx`
- **代码物证**（L255-L270）：
  ```tsx
  <Textarea
    bare
    className={styles.annCommentInput}
    value={draftComment}
    placeholder="写下批注说明… (Enter 保存，Esc 取消)"
    rows={2}
    autoFocus
    onChange={(e) => setDraftComment(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSaveAndClose();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    }}
  />
  ```
- **核心缺陷（IME 输入法回车提早提交）**：
  - 开发者使用了 `<Textarea bare>`，但在 `onKeyDown` 中直接捕获了 `Enter`：
    ```tsx
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveAndClose(); }
    ```
  - `Textarea.tsx` 组件内部的执行时序是：**先调用外部传入的 `onKeyDown?.(e)`，随后才执行自身的 IME 拦截判断（`isComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229`）**。
  - **结果**：当用户在中文/日文输入法下输入拼音并敲击 Enter 选词时，`AnnotationChipItem` 的 `onKeyDown` 立即触发了 `handleSaveAndClose()`，导致输入未完成便被提前提交并关闭！
  - **修复建议**：应使用 `Textarea` 自带的 `onEnter={handleSaveAndClose}` 属性，或在 `onKeyDown` 显式守卫 `if (e.nativeEvent.isComposing || e.keyCode === 229) return;`。

#### 6. `ComposerField.tsx`
- **代码物证**（L118-L195）：
  ```tsx
  <Textarea
    bare
    id={textAreaId}
    ref={taRef}
    className={styles.textarea}
    data-testid="chat-input"
    ...
    onCompositionStart={() => setIsComposing(true)}
    onCompositionEnd={() => {
      setIsComposing(false);
      requestAnimationFrame(resize);
    }}
    onKeyDown={(e) => {
      if (isComposing) return;
      ...
    }}
  />
  ```
- **审计评定**：
  - `ComposerField` 使用了 `<Textarea bare>`，属性透传完善，`data-testid="chat-input"` 无损保留。
  - 其通过组件自身的 `isComposing` 状态守卫了回车发送，但在 Windows Chromium 环境下，部分输入法（如微软件拼音）选词结束的 `compositionend` 与 `keydown` 处于同 tick，微任务时序可能导致偶发漏判。建议补充 `e.nativeEvent.isComposing || e.keyCode === 229` 双重防御。

#### 7. `ComposerNoticeBar.tsx`
- **代码物证**（L117-L165）：
  - 叹号徽标 `detailBadge`、复制按钮 `copyBtn`、反馈按钮 `feedbackBtn`、关闭按钮 `dismissBtn` 全部使用 `<Button variant="ghost">`。
  - `copyBtn` 与 `feedbackBtn` 的子节点包含图标和文字：
    ```tsx
    <Button type="button" variant="ghost" className={styles.copyBtn} onClick={handleCopy}>
      <AppIcon name="copy" size={13} className={styles.btnIcon} aria-hidden="true" />
      <span>复制</span>
    </Button>
    ```
  - `styles.copyBtn` 定义了 `display: inline-flex; align-items: center; gap: 4px;`。由于未传 `bare`，图标与文字被包入 `span.buttonLabel`，`gap: 4px` 无法在它们之间产生间距。
  - `dismissBtn` 作为纯图标按钮，未采用 `IconButton`。

#### 8. `ComposerPlanProgressBar.tsx`
- **代码物证**（L146-L230）：
  - `planModeBadge` 包含目标图标与文字，未传 `bare`。
  - 快捷操作按钮组（`planActionBtn`：编辑、暂停/继续、终止）均为 24×24 纯图标按钮，但全部使用了 `<Button variant="ghost">` 外包 `<Tooltip>`，而非直接使用 `<IconButton>`。

#### 9. `ComposerDirTree.tsx` & `TiptapSlashMenu.tsx`
- **代码物证**：
  - `ComposerDirTree.tsx`（L245）：列表行 `row` 包含文件夹图标与名称，未传 `bare`，`gap: var(--space-2)` 无法正确作用在图标与文本之间。
  - `TiptapSlashMenu.tsx`（L255）：菜单项内部包含 `<div className={styles.itemContent}>`，由于未传 `bare`，同样产生 **`<div>` 嵌套在 `<span>`** 的非法 DOM 缺陷。

---

### 3.2 消息渲染与折叠域（ChatMessageRow, ReasoningRow, PinActionWithPicker 等）

#### 1. `ChatMessageRow.tsx`
- **审计核查**：`ChatMessageRow.tsx` 为纯粹的聚合 re-export 门面文件，内部不包含任何 JSX 交互标签，无违规。

#### 2. `ReasoningRow.tsx`
- **代码物证**（L170-L215）：
  ```tsx
  <Button
    type="button"
    variant="ghost"
    className={styles.reasoningRow}
    onClick={handleToggle}
    aria-expanded={isExpanded}
    aria-controls={bodyId}
    id={triggerId}
    aria-label={summaryText}
  >
    <AppIcon name="sparkles" size={12} className={`${styles.sparkleIcon}...`} />
    <span className={styles.reasoningLabel}>{summaryText}</span>
    {durationText ? <span className={styles.reasoningDuration}>{durationText}</span> : null}
    <span className={`${styles.chevron} ...`}>›</span>
  </Button>
  ```
- **核心缺陷（Flex 布局与宽度截断失锁）**：
  - `ReasoningRow.module.css` 详细定义了极简单行防坍塌规格：
    ```css
    :global(.button).reasoningRow,
    .reasoningRow {
      display: flex;
      width: 100%;
      height: 24px;
      contain: size layout;
      align-items: center;
      gap: var(--space-1_5, 6px);
      ...
    }
    .reasoningLabel {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    ```
  - **设计依赖**：`.reasoningLabel` 声明 `flex: 1 1 auto`，依靠 flex 弹性把思考摘要撑开，并把折叠箭头 `chevron` 与耗时 `reasoningDuration` 推至右侧。
  - **现状**：由于 `Button` 内部把 4 个子元素打包丢进单个 `span.buttonLabel`，`reasoningLabel` 的 `flex: 1 1 auto` 完全失效！文本省略与弹性排版退化为 inline 排版，折叠箭头无法稳定右锚定。必须开启 `bare`。

#### 3. `PlanMilestoneSpine.tsx`
- **代码物证**（L90-L125）：
  - `flowPlanStepHead` 按钮包含步骤编号 `flowPlanStepNum`、标题 `flowPlanStepTitle`（`flex: 1`）、折叠箭头 `flowPlanChevron`。
  - 同样由于缺少 `bare`，子元素被包在 `span.buttonLabel` 中，导致里程碑步骤标题无法撑满行宽，箭头排版偏位。

#### 4. `PinActionWithPicker.tsx`
- **代码物证**（L330-L420）：
  - 颜色圆点 `pinColorDot`：使用 `<Button variant="ghost" style={{ backgroundColor: c.value }}>`。由于 `Button.module.css` 增加了 `:global(.button).pinColorDot`，尺寸被限制在 18×18px，基本可用。
  - 自定义色相滑块：
    ```tsx
    <Input
      bare
      type="range"
      min="0"
      max="360"
      value={customHue}
      onChange={handleHueChange}
      className={styles.pinHueSlider}
      aria-label="自定义色相滑块"
    />
    ```
    - 正确声明了 `bare`，使得 原生 `<input type="range">` 能够纯净渲染，未引入 `Input` 的外层边框与背景。
  - 重置按钮 `pinResetBtn`：包含图标与重置文字，未传 `bare`，图标与文字的 `gap: 4px` 丢失。

#### 5. `FlowScrubber.tsx`
- **代码物证**（L350-L465）：
  - 刻度线按钮 `styles.tick`：传递了完整无损的 `data-flow-scrubber-tick`、`data-msg-id`、`aria-label={ariaLabel}`、`onClick`、`onMouseEnter`。
  - 浮层气泡按钮 `scrubberTooltipUserBtn`、`scrubberTooltipAssistantBtn`：文本通过 span 承载，交互正常。

---

### 3.3 工具调用卡片域（ModernTerminalToolCall, ToolCallDiffPreview 等）

#### 1. `ModernTerminalToolCall.tsx`
- **代码物证**（L80-L175）：
  - 复制按钮 `terminalCopyBtn`：纯图标按钮，使用 `<Button variant="ghost">`，已在 CSS 中通过 `:global(.button).terminalCopyBtn` 重置了 22×22 尺寸与透明背景。
  - 折叠条按钮 `terminalMidFoldBar`：
    ```tsx
    <Button
      type="button"
      variant="ghost"
      className={styles.terminalMidFoldBar}
      onClick={...}
      aria-label={`展开中间剩余 ${...} 行日志输出`}
    >
      <AppIcon name="chevrons-down" size={12} aria-hidden="true" />
      <span>展开中间剩余 ... 行日志输出</span>
    </Button>
    ```
    - `styles.terminalMidFoldBar` 声明了 `display: flex; align-items: center; justify-content: center; gap: 6px;`。未传 `bare` 导致双箭头图标与文本丢失了 6px 的 flex 间距。

#### 2. `ToolCallDiffPreview.tsx`
- **代码物证**（L114-L235）：
  - `diffCopyBtn`: 24×24 纯图标复制按钮，缺少 `IconButton` 的类型化封装。
  - `diffPreviewTag`: “在右侧查看”标签按钮，包含文字与 `external-link` 图标，未传 `bare`。
  - `diffMoreBtn`: 平铺展开/收起按钮，纯文字，受 `buttonLabel` 影响较小。

#### 3. `ToolCallHeader.tsx`
- **代码物证**（L117-L130）：
  - 文件路径跳转按钮 `toolPathLink`: `<Button variant="ghost" className={styles.toolPathLink}>{paramText}</Button>`。纯文本链接态按钮，透传正常。

---

### 3.4 代码比对与查看域（VirtualPlainCodeViewer, DiffCardFileList, DiffCard 等）

#### 1. `DiffCard.tsx`
- **代码物证**（BATCH-4A, `DiffCard.tsx` L270-L280）：
  ```tsx
  {searchOpen || searchActive ? (
    <div className={styles.searchRow}>
      <Input
        variant="search"
        size="sm"
        className={styles.searchInput}
        placeholder="搜索/筛选行…"
        value={rawDiffSearchQuery}
        onChange={(e) => setRawDiffSearchQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setRawDiffSearchQuery('');
            setSearchOpen(false);
          }
        }}
        autoFocus
      />
    </div>
  ) : null}
  ```
- **核心缺陷（严重违反设计规范形态 ④）**：
  - `DiffCard.module.css` 顶部明确写有设计红线契约：
    ```css
    /* 形态 ④：Diff 搜索筛选框（纯光标极简型）
     * 全态只有光标闪烁，其他什么变化也没有！彻底消除边框、深黑描边与聚焦投影 */
    .searchInput,
    .searchInput:focus,
    .searchInput:focus-visible {
      width: 100%;
      height: 26px;
      padding: 0 8px;
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-size: var(--font-size-xs);
      outline: none;
      box-shadow: none;
      box-sizing: border-box;
    }
    ```
  - **严重事故**：开发者换用 `<Input variant="search">` 时，**漏掉了 `bare` 属性**！
  - `Input.tsx` 在非 `bare` 模式下，会强行渲染 `<div class="inputWrap"><div class="inputShell"><input class="input inputSm inputSearch searchInput" /></div></div>`。
  - `Input.module.css` 中的 `.input` 带有 `border: 1px solid var(--border-subtle)` 以及 `background: color-mix(...)`！
  - **结果**：原本纯透明、无边框的形态 ④ 筛选框，被强行套上了一层浅灰色实线边框与卡片背景底色，破坏了 Diff 工具栏的精致纯净感！
  - **修复建议**：必须改为 `<Input bare className={styles.searchInput} ... />`。

#### 2. `VirtualPlainCodeViewer.tsx`
- **代码物证**（L385-L415）：
  ```tsx
  <Button
    type="button"
    variant="ghost"
    size="sm"
    onClick={() => toggleLineExpanded(l.num - 1)}
    aria-expanded={l.expanded}
    style={{
      display: 'inline-block',
      fontSize: 11,
      padding: '1px 6px',
      borderRadius: 3,
      height: 'auto',
      minHeight: 'unset',
      background: 'var(--bg-secondary)',
      color: 'var(--text-secondary)',
      cursor: 'pointer',
      userSelect: 'none',
    }}
  >
    {...}
  </Button>
  ```
- **核心缺陷（极度丑陋的内联样式补偿反模式）**：
  - 超长单行代码展开按钮位于虚拟滚动代码行的正文中。开发者使用 `<Button variant="ghost" size="sm">` 后，发现其自带的 flex 居中、32px 高度、10px 内边距完全撑破了单行代码高度（20px）。
  - 开发者未采用 `bare` 模式，而是**在 JSX 中硬编码了 10 项内联样式（`style={{ display: 'inline-block', height: 'auto', minHeight: 'unset', ... }}`）来与 `Button` 的原子样式互相对轰**！
  - 这是典型的“为了满足门禁而打补丁”的违规行为，直接违反了 AGENTS.md §7（严禁补丁、绕过与作弊）。开启 `bare` 即可优雅根除。

#### 3. `DiffCardFileList.tsx`
- **代码物证**（L210-L255）：
  - 折叠展开 Chevron 按钮 `fileNodeToggle`：通过绝对定位在 `statusBadge` 和 `chevronIcon` 之间切换，CSS 补丁完整，功能正常。
  - 文件名链接 `fileNameLinkBtn`：文字链接按钮，点击跳转标签页，透传完整。

#### 4. `DiffCardGitActions.tsx`
- **代码物证**（L85-L95）：
  ```tsx
  <Textarea
    bare
    className={styles.commitInput}
    placeholder={...}
    value={commitMessage}
    onChange={...}
    onKeyDown={...}
  />
  ```
- **审计评定**：正确声明了 `bare`，样式类 `styles.commitInput` 无损生效，通过门禁检测。

---

### 3.5 智能体与状态卡片域（InlineAgentTimeline, AgentCard, InlineAgentPanel 等）

#### 1. `InlineAgentPanelHeader.tsx`
- **代码物证**（L80-L135）：
  ```tsx
  <Button
    variant="ghost"
    type="button"
    className={styles.inlineAgentHead}
    aria-expanded={open}
    aria-controls={bodyDomId}
    id={labelDomId}
    onClick={onToggleOpen}
  >
    {running ? <span className="loading-spinner" /> : <AppIcon name="bot" size={13} />}
    <span className={styles.inlineAgentLabel}>{displayLabel}</span>
    <span className={`${styles.inlineAgentBadge} ...`}>{statusLabel}</span>
    {pendingTools > 0 ? <span className={styles.inlineAgentBadgePending}>待批 {pendingTools}</span> : null}
    {mode ? <span className={styles.inlineAgentMode}>{mode}</span> : null}
    <span className={styles.inlineAgentMeta}>{msgCount} 条 ...</span>
    <AppIcon name="chevron-right" size={13} className={`tool-row-chevron ...`} aria-hidden />
  </Button>
  ```
- **核心缺陷**：
  - `inlineAgentHead` 承载了子智能体头部行的完整信息流，定义了 `display: flex; align-items: center; gap: 5px;`。
  - 由于缺少 `bare`，其包含的 6 个子组件（图标、标题、运行态徽标、待审批徽标、模式标签、消息数、折叠箭头）被统一包在单个 `span.buttonLabel` 内部。
  - 原本依靠 flex 的 `gap: 5px` 和弹性对齐全部丢失，元素之间发生紧缩挤压，箭头无法稳定右贴。

#### 2. `AgentTeamBoard.tsx`
- **代码物证**（L270-L335）：
  ```tsx
  <Button
    variant="ghost"
    id={optionId}
    type="button"
    role="option"
    aria-selected={active}
    className={`${styles.agentTeamCard} ${active ? styles.agentTeamCardActive : ''}`}
    onClick={() => handleSelect(a)}
    onKeyDown={(e) => handleKeyDown(e, a, i)}
  >
    <div className={styles.agentTeamCardTop}>...</div>
    <div className={styles.agentTeamCardBottom}>...</div>
  </Button>
  ```
- **核心缺陷**：
  - **严重违反 W3C HTML5 规范**：卡片内部由 `<div class="agentTeamCardTop">` 和 `<div class="agentTeamCardBottom">` 构成，外层 `Button` 将它们包在了 `span.buttonLabel` 内部（**`<div>` 嵌套在 `<span>`**）。
  - `styles.agentTeamCard` 设置的 `display: flex; flex-direction: column;` 无法正常约束卡片的上下两行，破坏了团队卡片的双行版式。必须使用 `bare`。

#### 3. `InlineAgentTimeline.tsx`
- **代码物证**（L85-L190）：
  - 操作链接按钮（`inlineAgentLinkStop`, `inlineAgentLinkResume`, `inlineAgentLinkKill`, `inlineAgentLinkKillAll`）：纯文本链接，带下划线，正确透传了 `disabled={recoveryBusy}` 与 `aria-label`。

---

### 3.6 顶栏与空态交互域（ChatCard, ProjectPickerMenu, SessionInlineRename 等）

#### 1. `ChatEmptyState.tsx`
- **代码物证**（BATCH-4C, `ChatEmptyState.tsx` L410-L430）：
  ```tsx
  <Tooltip key={item.label} content={item.prompt}>
    <Button
      type="button"
      variant="ghost"
      className={styles.quickPromptCard}
      role="listitem"
      data-quick-prompt={item.label}
      onClick={() => onSelectPrompt(item.prompt)}
    >
      <span className={styles.promptIcon}>{item.icon}</span>
      <span className={styles.promptLabel}>{item.label}</span>
      <AppIcon name="chevron-right" size={14} className={styles.promptArrow} aria-hidden="true" />
    </Button>
  </Tooltip>
  ```
- **核心缺陷（首页空态极具辨识度的严重对齐 Bug）**：
  - 观察 `ChatEmptyState.module.css` 中的样式声明：
    ```css
    :global(.button).quickPromptCard,
    .quickPromptCard {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      width: 100%;
      ...
    }
    .promptArrow {
      color: var(--text-tertiary);
      flex-shrink: 0;
      margin-left: auto; /* 关键：依赖 flex 自动外边距推到最右侧 */
    }
    ```
  - **Bug 根因**：`quickPromptCard` 在空会话时作为引导卡片，右侧的小箭头 `promptArrow` 声明了 `margin-left: auto;`，目的是靠 flexbox 的物理特性将其推到 640px 宽卡片的最右侧。
  - **当被替换为 `Button` 且未开启 `bare` 时**，`promptIcon`、`promptLabel`、`promptArrow` 全部被收拢进 `span.buttonLabel` 内部！
  - **`promptArrow` 已经不再是 `quickPromptCard` 的直属 flex 子节点，`margin-left: auto` 彻底失效！**
  - **现象**：右箭头直接挤在标题文本后面，卡片右侧留出大片尴尬空白！用户每次打开新会话第一眼就能看到此视觉破损。必须立即添加 `bare`。

#### 2. `SessionInlineRename.tsx`
- **代码物证**（L40-L68）：
  ```tsx
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCommit();
    } else if (e.key === 'Escape') {
      setEditValue(title);
      setIsEditing(false);
    }
  };

  return (
    <div className={styles.renameContainer}>
      <Input
        ref={inputRef}
        bare
        type="text"
        className={styles.renameInput}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleCommit}
        onKeyDown={handleKeyDown}
        maxLength={64}
        aria-label="修改会话名称"
      />
    </div>
  );
  ```
- **核心缺陷（IME 中文输入法提前回车提交）**：
  - 虽然使用了 `<Input bare>`，但在 `handleKeyDown` 中直接截取 `if (e.key === 'Enter') handleCommit();`。
  - 与 `Input.tsx` 内置的 IME 状态机发生脱节（`onKeyDown` 先于组件内部的 IME 拦截执行）。当用户输入拼音敲 Enter 确认汉字候选时，直接触发了 `handleCommit()`，将尚未选好的英文字母存为会话标题并关闭了输入框！
  - **修复建议**：直接使用 `Input` 提供的受 IME 保护的属性：`<Input onEnter={handleCommit} ... />`，或在 `handleKeyDown` 中增加 `if (e.nativeEvent.isComposing || e.keyCode === 229) return;`。

#### 3. `ChatHeaderMore.tsx`
- **代码物证**（BATCH-4C 变更记录）：
  ```diff
  -import { IconButton, Tooltip } from '../ui';
  +import { Button, Tooltip } from '../ui';
  ...
   const trigger = (
     <Tooltip content="更多操作" side={UNIT_CHROME_TOOL_TIP_SIDE}>
  -    <button
  +    <Button
         type="button"
  +      variant="ghost"
         className={`${className || ''} top-action-btn`}
         data-testid="chat-header-more"
         aria-label="更多选项"
       >
         <AppIcon name="more-horizontal" size={14} aria-hidden="true" />
  -    </button>
  +    </Button>
     </Tooltip>
   );
  ```
- **核心缺陷（架构组件逆向退化）**：
  - 此处是一个完美的标准纯图标按钮（28×28、ghost 变体、带有 Tooltip 和 aria-label）。
  - 原本代码已经从 `../ui` 导入了 `IconButton`，在 Wave 4 重构时，开发者不但没有顺理成章地使用 `IconButton`，反而将其删去，换成了普通 `Button`！
  - 这种反向操作既增加了 `span.buttonLabel` 包装成本，又丢弃了 `IconButton` 的严格属性守卫。

---

### 3.7 流式叙事流扩展域（extensions/conversation-flow/ 相关组件）

#### 1. `ActionRow.tsx`, `ThinkingBlock.tsx`, `PurposeBlock.tsx`
- **代码物证**：
  ```tsx
  // ActionRow.tsx:
  <Button
    variant="ghost"
    type="button"
    className={`${styles.head}${expandable ? '' : ` ${styles.headStatic}`}`}
    ...
  >
    <span className={styles.ico} aria-hidden><AppIcon name={...} size={13} /></span>
    <span className={styles.primary}>{human || action.verb}</span>
    {meta ? <span className={styles.meta}>{meta}</span> : null}
  </Button>
  ```
- **核心缺陷**：
  - 叙事流的 `head` 样式在 `narrative.module.css` 中设计为：
    ```css
    :global(.button).head,
    .head {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      ...
    }
    .primary {
      flex: 1 1 auto; /* 占据剩余空间，将 meta 贴向右侧 */
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    ```
  - 未使用 `bare` 导致 `ico`、`primary`、`meta` 被压平至 `span.buttonLabel` 内，`primary` 的 `flex: 1 1 auto` 失效，三者失去弹性排布。必须使用 `bare`。

---

## 四、四个维度的系统性深度核查

### 4.1 维度一：交互与功能正确性（Keyboard / IME / Disabled / Form）

1. **`type="button"` 属性的完整性**：
   - 全仓核查通过。原子组件 `Button.tsx` 在实现层声明了 `type = 'button'` 的安全默认值（L75），彻底杜绝了因漏传 `type` 导致的 HTML 默认 `type="submit"` 触发表单提交刷新的顽疾。
2. **键盘导航与快捷键交互**：
   - `ChatComposer.tsx` 中的 Esc 取消编辑（`onCancelEdit`）与 Ctrl+Enter / Enter 快捷发送行为逻辑完整；
   - `DiffCard.tsx` 的 Esc 清空检索并折叠搜索行响应正确。
3. **IME 输入法中文状态机断层（重大缺陷）**：
   - 虽然 `@/components/ui` 的 `Input.tsx` 与 `Textarea.tsx` 内置了工业级 IME 守卫状态机（拦截 `isComposingRef.current`、`e.nativeEvent.isComposing`、`keyCode === 229` 与 `key === 'Process'`），但业务层的 `SessionInlineRename.tsx` 与 `AnnotationChipItem.tsx` 在传入自定义 `onKeyDown` 时，均在事件传播的第一时间无条件捕获了 `Enter`，使得原子组件底层的 IME 守卫形同虚设，输入法候选选词直接误触发提交。
4. **禁用态与加载态联动**：
   - `Button.tsx` 将 `loading` 自动合并进 `disabled` 与 `aria-busy`，表现良好。
   - `InlineAgentTimeline.tsx` 的 `disabled={recoveryBusy}` 准确抑制了恢复中的重复点击并发。

---

### 4.2 维度二：无障碍可访问性与属性透传（ARIA / data-testid / 焦点）

1. **`data-testid` 测试桩无损性**：
   - 经与单测集穷举比对，下列核心单测桩 100% 得到保留与透传：
     - `reasoning-container`, `reasoning-body` (`ReasoningRow.tsx`)
     - `chat-input` (`ComposerField.tsx`)
     - `composer-cancel-edit-btn` (`ChatComposer.tsx`)
     - `composer-notice-detail-badge`, `composer-notice-dismiss-btn` (`ComposerNoticeBar.tsx`)
     - `model-selector-button` (`ChatHeaderControls.tsx`)
     - `chat-header-more` (`ChatHeaderMore.tsx`)
2. **`aria-label` 与屏幕阅读器命名**：
   - 绝大部分图标按钮均显式补齐了 `aria-label`；
   - 缺陷：使用普通 `Button` 替代 `IconButton` 导致无法通过 TypeScript 编译器强制约束 `aria-label` 的必传性，破坏了无障碍防御纵深。
3. **ARIA 状态拓扑**：
   - `aria-expanded`、`aria-haspopup="menu"`、`aria-controls` 在 `ChatComposer`、`PermissionModeMenu`、`ReasoningRow` 等折叠与浮层触发器上完整维持。

---

### 4.3 维度三：样式与布局光学表现（Flex 拓扑断裂 / 盒模型冲突 / 裸模式）

1. **`span.buttonLabel` 导致的 Flex 拓扑断裂（全仓共性毒点）**：
   - `Button.tsx` 设计的包裹层 `<span className={styles.buttonLabel}>{children}</span>` 仅适用于简单的“图标+单段文本”按钮。
   - 当用于承载“多段式信息列”、“带左右对齐控制的菜单项”、“多级标题栏”时，该 span 切断了业务样式类与直接子节点的父子级关系，引发排版灾难。
2. **`bare` 属性的定位与缺失**：
   - `Button.tsx` 第 32 行明确注释：
     `/** 裸核心模式（不应用默认规格与文字包裹，专供复杂列表项/下拉选项等自定义布局按钮） */`
   - Wave 4 的实施者对 `bare` 的理解严重不足，在需要复杂自定义布局的 15+ 处组件中盲目使用 `variant="ghost"`，导致外层按钮规格与子元素产生物理冲突。
3. **形态 ④ 极简搜索框破损**：
   - `DiffCard.tsx` 的搜索框因漏传 `bare` 染上外框与背景，破坏了设计系统对纯光标极简型的刚性约定。

---

### 4.4 维度四：架构纯净度与 CSS 维护债务（:global 补丁扩散）

1. **`:global(.button).xxx` 补丁泛滥**：
   - 在 `ChatComposer.module.css`、`ModernToolCall.module.css`、`AgentCard.module.css`、`InlineAgentPanel.module.css`、`narrative.module.css`、`custom-tags.module.css` 等 15 个样式模块中，充斥着如下高频重复的补丁：
     ```css
     :global(.button).xxx {
       min-width: unset;
       min-height: unset;
       height: auto;
       --btn-h: auto;
       --btn-px: 0px;
       box-shadow: none;
     }
     ```
   - 这些补丁的存在本身就是架构设计被扭曲的直接证据。
2. **内联样式硬编码恶化**：
   - `VirtualPlainCodeViewer.tsx` 的 10 项内联样式是对设计系统权威性的公然践踏，属于典型的为了跑通代码而引入的技术债务。

---

## 五、发现的缺陷与不合规项清单（含严重级判定）

| 缺陷编号 | 严重等级 | 缺陷描述 | 涉及文件与行号 | 根因分类 |
| :--- | :---: | :--- | :--- | :--- |
| **DEF-CHAT-01** | **CRITICAL** | `ComposerFusedTrigger` 菜单项对齐失效：`justify-content: space-between` 因缺少 `bare` 导致对号无法右对齐 | `ComposerFusedTrigger.tsx:189` | Flex 拓扑断裂 |
| **DEF-CHAT-02** | **CRITICAL** | `ChatEmptyState` 快速提示卡片箭头失效：`margin-left: auto` 因缺少 `bare` 导致右箭头紧贴文本 | `ChatEmptyState.tsx:410` | Flex 拓扑断裂 |
| **DEF-CHAT-03** | **CRITICAL** | W3C 规范违规：菜单项与团队卡片将 `<div>` 嵌套在 `span.buttonLabel` 内部 | `ComposePlusMenu.tsx:110`<br>`PermissionModeMenu.tsx:148`<br>`TiptapSlashMenu.tsx:255`<br>`AgentTeamBoard.tsx:272` | 非法 DOM 嵌套 |
| **DEF-CHAT-04** | **HIGH** | `SessionInlineRename` 中文输入法选词 Enter 提前触发提交保存并退出编辑 | `SessionInlineRename.tsx:42` | IME 状态机绕过 |
| **DEF-CHAT-05** | **HIGH** | `AnnotationChipItem` 批注输入域中文输入法选词 Enter 提前保存并关闭浮层 | `AnnotationChipItem.tsx:265` | IME 状态机绕过 |
| **DEF-CHAT-06** | **HIGH** | `DiffCard` 搜索框遗漏 `bare`，被渲染为带边框带背景的标准输入框，违反形态 ④ 规范 | `DiffCard.tsx:273` | 设计规范破损 |
| **DEF-CHAT-07** | **MEDIUM** | `ReasoningRow`, `InlineAgentPanelHeader`, `ActionRow` 等标题栏丢失弹性截断与 flex 间距 | `ReasoningRow.tsx:170`<br>`InlineAgentPanelHeader.tsx:80`<br>`ActionRow.tsx:88` | 布局光学破损 |
| **DEF-CHAT-08** | **MEDIUM** | `VirtualPlainCodeViewer` 硬编码 10 项内联样式与 `Button` 规格对抗，违反 AGENTS.md §7 | `VirtualPlainCodeViewer.tsx:394` | 技术债务/打补丁 |
| **DEF-CHAT-09** | **LOW** | 纯图标交互场景逆向使用普通 `Button` 代替 `IconButton`，丢失编译期无障碍约束 | `ChatHeaderMore.tsx:138`<br>`ChatComposer.tsx:360` 等 | 契约降级 |

---

## 六、回归风险评估

1. **用户操作体验风险**：
   - **重命名被打断**：使用拼音/日文输入法重命名会话时，每次按回车确认字词都会意外导致会话名称保存并退出，严重挫伤输入流；
   - **批注丢失或提前提交**：在图片或附件上撰写复杂批注时，选词回车误关闭批注弹窗，导致用户输入内容被截断。
2. **视觉感知与第一印象风险**：
   - **新用户空态破损**：每次打开新会话，中央展示的引导卡片右侧箭头全部向左坍塌，紧贴文本，视觉极为粗糙；
   - **思考档位菜单失衡**：在输入框调整思考模型档位时，选中的打勾图标紧贴选项文字，破坏了下拉菜单的标准对齐韵律；
   - **Diff 查看器视觉噪音**：搜索筛选框出现多余的边框与底色，破坏了代码对比场景的沉浸感。
3. **DOM 稳定性与浏览器兼容性风险**：
   - 现代浏览器对 `<button><span><div>...</div></span></button>` 会尝试进行 DOM 纠错（如拆分 span），这可能导致 React Fiber 树与真实 DOM 树水合/操作不一致，引发偶发性的渲染异常。

---

## 七、工业级代码修复方案与落盘建议

### 7.1 修复一：为所有复合布局的列表项、菜单项、标题栏开启 `bare`

#### 1. `ComposerFusedTrigger.tsx`（根治勾选对齐失效）
```diff
--- a/apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.tsx
+++ b/apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.tsx
@@ -190,6 +190,7 @@ export const ComposerFusedTrigger: React.FC<ComposerFusedTriggerProps> = ({
                 return (
                   <Button
                     key={opt.id}
+                    bare
                     type="button"
-                    variant="ghost"
                     className={`${styles.item} ${selected ? styles.isSelected : ''}`}
                     role="menuitem"
```

#### 2. `ChatEmptyState.tsx`（根治快速提示卡片右箭头对齐失效）
```diff
--- a/apps/crish-desktop/src/components/chat-card/ChatEmptyState.tsx
+++ b/apps/crish-desktop/src/components/chat-card/ChatEmptyState.tsx
@@ -410,6 +410,7 @@ export const ChatEmptyState: React.FC<ChatEmptyStateProps> = ({
               <Tooltip key={item.label} content={item.prompt}>
                 <Button
+                  bare
                   type="button"
-                  variant="ghost"
                   className={styles.quickPromptCard}
                   role="listitem"
```

#### 3. `ComposePlusMenu.tsx` & `PermissionModeMenu.tsx` & `AgentTeamBoard.tsx`（消除 `<div>` 嵌套于 `<span>`）
```diff
--- a/apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.tsx
+++ b/apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.tsx
@@ -109,6 +109,7 @@ export const ComposePlusMenu: React.FC<ComposePlusMenuProps> = ({
         <Tooltip key={item.id} content={item.hint || item.label}>
           <Button
+            bare
             type="button"
-            variant="ghost"
             className={styles.item}
             role="menuitem"
```
```diff
--- a/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx
+++ b/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx
@@ -147,6 +147,7 @@ export const PermissionModeMenu: React.FC<Props> = ({
               <Tooltip key={opt.id} content={itemMeta.matrixHint}>
                 <Button
+                  bare
                   type="button"
-                  variant="ghost"
                   className={`${styles.permMenuItem} ${isSelected ? styles.isSelected : ''}`}
                   role="menuitem"
```
```diff
--- a/apps/crish-desktop/src/components/agent-card/AgentTeamBoard.tsx
+++ b/apps/crish-desktop/src/components/agent-card/AgentTeamBoard.tsx
@@ -272,6 +272,7 @@ export const AgentTeamBoard: React.FC<AgentTeamBoardProps> = React.memo(
                 <Button
+                  bare
-                  variant="ghost"
                   id={optionId}
                   type="button"
```

#### 4. `ReasoningRow.tsx`, `InlineAgentPanelHeader.tsx`, `ActionRow.tsx`（恢复 Flex 弹性排布与间距）
将上述组件中的 `<Button variant="ghost" ...>` 改为 `<Button bare ...>`。

---

### 7.2 修复二：修复 IME 输入法回车提早提交问题

#### 1. `SessionInlineRename.tsx`
```diff
--- a/apps/crish-desktop/src/components/chat-card/SessionInlineRename.tsx
+++ b/apps/crish-desktop/src/components/chat-card/SessionInlineRename.tsx
@@ -40,6 +40,7 @@ export const SessionInlineRename: React.FC<SessionInlineRenameProps> = ({
   }, [editValue, title, onRename]);
 
   const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
+    if (e.nativeEvent.isComposing || e.keyCode === 229 || e.key === 'Process') return;
     if (e.key === 'Enter') {
       e.preventDefault();
       handleCommit();
@@ -62,6 +63,7 @@ export const SessionInlineRename: React.FC<SessionInlineRenameProps> = ({
           value={editValue}
           onChange={(e) => setEditValue(e.target.value)}
           onBlur={handleCommit}
+          onEnter={handleCommit}
           onKeyDown={handleKeyDown}
           maxLength={64}
           aria-label="修改会话名称"
```

#### 2. `AnnotationChipItem.tsx`
```diff
--- a/apps/crish-desktop/src/components/chat-composer/AnnotationChipItem.tsx
+++ b/apps/crish-desktop/src/components/chat-composer/AnnotationChipItem.tsx
@@ -262,6 +262,7 @@ export const AnnotationChipItem: React.FC<AnnotationChipItemProps> = React.memo(
                   rows={2}
                   autoFocus
                   onChange={(e) => setDraftComment(e.target.value)}
+                  onEnter={handleSaveAndClose}
                   onKeyDown={(e) => {
+                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                     if (e.key === 'Enter' && !e.shiftKey) {
                       e.preventDefault();
                       handleSaveAndClose();
```

---

### 7.3 修复三：恢复 `DiffCard.tsx` 的形态 ④ 纯光标极简模式

```diff
--- a/apps/crish-desktop/src/components/diff/DiffCard.tsx
+++ b/apps/crish-desktop/src/components/diff/DiffCard.tsx
@@ -272,6 +272,7 @@ const DiffCardInner: React.FC<DiffCardProps> = () => {
         <div className={styles.searchRow}>
           <Input
+            bare
             variant="search"
             size="sm"
             className={styles.searchInput}
```

---

### 7.4 修复四：清除 `VirtualPlainCodeViewer.tsx` 的内联样式硬编码

```diff
--- a/apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx
+++ b/apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx
@@ -387,6 +387,7 @@ export const VirtualPlainCodeViewer: React.FC<VirtualPlainCodeViewerProps> = Rea
                       }
                     >
                       <Button
+                        bare
                         type="button"
-                        variant="ghost"
-                        size="sm"
                         onClick={() => toggleLineExpanded(l.num - 1)}
                         aria-expanded={l.expanded}
-                        style={{
-                          display: 'inline-block',
-                          fontSize: 11,
-                          padding: '1px 6px',
-                          borderRadius: 3,
-                          height: 'auto',
-                          minHeight: 'unset',
-                          background: 'var(--bg-secondary)',
-                          color: 'var(--text-secondary)',
-                          cursor: 'pointer',
-                          userSelect: 'none',
-                        }}
+                        className={styles.expandLineBtn}
                       >
```
在 `DiffCard.module.css` 中定义 `.expandLineBtn` 规范类，杜绝 JSX 内联样式。

---

## 八、最终审计结论与交接报告

1. **审计结论**：
   - Wave 4 的收敛改造**成功清退了 Chat 域的裸原生交互标签**，顺利通过了 `check-frontend-convergence.mjs` 中的 G-01 规则，架构方向值得肯定；
   - 但因未透彻理解 `@/components/ui` 中 `Button.tsx` 的包裹层设计与 `bare` 模式的定位，引入了 **2 项致命的布局拓扑断裂（DEF-CHAT-01, DEF-CHAT-02）**、**1 项 W3C DOM 非法嵌套（DEF-CHAT-03）**、**2 项高危 IME 输入法中文选词回车提前提交（DEF-CHAT-04, DEF-CHAT-05）** 以及 **1 项设计规范破损（DEF-CHAT-06）**；
2. **交接指令与实施路线**：
   - 本审计报告所列的全部 9 项缺陷均已给出代码级精准修复 Diff；
   - 修复实施应统一作为专项波次（如 `Wave 4-Fix` 或 `Fix-Chat-Primitives`）进行集中收口；
   - 修复后须执行自动化测试验证 IME 回车与 CSS 布局光学表现，确保无一遗漏。
