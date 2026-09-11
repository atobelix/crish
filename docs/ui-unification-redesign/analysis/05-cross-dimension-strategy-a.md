# 跨维度综合建议：方案架构 A（系统结构收敛、纯粹物理光学与拓扑序净消减）

> **战役代号**：`UI-UNIFICATION-REDESIGN`
> **文档定位**：阶段一 前置深度审计与跨维度系统架构建议（方案架构 A）
> **设计依据**：
> - `C:\Software\conex\skill\design\`（`apple-design.md` 物理流体动效体系 + `jakub-skills` 7 大工程级设计技能）
> - `docs/ui-unification-redesign/00-战役调度总纲与工作区规范.md`（战役调度总纲）
> - `AGENTS.md`（通用协作纪律、§1 反退避铁律、§7 严禁补丁与立体验证、§8 反过度设计硬性红线、§11 CI 治理、§13 输入与焦点态、§14 色彩空间）
> - `apps/crish-desktop/src/styles/style-contract.test.ts`（样式系统契约测试）与 `scripts/check-ui-layer.mjs`（UI 原子层解耦门禁）
> - `FULL_CHECK_COMMANDS.md`（全仓重大改动后全量验证套件）

---

## 一、方案架构 A 核心定位与设计哲学

在主控调度总纲 `00-战役调度总纲与工作区规范.md` 确立的四大推进维度（DIM-01 ~ DIM-04）下，方案架构 A 立足于**系统工程级结构收敛、纯粹物理光学与拓扑序净消减（Systemic Structural Convergence, Pure Optical Physics & Topological Net-Negative Refactoring）**。

与方案架构 B 偏向“防御型渐进包装与别名双桥协议（Defensive Bridge Evolution）”不同，方案架构 A 坚决贯彻 `AGENTS.md` §7 **“追求架构优雅，杜绝打补丁”** 与反过度设计硬性红线：
> **“在代码架构中，多一层兼容垫片就多一份技术负债。真正的系统级重构，不是在旧废弃别名和混乱私有样式上搭建一层又一层的包装桥，而是穿透表象找到架构断层，以严密的自底向上拓扑依赖序（Topological Dependency Order），将基础设施 Token、原子组件基座与业务消费层彻底解耦，在保证现有 70+ 套件测试资产绝对零破坏的前提下，实现代码的刚性净负产出（Net-Negative LOC）与 Apple 级的极简流体质感。”**

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               方案架构 A 核心系统工程模型                              │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   [第 4 阶: 全景一致性与无障碍]  DIM-04: 一屏一主色 / 全景 tabular-nums / 3%~6% 柔和焦点环 │
│               ▲                                                                        │
│               │ 消费驱动换装 (Consume & Strip Private CSS)                              │
│   [第 3 阶: 业务层私有样式清退]  DIM-03 (业务面): 拔除 Sidebar/Settings/Toolbar 私有裸写实现   │
│               ▲                                                                        │
│               │ 底座能力完备 (Optical & Kinetic Injection)                             │
│   [第 2 阶: 原子层物理光学重塑]  DIM-02 + DIM-03 (原子面): Button/Input/Tabs/SegmentedControl │
│               ▲                                                                        │
│               │ 单一真源约束 (SSOT Contract)                                           │
│   [第 1 阶: 基础设施 Token 收敛] DIM-01: tokens.css 别名清理 / 7 档字阶 / 4px 网格同心圆角    │
│               ▲                                                                        │
│   [第 0 阶: 基线契约与测试防护] style-contract.test.ts + check:ui-layer 静态门禁守护    │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、四大推进维度的系统工程审视：重叠剖析与遗漏补全

系统工程要求各子系统的**职责边界正交、依赖单向无环、验收断言明确**。主控调度总纲虽然划定了四大维度，但在实际落地时存在 3 处职责边界重叠与 3 处关键技术遗漏，方案架构 A 对此进行刚性厘清与边界重划：

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                               四大推进维度边界重划与正交化矩阵                          │
├─────────┬──────────────────────┬───────────────────────────┬────────────────────────────┤
│ 维度    │ 总纲原始定义         │ 方案 A 裁决职责边界       │ 隔离与正交契约             │
├─────────┼──────────────────────┼───────────────────────────┼────────────────────────────┤
│ DIM-01  │ Token 碎片收敛 +     │ **纯全局基础设施层 (SSOT)**│ **禁止侵入任何业务叶子文件**；│
│         │ Settings/Sidebar 样式│ 收敛 `tokens.css` 全局变量│ 业务组件私有样式剥离完全划 │
│         │ 清理                 │ 与 7 档字阶，清理废弃别名 │ 归 DIM-03。                │
├─────────┼──────────────────────┼───────────────────────────┼────────────────────────────┤
│ DIM-02  │ 同心几何圆角 +       │ **几何标尺与物理动效契约**│ 动效注入必须**自带**       │
│         │ Apple 物理流体动效   │ 确立全景 $R_{out}=R_{in}+P$│ `prefers-reduced-motion` 降│
│         │                      │ 阻尼比归一 1.0，主题门闩  │ 级基座，不推诿至无障碍层。 │
├─────────┼──────────────────────┼───────────────────────────┼────────────────────────────┤
│ DIM-03  │ 原子层组件收敛 +     │ **原子基座重塑 + 业务换装**│ 分为原子组件重塑与业务层私 │
│         │ 8 处私有裸写组件拔除 │ Button/Input 光学补正；拔除│ 有样式连根拔除两阶段；保证 │
│         │                      │ 业务裸写，消减私有 CSS    │ 0 业务组件残留私有控件样式。│
├─────────┼──────────────────────┼───────────────────────────┼────────────────────────────┤
│ DIM-04  │ 色彩角色 + 排版节奏 +│ **宏观视觉收敛与无障碍闭环**│ 专注于跨组件视觉层级治理   │
│         │ 焦点无障碍           │ 一屏一主色治理；全景跳动  │ （一屏一主色）与键盘 APG / │
│         │                      │ 数字 tabular-nums；焦点环 │ WCAG 2.5.8 尺寸与语义合规。│
└─────────┴──────────────────────┴───────────────────────────┴────────────────────────────┘
```

