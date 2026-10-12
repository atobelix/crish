# 维度 02：定址化 UI 事件总线与跨组件通信隔离实现报告

> **所属战役**：[`docs/multi-pane-isolation/`](../00-总方案.md)  
> **实现维度**：维度 02（定址化 UI 事件总线与跨组件通信隔离）  
> **负责规范**：[`00-DISCIPLINE.md`](../00-DISCIPLINE.md)、[`02-定址化UI事件总线与跨组件通信隔离方案.md`](../02-定址化UI事件总线与跨组件通信隔离方案.md)、[`review-01-architecture-and-deletion-audit.md`](../plan-reviews/review-01-architecture-and-deletion-audit.md)  
> **执行状态**：✅ **已全部完成并验证通过**

---

## 一、 架构改造概述与实施范围

本维度全面消除了单窗口时代的「无寻址全局广播（Unscoped Global Broadcast）」与「跨分屏状态串扰（Cross-Pane State Pollution）」，在 `uiEvents.ts` 与 `useLeafUiEvent.ts` 网关层建立统一的作用域寻址协议，严格落实「构造即隔离（By-Construction Isolation）」架构原则：

1. **定址化协议与类型契约（`UiEventScopeTarget`）**：
   - 在 `uiEvents.ts` 中定义了标准的作用域寻址载荷 `UiEventScopeTarget`（`{ sessionId?: string; leafId?: string }`）；
   - 将子窗口级事件（`open-project-picker`, `open-scheduled`, `open-chat`, `open-overview`, `open-tasks`, `toggle-msg-filter`, `clear-current-session`, `export-session-md`, `open-conversation-rewind`, `focus-composer`, `stop-generation`, `toggle-right-panel`）扩展为 `void | UiEventScopeTarget` 可选定址载荷，既保持无参快捷键调用 100% 向后兼容，又支持精确作用域定址；
   - 业务载荷事件（`open-agent-panel`, `open-tool-panel`, `thinking-title-changed`, `retract-backfill`, `retry-failed-turn`）支持可选 `sessionId` 与 `leafId` 定址。

2. **作用域网关与自动路由（`shouldConsumeScopedEvent` & `onScopedUiEvent` & `useLeafUiEvent`）**：
   - 携带 `leafId` 优先精准匹配当前叶子；
   - 携带 `sessionId` 严格精准匹配当前分屏绑定的会话，阻断跨窗误操作；
   - 无参广播事件（快捷键/顶栏菜单）通过 `isActive` 判定，严格仅由当前激活焦点分屏消费；
   - 支持 Guard-1 契约护栏：未包裹 Provider 时的单窗/单元测试环境自动回退 `activeSessionId`，裸测试环境安全放行。

3. **业务组件全面切换定址化订阅**：
   - `useChatHandlers.ts`：将 `retract-backfill`、`retry-failed-turn`、`export-session-md`、`open-conversation-rewind`、`clear-current-session`、`toggle-msg-filter` 切换至 `getScopeTarget`（提供最新 `{ sessionId, leafId, isActive }`）；修复 C-03：`handleViewPlan` 显式透传 `openSidePanel('files', sid)`；
   - `useChatProjectPicker.ts`：全量切换为 `onScopedUiEvent`；修复 D-02：`focus-composer` 优先在当前分屏容器（`leafRootRef` / `queryWithinLeaf`）内查找 `.tiptap[contenteditable="true"], textarea.chat-input, [contenteditable="true"]` 精准聚焦；
   - `useChatSessionActions.ts`：统一接入 `useLeafScope()` 与 `getScopeTarget`；`openPathInFilesPanel` 派发 `crish-open-file` 携带 `{ path, sessionId, leafId }`；
   - `AiCommandSlashExtension.ts`：从 DOM `closest` 提取当前编辑器所在的 `{ sessionId, leafId }` 目标，清退无人监听的 `crish:chat-*` 悬空死事件，接入定址命令；
   - `MarkdownDocumentView.tsx`：仅对非外链本地路径触发 `crish-open-file`，并自动注入 DOM/Scope 的 `{ leafId, sessionId }`；
   - `useTreePanelEvents.ts`：`open-tool-panel`、`toggle-right-panel`、`open-agent-panel`、`open-overview`、`open-tasks`、`open-chat`、`crish-open-file`、`crish-open-terminal` 全量支持 `leafId` 优先、`sessionId` 次之的精准定址路由。

