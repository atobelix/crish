# 跨维度综合建议：方案架构 B（工程稳健性、防回归资产保护与无障碍防线）

> **战役代号**：`UI-UNIFICATION-REDESIGN`
> **文档定位**：阶段一 前置深度审计与维度架构建议（方案架构 B）
> **权威依据**：
> - `C:\Software\conex\skill\design\`（`apple-design.md` 物理流体动效体系 + `jakub-skills` 7 大工程级设计技能）
> - `docs/ui-unification-redesign/00-战役调度总纲与工作区规范.md`（战役调度总纲）
> - `FULL_CHECK_COMMANDS.md`（全仓全量门禁清单）
> - `AGENTS.md`（通用纪律、反退避铁律、§7 严禁补丁、§7.1 立体验证、§11 CI 治理、§13 输入与焦点态、§14 色彩空间）
> - `scripts/check-ui-layer.mjs`（UI 原子层解耦门禁）与 `apps/crish-desktop/src/styles/style-contract.test.ts`（样式契约测试）

---

## 一、方案架构 B 核心定位与设计哲学

在主控调度总纲 `00-战役调度总纲与工作区规范.md` 确立的四大推进维度（DIM-01 ~ DIM-04）下，方案 A 通常偏向**“绿地重构思维”（Aesthetic-First / Greenfield Replacement）**——追求一步到位的纯粹视觉重构与激进清洗，倾向于直接删除历史 Token、重写基础组件 DOM 结构、强制替换原生 HTML 标签。然而，Crish 作为一个高度成熟的桌面应用，拥有庞大的自动化测试资产网络与严格的 CI 门禁链。

**方案架构 B（Engineering-First / Defensive Evolution）** 的核心定位是：
> **“在零破坏性变更、零测试资产回归、零跨层架构漂移的前提下，以双桥平滑演进与原子级契约守护，实现 Apple-level 的极简视觉收敛与物理交互质感。”**

方案 B 坚信：**真正的工程级重构不是制造一场让 CI 门禁全面飘红的爆破，而是把架构负债消减、代码净负产出与全量单测防护编织进同一个原子事务中**。

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 方案 A vs 方案 B 核心哲学对比                             │
├───────────────────────────────┬─────────────────────────────────┬───────────────────────┤
│ 维度                          │ 方案 A（激进重塑型）            │ 方案 B（稳健工程演进型 · 本方案）        │
├───────────────────────────────┼─────────────────────────────────┼───────────────────────┤
│ 演进路径 (Migration Path)     │ 破而后立，全量重写组件与样式    │ 双桥过渡协议 (Dual-Bridge Protocol)    │
│ 样式契约 (Style Contract)     │ 直接删除旧 Token 与尺寸定义     │ 锁步更新 style-contract 门禁与棘轮断言  │
│ 基础组件 (Button/Input)       │ 重构 DOM 结构以迎合新视觉       │ 严格锁定现有 Props、DOM 树与 Class 映射 │
│ 原子层防护 (UI Layer Guard)   │ 容易误引入动画库/Hooks 外部依赖 │ 刚性遵循 check:ui-layer 纯粹第一层契约   │
│ 极端视口 (Extreme Viewport)   │ 默认标准视口，未显式防御窄屏    │ 强制覆盖 320px 视口回流与 200% 缩放防线 │
│ 无障碍体验 (A11y & Focus)     │ 依赖通用标准，细节易被动丢失    │ 深度固化 WCAG 2.5.8 尺寸与 APG 键盘闭环 │
└───────────────────────────────┴─────────────────────────────────┴───────────────────────┘
```

---

## 二、方案架构 B 跨维度差异化建议与潜在隐患深剖

### 1. DIM-01：重复、死层与 Token 碎片收敛

#### 方案 A 侧重点与盲区
方案 A 倾向于对 `apps/crish-desktop/src/styles/tokens.css`（1758 行）执行“大快人心”的直接修剪，立即剔除 30+ 废弃别名、清除 6 档半像素碎步字阶（nano: 10px, micro: 11.5px, xs-plus: 12.5px, sm-plus: 13.5px, xxl: 18px, 2xl: 22px），并统一为标准 7 档字阶。