### 1. 边界重叠深度剖析与解决方案

#### 1.1 重叠点 A：DIM-01 与 DIM-03 关于“业务私有样式清除”的归属冲突
- **现象描述**：总纲在 DIM-01 声明了“清除 Settings/Sidebar 裸写的私有 `.search` 与按钮样式”，而在 DIM-03 中又要求“Sidebar / Settings / TopBar 裸写按钮与输入框全面换装为 `<Button>` 与 `<Input>`，拔除 8 处私有裸写组件与配套私有 CSS 声明”。
- **架构冲突**：DIM-01 作为全局 Token 基础设施，若直接跨层篡改 `components/sidebar/` 和 `components/settings/` 中的具体类名，会造成 Token 收敛分支与组件换装分支产生巨大的 Git 冲突，破坏原子化提交纪律；更会导致原子组件尚未完成光学与动效重塑前，业务层样式已提前被破坏。
- **架构 A 裁决**：
  1. **DIM-01 严格圈禁在 `src/styles/tokens.css` 及全局设计变量层**，严禁直接修改业务组件 `.module.css`；
  2. 业务层（Sidebar, Settings, TopBar）对私有 `.search`、`.navItem`、`.sidebarTab`、`.sidebarToggleBtn` 等样式的拔除，**100% 移交给 DIM-03** 在原子组件换装时同步剥离。

#### 1.2 重叠点 B：DIM-02（物理动效）与 DIM-04（无障碍）关于 Reduced Motion 的割裂
- **现象描述**：DIM-02 负责引入 `scale(0.96)` 触感反馈与物理过渡动画，而 DIM-04 负责 WCAG / 无障碍。在工程实践中，根据 `apple-design.md` §14 与 `jakub-skills/better-accessibility`，动效的引入必须与 `@media (prefers-reduced-motion: reduce)` 的静止降级作为不可分割的同一物理单元交付。若 DIM-02 注入了动效却将降级留给 DIM-04，会导致中间态在无障碍门禁（Escalation Trigger）上直接爆红。
- **架构 A 裁决**：
  1. **动效自包含原则**：DIM-02 实施的所有物理过渡、Scale 按压变形与 Tab 移动动画，必须在同一个 CSS 规则或动画 Hook 中内嵌 `prefers-reduced-motion` 降级逻辑（静态透明度交叉淡入淡出，`transform: none !important`）；
  2. DIM-04 仅负责全局 A11y 验收扫描与极端视口下的动画抑制。

#### 1.3 重叠点 C：DIM-01（字阶收敛）与 DIM-04（排版节奏 / tabular-nums）的领域碎片化
- **现象描述**：DIM-01 负责收敛 7 档字阶，消除半像素碎步；DIM-04 却单列了排版节奏与 `tabular-nums`。从排版工程系统（`better-typography`）视角，字阶、字重、line-height、OpenType 特性（tabular-nums）属于不可割裂的同一排版标尺。
- **架构 A 裁决**：
  1. **定义层归入 DIM-01**：在 `tokens.css` 中明确确立 `--font-variant-numeric: tabular-nums` 以及标准化的数字字阶；
  2. **应用面归入 DIM-04**：DIM-04 负责在业务呈现层（DiffCard、TaskRunner、Timeline、StatusDiagnostics 等）全面注入该特性，解决动态数值横向跳动。

---

### 2. 关键架构遗漏剖析与补充

#### 2.1 遗漏点 A：点击热区扩展机制（Hit Target Expansion, WCAG 2.5.8）缺位
- **系统缺陷**：`better-accessibility` §Minimum hit area 和 `better-ui` 强烈约束：交互元素的物理点击面积在桌面端应保持 ≥ 40×40px（至少达 Level AA 要求的 24×24px 且不碰撞）。
  Crish 当前的 `<Button size="xs">` 高度仅 24px，`<Button size="sm">` 高度 28px，且密集分布在侧边栏和顶栏。若直接缩小视觉尺寸而没有使用 `::after` 伪元素进行透明热区外延（Hit Padding），在多窗口桌面与高分屏触控模式下将造成严重的误触与不可用。
- **方案 A 补充**：在 DIM-03 原子重塑阶段，在 `Button.module.css` 与 `Input.module.css` 中内置可配置的 `::after` 热区扩展层：
  ```css
  /* 仅在紧凑/小尺寸下激活透明热区补正，达到 36px/40px 安全点击面 */
  .buttonXs::after,
  .buttonSm::after {
    content: '';
    position: absolute;
    inset: -4px -2px;
    pointer-events: auto;
  }
  ```

