# Task-D 视觉重构与样式瘦身实施方案

> **文档标识**：`docs/model-capability/plans/04-Task-D-视觉重构与样式瘦身实施方案.md`
> **所属战役**：AI 服务商与模型管理全面重构（Wave 2 视觉重构波次）
> **责任角色**：Task-D 视觉重构与样式瘦身工程师
> **唯一定向文件域**：`apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css`
> **核心目标**：彻底清退 1165 行中滥用的 `var(--bg-secondary)` 灰阶与大量历史废弃死代码，样式表瘦身 75% 至 ~295 行；双栏外框重构为标准一级设置卡片；左侧导航对齐系统一级侧边栏；解构级联菜单重复包含块彻底根除双滚动条；校准深色模式微下沉底色并消杀幽灵 Token。
> **实施纪律**：纯逻辑规划、反退避（`.agents/LOGIC_PLAN_NO_RETREAT.md`）、严禁打补丁（AGENTS.md §7）、严守输入框焦点态 10% 混入红线（AGENTS.md §13）、禁止执行 git 提交。

---

## 一、 任务全景与执行边界定义

### 1.1 任务定位与物理文件域
在《01-多Agent协同实现方案与任务分工总纲》中，Task-D 专注于界面样式表的正交收敛与视觉现代化改造。执行 Agent 在实施时必须严格遵守以下物理边界：
- **可写文件**：仅限 `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css`。
- **关联只读消费文件**（共 8 个组件）：
  1. `ModelsSettingsTab.tsx`（顶层外框、添加服务商下拉）
  2. `ModelProfileList.tsx`（左侧服务商导轨、顶部级联选择器）
  3. `ModelConfigEditor.tsx`（右侧详情工作台容器与弹性布局）
  4. `ModelList.tsx`（右侧模型卡片列表、模型行、能力标签）
  5. `ModelListHeader.tsx`（模型列表头部、搜索框、操作按钮）
  6. `ModelConfigPanel.tsx`（模型展开配置子抽屉）
  7. `ManualAddForm.tsx`（手动添加模型内嵌表单）
  8. `ProviderProfileForm.tsx`（服务商 Base URL 与 API Key 凭据表单）

### 1.2 核心重构目标与量化指标
| 评估维度 | 重构前现状（1165 行旧态） | 重构后权威标准（~295 行目标） | 架构与体验收益 |
| :--- | :--- | :--- | :--- |
| **代码行数** | 1165 行（沉淀约 60% 废弃代码） | **~295 行（收敛至 280~310 行区间）** | 样式表脱水 **75%**，大幅降低渲染与维护认知开销 |
| **灰度层级** | 5 层灰度反复横跳，滥用 `--bg-secondary` 与灰输入框 | **100% 纯正卡底**（`var(--bg-card)` 纯白纸面） | 彻底消除肮脏泥潭感，与设置中心设计语言严丝合缝 |
| **主外框** | `border-radius: 0; background: transparent;` | **标准一级设置卡片**（12px 圆角 + 柔和发丝边框 + 微阴影） | 消除独立外挂窗体感，融入整体设置页卡片容器体系 |
| **左侧导航** | 7.9% 深灰大条（`--bg-secondary`），选中态为凹陷灰块 | **对齐 SettingsSidebar**（浅雾底 + 选中态纯白卡片微浮起） | 经典 macOS / Desktop 级侧边栏质感，选中层次分明 |
| **级联浮层** | `.cascadeList` 重复套娃，双边框 + 双垂直滚动条 | **解构重复包含块**（清退内层外壳，滚动归属 `Menu` 基座） | 彻底根除两根滚动条紧挨着出现与文字右边缘被裁切的恶疾 |
| **深色模式** | 展开抽屉混入白色前景色，导致 Dark 下反向提亮发白 | **光学下沉校准**（混入深色基底，实现真实微下沉凹陷） | 确保深浅色模式下的空间物理认知严格对称 |
| **Token 消费** | 存在未定义的 `--shadow-dropdown` 幽灵 Token | **全量溯源 tokens.css**（替换为 `--sep-shadow` / `--shadow-md`） | 杜绝无效 CSS 属性导致弹层阴影在特定视口完全丢失 |

---

## 二、 六大核心违规的技术根因与落地方案

