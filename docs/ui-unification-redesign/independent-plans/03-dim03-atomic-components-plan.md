# 03-原子组件全面收敛与光学平衡独立实施详案（DIM-03 实施详案）

> **战役代号**：`UI-UNIFICATION-REDESIGN`  
> **文档性质**：战役阶段二 维度独立实施详案（方案 03：DIM-03 原子组件全面收敛与光学平衡）  
> **执行依据**：
> - `c:/Software/conex/docs/ui-unification-redesign/00-战役调度总纲与工作区规范.md`（战役调度总纲）
> - `c:/Software/conex/docs/ui-unification-redesign/01-四维度定案与删除面矩阵.md`（四维度基准定案与硬性指标）
> - `c:/Software/conex/docs/ui-unification-redesign/analysis/03-dim03-atomic-components-and-optics-analysis.md`（DIM-03 专项分析报告）
> - `c:/Software/conex/docs/ui-unification-redesign/analysis/06-cross-dimension-strategy-b.md`（Button 20+ 单测契约守护与防回归资产保护）
> - `AGENTS.md`（§3 Git 提交纪律、§7 严禁补丁、§7.1 立体验证、§8 反过度设计硬性红线、§11 CI 治理、§13 输入与焦点态、§14 色彩空间）
> - `.agents/LOGIC_PLAN_NO_RETREAT.md`（反退避铁律与纯逻辑规划）
> - `scripts/check-ui-layer.mjs`（UI 原子层绝对解耦门禁）

---

## 一、DIM-03 核心定位与系统工程基调

### 1.1 架构使命与主控裁判对齐

在 `01-四维度定案与删除面矩阵.md` 确立的主控裁决基调下，DIM-03（原子组件全面收敛与光学平衡）承担着**“组件与表现层全面归一”**的核心职责：

> **“以策略 B 的稳健契约与单测防护为防线护栏，坚决维持原生 `<button>` 单节点 DOM 树与类名/数据属性映射，确保存量测试资产零破损；以策略 A 的层级解耦为推进路径，将业务层散落的 8 处原生 `<button>` 与 4 处原生 `<input>` 裸写连根拔除，彻底清除配套的私有重复 CSS（净删 ≥ 362 行），杜绝跨模块逆向依赖；同时将 Jakub Krehel 的理性极简光学平衡（-2px 内边距补正与 strokeWidth/字重正交）注入基座，实现无感知的高品质蜕变。”**

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  DIM-03 核心职责域与系统边界                                      │
├───────────────────────────────┬─────────────────────────────────┬────────────────────────────────┤
│ 核心职责域                    │ 严禁跨界与违规行为             │ 硬性验收交付指标               │
├───────────────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ 1. 业务层裸写全面拔除并换装   │ 严禁篡改 Button 原生单节点 DOM  │ 8 处裸写 Button 归零           │
│    (Sidebar, Settings,        │ 严禁破坏现有 class/data-* 属性  │ 4 处裸写 Input 归零            │
│     Preview, TopBar)          │ 严禁逆向 import 跨模块 CSS      │ 跨域 CSS import 彻底清零       │
├───────────────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ 2. 私有 CSS 彻底清退          │ 严禁留存无引用的死样式          │ 私有 CSS 净消减 ≥ 362 行       │
│    (.searchWrap, .sidebarTab, │ 严禁在业务层用 !important 盖样式│ (核算落地 -407 行)             │
│     .navItem, .sidebarToggle) │ 严禁以「兼容」为名保留私有类名  │ 无死代码存留                   │
├───────────────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ 3. 光学平衡算法建模与落地     │ 严禁侵入 TSX 搞动态 JS 几何测量 │ -2px 纯 CSS 声明式补偿         │
│    (-2px 内边距补偿 +         │ 严禁硬编码随意 1.75px 描边      │ strokeWidth 与字重绝对同频     │
│     strokeWidth/字重正交)     │ 严禁破坏非图标按钮对称性        │ (400→1.5px, 500/600→2.0px)     │
├───────────────────────────────┼─────────────────────────────────┼────────────────────────────────┤
│ 4. 单测防线与分层门禁守门     │ 严禁绕过 check:ui-layer 门禁   │ Button.test.tsx 20+ 项全绿     │
│    (测试资产保护铁律)         │ 严禁原子层反向依赖外部 Store    │ 业务层 70+ 单测零修改通过      │
│                               │ 严禁使用 --no-verify 跳过校验   │ check:ui-layer 0 违规          │
└───────────────────────────────┴─────────────────────────────────┴────────────────────────────────┘
```

### 1.2 现状架构断层与违规拓扑剖析

当前前端代码库中，虽然已在 `apps/crish-desktop/src/components/ui/` 建立了 `<Button>`, `<IconButton>`, `<Input>`, `<Tooltip>`, `<Dialog>` 等规范原子，但在桌面骨干视图（侧边栏、设置中心、工作区预览）中存在显著的**“原子层绕过（Bypass）”**与**“私有造轮子”**违规：

1. **裸写组件严重踩踏分层纪律**：
   - 侧边栏头部 `SidebarHeader.tsx` 裸写原生 `<button className={styles.sidebarToggleBtn}>`；
   - 侧边栏导航 `SidebarNav.tsx` 裸写新对话、定时任务 `<button className={styles.navItem}>`，并在 CSS 注释中承认“不走 Button 罩，关掉 ::before 避免叠黑罩”；
   - 侧边栏会话搜索裸写 `<div> + <input type="search">`，自造 WebKit 搜索伪类重置；
   - 侧边栏底栏 `SidebarFooter.tsx` 裸写设置齿轮 `<button className={styles.settingsGearBtn}>`；
   - 用户卡片 `UserProfileCard.tsx` 裸写复合触发按钮 `<button className={styles.userProfileCard}>`；
   - 设置中心 `SettingsSidebar.tsx` 裸写 Tab 分类按钮 `<button className={styles.sidebarTab}>`；
   - 预览工具栏 `PreviewToolbar.tsx` 裸写地址输入框 `<input className={styles.urlInput}>` 与清空按钮。
2. **跨域逆向依赖踩踏解耦红线**：
   - `components/settings/SettingsSidebar.tsx:4` 发生恶劣的跨域逆向引用：`import navStyles from '../sidebar/SidebarNav.module.css';`，直接从 settings 模块借用 sidebar 私有样式，严重违反模块独立性。
3. **私有 CSS 重复膨胀与死代码堆积**：
   - `SettingsPanel.module.css` 遗留了 71 行早就不再调用的历史死代码（`.navBack` 27 行、`.searchWrap` 44 行），加上 `.sidebarTab` 53 行，形成了巨大的维护包袱；
   - 各模块为裸写控件手写了近 400 行高度重复的 hover、active、focus-visible、transition 样式。
4. **光学对齐机制缺位**：
   - `<Button>` 无论是否带图标均使用绝对对称的 `padding: 0 var(--btn-px)`，导致带图标按钮“视觉重心向右偏心”；
   - 全仓大量充斥随意填写的 `strokeWidth={1.75}` 折中值，与 400 Regular 或 500/600 Semibold 字重脱节。

---

## 二、光学平衡数学建模与底层算法落地

### 2.1 缺陷 A：带图标按钮几何对称引发的视觉失衡与数学机理

#### 1. 物理现象与负空间（Negative Space）视错觉成因
根据 `better-ui/surfaces.md` § Optical alignment：
> **Buttons with text + icon**  
> Where an icon makes symmetric padding look unbalanced, use slightly less on the icon side. A starting point:  
> `icon-side padding = text-side padding - 2px`.

在人类视网膜的几何光学感知中，“物理边框”与“视觉边界”存在显著差异：
- **文本侧**：汉字或拉丁字符呈现密集的水平/垂直笔画骨架，字符的字形外框（Ink Bounding Box）实打实地贴近字盒内边缘；
- **图标侧**：矢量图标（如 Lucide 的 16×16 图标）以轮廓线、圆环或开口几何图形构成，其外轮廓与包围盒之间天然存在镂空与白边（负空间）；
- **视错觉结果**：当左内边距与右内边距在数值上完全相等（例如同为 `12px`）时，图标侧由于负空间的存在，视觉中心比物理边框更靠内，导致用户感知到**“图标离左边框太远，文字被挤向右侧，整体右重左轻”**。

```
几何对称时的视觉偏心现象 (Symmetric Padding = 12px)：
┌────────────────────────────────────────────────────────┐
│  [12px]   ( ⊙ )    [6px]   保存配置文案        [12px]  │
└────────────────────────────────────────────────────────┘
  ▲ 视觉留白过大 (12px + 图标内边缘空隙 ≈ 14px)   ▲ 密实文字边界 (12px)
  ==> 感知重心向右偏移约 2px！
