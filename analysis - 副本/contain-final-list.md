# CSS `contain` 注入位置完整清单

**目标**: 9 → 30+ 处 | **当前**: 37 处 | **日期**: 2026-07-22

---

## 新增注入（Round 4 — A-R4-05，共 13 处）

| # | 文件 | 选择器 | 值 | 行号 |
|---|------|--------|-----|------|
| 1 | `ChatMessageList.module.css` | `.list` | `layout style` | 12 |
| 2 | `AgentCard.module.css` | `.agentCardBody` | `layout style` | 134 |
| 3 | `AgentCard.module.css` | `.agentTeamBoardGrid` | `layout style` | 358 |
| 4 | `SettingsPanel.module.css` | `.coverContent` | `layout style` | 179 |
| 5 | `InlineAgentPanel.module.css` | `.inlineAgentStream` | `layout style` | 259 |
| 6 | `SkillsSettingsTab.module.css` | `.skillsRailList` | `layout style` | 428 |
| 7 | `SkillsSettingsTab.module.css` | `.skillsDetail` | `layout style` | 655 |
| 8 | `ChangeOverviewCard.module.css` | `.changeOverviewList` | `layout style` | 132 |
| 9 | `QuickOpen.module.css` | `.list` | `layout style` | 60 |
| 10 | `ModelsSettingsTab.module.css` | `.mrlList` | `layout style` | 65 |
| 11 | `SettingsUsageTab.module.css` | `.modalList` | `layout style` | 95 |
| 12 | `ChatStatusRibbons.module.css` | `.dynamicPlanList` | `layout style` | 485 |
| 13 | `PreviewCard.module.css` | `.histCol` | `layout style` | 254 |

## 此前已有注入（A-R2-04 及更早，共 24 处）

| # | 文件 | 选择器 | 值 | 行号 |
|---|------|--------|-----|------|
| 14 | `ChatMessageRow.module.css` | — | `layout style` | 16 |
| 15 | `ChatMessageRow.module.css` | — | `layout style` | 447 |
| 16 | `ChatToolCallBlock.module.css` | — | `layout style` | 26 |
| 17 | `ChatToolCallBlock.module.css` | — | `none` | 44 |
| 18 | `ChatToolCallBlock.module.css` | — | `none` | 52 |
| 19 | `ChatToolCallBlock.module.css` | — | `content` | 201 |
| 20 | `DiffCard.module.css` | — | `layout` | 13 |
| 21 | `FilesCard.module.css` | — | `layout` | 13 |
| 22 | `OverviewCard.module.css` | — | `layout style` | 462 |
| 23 | `RuntimePanel.module.css` | — | `layout` | 14 |
| 24 | `Sidebar.module.css` | — | `layout paint style` | 15 |
| 25 | `TerminalCard.module.css` | — | `layout style` | 12 |
| 26 | `Workspace.module.css` | — | `layout style` | 96 |
| 27 | `SidebarSessionList.module.css` | — | `layout style` | 29 |
| 28 | `SidebarSessionList.module.css` | — | `content` | 39 |
| 29 | `chat.css` | — | `layout style` | 151 |
| 30 | `shell-dragdrop.css` | — | `strict` | 164 |
| 31 | `shell-dragdrop.css` | — | `layout style` | 170 |
| 32 | `shell-dragdrop.css` | — | `layout style` | 173 |
| 33 | `shell-dragdrop.css` | — | `layout style` | 176 |
| 34 | `shell-dragdrop.css` | — | `layout style` | 179 |
| 35 | `shell-dragdrop.css` | — | `layout` | 182 |
| 36 | `shell-dragdrop.css` | — | `strict` | 191 |
| 37 | `shell-workspace.css` | — | `layout style` | 1188 |

---

## 覆盖分类

- **虚拟列表 / 聊天消息**: ChatMessageList, ChatMessageRow, AgentCardBody
- **工具调用区域**: ChatToolCallBlock, InlineAgentStream, thinkingFoldBody
- **文件列表**: FilesCard, ChangeOverviewList
- **设置面板选项卡**: SettingsPanel, SkillsSettingsTab, ModelsSettingsTab, SettingsUsageTab
- **Sidebar / 导航**: Sidebar, SidebarSessionList, QuickOpen
- **面板容器**: RuntimePanel, TerminalCard, Workspace
- **拖拽**: shell-dragdrop
- **其他**: DiffCard, OverviewCard, PreviewCard, ChatStatusRibbons, chat.css

## 使用的 contain 值分布

| 值 | 出现次数 |
|----|---------|
| `layout style` | 26 |
| `layout` | 4 |
| `strict` | 2 |
| `none` | 2 |
| `content` | 2 |
| `layout paint style` | 1 |