#### 2.2 遗漏点 B：全景同心级联标尺表（Concentric Hierarchy Matrix）缺失
- **系统缺陷**：总纲 DIM-02 强调了 $R_{outer} = R_{inner} + padding$，但仅关注了按钮与选项卡内部的局部几何。在整个 Crish 桌面端应用中，存在四级嵌套容器体系：
  `Window Shell` ➔ `Card / Panel Container` ➔ `Inner Group / Segmented Track` ➔ `Control (Button/Input) / Badge`。
  当前各层级圆角各行其是（Card 用 12px，Settings UI 用 14px，按钮用 7px，Badge 用 4px），形成了严重的“几何波纹破裂”。
- **方案 A 补充**：在 DIM-01 与 DIM-02 中制定并落地 **Crish 全景同心圆角级联标尺表**：

| 层级 | 容器角色 | 外圆角 $R_{outer}$ | 内边距 $padding$ | 契约推导子元素圆角 $R_{inner} = R_{out} - P$ | 实际映射 Token |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tier 1** | Window Shell / 顶级浮层 | 16px | 8px | 8px (顶级卡片外角) | `--radius-2xl: 16px` |
| **Tier 2** | Content Card / 模态面板 | 12px | 6px | 6px (内部操作容器) | `--radius-xl: 12px` |
| **Tier 3** | Tabs 轨道 / 分段控制器底板 | 8px | 2px / 3px | 6px / 5px (内层滑块) | `--radius-lg: 8px` / `--radius-md: 6px` |
| **Tier 4** | 原子控件 (Button / Input) | 6px (标准) / 4px (紧凑) | - | - | `--radius-md: 6px` / `--radius-sm: 4px` |
| **Tier 5** | Micro Badge / Tag / Kbd | 4px / 2px | - | - | `--radius-sm: 4px` / `--radius-xs: 2px` |
| **Special**| Switch / Capsule / Scrollbar | 9999px | - | 9999px (两端半圆完全对称) | `--radius-full: 9999px` |

#### 2.3 遗漏点 C：主题切换与冷启动瞬态门闩运行时（Runtime Theme Latch & Zero-FOUC）缺位
- **系统缺陷**：`tokens.css` 顶部虽有静态门闩 `html.preload * { transition: none !important; }`，但深浅色主题切换发生在应用运行时（`themeStore.ts`）。当用户切换主题或操作系统在日落时自动触发深色模式时，界面内所有带 `transition: background 150ms, border-color 150ms` 的元素会产生长达 150ms 的颜色交叉涂抹与脏色过渡（`jakub-skills/better-ui` §Suppress transitions on theme switch）。
- **方案 A 补充**：在 DIM-02 中确立 JS 与 CSS 联动的 **瞬态主题门闩协议（Transient Theme Latch Protocol）**：
  在 `themeStore.ts` 变更 `data-theme` 的瞬间，向 `document.documentElement` 添加 `theme-switching` 类，并在下一帧（`requestAnimationFrame`）移除：
  ```css
  /* 运行时主题切换瞬态门闩：1 帧完全抑制所有过渡，实现清脆干脆的瞬间色彩重绘 */
  html.theme-switching,
  html.theme-switching *,
  html.theme-switching *::before,
  html.theme-switching *::after {
    transition: none !important;
  }
  ```

---

## 三、每个维度的“删除面”刚性量化与清除清单

方案架构 A 坚持**“先算净减，再动代码；以删除量化为第一裁判”**。以下为四大维度的硬性消减指标与清单：

### 1. DIM-01：Token 基础设施层删除面（目标：净消减 ≥ 378 行）

