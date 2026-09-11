# DIM-03 专项分析：原子组件全面收敛与光学平衡

> **战役定位**：`UI-UNIFICATION-REDESIGN` 战役阶段一 · 维度三（DIM-03）深度分析报告
> **设计依据**：`C:\Software\conex\skill\design\jakub-skills\skills\better-ui`（`surfaces.md`、`icons.md`）、`better-interface`、`apps/crish-desktop/src/components/ui/README.md`
> **核心使命**：彻底根除桌面端各业务组件（Sidebar、Settings、TopBar、Shell）对原生 `<button>` 与 `<input>` 的裸写与私有样式重造，拔除跨层样式穿透，纠正按钮图标内边距与图标 strokeWidth 的光学平衡缺陷，实现代码资产的**净负产出（Net-Negative LOC）**。

---

## 一、维度现状与架构断层总述

在 `PE-05` 与 `RED-DETAILED-02` 的建设中，Crish 前端已在 `apps/crish-desktop/src/components/ui/` 目录下建立了较为完善的第一层「UI 原子层」，包括 `<Button>`, `<IconButton>`, `<Input>`, `<Tooltip>`, `<Dialog>` 等标准化原子。然而深入排查桌面端主要骨干视图（侧边栏、全局设置、顶栏）后，发现存在显著的**原子层绕过（Bypass）**与**私有样式造轮子**现象：

1. **裸写组件严重违反分层纪律**：
   - 侧边栏（`SidebarHeader`, `SidebarNav`, `SidebarFooter`, `UserProfileCard`）存在大量裸写 `<button>` 与 `<input>`；
   - 设置中心（`SettingsSidebar`, `SettingsPanel`）不仅裸写 `<button>` 和 `<input>`，甚至发生跨域逆向引用——从 `settings/SettingsSidebar.tsx` 直接反向 `import` `../sidebar/SidebarNav.module.css`，直接踩踏前端解耦红线；
   - 顶栏（`AppTopBar`, `WindowControls`）在引入原子 `<Button>` 后，却通过自定义类名覆盖全部尺寸、边框、圆角与内边距，使原子层规范名存实亡。
2. **私有 CSS 严重膨胀**：
   - 为支撑裸写的控制控件与输入框，各模块维护了近 370 行高度重复的私有 CSS 样式（包括重复实现 hover、active 遮罩、焦点环、圆角、WebKit 搜索重置、甚至死样式代码）。
3. **光学对齐（Optical Alignment）机制缺位**：
   - **内边距不对称**：`<Button>` 无论是否携带图标，一律采用完全对称的 `padding: 0 var(--btn-px)`。由于图标天然具有镂空与留白，导致带图标按钮在视觉上“图标离边缘过远、文字向右偏心”；
   - **strokeWidth 脱节**：业务组件中充斥随意硬编码的 `strokeWidth={1.75}`，未能与邻近文字字重（400 Regular 对应 1.5px，500/600 Medium/Semibold 对应 2.0px）形成光学同频，使图标在不同上下文下要么喧宾夺主，要么发虚断裂。

---

## 二、光学对齐缺陷深度分析与数学模型

### 2.1 缺陷 A：Button 图标侧内边距几何对称导致的视觉失衡

#### 1. 物理现象与视错觉成因
根据 `better-ui/surfaces.md` § Optical alignment：
> **Buttons with text + icon**
> Where an icon makes symmetric padding look unbalanced, use slightly less on the icon side. A starting point:
> `icon-side padding = text-side padding - 2px`.

在几何尺寸上相等的内边距，在人类视网膜感知中往往呈现不对称。按钮内部的文字通常呈现密集、连续的水平笔画，右边界（或左边界）实打实地贴合字符外框；而矢量图标（如 Lucide 的 16x16 / 24x24 栅格图形）多为轮廓线、圆环或几何构型，其内部与四周包含天然的**负空间（Negative Space）与镂空**。
若按钮左内边距与右内边距同为 `12px`：
- 图标由于负空间，视觉中心比物理外框更靠内（偏右）；
- 文字笔画实心，视觉重心紧贴内边距边缘；
- **综合视觉效果**：图标侧看起来过于空旷，整个按钮的重心被向右推挤，呈现严重的“右重左轻”失衡。