#### 方案 B 独立审视与潜在隐患
1. **`style-contract.test.ts` 契约崩溃隐患**：
   - `apps/crish-desktop/src/styles/style-contract.test.ts:133-180` 明确断言：`--ui-text-*` 五连 Token 必须在 `html[data-theme='dark']` 块内重新定义，且色系前缀 Token（`bg|text|border|accent|color|tint|sidebar|control`）在 dark 块必须 100% 重新定义；
   - `style-contract.test.ts:352-368` 断言“双层同源约束 1”：`themeStore.ts` 和 `themePersonalization.ts` 中 `setProperty` 注入的每一个 Token，必须在 `tokens.css` 存在静态定义；
   - `style-contract.test.ts:182-208` 维持裸混色棘轮 `BARE_MIX_BASELINE = 25`，`style-contract.test.ts:331-349` 维持 `!important` 棘轮 `IMPORTANT_BASELINE = 626`。
   - **隐患暴露**：若方案 A 在收敛 Token 时直接删除了被 `themeStore.ts` 动态注入或被 `style-contract.test.ts` 列入检查集的变量，将导致样式测试立即爆红，阻断快层 CI。
2. **字阶跳跃导致排版崩塌（Layout Overflow）**：
   - 现存的 `13.5px`（`--font-size-chat`、`--aicard-title-font-size`）是经过桌面排版微调的黄金尺寸。若粗暴四舍五入降为 `13px` 或升为 `14px`，在多列分栏或聊天卡片标题行中会导致原本单行展示的内容强制折行，造成纵向布局高度抖动。

#### 方案 B 架构对策：双层渐进收敛协议（Two-Phase Token Bridge）
- **Phase 1（别名桥接与静态对齐）**：将待淘汰的 6 档半像素字阶在 `tokens.css` 中重定向映射至标准 7 档，但保留 CSS 变量名向后兼容：
  ```css
  /* 桥接期：将碎步别名透明重定向至标准字阶，杜绝悬空引用 */
  --font-size-nano: var(--font-size-xs);       /* 10px -> 12px */
  --font-size-micro: var(--font-size-xs);      /* 11.5px -> 12px */
  --font-size-xs-plus: var(--font-size-sm);    /* 12.5px -> 13px */
  --font-size-sm-plus: var(--font-size-base);  /* 13.5px -> 14px */
  --font-size-chat: var(--font-size-base);     /* 13.5px -> 14px */
  ```
- **Phase 2（代码消费点收口与同源断言同步）**：全仓替换消费点后，同步更新 `style-contract.test.ts` 的静态扫描集，在同一原子提交中完成旧 Token 拔除与契约更新，确保 CI 始终全绿。

---

### 2. DIM-02：同心几何标尺与 Apple 物理动效

#### 方案 A 侧重点与盲区
方案 A 致力于消除 5px/7px 等杂乱硬编码圆角，强推 4px/8px 网格，落地 $R_{outer} = R_{inner} + padding$；同时在交互控件引入 `scale(0.96)`、1.0 临界阻尼、主题切换动画门闩等 Apple 动效。

#### 方案 B 独立审视与潜在隐患
1. **`--button-radius: 7px` 硬编码锁死契约**：
   - `apps/crish-desktop/src/styles/style-contract.test.ts:474-503` 存在专门测试用例：
     ```ts
     it('tokens.css 默认档 --button-radius 锁 7px，密度档不得改写', () => {
       expect(lightBlock).toMatch(/--button-radius:\s*7px/);
       expect(button).toContain('--btn-radius: var(--button-radius, 7px)');
       expect(seg).toContain('--seg-outer-radius: var(--button-radius, 7px)');
     });
     ```
   - **隐患暴露**：如果方案 A 强行将 `--button-radius` 改为 `8px` 或 `6px`，该测试用例将 100% 失败！这是典型的“新设计原则与存量守护测试冲突”。
