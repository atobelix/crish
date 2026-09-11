# 05-跨维度全域集成与先删后改实施方案（总集成与迁移详案）

> **战役代号**：`UI-UNIFICATION-REDESIGN`
> **文档性质**：阶段二 跨维度独立详案（方案 05：总集成、全域依赖拓扑与先删后改实施规划）
> **执行依据**：
> - `c:/Software/conex/docs/ui-unification-redesign/00-战役调度总纲与工作区规范.md`（战役调度总纲）
> - `c:/Software/conex/docs/ui-unification-redesign/01-四维度定案与删除面矩阵.md`（四维度基准定案）
> - `c:/Software/conex/docs/ui-unification-redesign/analysis/05-cross-dimension-strategy-a.md`（系统工程与拓扑解耦）
> - `c:/Software/conex/docs/ui-unification-redesign/analysis/06-cross-dimension-strategy-b.md`（工程稳健性与防回归单测防护）
> - `AGENTS.md`（§3 Git 提交纪律、§7 严禁补丁、§7.1 立体验证、§8 反过度设计硬性红线、§11 CI 治理、§13 输入与焦点态、§14 色彩空间）
> - `.agents/LOGIC_PLAN_NO_RETREAT.md`（反退避全文与纯逻辑规划）

---

## 一、方案核心定位与系统工程设计哲学

在 `01-四维度定案与删除面矩阵.md` 确立的主控裁决基调下，本方案作为战役阶段二的**总集成与迁移实施详案**，承担着将 DIM-01（Token 基础设施）、DIM-02（同心几何与物理动效）、DIM-03（原子组件收敛与光学平衡）、DIM-04（色彩角色、排版防抖与焦点 A11y）四大维度有机编织为统一工程实施流水线的使命。

### 1.1 核心执行基调

> **“以策略 B 的稳健契约与单测防护为防线护栏，以策略 A 的系统工程拓扑与严格层级解耦为推进路径，将 Jakub Krehel 的理性极简标准与 Apple 流体物理动效合二为一，坚决履行代码净负产出（Net-Negative LOC ≥ 650 行）与主 Agent 独占原子提交权。”**

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              全域集成与迁移“先删后改”系统工程总览                                      │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│   [Phase 5: 全量门禁立体收口]  FULL_CHECK_COMMANDS / git diff --stat (Net-Negative ≥ 650) / 契约锁定   │
│               ▲                                                                                        │
│               │ 宏观视觉与 A11y 闭环 (A11y & Macro Rhythms)                                            │
│   [Phase 4: 色彩排版与焦点]   DIM-04: 一屏一主色降级 / 16 处 tabular-nums / 3%~6% 柔和焦点环           │
│               ▲                                                                                        │
│               │ 业务私有样式连根拔除 (Consume Atomic & Strip Private CSS)                              │
│   [Phase 3: 业务裸写换装]     DIM-03 (业务面): 拔除 8 Button + 4 Input 裸写 / 净删 360+ 行私有 CSS     │
│               ▲                                                                                        │
│               │ 底座能力完备与物理注入 (Optics & Physics Injection)                                    │
│   [Phase 2: 原子基座重塑]     DIM-02 + DIM-03 (原子面): Button scale(0.96) / -2px 光学补正 / Tabs 1.0 │
│               ▲                                                                                        │
│               │ 单一真源约束与双桥映射 (SSOT & Dual-Bridge Aliases)                                    │
│   [Phase 1: Token 设施收敛]   DIM-01: tokens.css 清除 186 死变量 / 7 档字阶 / 净删 ≥ 250 行            │
│               ▲                                                                                        │
│   [Phase 0: 契约测试准备]     style-contract.test.ts 棘轮固化 / 待删 AST 靶标确定 / 基线验证全绿       │
│                                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 为什么必须是“严格单向拓扑有向无环图（Strict Unidirectional DAG）”？

在系统重构工程中，最致命的失误是**逆向依赖序实施**（例如：在 Token 尚未收敛时提前修改原子组件，或者在原子组件尚未具备光学补正与物理微触感前提前换装业务组件）。这会导致：
1. **垃圾变量继续扩散**：若未先收敛 `tokens.css` 中的 `--button-radius: 7px`，新换装的组件要么继续迁就 7px 垃圾变量，要么在业务代码中硬编码 8px，造成新的架构断层；
2. **业务回潮补丁横生**：若原子 `<Button>` 尚未支持 `-2px` 图标光学补正与纯透明 `variant="ghost"`，业务换装（如 `SidebarNav`）时就会发现图标偏心或悬浮叠色发黑（Double Alpha），被迫在业务 CSS 中再次写入 `.navItem::before { display: none !important; }` 等暴力补丁，彻底违反 `AGENTS.md` §7 铁律；
3. **测试爆破与 CI 中断**：若未在 Phase 0 固化契约和设置双桥重定向，直接删除旧别名会导致 `style-contract.test.ts` 和业务单测立即飘红。

因此，实施流程必须严格遵循：
$$\text{Phase 0 (契约)} \longrightarrow \text{Phase 1 (Token)} \longrightarrow \text{Phase 2 (原子)} \longrightarrow \text{Phase 3 (业务)} \longrightarrow \text{Phase 4 (宏观)} \longrightarrow \text{Phase 5 (收口)}$$

---

