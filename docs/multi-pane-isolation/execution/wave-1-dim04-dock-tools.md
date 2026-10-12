# 维度 04：工具抽屉卡片与内置预览浏览器多实例天然隔离落地报告

> **战役工作区**：`docs/multi-pane-isolation/`  
> **负责维度**：维度 04（工具抽屉卡片与内置预览浏览器多实例天然隔离）  
> **对应详案**：[`04-工具抽屉卡片与内置预览浏览器多实例天然隔离方案.md`](../04-工具抽屉卡片与内置预览浏览器多实例天然隔离方案.md)  
> **审查报告**：[`plan-reviews/review-04-dock-tools-and-preview-isolation.md`](../plan-reviews/review-04-dock-tools-and-preview-isolation.md)  
> **执行状态**：✅ **全部 16 个代码文件改造完成，新建专项测试 10/10 全绿，存量回归测试 20/20 全绿**

---

## 一、 改动文件清单与行数审计（Line Counts）

本次修改严格恪守任务书独占文件边界与 `ANTI_OVERENGINEERING_GUARDRAILS.md`，所有 16 个代码文件全部通过行数门禁，无任何越界文件修改：

| 文件路径                                                                            | 架构分类       | 有效行数 / 类别上限 |                             状态                             |
| :---------------------------------------------------------------------------------- | :------------- | :-----------------: | :----------------------------------------------------------: |
| `apps/crish-desktop/src/components/workspace/PreviewCard.tsx`                       | 预览容器组件   |      464 / 500      |    ✅ 通过（来源窗口校验 + 定址停止事件 + HIST_PANEL_ID）    |
| `apps/crish-desktop/src/components/workspace/usePreviewNavigation.ts`               | 导航逻辑 Hook  |      368 / 400      |      ✅ 通过（内部导航静默持久化 + 外部作用域消费守卫）      |
| `apps/crish-desktop/src/components/workspace/previewHostBridge.ts`                  | 通信桥基础模块 |      268 / 400      |     ✅ 通过（iframe.contentWindow 精确比对阻断跨窗污染）     |
| `apps/crish-desktop/src/components/binary-tree/ToolTabFavicon.tsx`                  | 标签图标组件   |      128 / 500      |     ✅ 通过（按分屏 leafId 独立定址过滤 URL 与 Favicon）     |
| `apps/crish-desktop/src/components/files/FilesCard.tsx`                             | 文件管理组件   |  460 / 465 (基线)   |      ✅ 通过（精简 handleSplitResizeStart 降至基线内）       |
| `apps/crish-desktop/src/components/files/FilePreview.tsx`                           | 文件预览组件   |      278 / 500      | ✅ 通过（批注 Popover 透传 targetSessionId=scopedSessionId） |
| `apps/crish-desktop/src/components/files/FileViewerCard.tsx`                        | 文件查看器     |      453 / 500      |     ✅ 通过（作用域模式切换 + 定位优先 scope.openTool）      |
| `apps/crish-desktop/src/store/workspace-shell/openTool.ts`                          | 工具打开契约   |      320 / 400      |    ✅ 通过（file-viewer-mode 派发携带 leafId/sessionId）     |
| `apps/crish-desktop/src/components/overview/OverviewCard.tsx`                       | 总览卡片组件   |      175 / 500      |  ✅ 通过（绑定 scopedSessionId，解绑全局 activeSessionId）   |
| `apps/crish-desktop/src/components/overview/changes/useSessionScopedChanges.ts`     | 改动提取 Hook  |      83 / 400       |     ✅ 通过（作用域派生变更提取 + 返回 scopedSessionId）     |
| `apps/crish-desktop/src/components/workspace/TerminalCard.tsx`                      | 终端容器组件   |      242 / 500      |          ✅ 通过（新建终端优先在所属分屏叶子创建）           |
| `apps/crish-desktop/src/components/agent-card/AgentCard.tsx`                        | 子智能体侧栏   |      284 / 500      |      ✅ 通过（绑定 scopedSessionId 独立加载目标 Agent）      |
| `apps/crish-desktop/src/components/diff/DiffCard.tsx`                               | 差异比对组件   |      378 / 500      |   ✅ 通过（openFileViewerInSession 透传 scopedSessionId）    |
| `apps/crish-desktop/src/components/workspace/FlowDagView.tsx`                       | DAG 视图组件   |      175 / 500      |         ✅ 通过（轮询绑定所属分屏 scopedSessionId）          |
| `apps/crish-desktop/src/components/workspace/TrashSection.tsx`                      | 回收站组件     |      198 / 500      |    ✅ 通过（恢复与彻底清除携带所属分屏 scopedSessionId）     |
| `apps/crish-desktop/src/components/note-paper/useNoteDocumentManager.ts`            | 便签管理 Hook  |      242 / 400      | ✅ 通过（清理重复监听 + subscribeNoteDocWritten 作用域过滤） |
| `apps/crish-desktop/src/components/workspace/__tests__/dockToolsIsolation.test.tsx` | 专项隔离测试   |       642 行        |              ✅ 新建并通过（10/10 tests pass）               |