2. **`scale(0.96)` 滥用导致的“重绘与模糊地狱”**：
   - 若直接在包含文本输入框、复杂树节点或带边框容器的组件上无节制挂载 `:active { transform: scale(0.96) }`，在 Chromium/WebView2 渲染引擎下，非 GPU 合成层的缩放会导致字体在缩放瞬态发生亚像素模糊与抗锯齿重算；
   - 若未配置 `will-change: transform` 或未限制在硬件加速叶子节点，高频点击将引发 Layout Trashing。
3. **主题切换时的“整页脏色涂抹（Smear Trap）”**：
   - 当用户在深色/浅色主题之间切换时，全局成百上千个 DOM 节点的 `color`, `background-color`, `border-color` 过渡动画同时启动（通常在 100ms~200ms），会导致中间态呈现出泥浆般的脏灰色。

#### 方案 B 架构对策：物理微触感分层与契约安全演进
- **圆角演进安全路径**：
  保持 `--button-radius: 7px` 兼容定义的同时，将基座网格升级为同心几何变量族：
  ```css
  /* tokens.css */
  --radius-button: 7px; /* 维持 style-contract 契约 */
  --radius-concentric-outer: 8px;
  --radius-concentric-pad: 4px;
  --radius-concentric-inner: calc(var(--radius-concentric-outer) - var(--radius-concentric-pad)); /* 4px */
  ```
  若需彻底升级为 8px，**必须将 `tokens.css` 的值修改与 `style-contract.test.ts:478` 的正则断言同步推进**，严禁留存单边改动。
- **物理微触感白名单控制**：
  触感微缩 `transform: scale(0.96)` **仅限挂载于纯原子交互层**（`Button`, `IconButton`, `SegmentedControl.item`），严禁挂载于大卡片或带滚动条的面板；必须伴随 `transform-origin: center center` 与 `will-change: transform`，并在 `:disabled` 状态显式重置为 `transform: none !important`。
- **零 FOUC / 零涂抹冷热双重门闩（Zero-Smear Latch）**：
  - 冷启动阶段依托 `tokens.css:6-16` 的 `html.preload` 冻结；
  - 热切换主题阶段，在 `themeStore.ts` 切换 class 前瞬时向 `document.documentElement` 注入 `.theme-switching` 类（`*, *::before, *::after { transition: none !important; }`），通过 `requestAnimationFrame` 在下一帧清除，强制物理跳变（Snap），杜绝涂抹。

---

### 3. DIM-03：原子层组件收敛与光学平衡

#### 方案 A 侧重点与盲区
方案 A 计划将 Sidebar、SettingsPanel、TopBar 等业务层存在的 8+ 处原生 `<button>` 与 `<input>` 拔除，全面替换为 `components/ui/Button` 与 `components/ui/Input`，并推行 -2px 图标内边距光学补正。

#### 方案 B 独立审视与潜在隐患（重点）
1. **修改 `<Button>` 导致存量 20+ 单元测试失败的真实风险**：
   - 深入审查 `apps/crish-desktop/src/components/ui/Button/Button.test.tsx`（206 行）：
     - 行 18-22：直接断言 `btn.className.toContain(styles.button)`、`styles.buttonSecondary`、`styles.buttonMd`；
     - 行 21-22：直接断言 `data-size="md"`、`data-variant="secondary"`；
     - 行 86-87：断言 `btn.className.toContain(styles.buttonActive)`、`data-active="true"`；
     - 行 95-98：断言 `styles.buttonLoading`、`btn.querySelector('.${styles.spinner}') !== null`，且**明确断言文案保留（loading 不吞掉 children）**；
     - 行 119-128：断言包裹图标的 `<span>` 必须拥有 `aria-hidden="true"`；
     - 行 188-190：断言 `<IconButton>` 必须拥有 `styles.iconButton`、`data-size`、`data-variant`。
   - 深入审查业务层 70+ 测试用例（如 `ApprovalSection.test.tsx`、`ApprovalAskCard.test.tsx`、`AppErrorBoundary.test.tsx`）：
     - 大量业务单测直接通过 `screen.getByRole('button', { name: 'xxx' })` 查找元素，并依赖原生的 `toBeDisabled()`、`fireEvent.click()`。
   - **重大隐患暴露**：
     - 若方案 A 改变了 `Button` 的变体命名（如将 `secondary` 改为 `default`，将 `plain` 改为 `link`），或者改变了 CSS Module 类名命名约定；
     - 若方案 A 引入了额外的外层 DOM 容器（例如为了做发光动画包裹一个 `<div className="btn-wrapper">`），将直接破坏 `screen.getByRole('button')` 的层级结构；
     - 若方案 A 在加载态时像某些开源组件库那样用 Spinner 替换掉 Children 文案，`Button.test.tsx:98`（`expect(screen.getByText('保存中')).toBeInTheDocument()`）将直接崩溃！