```

#### 2. 光学配平算法矩阵
为消除这一视错觉，必须对图标侧内边距施加 **`-2px` 光学微调补偿**：
- **前置图标（Leading Icon, `iconPosition="left"`）**：
  $$\text{padding-inline-start} = \max(0\text{px}, \text{var}(--\text{btn-px}) - 2\text{px})$$
  $$\text{padding-inline-end} = \text{var}(--\text{btn-px})$$
- **后置图标（Trailing Icon, `iconPosition="right"`）**：
  $$\text{padding-inline-start} = \text{var}(--\text{btn-px})$$
  $$\text{padding-inline-end} = \max(0\text{px}, \text{var}(--\text{btn-px}) - 2\text{px})$$
- **纯文本（Text Only）或纯图标（IconButton / No Children）**：保持基线完全对称。

四档标准化尺寸的光学配平矩阵如下：

| 尺寸等级 | 高度 (`--btn-h`) | 基线内边距 (`--btn-px`) | 纯文字内边距 (L / R) | 前置图标光学内边距 (L / R) | 后置图标光学内边距 (L / R) | 光学补偿量 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **xs** | 24px | 6px | 6px / 6px | **4px** / 6px | 6px / **4px** | -2px (33.3% 收口) |
| **sm** | 28px | 10px | 10px / 10px | **8px** / 10px | 10px / **8px** | -2px (20.0% 收口) |
| **md** | 32px | 12px | 12px / 12px | **10px** / 12px | 12px / **10px** | -2px (16.7% 收口) |
| **lg** | 40px | 16px | 16px / 16px | **14px** / 16px | 16px / **14px** | -2px (12.5% 收口) |

### 2.2 原生 O(1) 零测量纯 CSS 方案落地

严禁使用 JavaScript 在运行时测量 DOM 节点的 `getBoundingClientRect()` 或坐标偏移，这会导致严重的 Layout Thrashing。必须采用纯声明式、O(1) 复杂度的 DOM 属性派发与 CSS 计算：

1. **`Button.tsx` 属性判定**：
   当且仅当按钮同时拥有图标（`icon || loading`）与有效文字子节点（`children != null && children !== ''`）时，向根 `<button>` 派发 `data-icon-pos={iconPosition}`：
   ```tsx
   const hasIcon = Boolean(icon || loading);
   const hasText = children != null && children !== '';
   const isOpticallyAsymmetric = hasIcon && hasText;

   return (
     <button
       ref={ref}
       type={type}
       className={classNames}
       data-size={size}
       data-variant={variant}
       data-icon-pos={isOpticallyAsymmetric ? iconPosition : undefined}
       data-active={active || undefined}
       disabled={disabled || loading}
       aria-busy={loading || undefined}
       {...restProps}
     >
       {/* 保持既有单节点 DOM 结构绝对不变 */}
     </button>
   );
   ```

2. **`Button.module.css` 规则注入**：
   使用 CSS 属性选择器与 `max(0px, ...)` 进行安全计算，防止极小尺寸下内边距下溢为负值：
   ```css
   /* 前置图标：左侧内边距光学削减 2px，实现视觉重心居中 */
   .button[data-icon-pos='left'] {
     padding-left: max(0px, calc(var(--btn-px) - 2px));
     padding-right: var(--btn-px);
   }

   /* 后置图标：右侧内边距光学削减 2px，实现视觉重心居中 */
   .button[data-icon-pos='right'] {
     padding-left: var(--btn-px);
     padding-right: max(0px, calc(var(--btn-px) - 2px));
   }
   ```

```
光学补正后的视觉平衡 (data-icon-pos="left", L=10px, R=12px)：
┌────────────────────────────────────────────────────────┐
│  [10px]   ( ⊙ )    [6px]   保存配置文案        [12px]  │
└────────────────────────────────────────────────────────┘
  ▲ 视觉重心完美对称居中 (10px + 2px 镂空 ≈ 12px)   ▲ 密实边界 (12px)
```

---

### 2.3 缺陷 B：图标描边与文字字重脱节问题深剖

根据 `better-ui/icons.md` § Match icon stroke to text weight：
> “A hairline icon beside semibold text reads as broken; a heavy icon beside regular text shouts.”

界面的光学灰度一致性要求：**图标的墨水覆盖率（Ink Coverage）必须与相邻文字笔画粗细保持同频**：
- **Regular 400（常规体，正文/占位/副文本）**：文字笔画纤细，图标描边必须收敛至 `1.5px`。若使用 1.75px 或 2.0px，图标将化身为“视觉黑洞”，产生不必要的视觉干扰；
- **Medium 500 / Semibold 600（中粗/半粗体，激活项/按钮/重要标题）**：文字笔画厚实，图标描边必须提升至 `2.0px`。若低于 2.0px，图标将显得孱弱发虚、断裂不全；
- **Bold 700 / 强调特写**：独立强视觉图标使用 `2.5px`。

全仓存在 10 余处随手硬编码 `strokeWidth={1.75}` 的情况，陷入两头失衡。必须彻底清理并收敛。

### 2.4 图标 strokeWidth 与字重正交规范及常量定义

建立全局图标描边与字重联动映射，在 `apps/crish-desktop/src/components/ui/tokens.ts`（或 `components/ui/` 内部常量）中统一定义：

```ts
/**
 * 图标描边与字重正交契约常量（Jakub Krehel Optics Standard）
 * - normal (400 Regular) -> 1.5px (消除黑洞感)
 * - medium (500~600 Semibold) -> 2.0px (杜绝线条发虚)
 * - bold (700+ Bold) -> 2.5px (强调特写)
 */
export const ICON_STROKE_BY_WEIGHT = {
  normal: 1.5,
  medium: 2.0,
  bold: 2.5,
} as const;
```

各业务组件在渲染 Lucide 图标时，严格按照上下文状态绑定：
- 普通状态 / 400 字重：`strokeWidth={1.5}`；
- 激活态 / 选中态 / 500~600 字重（如 `isTabActive`, `scheduledActive`）：`strokeWidth={2.0}`。

---

## 三、业务层 8 处原生 Button 与 4 处原生 Input 换装详案

本章对业务层 8 处原生 `<button>` 与 4 处原生 `<input>` 逐项给出精准的重构清单与替换规格：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              业务层 8 处 Button + 4 处 Input 全面换装对照总表                           │
├────┬─────────────────────────────┬──────────────────────────┬─────────────────────────────┬────────────┤
│ 序 │ 所在文件与行号              │ 原始裸写与私有类名       │ 换装目标原子组件与规格      │ 核心收益   │
├────┼─────────────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┤
│ 1  │ `SidebarHeader.tsx:47-57`   │ `<button>` +             │ `<IconButton size="md"`     │ 内置 Focus │
│    │ (SidebarToggle 折叠按钮)    │ `.sidebarToggleBtn`      │ `  variant="ghost" />`      │ Ring，去重 │
├────┼─────────────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┤
│ 2  │ `SidebarHeader.tsx:94-104`  │ `<button>` +             │ `<IconButton size="md"`     │ 32px 标尺，│
│    │ (顶栏内部折叠按钮)          │ `.sidebarToggleBtn`      │ `  variant="ghost" />`      │ A11y 闭环  │
├────┼─────────────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┤
│ 3  │ `SidebarFooter.tsx:27-43`   │ `<button>` +             │ `<IconButton size="md"`     │ 统一齿轮与 │
│    │ (设置齿轮按钮)              │ `.settingsGearBtn`       │ `  variant="ghost" />`      │ 红点微脉冲 │
├────┼─────────────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┤
│ 4  │ `SidebarNav.tsx:24-46`      │ `<button>` +             │ `<Button variant="ghost"`   │ -2px 光学，│
│    │ (新对话按钮)                │ `.navItem`               │ `  size="md" block />`      │ 消除黑罩hack│
├────┼─────────────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┤
│ 5  │ `SidebarNav.tsx:47-56`      │ `<button>` +             │ `<Button variant="ghost"`   │ 语义激活态，│
│    │ (定时任务按钮)              │ `.navItem.isActive`      │ `  size="md" block />`      │ 2.0px 图标 │
├────┼─────────────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┤
│ 6  │ `SidebarNav.tsx:57-72`      │ `<input type="search">`  │ `<Input variant="search"`   │ IME 保护锁，│
│    │ (会话搜索过滤框)            │ + `.navItem[role=search]`│ `  size="md" clearable />`  │ 拔除自造CSS│
├────┼─────────────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┤
│ 7  │ `UserProfileCard.tsx:31-57` │ `<button>` +             │ `<Button bare`              │ 标准原子契 │
│    │ (用户卡片触发器)            │ `.userProfileCard`       │ `  type="button" />`        │ 约，A11y名 │
├────┼─────────────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┤
│ 8  │ `SettingsSidebar.tsx:96-118`│ `<input type="search">`  │ `<Input variant="search"`   │ **拔除跨域**│
│    │ (设置搜索过滤框)            │ + 借用 `navStyles`       │ `  size="sm" clearable />`  │ **逆向引用**│
├────┼─────────────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┤
│ 9  │ `SettingsSidebar.tsx:149`   │ `<button>` +             │ `<Button variant=ghost|sec` │ 自动 1.5/2.0│
│    │ (设置分类 Tab 列表项)       │ `.sidebarTab`            │ `  size="sm" block />`      │ 图标联动   │
├────┼─────────────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┤
│ 10 │ `SettingsPanel.module.css`  │ `.searchWrap, .search`   │ 彻底清退（TSX 接入原子      │ 清除 44 行 │
│    │ (历史死搜索样式)            │ (44 行无主死代码)        │  `<Input variant="search">`）│ 历史死代码 │
├────┼─────────────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┤
│ 11 │ `PreviewToolbar.tsx:163`    │ `<input>` +              │ `<Input variant="search"`   │ IME 防回车 │
│    │ (浏览器地址栏输入框)        │ `.urlInput`              │ `  size="sm" clearable />`  │ 清除私有类 │
├────┼─────────────────────────────┼──────────────────────────┼─────────────────────────────┼────────────┤
│ 12 │ `PreviewToolbar.tsx:176`    │ 手写清空 `<Button>` +    │ 由 `<Input clearable>`      │ 减少 1 处  │
│    │ (地址栏清空按钮)            │ `.urlClear`              │ 原生内置清空统一接管        │ 冗余 DOM   │
└────┴─────────────────────────────┴──────────────────────────┴─────────────────────────────┴────────────┘
```

### 3.1 `SettingsPanel.tsx` / `SettingsSidebar.tsx` 搜索框（换装 `<Input variant="search" size="sm" />`）

- **现状问题**：
  `SettingsSidebar.tsx` 逆向导入 `../sidebar/SidebarNav.module.css` 作为其搜索栏包裹容器，内部裸写 `<input type="search">`；而 `SettingsPanel.module.css` 内部却维护了一整套包含 44 行的 `.searchWrap`、`.searchIco`、`.search` 等死样式代码，二者死活混杂。此外，裸 `<input>` 缺乏 IME 拼音输入保护状态机。