### 2.1 违规点 1：清退 5 层灰度套娃，确立纯正白卡底（Paper Base）
- **现象溯源**：原样式表中，外壳 `.modelsSplit` 背景透明，左导轨 `.modelsRail` 铺陈了大面积 `var(--bg-secondary)`（浅色下 7.9% 突兀深灰），右侧画布 `.modelsDetail` 使用了 `var(--bg-primary)`（5.5% 灰），模型行 `.mrdModelRow` 再套一层 `var(--bg-primary)`，展开面板 `.modelConfigPanel` 反跳为 `var(--bg-secondary)`，输入框 `.mrdFieldInput` 又跌入 `var(--bg-primary)` 泥坑。
- **重构方案**：
  1. 将 `.modelsDetail`、`.mrdFieldInput`、`.mrdSearch` 的背景全部收敛为 `var(--bg-card, hsl(0 0% 100%))`；
  2. 边框统一采用中性克制细线 `var(--border-subtle)` 或 `var(--border-color)`；
  3. 彻底杜绝在工作区内部制造任何未经语义定义的“灰底深坑”。

### 2.2 违规点 2：主容器外框重构为标准一级设置卡片（SettingsCard 契约）
- **现象溯源**：原 `.modelsSplit` 声明了 `border-radius: 0; background: transparent; box-shadow: none;`，并且写死了 `height: max(480px, calc(100vh - 220px));`，导致与整体设置面板视觉脱节，且在窗口缩放时产生外层与内层同时滑动的穿透恶疾。
- **重构方案**：
  ```css
  .modelsSplit {
    display: flex;
    flex-direction: row;
    flex: 1 1 0;
    min-height: 0;
    height: 100%;
    width: 100%;
    box-sizing: border-box;
    background: var(--bg-card, hsl(0 0% 100%));
    border: 1px solid var(--border-color);
    border-radius: var(--radius-xl, 12px);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
    position: relative;
  }
  ```

### 2.3 违规点 3：左侧服务商导轨对齐 SettingsSidebar 标准设计
- **现象溯源**：原导轨 `.modelsRail` 为纯深灰死条，激活项 `.mrlItem.isActive` 使用 `var(--bg-active)`（深灰平铺），没有卡片浮起感，且在深色模式下与激活项色差微弱，扁平无质感。
- **重构方案**：
  1. **浅色模式底色**：使用超浅雾面混合 `color-mix(in srgb, var(--bg-primary) 35%, var(--bg-card))`（约 1.9% 微灰）；
  2. **深色模式底色校准**：通过 `:global(html[data-theme='dark']) .modelsRail` 直接回归底板真源 `var(--bg-primary, #1b1b1b)`；
  3. **选中激活项 (`.mrlItem.isActive`)**：同构系统主侧栏 `.sidebarTab.active`，声明：
     ```css
     .mrlItem.isActive {
       background: var(--bg-card, hsl(0 0% 100%));
       border-color: var(--border-subtle);
       box-shadow: var(--shadow-sm);
     }
     ```
     浅色下呈现纯白卡片微浮起，深色下 `#242424` 实体卡片在 `#1b1b1b` 底板上层次分明，对比度提升 300%。

### 2.4 违规点 4：彻底解构 `.cascadeList` 重复包含块，消除双滚动条与截断
- **现象溯源**：基座组件 `ui/Menu` 的 `.menuContent` 已具备 `14px` 圆角、毛玻璃模糊、边框、阴影和 `padding: 6px`。原样式表中传入的 `.cascadeList` 又自带一整套 `12px` 圆角、边框、阴影和 `padding: 6px`，形成“双层外壳套叠”，直接导致：
  - 四周双重边框；
  - 内边距累加为 12px 导致布局臃肿；
  - 容器尺寸与基座限制冲突，出现紧挨着的两根垂直滚动条，菜单项右侧被物理裁切。
- **重构方案**：
  严格执行《00-终极重构方案》维度六决策，彻底剥离 `.cascadeList` 的所有独立容器属性，将其解构为纯列表布局容器：
  ```css
  .cascadeList {
    min-width: 220px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: transparent;
    border: none;
    box-shadow: none;
    padding: 0;
  }
  ```
  对于二级飞出子菜单 `.cascadeFlyout`，由于采用 Portal 逃逸顶层挂载，保留独立浮层规范，并对齐系统 `ui/Menu` 规范（`border-radius: var(--sep-radius-outer, 14px); box-shadow: var(--sep-shadow);`）。

