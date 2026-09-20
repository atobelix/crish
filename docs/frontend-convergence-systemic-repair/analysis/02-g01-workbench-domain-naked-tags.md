# G-01 规则深度分析报告：工作区、设置、便签、文件与侧边栏等业务域裸标签收敛方案

> **规范权威来源**：`scripts/check-frontend-convergence.mjs` (Rule 1 / G-01)  
> **设计系统契约**：`apps/crish-desktop/src/components/ui/` (Single Truth Barrel) 与 `docs/red-team-plans/detailed-plans/02-原子设计系统与同心几何维度详案.md`  
> **输入依据**：全仓门禁扫描违规集 `.agent-outputs/all-convergence-violations.json`  
> **文档位置**：`docs/frontend-convergence-systemic-repair/analysis/02-g01-workbench-domain-naked-tags.md`  
> **状态**：全面审计完成 · 准备实施

---

## 目录

1. [执行摘要与全仓收敛审计全貌](#一执行摘要与全仓收敛审计全貌)
2. [原子设计系统契约与基元映射规范](#二原子设计系统契约与基元映射规范)
   - 2.1 原子组件能力矩阵与 Props 映射法则
   - 2.2 焦点环与同心几何标尺（§13 & G-04）
   - 2.3 `Input` 裸核心模式（`bare`）与文件选择器纯净化建议
   - 2.4 `document.createElement` 剪贴板与原生对话框架构解耦方案
3. [9 大业务域 81 文件 156 处违规项逐一详析与改造清单](#三9-大业务域-81-文件-156-处违规项逐一详析与改造清单)
   - 3.1 分域一：工作区与多窗格域（Workspace & Binary Tree，10 文件 / 19 处）
   - 3.2 分域二：设置、模型与技能域（Settings, Models & Skills，19 文件 / 38 处）
   - 3.3 分域三：便签与备忘录域（Note Paper & Scratchpad，6 文件 / 17 处）
   - 3.4 分域四：文件管理与代码比对域（Files & Diff，11 文件 / 20 处）
   - 3.5 分域五：侧边栏与会话导航域（Sidebar & Sessions，6 文件 / 10 处）
   - 3.6 分域六：向导与配置引导域（Wizard & First-Run，3 文件 / 6 处）
   - 3.7 分域七：智能体面板与自定义卡片域（Agent Card & Custom Tags，9 文件 / 18 处）
   - 3.8 分域八：会话流扩展域（Conversation Flow Extension，5 文件 / 8 处）
   - 3.9 分域九：浮层、概览与系统诊断域（Overlay, Overview & Diagnostics，12 文件 / 20 处）
4. [单测防护网与回归风险评估](#四单测防护网与回归风险评估)
5. [实施波次规划与分阶段行动清单](#五实施波次规划与分阶段行动清单)

---

## 一、执行摘要与全仓收敛审计全貌

在前端重构终极收敛防回潮门禁（`scripts/check-frontend-convergence.mjs`）中，**Rule 1（G-01：业务层零裸原生交互标签阻断）** 作为第一刚性检测红线，全面拦截任何未经 `@/components/ui` 标准基元包裹的原生 `<button>`、`<input>`、`<textarea>`、`<select>` 标签及 `createElement` 动态调用。

根据全仓静态扫描数据 `.agent-outputs/all-convergence-violations.json`，全仓前端代码共有 **226 处 G-01 违规项**。其中：
- **Chat 对话核心域**：70 处（归属于 01 专项报告分析范围）。
- **非 Chat 业务域（工作区、设置、便签、文件、侧边栏、向导、扩展流等）**：共计 **81 个文件、156 处违规项**，由本报告全部覆盖并提供完整工程改造方案。

### 1.1 违规标签型别与统计分布

| 标签 / 调用形态 | 违规总数 | 主要出现场景 | 映射目标原子组件 |
| :--- | :---: | :--- | :--- |
| `<button>` | **120** | 工具栏图标按钮、列表项折叠触点、卡片操作按钮、选项切换 Tab、对话框关闭按钮 | `IconButton`（纯图标）、`Button`（文本/图文）、`Button bare`（自定义复杂卡片布局） |
| `<input>` | **27** | 搜索过滤输入框、重命名浮层输入、向导表单字段、颜色选择器、隐藏文件选择器、复选框 | `Input`（text/search/password/color）、`Input bare`（内联编辑/隐藏）、`Switch`（复选开关） |
| `<textarea>` | **6** | 批注多行文本、代码临时编辑、Git 提交信息输入、规则编辑器文本域、计划任务描述 | `Textarea`、`Textarea bare`（代码编辑舞台/无边框输入） |
| `document.createElement('textarea')` | **2** | 剪贴板复制降级兜底（NotePaperStrictHeader, StatusDiagnosticsPanel） | 下沉至统一剪贴板模块，消解业务组件直接 DOM 操作 |
| `document.createElement('input')` | **1** | 动态创建文件上传对齐输入（SettingsProfileTab） | 规范化文件对话框 API 或通过标准组件隐蔽承载 |
| **总计** | **156** | **覆盖 81 个源文件，贯穿除 Chat 域外的全生命周期交互界面** | **100% 收敛至 `@/components/ui` 出口** |

### 1.2 9 大业务领域违规全景矩阵

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│              非 Chat 业务域 G-01 违规分布 (81 文件 / 156 违规)                     │
├────────────────────────┬──────────┬──────────┬───────────────────────────────────┤
│ 业务领域               │ 文件数量 │ 违规数量 │ 核心组件清单                      │
├────────────────────────┼──────────┼──────────┼───────────────────────────────────┤
│ 1. 工作区与多窗格      │ 10       │ 19       │ LeafToolTabStrip, PaneHeader, ... │
│ 2. 设置、模型与技能    │ 19       │ 38       │ FontSelectField, WorkflowForm, .. │
│ 3. 便签与备忘录        │ 6        │ 17       │ NoteSidebarDrawer, StrictHeader.. │
│ 4. 文件管理与代码比对  │ 11       │ 20       │ FileBreadcrumb, DiffCard, ...     │
│ 5. 侧边栏与会话导航    │ 6        │ 10       │ SidebarNav, SessionRow, ...       │
│ 6. 向导与配置引导      │ 3        │ 6        │ WizardKeyStep, WizardModelStep... │
│ 7. 智能体与自定义卡片  │ 9        │ 18       │ InlineAgentTimeline, WidgetDiff.. │
│ 8. 会话流扩展          │ 5        │ 8        │ ActionRow, ArtifactNotebookSurface│
│ 9. 浮层、概览与诊断    │ 12       │ 20       │ ToastCard, ModelBadgePickerMenu.. │
├────────────────────────┼──────────┼──────────┼───────────────────────────────────┤
│ 合计                   │ 81       │ 156      │ 全面覆盖                          │
└────────────────────────┴──────────┴──────────┴───────────────────────────────────┘
```

---

## 二、原子设计系统契约与基元映射规范

### 2.1 原子组件能力矩阵与 Props 映射法则

依据 `@/components/ui` 导出的单一真理出口，业务层裸交互标签必须按以下标准矩阵进行替换：

#### (1) `Button` 与 `IconButton` 选型法则
- **`IconButton`（正方形图标按钮）**：
  - 适用条件：无显式文字子节点、仅包含图标（如 `AppIcon`）的操作触点。
  - **强制契约**：必须提供 `'aria-label'` 属性；支持声明式 `tooltip`（内置 `Tooltip` 包裹）与 `shortcut` 快捷键提示；默认 `variant="ghost"`。
- **`Button`（标准操作按钮）**：
  - 适用条件：包含文案、主次操作按钮、危险操作按钮（`variant="primary" | "secondary" | "plain" | "ghost" | "danger"`）、加载状态按钮（`loading={true}`）。
  - **`bare={true}` 模式（关键核心）**：专供复杂列表项、下拉选项（`role="option"`）、自定义图文卡片布局。在此模式下，组件剥离外层固定 padding 与尺寸样式，保留可访问性、焦点环管理、`:active` 微触感与键盘事件委托。
- **Props 映射转换标准**：
  ```tsx
  // 改造前：裸图标按钮
  <Tooltip content="关闭">
    <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="关闭">
      <AppIcon name="x" size={12} />
    </button>
  </Tooltip>

  // 改造后：IconButton 规范写法（自带内置 Tooltip，消除 DOM 嵌套）
  <IconButton
    variant="ghost"
    size="xs"
    className={styles.closeBtn}
    onClick={onClose}
    aria-label="关闭"
    tooltip="关闭"
    icon={<AppIcon name="x" size={12} />}
  />
  ```

#### (2) `Input` 与 `Textarea` 映射法则
- **`Input`（单行文本输入基元）**：
  - 支持 `variant="search" | "password" | "text" | "default"`；
  - 内置 IME 组合输入锁（`handleCompositionStart`/`End`），防拼音回车误触；
  - `clearable={true}` 自动承载清空按钮与逻辑；
  - 尺寸档位严格对齐 `xs`(24px) / `sm`(28px) / `md`(32px) / `lg`(40px)。
- **`Textarea`（多行文本输入基元）**：
  - 自适应高度使用现代 CSS `field-sizing: content`，杜绝 JavaScript 频繁计算 `scrollHeight` 引发重排回流；
  - 支持 `bare={true}` 模式，专供代码编辑器、内嵌批注等无需外部 wrapper 装饰的纯净编辑舞台。
- **Props 映射转换标准**：
  ```tsx
  // 改造前：裸搜索框
  <input
    type="search"
    className={styles.search}
    placeholder="搜索…"
    value={query}
    onChange={(e) => setQuery(e.target.value)}
  />

  // 改造后：Input 原子组件
  <Input
    variant="search"
    size="sm"
    className={styles.search}
    placeholder="搜索…"
    value={query}
    onChange={(e) => setQuery(e.target.value)}
    clearable
    onClear={() => setQuery('')}
  />
  ```

#### (3) 复选框与选择组件映射法则
- **`<input type="checkbox">`**：应全面替换为 `@/components/ui` 的 `Switch` 原子开关组件（或专用的原子 Checkbox，如果组件库已具备）。`Switch` 组件提供 0ms 乐观响应状态机、发丝微收边（`0 0 0 0.5px`）与 GPU 硬件中轴定位。
- **二元/多模态切换（Tabs / Segment）**：业务层通过两个 `<button>` 拼凑的单选按钮组（如"单栏/分栏"、"仅看变更/完整代码"），映射为标准 `SegmentedControl` 或带有 `bare` 的原子按钮，严禁自行手写伪 Tab。

### 2.2 焦点环与同心几何标尺（§13 & G-04）

所有替换组件必须严格遵守 Conex 设计红线：
1. **焦点环对比度上限（AGENTS.md §13）**：
   - 默认禁止重黑边框（`0 0 0 1px #000`）；
   - 焦点态灰色混入文本色严格控制在 **3%~10%**（例如：`color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)`），保持浅灰柔和、长时间阅读无视疲劳。
2. **零药丸圆角禁令（Rule G-04 Zero-Pill Rule）**：
   - 严禁在按钮上使用 `border-radius: 9999px` 或 `border-radius: full`；
   - 按钮必须严格遵守同心圆角标尺：`--radius-sm` (4px)、`--radius-md` (6px)、`--radius-lg` (8px)。

### 2.3 `Input` 裸核心模式（`bare`）与文件选择器纯净化建议

在分析过程中发现，部分业务存在特殊场景：
1. **隐藏的文件选择器**：如 `BrowserImportSection.tsx` 中的 `<input type="file" ref={...} className={styles.hiddenFileInput} />`。目前 `@/components/ui/Input` 默认会在外层包裹 `<div className={styles.inputWrap}>`，若直接传 `hidden` 或 `style={{ display: 'none' }}`，外层 div 仍可能残留尺寸。
2. **内联无框编辑输入**：如 `EditableTitle.tsx` 中的标题编辑输入框，不需要外层 Shell 和边框背景。
3. **架构改造建议**：
   - 为 `@/components/ui/Input` 扩展支持 `bare?: boolean` 属性（与 `Textarea`、`Button` 的 `bare` 对齐），当 `bare === true` 时，仅渲染核心 `<input>` 元素并透传 IME 守卫与 ref，不渲染外层包装节点与 label/hint。
   - 对文件上传场景，或者调用原生 Tauri 对话框（`@tauri-apps/plugin-dialog`），或者使用 `<Input bare type="file" style={{ display: 'none' }} />`，彻底合规收敛。

### 2.4 `document.createElement` 剪贴板与原生对话框架构解耦方案

静态分析器通过 AST 捕获了 3 处业务代码中调用 `document.createElement` 的情况：
1. `StatusDiagnosticsPanel.tsx` (Line 47) 与 `NotePaperStrictHeader.tsx` (Line 119)：使用 `document.createElement('textarea')` 作为老旧浏览器的 `execCommand('copy')` 兜底。
   - **架构根治方案**：将剪贴板复制逻辑全量统一至项目级工具函数（如 `@/utils/clipboard` 或调用 Tauri 剪贴板插件），业务组件仅调用 `copyText(content)`，禁止在业务视图层动态构造裸 DOM。
2. `SettingsProfileTab.tsx` (Line 81)：使用 `const input = document.createElement('input'); input.type = 'file';` 动态呼出文件导入。
   - **架构根治方案**：在桌面端应当优先使用 Tauri 原生文件选择对话框 `open({ filters: [{ name: 'JSON', extensions: ['json'] }] })`；在 Web 端统一走规范封装的文件选择工具，消除组件内部的裸 DOM 拼装。

---

## 三、9 大业务域 81 文件 156 处违规项逐一详析与改造清单

### 3.1 分域一：工作区与多窗格域（Workspace & Binary Tree）
**涉及文件**：10 个；**违规总数**：19 处。

#### 违规文件与行号分布
1. `apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx`：Line 392 (`<button>` 关闭标签), Line 423 (`<button>` 最大化/恢复)
2. `apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx`：Line 511 (`<button>` 新建对话)
3. `apps/crish-desktop/src/components/binary-tree/PaneTabItem.tsx`：Line 88 (`<button>` 关闭 Tab)
4. `apps/crish-desktop/src/components/binary-tree/SidePanelLauncherHub.tsx`：Line 113 (`<button>` 活动服务卡片), Line 134 (`<button>` 浏览器卡片), Line 153 (`<button>` 文件卡片)
5. `apps/crish-desktop/src/components/binary-tree/SidePanelNavToolbar.tsx`：Line 25 (`<button>` 后退), Line 35 (`<button>` 前进), Line 45 (`<button>` 刷新), Line 57 (`<button>` 外部打开)
6. `apps/crish-desktop/src/components/binary-tree/ToolTabAddButton.tsx`：Line 53 (`<button>` 添加工具面板触发按钮)
7. `apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx`：Line 523 (`<button>` 顶部侧栏快捷展开)
8. `apps/crish-desktop/src/components/workspace/browser-panel/BrowserImportSection.tsx`：Line 69 (`<input type="file">`), Line 119 (`<input type="file">`)
9. `apps/crish-desktop/src/components/workspace/PreviewCard.tsx`：Line 349 (`<button>` 本地端口链接), Line 377 (`<button>` 最近访问网页链接)
10. `apps/crish-desktop/src/components/workspace/TerminalToolbar.tsx`：Line 54 (`<button>` 主分屏切换), Line 66 (`<button>` 副分屏切换)

#### 改造方案与代码对照

##### (1) `LeafToolTabStrip.tsx` (Line 392, 423)
- **分析**：Line 392 为工具栏标签关闭按钮；Line 423 为最大化/还原切换按钮。均为标准正方形图标操作。
- **映射目标**：`IconButton`（`size="xs"`, `variant="ghost"`）。
```diff
--- a/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx
+++ b/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx
@@ -10,2 +10,3 @@
 import { AppIcon } from '../AppIcon';
+import { IconButton } from '../ui';
 
@@ -391,10 +392,8 @@
-                    <Tooltip content={`关闭 ${label}`}>
-                      <button
-                        type="button"
+                    <IconButton
+                        variant="ghost"
+                        size="xs"
                         className={`${styles.tabCloseBtn} tab-item-close-btn`}
                         onClick={(e) => triggerCloseTab(tabId, e)}
                         aria-label={`关闭 ${label}`}
-                      >
-                        <AppIcon name="x" size={10} />
-                      </button>
-                    </Tooltip>
+                        tooltip={`关闭 ${label}`}
+                        icon={<AppIcon name="x" size={10} />}
+                      />
@@ -422,14 +421,11 @@
-              <button
-                type="button"
+              <IconButton
+                variant="ghost"
+                size="sm"
                 className={`${styles.sideBtn} side-panel-btn side-panel-btn-maximize`}
                 onClick={handleToggleMaximize}
                 aria-label={isMaximized ? '恢复面板' : '最大化面板'}
-              >
-                {isMaximized ? (
-                  <AppIcon name="minimize" size={14} />
-                ) : (
-                  <AppIcon name="maximize" size={14} />
-                )}
-              </button>
+                tooltip={isMaximized ? '恢复面板' : '最大化面板'}
+                icon={isMaximized ? <AppIcon name="minimize" size={14} /> : <AppIcon name="maximize" size={14} />}
+              />
```

##### (2) `PaneHeader.tsx` (Line 511) & `PaneTabItem.tsx` (Line 88)
- **分析**：新会话按钮及 Tab 关闭按钮，直接用 `IconButton` 替换。
```diff
--- a/apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx
+++ b/apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx
@@ -511,9 +511,10 @@
-          <button
-            type="button"
+          <IconButton
+            variant="ghost"
+            size="sm"
             className={styles.newTabBtn}
             onClick={handleNewTab}
             aria-label="新对话"
+            tooltip="新对话"
             data-tauri-drag-region="false"
-          >
-            <AppIcon name="plus" size={14} />
-          </button>
+            icon={<AppIcon name="plus" size={14} />}
+          />
```

##### (3) `SidePanelLauncherHub.tsx` (Line 113, 134, 153)
- **分析**：大卡片入口（本地端口、浏览器预览、文件浏览）。内部有复杂 DOM 布局（图标盒、标题、状态指示等）。
- **映射目标**：`<Button bare className={...} onClick={...} data-testid="...">`。
- **效果**：保持原有全部 CSS modules 结构与动画，同时获得标准的键盘可聚焦与 a11y 语义，完全满足 G-01。

##### (4) `SidePanelNavToolbar.tsx` (Line 25, 35, 45, 57)
- **分析**：后退、前进、刷新、外跳浏览器。4 个外包 Tooltip 的裸图标按钮。
- **映射目标**：全部替换为 `IconButton`（`size="sm"`, `variant="ghost"`），内置 tooltip 属性，消除外层 `<Tooltip>` 重叠。

##### (5) `BrowserImportSection.tsx` (Line 69, 119)
- **分析**：书签与 Storage 的隐藏原生文件上传 `<input type="file">`。
- **映射目标**：`<Input bare type="file" ref={...} accept=".json,application/json" className={styles.hiddenFileInput} onChange={...} />`。

##### (6) `PreviewCard.tsx` (Line 349, 377) & `TerminalToolbar.tsx` (Line 54, 66)
- **分析**：纯文字链接按钮与分屏终端分支切换标签。
- **映射目标**：`<Button bare className={styles.pureTextLink} onClick={...}>` 与 `<Button bare className={styles.termBranchItem} onClick={...}>`。

---

### 3.2 分域二：设置、模型与技能域（Settings, Models & Skills）
**涉及文件**：19 个；**违规总数**：38 处。

#### 违规文件与行号分布
1. `apps/crish-desktop/src/components/settings/FontSelectField.tsx`：Line 196 (触发器按钮), Line 231 (搜索框 `<input>`), Line 252 (应用按钮), Line 266 (扫描本地字体), Line 284 (重置默认), Line 322 (预设选项按钮), Line 359 (本机选项按钮)
2. `apps/crish-desktop/src/components/settings/FontSettingsSection.tsx`：Line 222 (代码连字 `<input type="checkbox">`)
3. `apps/crish-desktop/src/components/settings/ImportListSection.tsx`：Line 102 (导入项 `<input type="checkbox">`)
4. `apps/crish-desktop/src/components/settings/RulesEditorDialog.tsx`：Line 71 (规则正文 `<textarea>`)
5. `apps/crish-desktop/src/components/settings/SettingsDevicesNetworkEnv.tsx`：Line 97 (复制 IP `<button>`)
6. `apps/crish-desktop/src/components/settings/SettingsProfileTab.tsx`：Line 81 (`document.createElement('input')`)
7. `apps/crish-desktop/src/components/settings/SettingsQuickMenu.tsx`：Line 237 (底部设置触点按钮), Line 306 (快捷选项按钮)
8. `apps/crish-desktop/src/components/settings/SettingsRulesTab.tsx`：Line 222 (预设规则胶囊按钮)
9. `apps/crish-desktop/src/components/settings/SettingsSchemaRenderer.tsx`：Line 152 (取色器 `<input type="color">`)
10. `apps/crish-desktop/src/components/settings/SettingsSecurityTab.tsx`：Line 230 (展开更多路径), Line 241 (收起路径), Line 368 (添加预设白名单)
11. `apps/crish-desktop/src/components/settings/SettingsSidebar.tsx`：Line 104 (搜索框 `<input>`), Line 121 (清空搜索), Line 165 (侧栏分类 Tab)
12. `apps/crish-desktop/src/components/settings/StatusDiagnosticsPanel.tsx`：Line 47 (`document.createElement('textarea')`)
13. `apps/crish-desktop/src/components/settings/WorkflowForm.tsx`：Line 68 (名称输入), Line 95 (描述文本域), Line 142 (时间输入), Line 173 (间隔分钟输入)
14. `apps/crish-desktop/src/components/settings-models/ModelModalitiesEditor.tsx`：Line 98 (输入模态 Chip), Line 119 (输出模态 Chip)
15. `apps/crish-desktop/src/components/settings-models/ModelPricingEditor.tsx`：Line 60 (CNY 按钮), Line 69 (USD 按钮)
16. `apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.tsx`：Line 179 (上一个匹配项), Line 190 (下一个匹配项), Line 201 (清空搜索)
17. `apps/crish-desktop/src/components/settings-skills/SkillCardList.tsx`：Line 156 (技能列表项按钮)
18. `apps/crish-desktop/src/components/settings-skills/SkillsMoreMenu.tsx`：Line 165 (菜单项操作按钮)
19. `apps/crish-desktop/src/components/SettingsTablist.tsx`：Line 99 (搜索输入框), Line 145 (Tab 项按钮)

#### 改造方案与代码对照

##### (1) `FontSettingsSection.tsx` (Line 222) & `ImportListSection.tsx` (Line 102)
- **分析**：表单中的复选框。直接使用原生 `<input type="checkbox">` 存在操作系统原生控件样式污染，且违反 G-01。
- **映射目标**：`Switch` 组件（`size="sm"`）。
```diff
--- a/apps/crish-desktop/src/components/settings/FontSettingsSection.tsx
+++ b/apps/crish-desktop/src/components/settings/FontSettingsSection.tsx
@@ -10,2 +10,3 @@
 import { FontSelectField } from './FontSelectField';
+import { Switch } from '../ui';
 
@@ -221,8 +222,9 @@
             <label className={styles.settingsRowCheck} aria-label="启用代码连字（liga / calt）">
-              <input
-                type="checkbox"
+              <Switch
+                size="sm"
                 checked={!!prefs.monoLigatures}
                 disabled={busy}
-                onChange={(e) => void apply({ monoLigatures: e.target.checked })}
+                onCheckedChange={(checked) => void apply({ monoLigatures: checked })}
+                aria-label="启用代码连字"
               />
               <span>连字</span>
```

##### (2) `RulesEditorDialog.tsx` (Line 71)
- **分析**：对话框内的规则文本编辑器。
- **映射目标**：`Textarea`（`bare={true}`，保留已有尺寸与滚动条）。
```diff
--- a/apps/crish-desktop/src/components/settings/RulesEditorDialog.tsx
+++ b/apps/crish-desktop/src/components/settings/RulesEditorDialog.tsx
@@ -7,2 +7,3 @@
 import { Dialog, Button } from '../ui';
+import { Textarea } from '../ui';
 
@@ -71,2 +72,3 @@
-      <textarea
+      <Textarea
+        bare
         ref={initialFocusRef}
```

##### (3) `WorkflowForm.tsx` (Line 68, 95, 142, 173)
- **分析**：计划任务表单。在 `settingsVariant` 分支下已经使用了 `Input`，但在普通分支中遗留了 4 个裸标签。
- **映射目标**：统一使用 `Input`（`size="sm"`）与 `Textarea`（`bare={true}` 或 `size="sm"`）。
```diff
--- a/apps/crish-desktop/src/components/settings/WorkflowForm.tsx
+++ b/apps/crish-desktop/src/components/settings/WorkflowForm.tsx
@@ -67,2 +67,3 @@
-        <input
+        <Input
+          size="sm"
           className={styles.schedFieldInput}
           placeholder="例如：每日代码体检"
@@ -94,2 +95,3 @@
-      <textarea
+      <Textarea
+        bare
         className={`${styles.schedFieldInput} ${styles.schedFieldTextarea}`}
@@ -141,2 +143,3 @@
-        <input
+        <Input
+          size="sm"
           className={styles.schedFieldInput}
           type="time"
@@ -172,2 +175,3 @@
-        <input
+        <Input
+          size="sm"
           className={styles.schedFieldInput}
           type="number"
```

##### (4) `YamlConfigEditorModal.tsx` (Line 179, 190, 201)
- **分析**：YAML 搜索栏的前后匹配和清空按钮。
- **映射目标**：`IconButton`（`size="xs"`, `variant="ghost"`）。

##### (5) `FontSelectField.tsx` (7 处违规)
- Line 196 (触发器)：替换为 `<Button bare className={styles.settingsSelectTrigger} ...>`；
- Line 231 (搜索框)：替换为 `<Input variant="text" size="sm" className={styles.searchInput} ... />`；
- Line 252, 266, 284 (操作图标)：替换为 `IconButton`（`size="xs"`）；
- Line 322, 359 (字体选项条目)：替换为 `<Button bare role="option" className={styles.settingsSelectItem} ...>`。

---

### 3.3 分域三：便签与备忘录域（Note Paper & Scratchpad）
**涉及文件**：6 个；**违规总数**：17 处。

#### 违规文件与行号分布
1. `apps/crish-desktop/src/components/note-paper/EditableTitle.tsx`：Line 101 (标题编辑 `<input>`)
2. `apps/crish-desktop/src/components/note-paper/MirrorDriftStatusBar.tsx`：Line 244 (确认丢弃 `<input type="checkbox">`)
3. `apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.tsx`：Line 119 (`document.createElement('textarea')`), Line 184 (下拉展开按钮), Line 207 (新建笔记按钮), Line 226 (下拉选项按钮), Line 306 (单测保全测试桩按钮)
4. `apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.tsx`：Line 80 (新建笔记), Line 91 (关闭侧栏), Line 106 (搜索框), Line 148 (重命名输入), Line 176 (重命名按钮), Line 187 (删除按钮), Line 219 (取消删除), Line 226 (确认删除)
5. `apps/crish-desktop/src/components/note-paper/SendToNoteButton.tsx`：Line 164 (图标态发送按钮)
6. `apps/crish-desktop/src/components/note-paper/SlashMenuOverlayCatalog.tsx`：Line 92 (斜杠菜单条目)

#### 改造方案与代码对照

##### (1) `EditableTitle.tsx` (Line 101)
- **分析**：便签头部可编辑标题，在激活态渲染一个无边框无背景的内联输入框。
- **映射目标**：`<Input bare ref={inputRef} type="text" className={styles.titleInput} ... data-testid="note-paper-strict-title-input" />`。
- **测试保护**：保留 `data-testid="note-paper-strict-title-input"` 与 `onBlur`/`onKeyDown` 行为，无缝通过单测。

##### (2) `NotePaperStrictHeader.tsx` (Line 119, 184, 207, 226, 306)
- **Line 119**：原代码为 `const textarea = document.createElement('textarea');`，重构为直接调用 `navigator.clipboard.writeText` 或抽取为统一 copy 辅助，彻底干掉业务内原生创建。
- **Line 306（核心注意点）**：
  ```tsx
  {/* 斜杠菜单产品入口按钮（保全三大测试桩之一：note-paper-strict-open-slash，零尺寸不可见元素保全单测） */}
  {showOpenSlashButton && (
    <Button
      bare
      style={{ display: 'none' }}
      aria-hidden="true"
      onClick={onOpenSlash}
      aria-label={slashWriteMode === 'readonly' ? '打开斜杠菜单（只读）' : '打开斜杠菜单'}
      data-testid="note-paper-strict-open-slash"
      data-slash-open-trigger="1"
      data-slash-write-mode={slashWriteMode}
    >
      /
    </Button>
  )}
  ```
  通过使用 `<Button bare>` 替换裸 `<button>`，既保全了核心单测 `note-paper-strict-open-slash`，又 100% 消除 G-01 违规。

##### (3) `NoteSidebarDrawer.tsx` (8 处)
- **顶部操作**：Line 80（`+` 按钮）、Line 91（收起按钮）替换为 `IconButton`（`size="sm"`）；
- **搜索与重命名**：Line 106 替换为 `<Input variant="search" size="sm">`；Line 148 替换为 `<Input size="sm">`；
- **行级悬浮操作**：Line 176（重命名）、Line 187（删除）替换为 `IconButton`（`size="xs"`）；
- **删除弹窗**：Line 219（取消）替换为 `<Button variant="secondary" size="sm">`；Line 226（确认删除）替换为 `<Button variant="danger" size="sm">`。

##### (4) `SendToNoteButton.tsx` (Line 164)
- **分析**：该组件普通分支（Line 192）已正确使用 `<Button>`，但 `if (iconOnly)` 分支使用了裸 `<button>`。
- **映射目标**：替换为 `<IconButton variant="ghost" size="sm" ... />`。

---

### 3.4 分域四：文件管理与代码比对域（Files & Diff）
**涉及文件**：11 个；**违规总数**：20 处。

#### 违规文件与行号分布
1. `apps/crish-desktop/src/components/diff/DiffCard.tsx`：Line 274 (行过滤搜索框 `<input>`)
2. `apps/crish-desktop/src/components/diff/DiffCardFileList.tsx`：Line 213 (文件节点展开折叠), Line 237 (文件名打开详情)
3. `apps/crish-desktop/src/components/diff/DiffCardGitActions.tsx`：Line 88 (提交说明输入 `<textarea>`)
4. `apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx`：Line 388 (大文件折叠行展开)
5. `apps/crish-desktop/src/components/files/FileActions.tsx`：Line 143 (Markdown 渲染预览), Line 153 (Markdown 源码模式)
6. `apps/crish-desktop/src/components/files/FileAnnotationPopover.tsx`：Line 250 (代码批注 `<textarea>`), Line 276 (提交批注), Line 287 (关闭批注)
7. `apps/crish-desktop/src/components/files/FileBreadcrumb.tsx`：Line 293 (树节点按钮), Line 363 (面包屑段按钮), Line 389 (弹层过滤 `<input>`), Line 412 (直达打开), Line 430 (过滤结果按钮)
8. `apps/crish-desktop/src/components/files/FileEditor.tsx`：Line 21 (源码编辑区 `<textarea>`)
9. `apps/crish-desktop/src/components/files/FilesCard.tsx`：Line 300 (路径过滤 `<input>`)
10. `apps/crish-desktop/src/components/files/FileViewerCard.tsx`：Line 340 (仅看变更 Tab), Line 351 (完整代码 Tab)
11. `apps/crish-desktop/src/components/files/FileViewerHistoryDrawer.tsx`：Line 175 (复制提交哈希 Badge 按钮)

#### 改造方案与代码对照

##### (1) `DiffCard.tsx` (Line 274) & `FilesCard.tsx` (Line 300)
- **分析**：代码/文件筛选搜索输入框。
- **映射目标**：`<Input variant="search" size="xs" clearable ... />`。
```diff
--- a/apps/crish-desktop/src/components/diff/DiffCard.tsx
+++ b/apps/crish-desktop/src/components/diff/DiffCard.tsx
@@ -10,2 +10,3 @@
 import { AppIcon } from '../AppIcon';
+import { Input } from '../ui';
 
@@ -273,8 +274,8 @@
         <div className={styles.searchRow}>
-          <input
-            type="search"
+          <Input
+            variant="search"
+            size="sm"
             className={styles.searchInput}
             placeholder="搜索/筛选行…"
             value={rawDiffSearchQuery}
             onChange={(e) => setDiffSearchQuery(e.target.value)}
-          />
+            clearable
+            onClear={() => setDiffSearchQuery('')}
+          />
         </div>
```

##### (2) `DiffCardGitActions.tsx` (Line 88) & `FileEditor.tsx` (Line 21)
- **分析**：Git 提交信息多行输入与文件直接编辑多行输入。
- **映射目标**：`<Textarea bare ...>`。
```diff
--- a/apps/crish-desktop/src/components/diff/DiffCardGitActions.tsx
+++ b/apps/crish-desktop/src/components/diff/DiffCardGitActions.tsx
@@ -10,2 +10,3 @@
 import { Button } from '../ui/Button/Button';
+import { Textarea } from '../ui';
 
@@ -87,2 +88,3 @@
       </div>
-      <textarea
+      <Textarea
+        bare
         className={styles.commitInput}
```

##### (3) `FileActions.tsx` (Line 143, 153) & `FileViewerCard.tsx` (Line 340, 351)
- **分析**：视图切换模式按钮组（渲染/源码、仅看变更/完整代码）。
- **映射目标**：既可重构成 `<SegmentedControl>`，也可使用 `<Button bare role="tab" ...>` 保留已有 CSS Modules 样式与属性。

##### (4) `FileAnnotationPopover.tsx` (Line 250, 276, 287)
- **Line 250**：替换为 `<Textarea bare className={styles.nativeTextarea} ...>`；
- **Line 276**：替换为 `<IconButton variant="secondary" size="xs" aria-label="确认添加批注" tooltip="添加 (Enter)" icon={<AppIcon name="corner-down-left" size={12} />} ... />`；
- **Line 287**：替换为 `<IconButton variant="ghost" size="xs" aria-label="取消" tooltip="取消 (Esc)" icon={<AppIcon name="x" size={12} />} ... />`。

---

### 3.5 分域五：侧边栏与会话导航域（Sidebar & Sessions）
**涉及文件**：6 个；**违规总数**：10 处。

#### 违规文件与行号分布
1. `apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx`：Line 111 (单选菜单项 `<button>`)
2. `apps/crish-desktop/src/components/sidebar/SidebarNav.tsx`：Line 25 (新对话按钮), Line 34 (定时任务按钮), Line 51 (会话搜索 `<input>`)
3. `apps/crish-desktop/src/components/sidebar/session-list/GeneralSection.tsx`：Line 60 (对话折叠触点), Line 142 (查看全部展开)
4. `apps/crish-desktop/src/components/sidebar/session-list/PinnedSection.tsx`：Line 43 (置顶折叠触点)
5. `apps/crish-desktop/src/components/sidebar/session-list/ProjectsSection.tsx`：Line 75 (项目折叠触点), Line 189 (查看全部展开)
6. `apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx`：Line 328 (会话重命名 `<input>`)

#### 改造方案与代码对照

##### (1) `SidebarNav.tsx` (Line 25, 34, 51)
- **分析**：侧边栏顶部的新建对话、定时任务导航按钮以及搜索框。
- **映射目标**：按钮使用 `<Button bare>`；搜索框使用 `<Input variant="search" size="sm" clearable>`。
```diff
--- a/apps/crish-desktop/src/components/sidebar/SidebarNav.tsx
+++ b/apps/crish-desktop/src/components/sidebar/SidebarNav.tsx
@@ -5,2 +5,3 @@
 import { AppIcon } from '../AppIcon';
+import { Button, Input } from '../ui';
 
@@ -24,8 +25,7 @@
     <div className={styles.topActions}>
-      <button
-        type="button"
+      <Button
+        bare
         className={styles.navItem}
         data-testid="new-session-button"
         onClick={onNewSession}
-      >
-        <AppIcon name="new-chat" size={16} aria-hidden="true" />
+        icon={<AppIcon name="new-chat" size={16} aria-hidden="true" />}
+      >
         <span>新对话</span>
-      </button>
+      </Button>
@@ -34,8 +34,8 @@
-      <button
-        type="button"
+      <Button
+        bare
         className={`${styles.navItem}${scheduledActive ? ` ${styles.isActive}` : ''}`}
         data-testid="sidebar-nav-scheduled"
         aria-pressed={scheduledActive}
         onClick={onOpenScheduled}
-      >
-        <AppIcon name="clock" size={16} aria-hidden />
+        icon={<AppIcon name="clock" size={16} aria-hidden />}
+      >
         <span>定时任务</span>
-      </button>
+      </Button>
@@ -50,8 +50,9 @@
-          <input
-            type="search"
+          <Input
+            variant="search"
+            size="sm"
             placeholder="搜索会话与消息…"
             aria-label="搜索会话与消息"
             value={searchInput}
             onChange={(e) => onSearchChange(e.target.value)}
+            clearable
           />
```

##### (2) `SessionRow.tsx` (Line 328)
- **分析**：会话重命名输入框。
- **映射目标**：`<Input size="xs" ref={renameInputRef} className={styles.sessionRenameInput} ... />`。

##### (3) `GeneralSection.tsx`, `PinnedSection.tsx`, `ProjectsSection.tsx` 折叠与展开
- **折叠分组标题**：`<Button bare className={styles.sectionLabel} onClick={...} aria-expanded={...}>`；
- **查看全部按钮**：`<Button variant="ghost" size="xs" className={styles.foldToggleBtn} onClick={...}>`。

---

### 3.6 分域六：向导与配置引导域（Wizard & First-Run）
**涉及文件**：3 个；**违规总数**：6 处。

#### 违规文件与行号分布
1. `apps/crish-desktop/src/components/WizardKeyStep.tsx`：Line 65 (服务商名称), Line 83 (Base URL), Line 119 (API Key 密码输入)
2. `apps/crish-desktop/src/components/WizardModelStep.tsx`：Line 77 (自定义模型 ID), Line 93 (直接输入模型 ID)
3. `apps/crish-desktop/src/components/WizardProjectStep.tsx`：Line 74 (项目路径输入)

#### 改造方案与代码对照

##### (1) `WizardKeyStep.tsx` (Line 65, 83, 119)
- **分析**：首次运行向导密钥步骤。已使用 `<Select>`，但表单输入框全为裸 `<input>`。Line 119 是密码类型。
- **映射目标**：`Input` 原子组件（`variant="text"` 与 `variant="password"`，密码框内置明文切换）。
```diff
--- a/apps/crish-desktop/src/components/WizardKeyStep.tsx
+++ b/apps/crish-desktop/src/components/WizardKeyStep.tsx
@@ -5,2 +5,3 @@
 import { Select } from './ui';
+import { Input } from './ui';
 
@@ -62,7 +63,8 @@
-      <label className={styles.firstRunLabel} htmlFor={ids.nameId}>
-        服务商名称
-      </label>
-      <input
+      <Input
         id={ids.nameId}
+        label="服务商名称"
         className={styles.firstRunInput}
         placeholder="例如: 自建网关、公司代理"
         value={name}
         {...inputProps}
         onChange={(e) => onNameChange(e.target.value)}
-        onKeyDown={(e) => {
-          if (e.key === 'Enter' && !busy) {
-            e.preventDefault();
-            onEnter();
-          }
-        }}
+        onEnter={busy ? undefined : onEnter}
       />
@@ -80,7 +82,8 @@
-      <label className={styles.firstRunLabel} htmlFor={ids.baseUrlId}>
-        Base URL
-      </label>
-      <input
+      <Input
         id={ids.baseUrlId}
+        label="Base URL"
         className={styles.firstRunInput}
         placeholder="https://api.example.com/v1"
         value={baseUrl}
         {...inputProps}
         onChange={(e) => onBaseUrlChange(e.target.value)}
-        onKeyDown={(e) => { ... }}
+        onEnter={busy ? undefined : onEnter}
       />
@@ -116,7 +119,8 @@
-      <label className={styles.firstRunLabel} htmlFor={ids.keyId}>
-        API 密钥
-      </label>
-      <input
+      <Input
         id={ids.keyId}
+        label="API 密钥"
         type="password"
+        variant="password"
         className={styles.firstRunInput}
         placeholder="粘贴密钥"
         value={apiKey}
         {...inputProps}
         onChange={(e) => onKeyChange(e.target.value)}
-        onKeyDown={(e) => { ... }}
+        onEnter={busy ? undefined : onEnter}
       />
```

##### (2) `WizardModelStep.tsx` & `WizardProjectStep.tsx`
- 同样使用 `<Input id={ids.modelCustomId} onEnter={...} />` 与 `<Input id={ids.pathId} onEnter={...} />`。

---

### 3.7 分域七：智能体面板与自定义卡片域（Agent Card & Custom Tags）
**涉及文件**：9 个；**违规总数**：18 处。

#### 违规文件与行号分布
1. `apps/crish-desktop/src/components/agent-card/AgentBrowsePad.tsx`：Line 170 (智能体卡片)
2. `apps/crish-desktop/src/components/agent-card/AgentTeamBoard.tsx`：Line 274 (协作团队条目卡片)
3. `apps/crish-desktop/src/components/agent-card/ApprovalNoteField.tsx`：Line 15 (审批补充说明 `<textarea>`)
4. `apps/crish-desktop/src/components/agent-card/InlineAgentPanel.tsx`：Line 186 (标题栏触点), Line 257 (恢复重试), Line 266 (关闭)
5. `apps/crish-desktop/src/components/agent-card/InlineAgentPanelHeader.tsx`：Line 81 (折叠展开头)
6. `apps/crish-desktop/src/components/agent-card/InlineAgentTimeline.tsx`：Line 88 (停止生成), Line 148 (恢复运行), Line 163 (关闭), Line 176 (全部关闭)
7. `apps/crish-desktop/src/components/custom-tags/AiCard.tsx`：Line 106 (错误重试按钮)
8. `apps/crish-desktop/src/components/custom-tags/CustomTagErrorBoundary.tsx`：Line 77 (重试按钮)
9. `apps/crish-desktop/src/components/custom-tags/WidgetDiff.tsx`：Line 108 (单栏比对), Line 115 (分栏比对), Line 125 (复制), Line 137 (采纳), Line 146 (拒绝)

#### 改造方案与代码对照

##### (1) `ApprovalNoteField.tsx` (Line 15)
- **分析**：审批流程中的多行备注输入。
- **映射目标**：`<Textarea bare id={noteId} className={styles.approvalCardInput} ... />`。

##### (2) `InlineAgentTimeline.tsx` (Line 88, 148, 163, 176)
- **分析**：智能体时间线操作栏。
- **映射目标**：
  - Line 88（停止）：`<Button variant="danger" size="xs">停止</Button>`；
  - Line 148（恢复）：`<Button variant="secondary" size="xs">恢复运行</Button>`；
  - Line 163（关闭）：`<Button variant="danger" size="xs">关闭</Button>`；
  - Line 176（全部关闭）：`<Button variant="danger" size="xs">全部关闭</Button>`。

##### (3) `WidgetDiff.tsx` (Line 108, 115, 125, 137, 146)
- **比对模式**：`<Button bare className={...}>` 或 `<SegmentedControl>`；
- **复制**：`<Button variant="secondary" size="xs" onClick={handleCopy}>{copied ? '已复制' : '复制'}</Button>`；
- **采纳**：`<Button variant="primary" size="xs" onClick={handleAccept}>采纳</Button>`；
- **拒绝**：`<Button variant="danger" size="xs" onClick={handleReject}>拒绝</Button>`。

---

### 3.8 分域八：会话流扩展域（Conversation Flow Extension）
**涉及文件**：5 个；**违规总数**：8 处。

#### 违规文件与行号分布
1. `apps/crish-desktop/src/extensions/conversation-flow/ActionRow.tsx`：Line 88 (动作行头部折叠触点), Line 108 (路径导航按钮)
2. `apps/crish-desktop/src/extensions/conversation-flow/ArtifactChip.tsx`：Line 76 (文档产物气泡触点)
3. `apps/crish-desktop/src/extensions/conversation-flow/ArtifactNotebookSurface.tsx`：Line 44 (钉住按钮), Line 56 (编辑按钮), Line 68 (关闭按钮)
4. `apps/crish-desktop/src/extensions/conversation-flow/PurposeBlock.tsx`：Line 57 (意图块折叠头部)
5. `apps/crish-desktop/src/extensions/conversation-flow/ThinkingBlock.tsx`：Line 60 (思考过程折叠头部)

#### 改造方案与代码对照
- **折叠行头（`ActionRow`, `PurposeBlock`, `ThinkingBlock`, `ArtifactChip`）**：
  均使用 `<Button bare className={styles.head} aria-expanded={open} onClick={...}>` 替换裸 `<button>`，完整保留数据属性（`data-flow-action`, `data-flow-purpose` 等，保证与 CSS 选择器及单测无缝对齐）。
- **`ArtifactNotebookSurface.tsx`**：
  三个文本操作按钮（钉住/编辑/关闭）替换为 `<Button variant="plain" size="xs" className={styles.nbBtn} ...>`。

---

### 3.9 分域九：浮层、概览与系统诊断域（Overlay, Overview & Diagnostics）
**涉及文件**：12 个；**违规总数**：20 处。

#### 违规文件与行号分布
1. `apps/crish-desktop/src/components/AppErrorBoundary.tsx`：Line 336 (重新加载按钮)
2. `apps/crish-desktop/src/components/gallery/ComponentGallery.tsx`：Line 180 (Light 主题), Line 187 (Dark 主题)
3. `apps/crish-desktop/src/components/overlay/ToastCard.tsx`：Line 179 (撤销), Line 193 (Action), Line 206 (关闭)
4. `apps/crish-desktop/src/components/overlay/ToastStack.tsx`：Line 57 (撤销), Line 68 (关闭)
5. `apps/crish-desktop/src/components/overview/ActiveTasksSection.tsx`：Line 38 (折叠头)
6. `apps/crish-desktop/src/components/overview/AgentSection.tsx`：Line 37 (折叠头)
7. `apps/crish-desktop/src/components/overview/BackgroundSection.tsx`：Line 27 (折叠头)
8. `apps/crish-desktop/src/components/overview/OverviewChangesList.tsx`：Line 87 (折叠头)
9. `apps/crish-desktop/src/components/overview/ScheduleSection.tsx`：Line 24 (折叠头)
10. `apps/crish-desktop/src/components/overview/UsageSection.tsx`：Line 20 (折叠头)
11. `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx`：Line 192 (搜索 `<input>`), Line 207 (模型管理设置按钮), Line 233 (模型项), Line 257 (高级选项折叠), Line 285 (思考强度胶囊)
12. `apps/crish-desktop/src/dev/DevHealthOverlay.tsx`：Line 105 (刷新指标按钮)

#### 改造方案与代码对照

##### (1) `ToastCard.tsx` (Line 179, 193, 206) & `ToastStack.tsx` (Line 57, 68)
- **撤销**：`<Button variant="secondary" size="xs" onClick={...}>撤销</Button>`；
- **操作**：`<Button variant={toast.action.variant === 'danger' ? 'danger' : 'primary'} size="xs" onClick={...}>`；
- **关闭**：`<IconButton variant="ghost" size="xs" aria-label="关闭通知" icon={<AppIcon name="x" size={13} />} onClick={...} />`。

##### (2) `Overview` 6 个板块折叠头
- 统一替换为 `<Button bare id="..." className={styles.secH} aria-expanded={open} onClick={onToggle}>`。

##### (3) `ModelBadgePickerMenu.tsx` (5 处)
- Line 192（搜索框）：`<Input size="xs" variant="search" placeholder="搜索模型或厂商..." value={keyword} onChange={...} />`；
- Line 207（设置）：`<IconButton variant="ghost" size="xs" aria-label="模型管理" tooltip="模型管理..." icon={<AppIcon name="sliders" size={14} />} onClick={handleOpenSettings} />`；
- Line 233（模型条目）：`<Button bare role="menuitem" data-testid={`model-option-${m.id}`} className={...} onClick={...}>`；
- Line 257（高级折叠）：`<Button bare className={styles.advancedTrigger} aria-expanded={showAdvanced} onClick={...}>`；
- Line 285（思考强度 Pill）：`<Button bare data-testid={`thinking-option-${o.title}`} className={...} onClick={...}>`。

---

## 四、单测防护网与回归风险评估

经过对仓库内 749 个前端测试文件的交叉扫描，确认与上述 81 个组件强绑定的测试套件包括但不限于：
1. **测试桩（Test Stubs）强契约验证**：
   - `NotePaperStrictHeader.test.tsx`：重点断言 `note-paper-strict-open-slash` 与 `note-paper-strict-title-input`。改造时必须严格保留 `data-testid`、`data-slash-*` 属性与事件处理器，确保测试桩 100% 存活。
   - `SidebarNav.test.tsx`：断言 `new-session-button` 与 `sidebar-nav-scheduled`。
   - `PaneHeader.test.tsx` 与 `LeafToolTabStrip.scoped.test.tsx`：断言 Tab 增删和关闭。
2. **样式契约与物理几何门禁**：
   - `style-contract.test.ts` 与 `PhysicalGeometryGuards.test.tsx`：刚性校验 DOM 节点的尺寸与间距。通过使用 `<Button bare>` 与 `<Textarea bare>`，能够保证替换后的外层 DOM 节点不额外增加非预期的 padding 或 margin。
   - `input-three-patterns-guard.test.ts`：刚性守护输入框的三种模式，替换为 `@/components/ui/Input` 正好满足该门禁对于现代焦点环与无死锁输入状态机的所有要求。
3. **冒泡与键盘事件完整性**：
   - 所有改造必须保留 `e.stopPropagation()`、`onKeyDown`、`onBlur`、IME 状态机行为，严禁因组件替换改变原本的键盘导航与失焦提交逻辑。

---

## 五、实施波次规划与分阶段行动清单

为确保 81 个文件 156 处违规项的收敛安全受控、零故障着陆，建议按以下 4 个实施波次有序推进：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        4 阶段收敛推进计划                              │
├─────────┬───────────────────────────────┬──────────────────────────────┤
│ 实施波次│ 覆盖模块与文件域              │ 核心产出与验收标准           │
├─────────┼───────────────────────────────┼──────────────────────────────┤
│ Wave 1  │ 原子基元适配增强与剪贴板解耦  │ Input 支持 bare; clipboard 下│
│         │ (ui/Input, clipboard utils)   │ 沉; 消除 createElement 违规  │
├─────────┼───────────────────────────────┼──────────────────────────────┤
│ Wave 2  │ 工作区、文件与便签核心业务域  │ 27 个文件 / 56 处违规清零;   │
│         │ (binary-tree, files, diff, np)│ 单测套件全绿                 │
├─────────┼───────────────────────────────┼──────────────────────────────┤
│ Wave 3  │ 设置、模型、技能与向导业务域  │ 22 个文件 / 44 处违规清零;   │
│         │ (settings, models, wizard)    │ 表单受控/非受控双模验证      │
├─────────┼───────────────────────────────┼──────────────────────────────┤
│ Wave 4  │ 侧边栏、智能体卡片、扩展流与  │ 32 个文件 / 56 处违规清零;   │
│         │ 全局浮层 (sidebar, flow, misc)│ scripts 门禁 G-01 降为 70(仅 │
│         │                               │ 留 Chat 域)                  │
└─────────┴───────────────────────────────┴──────────────────────────────┘
```

### 验收执行指令
各波次完成后，执行以下命令验收成果：
```bash
# 1. 运行收敛防回潮门禁（断言非 Chat 域 G-01 违规数归零）
node scripts/check-frontend-convergence.mjs

# 2. 运行类型检查
npm run typecheck

# 3. 运行受影响域的单元测试套件
npx vitest run apps/crish-desktop/src/components/binary-tree/
npx vitest run apps/crish-desktop/src/components/settings/
npx vitest run apps/crish-desktop/src/components/note-paper/
npx vitest run apps/crish-desktop/src/components/files/
npx vitest run apps/crish-desktop/src/components/sidebar/
```

---
*报告编制完成 · 遵循 UTF-8 无 BOM 与 Conex 前端收敛规范*