- **换装方案**：
  1. 拔除 `SettingsSidebar.tsx` 对 `SidebarNav.module.css` 的 import；
  2. 采用 `<Input variant="search" size="sm">`，装配 `clearable`、`prefixIcon` 与 IME 回车拦截：
  ```tsx
  <Input
    ref={searchInputRef}
    id={searchId}
    variant="search"
    size="sm"
    placeholder="搜索设置…"
    value={searchQuery}
    onChange={(e) => onSearchChange(e.target.value)}
    onKeyDown={onSearchKeyDown}
    prefixIcon={<Lucide.Search size={14} strokeWidth={1.5} aria-hidden="true" />}
    clearable
    onClear={() => onSearchChange('')}
    aria-label="搜索设置分类"
    aria-controls={tablistId}
    aria-describedby={statusId}
    autoComplete="off"
    spellCheck={false}
  />
  ```

### 3.2 `SettingsSidebar.tsx` Tab 按钮（换装 `<Button variant={isTabActive ? 'secondary' : 'ghost'} size="sm" block />`）

- **现状问题**：
  在 `SettingsSidebar.tsx:149-168` 中裸写 `<button className={`${styles.sidebarTab} ${isTabActive ? styles.active : ''}`}>`，并在 `SettingsPanel.module.css:218-270` 维护了 53 行私有样式的 hover、active 与图标容器。
- **换装方案**：
  采用标准 `<Button>`，未激活为 `ghost` 变体，激活时切换为 `secondary` 纯白实体卡片（深色模式下为精致暗卡片），图标动态注入 1.5 / 2.0 strokeWidth：
  ```tsx
  <Tooltip content={tab.keywords.slice(0, 4).join(' · ')}>
    <Button
      id={tabBtnId}
      role="tab"
      variant={isTabActive ? 'secondary' : 'ghost'}
      size="sm"
      block
      active={isTabActive}
      aria-selected={isTabActive}
      aria-controls={isTabActive ? panelId : undefined}
      tabIndex={isRoving ? 0 : -1}
      aria-label={`${tab.group} · ${tab.label}`}
      onClick={() => onSelect(tab.id)}
      onFocus={() => onFocusTab(tab.id)}
      data-testid={`settings-tab-${tab.id}`}
      data-settings-tab-id={tab.id}
      icon={<Icon size={16} strokeWidth={isTabActive ? 2.0 : 1.5} />}
    >
      {tab.label}
    </Button>
  </Tooltip>
  ```

### 3.3 `SidebarHeader.tsx` 折叠按钮（换装 `<IconButton variant="ghost" size="md" />`）

- **现状问题**：
  在 `SidebarToggle`（L47-57）与 `SidebarHeader`（L94-104）两处均使用 `<Tooltip><button className={styles.sidebarToggleBtn}>`，并在 `Sidebar.module.css:84-115` 手写了 32 行私有样式，粗暴重置 `box-shadow: none`，丢失焦点指示。
- **换装方案**：
  换装为自带 Tooltip 能力的 `<IconButton size="md" variant="ghost">`，享受原子组件合规的 3%~10% 克制软灰 Focus Ring：
  ```tsx
  <IconButton
    size="md"
    variant="ghost"
    tooltip={toggleLabel}
    aria-label={toggleLabel}
    aria-expanded={!collapsed}
    aria-controls="crish-sidebar"
    data-testid="sidebar-toggle"
    onClick={onToggle}
    icon={<IconSidebarLeft size={16} strokeWidth={1.5} aria-hidden="true" />}
  />
  ```

### 3.4 `SidebarFooter.tsx` 设置齿轮按钮（换装 `<IconButton variant="ghost" size="md" />`）

- **现状问题**：
  在 `SidebarFooter.tsx:27-43` 中裸写 `<button className={styles.settingsGearBtn}>`，并在 `Sidebar.module.css:258-286` 手写了 29 行私有样式。同一 Footer 内的“更新”按钮使用了标准 `<Button>`，齿轮却裸写，标准割裂。
- **换装方案**：
  换装为 `<IconButton size="md" variant="ghost">`，将齿轮图标与红点徽标作为复合节点传入：
  ```tsx
  <IconButton
    size="md"
    variant="ghost"
    tooltip={tooltipText}
    aria-label={tooltipText}
    aria-pressed={showSettings}
    active={showSettings}
    data-testid="sidebar-settings-gear-btn"
    onClick={() => toggleSettingsOverlay()}
    icon={
      <>
        <Lucide.Settings size={16} strokeWidth={1.5} aria-hidden />
        {updateAvailable && (
          <span
            className={styles.gearUpdatePulseDot}
            aria-label="新版本可用提示"
          />
        )}
      </>
    }
  />
  ```

### 3.5 `SidebarNav.tsx` 导航按钮与会话过滤输入框

- **现状问题**：
  - “新对话”与“定时任务”裸写 `<button className={styles.navItem}>`；
  - 搜索框裸写 `<div> + <input type="search">`，并在 `SidebarNav.module.css` 维护了 99 行包含 WebKit 伪类重置、强制禁用 ::before 黑罩的私有样式。
- **换装方案**：
  - **新对话按钮**：
    换装为 `<Button variant="ghost" size="md" block>`，图标描边提升至 `2.0px`，自动享受 `-2px` 光学内边距补正：
    ```tsx
    <Button
      variant="ghost"
      size="md"
      block
      data-testid="new-session-button"
      onClick={onNewSession}
      icon={
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.0}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M11 3H7.5A4.5 4.5 0 0 0 3 7.5v9A4.5 4.5 0 0 0 7.5 21h9a4.5 4.5 0 0 0 4.5-4.5v-6" />
          <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
        </svg>
      }
    >
      新对话
    </Button>
    ```
  - **定时任务按钮**：
    换装为 `<Button variant="ghost" size="md" block>`，绑定 `active={scheduledActive}`，图标根据激活态在 1.5 与 2.0 之间动态切换：
    ```tsx
    <Button
      variant="ghost"
      size="md"
      block
      active={scheduledActive}
      aria-pressed={scheduledActive}
      data-testid="sidebar-nav-scheduled"
      onClick={onOpenScheduled}
      icon={
        <Lucide.Clock
          size={16}
          strokeWidth={scheduledActive ? 2.0 : 1.5}
          aria-hidden
        />
      }
    >
      定时任务
    </Button>
    ```
  - **会话搜索框**：
    换装为 `<Input variant="search" size="md">`，自带 IME 组合输入锁与清空能力：
    ```tsx
    <Input
      variant="search"
      size="md"
      placeholder="搜索会话与消息…"
      aria-label="搜索会话与消息"
      value={searchInput}
      onChange={(e) => onSearchChange(e.target.value)}
      prefixIcon={<Lucide.Search size={16} strokeWidth={1.5} aria-hidden="true" />}
      clearable
      onClear={() => onSearchChange('')}
    />
    ```

### 3.6 `UserProfileCard.tsx` 触发按钮（换装 `<Button bare />`）

- **现状问题**：
  在 `UserProfileCard.tsx:31-57` 中，为接收 `SettingsQuickMenu` 弹窗触发属性，手写了原生 `<button className={styles.userProfileCard}>`，并在 `Sidebar.module.css:163-192` 维护了 30 行私有按钮状态样式。
- **换装方案**：
  使用专门为复合排版设计的 `<Button bare>` 契约接管。`<Button bare>` 具备纯净单节点 DOM，透传所有原生属性并自动处理 disabled/loading 语义：
  ```tsx
  <SettingsQuickMenu
    renderTrigger={({ open, triggerProps }) => (
      <Button
        bare
        type="button"
        className={`${styles.userProfileCard}${open ? ` ${styles.isOpen}` : ''}`}
        data-testid="user-profile-card"
        aria-label={`用户卡片：${activeUser}，点击打开快捷菜单`}
        {...triggerProps}
      >
        <div className={styles.userAvatarContainer}>
          <div className={styles.userAvatar}>
            <Lucide.User size={15} strokeWidth={1.5} aria-hidden />
          </div>
          <span
            className={`${styles.userOnlineStatus}${!isLoggedIn ? ` ${styles.userOfflineStatus}` : ''}`}
            aria-label={isLoggedIn ? '在线' : '离线'}
          />
        </div>
        <div className={styles.userTextStack}>
          <span className={styles.userName}>{activeUser}</span>
          <span className={styles.userWorkspace}>{activeWorkspace}</span>
        </div>
        <Lucide.ChevronsUpDown
          size={13}
          strokeWidth={1.5}
          className={styles.userChevron}
          aria-hidden
        />
      </Button>
    )}
  />
  ```

### 3.7 `PreviewToolbar.tsx` 地址输入框（换装 `<Input variant="search" size="sm" />`）

- **现状问题**：
  在 `PreviewToolbar.tsx:148-187` 中手写了 `<form className={styles.urlForm}>`，内嵌原生 `<input className={styles.urlInput}>` 与额外的清空按钮 `<Button className={styles.urlClear}>`，并在 `PreviewCard.module.css:94-135` 维护了 42 行私有样式。
- **换装方案**：
  换装为 `<Input variant="search" size="sm">`，利用组件内建的 `prefixIcon` 与 `clearable` 属性，直接拔除独立的清空 Button 节点与私有 CSS：
  ```tsx
  <form
    className={styles.urlForm}
    aria-label="预览地址栏"
    onSubmit={(e) => {
      e.preventDefault();
      onUrlSubmit(urlInput.trim() ? urlInput : 'about:blank');
    }}
  >
    <Input
      variant="search"
      size="sm"
      className={styles.previewUrlInput}
      value={urlInput}
      placeholder="localhost:5173 或 https://…"
      onChange={(e) => onUrlChange(e.target.value)}
      prefixIcon={<Lucide.Globe size={14} strokeWidth={1.5} aria-hidden />}
      clearable
      onClear={onClearUrl}
      spellCheck={false}
      aria-label="预览地址"
      autoComplete="off"
      inputMode="url"
      enterKeyHint="go"
    />
  </form>
  ```

### 3.8 顶栏帮助入口与窗控（`AppTopBar.tsx` / `WindowControls.tsx`）辅助收敛

- **`AppTopBar.tsx:58-70`**：
  原实现虽引入 Button，但通过 `.helpBtn` 暴力覆盖尺寸（28x28）并重写 hover，清退为 `<IconButton size="sm" variant="ghost">`，删除 `AppTopBar.module.css:57-84`（-28 行）；