---

## 二、 审计缺陷清退与不变量对账记录

| 缺陷编号        | 涉及文件与事件                                                                                                                     | 根因与原故障                                                       | 实施的天然隔离机制                                                                                                                              |      验证状态       |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- | :-----------------: |
| **B-01 (A-04)** | `useChatHandlers.ts`<br>`'retract-backfill'`                                                                                       | 分屏 A 撤回时向全局广播，分屏 B 收到后覆盖自身输入框草稿           | `onScopedUiEvent('retract-backfill', ..., getScopeTarget)`，仅 `detail.sessionId === target.sessionId` 放行                                     |  ✅ 单元测试已覆盖  |
| **B-02 (A-05)** | `useChatHandlers.ts`<br>`'retry-failed-turn'`                                                                                      | 点击一次重试，所有挂载的 ChatCard 同时发起 N 次并发重试            | `onScopedUiEvent('retry-failed-turn', ..., getScopeTarget)`，仅目标 `sessionId` 响应重跑                                                        |  ✅ 单元测试已覆盖  |
| **B-03**        | `useChatProjectPicker.ts`<br>`'toggle-msg-filter'`<br>`'open-project-picker'`                                                      | 全局广播导致所有分屏同时弹窗与搜索框                               | 接入 `onScopedUiEvent`，无参广播仅 `isActive === true` 的焦点分屏响应                                                                           |  ✅ 单元测试已覆盖  |
| **B-04**        | `useChatHandlers.ts`<br>`useChatSessionActions.ts`<br>`'export-session-md'`<br>`'open-conversation-rewind'`<br>`'stop-generation'` | 快捷键或菜单触发导致双分屏同时导出、同时回溯预览或误杀停止         | 统一使用 `onScopedUiEvent` + `getScopeTarget` 过滤；快捷键仅激活分屏消费，定址调用仅目标分屏消费                                                |  ✅ 单元测试已覆盖  |
| **B-05 / C-03** | `useChatHandlers.ts:handleViewPlan`<br>`useChatSessionActions.ts`<br>`'crish-open-file'`                                           | 查看计划或点击文件跳到全局焦点分屏，无 `sessionId`/`leafId` 作用域 | `handleViewPlan` 显式透传 `openSidePanel('files', sid)`；`crish-open-file` detail 携带 `{ sessionId, leafId }`                                  |  ✅ 单元测试已覆盖  |
| **B-09**        | `AiCommandSlashExtension.ts`                                                                                                       | 派发悬空死事件 `crish:chat-clear / stop / compact / open-settings` | 废除死事件；`/clear` 与 `/stop` 动态提取 `{ sessionId, leafId }` 定址派发标准 UI 事件；`/compact` 插入指令文本；`/settings` 调 `openSettings()` | ✅ 类型与逻辑已闭合 |
| **D-02**        | `useChatProjectPicker.ts`<br>`'focus-composer'`                                                                                    | 全局 `document.querySelector` 永远命中第一个左分屏且不支持 Tiptap  | 改用 `leafRootRef.current` 与 `queryWithinLeaf` 容器级查询富文本及标准输入框                                                                    |  ✅ 单元测试已覆盖  |

---

## 三、 修改文件清单与改动点