`tokens.css` 现存 1758 行，存在大量历史修补遗留的别名网与同名异义变量。

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        DIM-01 tokens.css 刚性删除与收敛靶标                            │
├───────────────────────────────┬──────────┬─────────────────────────────────────────────┤
│ 类别                          │ 删除数量 │ 具体清除对象 / 路径证据                     │
├───────────────────────────────┼──────────┼─────────────────────────────────────────────┤
│ 废弃向后兼容别名              │ 35+ 处   │ `--tint-scrollbar-thumb`, `--color-text-dim`│
│ (Deprecated Alias Bridges)    │          │ `--color-text-secondary`, `--sep-btn-radius`│
│                               │          │ `--sep-radius-outer/inner` (重复声明 3 处)  │
├───────────────────────────────┼──────────┼─────────────────────────────────────────────┤
│ 半像素与非标碎步字阶          │ 7 档     │ 彻底剔除 11.5px (`--md-code-font-size`),    │
│ (Sub-Pixel Font Sizes)        │          │ 12.5px (`--thought-font-size-meta`),        │
│                               │          │ 13.5px (`--aicard-title-font-size`),        │
│                               │          │ 14.5px (`--md-table-font-size`),            │
│                               │          │ 17px, 19px, 21px (大屏碎步变量)             │
├───────────────────────────────┼──────────┼─────────────────────────────────────────────┤
│ 混乱与同名异义 Accent 变量    │ 8 处     │ 清除 `--brand-primary`、`--brand-deep`、    │
│ (Conflicting Accent Tokens)   │          │ `--accent-inverted`、`--accent-color`，     │
│                               │          │ 全面归一至 `--brand` (基础品牌主色)         │
├───────────────────────────────┼──────────┼─────────────────────────────────────────────┤
│ 随心奇数圆角                  │ 6 处     │ 拔除硬编码的 3px, 5px, 7px, 9px, 10px, 14px │
│ (Arbitrary Odd Radii)         │          │ 统一收敛至 4px/6px/8px/12px/16px 模数矩阵   │
└───────────────────────────────┴──────────┴─────────────────────────────────────────────┘
```

- **删除后标准 7 档字阶契约**：
  - `--font-size-xxs`: `11px` (极小标签 / 徽标状态)
  - `--font-size-xs`: `12px` (辅助说明文案 / 键盘快捷键)
  - `--font-size-sm`: `13px` (侧边栏会话 / 表单输入框)
  - `--font-size-base`: `14px` (正文默认基准 / 按钮标准字阶)
  - `--font-size-md`: `16px` (一级子标题 / 强调区块头)
  - `--font-size-lg`: `18px` (弹窗标题 / 模块主标题)
  - `--font-size-xl`: `20px` (页面主标题 / 视口 Header)

### 2. DIM-02：几何标尺与 Apple 物理动效删除面

- **清除 1.5 过冲弹簧抖动参数**：
  彻底删除 [`Tabs.module.css:7`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css#L7) 中极其生硬的过冲贝塞尔：
  ```css
  /* 【删除】导致选项卡切换严重回弹与视觉眩晕的 1.5 阻尼过冲 */
  --tab-spring-bezier: cubic-bezier(0.175, 0.885, 0.32, 1.5);
  /* 【替换为】Apple WWDC 2018 推荐的临界阻尼 (Damping Ratio = 1.0) 纯正物理曲线 */
  --tab-spring-bezier: cubic-bezier(0.2, 0, 0, 1);
  --tab-duration: 200ms;
  ```
- **清除随心 7px / 5px 杂乱圆角**：
  - 彻底删除 [`Button.module.css:11,102,112`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L11) 中的 `--button-radius: 7px`，替换为 `--radius-md: 6px`（标准）与 `--radius-sm: 4px`（紧凑）；
  - 彻底删除 [`Tabs.module.css:84-85`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css#L84) 中的 7px 外壳 + 5px 滑块；
  - 彻底删除 [`SegmentedControl.module.css:65-66`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css#L65) 中的 7px 外壳 + 5px 滑块。
- **清除全仓无界 `transition: all`**：
  全仓扫描并剔除所有 `transition: all` 滥用，必须精确约束为 `transition: transform 100ms ease-out, opacity 100ms ease-out, background-color 100ms ease-out`，杜绝触发布局重排与阴影撕裂。

### 3. DIM-03：原子层组件收敛与业务裸写删除面（目标：净消减 ≥ 280 行）

彻底拔除业务层散落的 8 处原生 HTML 裸写实现，并注销其对应的专用 CSS 规则：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        DIM-03 业务层 8 处私有裸写组件清除矩阵                          │
├──────────────────────┬──────────────────────┬─────────────────┬────────────────────────┤
│ 业务组件文件         │ 裸写代码特征         │ 配套私有 CSS    │ 替换标准原子方案       │
├──────────────────────┼──────────────────────┼─────────────────┼────────────────────────┤
│ 1. SidebarHeader.tsx │ 2 处 `<button>` 折叠 │ 34 行私有 CSS:  │ `<Button>`             │
│    (lines 47, 94)    │ 开关 (`sidebarToggle`│ `.sidebarToggle`│ `variant="ghost"`      │
│                      │ `Btn`)               │                 │ `size="sm"`            │
├──────────────────────┼──────────────────────┼─────────────────┼────────────────────────┤
│ 2. SidebarNav.tsx    │ 2 处 `<button>`      │ 50 行私有 CSS:  │ `<Button>`             │
│    (lines 24, 47)    │ (新对话、定时任务)   │ `.navItem`      │ `variant="ghost"`      │
│                      │                      │                 │ `active={...}`         │
├──────────────────────┼──────────────────────┼─────────────────┼────────────────────────┤
│ 3. SidebarNav.tsx    │ 1 处 `<input>`       │ 25 行私有 CSS:  │ `<Input>`              │
│    (line 64)         │ (`type="search"`)    │ `.navItem input`│ `variant="search"`     │
│                      │                      │                 │ `size="sm"`            │
├──────────────────────┼──────────────────────┼─────────────────┼────────────────────────┤
│ 4. SidebarFooter.tsx │ 1 处 `<button>`      │ 33 行私有 CSS:  │ `<Button>`             │
│    (line 27)         │ (设置齿轮按钮)       │ `.settingsGear` │ `variant="ghost"`      │
│                      │                      │ `Btn`           │ `size="sm"`            │
├──────────────────────┼──────────────────────┼─────────────────┼────────────────────────┤
│ 5. UserProfileCard   │ 1 处 `<button>`      │ 33 行私有 CSS:  │ `<Button bare>` 或     │
│    .tsx (line 31)    │ (用户信息卡片触发器) │ `.userProfile`  │ 纯语义 `<div tabIndex>`│
│                      │                      │ `Card`          │ 标准化 Trigger         │
├──────────────────────┼──────────────────────┼─────────────────┼────────────────────────┤
│ 6. SettingsSidebar   │ 1 处 `<input>`       │ 跨层反向 import │ `<Input>`              │
│    .tsx (line 103)   │ (`type="search"`)    │ 依赖 navStyles! │ `variant="search"`     │
│                      │                      │ 违背分层红线    │ `size="sm"`            │
├──────────────────────┼──────────────────────┼─────────────────┼────────────────────────┤
│ 7. SettingsSidebar   │ 1 处 `<button>`      │ 50 行私有 CSS:  │ `<Button>`             │
│    .tsx (line 149)   │ (设置分类导航选项卡) │ `.sidebarTab`   │ `variant="ghost"`      │
│                      │                      │                 │ 统一侧边栏 Tab 样式    │
├──────────────────────┼──────────────────────┼─────────────────┼────────────────────────┤
│ 8. PreviewToolbar    │ 1 处 `<input>`       │ 20 行私有 CSS:  │ `<Input>`              │
│    .tsx (line 163)   │ (预览地址栏输入框)   │ `.urlInput`     │ `variant="text"`       │
│                      │                      │                 │ `size="sm"`            │
└──────────────────────┴──────────────────────┴─────────────────┴────────────────────────┘
```