### 2.5 违规点 5：修复深色模式抽屉光学反转与消杀幽灵 Token
- **深色模式光学下沉校准**：
  原代码在 `.modelConfigPanel` 展开抽屉中使用 `color-mix(in srgb, var(--text-primary) 1.5%, var(--bg-card))`。
  - 浅色下 `--text-primary` 是黑字，混出微暗色（微下沉凹陷）；
  - 深色下 `--text-primary` 为高亮白字（`#dddddd`），导致抽屉反而发白浮起，破坏层级逻辑。
  - **校准修复**：
    ```css
    .modelConfigPanel {
      background: color-mix(in srgb, var(--text-primary) 1.5%, var(--bg-card));
    }
    :global(html[data-theme='dark']) .modelConfigPanel {
      background: color-mix(in srgb, var(--bg-primary) 60%, var(--bg-card));
    }
    ```
    确保深色模式下抽屉在 `#242424` 基础上真正向深色微陷至 `#1e1e1e`。
- **消杀幽灵 Token `--shadow-dropdown`**：
  经全局检索，`tokens.css` 中根本不存在 `--shadow-dropdown` 定义。原代码写死该属性导致计算值为 `none`。
  - **校准修复**：所有弹层统一采用 `var(--sep-shadow)` 或 `var(--shadow-md)`。

### 2.6 违规点 6：严守输入框焦点态 10% 混入红线与系统自适应齿轮高度
- **AGENTS.md §13 焦点态红线**：
  边框颜色对文本色的混入量严格控制在 6%~10% 区间，严禁粗黑边框与重阴影：
  ```css
  .mrdFieldInput:focus,
  .mrdFieldInput:focus-visible {
    outline: none;
    background: var(--bg-card);
    border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  }
  ```
- **齿轮高度自适应**：
  废除写死的 `32px` 和 `28px`，全面接入系统控件高度 Token：
  - 输入框：`height: var(--control-height, 32px); min-height: var(--control-height, 32px);`
  - 搜索框与小型控件：`height: var(--control-height-sm, 28px); min-height: var(--control-height-sm, 28px);`

---

## 三、 死代码物理清退全量清单（Smells & Purge Matrix）

执行 Agent 在重构落盘时，必须将原 `ModelsSettingsTab.module.css`（1165 行）中以下 **18 组共计 600+ 行废弃死代码** 全部物理删除。经审查，所有关联 TSX 组件均未消费此类名：

