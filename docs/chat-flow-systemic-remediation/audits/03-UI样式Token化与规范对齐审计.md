# 对话流及周边组件 UI 样式 Token 化与规范对齐纯缺陷审计报告

> **权威审计基准**：`AGENTS.md` §13（焦点态对比度 ≤ 10%、无重阴影）、§14（色彩空间与现代 CSS 规范）、`docs/rust-rewrite/31-security-baseline.md`。
> **审计原则**：纯缺陷审计，禁止任何成果总结、赞美或宣称“通过/完成”的废话。仅陈列代码中断层事实与运行期隐患。

---

## 一、CSS 变量未定义与属性失效致命缺陷（Undefined CSS Variables）

### 【缺陷分类与编号】VAR-UNDEFINED-01：未定义变量 `--error-color` 导致失败状态与交互颜色彻底失效
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css:154-156, 178-179`
- **【断层事实（附带真实代码片段）】**：
  ```css
  .statusBadge.failed {
    background: color-mix(in srgb, var(--error-color) 15%, transparent);
    color: var(--error-color);
  }
  
  .killBtn:hover {
    color: var(--error-color);
  }
  ```
  在全局样式契约 `tokens.css` 中，语义错误 Token 为 `--color-error`（别名 `--danger-color`），根本未声明 `--error-color` 变量，且此处均未配置任何 fallback 默认值。
- **【危害后果 / 真实运行期隐患】**：
  根据 W3C CSS Custom Properties 规范，无 fallback 的未定义变量在计算阶段将被解析为 `guaranteed-invalid`，使该属性声明成为“运行时无效声明”（Invalid at computed-value time）。这导致子代理失败徽章的文字颜色直接回落到父级继承色，错误状态无法呈现警示红，严重误导用户；同时终止按钮（Kill）悬停态无法变红，关键危险交互视觉反馈完全丧失。

---

### 【缺陷分类与编号】VAR-UNDEFINED-02：未定义变量 `--info-color` 导致缓存写入状态语义丢失
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css:24-32`
- **【断层事实（附带真实代码片段）】**：
  ```css
  .write {
    color: var(--info-color, var(--text-primary));
    background: color-mix(
      in srgb,
      var(--info-color, var(--text-primary)) 10%,
      transparent
    );
    border: 1px solid
      color-mix(in srgb, var(--info-color, var(--text-primary)) 20%, transparent);
  }
  ```
  全局 Token 规范定义的信息色为 `--color-info: var(--accent-blue)`，不存在 `--info-color` 变量。
- **【危害后果 / 真实运行期隐患】**：
  由于首选变量 `--info-color` 始终未命中，导致该类目全部退化为 fallback `var(--text-primary)`。在缓存命中（绿色 `--accent-color`）与未命中（灰色 `--text-tertiary`）之间，缓存写入（Write）本应展示信息蓝（`--color-info`），运行时却被渲染为高对比度的黑/白色普通文字，破坏了系统指标状态体系的语义连贯性。

---