- **配套私有 CSS 净删除清单**：
  1. [`Sidebar.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css)：彻底删除 `.sidebarToggleBtn` (lines 84-117)、`.userProfileCard` (lines 163-195)、`.settingsGearBtn` (lines 258-290)，**净减 ~100 行**；
  2. [`SidebarNav.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.module.css)：彻底删除 `.navItem`、`.navItem input[type='search']`、`.navItem::before`，**净减 ~105 行**；
  3. [`SettingsPanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css)：彻底删除 `.sidebarTab`、`.sidebarTabIco`、`.sidebarTab.active`，**净减 ~52 行**；
  4. [`SettingsUI.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUI.module.css)：彻底删除 `.filterInput :global(input)` 等深度穿透覆盖，**净减 ~28 行**。
  - **小计**：业务层私有 CSS 净消减 **≥ 285 行**，全面消除跨层样式穿透。

### 4. DIM-04：色彩角色、排版节奏与焦点无障碍删除面

- **清除一屏多 Primary 冲突**：
  根据 `jakub-skills/better-colors` §Fill exactly one action per view：
  > “当充满色彩的实体按钮代表主要强调时，一个视口内只能有 1 个 Primary 实体填充按钮，其余同级按钮必须降级为 Secondary 或 Ghost。”
  - **排查与降级清理**：
    - `DiffCardGitActions.tsx`: 清除并存的多个 `variant="primary"`，仅保留最核心的“提交变动”为 Primary，将“暂存所有”、“丢弃变动”降级为 Secondary / Danger-Ghost；
    - `ApprovalSection.tsx`: 批准与拒绝并存时，批准为 Primary，拒绝降级为 Danger-Ghost；
    - `WorkspaceEmptyStateActions.tsx`: 保持当前主次分明的降级策略，禁止双轨同时以 Primary 高亮。
- **清除动态数字横向跳动（Jittery Numbers）**：
  在以下模块彻底清除未受保护的动态数值展示，强制注入 `font-variant-numeric: tabular-nums`：
  - `diff/`: Diff 代码行号列（`.diff-linenum`）与变更统计计数（`+12 / -5`）；
  - `bg-tasks/`: 任务执行秒数倒计时、进度百分比 `[45%]`、传输速率；
  - `workspace/RuntimePanel.module.css`: 实时内存、CPU 与会话缓存指标。
- **清除粗黑高对比度与穿透性焦点环**：
  清除散落在各业务模块中的 `box-shadow: 0 0 0 2px var(--tint-focus-ring)`（15%~20% 过深黑框）或 `outline: 2px solid black`，全面归一至符合 `AGENTS.md` §13 的 3%~6% 柔和混入微环：
  `box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);`

---

## 四、“先删后改”的系统工程依赖拓扑编排

在系统重构工程中，最容易导致灾难的误区就是“盲目跳步”——例如：**还没收敛 tokens.css 就去改 Button，或者还没改好 Button 就去换装 Sidebar**。

### 1. 为什么“先收敛 tokens.css，再改造 Button”是不可违背的数学拓扑？

```
      ┌────────────────────────────────────────────────────────┐
      │  A. 若先改 Button，后收敛 tokens.css（错误逆向序）    │
      └────────────────────────────────────────────────────────┘
                                 │
                                 ▼
         Button 消费了尚未清洗的 `--button-radius: 7px`
         与未收敛的碎步字阶 `--font-size-base: 14px`
                                 │
                                 ▼
         导致 Button 要么硬编码 6px，破坏 Token 契约；
         要么迁就 7px 垃圾变量，将架构断层带入新代码！
                                 │
                                 ▼
      ┌────────────────────────────────────────────────────────┐
      │  B. 若先换装 Sidebar，后改造 Button（错误逆向序）     │
      └────────────────────────────────────────────────────────┘
                                 │
                                 ▼
         Sidebar 换装为 `<Button>` 时，原子 Button 尚未支持
         `-2px` 光学补偿、尚未支持 `scale(0.96)` 触感、
         其 `::before` 遮罩还会与侧栏暖褐底色发生 Double Alpha
                                 │
                                 ▼
         业务开发者被迫在 SidebarNav 再次写出私有补丁：
         `.navItem::before { display: none; }` —— 债务原地回潮！
```