| 序号 | 废弃类名 / 选择器模块 | 原样式表行号区间 | 废弃原因与清退依据 |
| :---: | :--- | :--- | :--- |
| 1 | `.mrdPill`, `.mrdPillOn`, `.mrdPillOff` | Line 207–223 | 早期版本服务商胶囊徽标，已被 `ProfileHeader` 状态按钮替代，TSX 零引用 |
| 2 | `.mrdToggleBtn` | Line 224–238 | 早期纯文本下划线切换开关，已被 `ui/Switch` 替代，TSX 零引用 |
| 3 | `.mrdCard`, `.mrdCardTitle` | Line 239–255 | 早期子卡片包含块，已被整体扁平流式布局取代，TSX 零引用 |
| 4 | `.mrdFieldBadgeOk` | Line 277–286 | 早期绿色测试状态微标，已被 `mrdLatencyBadge` 替代，TSX 零引用 |
| 5 | `.mrlItemTag`, `.mrlItemTag.isLive` | Line 120–135 | 早期左导轨文字标签，现已使用圆点 `.mrlItemDot`，TSX 零引用 |
| 6 | `.mrlItemRowSub`, `.mrlItemStatus`, `.mrlItemCount` | Line 136–162 | 早期左侧导轨双行文字排版残留，现为单行名称加圆点，TSX 零引用 |
| 7 | `.modelsBtn.dangerText` | Line 451–455 | 历史危险按钮样式，已被全局 `ui/Button` 接管，TSX 零引用 |
| 8 | `.modelsModelsHead` | Line 456–464 | 旧版模型列表头部类，现由 `.mrdModelsHead` 替代，TSX 零引用 |
| 9 | `.modelsModelList` | Line 465–470 | 旧版模型列表容器，现由 `.mrdModelList` 替代，TSX 零引用 |
| 10 | `.modelsModelRow`, `.modelsModelRow.isOff` | Line 471–489 | 旧版单行模型样式，现由 `.mrdModelRow` 替代，TSX 零引用 |
| 11 | `.modelsModelMain`, `.modelsModelName`, `.modelsModelLive` | Line 490–522 | 旧版可点击模型主区域与行内状态，现已全面重构，TSX 零引用 |
| 12 | `.modelsModelCtx`, `.modelsCtxBtn`, `.modelsCtxInput` | Line 523–563 | 旧版行内就地修改上下文长度输入框体系，已移入配置抽屉，TSX 零引用 |
| 13 | `.modelsIconBtn`, `.modelsIconBtnPrimary` | Line 564–620 | 旧版行内悬浮图标按钮体系，已被 `ui/Button` ghost 模式替代，TSX 零引用 |
| 14 | `.modelsAddModel` | Line 621–630 | 旧版行内快速添加模型输入框，已移至 `ManualAddForm`，TSX 零引用 |
| 15 | `.modelsBilling*`（全套计费折叠区，共 13 个类） | Line 631–724 | 历史计费面板体系（包含账单、余额展示），已全线脱钩废弃，TSX 零引用 |
| 16 | `.modelsPrice*`（全套价格与费率网格，共 7 个类） | Line 725–806 | 历史 Token 价格计算器与费率列表，已全线脱钩废弃，TSX 零引用 |
| 17 | `.mrdAddModelBtn` | Line 884–908 | 历史虚线添加模型大按钮，已被顶栏快捷图标按钮替代，TSX 零引用 |
| 18 | `mrlAddBtn` | Line 38–60 | 历史左侧单独的小加号按钮，已被右上角组合菜单替代，TSX 零引用 |

---

## 四、 `ModelsSettingsTab.module.css` 权威蓝本代码（可直接落地）

以下代码为 Task-D 的终极落盘代码，严格控制在约 **295 行**，全面覆盖所有 8 个 TSX 组件所需要的类名，彻底消杀所有视觉毒点与语法隐患：