### 【缺陷分类与编号】VAR-UNDEFINED-03：Diff 关键行背景裸引非标准 Token 导致高亮丢失风险
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css:913-920`
- **【断层事实（附带真实代码片段）】**：
  ```css
  .gitDiffLineRow.addition {
    background-color: var(--accent-green-light);
  }
  
  .gitDiffLineRow.deletion {
    background-color: var(--accent-red-light);
  }
  ```
  未提供任何 fallback，且与 `ModernToolCall.module.css` 中的 `color-mix(in srgb, var(--color-success) 8%, transparent)` 架构脱节。
- **【危害后果 / 真实运行期隐患】**：
  在部分未显式挂载 `--accent-green-light` 浅色变体变量的主题分支或独立弹窗上下文中，Diff 代码行背景将变为透明无色，用户无法直观辨识增删代码行；且在不同工具调用组件间造成 Diff 色差割裂。

---

## 二、架构契约断层与死选择器缺陷（Dead Selector / Architecture Disconnect）

### 【缺陷分类与编号】ARCH-DISCONNECT-01：CSS Module 假类名导致注入失败样式永不触发
- **【代码文件与精确行号】**：
  - CSS 定义：`apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css:353-357`
  - TSX 挂载：`apps/crish-desktop/src/components/chat-injection/CompactInjectionRow.tsx:145`
- **【断层事实（附带真实代码片段）】**：
  CSS 样式表规则：
  ```css
  .injectionBlock.isFailed {
    border-left-color: var(--color-error);
    border-color: color-mix(in srgb, var(--accent-red) 30%, var(--border-color));
    background: color-mix(in srgb, var(--accent-red) 3%, var(--bg-card));
  }
  ```
  实际 TSX 组件渲染节点：
  ```tsx
  className={`${styles.injectionRow} ${toneClass} ${openStateClass} ${isFailed ? styles.isFailed : ''} ${isPending ? styles.isPending : ''} injection-row`}
  ```
  CSS Module 声明了 `.injectionBlock.isFailed`，但 TSX 组件节点绑定的容器类名为 `styles.injectionRow`，组件内部根本不存在 `styles.injectionBlock`。
- **【危害后果 / 真实运行期隐患】**：
  在 Vite / CSS Modules 构建后，该选择器被编译为类似 `._injectionBlock_hash._isFailed_hash` 的复合类。然而实际生成的 DOM 元素仅具有 `._injectionRow_hash ._isFailed_hash` 类名，导致 `.injectionBlock.isFailed` 规则沦为 100% 匹配不到的死代码。当上下文注入失败（如文件读取权限拒绝、超时）时，卡片完全不会展示红色错误边框与警示背景，致命故障被隐蔽为普通正常卡片。

---

## 三、暗黑模式变量 Fallback 闪白缺陷（Dark Mode Flash-White Defects）

### 【缺陷分类与编号】DARK-FLASH-01：`focus-visible.css` 全局焦点底板兜底硬编码 `#ffffff`
- **【代码文件与精确行号】**：`apps/crish-desktop/src/styles/focus-visible.css:54-55, 67-68`
- **【断层事实（附带真实代码片段）】**：
  ```css
  button:focus-visible,
  a:focus-visible,
  [role='button']:focus-visible,
  [role='tab']:focus-visible,
  [role='option']:focus-visible,
  [tabindex]:not([tabindex='-1']):focus-visible {
    outline: none;
    box-shadow:
      0 0 0 1px var(--bg-card, var(--bg-canvas, #ffffff)),
      0 0 0 1.5px var(--focus-visible-ring);
  }
  ```
  在全局键盘聚焦规则中，内层同心遮罩阴影将 `#ffffff` 硬编码为最终回退值。
- **【危害后果 / 真实运行期隐患】**：
  在暗黑模式初始化、iframe 嵌入环境、或由于渲染时序 CSS 变量尚未注入根 DOM 的瞬间，用户使用键盘 Tab 键快速导航经过对话流中的任何按钮、卡片、折叠器或链接时，元素外围会瞬间闪现刺眼的纯白色 1px 实心光圈，对暗夜环境下使用暗色主题的用户造成强烈的视觉闪烁冲击与刺眼瑕疵。

---

### 【缺陷分类与编号】DARK-FLASH-02：浅色系 HSL 作为边框回退值导致暗色环境闪白
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css:168`
- **【断层事实（附带真实代码片段）】**：
  ```css
  .headerActionBtn {
    ...
    border: 1px solid var(--border-subtle, hsl(35 8% 91%));
    ...
  }
  ```
- **【危害后果 / 真实运行期隐患】**：
  `hsl(35 8% 91%)` 属于典型的亮色主题高亮浅米黄色（亮度高达 91%）。一旦处于暗色模式下发生变量解析延迟，操作按钮将瞬间绘制出一条刺眼的白色/浅黄色边框，严重破坏暗黑模式低对比度发丝线的沉浸感。

---

### 【缺陷分类与编号】DARK-FLASH-03：暗色半透明度 fallback 用于亮色模式导致边框失真
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:658`
- **【断层事实（附带真实代码片段）】**：
  ```css
  border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
  ```
