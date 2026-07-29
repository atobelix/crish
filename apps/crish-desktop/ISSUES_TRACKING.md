# 当前问题跟踪与修复计划

> 建立时间：2026-07-27
> 最近更新：2026-07-27
> 目的：避免连续对话压缩后丢失任务上下文，逐项修复用户提出的交互与布局问题。

---

## 问题清单

### P0 - 致命/阻断

1. **左侧对话列表点击无反应** ✅
   - 现象：点击左侧会话项，主对话区不切换到对应会话。
   - 修复：在 `useTreePanelEvents.ts` 中监听 `open-chat` 事件并调用 `focusOrOpenTreePanel('chat')`。
   - 验收：点击任意会话项，顶部标签与主对话区立即切换到该会话。

2. **新建对话在左侧列表点击无法进入** ✅
   - 现象：新建对话后，左侧列表出现对应项，但点击无法进入。
   - 修复：在 `GeneralSection.tsx` / `ProjectsSection.tsx` 的「新建对话」按钮点击时触发 `emitUiEvent('open-chat')`。
   - 验收：新建对话产生的会话项可被点击并激活。

### P1 - 核心交互

3. **模型选择列表无法点击** ✅
   - 现象：模型下拉列表展开后，选项点击无响应。
   - 修复：重构 `ModelBadgePickerMenu`，直接使用 Radix Popover 并修复事件绑定。
   - 验收：点击模型选项后，当前会话模型切换，下拉关闭。

4. **主对话界面模型选择无响应** ✅
   - 现象：点击主对话区模型选择器，没有任何反应。
   - 修复：同 #3。
   - 验收：点击后应弹出模型选择面板/下拉。

5. **顶部标签拖拽排序 / 拖拽分屏失效** ⏳
   - 现象：对话标签和功能标签都无法拖拽排序，也无法拖拽到另一侧分屏。
   - 验收：
     - 同域标签可拖拽排序。
     - 对话标签可拖拽到新的对话叶片分屏。
     - 功能标签可在功能域内拖拽排序 / 分屏。
   - 技术方案：
     - 顶部会话标签：拖拽排序通过调整 `workspaceChromeTabs` 中 `OPEN_SESSION_TABS_KEY` 的顺序实现。
     - 顶部功能标签：拖拽排序/分屏复用 `layoutTreeStore` 的 `setDraggedSource` + `commitDrop` 机制；每个功能 tab 视为一个可拖拽的 tab 源，目标为其它功能 leaf 或自身 leaf（同 leaf 重排）。
     - 对话标签分屏：会话标签拖拽到对话域空白处时，在对应会话上 split 出新对话 leaf（该 leaf 的 panelId 仍为 `chat`，但需记录当前会话 id 以便后续激活）。

### P1 - 标签管理

6. **关闭顶部对话标签后无标签时未显示新建对话界面** ✅
   - 现象：关闭所有对话标签后，主区域空白或停留在非预期状态。
   - 修复：`onCloseSession` 中关闭当前活动标签且无后备时调用 `enterDraftMode(folder)`。
   - 验收：关闭最后一个对话标签后，自动进入新建对话界面（pending draft）。

7. **关闭标签后顶部标签回溯历史打开标签** 🔧 进行中
   - 现象：关闭标签后，系统重新打开之前关闭的标签。
   - 根因：`workspaceChromeHooks.ts` 的 `selectWorkspace` 在工作区切换时存在自动播种逻辑，会把该工作区下最近 6 条会话重新打开。
   - 修复：移除 `selectWorkspace` 中的自动播种逻辑；仅在用户显式点击会话/新建对话时打开标签。
   - 验收：关闭标签后，只激活剩余已打开标签中的下一个，不应重新加载历史标签。

### P1 - 布局联动

