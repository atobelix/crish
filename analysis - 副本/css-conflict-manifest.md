# CSS 冲突清单 — Round 5

## 冲突类名：`.card-header`

**全局 CSS 位置**：
- `shell-workspace.css:800-821` — 结构定义，8 个 `!important` 声明
- `shell-polish.css:350-365` — 密度/间隙覆写
- `shell-polish.css:565-566` — 子元素排版
- `shell-polish.css:594-597` — hairline 边框

**Module CSS 位置**：无（CardPanel.tsx 直接使用全局 className="card-header"）

**冲突类型**：跨文件全局覆写 + `!important` 滥用

**!important 计数**：8 处（height, min-height, max-height, align-items, padding-top, padding-bottom, padding-left, padding-right）

**建议修复策略**：增加选择器特异性（`.workspace-card .card-header`），移除所有 `!important`

---

## 冲突类名：`.card-tab`

**全局 CSS 位置**：
- `shell-workspace.css:886-1024` — 结构定义 + 70+ 行状态样式
- `shell-dragdrop.css:114` — 拖拽幽灵状态
- `shell-polish.css:868` — focus-visible

**Module CSS 位置**：无（CardPanel.tsx 直接使用全局 className="card-tab"）

**冲突类型**：跨文件全局样式扩散

**建议修复策略**：统一在 shell-workspace.css 管理，增加选择器特异性

---

## 冲突类名：`.card-body`

**全局 CSS 位置**：
- `shell-workspace.css:1192-1211` — 结构定义（flex:1, overflow, bg）
- `shell-polish.css:342-348` — flat-layout 覆写

**Module CSS 位置**：无（CardPanel.tsx 直接使用全局 className="card-body"）

**冲突类型**：跨文件全局覆写

**建议修复策略**：合并到 shell-workspace.css，增加选择器特异性

---

## 冲突类名：`.tabs-bar`

**全局 CSS 位置**：
- `shell-workspace.css:857-882` — 结构定义
- `shell-dragdrop.css:100` — placeholder indicator

**Module CSS 位置**：无（CardPanel.tsx 直接使用全局 className="tabs-bar"）

**冲突类型**：跨文件全局样式扩散

**建议修复策略**：增加选择器特异性，移除 scrollbar 重复声明

---

## 冲突类名：`.sidebar`

**全局 CSS 位置**：
- `shell-sidebar.css:2-15` — 结构定义（死代码，Sidebar 组件使用 CSS Module 哈希名）
- `shell-sidebar.css:17-28` — collapsed 状态 + resizing 全局规则
- `shell-polish.css:577-579` — hairline 边框
- `shell-polish.css:604-605` — collapsed.temp-expanded

**Module CSS 位置**：`Sidebar.module.css:1-16` — 主样式（已哈希）
- `Sidebar.module.css:25-27` — `.collapsed`
- `Sidebar.module.css:31-35` — `.tempExpanded`

**冲突类型**：全局 vs Module 重复定义（全局 `.sidebar` 选择器不再匹配任何元素）

**建议修复策略**：删除全局 `shell-sidebar.css` 中的 `.sidebar` 死代码，将 `shell-polish.css` 中的 `.sidebar` 替换为 `.crish-sidebar`

---

## 冲突类名：`.workspace-canvas`

**全局 CSS 位置**：
- `shell-workspace.css:263-274` — 结构定义（2 处 `!important`）
- `shell-dragdrop.css:183` — is-layout-frozen

**Module CSS 位置**：`Workspace.module.css:78-84` — `.canvas`（语义同行但名称不同）

**冲突类型**：命名不一致（`.workspace-canvas` vs `.canvas`）

**建议修复策略**：Module CSS 使用 `:global(.workspace-canvas)` 或统一命名

---

## 冲突类名：`.workspace-column`

**全局 CSS 位置**：
- `shell-workspace.css:265-266` — 结构定义（`!important`）
- `shell-workspace.css:284-286` — 末列卡片边框
- `shell-polish.css:374-376` — 列间边框
- `shell-dragdrop.css:186` — is-layout-frozen

**Module CSS 位置**：`Workspace.module.css:86-100` — `.column`（语义同行但名称不同）