- **【危害后果 / 真实运行期隐患】**：
  将仅适用于深黑底板的 `rgba(255, 255, 255, 0.08)` 伪造为全局 `--border-subtle` 的 fallback。在亮色模式（Light Theme）下，白色半透明边框绘制在白色背景上近乎 100% 隐形，导致输入框边缘边界物理坍塌。

---

## 四、硬编码 Hex 色值与非规范着色缺陷（Hardcoded Hex & Raw Colors）

### 【缺陷分类与编号】HEX-COLOR-01：任务列表标记与纯白边框硬编码未对齐语义体系
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:532, 652`
- **【断层事实（附带真实代码片段）】**：
  ```css
  .assistantText :global(.md-task-box.checked::after) {
    border: solid var(--text-on-accent, hsl(0 0% 100%));
  }
  
  .assistantText :global(.md-code-copy.is-copied) {
    color: var(--brand, hsl(160 84% 39%));
  }
  ```
  多处直接书写未经 Token 抽象的绝对色值 `hsl(0 0% 100%)`（即 `#ffffff`）和 `hsl(160 84% 39%)`。
- **【危害后果 / 真实运行期隐患】**：
  当应用在用户自定义品牌色（例如将品牌色切换为紫色、橙色或石墨黑）时，复制成功的指示图标依然会由于 fallback 强行展示为硬编码翠绿色；复选框勾选图标一旦脱离 `--text-on-accent`，将出现无视主题的绝对高亮白色。

---

