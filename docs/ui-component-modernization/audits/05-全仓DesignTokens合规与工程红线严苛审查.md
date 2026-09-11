# Conex / Crish — 全仓 Design Tokens、Zero-Blue 与工程红线严苛审查报告

> **审查文档**：`docs/ui-component-modernization/audits/05-全仓DesignTokens合规与工程红线严苛审查.md`
> **审查基准**：`AGENTS.md` §13/§14、`ANTI_OVERENGINEERING_GUARDRAILS.md`、RL-03 行数门禁、Appica 动效物理数学契约
> **审查范围**：`Switch/`、`Tabs/`、`SegmentedControl/`、`Select/`、`PreviewCard/`、`overlay/Toast*`、`services/toast/`
> **审查纪律**：**只挑刺，别的一概不说**。严禁客套废话，直奔问题、缺陷、潜在 Bug 与架构漏洞。

---

## 一、审查问题清单总览

| 编号 | 严重级别 | 所涉组件/文件 | 缺陷类别 | 核心问题摘要 |
| :--- | :--- | :--- | :--- | :--- |
| **01** | **致命/严重** | `ui/Select/Combobox.tsx:1-1340` | RL-03 行数红线 | 单文件 1340 行严重超标（超限 168%），混杂 15 个子组件与适配器，违反上帝组件禁令 |
| **02** | **致命/严重** | `ui/Select/Select.tsx:1-1081` | RL-03 行数红线 | 单文件 1081 行严重超标（超限 116%），11 个复合子组件与适配器堆叠单文件 |
| **03** | **严重** | `ui/PreviewCard/PreviewCard.tsx:1-767` | RL-03 行数红线 | 单文件 767 行超标（超限 53%），几何算法与视图组件未物理拆分 |
| **04** | **严重** | `overlay/ToastStackModern.module.css` | 颜色与 Token 违规 | 散落 26 处硬编码 HEX（`#000`, `#111111`, `#555555`, `#dc2626` 等），破坏 Design Tokens |
| **05** | **严重** | `ui/SegmentedControl/SegmentedControl.module.css:9-10` | 几何同心圆角偏离 | 内外圆角均设为 7px，未遵循 $R_{\text{inner}} = R_{\text{outer}} - P$，角部挤压变形 |
| **06** | **严重** | `ui/Select/useFloatingPosition.ts:226-240` | 性能与回流漏洞 | 捕获阶段全量 window scroll 监听未过滤浮层内部滚动，引发严重 Layout Thrashing |
| **07** | **严重** | `ui/Select/Combobox.tsx:628-632` | IME 输入法竞态 | `onCompositionEnd` 同步解锁导致拼音选词回车误触发选项选择与弹窗关闭 |
| **08** | **严重** | `ui/Tabs/Tabs.tsx:368` / `SegmentedControl.tsx:233` | WAI-ARIA 无障碍漏洞 | 初始无选中项时所有 Tab 为 `tabIndex={-1}`，导致键盘 Tab 键完全无法进入组件 |
| **09** | **严重** | `ui/Switch/Switch.tsx:152-158` | 物理动效瞬跳 Bug | 快速连击时 CSS `@keyframes` 强制从 0% 起跳导致滑块中途瞬移归零 |
| **10** | **一般** | `ui/Select/Select.module.css:1-519` | RL-03 行数偏高 | CSS 单文件达到 519 行，样式未按 Compound 边界解耦 |
| **11** | **一般** | `overlay/ToastCard.tsx:120, 129, 138, 148, 157` | Token 违规硬编码 | JSX 内联样式硬编码 HEX fallback，未收敛至 CSS Modules |
| **12** | **一般** | 全仓多组件 CSS Modules | Token 违规十六进制 | 16 处 `var(--bg-card, #ffffff)` / `var(--text-*, #111111)` 硬编码 HEX 回退值 |
| **13** | **一般** | `Tabs.module.css` / `PreviewCard.module.css` 等 | AGENTS.md §14 违规 | 散落旧式 `rgba(...)` 语法，未遵循现代 HSL / color-mix 色彩空间 |
| **14** | **一般** | `ui/Switch/Switch.module.css:99` | Hover 态未收敛 | 开关 Hover 采用自定义混色，未收敛至全仓 `var(--tint-hover)` 体系 |
| **15** | **一般** | `overlay/ToastStackModern.module.css:234-236` | 动效与计时脱节 | 悬停暂停后进度条关键帧与 React 内部毫秒计时器恢复时产生跳变 |
| **16** | **一般** | `ui/Select/useFloatingPosition.ts:244` | React 不纯渲染 | 在组件渲染中使用 `Math.random()` 生成 ID，破坏确定性与 SSR 水合 |
| **17** | **一般** | `ui/Tabs/Tabs.tsx:210-222` | DOM 边界与重测缺陷 | 仅监听外框 ResizeObserver，Tab 文本变更/字体异步加载时滑块错位 |
| **18** | **一般** | `ui/Select/Combobox.tsx:711-752` | 键盘漫游缺失 | Chips 多选模式不支持 `ArrowLeft` / `ArrowRight` 胶囊间光标横向漫游 |