- **`WindowControls.tsx:73-116`**：
  原实现使用裸 hex 颜色 `#e81123`，收敛为 `<IconButton size="sm" variant="plain">`，通过 `--color-error` / `--text-on-accent` 接入，消除 `WindowControls.module.css:9-35`（-27 行）。

---

## 四、“删什么/收敛什么”专章与净负产出（Net-Negative LOC）矩阵

### 4.1 彻底清除的业务私有 CSS 选择器全集清单

通过将所有裸写控件换装接入原子层，以下私有 CSS 类名及其伪类、修饰符将被**100% 连根拔除**：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                彻底清除的私有 CSS 类名与选择器清单                                 │
├──────────────────────────────┬───────────────────────────────────────────────────────────────────┤
│ 模块与文件                   │ 待删除的私有选择器与伪类                                          │
├──────────────────────────────┼───────────────────────────────────────────────────────────────────┤
│ `Sidebar.module.css`         │ `.sidebarToggleBtn`                                               │
│                              │ `.sidebarToggleBtn:hover`                                         │
│                              │ `.sidebarToggleBtn:active`                                        │
│                              │ `.settingsGearBtn`                                                │
│                              │ `.settingsGearBtn:hover`                                          │
│                              │ `.settingsGearBtn:active`                                         │
│                              │ `.settingsGearBtn.isOpen`                                         │
│                              │ `.userProfileCard:hover` (仅保留基础盒模型布局)                  │
│                              │ `.userProfileCard:active`                                         │
│                              │ `.userProfileCard.isOpen`                                         │
├──────────────────────────────┼───────────────────────────────────────────────────────────────────┤
│ `SidebarNav.module.css`      │ `.navItem`                                                        │
│                              │ `.navItem::before` (历史关闭黑罩 hack)                           │
│                              │ `.navItem svg`                                                    │
│                              │ `.navItem:hover`                                                  │
│                              │ `.navItem:hover svg`                                              │
│                              │ `.navItem.isActive`                                               │
│                              │ `.navItem.isActive:hover`                                         │
│                              │ `.navItem.isActive svg`                                           │
│                              │ `.navItem:focus-visible`                                          │
│                              │ `.navItem[role='search']`                                         │
│                              │ `.navItem input[type='search']`                                   │
│                              │ `.navItem input[type='search']::placeholder`                      │
│                              │ `::-webkit-search-cancel-button` 等 4 个 WebKit 伪类重置          │
├──────────────────────────────┼───────────────────────────────────────────────────────────────────┤
│ `SettingsPanel.module.css`   │ `.navBack` (历史死代码)                                           │
│                              │ `.navBack:hover` (历史死代码)                                     │
│                              │ `.searchWrap` (历史死代码)                                        │
│                              │ `.searchIco` (历史死代码)                                         │
│                              │ `.search` (历史死代码)                                            │
│                              │ `.search::placeholder` (历史死代码)                               │
│                              │ `.search:focus, .search:focus-visible` (历史死代码)               │
│                              │ `.sidebarTab`                                                     │
│                              │ `.sidebarTab:hover`                                               │
│                              │ `.sidebarTab.active`                                              │
│                              │ `.sidebarTabIco`                                                  │
│                              │ `.sidebarTab.active .sidebarTabIco`                               │
│                              │ `.sidebarTab.active svg`                                          │
├──────────────────────────────┼───────────────────────────────────────────────────────────────────┤
│ `PreviewCard.module.css`     │ `.urlIco`                                                         │
│                              │ `.urlInput`                                                       │
│                              │ `.urlClear`                                                       │
│                              │ `.urlClear:hover`                                                 │
│                              │ `.urlClear:focus-visible`                                         │
├──────────────────────────────┼───────────────────────────────────────────────────────────────────┤
│ `AppTopBar.module.css`       │ `.helpBtn`                                                        │
│                              │ `.helpBtn:hover`                                                  │
│                              │ `.helpBtn:active`                                                 │
├──────────────────────────────┼───────────────────────────────────────────────────────────────────┤
│ `WindowControls.module.css`  │ `.winBtn` 尺寸边框覆盖                                            │
│                              │ `.winBtn:hover`, `.winBtn:active`                                 │
│                              │ 裸硬编码 `#e81123`, `#ffffff`                                     │
└──────────────────────────────┴───────────────────────────────────────────────────────────────────┘
```

### 4.2 彻底拔除的跨模块逆向依赖与死代码清退清单

1. **拔除跨域逆向依赖**：
   - 彻底删除 `apps/crish-desktop/src/components/settings/SettingsSidebar.tsx:4` 中的：
     ```ts
     import navStyles from '../sidebar/SidebarNav.module.css'; // ◀ 彻底拔除！
     ```
   - 彻底解除 settings 模块对 sidebar 模块的私有 CSS 捆绑，实现纯粹的拓扑正交。
2. **彻底清退历史死代码**：
   - 清除 `SettingsPanel.module.css` 中的 `.navBack`（27 行，TSX 早已改用 Button）；
   - 清除 `SettingsPanel.module.css` 中的 `.searchWrap`, `.search` 等一套完整搜索样式（44 行，TSX 此前错从 sidebar 借用样式，此部分为 100% 死代码）。

### 4.3 物理文件行数净消减量化核算表

遵循主控“重构必须有确凿删除面与净负产出”的铁律，DIM-03 的物理代码行数净消减量化核算如下：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               DIM-03 物理代码行数净消减量化核算表                                  │
├───────────────────────────────────┬──────────────────────────────┬───────────────┬───────────────┤
│ 物理文件路径                      │ 待清除/收敛的代码块          │ 拟删除行数    │ 拟新增/净消减 │
├───────────────────────────────────┼──────────────────────────────┼───────────────┼───────────────┤
│ `SettingsPanel.module.css`        │ 拔除 .navBack 死代码 (L58-84)│ -27 行        │               │
│                                   │ 拔除 .search* 死代码 (L85-128│ -44 行        │               │
│                                   │ 拔除 .sidebarTab (L218-270)  │ -53 行        │ **净减 124行**│
├───────────────────────────────────┼──────────────────────────────┼───────────────┼───────────────┤
│ `Sidebar.module.css`              │ 拔除 .sidebarToggleBtn(84-115│ -32 行        │               │
│                                   │ 收敛 .userProfileCard(163-192│ -30 行        │               │
│                                   │ 拔除 .settingsGearBtn(258-286│ -29 行        │ **净减 91行** │
├───────────────────────────────────┼──────────────────────────────┼───────────────┼───────────────┤
│ `SidebarNav.module.css`           │ 拔除 .navItem (L10-78)       │ -69 行        │               │
│                                   │ 拔除 search 裸样式 (L79-108) │ -30 行        │ **净减 99行** │
├───────────────────────────────────┼──────────────────────────────┼───────────────┼───────────────┤
│ `PreviewCard.module.css`          │ 拔除 .urlInput/.urlClear 等  │ -42 行        │ **净减 38行** │
├───────────────────────────────────┼──────────────────────────────┼───────────────┼───────────────┤
│ `AppTopBar.module.css`            │ 拔除 .helpBtn 私有覆盖(57-84)│ -28 行        │ **净减 28行** │
├───────────────────────────────────┼──────────────────────────────┼───────────────┼───────────────┤
│ `WindowControls.module.css`       │ 拔除 .winBtn 私有覆盖 (9-35) │ -27 行        │ **净减 27行** │
├───────────────────────────────────┴──────────────────────────────┴───────────────┼───────────────┤
│ **CSS 私有样式净消减总计**                                                       │ **-407 行**   │
│ (硬性门禁指标: ≥ 362 行，核算达成率: 112.4%)                                     │ (超额完成45行)│
├───────────────────────────────────┬──────────────────────────────┬───────────────┼───────────────┤
│ `Button.tsx` / `Button.module.css`│ 注入 -2px 光学补正与属性派发 │ +0 / -0       │ +16 行基座增强│
├───────────────────────────────────┴──────────────────────────────┴───────────────┼───────────────┤
│ **DIM-03 全域综合代码净负产出 (Net-Negative LOC)**                               │ **≤ -391 行** │
└──────────────────────────────────────────────────────────────────────────────────┴───────────────┘
```

---

## 五、逐文件代码前后完整 Diff 对照

### 5.1 原子层基座增强 Diff：`Button.tsx` 与 `Button.module.css`

#### 1. `apps/crish-desktop/src/components/ui/Button/Button.tsx`
```diff
@@ -86,6 +86,10 @@ export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
       return (
         <button
           ref={ref}
           type={type}
           className={className}
           disabled={disabled || loading}
           aria-busy={loading || undefined}
           {...restProps}
         >
           {children}
         </button>
       );
     }
 
+    const hasIcon = Boolean(icon || loading);
+    const hasText = children != null && children !== '';
+    const isOpticallyAsymmetric = hasIcon && hasText;
+
     const classNames = [
       styles.button,
       VARIANT_CLASS[variant],
@@ -111,6 +115,7 @@ export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
         type={type}
         className={classNames}
         data-size={size}
         data-variant={variant}
+        data-icon-pos={isOpticallyAsymmetric ? iconPosition : undefined}
         data-active={active || undefined}
         disabled={disabled || loading}
         aria-busy={loading || undefined}
```

#### 2. `apps/crish-desktop/src/components/ui/Button/Button.module.css`
```diff
@@ -49,6 +49,16 @@
   gap: var(--btn-gap);
 }
 
+/* 光学平衡补偿：带图标按钮在图标侧微减 2px，消除视错觉偏心 (better-ui) */
+.button[data-icon-pos='left'] {
+  padding-left: max(0px, calc(var(--btn-px) - 2px));
+  padding-right: var(--btn-px);
+}
+
+.button[data-icon-pos='right'] {
+  padding-left: var(--btn-px);
+  padding-right: max(0px, calc(var(--btn-px) - 2px));
+}
+
 /* 物理微光交互层 (Opacity Transition) */
 .button::before {
   content: '';
```

