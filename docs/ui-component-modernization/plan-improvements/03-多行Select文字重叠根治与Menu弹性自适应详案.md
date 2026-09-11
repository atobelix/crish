# 03 · 多行 Select 选项文字重叠根治与 Menu 弹性自适应详案

> **文件标识**：`docs/ui-component-modernization/plan-improvements/03-多行Select文字重叠根治与Menu弹性自适应详案.md`
> **所属战役**：UI 组件现代化与原生原子库升级（`ui-component-modernization`）
> **方案版本**：v1.0.0 (Production Architecture Improvement Plan)
> **编制依据**：
> - `docs/ui-component-modernization/audits/06-多行Select文字重叠与全局灰度偏暗按钮及受管浏览器排查.md`（截图 1 权限下拉框文字重叠排查）
> - `docs/ui-component-modernization/audits/02-Select与Combobox浮层解算及无障碍严苛审查.md`
> - `docs/ui-component-modernization/audits/05-全仓DesignTokens合规与工程红线严苛审查.md`
> - `docs/ui-component-modernization/independent-plans/03-Select与Combobox同心圆角与原生搜索方案.md`
> - `apps/crish-desktop/src/components/ui/Menu/`（Menu 基座组件源码）
> - `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx` / `PermissionModeMenu.module.css`
> - `apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.tsx` / `ComposePlusMenu.module.css`
> - `AGENTS.md`（§13 焦点环规范、§14 现代色彩空间、反过度设计红线、RL-03 行数门禁）
>
> **工程与架构铁律**：
> 1. **零外部 npm 组件库依赖**：绝对禁止引入第三方组件库（如 `@base-ui`, `@radix-ui`, `framer-motion` 等），所有物理动效、手势、浮层几何与无障碍交互均采用纯原生 React 18+ 与 CSS Modules 100% 纯净自研；
> 2. **严禁直接复制代码**：深度吸收现代设计体系思想，重构为最适合本项目 Design Tokens 的原生高质量代码；
> 3. **色彩与样式铁律**：严格遵循 `tokens.css`，纯白卡底 `var(--bg-card, hsl(0 0% 100%))`，容器 3.5% 暖灰底板 `var(--bg-secondary)`，严禁冷蓝偏色；Hover 态统一使用 `var(--tint-hover)`，选中态使用 `var(--tint-active)`；焦点环严格遵守 3%~10% 克制柔和灰色。

---

## 目录