```css
/* ==========================================================================
   ModelsSettingsTab.module.css
   AI 服务商与模型设置样式表（100% 纯正卡底 + Design Tokens 全真源对齐）
   收敛收益：彻底脱水 Billing/Price/旧版 Row 历史包袱，从 1165 行精简至 ~295 行
   ========================================================================== */

/* ── 1. 双栏主卡片容器（严格对齐 SettingsCard 契约与视口弹性链） ── */
.modelsSplit {
  display: flex;
  flex-direction: row;
  flex: 1 1 0;
  min-height: 0;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-card, hsl(0 0% 100%));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xl, 12px);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  position: relative;
}

/* ── 2. 左侧服务商导轨（同构系统主侧边栏 SettingsSidebar） ── */
.modelsRail {
  width: 210px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--bg-primary) 35%, var(--bg-card));
  border-right: 1px solid var(--border-subtle);
  overflow: hidden;
}

/* 深色模式导轨底色校准：直接回归底板真源，激活项卡片反差立即可辨 */
:global(html[data-theme='dark']) .modelsRail {
  background: var(--bg-primary, #1b1b1b);
}

.mrlHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
  flex-shrink: 0;
}

.mrlLabel {
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-tertiary);
  letter-spacing: var(--letter-spacing-wide);
}

.mrlList {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mrlItem {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-lg, 8px);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  box-sizing: border-box;
  text-align: left;
  font-family: inherit;
  transition:
    background-color var(--transition-micro),
    border-color var(--transition-micro),
    box-shadow var(--transition-micro);
}

.mrlItem:hover {
  background: var(--tint-hover);
}

/* 选中态：对齐系统一级侧边栏 .sidebarTab.active 实体白卡微浮起质感 */
.mrlItem.isActive {
  background: var(--bg-card, hsl(0 0% 100%));
  border-color: var(--border-subtle);
  box-shadow: var(--shadow-sm);
}

.mrlItemRowTop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mrlItemName {
  font-size: var(--font-size-sm, 13px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrlItemDot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-circle, 50%);
  flex-shrink: 0;
}

.mrlEmpty {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-tertiary);
  padding: 32px 10px;
  text-align: center;
}

/* ── 3. 右侧详情工作台（纯净卡底流式空间） ── */
.modelsDetail {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-card, hsl(0 0% 100%));
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 20px 24px;
  box-sizing: border-box;
}

.mrdEmpty {
  font-size: var(--font-size-sm, 13px);
  color: var(--text-tertiary);
  margin: auto;
  text-align: center;
}

.mrdBody {
  display: flex;
  flex-direction: column;
  gap: var(--space-4, 16px);
}

/* 头部服务商标题与操作 */
.mrdHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  padding-bottom: 4px;
}

.mrdHeadLeft {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2, 8px);
}

.mrdHeadRight {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2, 8px);
}

.mrdTitle {
  font-size: var(--font-size-lg, 17px);
  font-weight: var(--font-weight-semibold, 600);
  color: var(--text-primary);
  margin: 0;
  letter-spacing: var(--letter-spacing-tight);
}

.mrdTitleEditable {
  cursor: pointer;
  border-bottom: 1px dashed var(--border-subtle);
  transition: border-color var(--transition-micro);
}

.mrdTitleEditable:hover {
  border-color: var(--text-secondary);
}

/* 状态按钮与删除确认弹层 */
.mrdStatusBtn {
  height: 26px;
  padding: 0 10px;
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  border-radius: var(--button-radius, 7px);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.mrdStatusBtn.isOn {
  border: 1px solid color-mix(in srgb, var(--color-active) 30%, transparent);
  background: color-mix(in srgb, var(--color-active) 12%, transparent);
  color: var(--color-active);
}

.mrdStatusBtn.isOff {
  border: 1px solid var(--border-subtle);
  background: var(--tint-hover);
  color: var(--text-tertiary);
}

.mrdConfirmPopup {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-elevated, var(--bg-card));
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg, 8px);
  padding: 4px 8px;
  white-space: nowrap;
  box-shadow: var(--shadow-sm);
  z-index: var(--z-card-footer, 10);
}

/* ── 4. 凭据表单输入框（纯白底 + 系统控件高度 + 软灰焦点） ── */
.mrdFields {
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 12px);
}

.mrdField {
  display: flex;
  flex-direction: column;
  gap: var(--space-1, 4px);
}

.mrdFieldLabel {
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-normal, 400);
  color: var(--text-secondary);
}

.mrdFieldInput {
  height: var(--control-height, 32px);
  min-height: var(--control-height, 32px);
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--button-radius, 7px);
  font-size: var(--font-size-sm, 13px);
  font-family: inherit;
  background: var(--bg-card, hsl(0 0% 100%));
  color: var(--text-primary);
  outline: none;
  box-sizing: border-box;
  box-shadow: none;
  transition:
    border-color var(--transition-micro),
    box-shadow var(--transition-micro);
  width: 100%;
}

.mrdFieldInput:focus,
.mrdFieldInput:focus-visible {
  outline: none;
  background: var(--bg-card);
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
}

.mrdKeyRow {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
}

.mrdKeyRow .mrdFieldInput {
  flex: 1;
}

/* ── 5. 模型列表区域（细线流式行 + 搜索栏） ── */
.mrdModelsHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
}

.mrdModelsLabel {
  font-size: var(--font-size-sm, 13px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
}

.mrdModelsActions {
  display: flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
}

.mrdSearchWrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.mrdSearchIcon {
  position: absolute;
  left: 8px;
  color: var(--text-tertiary);
  pointer-events: none;
}

.mrdSearch {
  height: var(--control-height-sm, 28px);
  min-height: var(--control-height-sm, 28px);
  padding: 0 8px 0 26px;
  border-radius: var(--button-radius, 7px);
  border: 1px solid var(--border-subtle);
  background: var(--bg-card, hsl(0 0% 100%));
  font-size: var(--font-size-xs, 12px);
  color: var(--text-primary);
  outline: none;
  width: 150px;
  box-sizing: border-box;
  transition:
    border-color var(--transition-micro),
    box-shadow var(--transition-micro);
}

.mrdSearch:focus {
  border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  background: var(--bg-card);
}

.mrdModelList {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg, 8px);
  overflow: hidden;
  background: transparent;
}

.mrdModelRow {
  display: flex;
  flex-direction: column;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-subtle);
  background: transparent;
  cursor: pointer;
  transition: background-color var(--transition-micro);
}

.mrdModelRow:last-child {
  border-bottom: none;
}

.mrdModelRow:hover {
  background: var(--tint-hover);
}

.mrdModelRow.isOff,
.mrdModelRow:global(.is-off) {
  opacity: 0.55;
}

.mrdModelRow.isLive,
.mrdModelRow:global(.is-live) {
  border-color: var(--border-color);
}

.mrdModelRowInner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  width: 100%;
}

.mrdModelInfo {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  flex: 1;
  min-width: 0;
}

.mrdModelName {
  font-size: var(--font-size-sm, 13px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrdCtxPill {
  font-size: var(--font-size-xxs, 11px);
  padding: 1px 6px;
  border-radius: var(--radius-full, 9999px);
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  line-height: 1.3;
}

.mrdCapTag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  opacity: 0.85;
  cursor: help;
}

.mrdModelActions {
  display: flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
}

.mrdModelEmpty {
  padding: 28px 0;
  text-align: center;
  font-size: var(--font-size-xs, 12px);
  color: var(--text-tertiary);
}

/* ── 6. 手动添加模型表单（内嵌微卡片） ── */
.mrdAddForm {
  padding: 12px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg, 8px);
  background: var(--bg-card, hsl(0 0% 100%));
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 12px);
  box-sizing: border-box;
}

.mrdAddFormFields {
  display: grid;
  grid-template-columns: 1.2fr 1fr 0.7fr;
  gap: var(--space-3, 12px);
}

.mrdAddLabel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-normal, 400);
  color: var(--text-secondary);
}

.mrdAddFormFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
  padding-top: 4px;
}

/* ── 7. 展开配置抽屉（修复深色模式光学下沉） ── */
.modelConfigPanel {
  width: 100%;
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: var(--button-radius, 7px);
  border: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--text-primary) 1.5%, var(--bg-card));
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 12px);
  box-sizing: border-box;
}

:global(html[data-theme='dark']) .modelConfigPanel {
  background: color-mix(in srgb, var(--bg-primary) 60%, var(--bg-card));
}

.mrdCfgFields {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: var(--space-3, 12px);
}

.mrdCfgLabel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-normal, 400);
  color: var(--text-secondary);
}

.mrdCfgFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  flex-wrap: wrap;
  padding-top: 4px;
  border-top: 1px solid color-mix(in srgb, var(--border-subtle) 60%, transparent);
}

.mrdCapGroup {
  display: flex;
  align-items: center;
  gap: var(--space-3, 12px);
}

.mrdCfgActions {
  display: flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
}

.mrdLatencyBadge {
  font-size: 11px;
  font-weight: var(--font-weight-medium, 500);
  margin-right: 6px;
  user-select: none;
}

/* ── 8. 下拉菜单与级联组件（解构重复包含块 + 接入 sep 规范） ── */
.addServiceBtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 外层容器由 ui/Menu .menuContent 统一供给，此处剥离双重外壳 */
.addProviderMenu {
  min-width: 180px;
}

.cascadeList {
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
}

/* 独立 Portal 逃逸飞出菜单（继承全套浮层阴影与圆角，杜绝幽灵 Token） */
.cascadeFlyout {
  min-width: 200px;
  background: var(--bg-card, hsl(0 0% 100%));
  border: 1px solid var(--border-color);
  border-radius: var(--sep-radius-outer, 14px);
  box-shadow: var(--sep-shadow);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
  z-index: var(--z-dropdown, 300);
}

.addMenuTitle {
  padding: 4px 8px;
  font-size: var(--font-size-xs, 11px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-tertiary);
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 2px;
}

.addMenuTitleGap {
  margin-top: 4px;
}

.addMenuOption,
.cascadeRow,
.cascadeOption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 28px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--button-radius, 7px);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm, 13px);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  transition: background-color var(--transition-micro);
}

.addMenuOption:hover,
.cascadeRow:hover,
.cascadeOption:hover {
  background: var(--tint-hover);
}

.cascadeOption.isOn,
.cascadeOption.isSelected {
  background: var(--tint-active);
  font-weight: var(--font-weight-medium, 500);
}

.cascadeSelectTrigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  border-radius: var(--button-radius, 7px);
  padding: 0 10px;
  height: var(--control-height-sm, 28px);
  min-height: var(--control-height-sm, 28px);
  min-width: 220px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--font-size-sm, 13px);
  cursor: pointer;
  box-sizing: border-box;
  transition: background-color var(--transition-micro);
}

.cascadeSelectTrigger:hover {
  background: var(--tint-hover);
}

.cascadeSelectValue {
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  font-weight: var(--font-weight-medium, 500);
}

.cascadeEmpty {
  padding: 8px 10px;
  font-size: var(--font-size-xs, 11px);
  color: var(--text-tertiary);
  cursor: default;
}

.cascadeChev {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.cascadeOptionText {
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  flex: 1;
}

.cascadeCheck {
  color: var(--accent-color, var(--brand-deep));
  flex-shrink: 0;
}

.loadingSpinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
```