---

### 5.2 侧边栏头部换装 Diff：`SidebarHeader.tsx` 与 `Sidebar.module.css`

#### 1. `apps/crish-desktop/src/components/sidebar/SidebarHeader.tsx`
```diff
@@ -6,6 +6,7 @@
 import React, { useMemo } from 'react';
 import styles from './Sidebar.module.css';
 import { IconSidebarLeft } from './SidebarIcons';
-import { Tooltip } from '../ui';
+import { IconButton } from '../ui';
 
 export const SidebarToggle: React.FC<{
   collapsed: boolean;
@@ -44,18 +45,16 @@ export const SidebarToggle: React.FC<{
     <div
       className={`${styles.sidebarHeader} sidebar-header`}
       data-mac={isMacDesktop ? 'true' : 'false'}
     >
-      <Tooltip content={toggleLabel}>
-        <button
-          type="button"
-          className={`${styles.sidebarToggleBtn} sidebar-toggle-btn`}
-          data-testid="sidebar-toggle"
-          aria-label={toggleLabel}
-          aria-expanded={!collapsed}
-          aria-controls="crish-sidebar"
-          onClick={onToggle}
-        >
-          <IconSidebarLeft size={16} aria-hidden="true" />
-        </button>
-      </Tooltip>
+      <IconButton
+        size="md"
+        variant="ghost"
+        tooltip={toggleLabel}
+        aria-label={toggleLabel}
+        aria-expanded={!collapsed}
+        aria-controls="crish-sidebar"
+        data-testid="sidebar-toggle"
+        onClick={onToggle}
+        icon={<IconSidebarLeft size={16} strokeWidth={1.5} aria-hidden="true" />}
+      />
     </div>
   );
@@ -91,18 +90,16 @@ export const SidebarHeader: React.FC<SidebarHeaderProps> = React.memo(
         <header className={styles.sidebarHeaderBar} role="banner">
           <div className={styles.sidebarHeaderLeft}>
             {onToggle && (
-              <Tooltip content={toggleLabel}>
-                <button
-                  type="button"
-                  className={`${styles.sidebarToggleBtn} sidebar-toggle-btn`}
-                  data-testid="sidebar-header-toggle"
-                  aria-label={toggleLabel}
-                  aria-expanded={!collapsed}
-                  aria-controls="crish-sidebar"
-                  onClick={onToggle}
-                >
-                  <IconSidebarLeft size={16} aria-hidden="true" />
-                </button>
-              </Tooltip>
+              <IconButton
+                size="md"
+                variant="ghost"
+                tooltip={toggleLabel}
+                aria-label={toggleLabel}
+                aria-expanded={!collapsed}
+                aria-controls="crish-sidebar"
+                data-testid="sidebar-header-toggle"
+                onClick={onToggle}
+                icon={<IconSidebarLeft size={16} strokeWidth={1.5} aria-hidden="true" />}
+              />
             )}
           </div>
```

#### 2. `apps/crish-desktop/src/components/sidebar/Sidebar.module.css`
```diff
@@ -82,34 +82,6 @@
   padding-left: 70px;
 }
 
-.sidebarToggleBtn {
-  width: 32px;
-  height: 32px;
-  min-width: 32px;
-  min-height: 32px;
-  display: inline-flex;
-  align-items: center;
-  justify-content: center;
-  background: transparent;
-  border: none;
-  border-radius: var(--radius-md);
-  color: var(--text-tertiary);
-  cursor: pointer;
-  padding: 0;
-  margin: 0;
-  box-shadow: none;
-  transition:
-    background-color var(--transition-fast, 150ms ease-out),
-    color var(--transition-fast, 150ms ease-out);
-  -webkit-app-region: no-drag !important;
-  app-region: no-drag !important;
-  pointer-events: auto;
-}
-
-.sidebarToggleBtn:hover {
-  background: var(--tint-hover);
-  color: var(--text-primary);
-}
-
-.sidebarToggleBtn:active {
-  background: var(--tint-active);
-}
-
 .sidebarTop {
```

---

### 5.3 侧边栏导航与搜索换装 Diff：`SidebarNav.tsx` 与 `SidebarNav.module.css`

#### 1. `apps/crish-desktop/src/components/sidebar/SidebarNav.tsx`
```diff
@@ -1,6 +1,7 @@
 import React from 'react';
 import styles from './SidebarNav.module.css';
 import * as Lucide from 'lucide-react';
+import { Button, Input } from '../ui';
 
 export interface SidebarNavProps {
   activeNav: string;
@@ -21,52 +22,50 @@ export const SidebarNav: React.FC<SidebarNavProps> = ({
   const scheduledActive = activeNav === 'scheduled';
   return (
     <div className={styles.topActions}>
-      <button
-        type="button"
-        className={styles.navItem}
+      <Button
+        variant="ghost"
+        size="md"
+        block
         data-testid="new-session-button"
         onClick={onNewSession}
+        icon={
+          <svg
+            width={16}
+            height={16}
+            viewBox="0 0 24 24"
+            fill="none"
+            stroke="currentColor"
+            strokeWidth={2.0}
+            strokeLinecap="round"
+            strokeLinejoin="round"
+            aria-hidden="true"
+          >
+            <path d="M11 3H7.5A4.5 4.5 0 0 0 3 7.5v9A4.5 4.5 0 0 0 7.5 21h9a4.5 4.5 0 0 0 4.5-4.5v-6" />
+            <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
+          </svg>
+        }
       >
-        {/* 自定义新建对话图标：软圆角开口方 + 钢笔，右上留缺口避免与笔身重合 */}
-        <svg
-          width={16}
-          height={16}
-          viewBox="0 0 24 24"
-          fill="none"
-          stroke="currentColor"
-          strokeWidth={1.75}
-          strokeLinecap="round"
-          strokeLinejoin="round"
-          aria-hidden="true"
-        >
-          <path d="M11 3H7.5A4.5 4.5 0 0 0 3 7.5v9A4.5 4.5 0 0 0 7.5 21h9a4.5 4.5 0 0 0 4.5-4.5v-6" />
-          <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
-        </svg>
-        <span>新对话</span>
-      </button>
-      <button
-        type="button"
-        className={`${styles.navItem}${scheduledActive ? ` ${styles.isActive}` : ''}`}
+        新对话
+      </Button>
+      <Button
+        variant="ghost"
+        size="md"
+        block
+        active={scheduledActive}
         data-testid="sidebar-nav-scheduled"
         aria-pressed={scheduledActive}
         onClick={onOpenScheduled}
+        icon={
+          <Lucide.Clock
+            size={16}
+            strokeWidth={scheduledActive ? 2.0 : 1.5}
+            aria-hidden
+          />
+        }
       >
-        <Lucide.Clock size={16} strokeWidth={1.75} aria-hidden />
-        <span>定时任务</span>
-      </button>
+        定时任务
+      </Button>
       {onSearchChange && (
-        <div
-          className={`${styles.navItem} no-drag`}
-          role="search"
-          aria-label="会话搜索"
-        >
-          <Lucide.Search size={16} strokeWidth={1.75} aria-hidden="true" />
-          <input
-            type="search"
-            placeholder="搜索会话与消息…"
-            aria-label="搜索会话与消息"
-            value={searchInput}
-            onChange={(e) => onSearchChange(e.target.value)}
-          />
-        </div>
+        <Input
+          variant="search"
+          size="md"
+          placeholder="搜索会话与消息…"
+          aria-label="搜索会话与消息"
+          value={searchInput}
+          onChange={(e) => onSearchChange(e.target.value)}
+          prefixIcon={<Lucide.Search size={16} strokeWidth={1.5} aria-hidden="true" />}
+          clearable
+          onClear={() => onSearchChange('')}
+        />
       )}
     </div>
```

#### 2. `apps/crish-desktop/src/components/sidebar/SidebarNav.module.css`
```diff
@@ -7,98 +7,6 @@
 }
 
-.navItem {
-  --btn-hover-overlay: transparent;
-  --btn-active-overlay: transparent;
-  --btn-radius: var(--radius-lg);
-  --btn-h: var(--control-height);
-  display: flex;
-  align-items: center;
-  justify-content: flex-start;
-  gap: var(--space-2);
-  width: 100%;
-  height: var(--control-height);
-  min-height: var(--control-height);
-  border: 1px solid transparent;
-  background: transparent;
-  color: var(--text-secondary);
-  font-family: inherit;
-  font-size: var(--font-size-base, 14px);
-  font-weight: var(--font-weight-medium);
-  padding: 0 8px;
-  border-radius: var(--radius-lg);
-  cursor: pointer;
-  text-align: left;
-  appearance: none;
-  -webkit-appearance: none;
-  transition:
-    background var(--transition-micro),
-    color var(--transition-micro);
-  box-sizing: border-box;
-}
-
-/* 关掉 ui/Button ::before，避免暖褐 --sidebar-hover 再叠 6% 黑罩 */
-.navItem::before {
-  content: none;
-  display: none;
-}
-
-.navItem svg {
-  width: var(--icon-size);
-  height: var(--icon-size);
-  flex-shrink: 0;
-  color: var(--text-tertiary);
-}
-
-.navItem:hover {
-  background: var(--sidebar-hover);
-  color: var(--text-primary);
-  border-color: transparent;
-}
-
-.navItem:hover svg {
-  color: var(--text-secondary);
-}
-
-.navItem.isActive,
-.navItem.isActive:hover {
-  background: var(--sidebar-active);
-  color: var(--text-primary);
-  border-color: transparent;
-}
-
-.navItem.isActive svg {
-  color: var(--text-primary);
-}
-
-.navItem:focus-visible {
-  outline: none;
-  box-shadow: var(--focus-ring, 0 0 0 2px var(--tint-focus-ring));
-}
-
-/* Specific to search input */
-.navItem[role='search'] {
-  cursor: text;
-}
-
-.navItem input[type='search'] {
-  flex: 1 1 auto;
-  min-width: 0;
-  border: none;
-  outline: none;
-  background: transparent;
-  font: inherit;
-  font-size: var(--font-size-base);
-  color: var(--text-primary);
-  padding: 0;
-}
-
-.navItem input[type='search']::placeholder {
-  color: var(--text-secondary);
-  opacity: 0.9;
-}
-
-.navItem input[type='search']::-webkit-search-cancel-button,
-.navItem input[type='search']::-webkit-search-results-button,
-.navItem input[type='search']::-webkit-search-results-decoration {
-  -webkit-appearance: none;
-  appearance: none;
-  display: none;
-}
-
 /* 自治响应侧栏折叠状态 */
```