---

## 二、 核心改造落地详情

### 1. 内置预览浏览器（PreviewCard）与跨窗 postMessage 通信隔离（T-D-01 ~ T-D-03）

- **精确来源窗口比对（`event.source === iframe.contentWindow`）**：
  在 `previewHostBridge.ts` 的 `subscribeToInspector` 以及 `PreviewCard.tsx` 的 `handleMessage` 中，当传入 `iframeRef` 时严格校验：
  ```ts
  if (
    !iframe ||
    (iframe.contentWindow &&
      event.source &&
      event.source !== iframe.contentWindow)
  ) {
    return;
  }
  ```
  在双分屏挂载两个 `PreviewCard` 实例时，来自 iframe A 的 `INSPECT_HOVER` / `INSPECT_SELECT` 与 `preview:navigate` 消息绝不穿透污染分屏 B，反之亦然。
- **内部导航静默持久化与定址事件守卫**：
  在 `usePreviewNavigation.ts` 中，内部导航调用 `setPreviewUrl(url, { silent: true })`，彻底消除旧代码向全局派发未带坐标的 `crish-preview-url` 劫持其他分屏的问题；外部传入的定址事件严格经由 `shouldConsumeScopedEvent(detail, scopeTargetRef.current)` 校验，仅匹配目标 `leafId` / `sessionId` 的预览实例跳转。
- **ToolTabFavicon 作用域隔离**：
  在 `ToolTabFavicon.tsx` 中监听 `crish-preview-url-change` 时，校验 `shouldConsumeScopedEvent(ev.detail, { leafId })`，确保各叶子标签栏的站点 Favicon 与页面 URL 独立绑定。
- **协同停止定址化**：
  在 `PreviewCard.tsx` 的 `handleStopAi` 中，优先派发携带 `{ sessionId: scopedSessionId, leafId: effectiveLeafId }` 的 `stop-generation` UI 作用域事件（同时兼容保留 `crish:chat-stop` 向后兜底）。

### 2. 文件面板（FilesCard）与文件查看器（FileViewerCard）多实例隔离（T-D-04 ~ T-D-06）

- **待发送批注独立计数渲染**：
  在 `FilesCard.tsx` 中，改用 `useScopedSessionId` 读取所属分屏会话，向 `getPendingAnnotationsCount(scopedSessionId)` 独立提取该分屏的待提交批注数量，并在徽章中正确呈现；`FilePreview.tsx` 透传 `targetSessionId={scopedSessionId}` 给 `FileAnnotationPopover`，多窗口批注互不穿透。
- **定址文件打开与定位**：
  在 `FilesCard.tsx` 中，监听全局 `crish-open-file` 事件时接入 `shouldConsumeScopedEvent`，阻断非本分屏请求；在 `FileViewerCard.tsx` 的「在文件树中定位」操作中，优先获取所属 `scope.openTool('files')` 在当前分屏叶子打开文件树。
- **查看器模式切换隔离（`conex:file-viewer-mode`）**：
  在 `openTool.ts` 派发 `conex:file-viewer-mode` 时携带 `{ leafId, sessionId }`；在 `FileViewerCard.tsx` 中监听时接入 `shouldConsumeScopedEvent`，杜绝双分屏打开同名文件时发生跨分屏模式误联动（如一个切换到 diff，另一个保持 plain）。