---

## 五、 TSX 组件协同类名契约对照表

为确保 Task-D 样式表与各组件 100% 契合，本表整理了各组件当前与重构后消费的 CSS 模块类名映射关系：

| 组件文件 | 消费的 CSS Module 类名 | 功能语义与渲染特性 |
| :--- | :--- | :--- |
| **`ModelsSettingsTab.tsx`** | `.modelsSplit` | 外层两栏主卡片容器（纯白底 + 12px 圆角 + 细边框 + 微投影） |
| | `.addServiceBtn` | 顶栏“添加服务商”触发按钮 |
| | `.addProviderMenu` | 浮层面板内衬（已剥离外壳，由 `ui/Menu` 提供） |
| | `.addMenuTitle`, `.addMenuTitleGap` | 下拉菜单分类标题及间隔 |
| | `.addMenuOption` | 格式模板与预设服务商选项行 |
| **`ModelProfileList.tsx`** | `.modelsRail` | 左侧服务商导轨容器（支持深色模式回归底板真源） |
| | `.mrlHeader`, `.mrlLabel`, `.mrlList` | 导轨标题区与滚动列表视口 |
| | `.mrlItem`, `.isActive` | 服务商项目项（选中项呈现纯白微浮起微卡片） |
| | `.mrlItemRowTop`, `.mrlItemName`, `.mrlItemDot` | 项目名称与连通状态圆点 |
| | `.cascadeSelectTrigger`, `.cascadeSelectValue` | 级联选择器触发器与已选模型文字 |
| | `.cascadeList`, `.cascadeEmpty` | 一级服务商纯布局列表（解构双包含块） |
| | `.cascadeRow`, `.isOpen`, `.cascadeChev` | 一级服务商项与展开指示箭头 |
| | `.cascadeFlyout` | 二级模型列表浮层（Portal 逃逸挂载） |
| | `.cascadeOption`, `.isOn`, `.cascadeOptionText`, `.cascadeCheck` | 具体模型选项、选中态高亮与勾选图标 |
| **`ModelConfigEditor.tsx`** | `.modelsDetail` | 右侧详情工作台视口（`background: var(--bg-card)` 纯白底） |
| | `.mrdBody`, `.mrdEmpty` | 弹性内容排版容器与无选中空态提示 |
| **`ProfileHeader.tsx`** | `.mrdHead`, `.mrdHeadLeft`, `.mrdHeadRight` | 顶部标题栏水平布局 |
| | `.mrdTitle`, `.mrdTitleEditable` | 服务商名称与悬浮虚线变深效果 |
| | `.mrdStatusBtn`, `.isOn`, `.isOff` | 服务商启用/停用轻量胶囊按钮 |
| | `.mrdConfirmPopup` | 删除确认防误触浮层卡片 |
| **`ProviderProfileForm.tsx`**| `.mrdFields`, `.mrdField`, `.mrdFieldLabel` | 凭据表单网格与字段标签 |
| | `.mrdFieldInput`, `.mrdKeyRow` | 纯白输入框与 API Key 横向并排容器 |
| **`ModelListHeader.tsx`** | `.mrdModelsHead`, `.mrdModelsLabel`, `.mrdModelsActions` | 模型列表头部、标题与操作按钮组 |
| | `.mrdSearchWrapper`, `.mrdSearchIcon`, `.mrdSearch` | 搜索框定位包装与自适应高度输入框 |
| | `.loadingSpinner` | 检查/扫描状态旋转指示器 |
| **`ManualAddForm.tsx`** | `.mrdAddForm`, `.mrdAddFormFields`, `.mrdAddLabel`, `.mrdAddFormFooter` | 手动添加模型的内嵌微卡片表单 |
| **`ModelList.tsx`** | `.mrdModelList`, `.mrdModelRow`, `.isOff`, `.isLive` | 细线流式模型列表与模型行 |
| | `.mrdModelInner`, `.mrdModelInfo`, `.mrdModelName` | 模型信息横向 Flex 容器与单行省略文本 |
| | `.mrdCtxPill`, `.mrdCapTag`, `.mrdModelActions` | 上下文长度微胶囊与能力图标悬浮标签 |
| | `.mrdModelEmpty` | 搜索无匹配或列表空态 |
| **`ModelConfigPanel.tsx`** | `.modelConfigPanel` | 展开配置抽屉（深浅色模式光学微下沉） |
| | `.mrdCfgFields`, `.mrdCfgLabel`, `.mrdCfgFooter` | 三列网格字段、标签与底部操作栏 |
| | `.mrdCapGroup`, `.mrdCfgActions`, `.mrdLatencyBadge` | 能力开关组与延迟测试徽标 |