---

### 5.4 侧边栏底栏齿轮换装 Diff：`SidebarFooter.tsx` 与 `Sidebar.module.css`

#### 1. `apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx`
```diff
@@ -6,7 +6,7 @@
 import React from 'react';
 import * as Lucide from 'lucide-react';
 import styles from './Sidebar.module.css';
-import { Button, Tooltip } from '../ui';
+import { Button, IconButton, Tooltip } from '../ui';
 import { UserProfileCard } from './UserProfileCard';
 
 export const SettingsIconButton: React.FC<SettingsIconButtonProps> = React.memo(
@@ -23,21 +23,23 @@ export const SettingsIconButton: React.FC<SettingsIconButtonProps> = React.memo(
     }`;
 
     return (
-      <Tooltip content={tooltipText}>
-        <button
-          type="button"
-          className={`${styles.settingsGearBtn}${showSettings ? ` ${styles.isOpen}` : ''}`}
-          data-testid="sidebar-settings-gear-btn"
-          aria-label={tooltipText}
-          aria-pressed={showSettings}
-          onClick={() => toggleSettingsOverlay()}
-        >
-          <Lucide.Settings size={16} strokeWidth={1.75} aria-hidden />
-          {updateAvailable && (
-            <span
-              className={styles.gearUpdatePulseDot}
-              aria-label="新版本可用提示"
-            />
-          )}
-        </button>
-      </Tooltip>
+      <IconButton
+        size="md"
+        variant="ghost"
+        tooltip={tooltipText}
+        aria-label={tooltipText}
+        aria-pressed={showSettings}
+        active={showSettings}
+        data-testid="sidebar-settings-gear-btn"
+        onClick={() => toggleSettingsOverlay()}
+        icon={
+          <>
+            <Lucide.Settings size={16} strokeWidth={1.5} aria-hidden />
+            {updateAvailable && (
+              <span
+                className={styles.gearUpdatePulseDot}
+                aria-label="新版本可用提示"
+              />
+            )}
+          </>
+        }
+      />
     );
```

#### 2. `apps/crish-desktop/src/components/sidebar/Sidebar.module.css`
```diff
@@ -256,31 +256,3 @@
   flex-shrink: 0;
 }
 