| 文件路径                                                                                   | 架构职责                 | 关键改动点说明                                                                                                                                                                                                                                                           |
| :----------------------------------------------------------------------------------------- | :----------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/crish-desktop/src/api/uiEvents.ts`                                                   | UI 事件总线契约          | 导出 `UiEventScopeTarget`；将 12 个子窗口事件载荷升级为 `void \| UiEventScopeTarget`；为业务事件增加定址字段；导出 `dispatchUiEvent` 别名。                                                                                                                              |
| `apps/crish-desktop/src/hooks/useLeafUiEvent.ts`                                           | 作用域事件订阅 Hook      | 实现 `onScopedUiEvent` 与 `useLeafUiEvent`；落实 Guard-1 契约回退；动态通过 `getTarget()` 判定作用域。                                                                                                                                                                   |
| `apps/crish-desktop/src/components/chat-card/useChatHandlers.ts`                           | 聊天处理 Hook            | 引入 `scopeRef` 与 `getScopeTarget`；所有生命周期与交互事件（`retract-backfill`, `retry-failed-turn`, `toggle-msg-filter`, `clear-current-session`, `export-session-md`, `open-conversation-rewind`）改用定址订阅；`handleViewPlan` 传入 `openSidePanel('files', sid)`。 |
| `apps/crish-desktop/src/components/chat-card/useChatProjectPicker.ts`                      | 项目选择器与过滤器 Hook  | 接入 `onScopedUiEvent` 订阅 `open-project-picker`、`toggle-msg-filter`、`focus-composer`、`open-scheduled`、`open-chat`；`focus-composer` 支持容器级 Tiptap 富文本输入框聚焦。                                                                                           |
| `apps/crish-desktop/src/components/chat-card/useChatSessionActions.ts`                     | 会话动作组合 Hook        | 接入 `useLeafScope()` 与 `getScopeTarget`；`openPathInFilesPanel` 派发 `crish-open-file` 时注入 `leafId` 与 `sessionId`；生命周期事件统一走 `onScopedUiEvent`。                                                                                                          |
| `apps/crish-desktop/src/components/chat-composer/AiCommandSlashExtension.ts`               | 斜杠命令扩展             | 通过 `extractEditorScopeTarget` 提取当前编辑器所在的 `{ sessionId, leafId }`；清退悬空 `crish:*` 死事件并派发定址事件。                                                                                                                                                  |
| `apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx`                      | Markdown 渲染视图        | 拦截 `.md-path-link` 时增加 `!isExternalNavigableHref(cleanPath)` 外部链接安全守卫；派发 `crish-open-file` 时透传当前所属分屏的 `leafId` 与 `sessionId`。                                                                                                                |
| `apps/crish-desktop/src/hooks/useTreePanelEvents.ts`                                       | 面板事件桥接 Hook        | 集中路由函数 `openToolRouted` 优先支持 `leafId` 与 `sessionId` 定址；`open-chat` 事件支持按 `leafId` 激活对应标签并聚焦。                                                                                                                                                |
| `apps/crish-desktop/src/components/chat-card/__tests__/useChatHandlers.isolation.test.tsx` | 隔离契约单元测试（新建） | 新增 6 个多子窗口天然隔离完整测试用例，覆盖 A-04、A-05、B-03、B-04、C-03、D-02。                                                                                                                                                                                         |

---

## 四、 自动化测试与验证记录

### 4.1 Vitest 单元测试结果

运行命令：

```pwsh
npx vitest run apps/crish-desktop/src/hooks/__tests__/useLeafUiEvent.test.tsx apps/crish-desktop/src/components/chat-card/__tests__/useChatHandlers.isolation.test.tsx
```

测试执行结果：

```text
 RUN  v3.2.7 C:/Software/conex

 ✓  unit  apps/crish-desktop/src/hooks/__tests__/useLeafUiEvent.test.tsx (14 tests) 48ms
 ✓  unit  apps/crish-desktop/src/components/chat-card/__tests__/useChatHandlers.isolation.test.tsx (6 tests) 58ms

 Test Files  2 passed (2)
      Tests  20 passed (20)
   Start at  23:49:39
   Duration  2.87s