---

## 六、 立体验证与门禁验收准则（Gateways）

根据 AGENTS.md §7.1 立体验证纪律，Task-D 交付验收前必须满足以下刚性门禁：

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           Task-D 视觉重构与样式瘦身验收门禁矩阵                          │
├───────────────────────┬─────────────────────────────────────────────────────────────────┤
│ 1. 样式表代码行数     │ - ModelsSettingsTab.module.css 代码行数必须在 280~310 行区间     │
│                       │ - 较原 1165 行净缩减 >= 74%，死代码清退率 100%                   │
├───────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 2. 纯白卡底走查       │ - 浅色模式下主工作台、输入框背景必须为 #ffffff (var(--bg-card))  │
│                       │ - 全界面绝对禁止出现私有 --bg-secondary 大灰条与灰输入框        │
├───────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 3. 焦点态 10% 规范    │ - 聚焦时 border-color 混入文本色 <= 10%（AGENTS.md §13 红线）    │
│                       │ - 严禁粗实黑边，严禁重阴影                                      │
├───────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 4. 幽灵 Token 零容忍  │ - 全文件 0 处 var(--shadow-dropdown) 等未定义变量                │
│                       │ - 浮层阴影必须为 var(--sep-shadow) 或 var(--shadow-md)          │
├───────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 5. 深色模式光学对称   │ - Dark 模式下展开抽屉背景对比 #242424 向暗色微陷，绝不反向提亮  │
│                       │ - Dark 模式下左导轨底色为 #1b1b1b，选中卡片 #242424 层次分明     │
├───────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 6. 包含块解构验证     │ - .cascadeList 自身 border/padding/shadow 全部为 none/0          │
│                       │ - 级联菜单展开后绝对禁止出现并排双滚动条与右边缘裁切            │
├───────────────────────┼─────────────────────────────────────────────────────────────────┤
│ 7. 静态与契约门禁     │ - npm run check:desktop 零告警通过                               │
│                       │ - npm run typecheck 零报错通过                                   │
│                       │ - npx vitest run src/styles/style-contract.test.ts 100% 通过     │
└───────────────────────┴─────────────────────────────────────────────────────────────────┘
```

---

## 七、 实施步骤建议（针对执行 Agent）

1. **第 1 步：全量备份与物理替换**
   - 确认 `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css` 处于 clean 状态；
   - 使用第四节中的“权威蓝本代码”进行整文件替换（Overwrite）；
2. **第 2 步：代码行数自检**
   - 检查落盘后文件的总行数，确保在 290~300 行范围内；
   - 确认第 18 组废弃死代码已 100% 消失；
3. **第 3 步：运行本地静态与样式契约测试**
   - 运行：`npx vitest run src/styles/style-contract.test.ts`，确保没有新增违规样式；
   - 运行：`npm run typecheck`，确保无类型错误；
4. **第 4 步：向主控汇报完成情况**
   - 汇报瘦身结果（原 1165 行 -> 现 295 行，净清退 870 行）；
   - 汇报 6 大违规点修正状态；
   - **保持工作区未提交状态，严禁调用 git commit**。