## 二、全生命周期六阶段（Phase 0 ~ Phase 5）实施方案详则

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 全周期六阶段推进与代码净变更量化总表                              │
├───────┬───────────────────────────────┬──────────────────────────┬───────────────┬───────────────┤
│ 阶段  │ 核心使命与目标                │ 核心修改文件域           │ 预期代码变更  │ 净变化 (Net)  │
├───────┼───────────────────────────────┼──────────────────────────┼───────────────┼───────────────┤
│ **P0**│ 契约锁定与防回归基线准备      │ style-contract, tests/   │ +80 / -0 行   │ **+80 行**    │
├───────┼───────────────────────────────┼──────────────────────────┼───────────────┼───────────────┤
│ **P1**│ DIM-01 Token 基础设施 SSOT 收敛│ tokens.css, 契约测试     │ +60 / -360 行 │ **-300 行**   │
├───────┼───────────────────────────────┼──────────────────────────┼───────────────┼───────────────┤
│ **P2**│ DIM-02+03 原子基座物理动效重塑│ Button, Input, Tabs, Seg │ +120 / -160 行│ **-40 行**    │
├───────┼───────────────────────────────┼──────────────────────────┼───────────────┼───────────────┤
│ **P3**│ DIM-03 业务裸写拔除与私有清退 │ Sidebar, Settings, Prevw │ +90 / -460 行 │ **-370 行**   │
├───────┼───────────────────────────────┼──────────────────────────┼───────────────┼───────────────┤
│ **P4**│ DIM-04 色彩角色、防抖与 A11y  │ Diff, Tasks, 16 处 CSS   │ +70 / -180 行 │ **-110 行**   │
├───────┼───────────────────────────────┼──────────────────────────┼───────────────┼───────────────┤
│ **P5**│ 全量门禁立体收口与双桥拔除    │ tokens.css, 最终契约     │ +0 / -50 行   │ **-50 行**    │
├───────┴───────────────────────────────┴──────────────────────────┴───────────────┼───────────────┤
│ **全战役综合代码净变动核算（Net-Negative LOC）**                                 │ **-790 行**   │
│ **战役硬性门槛断言（Net-Negative LOC ≥ 650 行）**                                │ **安全超越！**│
└──────────────────────────────────────────────────────────────────────────────────┴───────────────┘
```

---

### 2.1 Phase 0：契约固化与测试资产准备（Contract Baseline & Readiness）

#### 1. 目标与准入条件
- 确保当前工作区处于干净状态，`npm run check:desktop` 与 `npm run typecheck` 100% 绿灯；
- 建立对 `style-contract.test.ts` 既有 531 行测试断言的基线快照；
- 搭建同心几何与 Apple 物理动效专项单测骨架，为 Phase 1/2/3 提供刚性守护。

#### 2. 详细实施步骤
1. **静态契约与 AST 扫描基准抽取**：
   - 提取 `apps/crish-desktop/src/store/themeStore.ts` 与 `themePersonalization.ts` 中通过 `setProperty` 动态注入的 Token 白名单集合；
   - 锁定 `style-contract.test.ts` 中的 `BARE_MIX_BASELINE = 25` 与 `IMPORTANT_BASELINE = 626` 棘轮门槛；
2. **新增物理动效与同心几何测试套件**：
   - 新建 `apps/crish-desktop/src/components/ui/__tests__/motion-concentric.test.ts`：
     - 断言标准 `<Button>` 包含 `:active { transform: scale(0.96) }` 或相应计算样式契约；
     - 断言 `@media (prefers-reduced-motion: reduce)` 时 `transform: none !important;`；
     - 断言 `Tabs` 弹性贝塞尔不包含 `1.5` 过冲阻尼，必须等于 `cubic-bezier(0.2, 0, 0, 1)`；
     - 断言圆角同心方程式：$R_{outer} - R_{inner} = Padding$。
3. **运行全量单测基线确认**：
   - 执行 `npm run test`，确保存量所有测试套件通过，记录测试基线。

#### 3. 修改文件域与行数预测
- **文件域**：
  - `[NEW] apps/crish-desktop/src/components/ui/__tests__/motion-concentric.test.ts`
  - `[MODIFY] apps/crish-desktop/src/styles/style-contract.test.ts`
- **预期代码行数变化**：
  - 新增：+80 行（测试用例与断言骨架）
  - 删除：0 行
  - 净变化：**+80 行**

---

### 2.2 Phase 1：DIM-01 Token 基础设施 SSOT 收敛（Tokens Infrastructure Convergence）

#### 1. 目标与准入条件
- 准入条件：Phase 0 契约与单测基线就绪；
- 核心目标：
  - 彻底清除 `tokens.css` 中 186 个外部零引用死变量与废弃兼容别名（净消减 ≥ 250 行）；
  - 确立标准 7 档字阶（11, 12, 13, 14, 16, 18, 22px），消除半像素碎步；
  - 落地 Phase 1 双桥别名重定向，杜绝业务层悬空调用；
  - 同步锁定品牌单一真源 `--brand` 与 4px 模数同心几何圆角网格。

#### 2. 详细实施步骤
1. **死变量与废弃特定业务系统清除**：
   - 清除极简思考链与错误横幅死变量（38 变量 · 76 行）：彻底移除 Light（`tokens.css:703-741`）与 Dark（`tokens.css:1364-1403`）中的 `--thought-*` 与 `--banner-error-*`；
   - 清除 Legacy Diff 兼容映射（21 变量 · 42 行）：彻底移除 `--diff-line-add-*`、`--diff-gutter-add-*`、`--diff-sidebar-width-*`；
   - 清除 SmartExpandablePanel (SEP) 脚手架遗留（12 变量 · 24 行）：移除 `--sep-font-size-*`、`--sep-bg-canvas`、`--sep-ease-*`；
   - 清除 AI 步骤卡片、Artifacts 与未消费排版扩展（21 变量 · 42 行）：移除 `--aicard-*`、`--artifact-*`、`--md-table-*` 死变量；
   - 收敛危险色 4 源分裂：清除 `--danger-color`、`--accent-danger`，全局统一收敛至 `--color-error` 与 `--text-danger`；
   - 清除测试专用伪活变量：移除 `--ui-text-success`, `--ui-text-danger`, `--ui-text-muted`, `--ui-text-info`, `--ui-text-warning`，测试集迁移至真实语义 Token。
2. **7 档标准字阶确立与双桥重定向部署**：
   - 在 `tokens.css` 声明标准 7 档字阶定义：
     ```css
     --font-size-xxs: 11px;  /* 辅助微标、Kbd */
     --font-size-xs: 12px;   /* 标签、次级元数据 */
     --font-size-sm: 13px;   /* 紧凑正文、列表条目 */
     --font-size-base: 14px; /* 标准正文、输入框交互 */
     --font-size-md: 16px;   /* 突出标题、对话框次标 */
     --font-size-lg: 18px;   /* 章节主标题、面板顶标 */
     --font-size-xl: 22px;   /* 页面总标题、空状态标 */
     ```
   - 在 `tokens.css` 注入 Phase 1 碎步别名双桥重定向（向后兼容）：
     ```css
     /* Phase 1 临时双桥别名重定向（在 Phase 5 拔除） */
     --font-size-nano: var(--font-size-xxs);
     --font-size-micro: var(--font-size-xxs);
     --font-size-xs-plus: var(--font-size-sm);
     --font-size-sm-plus: var(--font-size-base);
     --font-size-chat: var(--font-size-base);
     --font-size-xxl: var(--font-size-lg);
     --font-size-2xl: var(--font-size-xl);
     ```
   - 同步修正 `[data-ui-size='small']` 与 `[data-ui-size='large']` 的响应式缩放映射，消除断层。
3. **同心几何标尺基础定义与契约安全演进**：
   - 注入同心几何基座变量：
     ```css
     --radius-xs: 2px;
     --radius-sm: 4px;
     --radius-md: 6px;
     --radius-lg: 8px;
     --radius-xl: 12px;
     --radius-2xl: 16px;
     --radius-full: 9999px;
     ```
   - 依据策略 B 建议，保持 `--button-radius: 8px` 的平稳升级，并在同一原子提交中同步更新 `style-contract.test.ts:474-503`，将硬编码 7px 断言更新为 8px/6px 同心契约。

#### 3. 修改文件域与行数预测
- **文件域**：
  - `[MODIFY] apps/crish-desktop/src/styles/tokens.css`
  - `[MODIFY] apps/crish-desktop/src/styles/style-contract.test.ts`
  - `[MODIFY] apps/crish-desktop/src/styles/a11y-contrast.test.ts`
- **预期代码行数变化**：
  - 新增：+60 行（标准字阶与同心 Token）
  - 删除：-360 行（186 死变量与冗余别名）
  - 净变化：**-300 行**（严格达成 `tokens.css` 净消减 ≥ 250 行目标）

---

### 2.3 Phase 2：DIM-02 + DIM-03 原子基座与物理动效重塑（Atomic Physics & Optics Refactoring）

#### 1. 目标与准入条件
- 准入条件：Phase 1 Token 基础设施收敛就绪，`style-contract.test.ts` 全绿；
- 核心目标：
  - 重塑 `<Button>`：同心圆角（sm: 4px, md: 6px, lg: 8px）、注入 Apple `:active { transform: scale(0.96) }` 物理微缩触感、注入 `-2px` 图标侧光学配平、内置 WCAG 2.5.8 40×40px 透明点击热区、增加 `variant="ghost"` 透明层与 Double Alpha 隔离；
  - 严格保持 `<Button>` DOM 原生单节点结构与全量 Props 契约不变；
  - 重塑 `<Input>`：同心圆角、内置搜索放大镜与清空操作、继承 IME 输入法合成状态机锁；
  - 重塑 `<Tabs>` 与 `<SegmentedControl>`：阻尼比归一至 1.0（`cubic-bezier(0.2, 0, 0, 1)`），根除 1.5 过冲抖动，落地 $R_{out} = R_{in} + P$；
  - 注入主题切换瞬态门闩运行时（Zero-Smear Latch）。

#### 2. 详细实施步骤
1. **`<Button>` 原子组件重塑与契约守护**：
   - 修改 `apps/crish-desktop/src/components/ui/Button/Button.module.css`：
     - 圆角升级：移除 `--button-radius: 7px`，改为 `var(--radius-md, 6px)`（标准）与 `var(--radius-sm, 4px)`（紧凑）；
     - Apple 物理微缩触感与硬件加速：
       ```css
       .button {
         transform-origin: center center;
         will-change: transform;
         transition: transform 80ms ease-out, background-color 100ms ease-out, border-color 100ms ease-out;
       }
       .button:active:not(:disabled):not([data-static='true']) {
         transform: scale(0.96);
         transition: transform 140ms cubic-bezier(0.16, 1, 0.3, 1);
       }
       @media (prefers-reduced-motion: reduce) {
         .button {
           transition: none !important;
         }
         .button:active:not(:disabled) {
           transform: none !important;
         }
       }
       ```
     - `-2px` 图标侧光学补偿（利用 CSS 伪类与相邻选择器，零侵入 TSX）：
       ```css
       .button:has(.buttonIcon:first-child) {
         padding-inline-start: calc(var(--btn-px) - 2px);
       }
       .button:has(.buttonIcon:last-child) {
         padding-inline-end: calc(var(--btn-px) - 2px);
       }
       ```
     - WCAG 2.5.8 40×40px 透明点击热区扩展：
       ```css
       .buttonXs::after,
       .buttonSm::after {
         content: '';
         position: absolute;
         inset: -4px -2px;
         pointer-events: auto;
       }
       ```
     - 增加 `variant="ghost"` 纯透明层与独立覆盖变量 `--btn-hover-overlay`，解决侧栏暖灰色底叠色（Double Alpha）；
   - 保持 `Button.tsx` 严格不变：
     - 根节点保持原生 `<button>`，严禁添加任何包裹标签；
     - 维持 `styles.buttonSecondary`、`data-size`、`data-variant`、`data-active` 属性无损；
     - 保持 loading 状态下 `children` 不被销毁；
     - 扩展支持 `static?: boolean`（高频拖拽等逃逸场景）。
2. **`<Input>` 原子组件同心圆角与 IME 状态机加固**：
   - 修改 `apps/crish-desktop/src/components/ui/Input/Input.module.css`：收敛至同心圆角 4px/6px/8px；
   - 确保 `Input.tsx` 的 `isComposingRef` 正确处理拼音选词回车，内置 `onEnter` 安全回调。
3. **`<Tabs>` 与 `<SegmentedControl>` 临界阻尼与几何配平**：
   - 修改 `apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css`：
     - 拔除 1.5 贝塞尔：将 `--tab-spring-bezier: cubic-bezier(0.175, 0.885, 0.32, 1.5)` 替换为临界阻尼 `cubic-bezier(0.2, 0, 0, 1)`；
     - 拔除 3.5px / 6.5px 亚像素，落实外壳 8px + 内边距 2px = 滑块 6px；
     - 同步更新 `Tabs.test.tsx:314, 328` 测试断言；
   - 修改 `SegmentedControl.module.css`：拔除 7px/5px，落实同心标尺（外壳 6px，内边距 2px，滑块 4px）。
4. **主题瞬态门闩协议（Zero-Smear Latch）**：
   - 修改 `apps/crish-desktop/src/store/themeStore.ts`：
     - 封装 `withThemeTransitionFreeze(fn)`：在更新 `data-theme` 前向 `document.documentElement` 注入 `.theme-switching` 类；
     - 在 `tokens.css` 声明 `.theme-switching, .theme-switching * { transition: none !important; }`；
     - 强制 `document.documentElement.offsetHeight` 触发同步回流，双重 `requestAnimationFrame` 后移除门闩，实现 0ms 瞬间跳变，彻底终结 150ms 脏色涂抹。

#### 3. 修改文件域与行数预测
- **文件域**：
  - `[MODIFY] apps/crish-desktop/src/components/ui/Button/Button.tsx`
  - `[MODIFY] apps/crish-desktop/src/components/ui/Button/Button.module.css`
  - `[MODIFY] apps/crish-desktop/src/components/ui/Input/Input.module.css`
  - `[MODIFY] apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css`
  - `[MODIFY] apps/crish-desktop/src/components/ui/Tabs/Tabs.test.tsx`
  - `[MODIFY] apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css`
  - `[MODIFY] apps/crish-desktop/src/store/themeStore.ts`
- **预期代码行数变化**：
  - 新增：+120 行（物理微触感、光学补正、热区扩展、主题门闩）
  - 删除：-160 行（7px 硬编码、1.5 过冲贝塞尔、旧 Tabs/SegmentedControl 亚像素覆盖）
  - 净变化：**-40 行**

---

### 2.4 Phase 3：DIM-03 业务层裸写拔除与原子换装（Business Shell Unification & CSS Stripping）

#### 1. 目标与准入条件
- 准入条件：Phase 2 原子组件重塑完成，`Button.test.tsx`、`Tabs.test.tsx`、`scripts/check-ui-layer.mjs` 门禁全绿；
- 核心目标：
  - 彻底拔除业务层 8 处裸写 Button + 4 处裸写 Input，统一换装为 `components/ui/` 原子组件；
  - 彻底连根删除配套的私有 CSS 类声明（净消减私有 CSS ≥ 360 行）；
  - 根除 `SettingsSidebar.tsx` 跨层反向 `import navStyles` 架构违规；
  - 严格保持既有 `data-testid`、事件监听与业务行为 100% 稳定。

#### 2. 详细实施步骤与替换映射表
依据 `01-四维度定案与删除面矩阵.md` 与分析报告，逐一实施换装与 CSS 剥离：

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 Phase 3 业务裸写拔除与私有 CSS 连根清除清单                             │
├───────────────────────────────┬────────────────────────────┬─────────────────────────────┬──────────────┤
│ 业务组件路径                  │ 原生裸写与类名             │ 换装原子组件方案            │ 净删除私有CSS│
├───────────────────────────────┼────────────────────────────┼─────────────────────────────┼──────────────┤
│ `components/sidebar/`         │ 2 处原生 `<button>`        │ `<IconButton`               │ **-34 行**   │
│ `SidebarHeader.tsx:47,94`     │ `.sidebarToggleBtn`        │ `variant="ghost" size="sm"` │              │
│                               │                            │ `aria-label="折叠侧边栏" />` │              │
├───────────────────────────────┼────────────────────────────┼─────────────────────────────┼──────────────┤
│ `components/sidebar/`         │ 2 处原生 `<button>`        │ `<Button`                   │ **-58 行**   │
│ `SidebarNav.tsx:24,47`        │ `.navItem, .navItemActive` │ `variant="ghost"`           │              │
│                               │                            │ `active={...} />`           │              │
├───────────────────────────────┼────────────────────────────┼─────────────────────────────┼──────────────┤
│ `components/sidebar/`         │ 1 处原生 `<input search>`  │ `<Input`                    │ **-36 行**   │
│ `SidebarNav.tsx:64`           │ `.navItem input`           │ `variant="search" size="sm"`│              │
│                               │                            │ `onEnter={...} />`          │              │
├───────────────────────────────┼────────────────────────────┼─────────────────────────────┼──────────────┤
│ `components/sidebar/`         │ 1 处原生 `<button>`        │ `<IconButton`               │ **-33 行**   │
│ `SidebarFooter.tsx:27`        │ `.settingsGearBtn`         │ `variant="ghost" size="sm"` │              │
│                               │                            │ `aria-label="偏好设置" />`  │              │
├───────────────────────────────┼────────────────────────────┼─────────────────────────────┼──────────────┤
│ `components/sidebar/`         │ 1 处原生 `<button>`        │ `<Button variant="ghost"`   │ **-42 行**   │
│ `UserProfileCard.tsx:31`      │ `.cardTrigger`             │ `className={...} />`        │              │
├───────────────────────────────┼────────────────────────────┼─────────────────────────────┼──────────────┤
│ `components/settings/`        │ 1 处原生 `<input search>`  │ `<Input`                    │ **-44 行**   │
│ `SettingsPanel.tsx`           │ `.searchWrap, .search`     │ `variant="search" size="sm"`│              │
├───────────────────────────────┼────────────────────────────┼─────────────────────────────┼──────────────┤
│ `components/settings/`        │ 1 处原生 `<button>`        │ `<Button`                   │ **-48 行**   │
│ `SettingsSidebar.tsx:149`     │ `.sidebarTab`              │ `variant="ghost"`           │              │
├───────────────────────────────┼────────────────────────────┼─────────────────────────────┼──────────────┤
│ `components/settings/`        │ 1 处原生 `<input search>`  │ `<Input variant="search"`   │ **-35 行**   │
│ `SettingsSidebar.tsx:103`     │ 跨层反向 `import navStyles`│ `size="sm" />` (彻底拔除逆引)│              │
├───────────────────────────────┼────────────────────────────┼─────────────────────────────┼──────────────┤
│ `components/preview/`         │ 1 处原生 `<input url>`     │ `<Input`                    │ **-38 行**   │
│ `PreviewToolbar.tsx:163`      │ `.urlInput`                │ `size="sm" />`              │              │
├───────────────────────────────┼────────────────────────────┼─────────────────────────────┼──────────────┤
│ `components/diff/`            │ 原生 `<button>` 暴力覆盖   │ `<Button variant="ghost"`   │ **-42 行**   │
│ `DiffCard.module.css:430-456` │ `.inlineActionBtn`         │ `size="xs" />`              │              │
├───────────────────────────────┼────────────────────────────┼─────────────────────────────┼──────────────┤
│ `components/settings/`        │ 深度穿透选择器覆盖         │ 清理深度穿透样式            │ **-28 行**   │
│ `SettingsUI.module.css`       │ `.filterInput :global(...)`│ 改由 Input 内部标准控制     │              │
├───────────────────────────────┴────────────────────────────┴─────────────────────────────┼──────────────┤
│ **业务私有 CSS 净消减小计**                                                              │ **≥ -390 行**│
└──────────────────────────────────────────────────────────────────────────────────────────┴──────────────┘
```