### 【缺陷分类与编号】HEX-COLOR-02：对话审批询问卡片裸写十六进制原色
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css:237, 239, 243`
- **【断层事实（附带真实代码片段）】**：
  ```css
  .btnReject:hover {
    background: var(--brand-deep, #047857);
    color: #ffffff;
  }
  
  .btnApprove {
    background: var(--brand, #10b981);
  }
  ```
- **【危害后果 / 真实运行期隐患】**：
  完全无视项目色彩 Token 化规范，残留 `#047857`、`#ffffff`、`#10b981` 裸写十六进制。任何针对主题色、对比度或暗黑模式的 Token 调优对此处均完全无效，构成典型的硬编码技术债。

---

### 【缺陷分类与编号】HEX-COLOR-03：子代理内嵌卡片多处残留 `#10b981` / `#059669`
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css:73-74, 88, 256-258`
- **【断层事实（附带真实代码片段）】**：
  ```css
  .liveIndicator {
    background: var(--brand, #10b981);
    box-shadow: 0 0 0 2.5px color-mix(in srgb, var(--brand, #10b981) 22%, transparent);
  }
  
  .agentResultBadge {
    background: color-mix(in srgb, var(--brand, #10b981) 12%, transparent);
    color: var(--brand-deep, #059669);
    border-color: color-mix(in srgb, var(--brand, #10b981) 30%, transparent);
  }
  ```
- **【危害后果 / 真实运行期隐患】**：
  在子代理呼吸灯与产出徽章上，残留大量带有硬编码 `#10b981` 与 `#059669` 的复合属性，与当前全面推行的 `--accent-color` 规范脱节。

---

### 【缺陷分类与编号】HEX-COLOR-04：发送按钮样式使用裸写颜色关键字 `white`
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:1096, 1140`
- **【断层事实（附带真实代码片段）】**：
  ```css
  .sendBtnCircle,
  .sendCircle {
    color: var(--text-on-brand, white);
  }
  
  .sendBtnCircle svg,
  .sendCircle svg {
    color: var(--text-on-brand, white);
  }
  ```
- **【危害后果 / 真实运行期隐患】**：
  使用 CSS 裸写命名颜色 `white`。若未来品牌底板因无障碍标准调整为浅色微光背景（例如浅色墨水模式），`--text-on-brand` 期望呈现暗色文字时，此处 fallback 的绝对纯白将使图标完全看不见。

---

## 五、违反 Conex §13 焦点态与阴影铁律缺陷（Violations of AGENTS.md §13）

### 【缺陷分类与编号】CONEX-FOCUS-01：违背焦点对比度 ≤ 10% 铁律，滥用非受控 `--focus-ring`
- **【代码文件与精确行号】**：
  - `apps/crish-desktop/src/components/chat-card/ChatEmptyState.module.css:118, 181`
  - `apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:314`
- **【断层事实（附带真实代码片段）】**：
  `ChatEmptyState.module.css`:
  ```css
  .chatEmptyProjectBtnInline:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  
  .chatEmptyAction:focus-visible {
    outline: none;
    background: var(--control-soft-bg-active);
    box-shadow: var(--focus-ring);
  }
  ```
  `ChatMessageRow.module.css`:
  ```css
  .followupChipMain:focus-visible,
  .followupChipSend:focus-visible,
  .followupDismiss:focus-visible {
    outline: none;
    box-shadow: var(--focus-ring);
  }
  ```
  Conex §13 明文强制要求：“输入或按钮处于 active / focused / recording 时，禁止粗、深、实心黑边；灰色加深混入文本色不超过约 10%（例如 `color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)` 为上限量级）；常规元素优先约 3%–6% 混入以保持柔软。”
- **【危害后果 / 真实运行期隐患】**：
  直接引用 `--focus-ring` 生成粗外环，造成对话流跟随芯片与空态按钮在键盘聚焦时边缘极度生硬突兀，与同一文件中其它严格遵守 6%~10% soft mix 的交互元素（如 `.quickPromptCard:focus-visible`）产生严重的视觉质感分裂。

---

### 【缺陷分类与编号】CONEX-FOCUS-02：核心模型选择器完全缺失 `:focus-visible` 样式定义
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-card/ChatCard.module.css:100-126`
- **【断层事实（附带真实代码片段）】**：
  ```css
  .modelBadge {
    ...
    border: none;
    background: transparent;
    ...
  }
  
  .modelBadge:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  ```
  `.modelBadge` 为主输入区域上方核心的可交互控件，仅定义了 `:hover`，完全未声明 `.modelBadge:focus-visible`。
- **【危害后果 / 真实运行期隐患】**：
  当用户通过键盘无障碍访问时，该控件虽然能接收焦点，但没有任何外观变化指示，造成无障碍焦点指示器隐形，直接违反 WCAG 2.4.7 焦点可见性硬性标准。

---

### 【缺陷分类与编号】CONEX-SHADOW-01：违背“禁止厚重阴影”铁律，残留旧式 `rgba(...)` 重阴影
- **【代码文件与精确行号】**：
  - `apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css:89`
  - `apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:808`
- **【断层事实（附带真实代码片段）】**：
  `ChatStatusRibbons.module.css`:
  ```css
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  ```
  `ChatComposer.module.css`:
  ```css
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 6px rgba(0, 0, 0, 0.04);
  ```
  Conex §13 明确铁律：“默认不要重阴影：输入框、搜索框、composer 等默认不要加厚重 box-shadow，保持干净、扁平、轻量”；Conex §14 强制要求避免旧式 `rgba(r,g,b,a)`。
- **【危害后果 / 真实运行期隐患】**：
  在顶栏状态和 Composer 浮层上残存多重模糊深阴影与裸写 `rgba`，深色模式下呈现出脏污的黑色光晕，破坏了 Conex 极简扁平的高级质感。

---

## 六、动效曲线私自书写与违背统一阻尼律缺陷（Motion & Easing Violations）

### 【缺陷分类与编号】MOTION-EASING-01：流式表格单元格私自内联 `cubic-bezier(0.16, 1, 0.3, 1)`
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:106`
- **【断层事实（附带真实代码片段）】**：
  ```css
  animation: md-table-pulse var(--stream-table-pulse-duration, 1.6s) var(--stream-table-pulse-timing, cubic-bezier(0.16, 1, 0.3, 1)) infinite;
  ```
  样式表直接私写贝塞尔函数 `cubic-bezier(0.16, 1, 0.3, 1)`，直接打破了前序文档关于“杜绝组件层内联私自书写 cubic-bezier(0.16, 1, 0.3, 1)，统一收敛至 var(--ease-emphasized)”的声明。
- **【危害后果 / 真实运行期隐患】**：
  表格在接收流式 Token 输出时，单元格的呼吸动画与全局组件的加减速曲线产生微妙的相位脱节，且无法通过修改全局 `--ease-emphasized` 一并调优。

---

### 【缺陷分类与编号】MOTION-EASING-02：工具调用行多处内联随意贝塞尔数值与时间常数
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css:119, 676, 678, 705`
- **【断层事实（附带真实代码片段）】**：
  ```css
  animation: toolIndicatorFlip 100ms cubic-bezier(0.2, 0, 0, 1) forwards;
  
  transition:
    max-width 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.18s ease,
    margin-left 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  
  transition:
    color 0.15s ease,
    background 0.15s ease,
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  ```
- **【危害后果 / 真实运行期隐患】**：
  未引用任何统一过渡 Token，捏造了 `0.22s`、`cubic-bezier(0.22, 1, 0.36, 1)` 等非标参数，不仅增加了 CSS 解析负载，而且使路径展开与翻转指示器在不同设备上呈现不自然的突兀反弹。

---

### 【缺陷分类与编号】MOTION-EASING-03：发送按钮连续 4 组内联硬编码贝塞尔
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:1102-1105`
- **【断层事实（附带真实代码片段）】**：
  ```css
  transition:
    width 200ms cubic-bezier(0.16, 1, 0.3, 1),
    margin-left 200ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 160ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 200ms cubic-bezier(0.16, 1, 0.3, 1),
  ```
- **【危害后果 / 真实运行期隐患】**：
  同一选择器内 4 次重复书写 `cubic-bezier(0.16, 1, 0.3, 1)` 与裸写时间常数，使得该动效无法响应全局减弱动效策略与统一时间尺度调整。

---

## 七、TSX / JSX 内联样式反模式缺陷（TSX Inline Style Hardcoding）

### 【缺陷分类与编号】INLINE-STYLE-01：动态状态抽屉大量使用 JSX `style` 重置与颜色覆盖
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-card/DynamicChipBar.tsx:148-153, 169, 174, 182`
- **【断层事实（附带真实代码片段）】**：
  ```tsx
  <Button
    style={{
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: 'var(--text-tertiary)',
    }}
    ...
  />
  <Lucide.CheckCircle2 size={13} style={{ color: 'var(--accent-green)' }} />
  <Lucide.Circle size={13} style={{ color: 'var(--text-tertiary)' }} />
  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
  ```
- **【危害后果 / 真实运行期隐患】**：
  彻底无视组件现有的 CSS Module 架构，通过内联对象硬编码布局与颜色。内联样式拥有过高的权重，使得外部通过类名进行响应式适配或深浅主题微调被完全拦截失效；且每次 React 重新渲染时都会创建新的样式对象实例，引发无谓的垃圾回收压力。

---

### 【缺陷分类与编号】INLINE-STYLE-02：模型选择器在已有 CSS 类上叠加冗余内联样式
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-card/ChatHeaderControls.tsx:168, 173-179`
- **【断层事实（附带真实代码片段）】**：
  ```tsx
  <button
    className={`${styles.modelBadge} ...`}
    style={{ cursor: 'pointer', position: 'relative' }}
  >
    <span
      className={styles.modelText}
      style={{
        textOverflow: 'ellipsis',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        flex: 1,
        textAlign: 'left',
      }}
    >
  ```
- **【危害后果 / 真实运行期隐患】**：
  `styles.modelBadge` 与 `styles.modelText` 本身应当是排版单一真理源（SSOT）。开发者在 JSX 中又重复内联注入文本省略与弹性布局属性，造成 CSS Module 与 JSX 样式双源漂移，维护时修改 CSS 文件无法生效，极易引发修改盲区。

---

### 【缺陷分类与编号】INLINE-STYLE-03：微型加载指示器通过 JSX 内联强制固定像素
- **【代码文件与精确行号】**：
  - `apps/crish-desktop/src/components/chat-injection/InjectionHeader.tsx:180`
  - `apps/crish-desktop/src/components/chat-tool-call/CompactToolRow.tsx:146`
- **【断层事实（附带真实代码片段）】**：
  `InjectionHeader.tsx`:
  ```tsx
  <span
    className={`${styles.pendingPulse} loading-spinner`}
    style={{ width: 12, height: 12, borderWidth: 1.5 }}
  />
  ```
  `CompactToolRow.tsx`:
  ```tsx
  <span
    className="loading-spinner"
    style={{ width: 8, height: 8, borderWidth: 1.5 }}
  />
  ```
- **【危害后果 / 真实运行期隐患】**：
  微型加载 Spinner 的尺寸和边框宽度未封装为标准的尺寸原子类，硬编码了 `8px` 与 `12px`。在操作系统缩放比例非整数（如 125%、175%）时，`1.5px` 边框产生严重模糊与抗锯齿杂色。

---

### 【缺陷分类与编号】INLINE-STYLE-04：消息滚动容器空态内联裸写 Flex 属性
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-message-list/ChatMessageList.tsx:191`
- **【断层事实（附带真实代码片段）】**：
  ```tsx
  <div
    data-chat-scroll-container=""
    style={{ padding: '8px 0', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}
  >
  ```
- **【危害后果 / 真实运行期隐患】**：
  空态下的滚动容器直接内联布局参数，未复用标准主列栅格与内边距 Token，导致从空态水合为消息流时发生横向位置与内边距的跳动。

---

## 八、魔术数字与注释破坏代码卫生缺陷（Magic Numbers & Code Hygiene）

### 【缺陷分类与编号】MAGIC-NUMBER-01：核心消息气泡圆角硬编码魔术数字 `22px`
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css:86`
- **【断层事实（附带真实代码片段）】**：
  ```css
  .userBubble {
    background: color-mix(in srgb, var(--text-primary) 5.5%, var(--bg-card));
    color: var(--text-primary);
    border-radius: 22px;
    ...
  }
  ```
- **【危害后果 / 真实运行期隐患】**：
  未绑定任何设计系统圆角 Token（如 `--radius-xl` 或 `--radius-2xl`），在整体调整系统视觉风格或圆角弧度等级时，最核心的用户消息气泡成为漏网之鱼，无法联动。

---

### 【缺陷分类与编号】MAGIC-NUMBER-02：控制栏与分割线硬编码 `33px` / `0.5px`
- **【代码文件与精确行号】**：`apps/crish-desktop/src/components/chat-message/MessageContent.module.css:15, 20`
- **【断层事实（附带真实代码片段）】**：
  ```css
  .turnProcessControlBar {
    display: flex;
    align-items: center;
    width: 100%;
    height: 33px;
    padding: 6px 0;
    margin: 0;
    background: transparent;
    border: none;
    border-bottom: 0.5px solid var(--border-subtle);
  ```
- **【危害后果 / 真实运行期隐患】**：
  高度硬编码奇数 `33px`，脱离 8 点网格栅格律；下边框裸写 `0.5px` 在 1x 标准分辨率显示器上存在被浏览器丢弃（渲染为 0px）或抖动为 1px 的物理兼容缺陷。

---

### 【缺陷分类与编号】CODE-HYGIENE-01：历史编码污染导致核心样式注释大面积乱码与字符丢失
- **【代码文件与精确行号】**：
  - `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css:328, 387, 405, 452, 476, 485, 526, 570, 584, 605, 619`
  - `apps/crish-desktop/src/components/chat-card/ChatEmptyState.module.css:29, 84, 152`
- **【断层事实（附带真实代码片段）】**：
  `ChatToolCallBlock.module.css`:
  ```css
  /*        V1-          inspect /        group  */
  /*        */
  /*      Header */
  /*         */
  /*      */
  /* CLI Shell     */
  /*     Key-Value    */
  /*    Code   */
  ```
  `ChatEmptyState.module.css`:
  ```css
  max-width: none; /*       .chatCol      composer    */
  /*              /           */
  /* pill action   soft control, no elevation */
  ```
- **【危害后果 / 真实运行期隐患】**：
  因历史脚本处理不当，大量中文注释字符被替换为空格，原设计意图与架构分区文档信息永久丢失，不仅极具碍观，而且形成技术资产破坏，严重阻碍后续工程审计与维护。