---

## 二、逐项严苛缺陷深度剖析与极致修复方案

### 1. 代码行数超标与反过度设计红线（RL-03）

#### [严重级别: 致命/严重] `apps/crish-desktop/src/components/ui/Select/Combobox.tsx:1-1340`
- **缺陷剖析**：
  单文件行数高达 **1340 行**，超出前端 UI 组件 ≤ 500 行的红线门禁多达 840 行（超标 168%）！该文件违背单一职责原则，将 `Combobox`, `ComboboxTrigger`, `ComboboxInput`, `ComboboxChips`, `ComboboxChip`, `ComboboxContent`, `ComboboxList`, `ComboboxItem`, `ComboboxGroup`, `ComboboxLabel`, `ComboboxSeparator`, `ComboboxEmpty`, `ComboboxClearButton`, `ComboboxIcon`, `ComboboxLegacyAdapter` 等 15 个组件、多个内联 SVG 以及全文搜索与拼音高亮算法全部塞进一个文件。
- **极致修复方案**：
  必须立即实施物理文件拆分，严格按复合组件架构解耦：
  ```
  apps/crish-desktop/src/components/ui/Select/
  ├── Combobox.tsx             (主入口与 Context Provider, ≤ 180 行)
  ├── ComboboxInput.tsx        (单选搜索框与 IME 状态机, ≤ 160 行)
  ├── ComboboxChips.tsx        (多选 Chips 胶囊换行排版, ≤ 200 行)
  ├── ComboboxContent.tsx      (浮层容器、列表与选项行, ≤ 220 行)
  ├── ComboboxLegacyAdapter.tsx(历史配置式 Props 兼容层, ≤ 80 行)
  ├── comboboxHighlight.tsx    (关键词高亮算法, ≤ 50 行)
  └── index.ts                 (聚合导出)
  ```

---

#### [严重级别: 致命/严重] `apps/crish-desktop/src/components/ui/Select/Select.tsx:1-1081`
- **缺陷剖析**：
  单文件行数达到 **1081 行**，超出 UI ≤ 500 行上限 116%。单文件聚合了 11 个复合子组件与 Legacy 适配器，同时内联包含 JSX 树递归静态解析函数 `extractItemsFromChildren`。
- **极致修复方案**：
  物理拆分为原子文件结构：
  - `SelectRoot.tsx`（根状态编排，≤ 160 行）；
  - `SelectTrigger.tsx` 与 `SelectValue.tsx`（触发器与值渲染，≤ 160 行）；
  - `SelectContent.tsx` 与 `SelectItem.tsx`（浮层与项，≤ 200 行）；
  - `SelectLegacyAdapter.tsx`（旧版兼容，≤ 80 行）；
  - `selectUtils.ts`（静态 JSX 项提取辅助函数，≤ 50 行）。

---