2. **`check:ui-layer` 架构解耦门禁破防隐患**：
   - 审查 `scripts/check-ui-layer.mjs`（127 行）：门禁严格扫描 `apps/crish-desktop/src/components/ui/` 下全部 ts/tsx 文件；
   - 严禁任何来自 `components/(?!ui)`、`src/store/`、`src/hooks/`、`src/api/`、`src/services/` 的引用，违规即 `exit 1`。
   - **隐患暴露**：若在收敛过程中，为了给 Button 注入全局主题配置、国际化文本、Toast 提醒或复杂动效，不小心从外部 `hooks/` 或 `store/` 导入模块，将立即触发 `check:ui-layer` 门禁阻断。

#### 方案 B 架构对策：契约固化式组件封装与光学补正
- **五大不变契约（Inviolable Button Contracts）**：
  1. **DOM 单节点契约**：`<Button>` 根节点必须且只能是原生 `<button>`，严禁添加外层包裹标签；
  2. **Class & Data-Attribute 契约**：严格保留 `styles.button`、`styles.button[Variant]`、`styles.button[Size]`，以及 `data-size`、`data-variant`、`data-active` 属性；
  3. **Loading 文案保全契约**：`loading` 态仅前置插入 `<span className={styles.spinner} aria-hidden="true" />`，`children` 文本节点永远不得卸载；
  4. **Aria 隔离契约**：所有装饰性 Icon 节点自动挂载 `aria-hidden="true"`；
  5. **架构纯度契约**：`Button.tsx` 依赖项仅限 `react` 与自身 CSS Module，100% 独立于业务 Store 与业务 Hooks。
- **-2px 光学平衡的零破坏实现**：
  通过 CSS 逻辑属性而非侵入 TSX 结构来完成光学配平，在 `Button.module.css` 内部优雅解决：
  ```css
  /* 仅当包含图标时，通过 CSS 伪类与相邻选择器自动实现 -2px 光学补正 */
  .button:has(.buttonIcon:first-child) {
    padding-inline-start: calc(var(--btn-px) - 2px);
  }
  .button:has(.buttonIcon:last-child) {
    padding-inline-end: calc(var(--btn-px) - 2px);
  }
  ```

---

### 4. DIM-04：色彩角色、排版节奏与焦点无障碍

#### 方案 A 侧重点与盲区
方案 A 强调“一屏 1 主色”（Primary Solid），动态跳动数据配置 `tabular-nums`，消除粗黑边框，柔化 Focus Ring。

#### 方案 B 独立审视与潜在隐患
1. **极端视口（320px）与 200% 文本缩放下的溢出与截断（WCAG 1.4.4 / 1.4.10）**：
   - 许多业务面板（如 SettingsPanel、WorkflowList、ChatComposer 底部操作栏）大量使用 `white-space: nowrap` 与固定高度容器（`height: 32px`）；
   - 在 320px 超小宽度或 200% 浏览器缩放时，若强制收敛为单一主色填充按钮，长文本按钮（如“导出当前会话全部历史记录”）将直接冲出容器，或者被 `overflow: hidden` 截断且无 Tooltip 提示，违反 `jakub-skills/better-accessibility` 铁律。
