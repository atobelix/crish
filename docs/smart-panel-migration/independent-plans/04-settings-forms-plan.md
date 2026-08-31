# Conex / Crish — 设置系统与全表单选择器重构落地方案

> **文档标识**：`docs/smart-panel-migration/independent-plans/04-settings-forms-plan.md`  
> **战役工作区**：`docs/smart-panel-migration/`  
> **专业角色**：设置系统与表单选择器重构专家（Settings & Forms Specialist）  
> **参考资产库**：`reference/smart-expandable-panel/`（CSS Tokens / Panel / Search / Items / Submenu / Safe-Aim / Position / React Wrapper）  
> **遵循基准**：`AGENTS.md`（反退避铁律、架构优雅、零补丁绕过）、`ANTI_OVERENGINEERING_GUARDRAILS.md`（反过度设计红线）  
> **治理目标**：彻底消灭设置系统全部 5 大核心面板与表单选择器中的视觉断层、青绿杂色底污染、膨胀药丸、文字挤压截断、原生箭头粗滚动条以及排版重叠碰撞致命 Bug，建立全仓统一的高质感表单规范。

---

## 目录索引

1. [执行摘要与现状根因解剖](#1-执行摘要与现状根因解剖)
2. [全表单设计 Token 与同心几何规范标准](#2-全表单设计-token-与同心几何规范标准)
3. [外观与通用设置页深度重构（SettingsAppearanceTab & SettingsSchemaRenderer）](#3-外观与通用设置页深度重构)
4. [字体选择器 7 处违规彻底根除（FontSelectField & FontSettingsSection）](#4-字体选择器-7-处违规彻底根除)
5. [模型设置页 7 处违规彻底根除（ModelsSettingsTab & ModelProfileList）](#5-模型设置页-7-处违规彻底根除)
6. [规则设置页 5 处违规彻底根除（SettingsRulesTab）](#6-规则设置页-5-处违规彻底根除)
7. [安全设置页 4 处治理与状态诊断页 4 处治理（SettingsSecurityTab & StatusDiagnosticsPanel）](#7-安全设置页与状态诊断页治理)
8. [工程落地实施步骤与文件变动清单](#8-工程落地实施步骤与文件变动清单)
9. [全量验收断言与质量门禁保障](#9-全量验收断言与质量门禁保障)

---

## 1. 执行摘要与现状根因解剖

### 1.1 现状断层诊断
Crish 桌面端设置系统（Settings System）是用户配置个性化与核心功能的中枢。然而根据实机截图标注与源码排查，设置页与各子表单中散落着多处破坏产品质感的严重问题：

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                           设置系统当前 5 大严重断层分布                           │
├───────────────────────────────────────────────────────────────────────────────────┤
│ 1. [外观与通用设置] 14px 膨胀胶囊、青底污染、文本在窄容器下截断挤压              │
│ 2. [字体选择器]     底部青绿杂色底、自定义字体输入框背景不匹配、操作按钮不规范    │
│ 3. [模型设置页]     +添加服务商实心青绿胶囊、默认模型粗描边、Windows 原生粗滚动条 │
│ 4. [规则设置页]     右上角双按钮断层换行、常用胶囊黑边死斑、自定义输入裸写 HTML   │
│ 5. [安全与状态诊断] 权限模式粗描边、NOTE_RUNTIME 与时间戳重叠碰撞、状态裸字无徽标 │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 核心根因分析
1. **Token 滥用与色彩污染（`--sidebar-hover` / `--bg-secondary` 错位消费）**：
   在「冰川薄荷」、「抹茶拿铁」等彩色皮肤下，`--sidebar-hover` 和 `--bg-secondary` 含有高浓度青绿色。侧边栏在深底色下尚可，但**设置卡片与浮层菜单为纯净白底（`#ffffff` / `var(--bg-card)`）**，直接消费这些变量导致大面积深青绿“泥斑”污染。
2. **圆角层级膨胀失范（Pill Radius 滥用）**：
   大量触发器与操作按钮盲目使用 `var(--radius-xl)`（12px/14px）甚至 `radius-full`（9999px 胶囊），破坏了卡片内部规整的线性对齐，与旁边的复选框、输入框形成严重的视觉冲突。
3. **滚动容器与高度约束写死（Windows 原生箭头滚动条）**：
   未做自适应自然高度计算，直接声明 `overflow-y: scroll` 或固定高度，在 1 项条目时强制出现带上下三角箭头（`▲`/`▼`）的粗滚动条，并留下大片死白空间。
4. **CSS 布局脆弱（缺少 Grid 栅格隔离）**：
   状态诊断页的日志与时间戳条目直接使用简单 `flex` 且未锁死 min-width，在短文本与长日期碰撞时直接发生重叠覆盖（`NOTE_RUNTIME` 与 `2026/8/20` 叠影）。

---

## 2. 全表单设计 Token 与同心几何规范标准

对照 `reference/smart-expandable-panel/css/tokens.css`，全表单与设置组件统一收敛至以下精准 Token 契约：

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                      Mathematical Curvature & Token Contract                      │
├───────────────────────────────────────────────────────────────────────────────────┤
│ [ L1 外层面板壳体 ]   R_outer = 14px  │ Inset Padding = 6px                       │
│ [ L2 内部条目/容器 ]  R_inner = 8px   │ calc(14px - 6px) = 8px (100% 同心对齐)    │
│ [ L3 触发器/操作钮 ]  R_btn   = 6px   │ 高度 28px/32px，1px 发丝边框              │
│ [ L4 状态徽章/胶囊 ]  R_badge = 4px   │ 高度 16px/18px，字号 11px                 │
├───────────────────────────────────────────────────────────────────────────────────┤
│ [ 浅色调优色板 ]      底色: #ffffff / var(--bg-card)                              │
│                      发丝边框: #e2dfd9 (1px solid)                               │
│                      Hover 悬停: rgba(29, 28, 26, 0.045) (4.5% 轻柔暖灰，零青底)  │
│                      Selected 选中: rgba(29, 28, 26, 0.065) (6.5% 微灰)           │
│                      选中高亮对勾: #059669 (翡翠绿品牌对勾)                       │
├───────────────────────────────────────────────────────────────────────────────────┤
│ [ 深色调优色板 ]      底色: #181715 / var(--bg-card)                              │
│                      发丝边框: #2b2926 (1px solid)                               │
│                      Hover 悬停: rgba(245, 244, 240, 0.06) (6.0% 柔和冷白)        │
│                      Selected 选中: rgba(245, 244, 240, 0.09) (9.0% 微白)         │
│                      选中高亮对勾: #10b981 (翡翠绿高亮对勾)                       │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 外观与通用设置页深度重构

### 3.1 治理目标与规范收敛
涉及组件：`SettingsAppearanceTab.tsx`、`SettingsPersonalizeTab.tsx`、`SettingsSchemaRenderer.tsx`、`SettingsUI.module.css`。

1. **统一尺寸与圆角**：
   - 触发器：标准高度 `32px`（默认） / `28px`（`size="sm"`），圆角统一锁定为 **`6px`（`var(--radius-md)`）**；
   - 选项浮层面板：外层圆角 **`14px`**，内衬 **`6px`**，条目圆角 **`8px`**；
   - 彻底废除 `var(--radius-xl)`（14px 膨胀药丸）与 `var(--tint-hover)` 青绿底。
2. **消灭文字截断与弹性宽度规整**：
   - `SettingsSchemaRenderer` 中 `type: 'select'` 统一配置 `min-width: 160px; max-width: 280px; width: auto;`；
   - 「窗口风格」（经典 / 工作台）、「代码缩进」（2 空格 / 4 空格 / Tab）、「皮肤预设」（默认 / 极简暖灰 / 碳素黑等）、「回答风格」（简洁 / 标准 / 详细 / 深入）均使用统一规范。
3. **统一 Hover / Active 与勾选视觉**：
   - 悬停严格使用 `rgba(29, 28, 26, 0.045)`（浅色）/ `rgba(245, 244, 240, 0.06)`（深色）；
   - 选中态右侧对齐 `#059669`（浅色）/ `#10b981`（深色）翡翠绿发丝对勾。

### 3.2 `SettingsUI.module.css` 核心改造

```css
/* apps/crish-desktop/src/components/settings/SettingsUI.module.css */

/* 规整表单控制组中的 Select 控件 */
.controlSelect {
  min-width: 160px;
  max-width: 280px;
  width: auto;
}

/* 统一输入框与下拉选择框的触发器样式契约 */
.controlInput {
  min-width: 160px;
  max-width: 280px;
}

/* 统一 SegmentedControl 规整微圆角 */
.controlSegment.controlSegment {
  --seg-outer-radius: var(--radius-md, 6px);
  --seg-inner-radius: 4px;
}

/* 纯净发丝边框与纯白底色（零青底） */
:global(.ui-select-trigger) {
  height: var(--control-height-sm, 28px);
  min-height: var(--control-height-sm, 28px);
  border-radius: var(--radius-md, 6px);
  border: 1px solid var(--border-color, #e2dfd9);
  background: var(--bg-card, #ffffff);
  color: var(--text-primary);
  padding: 0 10px;
  font-size: var(--font-size-sm, 13px);
  box-shadow: none;
  transition: border-color 0.12s ease, background-color 0.12s ease;
}

:global(.ui-select-trigger:hover) {
  background: rgba(29, 28, 26, 0.045);
  border-color: var(--border-color, #e2dfd9);
}

:global(html[data-theme='dark']) :global(.ui-select-trigger) {
  border-color: var(--border-color, #2b2926);
  background: var(--bg-card, #181715);
}

:global(html[data-theme='dark']) :global(.ui-select-trigger:hover) {
  background: rgba(245, 244, 240, 0.06);
}
```

---

## 4. 字体选择器 7 处违规彻底根除

### 4.1 7 处违规对照与根治方案
涉及组件：`FontSelectField.tsx`、`FontSelectField.module.css`、`FontSettingsSection.tsx`、`FontSettingsSection.module.css`。

| 违规项 | 现状断层表现 | 根治方案与精确参数 |
| :--- | :--- | :--- |
| **违规 1** | 底部青绿杂色底（`--bg-secondary` / `--tint-hover` / `--bg-subtle` 污染） | 彻底移除杂色底，统一为 `var(--sep-bg-panel)`（`rgba(255, 254, 252, 0.96)`）纯净毛玻璃底色。 |
| **违规 2** | `自定义字体` 输入框与整行背景色不匹配、宽度硬编码致文字截断 | 重构为 Flex 自适应（`flex: 1 1 auto; min-width: 0;`），背景设为 `transparent` 与整行融合，文字与占位符完整显示。 |
| **违规 3** | 底部「扫描本机字体」`[ 🖫 ]` 与「恢复默认」`[ ↺ ]` 按钮不规范 | 统一封装为标准的 **22×22px 微圆角按钮（`var(--sep-btn-radius): 6px`）**，提供轻柔 Hover 边界与标准 Tooltip。 |
| **违规 4** | 搜索与自定义栏位置倒置在底部，缺少顶置一体化 | 将搜索/自定义栏架构**顶置为一体化 Header（`.sep-search-wrapper`）**，支持打字即时过滤上方与下方字体列表。 |
| **违规 5** | 触发器（Trigger）使用 14px 膨胀椭圆药丸与青绿底 | 统一为 **28px 高度、6px 微圆角、`var(--bg-card)` 纯白底与 1px 发丝边框**，与旁边的 `☐ 连字` 复选框高度精准对齐。 |
| **违规 6** | 面板外层使用 16px 膨胀大圆角与非对称内衬（`padding: 4px 1px 4px 4px`） | 收敛为严格的数学同心几何：**14px 外角 / 6px 内边距 / 8px 内层条目**，左右内衬对称。 |
| **违规 7** | 选中项使用大面积深青灰色块与黑色勾选 | 选中项底色为 **6.5% 极浅微灰（`rgba(29, 28, 26, 0.065)`）**，右侧靠齐 **`#059669` 翡翠绿品牌对勾**。 |

### 4.2 重构后 `FontSelectField.module.css` 核心代码

```css
/* apps/crish-desktop/src/components/settings/FontSelectField.module.css */

.settingsSelect {
  position: relative;
  min-width: 140px;
  max-width: 280px;
}

.settingsSelectTriggerRow {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
}

/* 违规 5 治理：28px 高度、6px 微圆角、纯白底、1px 发丝边框 */
.settingsSelectTrigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 1;
  min-width: 0;
  height: 28px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border-color, #e2dfd9);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-card, #ffffff);
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--font-size-sm, 13px);
  cursor: pointer;
  outline: none;
  box-shadow: none;
  box-sizing: border-box;
  transition: border-color 0.12s ease, background-color 0.12s ease;
}

.settingsSelectTrigger:hover:not(:disabled) {
  background: rgba(29, 28, 26, 0.045);
  border-color: var(--border-color, #e2dfd9);
}

:global(html[data-theme='dark']) .settingsSelectTrigger {
  border-color: var(--border-color, #2b2926);
  background: var(--bg-card, #181715);
}

:global(html[data-theme='dark']) .settingsSelectTrigger:hover:not(:disabled) {
  background: rgba(245, 244, 240, 0.06);
}

.settingsSelectValue {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settingsSelectChev {
  flex-shrink: 0;
  color: var(--text-tertiary);
  opacity: 0.7;
}

/* 违规 1 & 6 治理：14px 外角、6px 对称 padding、磨砂玻璃光影 */
.settingsSelectMenu {
  background: var(--sep-bg-panel, rgba(255, 254, 252, 0.96));
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  border: 1px solid var(--border-color, #e2dfd9);
  border-radius: 14px;
  box-shadow: 0 20px 48px -10px rgba(29, 28, 26, 0.09),
              0 6px 20px -3px rgba(29, 28, 26, 0.03);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
  box-sizing: border-box;
  z-index: var(--z-dropdown-menu, 2000);
}

:global(html[data-theme='dark']) .settingsSelectMenu {
  background: var(--sep-bg-panel, rgba(24, 23, 21, 0.96));
  border-color: var(--border-color, #2b2926);
  box-shadow: 0 24px 54px -10px rgba(0, 0, 0, 0.70);
}

/* 违规 4 治理：顶置一体化搜索栏 */
.sepSearchWrapper {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  min-height: 28px;
  padding: 0 4px 0 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid rgba(29, 28, 26, 0.06);
  background: transparent;
  flex-shrink: 0;
  box-sizing: border-box;
}

:global(html[data-theme='dark']) .sepSearchWrapper {
  border-bottom-color: rgba(255, 255, 255, 0.07);
}

/* 违规 2 治理：Flex 自适应输入框 */
.sepSearchInput {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  font-size: 12px;
  color: var(--text-primary);
  outline: none;
}

/* 违规 3 治理：22x22px 微圆角操作按钮 */
.sepSearchBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  transition: background-color 0.12s ease, color 0.12s ease;
}

.sepSearchBtn:hover {
  background-color: rgba(29, 28, 26, 0.045);
  color: var(--text-primary);
}

:global(html[data-theme='dark']) .sepSearchBtn:hover {
  background-color: rgba(245, 244, 240, 0.06);
}

/* 违规 7 治理：8px 同心条目、4.5% 悬停、6.5% 选中、翡翠绿对勾 */
.settingsSelectItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 28px;
  min-height: 28px;
  border: none;
  background: transparent;
  text-align: left;
  padding: 0 10px;
  border-radius: 8px;
  cursor: pointer;
  font-family: inherit;
  color: var(--text-primary);
  font-size: var(--font-size-sm, 13px);
  transition: background-color 0.12s ease;
  box-sizing: border-box;
}

.settingsSelectItem:hover {
  background: rgba(29, 28, 26, 0.045);
}

:global(html[data-theme='dark']) .settingsSelectItem:hover {
  background: rgba(245, 244, 240, 0.06);
}

.settingsSelectItem.isActive {
  background: rgba(29, 28, 26, 0.065);
  font-weight: 500;
}

:global(html[data-theme='dark']) .settingsSelectItem.isActive {
  background: rgba(245, 244, 240, 0.09);
}

.settingsSelectCheckIcon {
  flex-shrink: 0;
  color: #059669;
}

:global(html[data-theme='dark']) .settingsSelectCheckIcon {
  color: #10b981;
}
```

---

## 5. 模型设置页 7 处违规彻底根除

### 5.1 7 处违规对照与根治方案
涉及组件：`ModelsSettingsTab.tsx`、`ModelsSettingsTab.module.css`、`ModelProfileList.tsx`。

| 违规项 | 现状断层表现 | 根治方案与精确参数 |
| :--- | :--- | :--- |
| **违规 1** | 「+ 添加服务商」使用实心青绿底色与 `radius-xl` 药丸胶囊 | 还原为标准次级按钮：**6px 圆角、透明/中性背景、1px 发丝边框、悬停淡入 4.5% 柔和暖灰**。 |
| **违规 2** | 「全局默认模型」触发器使用深青绿粗描边与青色杂底 | 收敛为 **1px `#e2dfd9`/`#2b2926` 实体发丝边框 + `var(--bg-card)` 纯白底 + 6px 规整微圆角**。 |
| **违规 3** | 级联与模型列表出现 Windows 原生带箭头粗滚动条（`▲`/`▼`） | 彻底根除原生滚动条，内嵌滚动统一注入 **3px/4px 极细发丝滚动条（无箭头、透明轨道、圆角滑块）**。 |
| **违规 4** | 仅 1 项条目时写死高度，强制溢出并留下大片死白空间 | 采用**自适应高度测量**（`measureNaturalHeight`），条目不足时高度紧凑贴合，**1 项时绝不溢出、绝不出滚动条**。 |
| **违规 5** | 悬停态直接使用 `--sidebar-hover` 产生深青灰泥色块 | 悬停严格锁定为 **4.5% 轻柔淡灰（`rgba(29, 28, 26, 0.045)`）**，深色为 6% 冷白。 |
| **违规 6** | 浮层面板与触发器宽度错位脱节 | 面板自适应触发器宽度（`min-width: 100%`），消除阶梯错层感。 |
| **违规 7** | 浮层外层圆角与光影不统一 | 注入标准 **14px 外圆角 / 6px 内衬 / 8px 内层 / 28px 毛玻璃弥散光影**。 |

### 5.2 重构后核心样式规范

```css
/* apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css */

/* 违规 1 治理：「+ 添加服务商」去胶囊去青底 */
.addServiceBtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border-color, #e2dfd9);
  background: var(--bg-card, #ffffff);
  border-radius: var(--radius-md, 6px);
  padding: 0 10px;
  min-height: 28px;
  height: 28px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--font-size-sm, 13px);
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}

.addServiceBtn:hover {
  background: rgba(29, 28, 26, 0.045);
  border-color: var(--border-color, #e2dfd9);
}

:global(html[data-theme='dark']) .addServiceBtn {
  border-color: var(--border-color, #2b2926);
  background: var(--bg-card, #181715);
}

:global(html[data-theme='dark']) .addServiceBtn:hover {
  background: rgba(245, 244, 240, 0.06);
}

/* 违规 2 治理：「全局默认模型」触发器标准 28px / 6px 圆角 / 纯白底 */
.cascadeSelectTrigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--border-color, #e2dfd9);
  background: var(--bg-card, #ffffff);
  border-radius: var(--radius-md, 6px);
  padding: 0 10px;
  height: 28px;
  min-height: 28px;
  min-width: 220px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--font-size-sm, 13px);
  cursor: pointer;
  box-sizing: border-box;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}

.cascadeSelectTrigger:hover {
  background: rgba(29, 28, 26, 0.045);
  border-color: var(--border-color, #e2dfd9);
}

:global(html[data-theme='dark']) .cascadeSelectTrigger {
  border-color: var(--border-color, #2b2926);
  background: var(--bg-card, #181715);
}

:global(html[data-theme='dark']) .cascadeSelectTrigger:hover {
  background: rgba(245, 244, 240, 0.06);
}

/* 违规 7 治理：14px 同心外角与弥散毛玻璃 */
.cascadeList,
.addProviderMenu {
  min-width: 220px;
  background: var(--sep-bg-panel, rgba(255, 254, 252, 0.96));
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
  border: 1px solid var(--border-color, #e2dfd9);
  border-radius: 14px;
  box-shadow: 0 20px 48px -10px rgba(29, 28, 26, 0.09);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

:global(html[data-theme='dark']) .cascadeList,
:global(html[data-theme='dark']) .addProviderMenu {
  background: var(--sep-bg-panel, rgba(24, 23, 21, 0.96));
  border-color: var(--border-color, #2b2926);
  box-shadow: 0 24px 54px -10px rgba(0, 0, 0, 0.70);
}

/* 违规 3 & 4 治理：发丝滚动条与自适应高度 */
.cascadeFlyout {
  position: absolute;
  right: calc(100% + 4px);
  top: 0;
  min-width: 180px;
  max-height: 280px;
  height: auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  z-index: var(--z-dropdown-menu, 2000);
  background: var(--sep-bg-panel, rgba(255, 254, 252, 0.96));
  backdrop-filter: blur(28px);
  border: 1px solid var(--border-color, #e2dfd9);
  border-radius: 14px;
  box-shadow: 0 20px 48px -10px rgba(29, 28, 26, 0.09);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 3px 极细无箭头发丝滚动条 */
.cascadeFlyout::-webkit-scrollbar {
  width: 3px;
}
.cascadeFlyout::-webkit-scrollbar-track {
  background: transparent;
}
.cascadeFlyout::-webkit-scrollbar-thumb {
  background: var(--sep-border-color, #e2dfd9);
  border-radius: 3px;
}

/* 违规 5 治理：8px 条目圆角、4.5% 中性悬停与翡翠绿对勾 */
.cascadeRow,
.cascadeOption,
.addMenuOption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 28px;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary);
  background: transparent;
  cursor: pointer;
  border: none;
  transition: background-color 0.12s ease;
  box-sizing: border-box;
}

.cascadeRow:hover,
.cascadeRow.isOpen,
.cascadeOption:hover,
.addMenuOption:hover {
  background: rgba(29, 28, 26, 0.045);
  color: var(--text-primary);
}

:global(html[data-theme='dark']) .cascadeRow:hover,
:global(html[data-theme='dark']) .cascadeRow.isOpen,
:global(html[data-theme='dark']) .cascadeOption:hover,
:global(html[data-theme='dark']) .addMenuOption:hover {
  background: rgba(245, 244, 240, 0.06);
}

.cascadeOption.isSelected,
.cascadeOption.isOn {
  background: rgba(29, 28, 26, 0.065);
  color: var(--text-primary);
  font-weight: 500;
}

:global(html[data-theme='dark']) .cascadeOption.isSelected,
:global(html[data-theme='dark']) .cascadeOption.isOn {
  background: rgba(245, 244, 240, 0.09);
}

.cascadeCheck {
  color: #059669;
  flex-shrink: 0;
}

:global(html[data-theme='dark']) .cascadeCheck {
  color: #10b981;
}
```

---

## 6. 规则设置页 5 处违规彻底根除

### 6.1 5 处违规对照与根治方案
涉及组件：`SettingsRulesTab.tsx`、`SettingsRulesTab.module.css`。

| 违规项 | 现状断层表现 | 根治方案与精确参数 |
| :--- | :--- | :--- |
| **违规 1** | 右上角 `[ 全局 ▾ ]` 与 `[ 编辑全文 ]` 垂直错位换行与青绿药丸 | 采用**水平同行流式排布**（`display: flex; flex-direction: row; gap: 8px; align-items: center;`），彻底消灭垂直两截断层与青绿胶囊。 |
| **违规 2** | 右侧删除按钮尺寸与交互动效不规范 | 统一封装为 **28×28px 规范危操作图标按钮（`variant="danger"`）**，提供平滑悬停红底过渡。 |
| **违规 3** | 「常用」一键加入预设胶囊存在纯黑生硬描边与发白死斑 | 统一收敛为 **`--sep-btn-radius: 6px`** 微圆角，采用中性柔和浅灰底（`rgba(29, 28, 26, 0.03)`）与 1px 发丝边框。 |
| **违规 4** | 「自定义」输入栏裸写 HTML `<input>` 与未样式化裸字 | 升级为规范 **Input Group**，封装标准 `<Input size="sm">` + `<Button variant="secondary" size="sm">`。 |
| **违规 5** | 上半部规则列表与下半部快速添加卡片内边距不对齐 | 统一设定 `padding: 10px 14px` 与 `120px` 标签列宽度，实现上下边界严丝合缝对齐。 |

### 6.2 `SettingsRulesTab.tsx` 核心排版重构

```tsx
// 右上角操作区：水平同行排布
const headerMeta = (
  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
    <Select
      value={scopeKey}
      options={scopeOptions.map((o) => ({
        id: o.value,
        label: o.label,
        ...(o.hint !== undefined ? { hint: o.hint } : {}),
      }))}
      onChange={setScopeKey}
      disabled={busy}
      size="sm"
    />
    <Tooltip content={`编辑${scopeLabel}全文`}>
      <Button
        ref={fullEditorBtnRef}
        type="button"
        variant="secondary"
        size="sm"
        onClick={openFullEditor}
        aria-label={`编辑${scopeLabel}全文`}
        disabled={busy}
      >
        编辑全文
      </Button>
    </Tooltip>
  </div>
);

// 快速添加自定义栏：标准 Input Group
<div className={styles.sectionRowNoBorder}>
  <div className={styles.labelCol}>
    <label htmlFor={addInputId} className={styles.labelTitle}>自定义</label>
    <span className={styles.labelDesc}>输入后添加</span>
  </div>
  <div className={styles.inputGroup}>
    <Input
      ref={addInputRef}
      id={addInputId}
      size="sm"
      placeholder="写一条规则…"
      value={newRuleText}
      onChange={(e) => setNewRuleText(e.target.value)}
      disabled={busy}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleAddCustomRule();
        }
      }}
    />
    <Tooltip content={`加入${scopeLabel}短规则`}>
      <Button
        type="button"
        onClick={handleAddCustomRule}
        variant="secondary"
        size="sm"
        className={styles.actionBtn}
        disabled={busy || !normalizeRuleLine(newRuleText)}
        aria-label="添加规则"
      >
        添加
      </Button>
    </Tooltip>
  </div>
</div>
```

---

## 7. 安全设置页与状态诊断页治理

### 7.1 安全设置页 4 处治理（`SettingsSecurityTab`）
1. **权限模式选择器去粗描边与去青底**：收敛为 1px `#e2dfd9`/`#2b2926` 实体发丝边框 + `var(--bg-card)` 纯白底 + 6px 规整微圆角；
2. **「添加命令」输入群组标准化**：封装标准 `<Input size="sm">` + `<Button variant="secondary" size="sm">`，消灭裸写 HTML input；
3. **「常用预设」胶囊去药丸化**：废除 `radius-full` 大胶囊，统一收敛为标准 `6px` 微圆角（`--sep-btn-radius`）；
4. **统一工作区卡片排版**：统一左右对齐边距（`10px 14px`），与设置系统全局卡片契约保持一致。

### 7.2 状态诊断页 4 处治理（`StatusDiagnosticsPanel`）
1. **「当前日志级别」重构为标准下拉选择器**：
   - 废除死黑实心胶囊与孤立左侧脉冲图标；
   - 重构为标准 `Select` 控件（选项：`debug` / `info` / `warn` / `error`），带 Chevron `▾` 交互指示；
   - 日志目录补齐快捷复制按钮与完整绝对路径 Tooltip。
2. **根除「最近诊断」文本重叠碰撞致命排版 Bug**：
   - **根因**：原实现使用 `display: flex; gap: 10px; align-items: baseline;`，在不同屏幕宽度与多行日志下，`NOTE_RUNTIME` 标签与 `2026/8/20 16:21:57` 时间戳宽度挤压，发生严重的像素叠影乱码；
   - **重构方案**：采用 **CSS Grid 刚性栅格化分列**：
     ```css
     .diagItem {
       display: grid;
       grid-template-columns: 72px 150px 1fr;
       align-items: center;
       gap: 12px;
       padding: 8px 10px;
       border-bottom: 1px solid var(--border-subtle);
       box-sizing: border-box;
     }
     ```
     严格锁定第 1 列日志级别（72px）、第 2 列时间戳（150px）、第 3 列详细内容（1fr 带 ellipsis 截断与 Tooltip），100% 杜绝文本挤压碰撞！
3. **诊断卡片行内边距标准化**：为每行提供 `8px 10px` 呼吸感安全阅读内衬，消灭密密麻麻的条纹压迫感；
4. **状态语言统一化**：将 `OK`、`异常` 裸字统一为标准状态 Badge 胶囊（`--sep-badge-radius: 4px`），与「重建索引」操作按钮形成规范的图文与交互层级。

---

## 8. 工程落地实施步骤与文件变动清单

### 8.1 涉及文件清单与修改职责

| 目标文件 | 变更类型 | 核心修改职责 |
| :--- | :--- | :--- |
| `apps/crish-desktop/src/components/settings/SettingsUI.module.css` | **[MODIFY]** | 收敛全局 Select/Input/SegmentedControl 的 6px 圆角、28px/32px 高度与 Zero-Blue 边框底色 |
| `apps/crish-desktop/src/components/settings/FontSelectField.tsx` | **[MODIFY]** | 顶置搜索栏、接入 22×22px 微圆角按钮、绑定翡翠绿对勾 |
| `apps/crish-desktop/src/components/settings/FontSelectField.module.css` | **[MODIFY]** | 彻底消灭青绿杂底，实现 14px 同心外角 / 6px 内衬 / 8px 条目，重构 Flex 自适应输入框 |
| `apps/crish-desktop/src/components/settings/FontSettingsSection.tsx` | **[MODIFY]** | 规范头部与底部交互，对齐 28px 触发器与连字复选框高度 |
| `apps/crish-desktop/src/components/settings/FontSettingsSection.module.css` | **[MODIFY]** | 规范 22×22px 按钮，消灭杂色底 |
| `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx` | **[MODIFY]** | 「+ 添加服务商」去胶囊化与去青底，默认模型触发器标准化 |
| `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css` | **[MODIFY]** | 根除原生粗滚动条，实现 1 项条目自适应贴合，悬停绑定 4.5% 轻柔淡灰 |
| `apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx` | **[MODIFY]** | 级联菜单与条目重构为 8px 同心圆角与翡翠绿对勾 |
| `apps/crish-desktop/src/components/settings/SettingsRulesTab.tsx` | **[MODIFY]** | 右上角两按钮恢复水平同行，快速添加封装标准 `<Input>` + `<Button>` |
| `apps/crish-desktop/src/components/settings/SettingsRulesTab.module.css` | **[MODIFY]** | 常用预设去黑粗边，统一卡片内边距 |
| `apps/crish-desktop/src/components/settings/SettingsSecurityTab.tsx` | **[MODIFY]** | 权限模式选择器去青底，添加命令封装标准 Input Group，预设胶囊 6px 规整化 |
| `apps/crish-desktop/src/components/settings/SettingsSecurityTab.module.css` | **[MODIFY]** | 统一工作区卡片内边距与预设芯片样式 |
| `apps/crish-desktop/src/components/settings/StatusDiagnosticsPanel.tsx` | **[MODIFY]** | 日志级别升级为标准 Select 下拉，诊断列表采用 Grid 栅格分列彻底杜绝文字碰撞 |
| `apps/crish-desktop/src/components/settings/StatusDiagnosticsPanel.module.css` | **[MODIFY]** | 实现 `grid-template-columns: 72px 150px 1fr` 栅格，规范 4px 状态 Badge 与行内衬 |

---

## 9. 全量验收断言与质量门禁保障

### 9.1 视觉与交互断言
1. **[断言 1 - 零青底与 Zero-Blue 墨阶]**：
   - 浅色模式下，所有设置卡片、触发器、浮层面板底色均为纯净白底（`#ffffff` / `rgba(255, 254, 252, 0.96)`），边框为 1px 实体发丝线 `#e2dfd9`；
   - 彻底绝迹 `--sidebar-hover` 引入的深青绿泥色块；悬停严格为 4.5% 轻柔淡灰，选中高亮为 `#059669` 翡翠绿对勾。
2. **[断言 2 - 数学同心几何]**：
   - 外层主面板壳体锁定为 $14\text{px}$，内衬 $6\text{px}$，内部条目 $8\text{px}$，按钮 $6\text{px}$，标签 $4\text{px}$；
   - 彻底消灭 14px/16px 膨胀椭圆胶囊与非同心角落挤压。
3. **[断言 3 - 滚动条与自适应高度]**：
   - 模型设置与所有长列表中，彻底根除 Windows 原生上下三角箭头滚动条（`▲`/`▼`）；
   - 仅 1 项条目时高度自然贴合，绝不产生多余滚动条与死白空洞。
4. **[断言 4 - 排版防碰撞与栅格稳定性]**：
   - 状态诊断页最近诊断列表采用固定 Grid 分列，无论窗口如何拉伸，`NOTE_RUNTIME`、`INFO` 与 `2026/8/20 16:21:57` 绝对不发生叠影重叠；
   - 规则设置页右上角 `[ 全局 ▾ ]` 与 `[ 编辑全文 ]` 100% 保持在单行水平排列。

### 9.2 流水线与测试门禁断言
1. **类型检查**：运行 `npm run typecheck` 必须 0 错误通过；
2. **单元测试回归**：运行 `npm run test`，包含 `SettingsSchemaRenderer.test.tsx`、`StatusDiagnosticsPanel.test.tsx`、`ScheduledTasksPanel.test.tsx` 在内的设置相关测试 100% 绿灯通过；
3. **前端行数门禁**：遵循 `AGENTS.md` §11 行数分级门禁，单文件重构严格保持高内聚，不突破行数上限。