#### [严重级别: 严重] `apps/crish-desktop/src/components/ui/PreviewCard/PreviewCard.tsx:1-767`
- **缺陷剖析**：
  单文件行数 **767 行**，超出 500 行限制。文件内把视口碰撞翻折与边缘钳位算法 `computePreviewCardPosition`（130 行代码）、`useMergeRefs` 工具 Hook、Trigger 与 Content 视图混合存放。
- **极致修复方案**：
  1. 将纯几何数学算法抽离到 `previewCardPosition.ts`（≤ 140 行）；
  2. 将 `PreviewCardTrigger.tsx` 与 `PreviewCardContent.tsx` 拆分为独立文件。

---

#### [严重级别: 一般] `apps/crish-desktop/src/components/ui/Select/Select.module.css:1-519`
- **缺陷剖析**：
  CSS 单文件达到 519 行，超过了样式单文件 500 行的维护性门槛。Trigger、Popup Content、Item、Group、Separator 样式均堆叠在一个文件中。
- **极致修复方案**：
  按组件拆分为 `SelectTrigger.module.css` 与 `SelectContent.module.css`。

---

### 2. 颜色与 Token 绝对合规（Zero-Blue、HEX 清零与色彩空间）

#### [严重级别: 严重] `apps/crish-desktop/src/components/overlay/ToastStackModern.module.css:77-405`
- **缺陷剖析**：
  样式表中存在 **26 处硬编码十六进制 HEX** 颜色与回退值：
  - 行 77, 312, 318, 364, 375, 386, 405: `#111111`
  - 行 86, 87, 123, 140, 141, 150: `#000`
  - 行 253, 257, 380: `#dc2626`
  - 行 262: `#86efac`
  - 行 266, 344: `#059669`
  - 行 271, 275: `#c2410c`
  - 行 280: `#10b981`
  - 行 325: `#555555`
  - 行 365, 381: `#ffffff`
  - 行 397: `#696969`
  这些硬编码严重破坏了项目的 Design Tokens 体系，导致深色模式或主题变体下出现严重的视觉残留与断层。
- **极致修复方案**：
  彻底清洗为仓库标准语义 Tokens：
  ```css
  /* 修复后标准 Token 规范 */
  .title, .message {
    color: var(--text-primary);
  }
  .description {
    color: var(--text-secondary);
  }
  .closeButton {
    color: var(--text-tertiary);
  }
  .toastCard {
    box-shadow: 0 -4px 16px -2px color-mix(in srgb, var(--shadow-color) 6%, transparent),
                0 2px 6px -1px color-mix(in srgb, var(--shadow-color) 4%, transparent);
    background-color: var(--bg-card, hsl(0 0% 100%));
  }
  .toastCard[data-type='error'] .progressBar {
    background: var(--text-danger);
  }
  .toastCard[data-type='success'] .progressBar {
    background: var(--text-success-strong);
  }
  .toastCard[data-type='warning'] .progressBar {
    background: var(--text-warning-strong);
  }
  ```

---

#### [严重级别: 一般] `apps/crish-desktop/src/components/overlay/ToastCard.tsx:120-157`
- **缺陷剖析**：
  在 JSX 内联 `style={{ color: '...' }}` 中违规写入了 HEX 回退值：
  - 行 120: `style={{ color: 'var(--text-success-strong, #059669)' }}`
  - 行 129: `style={{ color: 'var(--text-danger, #dc2626)' }}`
  - 行 138: `style={{ color: 'var(--text-warning-strong, #c2410c)' }}`
  - 行 148: `style={{ color: 'var(--brand, #10b981)' }}`
  - 行 157: `style={{ color: 'var(--text-secondary, #555555)' }}`
- **极致修复方案**：
  完全移除内联 style，改用 CSS Modules 类名控制色彩：
  ```tsx
  <span className={styles.iconWrapper} data-type={toast.type}>
    {getIcon()}
  </span>
  ```

---