**系统工程正确依赖有向无环图（DAG）**：
`DIM-01 (tokens.css 基础设施)` ➔ `DIM-02 + DIM-03 (原子组件重塑)` ➔ `DIM-03 (业务组件换装与私有样式清退)` ➔ `DIM-04 (全景排版、色彩与无障碍闭环)` ➔ `Phase 5 (门禁立体验证)`。

---

### 2. 五阶段“先删后改”编排全景流水线

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        五阶段“先删后改”系统重构流水线编排                              │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   Phase 0: 契约固化与删除靶标确立 (Baseline & Contract Freeze)                          │
│   ├─ 锁定 `style-contract.test.ts` 现有 531 行测试断言与 ratchet 门槛                  │
│   ├─ 建立待淘汰别名映射表与业务裸写 AST 扫描靶标                                       │
│   └─ 确认当前 CI `npm run check:desktop` 处于 100% 全绿基线                            │
│                                                                                        │
│   Phase 1: Token 基础设施 SSOT 收敛 (DIM-01 tokens.css 收敛)                           │
│   ├─ 彻底剔除 35+ 废弃向后兼容别名与悬空变量                                           │
│   ├─ 归一 7 档标准字阶，删除 11.5px/12.5px/13.5px 等 6 档半像素碎步                    │
│   ├─ 建立 4px 模数同心几何圆角网格（4px/6px/8px/12px/16px/9999px）                    │
│   ├─ 归一品牌色变量为单一真源 `--brand`，清除 `--brand-primary` / `--brand-deep`        │
│   └─ 【验收】`tokens.css` 净消减 ≥ 378 行；`style-contract.test.ts` 静态定义测试全绿   │
│                                                                                        │
│   Phase 2: 原子基座组件物理光学重塑 (DIM-02 + DIM-03 原子上半场)                       │
│   ├─ Button 重塑：                                                                     │
│   │  ├─ 注入同心圆角（sm: 4px, md: 6px, lg: 8px），彻底注销 7px 奇数硬编码             │
│   │  ├─ 注入 Apple 物理按压微缩触感：`:active { transform: scale(0.96); }`             │
│   │  ├─ 注入 `-2px` 图标侧光学补正（带图标时减少图标侧 padding 2px）                   │
│   │  ├─ 注入 `variant="ghost"` 纯透明层，隔离 `::before` 遮罩以杜绝 Double Alpha 叠色  │
│   │  └─ 内置 `::after` 紧凑尺寸热区扩展（WCAG 2.5.8 40×40px 防误触）                   │
│   ├─ Input 重塑：                                                                      │
│   │  ├─ 注入同心圆角（4px/6px/8px），继承 IME 输入法组合状态机锁                       │
│   │  └─ 内置标准化放大镜图标与清空按钮，消除业务层私有 WebKit 搜索伪类穿透             │
│   ├─ Tabs / SegmentedControl 重塑：                                                    │
│   │  ├─ 阻尼比归一至 1.0 (`cubic-bezier(0.2, 0, 0, 1)`)，彻底根除 1.5 贝塞尔过冲抖动   │
│   │  └─ 严格执行 $R_{outer} = R_{inner} + padding$ 同心几何方程式                      │
│   └─ 【验收】`Button.test.tsx`, `Input.test.tsx`, `Tabs.test.tsx` 单元测试通过          │
│                                                                                        │
│   Phase 3: 业务层私有实现连根拔除与原子换装 (DIM-03 业务下半场)                        │
│   ├─ Sidebar 换装与清理：                                                              │
│   │  ├─ 拔除 `SidebarHeader` 2 处裸写折叠按钮 ➔ 替换为 `<Button variant="ghost">`      │
│   │  ├─ 拔除 `SidebarNav` 2 处裸写导航按钮 ➔ 替换为 `<Button variant="ghost">`        │
│   │  ├─ 拔除 `SidebarNav` 1 处裸写 `<input type="search">` ➔ 替换为 `<Input>`          │
│   │  ├─ 拔除 `SidebarFooter` 1 处裸写设置齿轮 ➔ 替换为 `<Button variant="ghost">`      │
│   │  ├─ 重构 `UserProfileCard` 为标准化卡片 Trigger                                    │
│   │  └─ 彻底删除 `Sidebar.module.css` 与 `SidebarNav.module.css` 中配套的 ~205 行私有类│
│   ├─ Settings 换装与清理：                                                             │
│   │  ├─ 拔除 `SettingsSidebar` 跨层反向 `import navStyles` 红线依赖                    │
│   │  ├─ 拔除 `SettingsSidebar` 搜索框与 Tab 选项卡裸写 ➔ 换装标准 `<Input>` 与 `<Button>`│
│   │  └─ 彻底删除 `SettingsPanel.module.css` 中的 `.sidebarTab` 等 ~52 行私有类         │
│   ├─ Toolbar 换装与清理：                                                              │
│   │  ├─ `PreviewToolbar` 裸写地址框 ➔ 替换为 `<Input variant="text" size="sm">`        │
│   │  └─ 清除 `SettingsUI.module.css` 深度穿透覆盖样式                                  │
│   └─ 【验收】业务层私有 CSS 净消减 ≥ 285 行；全仓业务代码 0 原生 `<button>` 裸写        │
│                                                                                        │
│   Phase 4: 全景排版防抖、一屏一主色与无障碍闭环 (DIM-04 全局收口)                      │
│   ├─ 一屏一主色治理：                                                                  │
│   │  └─ 审计降级 `DiffCardGitActions`、`ApprovalSection`、`Workspace` 多重 Primary 按钮│
│   ├─ 全景数值跳动防抖：                                                                │
│   │  └─ 在 Diff 行号、任务耗时、倒计时、监控面板注入 `font-variant-numeric: tabular-nums`│
│   ├─ 柔和 Focus Ring 收敛：                                                            │
│   │  └─ 统一收敛为 3%~6% 混入微环，清除 15%~20% 粗黑实心框                             │
│   └─ 【验收】WCAG 2.5.8 尺寸与对比度达标；ARIA APG 键盘流走通                          │
│                                                                                        │
│   Phase 5: 自动化防线固化与全量立体验证 (Validation & Guardrails Lock)                 │
│   ├─ 运行 `npm run check:ui-layer` 验证 0 跨层反向业务依赖                             │
│   ├─ 运行 `npm run test:coverage -- --project=unit` 验证核心组件覆盖率                 │
│   ├─ 运行 `npm run test` (vitest 全量) + `vitest.integration.config.ts`                │
│   ├─ 运行 `git diff --stat` 验证全仓净消减 LOC（净产出为负）                           │
│   └─ 形成规范沉淀，封死后续回潮路径                                                    │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 五、方案架构 A 独立执行路径建议与风险护栏