#### 3. 稳健工程与架构解耦执行细节
- **测试选择器 100% 保持**：透传 `data-testid="sidebar-toggle"` 等属性，保证业务 70+ 单测无缝绿灯；
- **反向依赖彻底清零**：删除 `SettingsSidebar.tsx` 中 `import navStyles from '@/components/sidebar/SidebarNav.module.css'`，符合 `scripts/check-ui-layer.mjs` 分层红线；
- **清理私有 CSS 文件**：在 `Sidebar.module.css`、`SidebarNav.module.css`、`SettingsPanel.module.css`、`SettingsUI.module.css`、`PreviewToolbar.module.css` 中直接删除对应类声明，严禁留存死代码。

#### 4. 修改文件域与行数预测
- **文件域**：
  - `[MODIFY] apps/crish-desktop/src/components/sidebar/SidebarHeader.tsx`
  - `[MODIFY] apps/crish-desktop/src/components/sidebar/SidebarNav.tsx`
  - `[MODIFY] apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx`
  - `[MODIFY] apps/crish-desktop/src/components/sidebar/UserProfileCard.tsx`
  - `[MODIFY] apps/crish-desktop/src/components/sidebar/Sidebar.module.css`
  - `[MODIFY] apps/crish-desktop/src/components/sidebar/SidebarNav.module.css`
  - `[MODIFY] apps/crish-desktop/src/components/settings/SettingsPanel.tsx`
  - `[MODIFY] apps/crish-desktop/src/components/settings/SettingsSidebar.tsx`
  - `[MODIFY] apps/crish-desktop/src/components/settings/SettingsPanel.module.css`
  - `[MODIFY] apps/crish-desktop/src/components/settings/SettingsUI.module.css`
  - `[MODIFY] apps/crish-desktop/src/components/preview/PreviewToolbar.tsx`
  - `[MODIFY] apps/crish-desktop/src/components/preview/PreviewToolbar.module.css`
  - `[MODIFY] apps/crish-desktop/src/components/diff/DiffCard.module.css`