#### [严重级别: 一般] 多组件 CSS Modules 中的硬编码 `#ffffff` / `#111111` / `#555555` / `#888888`
- **缺陷位置**：
  - `Switch.module.css:136`: `background: var(--bg-elevated, #ffffff);`
  - `Switch.module.css:226`: `color: var(--text-tertiary, #888888);`
  - `Tabs.module.css:132`: `background-color: var(--bg-card, #ffffff);`
  - `SegmentedControl.module.css:84`: `background-color: var(--bg-card, #ffffff);`
  - `Combobox.module.css:22, 40, 102`: `background: var(--bg-card, #ffffff);`
  - `Select.module.css:32, 52, 70, 192, 236`: `background: var(--bg-card, #ffffff);`
  - `PreviewCard.module.css:17, 126, 133`: `#111111`, `#555555`
- **缺陷剖析**：
  在 CSS 变量回退值中随意硬编码十六进制值，破坏了 Zero-Blue 暖灰墨阶的设计基准。
- **极致修复方案**：
  统一遵循纯白底板 `var(--bg-card, hsl(0 0% 100%))` 与文本变量 `var(--text-primary)` / `var(--text-secondary)` / `var(--text-tertiary)`。

---

#### [严重级别: 一般] 旧式 `rgba(...)` 语法散落（违反 AGENTS.md §14）
- **缺陷位置**：
  - `Tabs.module.css:135-136`: `0 1px 2px rgba(0, 0, 0, 0.05)`
  - `SegmentedControl.module.css:87-88`: `0 1px 2px rgba(0, 0, 0, 0.05)`
  - `Select.module.css:478`: `background: var(--border-subtle, rgba(0, 0, 0, 0.06));`
  - `PreviewCard.module.css:21`: `box-shadow: var(--shadow-2xl, 0 16px 36px -4px rgba(0, 0, 0, 0.2));`
- **缺陷剖析**：
  违反了 AGENTS.md §14「避免散落旧式 `rgba(r,g,b,a)`；UI 与 Design Token 优先 `hsl(h s l / a)` 或 `color-mix`」的强制规范。
- **极致修复方案**：
  ```css
  /* 修复后 */
  .separator {
    background: var(--border-subtle, hsl(0 0% 0% / 0.06));
  }
  .popup {
    box-shadow: var(--shadow-2xl, 0 16px 36px -4px color-mix(in srgb, var(--shadow-color) 20%, transparent));
  }
  ```

---

#### [严重级别: 一般] `apps/crish-desktop/src/components/ui/Switch/Switch.module.css:99` Hover 态未收敛
- **缺陷剖析**：
  `.track:hover:not(:disabled)` 采用了 `background: color-mix(in srgb, var(--text-primary) 8%, var(--bg-tertiary));`，自创了 8% 文本混色，未遵循全局 Hover 收敛至 `var(--tint-hover)` 的铁律。
- **极致修复方案**：
  使用标准的背景底色叠加 `var(--tint-hover)`。

---

### 3. 几何与物理动效数学模型缺陷

#### [严重级别: 严重] `apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css:9-10` 同心圆角几何公式违背
- **缺陷剖析**：
  ```css
  --seg-outer-radius: var(--button-radius, 7px);
  --seg-inner-radius: var(--button-radius, 7px);
  ```
  SegmentedControl 外框与内部滑块均分配了 7px 圆角。由于容器具有 2px padding，根据同心圆角方程：
  $$R_{\text{inner}} = R_{\text{outer}} - \text{Padding} = 7\text{px} - 2\text{px} = 5\text{px}$$
  如果内圆角同为 7px，滑块在贴近外框边缘时四个角落会出现明显的几何角部挤压（Corner Crowding），破坏了与 Tabs 一致的物理同心视觉。
- **极致修复方案**：
  ```css
  --seg-pad: 2px;
  --seg-outer-radius: var(--button-radius, 7px);
  --seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad)); /* 严格 5px */
  ```

---