### 1. 独立执行路径关键里程碑（Milestones）

- **M1（第 1 天）：基础设施纯正化（Infrastructure Purity）**
  - 单一目标：收敛 `tokens.css`，达成净消减 ≥ 378 行。
  - 交付物：纯净的 7 档字阶、4px 模数圆角网格与单一真源 `--brand`。
- **M2（第 2 天）：原子层物理流体与光学重塑（Atomic Optics & Fluid Motion）**
  - 单一目标：升级 `ui/Button`、`ui/Input`、`ui/Tabs`、`ui/SegmentedControl`。
  - 交付物：注入 `scale(0.96)`、-2px 光学内边距、阻尼 1.0 贝塞尔、Ghost 变体。
- **M3（第 3-4 天）：业务层私有样式剥离与原子换装（Business Shell Unification）**
  - 单一目标：彻底改造 Sidebar、Settings、TopBar、PreviewToolbar。
  - 交付物：拔除 8 处裸写，删除 285 行私有 CSS，消除跨层反向 import。
- **M4（第 5 天）：宏观排版节奏、色彩主角色与无障碍闭环（Visual Rhythm & A11y）**
  - 单一目标：一屏一主色治理、全景 `tabular-nums`、柔和焦点环。
  - 交付物：消除多重 Primary 冲突，消除数字排版抖动，打通键盘焦点。
- **M5（第 6 天）：全量门禁与净负产出决算（Full Verification & Negative Ratchet）**
  - 单一目标：跑通全仓门禁套件，固化防回潮规则。

---

### 2. 系统工程级六大风险护栏（Risk Guardrails）

#### 护栏 1：样式契约动态注入同源守护（Dynamic Injection Guardrail）
- **风险点**：`src/api/themeStore.ts` 与 `themePersonalization.ts` 动态调用 `document.documentElement.style.setProperty('--xxx', val)`。若在收敛 `tokens.css` 时误删了动态注入的静态底座变量，会导致 `style-contract.test.ts:352-368` 报 `注入但无静态定义` 错误。
- **防线策略**：重构前提取 `themeStore.ts` 中所有 `setProperty` 涉及的 Token 集合作为白名单，任何修改必须维持 `injectedToken ⊆ staticTokens` 的集合真包含关系。

#### 护栏 2：Double Alpha 叠色与层叠上下文隔离护栏（Double Alpha Isolation Guardrail）
- **风险点**：Sidebar 和 Settings 的背景是 `hsl(35 8% 92.1%)` 暖灰色。当把原生 `<button>` 替换为 `<Button>` 时，若 Button 的 `::before` 悬浮遮罩叠加（`color-mix(in srgb, var(--text-primary) 3.5%, transparent)`），在深色或特定对比度下会发生 Double Alpha Stacking，导致按钮悬浮态发黑或发脏。
- **防线策略**：
  1. `<Button>` 的 `variant="ghost"` 必须支持 `--btn-hover-overlay: var(--sidebar-hover)` 的主题化覆盖；
  2. 容器建立 `isolation: isolate` 局部层叠上下文，切断外部底板灰度穿透。

#### 3. 护栏 3：IME 输入法合成状态机不可破坏（IME Composition State Guardrail）
- **风险点**：业务搜索框（如 `SidebarNav` 的 `onSearchChange`、`SettingsSidebar` 的 `onSearchKeyDown`）依赖原生键盘事件。若直接换装为 `<Input>`，若未正确对接 `Input.tsx` 的 `isComposingRef` 状态机，会导致中文拼音选词回车被误判为“提交搜索”。
- **防线策略**：所有换装为 `<Input>` 的业务调用点，统一走 `<Input onEnter={...}>` 标准回调，严禁在业务外层私自拦截 `Enter` 键。