- **预期代码行数变化**：
  - 新增：+90 行（引入 `<Button>`、`<IconButton>`、`<Input>` 调用及属性）
  - 删除：-460 行（删除 12 处原生 HTML 裸写结构与对应私有 CSS 类）
  - 净变化：**-370 行**（达成净消减 ≥ 360 行目标）

---

### 2.5 Phase 4：DIM-04 色彩角色、排版防抖与焦点 A11y（Macro Convergence & A11y Guardrails）

#### 1. 目标与准入条件
- 准入条件：Phase 3 业务换装完成，业务私有 CSS 清除就绪；
- 核心目标：
  - 一屏一主色治理（Fill exactly one action per view）：降级批量操作与条目次级 Primary 按钮，拔除 `#111111` 纯黑按钮；
  - 动态跳动数字防抖：在 16 处数值高频跳动场景注入 `font-variant-numeric: tabular-nums`；
  - 克制浅灰焦点环：落地 3%~6% 混入微环，清除 15%~20% 粗黑实心边框与 `outline: none` 盲区；
  - WCAG 2.5.8 与 Accessible Name 闭环：21 处纯图标按钮补齐 `aria-label`。

#### 2. 详细实施步骤
1. **一屏一主色降级与纯黑按钮拔除**：
   - 降级 `DiffCardFileList.tsx:295`：文件条目操作按钮由 `variant="primary"` 改为 `variant="ghost"`；
   - 降级 `ActiveTasksSection.tsx:84`：待处理列表中的循环“允许”按钮降级为 `variant="secondary"`，仅在顶部提供唯一全局“全部允许” Primary 按钮；
   - 拔除 `ModernApprovalCard.tsx:49` 与 `ModernToolCall.module.css:507` 中的 `#111111` 纯黑按钮，统一回归品牌翡翠绿 `--brand`；
   - 删除 `DiffCard.module.css:430-456` 的暴力 `background: transparent` 覆盖补丁。