#### [严重级别: 严重] `apps/crish-desktop/src/components/ui/Switch/Switch.tsx:152-158` 快速点击时 CSS Keyframes 瞬跳归零 Bug
- **缺陷剖析**：
  Switch 的 Pill Stretch 采用 CSS `@keyframes thumb-stretch-on` 与 `@keyframes thumb-stretch-off`。当用户快速连续点击开关（或受控状态高频切换）时，新的 keyframe 动画触发会强制从 0% 关键帧（`translateX(0)`）起跳，导致滑块从运动中途瞬间闪跳回原点再重新拉伸，破坏流体果冻的物理平滑感。
- **极致修复方案**：
  将绝对关键帧动画改造为基于 CSS 变量驱动的 `transition: transform, width`，或者在 React 中动态监测动画中途并在切换时平滑逆转。

---

#### [严重级别: 一般] `apps/crish-desktop/src/components/overlay/ToastStackModern.module.css:234-236` 展开悬停进度条跳变
- **缺陷剖析**：
  展开悬停时 CSS 设置了 `animation-play-state: paused`，而 JS 侧在 `ToastCard.tsx` 中记录了剩余时间。但当鼠标离开时，CSS 关键帧无法动态读取 JS 修正后的精确剩余时间，导致动画重新开始播放或总时长与实际自动关闭时间产生脱节。
- **极致修复方案**：
  在 `ToastCard.tsx` 中，鼠标移出恢复计时时，动态将当前的剩余百分比或剩余时间写入 CSS 变量 `--toast-remaining-duration` 并重置进度条关键帧。

---

### 4. 内存生命周期、边界处理与极端场景缺陷

#### [严重级别: 严重] `apps/crish-desktop/src/components/ui/Select/useFloatingPosition.ts:226-240` 捕获阶段全量 Scroll 引发 Layout Thrashing
- **缺陷剖析**：
  `useFloatingPosition` 使用了 `window.addEventListener('scroll', handleScrollOrResize, { passive: true, capture: true })`。当浮层展开后，用户在下拉列表内容区内部（具有垂直滚动条的长列表）滚动时，内部的每一个 `scroll` 事件都会捕获触发 `updatePosition()`，从而在每一帧强制触发 `contentEl.offsetWidth` 与 `triggerEl.getBoundingClientRect()` 回流读取，造成高频掉帧与主线程卡死。
- **极致修复方案**：
  在滚动监听回调中判定事件源 `e.target`，若滚动来自于浮层内容节点内部，直接拦截跳过：
  ```ts
  const handleScrollOrResize = (e: Event) => {
    if (e.type === 'scroll' && contentRef.current && contentRef.current.contains(e.target as Node)) {
      return; // 忽略浮层内部列表滚动
    }
    updatePosition();
  };
  ```

---

#### [严重级别: 严重] `apps/crish-desktop/src/components/ui/Select/Combobox.tsx:628-632` IME 输入法合成回车竞态打断
- **缺陷剖析**：
  `onCompositionEnd` 直接同步执行 `isComposingRef.current = false`。在 Chromium/WebView2 环境下，中文输入法选词回车的 `compositionend` 事件可能紧接着触发一个带有 `Enter`（keyCode 13）的键盘事件。由于同步置为 false，`handleKeyDown` 在检测到 keyCode 13 且 `isComposingRef.current === false` 时，会误将这次选词确认当作用户提交选择，直接选中了高亮选项并关闭了弹窗。
- **极致修复方案**：
  在 `onCompositionEnd` 中使用微任务或短延迟解除合成锁：
  ```ts
  onCompositionEnd={() => {
    setTimeout(() => {
      isComposingRef.current = false;
    }, 30);
  }}
  ```

---

#### [严重级别: 一般] `apps/crish-desktop/src/components/ui/Select/useFloatingPosition.ts:244` 渲染时不纯随机数
- **缺陷剖析**：
  `useRef(layerId ?? 'floating-layer-' + Math.random().toString(36)...)` 在组件渲染期调用 `Math.random()`，违反 React 纯函数规范。
- **极致修复方案**：
  改用 React 内建 `useId()`：
  ```ts
  const autoId = useId();
  const resolvedLayerId = layerId ?? `floating-layer-${autoId}`;
  ```

---