2. **柔和焦点环的对比度陷阱（AGENTS.md §13 vs WCAG 2.4.7）**：
   - 仓库规约 `AGENTS.md §13` 规定：“任何情况下焦点/激活态不得使用硬实线；相对基线，灰色加深混入文本色不超过约 10%（例如 `color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)` 为上限量级）”；
   - **隐患暴露**：在极浅背景或高对比度屏幕下，若混入比例过低（如 <3%），焦点环肉眼几乎无法分辨，导致纯键盘操作者（Keyboard-only users）迷失光标位置，无法通过无障碍走查。

#### 方案 B 架构对策：自适应弹性排版与双层焦点环系统
- **动态数字防抖（Tabular Rhythm）**：
  为所有涉及会话计数、Token 消耗、响应耗时、时间戳的文本类名，全局配置：
  ```css
  .metric-value, .tabular-figure, [data-tabular='true'] {
    font-variant-numeric: tabular-nums lining-nums;
    font-feature-settings: 'tnum' 1, 'lnum' 1;
  }
  ```
- **双层光学焦点环（Dual-Layer Focus Ring）**：
  完美兼容 `AGENTS.md §13` 克制要求与 WCAG 2.4.7 可感知要求的终极方案：
  ```css
  /* 采用 1.5px 软灰焦点环 + 0.5px 外层透明过渡，兼顾柔和质感与清晰可辨 */
  :focus-visible {
    outline: none;
    box-shadow:
      0 0 0 1px var(--bg-card),
      0 0 0 2.5px color-mix(in srgb, var(--border-color) 88%, var(--text-primary) 12%);
  }
  ```
- **WCAG 2.5.8 目标尺寸防线（Target Size Guard）**：
  桌面端视觉尺寸允许为 24px（如 `xs` 按钮），但通过 `::after` 隐式扩展点击热区至 32px/40px，且相邻元素热区互不重叠：
  ```css
  .buttonXs::after {
    content: '';
    position: absolute;
    inset: -4px;
    pointer-events: auto;
  }
  ```

---

## 三、各推进维度“负产出硬指标”与“门禁检查点”