```

覆盖的核心断言场景：

1. **携带 `sessionId` 定址**：`retract-backfill` 仅命中目标会话，邻屏输入框草稿零覆盖；`retry-failed-turn` 仅目标会话重试，无并发多发；`thinking-title-changed` 仅目标会话更新；
2. **携带 `leafId` 定址**：`open-tool-panel`、`toggle-right-panel`、`stop-generation` 携带 `leafId` 时精准路由至指定叶子，后台叶亦能正确接收；
3. **无参快捷键广播**：`toggle-msg-filter`、`open-project-picker`、`export-session-md`、`open-conversation-rewind` 严格仅由 `isActive === true` 的焦点分屏消费；
4. **C-03 抽屉打开**：后台分屏 B 调用 `handleViewPlan` 严格传入 `openSidePanel('files', 'session-b')`；
5. **D-02 容器级输入框聚焦**：在激活分屏 B 派发 `focus-composer` 时，精准通过 `rootRef` 查找到分屏 B 内的 `.tiptap[contenteditable="true"]` 并执行 `.focus()`，绝不命中左分屏 A。

### 4.2 行数预算门禁检查（RL-03 Line Budget Verification）

运行命令：

```pwsh
node scripts/check-line-counts.mjs apps/crish-desktop/src/api/uiEvents.ts apps/crish-desktop/src/hooks/useLeafUiEvent.ts apps/crish-desktop/src/components/chat-card/useChatHandlers.ts apps/crish-desktop/src/components/chat-card/useChatProjectPicker.ts apps/crish-desktop/src/components/chat-card/useChatSessionActions.ts apps/crish-desktop/src/components/chat-composer/AiCommandSlashExtension.ts apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx apps/crish-desktop/src/hooks/useTreePanelEvents.ts
```

输出：

```text
[check-line-counts] Starting RL-03 Line Budget Verification...
  ✅ [PASS] apps/crish-desktop/src/api/uiEvents.ts (Business Logic: 214/400 lines)
  ✅ [PASS] apps/crish-desktop/src/hooks/useLeafUiEvent.ts (Business Logic: 75/400 lines)
  ⚠️ [WARNING] apps/crish-desktop/src/components/chat-card/useChatHandlers.ts (UI Component: 471/500 lines)
  ✅ [PASS] apps/crish-desktop/src/components/chat-card/useChatProjectPicker.ts (UI Component: 123/500 lines)
  ✅ [PASS] apps/crish-desktop/src/components/chat-card/useChatSessionActions.ts (UI Component: 286/500 lines)
  ✅ [PASS] apps/crish-desktop/src/components/chat-composer/AiCommandSlashExtension.ts (UI Component: 173/500 lines)
  ✅ [PASS] apps/crish-desktop/src/components/markdown/MarkdownDocumentView.tsx (UI Component: 379/500 lines)
  ✅ [PASS] apps/crish-desktop/src/hooks/useTreePanelEvents.ts (Business Logic: 102/400 lines)

[check-line-counts] Summary:
  Scanned: 8 files
  Warnings: 1
  Violations: 0
  Hard blocks: 0
  Baselined (存量登记): 0

[check-line-counts] ✅ All scanned files passed RL-03 line budget checks!
```

---

## 五、 契约合规与协作纪律遵守

1. **独占文件域合规**：所有修改文件均严格限制在维度 02 指定的独占写入文件白名单内，未碰触任何外部文件；
2. **Git 纪律合规**：全程零 `git commit`、零 `git reset`、零 `git checkout`、零 `git restore`；改动完好保留在工作区等待主控统一验收收口；
3. **架构净收敛（Net Convergence）**：彻底清除 4 处 `crish:chat-*` 悬空死事件，杜绝了 `MarkdownDocumentView` 无条件派发，去除了硬编码全局选择器。