#### 2. 现状代码证据
在 [`Button.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L28) 中：
```css
/* apps/crish-desktop/src/components/ui/Button/Button.module.css:28 */
.button {
  --btn-h: 32px;
  --btn-px: 12px;
  ...
  height: var(--btn-h);
  padding: 0 var(--btn-px); /* ◀ 几何死值对称，完全不感知是否存在图标或图标方向 */
  gap: var(--btn-gap);
```
在 [`Button.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.tsx#L122-L129) 中：
```tsx
/* apps/crish-desktop/src/components/ui/Button/Button.tsx:122-129 */
{loading ? (
  <span className={styles.spinner} aria-hidden="true" />
) : iconPosition === 'left' ? (
  iconNode
) : null}
{children != null ? (
  <span className={styles.buttonLabel}>{children}</span>
) : null}
{!loading && iconPosition === 'right' ? iconNode : null}
```
无论是左图标（Leading Icon）还是右图标（Trailing Icon），按钮都应用无差别的 `padding: 0 var(--btn-px)`。

#### 3. 光学平衡补正模型与各档矩阵
严格依据 `better-ui` 准则：
- **前置图标（Leading Icon）**：`padding-inline-start = var(--btn-px) - 2px`，`padding-inline-end = var(--btn-px)`；
- **后置图标（Trailing Icon）**：`padding-inline-start = var(--btn-px)`，`padding-inline-end = var(--btn-px) - 2px`；
- **纯文字（Text Only）或纯图标（IconButton / No Children）**：保持完全对称。

四档标准化尺寸矩阵对照表如下：

| 尺寸等级 | 高度 (`--btn-h`) | 基线内边距 (`--btn-px`) | 纯文字内边距 (L / R) | 前置图标光学内边距 (L / R) | 后置图标光学内边距 (L / R) | 光学补偿量 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **xs** | 24px | 6px | 6px / 6px | **4px** / 6px | 6px / **4px** | -2px (33.3% 收口) |
| **sm** | 28px | 10px | 10px / 10px | **8px** / 10px | 10px / **8px** | -2px (20.0% 收口) |
| **md** | 32px | 12px | 12px / 12px | **10px** / 12px | 12px / **10px** | -2px (16.7% 收口) |
| **lg** | 40px | 16px | 16px / 16px | **14px** / 16px | 16px / **14px** | -2px (12.5% 收口) |

#### 4. 原生 O(1) 工程化改造方案
在 `Button.tsx` 中识别是否同时具有图标与文本内容，派发 `data-icon-pos`：
```tsx
const hasIcon = Boolean(icon || loading);
const hasText = children != null && children !== '';
const isOpticallyAsymmetric = hasIcon && hasText;

<button
  ref={ref}
  className={classNames}
  data-size={size}
  data-variant={variant}
  data-icon-pos={isOpticallyAsymmetric ? iconPosition : undefined}
  ...
>
```
在 `Button.module.css` 中注入光学补偿（利用 CSS `max(0px, ...)` 防御越界）：
```css
/* 前置图标：左侧内边距削减 2px 达到视觉居中 */
.button[data-icon-pos='left'] {
  padding-left: max(0px, calc(var(--btn-px) - 2px));
  padding-right: var(--btn-px);
}

/* 后置图标：右侧内边距削减 2px 达到视觉居中 */
.button[data-icon-pos='right'] {
  padding-left: var(--btn-px);
  padding-right: max(0px, calc(var(--btn-px) - 2px));
}
```
**优势**：0 运行时 JS 测量，不破坏 CSS 单一真源，纯声明式完成光学对齐。

---

### 2.2 缺陷 B：图标 strokeWidth 与文字字重脱节问题

#### 1. 物理规律与设计准则
根据 `better-ui/icons.md` § Match icon stroke to text weight：
> A hairline icon beside semibold text reads as broken; a heavy icon beside regular text shouts.
>
> | Adjacent text | Icon stroke width (24px grid) |
> | :--- | :--- |
> | Regular (400), 14–16px | `1.5px` |
> | Medium/Semibold (500–600) | `2px` |
> | Bold (700), or emphasized standalone | `2.5px` |

图标描边粗细与相邻文字笔画粗细的**光学灰度一致性**是高品质界面的关键基石：
- 当图标放置在 400 字重（常规体）文字旁时，图标描边必须收敛至 `1.5px`。若使用 1.75px 或 2.0px，图标的墨水覆盖率（Ink Coverage）将显著超越单薄的文字字形，形成“视觉黑洞”，夺走用户注意力；
- 当图标放置在 500/600 字重（中粗体/半粗体，如激活 Tab、主操作按钮、重要标题）文字旁时，图标描边应提升至 `2.0px`。若低于 2.0px，文字厚重而图标纤弱，视觉上呈现“营养不良”、“线段发虚断裂”。

#### 2. 现状排查与代码证据链
代码库中各处组件大量存在随手配置 `strokeWidth={1.75}` 的“万金油折中”现象，无论上下文文字字重是 400 还是 500/600，均一律填入 1.75，陷入两头失衡的尴尬境地：

| 文件路径与行号 | 组件与元素 | 邻近文字字重 | 现状 strokeWidth | 光学缺陷表现 | 规范目标值 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| [`SidebarNav.tsx:37`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.tsx#L37) | 新对话 SVG 路径 | Medium (500) | `1.75` | 面对 500 字重，1.75px 线条偏细发虚 | **`2.0`** |
| [`SidebarNav.tsx:54`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.tsx#L54) | `<Lucide.Clock>` 定时任务 | Medium (500) | `1.75` | 同上，激活态时更显薄弱 | **`2.0`** |
| [`SidebarNav.tsx:63`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.tsx#L63) | `<Lucide.Search>` 会话搜索 | Regular (400 占位符) | `1.75` | 图标压过淡色的占位文本 | **`1.5`** |
| [`SidebarFooter.tsx:35`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx#L35) | `<Lucide.Settings>` 独立齿轮 | 无文字（独立控件） | `1.75` | 独立控件缺乏 2.0px 的实体感 | **`1.5` / `2.0`** |
| [`SidebarFooter.tsx:94`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx#L94) | `<Lucide.RefreshCw>` 更新按钮 | Regular (400) | `1.75` | 14px 小字号下 1.75px 模糊糊成一团 | **`1.5`** |
| [`UserProfileCard.tsx:40`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/UserProfileCard.tsx#L40) | `<Lucide.User>` 用户头像 | 头像容器 (26px) | `2` | 与同组件内 ChevronsUpDown(1.75) 冲突 | **`1.5`** |
| [`UserProfileCard.tsx:53`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/UserProfileCard.tsx#L53) | `<Lucide.ChevronsUpDown>` | Regular (400 副文案) | `1.75` | 13px 极小尺寸下 1.75 导致上下箭头粘连 | **`1.5`** |
| [`SettingsSidebar.tsx:88`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSidebar.tsx#L88) | `<Lucide.ArrowLeft>` 返回应用 | Regular (400) | `1.75` | 压过“返回应用”的普通字重 | **`1.5`** |
| [`SettingsSidebar.tsx:102`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSidebar.tsx#L102) | `<Lucide.Search>` 设置搜索 | Regular (400 占位符) | `1.75` | 图标比占位文本重 | **`1.5`** |
| [`SettingsSidebar.tsx:164`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSidebar.tsx#L164) | `<Icon>` Tab 列表项图标 | 默认 400 / 激活 500 | `1.75` 固定死 | 未激活时偏重，激活高亮时又未能加粗 | **默认 `1.5` / 激活 `2.0`** |
| [`AppTopBar.tsx:67`](file:///c:/Software/conex/apps/crish-desktop/src/components/top-bar/AppTopBar.tsx#L67) | `<HelpCircle>` 帮助入口 | 独立 14px 图标 | `1.75` | 14px 渲染时产生非整数网格软边缘 | **`1.5`** |

#### 3. 规范方案：动态同频与常量映射
建立统一的光学常量与组件支持：
1. **光学映射字典**（收敛至 `components/ui/tokens` 或相关声明）：
   ```ts
   export const ICON_STROKE_BY_WEIGHT = {
     normal: 1.5,   // 对应 font-weight: 400 (Regular)
     medium: 2.0,   // 对应 font-weight: 500~600 (Medium/Semibold)
     bold: 2.5,     // 对应 font-weight: 700 (Bold) 或强调独立图标
   } as const;
   ```
2. **在 Tab 导航与 Button 中形成联动**：
   - 普通状态（`font-weight: 400`）渲染 `strokeWidth={1.5}`；
   - 激活选中态（`font-weight: 500 / 600`，如 `activeNav === 'scheduled'` 或 `isTabActive`）动态注入 `strokeWidth={2.0}`。

---

## 三、桌面端业务组件裸写现象全面排查与改造方案

### 3.1 侧栏头部开关（`SidebarHeader.tsx`）

#### 1. 裸写代码定位
- 证据 1：[`SidebarHeader.tsx:47-57`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarHeader.tsx#L47-L57)（独立折叠开关）
- 证据 2：[`SidebarHeader.tsx:94-104`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarHeader.tsx#L94-L104)（侧栏顶栏内折叠开关）

```tsx
/* 现状：裸写 <button> 外层套 <Tooltip>，自造样式类名 */
<Tooltip content={toggleLabel}>
  <button
    type="button"
    className={`${styles.sidebarToggleBtn} sidebar-toggle-btn`}
    data-testid="sidebar-toggle"
    aria-label={toggleLabel}
    aria-expanded={!collapsed}
    aria-controls="crish-sidebar"
    onClick={onToggle}
  >
    <IconSidebarLeft size={16} aria-hidden="true" />
  </button>
</Tooltip>
```

#### 2. 问题与危害
- 业务方为该按钮在 `Sidebar.module.css:84-115` 手写了 32 行私有样式，包括尺寸（32x32）、无边框、圆角、光标、hover/active 颜色混合；
- 没有使用原子组件的 Focus Ring 规范（AGENTS.md §13 要求 3%~10% 混入），而是粗暴 `box-shadow: none`，破坏键盘无障碍（WCAG 2.4.7）；
- 外套 `<Tooltip>` 与裸 `<button>` 的无障碍属性割裂。

#### 3. 收敛方案（使用 `<IconButton>`）
```tsx
import { IconButton } from '../ui';

<IconButton
  size="md"
  variant="ghost"
  tooltip={toggleLabel}
  aria-label={toggleLabel}
  aria-expanded={!collapsed}
  aria-controls="crish-sidebar"
  data-testid="sidebar-toggle"
  onClick={onToggle}
  icon={<IconSidebarLeft size={16} aria-hidden="true" />}
/>
```

---

### 3.2 侧栏快捷导航与会话搜索（`SidebarNav.tsx`）

#### 1. 裸写代码定位
- 证据 1：[`SidebarNav.tsx:24-46`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.tsx#L24-L46)（新对话按钮）
- 证据 2：[`SidebarNav.tsx:47-56`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.tsx#L47-L56)（定时任务按钮）
- 证据 3：[`SidebarNav.tsx:58-72`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.tsx#L58-L72)（会话搜索框）

```tsx
/* 现状：完全避开 Button，在 CSS 注释中承认不走 Button 罩 */
<button
  type="button"
  className={styles.navItem}
  data-testid="new-session-button"
  onClick={onNewSession}
>
  ...
  <span>新对话</span>
</button>

<button
  type="button"
  className={`${styles.navItem}${scheduledActive ? ` ${styles.isActive}` : ''}`}
  data-testid="sidebar-nav-scheduled"
  aria-pressed={scheduledActive}
  onClick={onOpenScheduled}
>
  <Lucide.Clock size={16} strokeWidth={1.75} aria-hidden />
  <span>定时任务</span>
</button>

<div
  className={`${styles.navItem} no-drag`}
  role="search"
  aria-label="会话搜索"
>
  <Lucide.Search size={16} strokeWidth={1.75} aria-hidden="true" />
  <input
    type="search"
    placeholder="搜索会话与消息…"
    aria-label="搜索会话与消息"
    value={searchInput}
    onChange={(e) => onSearchChange(e.target.value)}
  />
</div>
```

#### 2. 问题与危害
- 开发者在 `SidebarNav.module.css:40-44` 写道：`/* 关掉 ui/Button ::before，避免暖褐 --sidebar-hover 再叠 6% 黑罩 */`。由于没有在 `<Button>` 抽象轻量侧栏变体，业务层索性手写了 99 行私有样式（`.navItem`、`.isActive`、`input[type='search']`）；
- 搜索框使用裸 `<input type="search">`，缺失 `Input.tsx` 中至关重要的 **IME 合成状态锁（`isComposingRef`）**，在 Windows/Mac 输入中文按回车时可能误触提交；
- 搜索框自造了 28 行 WebKit 清除按钮、放大镜的伪类清除样式（`.navItem input[type='search']::-webkit-search-*`），与原子 `<Input variant="search">` 完全重复。

#### 3. 收敛方案（使用 `<Button>` 与 `<Input>`）
- **按钮收敛**：
  使用带有 `block` 与 `active` 属性的 `<Button variant="ghost" size="md">`：
  ```tsx
  <Button
    variant="ghost"
    size="md"
    block
    data-testid="new-session-button"
    onClick={onNewSession}
    icon={<NewSessionIcon size={16} strokeWidth={2.0} aria-hidden="true" />}
  >
    新对话
  </Button>

  <Button
    variant="ghost"
    size="md"
    block
    active={scheduledActive}
    aria-pressed={scheduledActive}
    data-testid="sidebar-nav-scheduled"
    onClick={onOpenScheduled}
    icon={<Lucide.Clock size={16} strokeWidth={scheduledActive ? 2.0 : 1.5} aria-hidden />}
  >
    定时任务
  </Button>
  ```
- **搜索框收敛**：
  使用 `<Input variant="search" size="md">`：
  ```tsx
  <Input
    variant="search"
    size="md"
    placeholder="搜索会话与消息…"
    aria-label="搜索会话与消息"
    value={searchInput}
    onChange={(e) => onSearchChange(e.target.value)}
    prefixIcon={<Lucide.Search size={16} strokeWidth={1.5} />}
    clearable
    onClear={() => onSearchChange('')}
  />
  ```

---

### 3.3 侧栏底栏与设置齿轮（`SidebarFooter.tsx`）

#### 1. 裸写代码定位
- 证据：[`SidebarFooter.tsx:27-43`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx#L27-L43)（独立设置齿轮按钮）

```tsx
/* 现状：裸写 <button> 外包 <Tooltip> */
<Tooltip content={tooltipText}>
  <button
    type="button"
    className={`${styles.settingsGearBtn}${showSettings ? ` ${styles.isOpen}` : ''}`}
    data-testid="sidebar-settings-gear-btn"
    aria-label={tooltipText}
    aria-pressed={showSettings}
    onClick={() => toggleSettingsOverlay()}
  >
    <Lucide.Settings size={16} strokeWidth={1.75} aria-hidden />
    {updateAvailable && (
      <span
        className={styles.gearUpdatePulseDot}
        aria-label="新版本可用提示"
      />
    )}
  </button>
</Tooltip>
```

#### 2. 问题与危害
- 在 `Sidebar.module.css:258-286` 中维护了 29 行私有样式 `.settingsGearBtn`，与 `.sidebarToggleBtn` 几乎 90% 重复；
- 同文件内更新按钮使用了 `<Button variant="ghost" size="sm">`，而齿轮按钮却裸写，同一个 Footer 两种实现标准。

#### 3. 收敛方案（使用 `<IconButton>`）
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

---

### 3.4 用户个人卡片（`UserProfileCard.tsx`）

#### 1. 裸写代码定位
- 证据：[`UserProfileCard.tsx:31-57`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/UserProfileCard.tsx#L31-L57)

```tsx
/* 现状：复合触发器裸写 <button>，由外部注入 triggerProps */
<SettingsQuickMenu
  renderTrigger={({ open, triggerProps }) => (
    <button
      type="button"
      className={`${styles.userProfileCard}${open ? ` ${styles.isOpen}` : ''}`}
      data-testid="user-profile-card"
      aria-label={`用户卡片：${activeUser}，点击打开快捷菜单`}
      {...triggerProps}
    >
      <div className={styles.userAvatarContainer}>...</div>
      <div className={styles.userTextStack}>...</div>
      <Lucide.ChevronsUpDown size={13} strokeWidth={1.75} className={styles.userChevron} aria-hidden />
    </button>
  )}
/>
```

#### 2. 问题与危害
- 业务方在 `Sidebar.module.css:163-192` 手写了 30 行私有按钮样式，包含了重复的 `cursor: pointer`、`transition`、`background`、`:hover`、`:active` 等；
- 忽略了 `<Button bare>` 是专门为此类自定义复杂布局设计的标准原子接口。

#### 3. 收敛方案（使用 `<Button bare>`）
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

---

### 3.5 设置中心侧栏导航与搜索（`SettingsSidebar.tsx`）

#### 1. 裸写代码定位
- 证据 1：[`SettingsSidebar.tsx:4`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSidebar.tsx#L4) 及 [`L96-118`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSidebar.tsx#L96-L118)（设置搜索框，逆向依赖 `SidebarNav.module.css` 并裸写 `<input>`）
- 证据 2：[`SettingsSidebar.tsx:149-168`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSidebar.tsx#L149-L168)（分类标签页 Tab 按钮裸写）

```tsx
/* 证据 1：逆向引入跨域样式 */
import navStyles from '../sidebar/SidebarNav.module.css';

<div
  className={`${navStyles.navItem} no-drag`}
  role="search"
  aria-label="设置搜索"
  style={{ cursor: 'text' }}
>
  <Lucide.Search size={16} strokeWidth={1.75} aria-hidden="true" />
  <input
    ref={searchInputRef}
    id={searchId}
    type="search"
    placeholder="搜索设置…"
    value={searchQuery}
    onChange={(e) => onSearchChange(e.target.value)}
    onKeyDown={onSearchKeyDown}
    ...
  />
</div>

/* 证据 2：裸写 Tab 按钮并手写私有样式 */
<Tooltip content={tab.keywords.slice(0, 4).join(' · ')}>
  <button
    type="button"
    id={tabBtnId}
    role="tab"
    data-testid={`settings-tab-${tab.id}`}
    data-settings-tab-id={tab.id}
    aria-selected={isTabActive}
    aria-controls={isTabActive ? panelId : undefined}
    tabIndex={isRoving ? 0 : -1}
    aria-label={`${tab.group} · ${tab.label}`}
    onClick={() => onSelect(tab.id)}
    onFocus={() => onFocusTab(tab.id)}
    className={`${styles.sidebarTab} ${isTabActive ? styles.active : ''}`}
  >
    <span className={styles.sidebarTabIco} aria-hidden>
      <Icon size={16} strokeWidth={1.75} />
    </span>
    <span>{tab.label}</span>
  </button>
</Tooltip>
```

#### 2. 问题与危害
- **架构断层**：`components/settings/` 跨域反向 import `components/sidebar/SidebarNav.module.css`。这不仅严重违反三层解耦纪律，而且导致如果 sidebar 修改样式，设置中心就会意外破坏；
- **死代码与冗余技术债务**：`SettingsPanel.module.css` 自身其实定义了一整套 `.searchWrap` / `.search`（第 85-128 行，44 行），但 TSX 却从 sidebar 借用样式，两套私有搜索 CSS 同时并存、死活混杂；
- **Tab 样式重复造轮子**：`SettingsPanel.module.css:218-270` 维护了 53 行私有 Tab 按钮样式。

#### 3. 收敛方案（使用 `<Input>` 与 `<Button>`）
- **搜索框收敛**：
  彻底拔除 `navStyles` 导入，直接引入 `<Input>`：
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
    prefixIcon={<Lucide.Search size={16} strokeWidth={1.5} aria-hidden="true" />}
    clearable
    onClear={() => onSearchChange('')}
    aria-label="搜索设置分类"
    aria-controls={tablistId}
    aria-describedby={statusId}
  />
  ```
- **Tab 按钮收敛**：
  使用标准 `<Button>`，选中时为 `secondary` 实体轻卡片或带有 `active` 标识的 `ghost`，图标同步进行 strokeWidth 动态适配（未选中 1.5，选中 2.0）：
  ```tsx
  <Tooltip content={tab.keywords.slice(0, 4).join(' · ')}>
    <Button
      variant={isTabActive ? 'secondary' : 'ghost'}
      size="sm"
      block
      id={tabBtnId}
      role="tab"
      data-testid={`settings-tab-${tab.id}`}
      data-settings-tab-id={tab.id}
      aria-selected={isTabActive}
      aria-controls={isTabActive ? panelId : undefined}
      tabIndex={isRoving ? 0 : -1}
      aria-label={`${tab.group} · ${tab.label}`}
      onClick={() => onSelect(tab.id)}
      onFocus={() => onFocusTab(tab.id)}
      icon={<Icon size={16} strokeWidth={isTabActive ? 2.0 : 1.5} />}
    >
      {tab.label}
    </Button>
  </Tooltip>
  ```

---

### 3.6 顶栏帮助入口与窗控（`AppTopBar.tsx` / `WindowControls.tsx`）

#### 1. 裸写/覆盖代码定位
- 证据 1：[`AppTopBar.tsx:58-70`](file:///c:/Software/conex/apps/crish-desktop/src/components/top-bar/AppTopBar.tsx#L58-L70)（帮助按钮）
- 证据 2：[`WindowControls.tsx:73-116`](file:///c:/Software/conex/apps/crish-desktop/src/components/shell/WindowControls.tsx#L73-L116)（窗口控制按钮组）

```tsx
/* AppTopBar 现状：使用 Button 却用 .helpBtn 暴力覆盖 */
<Tooltip content="快捷键与帮助">
  <Button
    type="button"
    variant="ghost"
    size="sm"
    className={`${styles.helpBtn} app-top-bar__help-btn`}
    aria-label="快捷键与帮助"
    onClick={handleShowHelp}
    icon={<HelpCircle size={14} strokeWidth={1.75} aria-hidden="true" />}
  />
</Tooltip>
```

#### 2. 问题与危害
- `AppTopBar.module.css:57-84` 声明了 28 行 `.helpBtn` 样式，强行把 Button 的宽高覆盖为 28x28、清空 padding、重写 hover/active，导致原子 Button 内部规则被架空；
- `WindowControls.module.css:9-35` 声明了 27 行 `.winBtn`，覆盖了 `border-radius: 0; border: none; padding: 0`，并且在第 37-38 行硬编码了裸 hex 颜色 `#e81123` 与 `#ffffff`（违反 tokens.css 唯一源纪律）；
- 外层手动包 `<Tooltip>`，没有使用自带 Tooltip 能力的 `<IconButton>`。

#### 3. 收敛方案（使用 `<IconButton>`）
- `AppTopBar.tsx`：
  ```tsx
  <IconButton
    size="sm"
    variant="ghost"
    tooltip="快捷键与帮助"
    aria-label="快捷键与帮助"
    onClick={handleShowHelp}
    icon={<HelpCircle size={14} strokeWidth={1.5} aria-hidden="true" />}
  />
  ```
- `WindowControls.tsx`：
  窗控按钮属于无圆角纯贴边形态，收敛为 `<IconButton size="sm" variant="plain" ...>`，并将 hover 红色关闭态通过语义 token `--color-error` / `--text-on-accent` 接入，消除硬编码 hex。

---

## 四、原子组件收敛改造总对照表

| 目标业务文件 | 原裸写或违规实现 | 收敛后原子组件落地形式 | 传入关键参数与契约 | 收益（无障碍 / 健壮性） |
| :--- | :--- | :--- | :--- | :--- |
| `SidebarHeader.tsx` (L47, L94) | `<Tooltip><button className={styles.sidebarToggleBtn}>` | `<IconButton>` | `size="md"`, `variant="ghost"`, `tooltip={toggleLabel}` | 内置 Focus Ring、去重 Tooltip、统一 32px 方格 |
| `SidebarNav.tsx` (L24) | 裸写 `<button className={styles.navItem}>` (新对话) | `<Button>` | `variant="ghost"`, `size="md"`, `block`, `icon={<... strokeWidth={2.0} />}` | 自动获得 -2px 光学内边距补正、统一弹性形变 |
| `SidebarNav.tsx` (L47) | 裸写 `<button className={styles.navItem}>` (定时任务) | `<Button>` | `variant="ghost"`, `size="md"`, `block`, `active={scheduledActive}` | 语义化 `data-active`，消除黑罩叠加 hack |
| `SidebarNav.tsx` (L58) | 裸写 `<div> + <input type="search">` (会话搜索) | `<Input>` | `variant="search"`, `size="md"`, `prefixIcon={<Search />} `, `clearable` | **装配 IME 组合输入锁**、消除 Windows 边缘白边、原生清空 |
| `SidebarFooter.tsx` (L27) | `<Tooltip><button className={styles.settingsGearBtn}>` | `<IconButton>` | `size="md"`, `variant="ghost"`, `tooltip={tooltipText}`, `active={showSettings}` | 规范收敛设置齿轮与微脉冲红点复合插槽 |
| `UserProfileCard.tsx` (L31) | 裸写复合 `<button className={styles.userProfileCard}>` | `<Button>` | `bare={true}`, `className={styles.userProfileCard}`, `aria-label=...` | 规范化 `bare` 语义，无障碍屏幕阅读器可完整识读 |
| `SettingsSidebar.tsx` (L96) | 跨域引用 `SidebarNav.module.css` + 裸写 `<input>` | `<Input>` | `variant="search"`, `size="sm"`, `prefixIcon={<Search />} `, `clearable` | **彻底拔除跨域逆向 import**、统一 IME 保护 |
| `SettingsSidebar.tsx` (L149)| `<Tooltip><button className={styles.sidebarTab}>` | `<Button>` | `variant={isTabActive ? 'secondary' : 'ghost'}`, `size="sm"`, `block` | 获得标准 Secondary 纯白卡片或 Ghost 变体，图标自动 1.5/2.0 光学联动 |
| `AppTopBar.tsx` (L58) | `<Tooltip><Button className={styles.helpBtn}>` 强行打补丁 | `<IconButton>` | `size="sm"`, `variant="ghost"`, `tooltip="快捷键与帮助"` | 消除 28 行私有覆盖样式，标准化 28px 规格 |
| `WindowControls.tsx` (L73) | `<Button className={styles.winBtn}>` + 裸写 hex 颜色 | `<IconButton>` | `size="sm"`, `variant="plain"` | 消除裸 hex，统一通过语义 token 控制关闭悬浮红 |

---

## 五、私有样式删除面与负产出（Net-Negative LOC）清单

通过将上述各处裸写与私有修饰全面收敛回 `components/ui/`，可以彻底拔除以下大量重复、过时、甚至死代码的私有 CSS 声明：

### 5.1 精确删除行号清单

| 文件路径 | 待删除/清退的选择器与属性块 | 行号范围 | 净删除行数 | 清除性质与原因 |
| :--- | :--- | :--- | :--- | :--- |
| `Sidebar.module.css` | `.sidebarToggleBtn`, `.sidebarToggleBtn:hover`, `.sidebarToggleBtn:active` | Lines 84–115 | **32 行** | 裸写折叠按钮私有样式，收敛到 `<IconButton>` |
| `Sidebar.module.css` | `.userProfileCard` 基础交互与状态覆盖（保留内部布局） | Lines 163–192 | **30 行** | 裸写用户卡片交互，由 `<Button bare>` 与原子层接管 |
| `Sidebar.module.css` | `.settingsGearBtn`, `.settingsGearBtn:hover`, `.settingsGearBtn:active`, `.settingsGearBtn.isOpen` | Lines 258–286 | **29 行** | 裸写齿轮按钮私有样式，收敛到 `<IconButton>` |
| `SidebarNav.module.css` | `.navItem`, `.navItem::before`, `.navItem svg`, `.navItem:hover`, `.navItem.isActive`, `.navItem:focus-visible` | Lines 10–78 | **69 行** | 重复手写的伪 Button 体系及 hack 关闭 ::before 的代码 |
| `SidebarNav.module.css` | `.navItem[role='search']`, `.navItem input[type='search']`, `::-webkit-search-*` 重置 | Lines 79–108 | **30 行** | 裸写搜索框私有样式，收敛到 `<Input variant="search">` |
| `SettingsPanel.module.css` | `.navBack`, `.navBack:hover` | Lines 58–84 | **27 行** | **100% 历史死代码**（TSX 早已改用 Button） |
| `SettingsPanel.module.css` | `.searchWrap`, `.searchIco`, `.search`, `.search::placeholder`, `.search:focus` | Lines 85–128 | **44 行** | **100% 历史死代码**（TSX 误从 SidebarNav 借样式，此处置空无用） |
| `SettingsPanel.module.css` | `.sidebarTab`, `.sidebarTab:hover`, `.sidebarTab.active`, `.sidebarTabIco` | Lines 218–270 | **53 行** | 裸写 Tab 按钮私有样式，收敛到 `<Button>` |
| `AppTopBar.module.css` | `.helpBtn`, `.helpBtn:hover`, `.helpBtn:active` | Lines 57–84 | **28 行** | 覆盖 Button 的私有尺寸与交互样式，收敛到 `<IconButton>` |
| `WindowControls.module.css` | `.winBtn`, `.winBtn:hover`, `.winBtn:active` 冗余声明 | Lines 9–35 | **27 行** | 窗控覆盖样式收敛，去除硬编码 hex 颜色 |

### 5.2 负产出统计汇总
- **CSS 样式净删除总量**：**`369 行`** 有效代码！
- **跨模块逆向依赖清零**：消除 `SettingsSidebar.tsx` 中 `import navStyles from '../sidebar/SidebarNav.module.css'` 违规导入。
- **死代码清退率**：拔除 `SettingsPanel.module.css` 中 71 行无主死样式。

---

## 六、分阶段实施路线与质量守门

### 6.1 阶段推进路线
1. **基建级光学增强（Step 1）**：
   - 在 `Button.tsx` / `Button.module.css` 中注入 `data-icon-pos`，落地 `-2px` 前后置图标光学内边距补偿；
   - 建立 `ICON_STROKE_BY_WEIGHT` 常量映射，统一规范 400 字重对应 `1.5px`、500/600 对应 `2.0px`。
2. **顶栏与窗控轻量收敛（Step 2）**：
   - 改造 `AppTopBar.tsx`，将帮助入口替换为 `<IconButton size="sm" variant="ghost">`，删除 `AppTopBar.module.css:57-84`（-28 行）；
   - 规范 `WindowControls.tsx`，清除裸 hex 色号，规范 Focus 行为。
3. **侧栏全线收敛（Step 3）**：
   - 改造 `SidebarHeader.tsx`，收敛侧栏开关至 `<IconButton>`，删除 `Sidebar.module.css:84-115`（-32 行）；
   - 改造 `SidebarNav.tsx`，收敛新对话与定时任务至 `<Button block>`，收敛搜索框至 `<Input variant="search">`，删除 `SidebarNav.module.css:10-108`（-99 行）；
   - 改造 `SidebarFooter.tsx`，收敛设置齿轮至 `<IconButton>`，删除 `Sidebar.module.css:258-286`（-29 行）；
   - 改造 `UserProfileCard.tsx`，使用 `<Button bare>` 接管交互，精简私有样式（-30 行）。
4. **设置中心解耦与清死（Step 4）**：
   - 改造 `SettingsSidebar.tsx`，断开对 `SidebarNav.module.css` 的逆向引用，搜索框全面收敛为 `<Input variant="search">`，Tab 按钮收敛为 `<Button block>`；
   - 彻底删除 `SettingsPanel.module.css` 中的 `.navBack`、`.search*`、`.sidebarTab*`（-124 行）。

### 6.2 质量守门与验证断言
实施过程中与完成后，必须履行立体化验证（对齐 AGENTS.md §7.1）：
1. **分层门禁刚性拦截**：
   ```bash
   npm run check:ui-layer
   ```
   验证原子层无反向依赖，且业务组件间无跨域 CSS 导入。
2. **类型检查与单元测试**：
   ```bash
   npm run typecheck
   npm test
   ```
   验证 `Button.test.tsx`、`Input.test.tsx` 以及涉及的侧栏/设置页单测 100% 跑通。
3. **真实运行时现场与光学验收**：
   - 启动 Tauri 桌面应用（`npm run dev:workbench`），通过 Tauri MCP 检查 WebView 真实渲染；
   - 验证带图标按钮的左右间距：测量 Leading Icon 左侧内边距确实比右侧文本内边距收窄 `2px`；
   - 验证输入法 IME：在会话搜索框和设置搜索框输入中文拼音时，按下回车键不会异常触发清空或失焦；
   - 验证高对比度与深浅色模式：验证 Secondary 按钮实体卡片底与 Ghost 按钮在 `:hover` 与 `:active` 时零色差、零跳动。