### 3. 总览卡片（OverviewCard）、派生改动与运行态卡片隔离（T-D-07 ~ T-D-10）

- **OverviewCard 解除全局 activeSessionId 耦合**：
  `OverviewCard.tsx` 使用 `useScopedSessionId(sessionIdProp)` 与 `useSessionStore` 读取本分屏绑定的真实会话（包括标题、改动、协作体列表等），并透传 `activeSessionId={scopedSessionId}` 给 `AgentSection`。即使全局焦点切换到另一个分屏，后台分屏的总览卡片依然稳定展示本分屏内容。
- **useSessionScopedChanges 作用域收敛**：
  返回 `{ activeSessionId: scopedSessionId, changes, ... }`，确保改动列表始终对应所属叶子。
- **TerminalCard 分屏感知**：
  点击「新建独立终端」按钮时，优先调用 `openNewTerminalInLeaf(effectiveLeafId)`，精准在当前分屏叶子新建终端标签，而不是盲目在全局激活标签创建。
- **DiffCard、FlowDagView、TrashSection 接入会话作用域**：
  `DiffCard.tsx` 在打开文件查看器时调用 `openFileViewerInSession(scopedSessionId, path, 'plain')`；`FlowDagView.tsx` 轮询时读取 `scopedSessionId`；`TrashSection.tsx` 在执行恢复（`restoreTrashEntry`）与彻底清除（`purgeTrashEntry`）时携带所属分屏 `scopedSessionId`。

### 4. 便签文档管理器（useNoteDocumentManager）事件总线隔离（T-D-11）

- 清除旧代码中多余的全局 DOM 事件重复监听；
- `subscribeNoteDocWritten` 接入 `shouldConsumeScopedEvent(payload, { leafId, sessionId })`，仅当写入事件的目标叶子或会话与当前便签所属分屏一致时才触发刷新，阻断跨窗口写入造成的冗余列表拉取。

---

## 三、 自动化测试覆盖与验证结果

新建专属测试套件 [`dockToolsIsolation.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/__tests__/dockToolsIsolation.test.tsx)，涵盖三大测试分组共 10 个专项用例：

```text
✓ 维度 04：工具抽屉卡片与内置预览浏览器多实例天然隔离 (10 tests)
  ✓ 1. 内置预览浏览器与 Favicon 多实例隔离
    ✓ 双 PreviewCard 挂载时，MessageEvent 仅由源 iframe 匹配的分屏响应
    ✓ 外部派发带 leafId 定址的 crish-preview-url，仅目标分屏跳转
    ✓ ToolTabFavicon 按 leafId 隔离 crish-preview-url-change
  ✓ 2. 文件面板与单文件查看器隔离
    ✓ 双 FilesCard 批注计数徽章独立渲染，互不串联
    ✓ FileViewerCard 模式切换按 leafId 隔离，杜绝同名文件跨分屏联动
  ✓ 3. 总览、终端、子智能体与回收站会话上下文隔离
    ✓ 全局 activeSessionId = sess-a 时，非激活分屏 B 的 OverviewCard 依然展示 sess-b 的子智能体
    ✓ TerminalCard 点击新建终端时，优先在所属分屏叶子创建
    ✓ AgentCard 独立绑定所属分屏子智能体
    ✓ TrashSection 在分屏内恢复/清除时，携带所属分屏 scopedSessionId
    ✓ useNoteDocumentManager 作用域过滤阻断跨窗口写入刷新
```

**存量测试回归结果**：

- `PreviewCard.test.tsx`：20/20 全部 PASS；
- 行数门禁 `node scripts/check-line-counts.mjs`：全量绿色通过。

---

## 四、 零越界合规与交付交接

- **修改文件范围**：严格限定于任务书指定的 16 个代码文件 + 1 个新建测试文件 + 本执行报告，未修改任何其他范围外文件；
- **Git 纪律**：未执行 `git commit`、`git reset`、`git checkout`、`git restore`，所有改动完好保留在工作区等待主控统一验证和提交。