#### [严重级别: 一般] `apps/crish-desktop/src/components/ui/Tabs/Tabs.tsx:210-222` DOM 变更未触发指示条重测
- **缺陷剖析**：
  `TabsList` 仅监听了外层容器的 `ResizeObserver`。当 Tab 标签内部文字异步国际化更新、图标动态加载或字体完成下载导致触发器宽度变化但外层总宽度不变时，指示块不会重新测量位置，导致滑块与激活 Tab 产生错位。
- **极致修复方案**：
  在 `useTabsContext` 注册的所有子 Trigger 上建立 ResizeObserver 监听，或通过 `MutationObserver` 监听 childList / characterData。

---

### 5. 无障碍与键盘交互缺陷（A11y, ARIA, Roving Tabindex）

#### [严重级别: 严重] `apps/crish-desktop/src/components/ui/Tabs/Tabs.tsx:368` 与 `SegmentedControl.tsx:233` Roving TabIndex 初始不可达 Bug
- **缺陷剖析**：
  ```tsx
  tabIndex={isSelected && !disabled ? 0 : -1}
  ```
  如果传入的 `value` 初始未匹配任何现有选项（例如异步数据未加载完成、受控 `value` 为空字符串或 null），则所有 Tab 按钮的 `tabIndex` 全部被赋予 `-1`。根据 WAI-ARIA 规范，用户使用键盘 Tab 键漫游到该组件时，整个 TabGroup 会被浏览器焦点系统完全跳过，造成严重的键盘不可达无障碍缺陷！
- **极致修复方案**：
  当存在选中项时激活选中项为 0；若不存在任何选中项，则将列表中的**第一个非禁用项**设为 `tabIndex={0}`：
  ```tsx
  const hasAnySelected = options.some((o) => o.value === currentValue);
  const isFirstEnabled = !hasAnySelected && isFirstEnabledOption(opt);
  const tabIndex = (isSelected || isFirstEnabled) && !disabled ? 0 : -1;
  ```

---

#### [严重级别: 一般] `apps/crish-desktop/src/components/ui/Select/Combobox.tsx:711-752` Chips 多选模式缺乏左右光标漫游
- **缺陷剖析**：
  在 `ComboboxChips` 多选模式下，当输入框为空且存在多个 Chips 时，仅支持连续按 Backspace 从后向前删除，不支持使用 `ArrowLeft` / `ArrowRight` 在已有 Chips 之间前后漫游焦点，违反了标准 Chips 输入框无障碍键盘规范。
- **极致修复方案**：
  在 `handleKeyDown` 中捕获 `ArrowLeft` / `ArrowRight`，当输入光标在最左侧（`selectionStart === 0`）且 `query === ''` 时，允许在 Chips 胶囊间前后漫游并赋予高亮。

---

## 三、审查结论与整改指令

1. **红线阻断项（必须立即整改）**：
   - **RL-03 行数超标**：`Combobox.tsx` (1340行)、`Select.tsx` (1081行)、`PreviewCard.tsx` (767行) 必须立即按复合组件边界执行物理文件拆解，单文件严格收敛至 ≤ 500 行；
   - **Zero-Blue 墨阶纯净化**：`ToastStackModern.module.css` 中的 26 处硬编码 HEX 与 `ToastCard.tsx` 内联样式必须全部清洗为项目 Design Tokens；
   - **几何同心圆角**：`SegmentedControl.module.css` 必须修正内圆角公式为 `calc(var(--seg-outer-radius) - var(--seg-pad))`；
   - **性能与生命周期**：`useFloatingPosition.ts` 必须增加浮层内部滚动事件过滤，杜绝 Layout Thrashing；
   - **IME 输入法**：`Combobox.tsx` 必须增加微任务延迟合成锁，防止选词回车打断与误触发。

2. **合规验证基准**：
   - 整改后必须通过全量 `npm run check:line-counts`；
   - 运行全量 `npm run test` 与 UI 单元测试集；
   - 严禁引入任何外部第三方组件库，保持 100% 自研纯净度。