8. **顶部标签行宽度未与对应面板绑定** 🔧 进行中
   - 现象：
     - 右侧功能标签行宽度应与右侧面板宽度一致。
     - 主对话区标签行宽度应与对话面板宽度一致。
     - 点击右侧面板折叠/展开按钮时，顶部功能区标签行应同步关闭/展开。
   - 技术方案（系统化，不补丁）：
     1. 在 `layoutTreeStore` 中新增 `toolColumnCollapsed: boolean` 状态并持久化。
     2. 修改 `operations.ts` 的 `flattenTree`，支持 `collapsedDomain?: 'chat' | 'tool'` 参数；折叠域的 leaf/branch rect 压缩为 0，非折叠域扩展至全宽/全高。
     3. `BinaryTreeWorkspace` 读取 `toolColumnCollapsed` 并使用带折叠参数的 `flattenTree` 渲染。
     4. `UnifiedTopBar` 读取 `toolColumnCollapsed`：折叠时功能域宽度为 0，对话域宽度为 1；展开时按 leaf rect 动态计算。
     5. `UnifiedTopBar` 中面板分类由 `activeTab` 改为 `panelId`，避免 chat leaf 的 activeTab 被误分类。
     6. `useRightSidebarState` 在二叉树工作区激活时，改为操作 `layoutTreeStore.toggleToolColumnCollapsed`；旧 columns 工作区保持原逻辑。
   - 验收：
     - 顶部左右两域宽度分别跟随下方面板宽度。
     - 右侧面板折叠时，顶部功能标签行隐藏。
     - 右侧面板展开时，顶部功能标签行显示且宽度一致。

### P2 - 细节优化

9. **左侧 more 按钮面板应智能退避** ✅
   - 现象：点击会话项 more 按钮，展开面板占满整列，且位于底部的 more 按钮会被面板遮挡。
   - 修复：优化 `syntheticContextMenuEvent`，使用 `right-center` 锚点并增加边界翻转。
   - 验收：面板在 more 按钮周围展开，不覆盖按钮本身；靠近底部时自动向上翻转。

---

## 新发现：对话消息未渲染（空界面）

- 现象：部分已输入过的对话点开后显示「没有对话」的界面；即使响应失败也应保留消息流。
- 待排查方向：
  1. `useChatCardState` 中 `messages` 取自 `sessionsById[activeSessionId]?.messages`，若索引或 `hydratedFromEngine` 状态异常，会导致空界面。
  2. `useChatEmptyKind` 中 `messagesLoading` 逻辑：当 `hydratedFromEngine === false && messages.length === 0` 时会进入 loading/null，3s 超时后显示 session-empty。
  3. 若消息实际存在但 `sessionsById` 未同步或 activeSessionId 与 messages 不同步，也会出现空界面。
- 下一步：通过 CDP 实测确认 store 状态后修复。

---

## 新对话界面状态规则（需明确并落实）

- 新对话界面只有 **一个** 统一界面。
- 该界面承载三类状态：
  1. **项目选择**：决定草稿/首条消息归属哪个 folder。
  2. **模型选择/权限**：决定使用哪个模型及是否有权限。
  3. **输入框保存**：仅当用户真正发送消息时才持久化为真实会话；切换界面时保存已输入的草稿文本。
- 左侧列表中的多个“新建对话”入口（如不同项目下的 +）点击后，只改变对应的项目选择状态，不创建新会话。
- 技术落地：
  - `enterDraftMode(folder)` 只切换 `activeSessionId` 到 pending draft 并设置 `draftFolder`。
  - 真会话在首条用户消息发送时由 `useChatComposerProps` / `handleSendChat` commit。
  - 项目选择仅修改 draft folder，不 mint 新会话 id。

---

## 修复顺序

1. ✅ 修复 P0：左侧列表点击无反应、新建对话进入问题。
2. ✅ 修复模型选择相关（#3、#4）。
3. ✅ 修复标签关闭后进入新建对话（#6）。
4. ✅ 修复 more 面板定位（#9）。
5. 🔧 修复标签回溯（#7）+ 实现顶部标签行与面板宽度绑定（#8）。
6. ⏳ 实现拖拽排序/分屏（#5）。
7. ⏳ 修复对话消息空界面问题。
8. ⏳ 梳理新对话状态规则并写入代码注释/ADR（#附加）。

---

## 测试要求

每修复一项，需在真实 Tauri 界面通过 CDP / Playwright 脚本验证：
- 元素可见且可点击。
- Store 状态变化符合预期。
- 截图对比无布局错乱。