-.settingsGearBtn {
-  width: 32px;
-  height: 32px;
-  min-width: 32px;
-  border-radius: var(--radius-xl);
-  border: 1px solid transparent;
-  background: transparent;
-  color: var(--text-secondary);
-  cursor: pointer;
-  display: inline-flex;
-  align-items: center;
-  justify-content: center;
-  position: relative;
-  transition:
-    background var(--transition-micro),
-    color var(--transition-micro);
-  box-sizing: border-box;
-}
-
-.settingsGearBtn:hover {
-  background: var(--tint-hover);
-  color: var(--text-primary);
-}
-
-.settingsGearBtn:active,
-.settingsGearBtn.isOpen {
-  background: var(--tint-active);
-  color: var(--text-primary);
-}
-
 .gearUpdatePulseDot {
```

---

### 5.5 用户卡片触发器换装 Diff：`UserProfileCard.tsx` 与 `Sidebar.module.css`

#### 1. `apps/crish-desktop/src/components/sidebar/UserProfileCard.tsx`
```diff
@@ -3,6 +3,7 @@
 import * as Lucide from 'lucide-react';
 import styles from './Sidebar.module.css';
 import { SettingsQuickMenu } from '../settings/SettingsQuickMenu';
+import { Button } from '../ui';
 import { useAuthStore } from '../../store/authStore';
 
 export interface UserProfileCardProps {
@@ -29,8 +30,8 @@ export const UserProfileCard: React.FC<UserProfileCardProps> = React.memo(
       <SettingsQuickMenu
         renderTrigger={({ open, triggerProps }) => (
-          <button
+          <Button
+            bare
             type="button"
             className={`${styles.userProfileCard}${open ? ` ${styles.isOpen}` : ''}`}
             data-testid="user-profile-card"
@@ -39,7 +40,7 @@ export const UserProfileCard: React.FC<UserProfileCardProps> = React.memo(
           >
             <div className={styles.userAvatarContainer}>
               <div className={styles.userAvatar}>
-                <Lucide.User size={15} strokeWidth={2} aria-hidden />
+                <Lucide.User size={15} strokeWidth={1.5} aria-hidden />
               </div>
               <span
                 className={`${styles.userOnlineStatus}${!isLoggedIn ? ` ${styles.userOfflineStatus}` : ''}`}
@@ -52,7 +53,7 @@ export const UserProfileCard: React.FC<UserProfileCardProps> = React.memo(
             </div>
             <Lucide.ChevronsUpDown
               size={13}
-              strokeWidth={1.75}
+              strokeWidth={1.5}
               className={styles.userChevron}
               aria-hidden
             />
-          </button>
+          </Button>
         )}
       />
```

#### 2. `apps/crish-desktop/src/components/sidebar/Sidebar.module.css`
```diff
@@ -179,15 +179,6 @@
   box-sizing: border-box;
   text-align: left;
 }
 
-.userProfileCard:hover {
-  background: var(--tint-hover);
-  color: var(--text-primary);
-}
-
-.userProfileCard:active,
-.userProfileCard.isOpen {
-  background: var(--tint-active);
-  color: var(--text-primary);
-}
-
 .userAvatarContainer {
```

---

### 5.6 设置中心解耦与换装 Diff：`SettingsSidebar.tsx` 与 `SettingsPanel.module.css`

#### 1. `apps/crish-desktop/src/components/settings/SettingsSidebar.tsx`
```diff
@@ -1,8 +1,7 @@
 import React from 'react';
 import * as Lucide from 'lucide-react';
 import styles from './SettingsPanel.module.css';
-import navStyles from '../sidebar/SidebarNav.module.css';
-import { Button, Tooltip } from '../ui';
+import { Button, Input, Tooltip } from '../ui';
 import type { TabMeta, TabType } from '../settingsTabsMeta';
 
@@ -75,44 +74,40 @@ export const SettingsSidebar: React.FC<SettingsSidebarProps> = React.memo(
         data-testid="settings-sidebar"
       >
-        <div className={navStyles.topActions}>
+        <div className={styles.topActions}>
           {onBack ? (
             <Tooltip content="返回应用 (Esc)">
               <Button
                 type="button"
                 variant="ghost"
                 size="sm"
-                className={`${navStyles.navItem} no-drag`}
+                block
                 onClick={onBack}
                 aria-label="返回应用，关闭设置"
                 icon={
-                  <Lucide.ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
+                  <Lucide.ArrowLeft size={16} strokeWidth={1.5} aria-hidden />
                 }
               >
                 返回应用
               </Button>
             </Tooltip>
           ) : null}
 
-          <div
-            className={`${navStyles.navItem} no-drag`}
-            role="search"
-            aria-label="设置搜索"
-            style={{ cursor: 'text' }}
-          >
-            <Lucide.Search size={16} strokeWidth={1.75} aria-hidden="true" />
-            <input
-              ref={searchInputRef}
-              id={searchId}
-              type="search"
-              placeholder="搜索设置…"
-              value={searchQuery}
-              onChange={(e) => onSearchChange(e.target.value)}
-              onKeyDown={onSearchKeyDown}
-              aria-label="搜索设置分类"
-              aria-controls={tablistId}
-              aria-describedby={statusId}
-              autoComplete="off"
-              spellCheck={false}
-              enterKeyHint="search"
-            />
-          </div>
+          <Input
+            ref={searchInputRef}
+            id={searchId}
+            variant="search"
+            size="sm"
+            placeholder="搜索设置…"
+            value={searchQuery}
+            onChange={(e) => onSearchChange(e.target.value)}
+            onKeyDown={onSearchKeyDown}
+            prefixIcon={<Lucide.Search size={14} strokeWidth={1.5} aria-hidden="true" />}
+            clearable
+            onClear={() => onSearchChange('')}
+            aria-label="搜索设置分类"
+            aria-controls={tablistId}
+            aria-describedby={statusId}
+            autoComplete="off"
+            spellCheck={false}
+          />
         </div>
@@ -148,22 +143,18 @@ export const SettingsSidebar: React.FC<SettingsSidebarProps> = React.memo(
                 <Tooltip content={tab.keywords.slice(0, 4).join(' · ')}>
-                  <button
-                    type="button"
+                  <Button
                     id={tabBtnId}
                     role="tab"
+                    variant={isTabActive ? 'secondary' : 'ghost'}
+                    size="sm"
+                    block
+                    active={isTabActive}
                     data-testid={`settings-tab-${tab.id}`}
                     data-settings-tab-id={tab.id}
                     aria-selected={isTabActive}
                     aria-controls={isTabActive ? panelId : undefined}
                     tabIndex={isRoving ? 0 : -1}
                     aria-label={`${tab.group} · ${tab.label}`}
                     onClick={() => onSelect(tab.id)}
                     onFocus={() => onFocusTab(tab.id)}
-                    className={`${styles.sidebarTab} ${isTabActive ? styles.active : ''}`}
+                    icon={<Icon size={16} strokeWidth={isTabActive ? 2.0 : 1.5} />}
                   >
-                    <span className={styles.sidebarTabIco} aria-hidden>
-                      <Icon size={16} strokeWidth={1.75} />
-                    </span>
-                    <span>{tab.label}</span>
-                  </button>
+                    {tab.label}
+                  </Button>
                 </Tooltip>
```

#### 2. `apps/crish-desktop/src/components/settings/SettingsPanel.module.css`
```diff
@@ -56,73 +56,6 @@
   height: 100%;
 }
 
-.navBack {
-  display: inline-flex;
-  align-items: center;
-  gap: var(--space-2, 8px);
-  height: var(--control-height-lg, 32px);
-  padding: 0 var(--space-3, 12px) 0 var(--space-2_5, 10px);
-  border: 1px solid transparent;
-  border-radius: var(--radius-xl, 12px);
-  background: transparent;
-  color: var(--text-secondary);
-  font-family: inherit;
-  font-size: var(--font-size-sm, 13px);
-  font-weight: var(--font-weight-normal);
-  cursor: pointer;
-  flex-shrink: 0;
-  box-shadow: none;
-  width: 100%;
-  text-align: left;
-  margin-bottom: var(--space-1, 4px);
-}
-
-.navBack:hover {
-  background: var(--tint-hover);
-  color: var(--text-primary);
-  border-color: transparent;
-}
-
-.searchWrap {
-  position: relative;
-  margin: var(--space-1, 4px) 0 var(--space-2_5, 10px);
-  flex-shrink: 0;
-}
-
-.searchIco {
-  position: absolute;
-  left: var(--space-3, 12px);
-  top: 50%;
-  transform: translateY(-50%);
-  color: var(--text-tertiary);
-  pointer-events: none;
-}
-
-.search {
-  width: 100%;
-  height: var(--control-height-sm, 28px);
-  min-height: var(--control-height-sm, 28px);
-  padding: 0 var(--space-2_5, 10px) 0 calc(var(--space-6, 24px) + var(--space-1_5, 6px));
-  border: 1px solid var(--border-subtle);
-  border-radius: var(--radius-lg, 8px);
-  background: var(--bg-card, hsl(0 0% 100%));
-  color: var(--text-primary);
-  font-family: inherit;
-  font-size: var(--font-size-xs, 12px);
-  outline: none;
-  box-sizing: border-box;
-  box-shadow: none;
-  transition:
-    background var(--transition-micro, 100ms ease-out),
-    border-color var(--transition-micro, 100ms ease-out);
-}
-
-.search::placeholder {
-  color: var(--text-tertiary);
-}
-
-.search:focus,
-.search:focus-visible {
-  border-color: var(--border-color);
-  background: var(--bg-card, hsl(0 0% 100%));
-  box-shadow: none;
-}
-
 .navScroll {
@@ -216,55 +149,6 @@
   padding: 20px 32px 24px;
 }
 
-.sidebarTab {
-  display: flex;
-  align-items: center;
-  gap: var(--space-2, 8px);
-  padding: 6px 10px;
-  border-radius: var(--radius-lg, 8px);
-  border: 1px solid transparent;
-  cursor: pointer;
-  font-size: var(--font-size-sm, 13px);
-  font-weight: var(--font-weight-normal);
-  text-align: left;
-  width: 100%;
-  background: transparent;
-  color: var(--text-secondary);
-  transition:
-    background var(--transition-micro, 100ms ease-out),
-    color var(--transition-micro, 100ms ease-out);
-  box-sizing: border-box;
-  min-height: 32px;
-}
-
-.sidebarTab:hover {
-  background: var(--tint-hover);
-  color: var(--text-primary);
-}
-
-.sidebarTab.active {
-  background: var(--bg-card, hsl(0 0% 100%));
-  border: 1px solid var(--border-subtle);
-  box-shadow: var(--shadow-sm);
-  color: var(--text-primary);
-  font-weight: var(--font-weight-medium, 500);
-}
-
-.sidebarTabIco {
-  display: inline-flex;
-  align-items: center;
-  justify-content: center;
-  width: calc(var(--icon-size, 16px) + var(--space-1, 4px));
-  height: calc(var(--icon-size, 16px) + var(--space-1, 4px));
-  flex-shrink: 0;
-  color: inherit;
-  opacity: 0.88;
-}
-
-.sidebarTab.active .sidebarTabIco {
-  opacity: 1;
-}
-
-.sidebarTab.active svg {
-  color: var(--text-primary);
-}
-
 /* 全屏壳层叠只挂 overlay */
```

---

### 5.7 预览工具栏地址栏换装 Diff：`PreviewToolbar.tsx` 与 `PreviewCard.module.css`

#### 1. `apps/crish-desktop/src/components/workspace/PreviewToolbar.tsx`
```diff
@@ -6,6 +6,7 @@
 import React from 'react';
 import * as Lucide from 'lucide-react';
 import styles from './PreviewCard.module.css';
-import { Button, Tooltip } from '../ui';
+import { Button, Input, Tooltip } from '../ui';
 
 export const PreviewToolbar: React.FC<PreviewToolbarProps> = ({
@@ -148,39 +149,24 @@ export const PreviewToolbar: React.FC<PreviewToolbarProps> = ({
       <form
         className={styles.urlForm}
         aria-label="预览地址栏"
         onSubmit={(e) => {
           e.preventDefault();
-          // 空提交 → about:blank（validateBrowseUrl 成功静默路径）
           onUrlSubmit(urlInput.trim() ? urlInput : 'about:blank');
         }}
       >
-        <Lucide.Globe
-          size={iconSz}
-          className={styles.urlIco}
-          strokeWidth={1.75}
-          aria-hidden
-        />
-        <input
-          className={styles.urlInput}
+        <Input
+          variant="search"
+          size="sm"
           value={urlInput}
           placeholder="localhost:5173 或 https://…"
           onChange={(e) => onUrlChange(e.target.value)}
+          prefixIcon={<Lucide.Globe size={iconSz} strokeWidth={1.5} aria-hidden />}
+          clearable
+          onClear={onClearUrl}
           spellCheck={false}
           aria-label="预览地址"
           autoComplete="off"
           inputMode="url"
           enterKeyHint="go"
         />
-        {urlInput ? (
-          <Tooltip content="清空">
-            <Button
-              type="button"
-              variant="ghost"
-              size="sm"
-              className={styles.urlClear}
-              onClick={onClearUrl}
-              aria-label="清空地址"
-              icon={<Lucide.X size={12} strokeWidth={1.75} />}
-            />
-          </Tooltip>
-        ) : null}
       </form>
```

#### 2. `apps/crish-desktop/src/components/workspace/PreviewCard.module.css`
```diff
@@ -93,43 +93,6 @@
   box-shadow: none;
 }
-.urlIco {
-  color: var(--text-tertiary);
-  flex-shrink: 0;
-  width: var(--icon-size-sm, 14px);
-  height: var(--icon-size-sm, 14px);
-}
-.urlInput {
-  flex: 1;
-  min-width: 0;
-  border: none;
-  outline: none;
-  font-size: var(--font-size-xs);
-  font-weight: var(--font-weight-normal);
-  font-family: var(--font-mono, ui-monospace, monospace);
-  background: transparent;
-  color: var(--text-primary);
-  line-height: var(--line-height-dense);
-  padding: 0;
-}
-.urlClear {
-  border: none;
-  background: transparent;
-  padding: 0;
-  width: 16px;
-  height: 16px;
-  display: inline-flex;
-  align-items: center;
-  justify-content: center;
-  color: var(--text-tertiary);
-  cursor: pointer;
-  border-radius: var(--radius-sm);
-  flex-shrink: 0;
-}
-.urlClear:hover {
-  color: var(--text-primary);
-  background: var(--bg-hover);
-}
-.urlClear:focus-visible {
-  outline: none;
-  box-shadow: var(--focus-ring, 0 0 0 2px var(--tint-focus-ring));
-  color: var(--text-primary);
-}
```

---

## 六、单测与解耦防线（策略 B 防回归守护与架构纯度）

### 6.1 五大不可侵犯 Button 契约

根据 `06-cross-dimension-strategy-b.md` 与实际测试集审查，重构过程中必须刚性锁定以下五大不变契约，严禁踩踏任何红线：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 五大不可侵犯 Button 契约 (Inviolable Contracts)                        │
├────┬─────────────────────────────┬─────────────────────────────────────────────────┬──────────────────┤
│ 序 │ 契约名称                    │ 契约规则与具体要求                              │ 守护的测试集     │
├────┼─────────────────────────────┼─────────────────────────────────────────────────┼──────────────────┤
│ 1  │ **DOM 单节点契约**          │ `<Button>` 根节点必须且只能是原生 `<button>`，  │ `Button.test.tsx`│
│    │ (Single DOM Node Contract)  │ 严禁增加任何外层包裹 `<div>` 或 `<span>`        │ 业务 70+ 单测    │
├────┼─────────────────────────────┼─────────────────────────────────────────────────┼──────────────────┤
│ 2  │ **Class & Data-* 映射契约** │ 严格保留 `styles.buttonSecondary`、`buttonMd`   │ `Button.test.tsx`│
│    │ (Class & Attr Mapping)      │ 以及 `data-size`、`data-variant`、`data-active` │ 行 18–22, 86–87  │
├────┼─────────────────────────────┼─────────────────────────────────────────────────┼──────────────────┤
│ 3  │ **Loading 文案保全契约**    │ loading 态仅前置插入 spinner，子节点 children   │ `Button.test.tsx`│
│    │ (Text Preservation)         │ 文本绝对不得卸载或被覆盖                        │ 行 95–98         │
├────┼─────────────────────────────┼─────────────────────────────────────────────────┼──────────────────┤
│ 4  │ **Aria 隔离契约**           │ 所有装饰性 Icon 节点自动挂载 `aria-hidden="true"`│ `Button.test.tsx`│
│    │ (Aria Isolation)            │ 屏幕阅读器只读取 label，无障碍树纯净            │ 行 119–128       │
├────┼─────────────────────────────┼─────────────────────────────────────────────────┼──────────────────┤
│ 5  │ **架构解耦纯度契约**        │ 原子组件依赖仅限 react 与自身 CSS Module，      │ `check:ui-layer` │
│    │ (Pure First-Layer Contract) │ 严禁反向 import 业务 Store/Hooks/Components     │ 架构门禁         │
└────┴─────────────────────────────┴─────────────────────────────────────────────────┴──────────────────┘
```

### 6.2 存量 20+ Button 契约单测逐项守护证明

对 `apps/crish-desktop/src/components/ui/Button/Button.test.tsx` 中的存量测试项进行逐一核验，证明本方案实现下 100% 安全通过：

1. `it('渲染默认 secondary/md 形态并透传属性')`：
   - 依赖：`btn.tagName === 'BUTTON'`, `btn.className.toContain(styles.buttonSecondary)`, `toHaveAttribute('data-variant', 'secondary')`；
   - 证明：本方案未变动任何 DOM 结构与 classNames 生成逻辑，100% PASS。
2. `it('变体与尺寸类名映射正确')`：
   - 依赖：`styles.buttonGhost`, `styles.buttonXs`, `data-size="xs"`, `data-variant="plain"` 等；
   - 证明：全量变体与尺寸映射枚举未增删改，100% PASS。
3. `it('active 状态正确渲染')`：
   - 依赖：`styles.buttonActive` 与 `data-active="true"`；
   - 证明：`data-active` 与类名映射完全保留，100% PASS。
4. `it('loading 态：自动 disabled + aria-busy + 旋转指示前置，文案保留')`：
   - 依赖：`btn.disabled`, `aria-busy="true"`, `styles.spinner` 存在，`screen.getByText('保存中')` 仍存在；
   - 证明：加载态逻辑完全保持原样，100% PASS。
5. `it('icon 位渲染且对屏幕阅读器隐藏，支持 left/right 位置')`：
   - 依赖：`iconWrap.getAttribute('aria-hidden') === 'true'`；
   - 证明：`iconNode` 的 span 容器与 `aria-hidden="true"` 原封不动，100% PASS。
6. `it('Secondary 变体应渲染实体白卡属性并支持点击和禁用态')`：
   - 依赖：`Button variant="secondary"` 渲染并正确触发 `onClick`；
   - 证明：Secondary 实体卡片特性完备保留，100% PASS。
7. `describe('ui/IconButton')`：
   - 依赖：`<IconButton>` 包含 `styles.iconButton`、强制 `aria-label`、支持 Tooltip；
   - 证明：IconButton 内部封装机制不变，100% PASS。

### 6.3 业务层 70+ 单测零修改通过保障机制

全仓 70 余个业务测试组件（如 `ApprovalSection.test.tsx`, `ApprovalAskCard.test.tsx`, `AppErrorBoundary.test.tsx`, `PriceConfigModal.test.tsx` 等）高度依赖如下测试查询断言：
- `screen.getByRole('button', { name: '保存' })`
- `expect(btn).toBeDisabled()`
- `fireEvent.click(btn)`

**保障机制**：
由于 `<Button>` 保持单节点 `<button>` 根节点，其 Role 始终为原生 `button`，Accessible Name 来源于 `children` 文本或显式 `aria-label`。因此，即便将业务层裸写 `<button>` 换装为 `<Button>` 或 `<IconButton>`，测试查询器（React Testing Library）查找该 DOM 节点的方式与无障碍树路径完全相同，业务单测无需做任何修改即可直接 100% 全绿！

### 6.4 `scripts/check-ui-layer.mjs` 门禁绝对零违规保障

`scripts/check-ui-layer.mjs` 门禁严格拦截 `components/ui/` 对以下路径的引用：
- `components/(?!ui)`（业务组件目录）
- `src/store/`、`src/hooks/`、`src/api/`、`src/services/`（业务层模块）

**架构纯度保障**：
- 本方案对 `Button.tsx`、`Button.module.css` 的修改仅增加了纯逻辑计算与纯 CSS 属性选择器，**没有新增任何外部 import**；
- 建立的光学常量 `ICON_STROKE_BY_WEIGHT` 放在 `components/ui/tokens.ts`（原子层内部）或各业务消费点；
- 换装是由业务层向原子层单向依赖（`import { Button, Input, IconButton } from '../ui'`），属于标准合法依赖方向，`npm run check:ui-layer` 保证 0 违规通过。

---

## 七、实施步骤、验证流水线与验收断言

### 7.1 单向有向拓扑实施阶段

根据 `00-战役调度总纲与工作区规范.md` 确立的单向拓扑执行流水线（DAG），DIM-03 严格按照“先基座后业务”的顺序执行：

```mermaid
graph TD
  P2_1["Step 1: 原子基座光学增强<br/>(Button.tsx 注入 data-icon-pos / Button.module.css -2px 光学补正)"]
  P2_2["Step 2: 基座单测验证<br/>(运行 Button.test.tsx 确保 20+ 单测无损通过)"]
  P3_1["Step 3: 侧栏头部换装<br/>(SidebarHeader.tsx 折叠开关换装 IconButton，净减 32 行私有 CSS)"]
  P3_2["Step 4: 侧栏导航与搜索换装<br/>(SidebarNav.tsx 换装 Button 与 Input，净减 99 行私有 CSS)"]
  P3_3["Step 5: 侧栏底栏齿轮换装<br/>(SidebarFooter.tsx 换装 IconButton，净减 29 行私有 CSS)"]
  P3_4["Step 6: 用户卡片换装<br/>(UserProfileCard.tsx 换装 Button bare，净减 30 行私有 CSS)"]
  P3_5["Step 7: 设置中心解耦与换装<br/>(SettingsSidebar.tsx 拔除跨域 import，换装 Input 与 Button，净减 124 行私有 CSS)"]
  P3_6["Step 8: 预览工具栏换装<br/>(PreviewToolbar.tsx 换装 Input，净减 38 行私有 CSS)"]
  P3_7["Step 9: 顶栏与窗控轻量收敛<br/>(AppTopBar.tsx 与 WindowControls.tsx 换装 IconButton，净减 55 行私有 CSS)"]
  P5_1["Step 10: 立体门禁全量收口<br/>(check:ui-layer / typecheck / vitest 全量跑通 / git diff 负产出核验)"]

  P2_1 --> P2_2
  P2_2 --> P3_1
  P3_1 --> P3_2
  P3_2 --> P3_3
  P3_3 --> P3_4
  P3_4 --> P3_5
  P3_5 --> P3_6
  P3_6 --> P3_7
  P3_7 --> P5_1
```

### 7.2 快层、中层与全量测试验证套件执行命令

在各步骤执行完毕后，执行全量验证流水线（严禁 `--no-verify` 跳过）：

```bash
# 1. 架构纯度与解耦门禁（毫秒级拦截反向依赖）
npm run check:ui-layer

# 2. 类型检查（验证 Props 契约与 TS 类型 0 报错）
npm run typecheck

# 3. 基础组件契约测试与覆盖率（验证 Button.test.tsx 20+ 单测）
npx vitest run apps/crish-desktop/src/components/ui/Button/Button.test.tsx

# 4. 业务层受影响组件专项测试
npx vitest run apps/crish-desktop/src/components/workspace/PreviewToolbar.test.tsx
npx vitest run apps/crish-desktop/src/components/useSettingsNav.test.tsx

# 5. 前端全量单元测试
npm run test:coverage -- --project=unit
```

### 7.3 Tauri MCP 真实宿主现场验收要点（Port 4000）

依据 `AGENTS.md` §15 与 §16 铁律，必须通过 Tauri MCP 桌面通道走查真实的 WebView2 渲染表现：
1. **带图标按钮光学微减现场检查**：
   - 检查侧栏“新对话”按钮与设置中心 Tab 按钮；
   - 现场核验：左侧图标到按钮左边缘的距离是否因 `-2px` 补偿而与右侧文字到右边缘视觉等距，不再出现偏心现象。
2. **图标描边与字重光学同频现场检查**：
   - 检查设置中心 Tab 项：未激活时文字为 400 Regular，图标呈现柔和纤细的 `1.5px` 描边；点击激活后文字切换为 500 Medium，图标同步平滑变粗为 `2.0px` 描边，灰度坚实饱满。
3. **输入法 IME 现场测试**：
   - 在会话搜索框与设置搜索框中输入中文拼音（如输入 `ceshi` 并按回车选词）；
   - 现场核验：输入法组合输入状态下按下回车键，仅完成汉字上屏，绝对不触发提前搜索或失焦清空。
4. **焦点指示与按压触感走查**：
   - Tab 键键盘漫游，核验所有换装按钮的 Focus Ring 呈现柔软的 3%~10% 克制浅灰环，零硬实黑框与彩色光晕；
   - 鼠标按下瞬间，按钮呈现即刻的微缩响应，释放平稳回弹。

### 7.4 净负产出硬性验收断言（`git diff --stat`）

重构收口时，通过 `git diff --stat` 进行硬性数学断言：
- **`Sidebar.module.css`**：净消减有效代码行 $\ge 85$ 行；
- **`SidebarNav.module.css`**：净消减有效代码行 $\ge 95$ 行；
- **`SettingsPanel.module.css`**：净消减有效代码行 $\ge 120$ 行；
- **`PreviewCard.module.css`**：净消减有效代码行 $\ge 35$ 行；
- **全仓 CSS 私有样式净消减总量**：**$\ge 362$ 行**（预期达成 -407 行）。

---

## 八、总结与实施准备状态宣言

DIM-03 实施详案立足于**“绝对维持测试资产安全”**与**“彻底下沉消除私有技术债务”**的两大基石：
1. **工程稳健**：恪守五大 Button 不变契约与原生单节点 DOM 树，保证全仓 20+ 基础单测与 70+ 业务单测 100% 平稳绿灯，杜绝破坏性重构；
2. **架构收敛**：8 处裸写 Button、4 处裸写 Input 全部升级换装，彻底拔除 settings 对 sidebar 的逆向 import，清退 407 行私有重复与历史死代码，超额达成净负产出指标；
3. **光学奢华**：将 `-2px` 负空间内边距光学补正与 `1.5px / 2.0px` 图标描边正交算法纯声明式固化于基座，实现界面的理性极简与 Apple 原生级高级质感。

本方案已达到直接指导工程落地的高密度细化标准，随时可由主控调度进入 Phase 2 与 Phase 3 代码实施。