#### 4. 护栏 4：测试资产零破坏与 Selector 稳定器（Test Asset Zero-Regression Guardrail）
- **风险点**：业务组件如 `SidebarHeader.tsx` 带有 `data-testid="sidebar-toggle"`、`data-testid="sidebar-header-toggle"`，大量 Vitest 单元测试与 Playwright E2E 依赖这些选择器。若组件换装导致 testid 丢失或层级改变，会导致 70+ 套件大面积飘红。
- **防线策略**：
  1. **属性直通（Props Pass-through）**：`<Button>` 和 `<Input>` 必须 100% 透传 `data-testid`、`aria-*` 与原生 HTML 属性；
  2. 换装前后运行 `npm run test`，若有单测因 DOM 结构报错，严禁删测试，必须保证原有交互契约完全满足。

#### 5. 护栏 5：代码行数净负产出硬性门限（Net-Negative LOC Ratchet）
- **风险点**：重构往往演变为“新增了 1000 行新代码，只删了 200 行旧代码”，导致代码库持续膨胀。
- **防线策略**：设立硬性门限——**全战役必须实现代码净消减 ≥ 650 行**：
  - `tokens.css`: 净消减 ≥ 378 行；
  - 业务层私有 CSS: 净消减 ≥ 285 行；
  - 若 `git diff --stat` 结算为正增长，主控 Agent 严格拒绝合并。

#### 6. 护栏 6：绝对禁止 `--no-verify` 与临时补偿（Zero-Bypass Discipline）
- **纪律红线**：根据 `AGENTS.md` §7，严禁使用 `--no-verify` 绕过 pre-commit 钩子；严禁使用任何 `setTimeout` 盲猜延时或坐标魔术数字补偿；所有布局必须基于 flex/grid 语义，动效必须基于物理时间常数。

---

## 六、方案架构 A 验收断言清单（Acceptance Assertions）

方案架构 A 的最终交付，必须通过以下六大维度的自动化与数学化刚性验收：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              方案架构 A 综合验收断言矩阵                               │
├───────────────────┬───────────────────────────────────┬────────────────────────────────┤
│ 验收维度          │ 断言公式 / 检查命令               │ 达标判定标准                   │
├───────────────────┼───────────────────────────────────┼────────────────────────────────┤
│ 1. 几何同心圆角   │ $R_{outer} = R_{inner} + padding$ │ 嵌套容器与子元素偏差 = 0px；   │
│    (Concentricity)│ 全景同心矩阵核算                  │ 彻底消除 7px/5px 奇数圆角      │
├───────────────────┼───────────────────────────────────┼────────────────────────────────┤
│ 2. 物理流体与触感 │ `:active` 触发 `scale(0.96)`      │ Settling time ≤ 200ms；        │
│    (Physics Motion│ Tab 贝塞尔 = (0.2, 0, 0, 1)       │ 阻尼过冲量 = 0% (无回弹抖动)； │
│    & Reduced A11y)│ `prefers-reduced-motion` 静态降级 │ 减弱动效下 transform = none    │
├───────────────────┼───────────────────────────────────┼────────────────────────────────┤
│ 3. 光学平衡补正   │ $Pad_{icon} = Pad_{text} - 2px$   │ 图标侧内边距严格减少 2px；     │
│    (Optical Align)│ 图标 strokeWidth 与字重同频       │ 400 对应 1.5px, 600 对应 2.0px │
├───────────────────┼───────────────────────────────────┼────────────────────────────────┤
│ 4. 原子层解耦与   │ `npm run check:ui-layer`          │ Exit Code = 0；                │
│    依赖正交       │ 业务目录 0 原生 `<button>` 裸写   │ 违规依赖 = 0 处                │
├───────────────────┼───────────────────────────────────┼────────────────────────────────┤
│ 5. 代码净负产出   │ `git diff --stat`                 │ 全仓净消减 LOC ≥ 650 行；      │
│    (Net-Negative) │ `tokens.css` 行数核算             │ `tokens.css` ≤ 1380 行         │
├───────────────────┼───────────────────────────────────┼────────────────────────────────┤
│ 6. 门禁全绿资产   │ `npm run check:desktop`           │ TypeScript / Lint / 单元测试   │
│    守护 (Testing) │ `npm run test` (vitest 全量)      │ 100% PASS，0 Regression        │
└───────────────────┴───────────────────────────────────┴────────────────────────────────┘
```

---

## 七、总结与方案架构 A 核心决议

方案架构 A 坚决主张：
1. **边界清晰化**：DIM-01 管住 Token SSOT，DIM-02 管住物理动效与几何标尺，DIM-03 管住原子重塑与私有样式剥离，DIM-04 管住宏观排版节奏与无障碍体验；
2. **依赖拓扑化**：绝不跳步，严格遵循 `Token SSOT ➔ 原子组件重塑 ➔ 业务私有样式连根拔除 ➔ 全景一致性收口` 的单向流动；
3. **消除冗余层**：拒绝在废弃资产上堆砌冗长的兼容桥接，以原子级单测为防护罩，坚决实施代码净负产出，实现系统工程的彻底清爽与极简。