2. **全景 16 处跳动数值注入 `tabular-nums` 防抖**：
   在以下 16 处高频更新的 CSS 类名中注入 `font-variant-numeric: tabular-nums; font-feature-settings: 'tnum' 1;`：
   1. `PriceConfigModal.module.css:34, 72`（模型单价）
   2. `SidebarSessionList.module.css:450`（会话时间戳）
   3. `SubagentHeaderPanel.module.css:60`（子代理运行计数）
   4. `DiffCard.module.css:286`（差异行数统计 `+128 -42`）
   5. `ChatToolCallBlock.module.css:245`（工具执行差异行）
   6. `ScanResultsModal.module.css:135`（模型统计数）
   7. `YamlConfigEditorModal.module.css:144, 172`（编辑器行数与行号）
   8. `ModelsSettingsTab.module.css:460`（网络延迟徽标 `42ms`）
   9. `ChatQueuePanel.module.css:25`（排队序号）
   10. `TerminalCard.module.css:109, 365`（终端行数与匹配数）
   11. `SkillsSettingsTab.module.css:21, 197`（技能统计）
   12. `ScheduledTasksPanel.module.css:50`（定时任务计数）
   13. `Badge.module.css:6`（原子角标基础类）
   14. `Tabs.module.css:257`（标签页角标）
   15. `UsageTrendChart.module.css:153`（24 小时时间刻度）
   16. `FlowScrubber.module.css`（滚动刻度气泡）
3. **柔和焦点环（3%~6% 混入）全面收敛**：
   - 在 `tokens.css` 统一声明：
     ```css
     --focus-ring-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
     --focus-ring-shadow: 0 0 0 1.5px var(--focus-ring-color);
     ```
   - 清除业务模块中散落的 `box-shadow: 0 0 0 2px black` 与粗黑硬实线；
   - 清除全站 10 处 `outline: none` 无视觉替代的隐患。
4. **Accessible Name 与 ARIA 补全**：
   - 为 21 处纯图标按钮补齐明确 `aria-label`；
   - 装饰性图标统一挂载 `aria-hidden="true"`。

#### 3. 修改文件域与行数预测
- **文件域**：
  - `[MODIFY] apps/crish-desktop/src/components/diff/DiffCardFileList.tsx`
  - `[MODIFY] apps/crish-desktop/src/components/tasks/ActiveTasksSection.tsx`
  - `[MODIFY] apps/crish-desktop/src/components/approval/ModernApprovalCard.tsx`
  - `[MODIFY] apps/crish-desktop/src/components/tools/ModernToolCall.module.css`
  - `[MODIFY] apps/crish-desktop/src/styles/tokens.css`
  - `[MODIFY] 上述 16 处跳动数值对应的 CSS 模块文件`
- **预期代码行数变化**：
  - 新增：+70 行（tabular-nums 与 focus-ring 属性声明、aria-label 注入）
  - 删除：-180 行（纯黑按钮、暴力覆盖 CSS、重复 outline:none 声明）
  - 净变化：**-110 行**