**冲突类型**：命名不一致（`.workspace-column` vs `.column`）

**建议修复策略**：Module CSS 通过 `:global(.workspace-column)` 引用

---

## `!important` 统计

### Wave 1 基线（Round 5 前）

| 文件 | !important 计数 |
|------|----------------|
| shell-workspace.css | 132 |
| shell-polish.css | 146 |
| shell-dragdrop.css | 23 |
| shell-layout.css | 16 |
| shell-sidebar.css | 6 |
| shell-menus.css | 5 |
| shell-scrollbar.css | 3 |
| chat.css | 10 |
| theme-dark.css | 6 |
| tokens.css | 11 |
| reduced-motion.css | 27 |
| settings-base.css | 24 |
| settings-models.css | 21 |
| settings-advanced.css | 7 |
| settings-plugins.css | 7 |
| chat-markdown.css | 6 |
| **总计** | **~450** |

### Wave 2（Round 5 后 — 修复后）

| 文件 | !important 计数 | 变化 |
|------|----------------|------|
| shell-workspace.css | 111 | **-21**（.card-header 8 处 + .card-tab 6 处 + .card-header-right/left/tabs-bar 等） |
| shell-polish.css | 146 | 无变化（hairline 系统特意保留 `!important`） |
| shell-dragdrop.css | 20 | **-3**（移除 .sidebar.collapsed 死代码） |
| shell-layout.css | 16 | 无变化 |
| shell-sidebar.css | 5 | **-1**（移除 .sidebar.collapsed 死代码）|
| shell-menus.css | 5 | 无变化 |
| shell-scrollbar.css | 3 | 无变化 |
| chat.css | 10 | 无变化 |
| theme-dark.css | 6 | 无变化 |
| tokens.css | 11 | 无变化 |
| reduced-motion.css | 27 | 无变化 |
| settings-base.css | 24 | 无变化 |
| settings-models.css | 21 | 无变化 |
| settings-advanced.css | 7 | 无变化 |
| settings-plugins.css | 7 | 无变化 |
| chat-markdown.css | 6 | 无变化 |
| **总计** | **425** | **-25** |

### 修复摘要

| 修复项 | 文件 | 操作 |
|--------|------|------|
| `.card-header` `!important` 消除 | shell-workspace.css | 选择器改为 `.workspace-card .card-header`，移除 8 处 `!important` |
| `.card-header` 跨文件冲突 | shell-polish.css | 选择器统一为 `.workspace-card .card-header` |
| `.card-tab` `!important` 消除 | shell-workspace.css | 选择器改为 `.workspace-card .card-tab`，移除 6 处 `!important` |
| `.card-tab` 拖拽幽灵基础样式 | shell-dragdrop.css | 添加裸 `.card-tab` 基础定义（拖拽覆盖层不在 `.workspace-card` 内） |
| `.card-body` 跨文件合并 | shell-workspace.css + shell-polish.css | 选择器改为 `.workspace-card .card-body`，合并 flat-layout 规则 |
| `.tabs-bar` 选择器增强 | shell-workspace.css | 选择器改为 `.workspace-card .tabs-bar` |
| `.sidebar` 死代码清理 | shell-sidebar.css | 移除 `.sidebar` / `.sidebar.collapsed`（CSS Module 已接管） |
| `.sidebar` 全局选择器清理 | shell-dragdrop.css | 移除 `.sidebar.collapsed` / `.temp-expanded` 死代码 |
| `.sidebar` 引用更新 | shell-polish.css | `.sidebar, .crish-sidebar` → `.crish-sidebar` 单独 |
| `.card-header-right/left` | shell-workspace.css | 选择器改为 `.workspace-card .card-header-right/left`，移除 `!important` |
| `.card-action-btn` | shell-workspace.css | 选择器改为 `.workspace-card .card-action-btn` |
| `.card-subheader` | shell-workspace.css | 选择器改为 `.workspace-card .card-subheader` |
| `.tab-close-btn svg` | shell-workspace.css | 选择器改为 `.workspace-card .tab-close-btn svg`，移除 `!important` |