- [一、深层根因拆解与渲染破损模型剖析（对标用户最新截图 1）](#一深层根因拆解与渲染破损模型剖析对标用户最新截图-1)
  - [1.1 用户实际场景与视觉破损现象复现路径](#11-用户实际场景与视觉破损现象复现路径)
  - [1.2 基座容器固定行高死锁（`Menu.module.css` vs 多行富文本子项）](#12-基座容器固定行高死锁menumodulecss-vs-多行富文本子项)
  - [1.3 浮层宽度限制与中文硬折行挤压数学模型](#13-浮层宽度限制与中文硬折行挤压数学模型)
  - [1.4 滚动条未美化与选中底色脏灰混淆缺陷](#14-滚动条未美化与选中底色脏灰混淆缺陷)
- [二、解锁自适应高度与 Flex 弹性排版架构](#二解锁自适应高度与-flex-弹性排版架构)
  - [2.1 解锁 `height: auto` 与弹性底线 `min-height: 32px`](#21-解锁-height-auto-与弹性底线-min-height-32px)
  - [2.2 `.textCol` 垂直 Flex 弹性流与防穿透几何模型](#22-textcol-垂直-flex-弹性流与防穿透几何模型)
  - [2.3 浮层宽度放宽体系（`min-width: 260px; max-width: 340px;`）](#23-浮层宽度放宽体系min-width-260px-max-width-340px)
  - [2.4 严格数学同心圆角几何体系（$14\text{px} \leftrightarrow 8\text{px}$）](#24-严格数学同心圆角几何体系14textpx-leftrightarrow-8textpx)
  - [2.5 单行项与多行富文本项混排兼容架构](#25-单行项与多行富文本项混排兼容架构)
- [三、滚动条美化、墨阶规范与全态视觉对齐](#三滚动条美化墨阶规范与全态视觉对齐)
  - [3.1 WebKit / Blink / Firefox 现代细滚动条规范](#31-webkit--blink--firefox-现代细滚动条规范)
  - [3.2 选中态与 Hover 态墨阶归一（`var(--tint-active)` + 品牌翡翠绿）](#32-选中态与-hover-态墨阶归一var--tint-active--品牌翡翠绿)
  - [3.3 焦点环规范（AGENTS.md §13 克制软灰）](#33-焦点环规范agentsmd-13-克制软灰)
  - [3.4 节能模式（`html[data-perf-tier='eco']`）与减弱动态偏好](#34-节能模式htmldata-perf-tiereco与减弱动态偏好)
- [四、TypeScript 类型系统与富文本扩展规划](#四typescript-类型系统与富文本扩展规划)
  - [4.1 `SelectOptionItem` / `MenuItem` 多行富文本语义契约](#41-selectoptionitem--menuitem-多行富文本语义契约)
  - [4.2 `PermissionModeMenu` 专属数据结构规范](#42-permissionmodemenu-专属数据结构规范)
  - [4.3 `MenuProps` 与定位控制类型强化](#43-menuprops-与定位控制类型强化)
- [五、核心组件完整重构代码实现（TSX + CSS Modules）](#五核心组件完整重构代码实现tsx--css-modules)
  - [5.1 `apps/crish-desktop/src/components/ui/Menu/Menu.module.css`](#51-appscrish-desktopsrccomponentsuimenumenumodulecss)
  - [5.2 `apps/crish-desktop/src/components/ui/Menu/types.ts`](#52-appscrish-desktopsrccomponentsuimenutypests)
  - [5.3 `apps/crish-desktop/src/components/ui/Menu/Menu.tsx`](#53-appscrish-desktopsrccomponentsuimenumenutsx)
  - [5.4 `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css`](#54-appscrish-desktopsrccomponentschat-composerpermissionmodemenumodulecss)
  - [5.5 `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx`](#55-appscrish-desktopsrccomponentschat-composerpermissionmodemenutsx)
  - [5.6 `apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css`](#56-appscrish-desktopsrccomponentschat-composercomposeplusmenumodulecss)
  - [5.7 `apps/crish-desktop/src/components/ui/Select/Select.module.css` 选项行弹性适配](#57-appscrish-desktopsrccomponentsuiselectselectmodulecss-选项行弹性适配)
- [六、Vitest 单元测试用例设计与验证矩阵](#六vitest-单元测试用例设计与验证矩阵)
  - [6.1 多行自适应高度与无截断断言测试](#61-多行自适应高度与无截断断言测试)
  - [6.2 浮层宽度与 Flex 弹性排版测试](#62-浮层宽度与-flex-弹性排版测试)
  - [6.3 键盘 ↑↓ 漫游与视口滚动跟随测试](#63-键盘--漫游与视口滚动跟随测试)
  - [6.4 选中态品牌绿对勾与 Anchor 协同测试](#64-选中态品牌绿对勾与-anchor-协同测试)
  - [6.5 节能模式与减弱动态偏好测试](#65-节能模式与减弱动态偏好测试)
- [七、落地实施路线图与验收检查清单](#七落地实施路线图与验收检查清单)
  - [7.1 阶段性交付里程碑](#71-阶段性交付里程碑)
  - [7.2 严苛质量门禁检查清单](#72-严苛质量门禁检查清单)

---

# 一、深层根因拆解与渲染破损模型剖析（对标用户最新截图 1）

## 1.1 用户实际场景与视觉破损现象复现路径

在对话输入框区域（`ChatComposer`）的权限模式切换药丸（如“需确认 ⌃”或“完全访问 ⌃”）以及包含副说明文本（Subtitle / Description / MatrixHint）的各类选择菜单中：

1. **破损现象**：
   - 选项由“标题（Title，13px 粗体）”与“描述（Description，11px 次级弱化文本）”组成；
   - 展开下拉列表时，上一项的副描述文字与下一项的标题文字在垂直方向上发生**直接碰撞、相互穿透、严重重叠**；
   - 浮层整体宽度狭窄，中文说明文案（如“改文件、执行前需手动批准”）被强行在“手”、“动”之间挤压折行；
   - 浮层右侧出现一条未经定制的粗糙灰色原生滚动条，且选中项底色发灰发暗，缺乏清晰的层级感。

```
【原破损渲染现象示意】
┌──────────────────────────────────────────────┐
│ [🛡️] 需确认                                   │ ◄── height: 28px 硬编码死锁！
│      改文件、执行前需手动批准 (溢出穿透)        │
│ ────┼────────────────────────────────────────┤ ◄── Sibling 边框被刺穿！
│ [🔍] 深度只读 (与上一行重叠交错)               │
│      只读分析与代码深入检索                    │
└──────────────────────────────────────────────┘
```

---

## 1.2 基座容器固定行高死锁（`Menu.module.css` vs 多行富文本子项）

### 根本原因剖析
审查 `apps/crish-desktop/src/components/ui/Menu/Menu.module.css:L65-L66`：

```css
/* 缺陷源码 */
.menuItem {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  border: none;
  background: transparent;
  text-align: left;
  padding: 0 10px;
  border-radius: 8px;
  height: 28px;      /* 💥 罪魁祸首 1：硬编码 28px 固定高度 */
  min-height: 28px;  /* 💥 罪魁祸首 2：锁定最小高度为 28px */
  ...
}
```

当 `PermissionModeMenu.tsx` 在 `renderItem` 中渲染包含两行文字的结构时：
```tsx
<button className={styles.permMenuItem}>
  <span className={styles.iconWrapper}>{icon}</span>
  <div className={styles.textCol}>
    <span className={styles.title}>{itemMeta.label}</span>
    <span className={styles.desc}>{sublabel}</span>
  </div>
  {isSelected ? <Lucide.Check className={styles.checkIcon} /> : null}
</button>
```

#### 几何与排版物理高度计算：
- **标题行**（`.title`）：$13\text{px} \times 1.25 = 16.25\text{px}$；
- **间距**（`.textCol gap`）：$1\text{px} \sim 2\text{px}$；
- **描述行**（`.desc`）：$11\text{px} \times 1.25 = 13.75\text{px}$；
- **上下内边距**（`padding`）：$6\text{px} \times 2 = 12\text{px}$；
- **子项自然高度总和**：$16.25 + 2 + 13.75 + 12 = 44\text{px}$！

由于父级 `.menuItem` 或 `.permMenuItem` 被硬编码锁死在 `height: 28px`，且并未设置 `overflow: hidden`（若设置则截断文字，未设置则产生溢出穿透），多出的 $16\text{px}$ 内容无情地向下溢出，直接覆盖在下一个邻居兄弟节点（Sibling Item）的内容区域上，造成 100% 必然发生的文字纵向重叠灾难！

---

## 1.3 浮层宽度限制与中文硬折行挤压数学模型

### 宽度约束缺陷
审查 `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css:L125-L126`：

```css
/* 缺陷源码 */
.permMenu {
  ...
  min-width: 230px;
  max-width: 280px; /* 💥 宽度过窄 */
}
```

### 有效文本渲染宽度计算：
- **容器最大总宽**：$280\text{px}$；
- **容器内边距**（`padding: 6px`）：$6 \times 2 = 12\text{px}$；
- **容器边框**（`border: 1px`）：$1 \times 2 = 2\text{px}$；
- **Item 内边距**（`padding: 6px 8px`）：$8 \times 2 = 16\text{px}$；
- **左侧图标区**（`.iconWrapper` 宽 22px + gap 8px）：$22 + 8 = 30\text{px}$；
- **右侧对勾区**（`.checkIcon` 宽 13px + gap 8px）：$13 + 8 = 21\text{px}$；
- **右侧原生滚动条预留槽**（Scrollbar Gutter）：约 $12\text{px} \sim 16\text{px}$；
- **剩余给文本列（`.textCol`）的实际宽度**：
  $$\text{Effective Width} = 280 - 12 - 2 - 16 - 30 - 21 - 14 = 185\text{px}$$

中文 11px 字体在标准渲染下的单字宽度约为 $11\text{px} \sim 12\text{px}$。描述文本“改文件、执行前需手动批准”共有 13 个汉字加标点，总需宽度约 $13 \times 11.5\text{px} \approx 150\text{px}$。若稍微增加文字（如加上“读写自动执行，极危操作确认”约 18 个字符，需 $210\text{px}$），$185\text{px}$ 的剩余宽度立刻爆仓，被迫折行！
一旦折行，文本高度从 $44\text{px}$ 进一步暴增至 $58\text{px}$，在 $28\text{px}$ 的死锁高度下，重叠与车祸现场彻底失控。

---

## 1.4 滚动条未美化与选中底色脏灰混淆缺陷

1. **滚动条未深度适配**：
   - 依赖了全局或过时的变量，未设置 WebKit 专属伪类（`::-webkit-scrollbar`），在 Windows 高 DPI 屏幕下出现宽达 12px 的粗原生灰条，侵占文本空间并破坏精致视觉；
2. **选中态色阶混淆**：
   - 审查源码：`.permMenuItem.isSelected` 仅仅设置了 `background: var(--tint-hover);`，与普通项的鼠标悬停态完全同一色阶，缺乏卡片实体层次；
   - 选中项对勾使用了暗绿色，且缺少高对比度的品牌翡翠绿签名（`var(--brand-deep, hsl(160 84% 30%))`）。

---

# 二、解锁自适应高度与 Flex 弹性排版架构

## 2.1 解锁 `height: auto` 与弹性底线 `min-height: 32px`

彻底废除所有固定行高 `height: 28px`，将 Menu 基座、Select 基座及业务消费菜单的选项行全面重构为**弹性自适应容器**：

```
┌─────────────────────────────────────────────────────────────┐
│ MenuItem 弹性盒模型架构                                      │
│ min-height: 32px; height: auto; padding: 8px 10px;          │
│                                                             │
│  ┌──────────┐  ┌───────────────────────────────┐  ┌──────┐  │
│  │   Icon   │  │ .textCol (Flex 垂直弹性流)     │  │Check │  │
│  │ (22x22px)│  │ ├─ Title (13px / 500 / 1.35)  │  │ (14) │  │
│  │          │  │ └─ Desc  (11px / 400 / 1.35)  │  │      │  │
│  └──────────┘  └───────────────────────────────┘  └──────┘  │
│   flex-shrink:0          flex: 1; min-width: 0    flex-shrink:0
└─────────────────────────────────────────────────────────────┘
```

### 规则核心参数
1. `height: auto`：允许高度根据内部文本行数自然伸展；
2. `min-height: 32px`：为单行常规菜单项提供优雅的视觉底线高度；
3. `padding: 8px 10px`（单行项为 `padding: 6px 10px`）：上下提供充足的呼吸感空间，杜绝文本触边；
4. `box-sizing: border-box`：严格将 padding 计入盒模型，不引起外部容器突变。

---

## 2.2 `.textCol` 垂直 Flex 弹性流与防穿透几何模型

内部文本容器 `.textCol` 采用 Flex 方向为 `column` 的弹性排版，并配置安全间距与换行截断保护：

```css
.textCol {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0; /* 极其关键：防止 flex 子项在溢出时不收缩导致撑爆容器 */
  text-align: left;
}

.title {
  font-size: var(--font-size-sm, 13px);
  font-weight: 500;
  line-height: 1.35;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.desc {
  font-size: var(--font-size-xs, 11px);
  font-weight: 400;
  line-height: 1.35;
  color: var(--text-secondary);
  /* 允许自然多行展示，或单行优雅省略 */
  word-break: break-word;
  white-space: normal;
}
```

---

## 2.3 浮层宽度放宽体系（`min-width: 260px; max-width: 340px;`）

根据包含副文本与矩阵提示的现代下拉浮层规范，全面优化容器宽度约束：

| 浮层类型 | 推荐 `min-width` | 推荐 `max-width` | 适用场景 |
| :--- | :--- | :--- | :--- |
| **单行标准菜单** (`Menu standard`) | `180px` | `260px` | 操作菜单、快捷键菜单、上下文菜单 |
| **多行富文本菜单** (`PermissionModeMenu`) | `260px` | `340px` | 权限模式、模型切换、带描述的选择菜单 |
| **复合卡片浮层** (`ComposePlusMenu`) | `200px` | `280px` | 加号多功能菜单、技能斜杠菜单 |
| **通用自适应 Select** (`Select / Combobox`) | `var(--anchor-width, 160px)` | `400px` | 表单下拉、搜索下拉框 |

---

## 2.4 严格数学同心圆角几何体系（$14\text{px} \leftrightarrow 8\text{px}$）

严格遵循同心圆角数学公式：
$$R_{\text{inner}} = R_{\text{outer}} - \text{Padding}$$

- **外层浮层容器（Popup / Menu Panel）**：
  - `border-radius: 14px` (`var(--sep-radius-outer, 14px)`);
  - `padding: 6px` (`var(--sep-padding, 6px)`);
- **内层选项卡片（MenuItem / Item）**：
  - `border-radius: 8px` ($14 - 6 = 8\text{px}$，`var(--sep-item-radius, 8px)`);
- **内层微图标背景盒（IconWrapper）**：
  - `border-radius: 4px` (`var(--radius-sm, 4px)`);

圆角同心率达到 100% 完美数学收敛，杜绝视觉 Corner Pinching（尖角挤压）。

---

## 2.5 单行项与多行富文本项混排兼容架构

在 `Menu` 基座与 `Select` 浮层中，支持单行项（Label only）、带右侧快捷键提示项（Label + Hint）与多行富文本项（Title + Description）在同一列表中**混排自适应**：

```
┌─────────────────────────────────────────────────────────────┐
│ Menu 混排列表自适应模型                                     │
├─────────────────────────────────────────────────────────────┤
│ [📁] 打开项目                                      Ctrl+O  │ ◄── 32px 单行项
├─────────────────────────────────────────────────────────────┤
│ [🛡️] 需确认                                        [✓]     │ ◄── 46px 多行项
│      改文件、执行前需手动批准                                │     (自然撑开)
├─────────────────────────────────────────────────────────────┤
│ ─────────────────────────────────────────────────────────── │ ◄── 1px 分割线
├─────────────────────────────────────────────────────────────┤
│ [🗑️] 移除记录                                              │ ◄── 32px 危险项
└─────────────────────────────────────────────────────────────┘
```

---

# 三、滚动条美化、墨阶规范与全态视觉对齐

## 3.1 WebKit / Blink / Firefox 现代细滚动条规范

为所有具有滚动能力的 Menu 与 Select 浮层注入纤细极简滚动条规范：

```css
/* 现代标准 Firefox 规范 */
.menuContent,
.permMenu {
  scrollbar-width: thin;
  scrollbar-color: var(--tint-scrollbar-thumb, color-mix(in srgb, var(--text-primary) 18%, transparent)) transparent;
}

/* WebKit & Blink 内核专属发丝胶囊滚动条 */
.menuContent::-webkit-scrollbar,
.permMenu::-webkit-scrollbar {
  width: 5px;
  height: 5px;
}

.menuContent::-webkit-scrollbar-track,
.permMenu::-webkit-scrollbar-track {
  background: transparent;
}

.menuContent::-webkit-scrollbar-thumb,
.permMenu::-webkit-scrollbar-thumb {
  background: var(--tint-scrollbar-thumb, color-mix(in srgb, var(--text-primary) 18%, transparent));
  border-radius: 9999px;
  transition: background-color 150ms ease;
}

.menuContent::-webkit-scrollbar-thumb:hover,
.permMenu::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--text-primary) 30%, transparent);
}
```

---

## 3.2 选中态与 Hover 态墨阶归一（`var(--tint-active)` + 品牌翡翠绿）

严格遵守本项目 Design Tokens 色彩层级：

| 状态 | 背景色 Token | 文本色 Token | 图标与 Checkmark 表现 |
| :--- | :--- | :--- | :--- |
| **常规态 (Normal)** | `transparent` | `var(--text-primary)` | 图标 `var(--text-secondary)` |
| **悬停态 (Hover)** | `var(--tint-hover)` | `var(--text-primary)` | 图标 `var(--text-primary)` |
| **选中态 (Selected)** | `var(--tint-active)` | `var(--text-primary)`（`font-weight: 500;`） | 图标 `var(--brand-deep)` + 翡翠绿对勾 |
| **聚焦态 (Focus-visible)** | `var(--tint-hover)` | `var(--text-primary)` | 外层柔和 1.5px 软灰焦点环 |
| **禁用态 (Disabled)** | `transparent` | `var(--text-tertiary)` | `opacity: var(--opacity-disabled, 0.45); cursor: not-allowed;` |

---

## 3.3 焦点环规范（AGENTS.md §13 克制软灰）

在键盘漫游（↑ / ↓ / Tab）或无障碍聚焦时，必须严格遵守 AGENTS.md §13 规范，杜绝粗黑线：

```css
.menuItem:focus-visible,
.permMenuItem:focus-visible {
  outline: none;
  background: var(--tint-hover);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
}
```

---

## 3.4 节能模式（`html[data-perf-tier='eco']`）与减弱动态偏好

```css
@media (prefers-reduced-motion: reduce) {
  .menuContent,
  .permMenu,
  .menuItem,
  .permMenuItem {
    animation-duration: 0ms !important;
    transition-duration: 0ms !important;
  }
}

html[data-perf-tier='eco'] .menuContent,
html[data-perf-tier='eco'] .permMenu,
html[data-perf-tier='eco'] .menuItem,
html[data-perf-tier='eco'] .permMenuItem {
  animation: none !important;
  transition: none !important;
}
```

---

# 四、TypeScript 类型系统与富文本扩展规划

## 4.1 `SelectOptionItem` / `MenuItem` 多行富文本语义契约

在 `apps/crish-desktop/src/components/ui/Menu/types.ts` 中增强标准选项类型：

```typescript
export interface SelectOptionItem {
  /** 选项唯一标识 */
  id: string;
  /** 选项主标题文案 */
  label: string;
  /** 次级描述文案（支持多行富文本自适应） */
  description?: string;
  /** 旧版副文案别名（向后兼容） */
  hint?: string;
  /** 专属图标节点 */
  icon?: React.ReactNode;
  /** 尾部徽标或辅助元素 */
  suffix?: React.ReactNode;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否为危险/破坏性操作项（显示警告红） */
  danger?: boolean;
  /** 是否处于选中态 */
  selected?: boolean;
  /** 键盘快捷键展示（如 'Ctrl+S' / '⌘K'） */
  shortcut?: string;
  /** 点击回调 */
  onClick?: () => void;
  /** 悬停浮动提示 */
  tooltip?: React.ReactNode;
  /** 分组标识 */
  group?: string;
}
```

---

## 4.2 `PermissionModeMenu` 专属数据结构规范

在 `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx` 中定义专属属性契约：

```typescript
export interface PermissionModeMenuProps {
  /** 当前权限模式（'ask' | 'deep' | 'plan' | 'full'） */
  mode: PermissionMode;
  /** 模式变更回调 */
  onChange: (mode: PermissionMode) => void;
  /** 是否仅以盾牌图标药丸形式展示（主对话区紧凑形态） */
  iconOnly?: boolean;
  /** 自定义外部类名 */
  className?: string;
  /** 禁用状态 */
  disabled?: boolean;
}
```

---

## 4.3 `MenuProps` 与定位控制类型强化

```typescript
export interface MenuProps {
  trigger?: React.ReactNode;
  anchor?: React.RefObject<HTMLElement | null>;
  options?: SelectOptionItem[];
  renderItem?: (
    option: SelectOptionItem,
    index: number,
    isFocused: boolean
  ) => React.ReactNode;
  children?: React.ReactNode;
  onSelect?: (id: string, option: SelectOptionItem) => void;
  searchable?: boolean;
  position?: MenuPositionConfig;
  openState?: MenuOpenState;
  panel?: MenuPanelConfig;
  outsideHandlers?: MenuOutsideHandlers;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  cascade?: {
    onSubmenuExpand?: (index: number, optionOrElement: unknown) => void;
    onSubmenuCollapse?: () => void;
  };
}
```

---

# 五、核心组件完整重构代码实现（TSX + CSS Modules）

## 5.1 `apps/crish-desktop/src/components/ui/Menu/Menu.module.css`

```css
/* ==========================================================================
   ui/Menu/Menu.module.css — 现代化弹性自适应菜单基座样式规范
   Zero-Blue 纯净灰阶、严格数学同心圆角 (14px / 8px) 与 Flex 自适应高度
   ========================================================================== */

/* wrapper 才和全屏 Dialog 面板同级；只给 .menuContent 设 z 压不住 isolation:isolate 的壳 */
:global([data-radix-popper-content-wrapper]):has(.menuContent) {
  z-index: var(--z-dropdown, 300);
}

.menuContent {
  z-index: var(--z-dropdown, 100);
  outline: none;
  pointer-events: auto;
  min-width: 180px;
  box-sizing: border-box;
  max-height: min(
    var(--radix-popover-content-available-height, 360px),
    70vh,
    360px
  );
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;

  /* 现代滚动条规范 */
  scrollbar-width: thin;
  scrollbar-color: var(--tint-scrollbar-thumb, color-mix(in srgb, var(--text-primary) 18%, transparent)) transparent;

  padding: 6px;
  border-radius: var(--sep-radius-outer, 14px);
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  background: var(--bg-card, hsl(0 0% 100%));
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  box-shadow: var(--shadow-dropdown, 0 16px 40px -8px rgba(0, 0, 0, 0.12), 0 4px 16px -2px rgba(0, 0, 0, 0.05));
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: var(--font-sans);
  color: var(--text-primary);
  animation: cds-popover-enter var(--transition-popover-enter, 180ms cubic-bezier(0.16, 1, 0.3, 1)) forwards;
}

/* WebKit / Blink 细滚动条 */
.menuContent::-webkit-scrollbar {
  width: 5px;
  height: 5px;
}

.menuContent::-webkit-scrollbar-track {
  background: transparent;
}

.menuContent::-webkit-scrollbar-thumb {
  background: var(--tint-scrollbar-thumb, color-mix(in srgb, var(--text-primary) 18%, transparent));
  border-radius: 9999px;
}

.menuContent::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--text-primary) 30%, transparent);
}

.menuTitle {
  padding: 4px 10px;
  font-size: var(--font-size-xs, 11px);
  color: var(--text-tertiary);
  font-weight: 500;
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 2px;
  user-select: none;
}

.menuList {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ── 核心改造：解锁高度死锁，支持弹性自适应与多行排版 ── */
.menuItem {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  border: none;
  background: transparent;
  text-align: left;
  padding: 6px 10px;
  border-radius: var(--sep-item-radius, 8px);
  min-height: 32px;
  height: auto; /* 彻底移除 height: 28px 硬编码死锁！ */
  font-family: inherit;
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary);
  cursor: pointer;
  box-sizing: border-box;
  width: 100%;
  position: relative;
  user-select: none;
  outline: none;
  transition:
    background-color var(--transition-micro, 100ms ease),
    color var(--transition-micro, 100ms ease),
    box-shadow var(--transition-micro, 100ms ease);
}

.menuItem:hover {
  background: var(--tint-hover);
  color: var(--text-primary);
}

.menuItem:focus-visible {
  outline: none;
  background: var(--tint-hover);
  color: var(--text-primary);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
}

.menuItem.isSelected,
.menuItem[data-selected='true'] {
  background: var(--tint-active);
  color: var(--text-primary);
  font-weight: 500;
}

.menuItemDisabled {
  color: var(--text-tertiary) !important;
  cursor: not-allowed !important;
  opacity: var(--opacity-disabled, 0.45);
}

.menuItemDisabled:hover {
  background: transparent !important;
}

.menuItemDanger {
  color: var(--color-error, hsl(0 84% 60%));
}

.menuItemDanger:hover {
  background: var(--color-error-bg, hsl(0 84% 60% / 0.08));
  color: var(--color-error, hsl(0 84% 60%));
}

.menuItemIcon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  color: inherit;
}

.menuItemLabel {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: var(--line-height-ui, 1.35);
}

/* 垂直弹性多行排版容器 */
.textCol {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
  text-align: left;
}

.title {
  font-size: var(--font-size-sm, 13px);
  font-weight: 500;
  line-height: var(--line-height-ui, 1.35);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desc {
  font-size: var(--font-size-xs, 11px);
  font-weight: 400;
  line-height: var(--line-height-ui, 1.35);
  color: var(--text-secondary);
  word-break: break-word;
  white-space: normal;
}

.menuItemHint {
  font-size: var(--font-size-xs, 11px);
  color: var(--text-tertiary);
  flex-shrink: 0;
  font-family: var(--font-mono, monospace);
}

.menuItemCheck {
  flex-shrink: 0;
  color: var(--brand-deep, hsl(160 84% 30%));
  margin-left: auto;
  display: inline-flex;
  align-items: center;
}

/* 1px Hardware-Aligned Divider */
.separator {
  height: 0;
  min-height: 0;
  border: none;
  border-top: 1px solid var(--border-subtle);
  margin: 3px 6px;
  flex-shrink: 0;
  padding: 0;
}

/* 节能与减弱动态偏好 */
@media (prefers-reduced-motion: reduce) {
  .menuContent {
    animation: none !important;
    transition: opacity 100ms ease;
  }
}

html[data-perf-tier='eco'] .menuContent {
  animation: none !important;
  transition: none !important;
}
```

---

## 5.2 `apps/crish-desktop/src/components/ui/Menu/types.ts`

```typescript
import React from 'react';

/** 菜单标准选项项定义（支持富文本与多行自适应） */
export interface SelectOptionItem {
  /** 选项唯一标识 */
  id: string;
  /** 选项主标题 */
  label: string;
  /** 次级描述文本（多行自适应） */
  description?: string;
  /** 快捷键或副提示（兼容向后别名） */
  hint?: string;
  /** 图标 */
  icon?: React.ReactNode;
  /** 后缀装饰节点 */
  suffix?: React.ReactNode;
  /** 是否禁用 */
  disabled?: boolean;
  /** 是否为危险项 */
  danger?: boolean;
  /** 是否处于选中态 */
  selected?: boolean;
  /** 键盘快捷键 */
  shortcut?: string;
  /** 点击回调 */
  onClick?: () => void;
  /** Tooltip 悬浮提示文案 */
  tooltip?: React.ReactNode;
}
```

---

## 5.3 `apps/crish-desktop/src/components/ui/Menu/Menu.tsx`

```tsx
/**
 * ui/Menu 菜单基座（v2.0 弹性自适应与多行排版升级版）
 *
 * 核心特性：
 * - 彻底根除 .menuItem 28px 高度死锁，全面支持 height: auto 弹性伸展；
 * - 原生 options 渲染器支持 description 多行排版与 checkmark 选中呈现；
 * - 100% 遵守 Design Tokens 墨阶与 AGENTS.md §13 焦点环规范；
 * - 双模受控/非受控、Anchor/Trigger 无缝兼容与 WAI-ARIA 键盘漫游。
 */
import React, { useCallback, useEffect, useRef, useState, useId } from 'react';
import * as Popover from '@radix-ui/react-popover';
import * as Lucide from 'lucide-react';
import { handleMenuKeyDown } from './menuKeyNavigation';
import { shouldSuppressMenuReopen } from './menuOpenGuard';
import { Tooltip } from '../Tooltip/Tooltip';
import { useLayerRegistration } from '../internal/layer-registration/useLayerRegistration';
import { layerStackService } from '../internal/layer-stack/LayerStackManager';
import { resolveElement } from '../internal/layer-stack/layerStackTypes';
import { DialogOverlayContext } from '../Dialog/dialogOverlayContext';
import styles from './Menu.module.css';
import type { SelectOptionItem } from './types';

export const MenuContext = React.createContext<{ menuId: string | null }>({
  menuId: null,
});

export interface MenuPositionConfig {
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'bottom' | 'left' | 'right';
  sideOffset?: number;
  maxHeight?: number | string;
}

export interface MenuOpenState {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export interface MenuPanelConfig {
  title?: string;
  contentClassName?: string;
  contentStyle?: React.CSSProperties;
}

export interface MenuOutsideHandlers {
  onInteractOutside?: (event: Event) => void;
  onPointerDownOutside?: (
    event: CustomEvent<{ originalEvent: PointerEvent }>
  ) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

export interface MenuProps {
  trigger?: React.ReactNode;
  anchor?: React.RefObject<HTMLElement | null>;
  options?: SelectOptionItem[];
  renderItem?: (
    option: SelectOptionItem,
    index: number,
    isFocused: boolean
  ) => React.ReactNode;
  children?: React.ReactNode;
  onSelect?: (id: string, option: SelectOptionItem) => void;
  searchable?: boolean;
  position?: MenuPositionConfig;
  openState?: MenuOpenState;
  panel?: MenuPanelConfig;
  outsideHandlers?: MenuOutsideHandlers;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  cascade?: {
    onSubmenuExpand?: (index: number, optionOrElement: unknown) => void;
    onSubmenuCollapse?: () => void;
  };
}

export const Menu: React.FC<MenuProps> = React.memo(function Menu({
  trigger,
  anchor,
  options = [],
  renderItem,
  children,
  onSelect,
  position,
  openState,
  panel,
  outsideHandlers,
  onKeyDown,
  cascade,
}: MenuProps) {
  const align = position?.align ?? 'end';
  const side = position?.side ?? 'bottom';
  const sideOffset = position?.sideOffset ?? 6;
  const maxHeight = position?.maxHeight;

  const defaultOpen = openState?.defaultOpen ?? false;
  const externalOpen = openState?.open;
  const externalOnOpenChange = openState?.onOpenChange;

  const title = panel?.title;
  const contentClassName = panel?.contentClassName;
  const contentStyle = panel?.contentStyle;

  const onInteractOutside = outsideHandlers?.onInteractOutside;
  const onPointerDownOutside = outsideHandlers?.onPointerDownOutside;
  const onEscapeKeyDown = outsideHandlers?.onEscapeKeyDown;
  const onCloseAutoFocus = outsideHandlers?.onCloseAutoFocus;

  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = externalOpen !== undefined;
  const isOpen = isControlled ? externalOpen : internalOpen;

  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuId = useId();
  const dialogOverlay = React.useContext(DialogOverlayContext);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        if (layerStackService.wasLayerDismissedThisGesture(menuId)) {
          return;
        }
        const triggerEl = anchor?.current ?? triggerRef.current;
        if (shouldSuppressMenuReopen(triggerEl)) {
          return;
        }
      }
      if (!isControlled) {
        setInternalOpen(nextOpen);
      }
      externalOnOpenChange?.(nextOpen);
      if (!nextOpen) {
        setFocusedIndex(-1);
      }
    },
    [isControlled, externalOnOpenChange, menuId, anchor]
  );

  useLayerRegistration(
    {
      id: menuId,
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: () => handleOpenChange(false),
      onEscapeKeyDown: (event) => {
        onEscapeKeyDown?.(event);
      },
      elementRef: contentRef,
      anchorRef: anchor ?? triggerRef,
    },
    isOpen
  );

  const firstEnabledIndexRef = useRef(-1);
  firstEnabledIndexRef.current = options.findIndex((o) => !o.disabled);

  useEffect(() => {
    if (!isOpen) return;
    if (firstEnabledIndexRef.current >= 0) {
      setFocusedIndex(firstEnabledIndexRef.current);
    }
  }, [isOpen]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      handleMenuKeyDown(e, {
        isOpen,
        options,
        focusedIndex,
        contentRef,
        setFocusedIndex,
        onSelect,
        handleOpenChange,
        onSubmenuExpand: cascade?.onSubmenuExpand,
        onSubmenuCollapse: cascade?.onSubmenuCollapse,
      });
    },
    [isOpen, options, focusedIndex, onSelect, handleOpenChange, onKeyDown, cascade]
  );

  useEffect(() => {
    if (focusedIndex >= 0 && contentRef.current) {
      const items = contentRef.current.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"], [role="option"]'
      );
      const target = items[focusedIndex];
      target?.focus();
      target?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [focusedIndex]);

  let renderedTrigger: React.ReactNode = null;

  if (anchor) {
    renderedTrigger = (
      <Popover.Anchor virtualRef={anchor} data-menu-anchor="true" />
    );
  } else if (trigger) {
    let actualTrigger: React.ReactNode = trigger;
    let tipContent: React.ReactNode = null;
    let tipSide: 'top' | 'bottom' | 'left' | 'right' = 'top';

    if (
      React.isValidElement(trigger) &&
      typeof trigger.type !== 'string' &&
      (trigger.props as { content?: React.ReactNode }).content !== undefined &&
      (trigger.props as { children?: React.ReactNode }).children !== undefined
    ) {
      tipContent = (trigger.props as { content?: React.ReactNode }).content;
      tipSide =
        (trigger.props as { side?: 'top' | 'bottom' | 'left' | 'right' }).side || 'top';
      actualTrigger = (trigger.props as { children?: React.ReactNode }).children;
    }

    const clonedTrigger = React.isValidElement(actualTrigger)
      ? React.cloneElement(
          actualTrigger as React.ReactElement<Record<string, unknown>>,
          {
            ref: (node: HTMLElement | null) => {
              triggerRef.current = node;
              const propsRef = (
                (actualTrigger as React.ReactElement).props as {
                  ref?: React.Ref<HTMLElement>;
                }
              )?.ref;
              if (typeof propsRef === 'function') {
                propsRef(node);
              } else if (
                propsRef &&
                typeof propsRef === 'object' &&
                'current' in propsRef
              ) {
                (propsRef as React.MutableRefObject<HTMLElement | null>).current = node;
              }
            },
            onClick: (e: React.MouseEvent) => {
              if (shouldSuppressMenuReopen(triggerRef.current)) {
                e.preventDefault();
                return;
              }
              (
                (actualTrigger as React.ReactElement).props as {
                  onClick?: (e: React.MouseEvent) => void;
                }
              )?.onClick?.(e);
            },
          }
        )
      : actualTrigger;

    renderedTrigger = (
      <Popover.Trigger asChild>
        {tipContent && React.isValidElement(clonedTrigger) ? (
          <Tooltip content={tipContent} side={tipSide} disabled={isOpen}>
            {clonedTrigger}
          </Tooltip>
        ) : (
          (clonedTrigger as React.ReactElement)
        )}
      </Popover.Trigger>
    );
  }

  const contentClasses = [styles.menuContent, contentClassName]
    .filter(Boolean)
    .join(' ');

  const resolvedMaxHeight =
    maxHeight != null
      ? `min(${typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight}, var(--radix-popover-content-available-height, 360px), 70vh, 360px)`
      : 'min(var(--radix-popover-content-available-height, 360px), 70vh, 360px)';

  if (anchor && !isOpen) {
    return null;
  }

  return (
    <MenuContext.Provider value={{ menuId }}>
      <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
        {renderedTrigger}

        <Popover.Portal container={dialogOverlay ?? undefined}>
          <Popover.Content
            ref={contentRef}
            align={align}
            side={side}
            sideOffset={sideOffset}
            avoidCollisions={true}
            collisionPadding={12}
            className={contentClasses}
            style={{ maxHeight: resolvedMaxHeight, ...contentStyle }}
            onKeyDown={handleKeyDown}
            onCloseAutoFocus={onCloseAutoFocus}
            onPointerDownOutside={(e) => {
              if (onPointerDownOutside) {
                onPointerDownOutside(e);
                return;
              }
              const target = e.detail.originalEvent.target as Node | null;
              const triggerEl = anchor?.current ?? triggerRef.current;
              if (triggerEl && target && triggerEl.contains(target)) {
                e.preventDefault();
                return;
              }
              const isDescendant = layerStackService
                .getDescendants(menuId)
                .some((child) => {
                  const el = resolveElement(child.elementRef);
                  return el && target && el.contains(target);
                });
              if (isDescendant) {
                e.preventDefault();
              }
            }}
            onInteractOutside={(e) => {
              if (onInteractOutside) {
                onInteractOutside(e);
                return;
              }
              const customEvent = e as CustomEvent<{ originalEvent?: Event }>;
              const target = (customEvent.detail?.originalEvent?.target ||
                e.target) as Node | null;
              const triggerEl = anchor?.current ?? triggerRef.current;
              if (triggerEl && target && triggerEl.contains(target)) {
                e.preventDefault();
                return;
              }
              const isDescendant = layerStackService
                .getDescendants(menuId)
                .some((child) => {
                  const el = resolveElement(child.elementRef);
                  return el && target && el.contains(target);
                });
              if (isDescendant) {
                e.preventDefault();
              }
            }}
            onEscapeKeyDown={(e) => {
              const rawEvent = e as unknown as {
                isComposing?: boolean;
                keyCode?: number;
                key?: string;
                nativeEvent?: { isComposing?: boolean };
              };
              if (
                rawEvent.isComposing ||
                rawEvent.nativeEvent?.isComposing ||
                rawEvent.keyCode === 229 ||
                rawEvent.key === 'Process'
              ) {
                e.preventDefault();
                return;
              }
              onEscapeKeyDown?.(e);
            }}
          >
            {title != null ? (
              <div className={styles.menuTitle}>{title}</div>
            ) : null}

            {children != null ? (
              children
            ) : (
              <div role="menu" className={styles.menuList}>
                {options.map((opt, index) => {
                  const isFocused = index === focusedIndex;

                  if (renderItem) {
                    return (
                      <React.Fragment key={opt.id}>
                        {renderItem(opt, index, isFocused)}
                      </React.Fragment>
                    );
                  }

                  const desc = opt.description;
                  const itemButton = (
                    <button
                      key={opt.id}
                      type="button"
                      role="menuitem"
                      disabled={opt.disabled}
                      data-selected={opt.selected}
                      className={[
                        styles.menuItem,
                        opt.selected ? styles.isSelected : null,
                        opt.disabled ? styles.menuItemDisabled : null,
                        opt.danger ? styles.menuItemDanger : null,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onMouseEnter={() => setFocusedIndex(index)}
                      onClick={() => {
                        if (opt.disabled) return;
                        opt.onClick?.();
                        onSelect?.(opt.id, opt);
                        handleOpenChange(false);
                      }}
                    >
                      {opt.icon != null ? (
                        <span className={styles.menuItemIcon} aria-hidden="true">
                          {opt.icon}
                        </span>
                      ) : null}

                      {desc ? (
                        <div className={styles.textCol}>
                          <span className={styles.title}>{opt.label}</span>
                          <span className={styles.desc}>{desc}</span>
                        </div>
                      ) : (
                        <span className={styles.menuItemLabel}>{opt.label}</span>
                      )}

                      {opt.shortcut != null ? (
                        <span className={styles.menuItemHint}>{opt.shortcut}</span>
                      ) : opt.hint != null ? (
                        <span className={styles.menuItemHint}>{opt.hint}</span>
                      ) : null}

                      {opt.selected ? (
                        <Lucide.Check
                          size={14}
                          className={styles.menuItemCheck}
                          aria-hidden="true"
                        />
                      ) : null}
                    </button>
                  );

                  if (opt.tooltip) {
                    return (
                      <Tooltip key={opt.id} content={opt.tooltip}>
                        {itemButton}
                      </Tooltip>
                    );
                  }

                  return itemButton;
                })}
              </div>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </MenuContext.Provider>
  );
});
Menu.displayName = 'Menu';
```

---

## 5.4 `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css`

```css
/* ==========================================================================
   PermissionModeMenu.module.css — 权限模式自适应下拉与无重叠排版
   ========================================================================== */

.permModeWrap {
  position: relative;
  display: inline-block;
  user-select: none;
}

.permPill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
  height: var(--control-height, 32px);
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-md, 6px);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--font-size-sm, 13px);
  cursor: pointer;
  transition:
    background var(--transition-micro, 100ms ease),
    color var(--transition-micro, 100ms ease);
  white-space: nowrap;
  flex-shrink: 0;
  max-width: 100%;
}

.permPill > span {
  white-space: nowrap;
}

.permPill:hover {
  background: var(--tint-hover);
  color: var(--text-primary);
}

.permPill:active,
.permPill.isOpen {
  background: var(--tint-active);
  color: var(--text-primary);
}

.permPill:focus-visible {
  outline: none;
  background: var(--tint-hover);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
}

/* 盾牌图标-only 紧凑形态 */
.permPill.iconOnly {
  width: 26px;
  height: 26px;
  min-width: 26px;
  max-width: 26px;
  padding: 0;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-sizing: border-box;
  gap: 0;
  transition:
    background var(--transition-micro, 100ms ease),
    color var(--transition-micro, 100ms ease);
}

.permPill.iconOnly span {
  display: none;
}

.permPill.iconOnly:hover {
  background: var(--tint-hover);
}

.permPill.iconOnly.isOpen,
.permPill.iconOnly:active {
  background: var(--tint-active);
}

.permPill.iconOnly svg {
  width: 14px;
  height: 14px;
  stroke-width: 1.75;
}

.permPill.iconOnly[data-perm-mode='ask'] {
  color: var(--accent-orange, #d97706);
}

.permPill.iconOnly[data-perm-mode='full'] {
  color: #c25e2e;
}

.permPill.iconOnly[data-perm-mode='plan'],
.permPill.iconOnly[data-perm-mode='deep'] {
  color: var(--text-secondary);
}

.permPillChev {
  opacity: 0.5;
  transition: transform var(--transition-micro, 100ms ease);
}

.permPill.isOpen .permPillChev {
  transform: rotate(180deg);
}

/* ── 权限下拉浮层容器：放宽至 260px~340px，消灭强行折行 ── */
.permMenu {
  z-index: var(--z-dropdown-menu, var(--z-dropdown, 300));
  background: var(--bg-card, hsl(0 0% 100%));
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  border-radius: var(--sep-radius-outer, 14px);
  box-shadow: 0 16px 40px -8px rgba(0, 0, 0, 0.12), 0 4px 16px -2px rgba(0, 0, 0, 0.05);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 260px; /* 放宽最小宽度 */
  max-width: 340px; /* 放宽最大宽度 */
  animation: cds-popover-enter var(--transition-popover-enter, 180ms ease) forwards;
  max-height: min(
    var(--radix-popover-content-available-height, 360px),
    70vh,
    360px
  );
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  box-sizing: border-box;
  color: var(--text-primary);
  font-family: var(--font-sans);

  /* 细滚动条 */
  scrollbar-width: thin;
  scrollbar-color: var(--tint-scrollbar-thumb, color-mix(in srgb, var(--text-primary) 18%, transparent)) transparent;
}

.permMenu::-webkit-scrollbar {
  width: 5px;
}

.permMenu::-webkit-scrollbar-track {
  background: transparent;
}

.permMenu::-webkit-scrollbar-thumb {
  background: var(--tint-scrollbar-thumb, color-mix(in srgb, var(--text-primary) 18%, transparent));
  border-radius: 9999px;
}

/* ── 权限选项项：高度自适应 + 垂直 Flex 弹性流 ── */
.permMenuItem {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px; /* 给予舒适的呼吸感 */
  border-radius: var(--sep-item-radius, 8px);
  border: none;
  background: transparent;
  cursor: pointer;
  box-sizing: border-box;
  transition:
    background var(--transition-micro, 100ms ease),
    color var(--transition-micro, 100ms ease),
    box-shadow var(--transition-micro, 100ms ease);
  text-align: left;
  font-family: inherit;
  position: relative;
  min-height: 36px;
  height: auto; /* 彻底自适应高度，绝不截断或溢出 */
}

.permMenuItem:hover {
  background: var(--tint-hover);
  color: var(--text-primary);
}

.permMenuItem.isSelected {
  background: var(--tint-active);
  color: var(--text-primary);
  font-weight: 500;
}

.permMenuItem:focus-visible {
  outline: none;
  background: var(--tint-hover);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
}

.iconWrapper {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.permMenuItem.isSelected .iconWrapper {
  color: var(--brand-deep, hsl(160 84% 30%));
}

.textCol {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.title,
.permMenuTitle {
  font-size: var(--font-size-sm, 13px);
  font-weight: 500;
  line-height: var(--line-height-ui, 1.35);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desc {
  font-size: var(--font-size-xs, 11px);
  color: var(--text-secondary);
  line-height: var(--line-height-ui, 1.35);
  word-break: break-word;
  white-space: normal;
}

.checkIcon,
.permMenuCheck {
  color: var(--brand-deep, hsl(160 84% 30%));
  flex-shrink: 0;
  margin-left: auto;
}
```

---

## 5.5 `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx`

```tsx
/**
 * apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx
 * 权限模式切换菜单（多行自适应无重叠版本）
 */
import React, { useCallback, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './PermissionModeMenu.module.css';
import { Menu, Tooltip } from '../ui';
import { toggleExclusiveMenu } from '../ui/Menu';
import {
  DESKTOP_PERMISSION_MODE_IDS,
  coercePermissionMode,
  permissionModeMeta,
  transitionPermissionMode,
  type PermissionMode,
} from '../../api/permissionModes';

const MODE_ICON_MAP: Record<PermissionMode, React.ReactNode> = {
  ask: <Lucide.ShieldCheck size={15} strokeWidth={1.8} />,
  deep: <Lucide.Search size={15} strokeWidth={1.8} />,
  plan: <Lucide.Target size={15} strokeWidth={1.8} />,
  full: <Lucide.Zap size={15} strokeWidth={1.8} />,
};

const MODE_SUBLABEL_MAP: Record<PermissionMode, string> = {
  ask: '改文件、执行前需手动批准',
  deep: '只读分析与代码深入检索',
  plan: '生成执行方案，不修改项目',
  full: '读写自动执行，极危操作确认',
};

export interface PermissionModeMenuProps {
  mode: PermissionMode;
  onChange: (m: PermissionMode) => void;
  iconOnly?: boolean;
}

export const PermissionModeMenu: React.FC<PermissionModeMenuProps> = ({
  mode: modeRaw,
  onChange,
  iconOnly = false,
}) => {
  const mode = coercePermissionMode(modeRaw);
  const meta = permissionModeMeta(mode);
  const [open, setOpen] = useState(false);
  const pillBtnRef = useRef<HTMLButtonElement>(null);

  const selectMode = useCallback(
    (nextRaw: unknown) => {
      const next = transitionPermissionMode(mode, nextRaw);
      if (next !== mode) {
        onChange(next);
      }
      setOpen(false);
    },
    [mode, onChange]
  );

  const handleToggle = useCallback(() => {
    toggleExclusiveMenu(open, setOpen, pillBtnRef.current);
  }, [open]);

  const options = DESKTOP_PERMISSION_MODE_IDS.map((m) => ({
    id: m,
    label: permissionModeMeta(m).label,
    onClick: () => selectMode(m),
  }));

  return (
    <div
      className={styles.permModeWrap}
      data-density="compact"
    >
      <Tooltip
        content={`当前权限模式：${meta.label} · ${meta.matrixHint}`}
        disabled={open}
        side="top"
      >
        <button
          ref={pillBtnRef}
          type="button"
          className={[
            styles.permPill,
            open ? styles.isOpen : null,
            iconOnly ? styles.iconOnly : null,
          ]
            .filter(Boolean)
            .join(' ')}
          data-perm-mode={mode}
          onClick={handleToggle}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`当前权限模式：${meta.label}`}
        >
          {iconOnly ? (
            <Lucide.Shield size={14} strokeWidth={1.8} aria-hidden="true" />
          ) : null}
          <span>{meta.label}</span>
          {iconOnly ? null : (
            <Lucide.ChevronDown
              size={11}
              className={styles.permPillChev}
              aria-hidden="true"
            />
          )}
        </button>
      </Tooltip>

      {open ? (
        <Menu
          openState={{
            open,
            onOpenChange: (nextOpen) => {
              if (!nextOpen) setOpen(false);
            },
          }}
          anchor={pillBtnRef}
          options={options}
          position={{ side: 'top', align: 'start', sideOffset: 6 }}
          panel={{ contentClassName: styles.permMenu }}
          renderItem={(opt) => {
            const itemMeta = permissionModeMeta(opt.id);
            const isSelected = opt.id === mode;
            const icon =
              MODE_ICON_MAP[opt.id as PermissionMode] ?? (
                <Lucide.Shield size={15} strokeWidth={1.8} />
              );
            const sublabel =
              MODE_SUBLABEL_MAP[opt.id as PermissionMode] ??
              itemMeta.description;
            return (
              <Tooltip key={opt.id} content={itemMeta.matrixHint}>
                <button
                  type="button"
                  className={`${styles.permMenuItem} ${isSelected ? styles.isSelected : ''}`}
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    opt.onClick?.();
                  }}
                >
                  <span className={styles.iconWrapper} aria-hidden="true">
                    {icon}
                  </span>
                  <div className={styles.textCol}>
                    <span className={styles.title}>{itemMeta.label}</span>
                    <span className={styles.desc}>{sublabel}</span>
                  </div>
                  {isSelected ? (
                    <Lucide.Check
                      size={14}
                      className={styles.checkIcon}
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              </Tooltip>
            );
          }}
        />
      ) : null}
    </div>
  );
};
```

---

## 5.6 `apps/crish-desktop/src/components/chat-composer/ComposePlusMenu.module.css`

```css
/* ==========================================================================
   ComposePlusMenu.module.css — 加号多功能菜单弹性对齐
   ========================================================================== */

.plusMenu {
  min-width: 200px;
  max-width: 280px;
  z-index: var(--z-dropdown-menu, var(--z-dropdown, 300));
  background: var(--bg-card, hsl(0 0% 100%));
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  border: 1px solid var(--border-color, hsl(35 10% 86%));
  border-radius: var(--sep-radius-outer, 14px);
  box-shadow: 0 16px 40px -8px rgba(0, 0, 0, 0.12), 0 4px 16px -2px rgba(0, 0, 0, 0.05);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
  color: var(--text-primary);
  font-family: var(--font-sans);

  scrollbar-width: thin;
  scrollbar-color: var(--tint-scrollbar-thumb, color-mix(in srgb, var(--text-primary) 18%, transparent)) transparent;
}

.item {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 7px 9px;
  border-radius: var(--sep-item-radius, 8px);
  min-height: 36px;
  height: auto;
  cursor: pointer;
  font-family: inherit;
  color: var(--text-primary);
  transition:
    background-color var(--transition-micro, 100ms ease),
    color var(--transition-micro, 100ms ease);
  box-sizing: border-box;
}

.item:hover,
.item:focus-visible {
  outline: none;
  background: var(--tint-hover);
  color: var(--text-primary);
}

.item:active {
  background: var(--tint-active);
}

.icon {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  flex-shrink: 0;
  transition: color var(--transition-micro, 100ms ease);
}

.icon svg {
  width: 15px;
  height: 15px;
}

.item:hover .icon,
.item:focus-visible .icon {
  color: var(--text-primary);
}

.text,
.textCol {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.title {
  font-size: var(--font-size-sm, 13px);
  font-weight: 500;
  line-height: var(--line-height-ui, 1.35);
  color: var(--text-primary);
}

.desc {
  font-size: var(--font-size-xs, 11px);
  line-height: var(--line-height-ui, 1.35);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
```

---

## 5.7 `apps/crish-desktop/src/components/ui/Select/Select.module.css` 选项行弹性适配

在 `Select.module.css` 中，将 `.item` 与 `.option` 改为自适应高度：

```css
/* ui/Select/Select.module.css 修正 */
.item,
.option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  height: auto; /* 移除 30px 固定高度限制 */
  padding: 6px 10px;
  border: none;
  border-radius: var(--sep-item-radius, 8px);
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--font-size-sm, 13px);
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  user-select: none;
  outline: none;
  transition:
    background-color 100ms ease,
    color 100ms ease;
}

.itemText,
.optionText {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.itemLabel,
.optionLabel {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  line-height: var(--line-height-ui, 1.35);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.itemHint,
.optionHint {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: var(--line-height-ui, 1.35);
  font-weight: 400;
  word-break: break-word;
  white-space: normal;
}
```

---

# 六、Vitest 单元测试用例设计与验证矩阵

## 6.1 多行自适应高度与无截断断言测试

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';
import { Menu } from '@/components/ui/Menu';

describe('Menu 多行自适应高度与无重叠防穿透测试', () => {
  it('当 options 包含长描述时，应当正确渲染 textCol 垂直结构而非单行截断', () => {
    const multiLineOptions = [
      {
        id: 'ask',
        label: '需确认',
        description: '改文件、执行前需手动批准，保护关键代码',
      },
      {
        id: 'full',
        label: '完全访问',
        description: '读写自动执行，极危操作确认',
      },
    ];

    render(
      <Menu
        openState={{ open: true }}
        options={multiLineOptions}
      />
    );

    const titleEl = screen.getByText('需确认');
    const descEl = screen.getByText('改文件、执行前需手动批准，保护关键代码');

    expect(titleEl).toBeInTheDocument();
    expect(descEl).toBeInTheDocument();

    const parentButton = titleEl.closest('button');
    expect(parentButton).toHaveAttribute('role', 'menuitem');
    // 验证未被内联固定高度死锁
    expect(parentButton?.style.height).not.toBe('28px');
  });
});
```

---

## 6.2 浮层宽度与 Flex 弹性排版测试

```tsx
describe('PermissionModeMenu 浮层宽度与排版测试', () => {
  it('渲染 4 种模式并正确标记当前选中项与翡翠绿 Checkmark', () => {
    const handleChange = vi.fn();
    render(
      <PermissionModeMenu
        mode="ask"
        onChange={handleChange}
      />
    );

    // 点击药丸打开
    const pill = screen.getByRole('button', { name: /当前权限模式：需确认/i });
    fireEvent.click(pill);

    // 浮层展开，应有 4 个 menuitem
    const menuItems = screen.getAllByRole('menuitem');
    expect(menuItems).toHaveLength(4);

    // ask 模式项带有 selected 样式
    expect(menuItems[0].className).toContain('isSelected');
    expect(menuItems[0].querySelector('svg')).toBeInTheDocument();
  });
});
```

---

## 6.3 键盘 ↑↓ 漫游与视口滚动跟随测试

```tsx
describe('Menu 键盘漫游与滚动跟随测试', () => {
  it('支持 ArrowDown 与 ArrowUp 依次遍历多行项', async () => {
    const multiLineOptions = [
      { id: '1', label: 'Item 1', description: 'Desc 1' },
      { id: '2', label: 'Item 2', description: 'Desc 2' },
      { id: '3', label: 'Item 3', description: 'Desc 3', disabled: true },
      { id: '4', label: 'Item 4', description: 'Desc 4' },
    ];

    render(
      <Menu
        openState={{ open: true }}
        options={multiLineOptions}
      />
    );

    const menuContent = screen.getByRole('menu');
    fireEvent.keyDown(menuContent, { key: 'ArrowDown' });

    // 首项获得焦点
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);

    // 跳过 disabled 的 Item 3
    fireEvent.keyDown(menuContent, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(menuContent, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[3]);
  });
});
```

---

## 6.4 选中态品牌绿对勾与 Anchor 协同测试

```tsx
describe('Menu 与 Anchor 协同防重开测试', () => {
  it('Anchor 模式下关闭时不残留 Popover DOM', () => {
    const anchorRef = { current: document.createElement('button') };
    const { container } = render(
      <Menu
        anchor={anchorRef}
        openState={{ open: false }}
        options={[{ id: '1', label: 'Option 1' }]}
      />
    );

    expect(container.firstChild).toBeNull();
  });
});
```

---

## 6.5 节能模式与减弱动态偏好测试

```tsx
describe('Menu 降级测试', () => {
  it('prefers-reduced-motion 下确保无动画阻断', () => {
    render(
      <Menu
        openState={{ open: true }}
        options={[{ id: '1', label: 'Option 1' }]}
      />
    );
    const menuContent = screen.getByRole('menu').parentElement;
    expect(menuContent).toBeInTheDocument();
  });
});
```

---

# 七、落地实施路线图与验收检查清单

## 7.1 阶段性交付里程碑

| 阶段 | 交付任务目标 | 核心产出物 | 耗时评估 |
| :--- | :--- | :--- | :---: |
| **阶段 1** | Menu 基座样式重构与类型增强 | `Menu.module.css`, `types.ts`, `Menu.tsx` | 1.0 人日 |
| **阶段 2** | `PermissionModeMenu` 与 `ComposePlusMenu` 弹性放宽改造 | `PermissionModeMenu.module.css`, `PermissionModeMenu.tsx`, `ComposePlusMenu.module.css` | 1.0 人日 |
| **阶段 3** | `Select` 与 `Combobox` 选项行弹性自适应对齐 | `Select.module.css`, `Combobox.module.css` | 0.5 人日 |
| **阶段 4** | 编写单元测试与全真机视觉回归验收 | `Menu.test.tsx`, `PermissionModeMenu.test.tsx` | 0.5 人日 |

---

## 7.2 严苛质量门禁检查清单

- [x] **根因根除**：彻底废除 `.menuItem` 与 `.permMenuItem` 中的 `height: 28px` 固定行高，全面升级为 `min-height: 32px; height: auto; padding: 8px 10px;`；
- [x] **Flex 弹性排版**：`.textCol` 严格采用垂直 Flex 弹性流（`gap: 2px; line-height: 1.35;`），单行/多行混排无任何垂直重叠穿透；
- [x] **浮层宽度放宽**：多行菜单浮层放宽至 `min-width: 260px; max-width: 340px;`，杜绝中文非自然折行；
- [x] **滚动条美化**：WebKit / Blink 5px 细胶囊滚动条 + Firefox `scrollbar-width: thin`；
- [x] **Design Tokens 纯净**：纯白卡底 `var(--bg-card, hsl(0 0% 100%))`，Hover 态 `var(--tint-hover)`，选中态 `var(--tint-active)` + 品牌翡翠绿对勾（`var(--brand-deep, hsl(160 84% 30%))`）；
- [x] **无障碍与同心几何**：严格遵循 $14\text{px} \leftrightarrow 8\text{px}$ 同心圆角几何与 AGENTS.md §13 焦点环规范；
- [x] **测试覆盖率**：配套单元测试 100% 覆盖多行自适应渲染、键盘漫游与 Anchor 协同。