---

### 2.6 Phase 5：全量立体门禁验证、双桥拔除与收口（Validation & Lock）

#### 1. 目标与准入条件
- 准入条件：Phase 0 ~ Phase 4 全部变更就绪；
- 核心目标：
  - 拔除 Phase 1 设置的碎步字阶双桥重定向别名，使废弃别名彻底清零；
  - 运行全量立体门禁套件，实现零编译错误、零测试破损、零架构违规；
  - 执行 `git diff --stat` 自动化断言：验证全战役 Net-Negative LOC ≥ 650 行。

#### 2. 详细实施步骤
1. **双桥重定向别名拔除**：
   - 检查全仓代码，确认无任何业务代码再消费 `--font-size-nano`、`--font-size-micro`、`--font-size-xs-plus`、`--font-size-sm-plus`、`--font-size-chat`、`--font-size-xxl`；
   - 从 `tokens.css` 中正式拔除这 7 个双桥临时别名（净减 50 行）；
   - 同步更新 `style-contract.test.ts`，锁定标准 7 档字阶白名单。
2. **全量立体门禁流水线执行**：
   - 依 `AGENTS.md §7.1` 与 `FULL_CHECK_COMMANDS.md` 执行立体化验证：
     ```bash
     # 1. 静态语法与解耦门禁
     npm run typecheck
     npm run check:ui-layer
     npm run check:line-counts
     npm run check:store-types
     npm run check:conflict-markers
     npm run check:css-encoding

     # 2. 样式契约与覆盖率
     npx vitest run apps/crish-desktop/src/styles/style-contract.test.ts
     npm run test:coverage -- --project=unit

     # 3. 中层与全量 Vitest 集成测试
     npm run test
     npx vitest run --config vitest.integration.config.ts
     ```
3. **全仓净负产出自动化断言**：
   - 运行净负产出断言脚本，校验 `deletions - insertions >= 650`。

#### 3. 修改文件域与行数预测
- **文件域**：
  - `[MODIFY] apps/crish-desktop/src/styles/tokens.css`
  - `[MODIFY] apps/crish-desktop/src/styles/style-contract.test.ts`
- **预期代码行数变化**：
  - 新增：+0 行
  - 删除：-50 行（拔除双桥重定向别名）
  - 净变化：**-50 行**

---

## 三、Git 原子提交批次规划（Strict Main Agent Exclusive Commits）

根据 `AGENTS.md` §3 **“多 Agent Git 提交纪律（2026-08-13 用户裁决）”**：
1. **提交权仅归主 Agent**：子 Agent 完成任务后把改动留在工作区，由主 Agent 验证无问题后统一提交；子 Agent 一律不许提交、不许回撤、不许 `reset --hard` / `checkout .` / `restore`；
2. **限定路径提交**：主控提交时统一使用 **`git commit --only <paths...>` 限定本次收口文件路径**，避免误提交他人 staged 或未完成的工作区文件；
3. **绝对禁止 `--no-verify`**：任何提交必须跑通 pre-commit 钩子。

为保证工程历史清晰可回溯，全战役划分为 6 个高内聚原子提交批次：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   Git 原子提交批次规划表 (BATCH-00 ~ 05)                               │
├──────────┬─────────────────────────────────────────────────┬───────────────────────────────────────────┤
│ 批次号   │ 提交信息规范 (Git Commit Message)               │ 独占提交路径域 (git commit --only <paths>) │
├──────────┼─────────────────────────────────────────────────┼───────────────────────────────────────────┤
│ BATCH-00 │ `test(ui-unification): BATCH-00 契约测试与防回  │ `apps/crish-desktop/src/styles/`          │
│          │ 归基线固化`                                     │ `style-contract.test.ts`                  │
│          │                                                 │ `apps/crish-desktop/src/components/ui/`   │
│          │                                                 │ `__tests__/motion-concentric.test.ts`     │
├──────────┼─────────────────────────────────────────────────┼───────────────────────────────────────────┤
│ BATCH-01 │ `refactor(tokens): BATCH-01 DIM-01 清除死变量与 │ `apps/crish-desktop/src/styles/tokens.css`│
│          │ 收敛标准字阶 (Net-Negative -300L)`              │ `apps/crish-desktop/src/styles/`          │
│          │                                                 │ `style-contract.test.ts`                  │
│          │                                                 │ `apps/crish-desktop/src/styles/`          │
│          │                                                 │ `a11y-contrast.test.ts`                   │
├──────────┼─────────────────────────────────────────────────┼───────────────────────────────────────────┤
│ BATCH-02 │ `feat(ui-base): BATCH-02 DIM-02+03 原子基座物理 │ `apps/crish-desktop/src/components/ui/`   │
│          │ 动效与光学平衡 (Net-Negative -40L)`             │ `Button/*` `Input/*` `Tabs/*`             │
│          │                                                 │ `SegmentedControl/*`                      │
│          │                                                 │ `apps/crish-desktop/src/store/`           │
│          │                                                 │ `themeStore.ts`                           │
├──────────┼─────────────────────────────────────────────────┼───────────────────────────────────────────┤
│ BATCH-03 │ `refactor(shell): BATCH-03 DIM-03 业务层裸写拔  │ `apps/crish-desktop/src/components/`      │
│          │ 除与私有样式清退 (Net-Negative -370L)`          │ `sidebar/*` `settings/*` `preview/*`      │
│          │                                                 │ `diff/DiffCard.module.css`                │
├──────────┼─────────────────────────────────────────────────┼───────────────────────────────────────────┤
│ BATCH-04 │ `feat(a11y-visual): BATCH-04 DIM-04 一屏一主色  │ `apps/crish-desktop/src/components/`      │
│          │ 降级、排版防抖与焦点无障碍 (Net-Negative -110L)`│ `diff/DiffCardFileList.tsx`               │
│          │                                                 │ `tasks/ActiveTasksSection.tsx`            │
│          │                                                 │ `approval/ModernApprovalCard.tsx`         │
│          │                                                 │ `tools/ModernToolCall.module.css`         │
│          │                                                 │ 16 处跳动数值 CSS 模块                    │
├──────────┼─────────────────────────────────────────────────┼───────────────────────────────────────────┤
│ BATCH-05 │ `chore(ratchet): BATCH-05 双桥别名拔除、全量立  │ `apps/crish-desktop/src/styles/tokens.css`│
│          │ 体收口与净负产出硬性断言 (Net-Negative -50L)`   │ `apps/crish-desktop/src/styles/`          │
│          │                                                 │ `style-contract.test.ts`                  │
│          │                                                 │ `scripts/verify-net-negative-loc.mjs`     │
└──────────┴─────────────────────────────────────────────────┴───────────────────────────────────────────┘
```

---

## 四、全仓代码净负产出（Net-Negative LOC ≥ 650 行）核验机制

### 4.1 净负产出数学模型与配额分解

为确保重构杜绝“新写 1000 行、仅删 200 行”的伪重构回潮，全仓设立严格的净负产出断言公式：
$$\Delta \text{LOC} = \sum \text{Added Lines} - \sum \text{Deleted Lines} \le -650$$

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                全仓净负产出逐模块配额追踪与核验矩阵                              │
├───────────────────────┬──────────────────────┬─────────────┬─────────────┬───────────────────────┤
│ 模块 / 文件域         │ 改造主要内容         │ 预期新增 (+) │ 预期删除 (-) │ 净贡献 ($\Delta$ LOC) │
├───────────────────────┼──────────────────────┼─────────────┼─────────────┼───────────────────────┤
│ `tokens.css`          │ 清除 186 死变量/双桥 │ +60 行      │ -410 行     │ **-350 行**           │
├───────────────────────┼──────────────────────┼─────────────┼─────────────┼───────────────────────┤
│ `Sidebar` 系列组件    │ 拔除 5 处裸写及样式  │ +35 行      │ -240 行     │ **-205 行**           │
├───────────────────────┼──────────────────────┼─────────────┼─────────────┼───────────────────────┤
│ `Settings` 系列组件   │ 拔除 3 处裸写及样式  │ +30 行      │ -160 行     │ **-130 行**           │
├───────────────────────┼──────────────────────┼─────────────┼─────────────┼───────────────────────┤
│ `PreviewToolbar`      │ 换装标准 Input       │ +10 行      │ -38 行      │ **-28 行**            │
├───────────────────────┼──────────────────────┼─────────────┼─────────────┼───────────────────────┤
│ `DiffCard` / Tools    │ 降级与拔除纯黑/补丁  │ +15 行      │ -77 行      │ **-62 行**            │
├───────────────────────┼──────────────────────┼─────────────┼─────────────┼───────────────────────┤
│ `Tabs` / SegControl   │ 拔除 1.5 贝塞尔与圆角│ +20 行      │ -45 行      │ **-25 行**            │
├───────────────────────┼──────────────────────┼─────────────┼─────────────┼───────────────────────┤
│ 契约测试与 A11y 属性  │ 测试骨架与 ARIA 标记 │ +170 行     │ -160 行     │ **+10 行**            │
├───────────────────────┴──────────────────────┴─────────────┴─────────────┼───────────────────────┤
│ **全战役预期总计**                                                       │ **-790 行** (净消减)  │
│ **战役刚性合格门限**                                                     │ **≤ -650 行**         │
│ **安全裕量 (Buffer Margin)**                                             │ **+140 行安全空间**   │
└──────────────────────────────────────────────────────────────────────────┴───────────────────────┘
```