遵循主控“先删后改，强制负产出”原则，方案 B 为四大维度设立刚性的负产出配额与门禁拦截线：

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                             四大维度负产出硬指标与门禁检查点总表                                  │
├─────────┬───────────────────────────────┬───────────────────────────────────────────────────────┤
│ 维度编号 │ 强制删除面（负产出硬指标）      │ 自动化门禁检查点（Gate Checkpoints）                  │
├─────────┼───────────────────────────────┼───────────────────────────────────────────────────────┤
│ DIM-01  │ 1. 净删除 tokens.css 350+ 行  │ 1. `npm run check:conflict-markers`（零冲突标记）      │
│         │ 2. 清除 30+ 废弃 Token 别名   │ 2. `npm run check:css-encoding`（UTF-8 编码契约）      │
│         │ 3. 彻底清除 6 档半像素碎步字阶│ 3. `style-contract.test.ts`（双层同源与悬空引用清零）  │
│         │ 4. 裸混色消费点严格 ≤ 25 处   │ 4. `npm run check:store-types`（禁 as any 逃逸）      │
├─────────┼───────────────────────────────┼───────────────────────────────────────────────────────┤
│ DIM-02  │ 1. 清除全部裸 5px/7px 杂乱圆角 │ 1. `style-contract.test.ts`（圆角契约与 999px 棘轮）   │
│         │ 2. 清除 1.5 过冲贝塞尔动画参数 │ 2. `npm run test:coverage -- --project=unit`          │
│         │ 3. 清除全仓无节制 transition:all│ 3. 静态检查：全仓搜 `transition: all` 增量为 0        │
├─────────┼───────────────────────────────┼───────────────────────────────────────────────────────┤
│ DIM-03  │ 1. 拔除 8 处私有裸写 button   │ 1. `npm run check:ui-layer`（UI 原子层零业务依赖违规） │
│         │ 2. 拔除 4 处私有裸写 input    │ 2. `Button.test.tsx` + `IconButton` 单元测试 100% 绿  │
│         │ 3. 清理 200+ 行重复私有 CSS   │ 3. `npm run check:line-counts`（UI 组件 ≤ 500 行）    │
├─────────┼───────────────────────────────┼───────────────────────────────────────────────────────┤
│ DIM-04  │ 1. 清除一屏多 Primary 冲突视觉 │ 1. `a11y-contrast.test.ts`（WCAG AA 对比度契约）      │
│         │ 2. 清除 10 处粗黑焦点边框声明  │ 2. `better-accessibility` 无障碍断言自动化走查        │
│         │ 3. 清除未受保护的纯色彩状态指示│ 3. 静态扫描：全仓 icon-only 按钮 100% 具备 aria-label │
└─────────┴───────────────────────────────┴───────────────────────────────────────────────────────┘
```

---

## 四、极简收敛与 Apple-Level 奢华质感的统一方案

极简（Minimalism）不等于贫瘠（Improverishment）。如何确保在大幅削减代码、收敛 Token 的同时，Crish 依然呈现出顶级 Apple 原生应用的物理操作质感与奢华视效？方案 B 提出五大核心物理感知落地策略：

### 1. 同心几何矩阵（Concentric Precision）
根据 $R_{outer} = R_{inner} + padding$ 原则，外层卡片与内层元素严格同心，消除视觉错位感：
- **卡片/面板容器（Panel）**：$R_{outer} = 12px$, $padding = 4px \implies R_{inner} = 8px$（内嵌按钮/标签完美贴合）；
- **分段控制器（SegmentedControl）**：$R_{outer} = 7px$, $padding = 2px \implies R_{inner} = 5px$；
- **对话框（Dialog）**：$R_{outer} = 16px$, $padding = 8px \implies R_{inner} = 8px$。

### 2. 响应 0 迟滞与实体按压触感（Zero-Latency & Haptic Press）
- **高亮提前**：将交互反馈绑定在 `:active` 与 `pointerdown` 上，绝不等待 `click` 或松手事件；
- **实体微缩**：`:active` 触发 `scale(0.96)`，并伴随 `80ms` 物理压缩响应与 `cubic-bezier(0.2, 0, 0, 1)` 回弹；
- **微光叠加（Subtle Specular Sheen）**：使用纯色叠加层的 `opacity` 变化（`var(--tint-hover): 3.5%`, `var(--tint-active): 6.5%`），而不是直接替换背景色，从而保留底板材质质感。

### 3. 景深磨砂与发丝光捕获（Translucent Materials & Rim Light）
- **景深虚化**：弹窗与浮层统一采用 `backdrop-filter: blur(16px) saturate(180%)`，配合半透明背景色；
- **发丝天光边框（Top Rim Light）**：在卡片与工具栏顶部叠加 `1px` 极弱高光，模拟物理光线打在倒角上的边缘高光反射：
  ```css
  /* 顶部发丝光：模拟光线在材质边缘的物理捕获 */
  border-top: 1px solid color-mix(in srgb, #ffffff 12%, transparent);
  ```

### 4. 临界阻尼与弹簧归一（Critically Damped Motion）
- 根除界面中让人感觉松垮晃动的 `bounce > 0` 动画；
- 常规弹窗展开、菜单呼出、Tab 切换全部归一为 **临界阻尼（Damping Ratio = 1.0, Response = 0.32s）**；
- 只有带手势拖拽（Flick/Throw）释放时，才允许注入带有轻微惯性的物理动画。

### 5. 排版光学对齐与字重协同（Optical Balance & Weight Synergy）
- 图标粗细与文字字重保持绝对物理协同：Regular 400 文本对应 `1.5px` 图标描边，Semibold 600 文本对应 `2.0px` 图标描边；
- 按钮前置图标侧自动缩减 2px 内边距（`-2px Optical Correction`），彻底根除视觉偏心问题。

---

## 五、极端视口与无障碍防御架构（A11y & Extreme Viewport）

### 1. 320px 极端窄屏自适应策略
- **自动折行与降级（Fluid Wrapping）**：
  在顶栏、底部状态栏与聊天卡片操作区，采用 `flex-wrap: wrap` 配合 `gap: 8px`；
  当容器宽度 $< 360px$ 时，次要操作按钮自动折叠至二级 `...` 菜单，保证核心确认/取消操作始终位于视口内；
- **容器查询优先（Container Queries）**：
  组件内部布局断点放弃基于全局 Window 的媒体查询，改用 `@container (max-width: 320px)`，确保无论分栏面板被拖拽得多么狭窄，组件都能自适应重排。

### 2. 200% 页面缩放与动态字体（Dynamic Text Zoom）
- **禁止固定容器高度**：在包裹文本的容器上，严禁使用 `height: 32px`，一律使用 `min-height: 32px` 与 `padding` 撑开，防止 200% 缩放时文字纵向溢出被切头切脚；
- **无单位行高（Unitless Line-Height）**：所有文本排版类名强制采用无单位行高（正文 `1.5`，标题 `1.2`），使行高与字体缩放完美线性联动。

### 3. ARIA APG 键盘交互闭环
- **全流程无需鼠标**：
  - `Escape` 键统一由全局 LayerStackManager 捕获，严格按“最上层 Popover $\to$ 子菜单 $\to$ 模态弹窗”逆序关闭；
  - 复合组件（TabStrip、SegmentedControl、Menu）严格执行 **Roving Tabindex** 规范（激活项 `tabindex="0"`，其余项 `tabindex="-1"`，左右箭头无缝穿梭）；
- **无障碍命名铁律**：
  - 没有任何一个 `<button>` 允许只有图标而没有可读名称。所有 `IconButton` 必须强制传入 `aria-label`；
  - 装饰性图形强制声明 `aria-hidden="true"`，防止屏幕阅读器朗读无意义的 SVG 路径。

---

## 六、工程实施防护与全量验证套件协同

在战役后续实施阶段，任何 Agent 提交代码前必须无条件执行以下立体化验证流程，严禁使用 `--no-verify` 绕过：

### 1. 快层验证（必须 100% 立即跑通）
```bash
npm run typecheck
npm run check:ui-layer
npm run check:line-counts
npm run check:store-types
npm run test:coverage -- --project=unit
```
- **通过判据**：
  - 全仓类型 0 错误；
  - `check:ui-layer` 输出 `[check:ui-layer] 通过：无业务依赖违规`；
  - 行数门禁无新增超标文件；
  - vitest 单元测试覆盖率不低于基线。

### 2. 样式契约与中层集成验证
```bash
npx vitest run apps/crish-desktop/src/styles/style-contract.test.ts
npm run test
```
- **通过判据**：
  - `style-contract.test.ts` 全部测试项 PASS（暗色覆盖、双层同源、棘轮指标不反弹、圆角契约锁死）；
  - `Button.test.tsx` 存量 20+ 单测无一破损。

### 3. 桌面端真实宿主验收（Tauri MCP 4000）
- 依据 `AGENTS.md §15 / §16` 铁律，通过 `127.0.0.1:4000` 调试通道进行桌面真实环境走查；
- 重点检验：
  - 主题明暗切换瞬间是否存在全页脏色涂抹；
  - 按钮按下瞬间 `scale(0.96)` 物理微缩是否存在字体抗锯齿闪烁；
  - 320px 极端窄屏下是否存在水平滚动条或关键按钮遮挡。

---

## 七、结论与主控定夺建议

方案架构 B 不仅是一个设计建议，更是一份**高严密度的工程防御白皮书**。它向主控提供了以下明确裁决建议：

1. **坚持锁步更新，拒绝单边破坏**：对 `tokens.css` 和圆角体系的任何修改，必须与 `style-contract.test.ts` 保持同批次原子更新，绝不给 CI 引入中断窗口；
2. **坚持 DOM 单节点纯粹性**：`<Button>` 与 `<Input>` 的原子改造必须恪守既有 API 与 DOM 契约，让全仓 70+ 业务单测在零感知状态下获得 Apple-level 质感提升；
3. **坚持负产出净收敛**：四大维度必须严格达成清除 350+ 行 CSS、清除 30+ 废弃 Token、拔除 8 处原生裸写按钮的硬指标，实现代码体量与维护负担的真正下沉。