### 4.2 自动化核验断言脚本实现

在 `scripts/verify-net-negative-loc.mjs` 实现净负产出自动化门禁，作为 Phase 5 收口时的主控拦截器：

```javascript
/**
 * scripts/verify-net-negative-loc.mjs
 * 战役 UI-UNIFICATION-REDESIGN 净负产出 (Net-Negative LOC) 刚性断言门禁
 */
import { execSync } from 'node:child_process';

const TARGET_NET_NEGATIVE = 650; // 硬性消减门槛 ≥ 650 行
const BASE_REVISION = process.env.BASE_REV || 'HEAD~6'; // 战役起始 commit

try {
  const statOutput = execSync(`git diff --stat ${BASE_REVISION}..HEAD`, { encoding: 'utf-8' });
  const lines = statOutput.trim().split('\n');
  const summaryLine = lines[lines.length - 1];

  // 匹配类似: "25 files changed, 420 insertions(+), 1210 deletions(-)"
  const match = summaryLine.match(/(\d+)\s+insertions?\(\+\),\s+(\d+)\s+deletions?\(-\)/);
  if (!match) {
    console.error('❌ [verify-net-negative] 无法解析 git diff --stat 摘要行:', summaryLine);
    process.exit(1);
  }

  const insertions = parseInt(match[1], 10);
  const deletions = parseInt(match[2], 10);
  const netReduction = deletions - insertions;

  console.log(`📊 [verify-net-negative] 变更统计: 新增 +${insertions} 行, 删除 -${deletions} 行`);
  console.log(`📉 [verify-net-negative] 净消减代码行数: ${netReduction} 行 (硬性目标: ≥ ${TARGET_NET_NEGATIVE} 行)`);

  if (netReduction < TARGET_NET_NEGATIVE) {
    console.error(`❌ [verify-net-negative] 门禁拦截失败！净消减 ${netReduction} 行，未达到要求的 ≥ ${TARGET_NET_NEGATIVE} 行！`);
    console.error(`🚨 请检查是否存在多余冗余代码或未彻底删除的私有样式！`);
    process.exit(1);
  }

  console.log(`✅ [verify-net-negative] 门禁通过！达成净负产出硬性指标！`);
} catch (error) {
  console.error('❌ [verify-net-negative] 执行异常:', error.message);
  process.exit(1);
}
```

---

## 五、异常熔断与自愈机制（Circuit Breaker & Self-Healing）

系统重构过程中严禁凭运气推进。针对可能出现的 5 类典型异常，特制定刚性熔断指标与标准自愈流程：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   异常熔断与自愈机制矩阵 (Circuit Breaker)                              │
├─────────┬──────────────────────┬─────────────────────────────┬─────────────────────────────────────────┤
│ 编号    │ 熔断触发场景         │ 判定依据 / 拦截信号         │ 标准自愈与回退流程                      │
├─────────┼──────────────────────┼─────────────────────────────┼─────────────────────────────────────────┤
│ **CB-01**│ 样式契约崩溃         │ `style-contract.test.ts`    │ 触发双桥回退协议：比对 `themeStore` 动  │
│         │ (Contract Rupture)   │ 报错 `注入但无静态定义`     │ 态注入集合，恢复遗漏静态底座声明。      │
├─────────┼──────────────────────┼─────────────────────────────┼─────────────────────────────────────────┤
│ **CB-02**│ 存量单元测试破损     │ `Button.test.tsx` 存量 20+  │ 立即回滚 TSX DOM 变动；恪守单原生节点   │
│         │ (Test Regression)    │ 单测或业务 70+ 单测失败     │ 契约，改用 CSS `:has` 达成光学补正。    │
├─────────┼──────────────────────┼─────────────────────────────┼─────────────────────────────────────────┤
│ **CB-03**│ 架构反向依赖违规     │ `scripts/check-ui-layer.mjs`│ 移除原子组件外部引用；将业务状态提升至  │
│         │ (Layer Violation)    │ 抛出 `exit 1` 业务依赖违规  │ 上层容器，原子层仅保留纯展示 Props。    │
├─────────┼──────────────────────┼─────────────────────────────┼─────────────────────────────────────────┤
│ **CB-04**│ 共享索引与并行提交   │ 工作区存在他人 Staged 文件  │ 严格执行 `git commit --only <paths>`；  │
│         │ (Index Conflict)     │ 或提交时被并行 Agent 吞并   │ 严禁 `git reset HEAD`，仅验证内容完整性 │
├─────────┼──────────────────────┼─────────────────────────────┼─────────────────────────────────────────┤
│ **CB-05**│ pre-commit 钩子阻塞  │ `.husky/pre-commit` 报      │ 严禁 `--no-verify`！执行最小空白符修复  │
│         │ (Hook Whitespace)    │ `trailing whitespace` 拦截  │ （仅修改违规行尾空格，不碰代码逻辑）。  │
└─────────┴──────────────────────┴─────────────────────────────┴─────────────────────────────────────────┘
```

### 5.1 CB-01：样式契约崩溃自愈流程（双桥回退协议）
1. **现象**：`style-contract.test.ts:352-368` 断言失败，提示某个 Token 被 `themeStore.ts` 动态注入但在 `tokens.css` 无静态声明；
2. **自愈动作**：
   - 提取报错变量名；
   - 在 `tokens.css` 中恢复该变量在 Light 与 Dark 块的基础定义；
   - 将该变量标记为“受保护动态底座 Token”，禁止在后续轮次中删除；
   - 严禁修改测试断言去迎合错误的删除。

### 5.2 CB-02：存量单测破损自愈流程
1. **现象**：`Button.test.tsx` 报错，提示文案找不到或包裹层级改变；
2. **自愈动作**：
   - 检查是否在 `<button>` 外层添加了 `<div>` 或 `<span>`；若是，立即移除；
   - 检查是否在 `loading` 态清除了 `children` 文本；若是，恢复 `children` 节点渲染；
   - 验证 `data-size`、`data-variant` 是否发生语义变更，恢复为既有常量；
   - 严禁修改已有测试用例的预期值来掩盖回归。

### 5.3 CB-03：UI 原子层解耦违规自愈流程
1. **现象**：`npm run check:ui-layer` 报告 `apps/crish-desktop/src/components/ui/` 引入了 `src/store/` 或 `src/hooks/`；
2. **自愈动作**：
   - 立即斩断反向 import；
   - 将业务控制逻辑（如当前是否正在播放动画、当前用户权限）以 Props 形式（如 `static?: boolean`、`disabled?: boolean`）由外层传入；
   - 保持原子组件的 100% 纯粹性。

### 5.4 CB-04：Git 共享 index 污染自愈流程
1. **现象**：主 Agent 执行提交时，发现 `git status` 中包含其他并行 Agent 暂存的文件；
2. **自愈动作**：
   - 遵循 `AGENTS.md` §3 第 3 条：**绝对不要执行 `git reset HEAD --` 试图清空他人索引**；
   - 提交时无条件使用 `git commit --only <paths...>` 显式指定本次批次的收口文件；
   - 若本地修改已被其他 Agent 提前提交（被吞并），遵循第 4 条：通过 `git show HEAD:<path>` 核对工作区完整性，内容完整则直接放行，内容缺失则通过新批次追加。

### 5.5 CB-05：pre-commit 钩子空白符阻塞自愈流程
1. **现象**：`git diff --check` 检测到全工作区（包括未暂存或他人文件）存在 trailing whitespace；
2. **自愈动作**：
   - 遵循 `AGENTS.md` §3 第 5 条与 §7 铁律：**严禁使用 `--no-verify` 跳过门禁**；
   - 定位报出 trailing whitespace 的行号，对该行执行最小精确修改（剥离行尾空格），恢复提交合规状态。

---

## 六、全生命周期执行与产出验收清单（Checklist）

在主控 Agent 推进本方案实施时，必须对照下述清单逐项打钩闭环：

### 阶段执行闭环清单
- [ ] **Phase 0 就绪**：`style-contract.test.ts` 契约快照完成，`motion-concentric.test.ts` 骨架创建，当前 CI 100% 全绿；
- [ ] **Phase 1 收敛**：`tokens.css` 清除 186 死变量，标准 7 档字阶确立，双桥重定向部署，`tokens.css` 净消减 ≥ 250 行，`BATCH-01` 独占提交；
- [ ] **Phase 2 重塑**：`<Button>` scale(0.96) 触感与 -2px 光学补正就绪，DOM 单节点未破坏，Tabs 归一 1.0 阻尼，主题门闩就绪，`BATCH-02` 独占提交；
- [ ] **Phase 3 换装**：Sidebar / Settings / Preview 8 处 Button + 4 处 Input 裸写清零，删除 360+ 行私有 CSS，反向 import 清零，`BATCH-03` 独占提交；
- [ ] **Phase 4 宏观**：Diff / Tasks 一屏一主色降级完成，16 处 `tabular-nums` 注入防抖，3%~6% 柔和焦点环落地，`BATCH-04` 独占提交；
- [ ] **Phase 5 收口**：拔除双桥临时别名，运行全量 `FULL_CHECK_COMMANDS` 全绿，`git diff --stat` 自动化断言 Net-Negative LOC ≥ 650 行通过，`BATCH-05` 最终收口。

---

## 七、总结与主控调度交付口径

本实施方案通过严格的**数学拓扑有向无环图编排（Phase 0 ➔ Phase 5）**，完美融合了策略 A 的系统工程收敛性与策略 B 的防回归防护网。它不仅清晰定义了每个阶段的修改文件与行数净变动，而且为可能出现的各类工程隐患构筑了熔断自愈机制，并以主 Agent 独占提交与自动化 LOC 断言为最终保障，确保战役 `UI-UNIFICATION-REDESIGN` 能够以**高雅的架构收敛、卓越的 Apple 物理质感与硬性的代码净负产出（-790 行）**胜利会师！
