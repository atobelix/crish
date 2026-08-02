# 子计划 05：Layer E — State & API 层 (Zustand Store & Hooks)

> **层级编号**：Layer E（Round 4，依赖 Layer D Daemon 协议稳定后启动）
> **建议 Agent 数量**：6-8 个
> **涉及维度**：D1（上帝文件/上帝类）、D3（逻辑重复）、D4（异步竞态 — Zustand 盲目突变 / 晚到覆盖）、D6（资源泄漏）、D8（圈复杂度）
> **包路径**：`apps/crish-desktop/src/store/`、`apps/crish-desktop/src/hooks/`、`apps/crish-desktop/src/api/`
> **下游依赖方**：Layer F (UI Components) 直接消费 Store selectors 和 Hooks、Layer G (Performance) 依赖 Store 的不可变更新模式
> 
> **本层与其它层的交叉引用**：E-1（useChatStream 拆分）完成后，Layer G 的 G-1（SSE 渲染节流）和 G-2（onFrame 闭包竞态修复）在其拆分子文件中执行。E-6（Zustand 状态审计）发现的全局状态突变模式需要 Layer H 的 ApprovalPipeline（H-3）和 Layer J 的测试隔离（J-20 provider-gateway 单例 reset）协作修复。
>
> **⚠️ HISTORICAL (OPT-E8 / W4-2):** 下文规划的 `session-actions/` 子目录拆分形态已过时——该目录在 W4-2 **物理删除**。现行为 flat 模块：`sessionCrudActions.ts` / `sessionMessageActions.ts` / `sessionOrderingActions.ts` / `sessionAgentActions.ts` + barrel `sessionActions.ts`（均在 `apps/crish-desktop/src/store/`）。代码示例与 `wc -l session-actions/*.ts` 验收项仅作历史方案参考。

---

## 一、层级目标

Layer E 的核心使命是拆分前端状态管理的上帝文件群、修复 Zustand 状态突变竞态：

| 目标 | 文件 | 行数 | KB |
|------|------|------|-----|
| 上帝 Hook 拆分 | `useChatStream.ts` | 1,996 | 75 |
| Tab 拖拽 Hook 拆分 | `useTabDrag.ts` | 1,792 | 56 |
| Session Action 拆分 | `sessionActions.ts` | 1,346 | 50 |
| 布局辅助函数拆分 | `layoutHelpers.ts` | 1,200 | 40 |
| 上帝 Store 拆分 | `layoutStore.ts` | 1,152 | 41 |
| 状态突变竞态修复 | 多文件 | — | — |

---

## 二、任务总表

| 任务 ID | 目标文件 | 行数/KB | 核心问题 | 修复策略 | 分配 Agent |
|---------|---------|---------|---------|---------|-----------|
| E-1 | `useChatStream.ts` | 1,996 / 75KB | 8 领域混杂的上帝 Hook | 提取 5 个子 Hook + 类型文件 | Agent E2 |
| E-2 | `useTabDrag.ts` | 1,792 / 56KB | 拖拽状态机 + 碰撞检测 + 落点处理混杂 | 按阶段拆分 | Agent E3 |
| E-3 | `sessionActions.ts` | 1,346 / 50KB | 60+ action 混杂 | 按领域拆分 | Agent E1 |
| E-4 | `layoutHelpers.ts` | 1,200 / 40KB | 纯函数混杂多领域 | 按领域拆分 | Agent E1 |
| E-5 | `layoutStore.ts` | 1,152 / 41KB | 上帝 Store + 5 层中间件栈 | 提取 slice | Agent E1 |
| E-6 | Zustand 状态突变 | 多文件 | immer draft 外 + setState 混用 | 审计修复 | Agent E4 |
| E-7 | 流回调晚到覆盖 | `useChatStream.ts` | 快速切换会话时旧回调覆盖新会话 | generation guard | Agent E2 |
| E-8 | sessionIndex 性能 | `sessionIndex.ts` | 每次 action 重建全量索引 | 增量更新 | Agent E4 |

---

## 三、任务 E-1：useChatStream.ts 上帝 Hook 深度拆分

### 3.1 问题现状

[useChatStream.ts](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useChatStream.ts)（1,996 行 / 75 KB）是**前端最大的单文件**。通过逐行审查，精确定位了 **8 个领域区段**：

| 区段 | 行号范围 | 行数 | 核心职责 | 代表性符号 |
|------|---------|------|---------|-----------|
| D1: 纯辅助函数 | L1-L288 | 288 | 导出的测试用纯函数、类型定义 | `resolveStreamSessionId()`, `buildTerminalToolPatches()`, `ensureSessionMessages()`, `canStreamLocalSession()` |
| D2: 多模态附件构建 | L288-L396 | 108 | 附件 → OpenAI content parts + 文本备援 | `buildMultimodalFromAttachments()`, `guessMimeFromDataUrl()`, `ChatAttachment` |
| D3: Slash 命令前缀 | L368-L420 | 52 | `/grill-me`, `/init` 系统提示词 | `GRILL_ME_PREFIX`, `INIT_CONEX_PREFIX`, `UseChatStreamOptions` 接口 |
| D4: Hook 初始化与 Batcher | L447-L616 | 169 | 3 个 `StreamTextBatcher` ref + `StreamRenderBuffer` + notice 管理 | `textBatcherRef`, `thinkingBatcherRef`, `toolBatcherRef`, `renderBufferRef`, `flushStreamBatchers()` |
| D5: Goal 模式控制 | L617-L696 | 79 | `/goal` 自动续写决策 + 排队消息 drain | `maybeContinueGoalMode()`, `drainQueuedAfterComplete()` |
| D6: 流式核心 — runStreamingAssistant | L698-L1441 | **743** | SSE 事件回调（`onChunk`, `onThought`, `onToolStart/Success/Error`, `onSubagent*`, `onComplete`） | `runStreamingAssistant()`, `queueToolCallPatch()`, `upsertToolCall()`, `assertLive()` |
| D7: 停止生成 | L1445-L1500 | 55 | `handleStopGeneration()` | `handleStopGeneration()` |
| D8: 发送消息 — handleSendChat | L1502-L1973 | **471** | Slash 命令解析、会话创建/草稿提交、附件注入、目标模式前缀、权限检查、排队逻辑 | `handleSendChat()`, `/learn`, `/doctor`, `/goal`, `/skill`, `/init`, `/browser` |

**关键架构特征**：
- **4 个 ref 状态机**：`streamManagerRef`（`SessionStreamManager`）、`textBatcherRef`、`thinkingBatcherRef`、`toolBatcherRef`，加上 `renderBufferRef`。
- **`runClosed` 闭包标志**（L742）：防止 `onComplete` 和 `handleStopGeneration` 的竞态双路径。
- **`assertLive()` 守卫**（L787-L793）：每个回调入口检查流是否仍活跃。
- **3 层文本管线**：`StreamRenderBuffer`（rAF 分帧） → `StreamTextBatcher`（48ms 定时合并） → `updateMessageText`（Store 写入）。

### 3.2 目标文件结构

```
apps/crish-desktop/src/hooks/
├── chat-stream/
│   ├── index.ts                    # useChatStream 瘦身后的主 Hook（≤300 行）
│   ├── types.ts                    # ChatAttachment, RunNotice, UseChatStreamOptions, UseChatStreamResult
│   ├── helpers.ts                  # D1: 纯辅助函数（resolveStreamSessionId 等 5 个导出函数）
│   ├── multimodal.ts              # D2: buildMultimodalFromAttachments + guessMimeFromDataUrl
│   ├── useStreamBatchers.ts       # D4: 3 个 batcher ref 初始化 + flushStreamBatchers
│   ├── useStreamCallbacks.ts      # D6: runStreamingAssistant 的全部 SSE 回调（最大子文件 ~500 行）
│   ├── useGoalMode.ts             # D5: maybeContinueGoalMode + drainQueuedAfterComplete
│   ├── useSlashSend.ts            # D8: handleSendChat 中的 slash 命令分发（/learn, /doctor, /skill, /goal, /init, /browser）
│   └── slash-prefixes.ts          # D3: GRILL_ME_PREFIX, INIT_CONEX_PREFIX 常量
├── useChatStream.ts                # barrel 重导出
```

### 3.3 关键迁移约束

**约束 1：ref 共享**
`useStreamCallbacks` 需要访问 `textBatcherRef`, `thinkingBatcherRef`, `toolBatcherRef`, `renderBufferRef`, `streamManagerRef`。这些 ref 在主 Hook 中创建，通过参数传入子 Hook：

```typescript
// chat-stream/index.ts
export function useChatStream(options: UseChatStreamOptions): UseChatStreamResult {
  const refs = useStreamBatchers();  // 返回 { textBatcher, thinkingBatcher, toolBatcher, renderBuffer, streamManager }
  const { runStreamingAssistant } = useStreamCallbacks(options, refs);
  const { handleSendChat } = useSlashSend(options, refs, runStreamingAssistant);
  // ...
}
```

**约束 2：`runClosed` + `assertLive` 闭包隔离**
`runStreamingAssistant` 内部的 `runClosed` 和 `assertLive` 是**每次调用**的局部闭包变量，不是 ref。拆分时必须将整个 `runStreamingAssistant` 函数体保持在同一个子文件中，不能跨文件拆分其内部回调。

**约束 3：`handleSendChat` 的 async 路径**
`handleSendChat` 是 `async function`，内部包含 6 个 `await import(...)` 惰性加载路径（`skillsApi`, `usageStore`, `rulesApi`, `doctorReport`, `engineConfig`, `previewBrowserStore`）。拆分时所有 `await` 路径必须在同一个 async 函数中。

**约束 4：导出签名不变**
`useChatStream` 的返回类型 `UseChatStreamResult`（L422-L441）必须保持：
```typescript
{ runNotice, setRunNotice, runStreamingAssistant, handleSendChat, handleStopGeneration }
```

**[新增] E-1e：流缓冲区 beforeunload 同步 flush**
- 目标文件：`apps/crish-desktop/src/api/beforeunloadFlush.ts`（已有实现，07 文档 §1.1 已识别）
- 动作：将此模块接入 useChatStream 拆分的 chat-stream/index.ts 主 Hook。在 chat-stream/types.ts 中暴露 `flushAllBuffers()` 函数。
- 在 E-1 拆分完成后，确保 composerDrafts 草稿在 pagehide 事件中持久化到 localStorage：
```typescript
window.addEventListener('pagehide', () => {
  flushAllBuffers();
  // 持久化 composer 草稿
  const drafts = getComposerDraftRef().current;
  if (drafts && drafts.trim().length > 0) {
    localStorage.setItem(`composerDraft:${activeSessionId}`, drafts);
  }
});
```

**[新增] E-1f：Stream generation counter 代际防护**
- 目标文件：`chat-stream/useStreamCallbacks.ts`（拆分后的 SSE 回调模块）
- 说明：每次 `runStreamingAssistant(sid)` 启动时递增原子计数器。SSE 回调入口检查计数器匹配；`flushStreamBatchers` 的异步 microtask 中持有快照值，快照与当前值不匹配时丢弃写入。
- 计数器模式：
```typescript
const generationMapRef = useRef(new Map<string, number>());

function runStreamingAssistant(sid: string) {
  const myGen = (generationMapRef.current.get(sid) ?? 0) + 1;
  generationMapRef.current.set(sid, myGen);
  
  onFrame(frame => {
    if (myGen !== generationMapRef.current.get(sid)) return; // 代际不匹配
    buffer.write(frame, sid);
  });
}
```

### 3.4 验证

```bash
npm test -- useChatStream
npm run build
```

---

## 四、任务 E-2：useTabDrag.ts 拆分

### 4.1 问题现状

[useTabDrag.ts](file:///c:/Software/conex/apps/crish-desktop/src/hooks/useTabDrag.ts)（1,792 行 / 56 KB）实现了完整的 Tab 拖拽系统。通过审查，分为以下区段：

| 区段 | 行号范围（约） | 职责 |
|------|-------------|------|
| 类型与常量 | L1-L100 | `DropType`, `UseTabDragOptions`, `DROP_TYPES` 等类型定义 |
| 碰撞检测 | L100-L400 | 5-zone 碰撞检测、drop target 计算、overlay rect 计算 |
| 拖拽状态管理 | L400-L700 | pointer event 处理、drag start/move/end 状态转换 |
| 落点处理器 | L700-L1200 | `finishPointer()` 中的 merge / split-card / split-col 处理 |
| 主 Hook | L1200-L1792 | `useTabDrag()` 组装、event listener 绑定、cleanup |

### 4.2 目标结构

```
apps/crish-desktop/src/hooks/
├── tab-drag/
│   ├── index.ts                    # useTabDrag 主 Hook（≤400 行）
│   ├── types.ts                    # DropType, UseTabDragOptions 等
│   ├── collision.ts                # 5-zone 碰撞检测算法
│   ├── drop-handlers.ts           # finishPointer 中的 merge/split 处理
│   └── pointer-state.ts           # pointer event → 状态转换
├── useTabDrag.ts                   # barrel
```

---

## 五、任务 E-3：sessionActions.ts 领域拆分

### 5.1 问题现状

[sessionActions.ts](file:///c:/Software/conex/apps/crish-desktop/src/store/sessionActions.ts)（1,346 行）。`SessionActions` 接口（L77-L210）定义了 **60+ 个方法**，`createSessionActions()` 工厂函数（L213-L1346）实现了全部。

**SessionStoreSlice** 接口（L57-L73）定义了 action 需要读写的 Store 切片：

```typescript
export interface SessionStoreSlice extends SessionsIndexed {
  folderOrder: string[];
  activeSessionId: string;
  draftFolder: string;
  activeAgentId: string | null;
  panelAgentId: string | null;
  terminalLines: string[];
  terminalBySession: Record<string, string[]>;
  composerDrafts: Record<string, string>;
  streamingRenderStates: Record<string, StreamingMessageRenderState>;
  archiveBuckets: Record<string, SessionMessage[]>;
  // ...
}
```

### 5.2 领域分组（精确到方法名）

| 领域 | 方法清单 | 预计行数 |
|------|---------|---------|
| **session-crud.ts** | `createSession`, `deleteSession`, `renameSession`, `enterDraftMode`, `setDraftFolder`, `clearDraft`, `commitDraftIfNeeded`, `setActiveSessionId`, `setSessions` | ~300 |
| **message-actions.ts** | `addMessage`, `updateMessageText`, `updateMessageThinking`, `withdrawMessage`, `setSessionMessageStatus`, `pinMessage`, `unpinMessage`, `restoreArchivedMessages` | ~250 |
| **tool-actions.ts** | `addMessageToolCall`, `updateMessageToolCall`, `respondToApproval`, `patchAgentTool` | ~150 |
| **agent-actions.ts** | `upsertSessionAgent`, `patchSessionAgent`, `appendSessionAgentMessage`, `setActiveAgentId`, `setPanelAgentId` | ~120 |
| **session-ordering.ts** | `moveSessionRealtime`, `moveFolderRealtime`, `pinSession`, `unpinSession`, `archiveSession`, `unarchiveSession`, `branchSession`, `pinFolderSessions`, `unpinFolderSessions` | ~250 |
| **session-patch.ts** | `patchSession`, `setComposerDraft`, `setStreamTextOffset` | ~80 |

### 5.3 关键约束

`createSessionActions(set, get)` 的 `set`/`get` 闭包需通过参数传入每个子工厂：

```typescript
// session-actions/session-crud.ts
export function createSessionCrudActions(
  set: SetState<SessionStoreSlice>,
  get: GetState<SessionStoreSlice>
): Pick<SessionActions, 'createSession' | 'deleteSession' | ...> {
  return { ... };
}

// session-actions/index.ts
export function createSessionActions(set, get): SessionActions {
  return {
    ...createSessionCrudActions(set, get),
    ...createMessageActions(set, get),
    ...createToolActions(set, get),
    ...createAgentActions(set, get),
    ...createSessionOrderingActions(set, get),
    ...createSessionPatchActions(set, get),
  };
}
```

---

## 六、任务 E-4：layoutHelpers.ts 拆分与 useChatCardSelectors 规范化

### 6.1 问题现状

[layoutHelpers.ts](file:///c:/Software/conex/apps/crish-desktop/src/store/layoutHelpers.ts)（1,200 行 / 40 KB）混合了多领域的纯辅助函数，且组件侧 selector 未使用 `useShallow` 包装。

### 6.2 关键约束

返回的 selector 必须使用 `useShallow` 包装，避免返回字面量新对象导致全树重渲染：

```typescript
import { useShallow } from 'zustand/react/shallow';

// 正确模式
const { activeSessionId, permissionMode } = useLayoutStore(
  useShallow(s => ({ activeSessionId: s.activeSessionId, permissionMode: s.permissionMode }))
);
// 错误模式 ❌ — 每次返回新对象
const { activeSessionId, permissionMode } = useLayoutStore(
  s => ({ activeSessionId: s.activeSessionId, permissionMode: s.permissionMode })
);
```

### 6.3 目标结构

```
apps/crish-desktop/src/store/
├── layout-helpers/
│   ├── index.ts                    # barrel re-export
│   ├── ui-selectors.ts             # UI 相关 selector 聚合（useShallow 包装）
│   ├── session-selectors.ts        # 会话相关 selector 聚合（useShallow 包装）
│   ├── permission-selectors.ts     # 权限相关 selector 聚合（useShallow 包装）
│   └── diff-selectors.ts           # Diff 相关 selector 聚合（useShallow 包装）
├── layoutHelpers.ts                # barrel re-export
```

---

## 七、任务 E-5：layoutStore.ts 上帝 Store 拆分

### 6.1 中间件栈分析

[layoutStore.ts](file:///c:/Software/conex/apps/crish-desktop/src/store/layoutStore.ts) 使用了 **5 层 Zustand 中间件栈**：

```typescript
export const useLayoutStore = create<LayoutStore>()(
  withDevtools(          // ← Layer 5: DevTools 集成
    withLogger(          // ← Layer 4: 状态变更日志
      withPersist(       // ← Layer 3: 持久化到 localStorage
        withAutoIndex(   // ← Layer 2: 自动维护 sessionsById 索引
          immer(         // ← Layer 1: Immer 不可变更新
            (set, get) => ({
              // ... 所有状态和 action
            })
          )
        )
      )
    )
  )
);
```

**`LayoutStore` 类型**混合了 6 个领域：

| 领域 | 字段 | 行号 |
|------|------|------|
| UI 外观 | `uiSize`, `shellChromeMode`, `settingsOpen`, `settingsTab`, `sidebarCollapsed` | ~L80-L120 |
| 会话状态 | `SessionStoreSlice` + `SessionActions` | 通过 `createSessionActions` 注入 |
| 工作区布局 | `WorkspaceActions` + workspace 相关字段 | 通过 `createWorkspaceActions` 注入 |
| 终端 | `terminalLines`, `terminalBySession`, `addTerminalLine` | ~L200-L230 |
| 权限 | `permissionMode`, `commandPermissions`, `setPermissionMode` | ~L250-L300 |
| Diff/遥测 | `diffFiles`, `activeDiffSource`, `tokenUsage` | ~L300-L350 |

### 6.2 目标 Slice 拆分

| Slice | 文件 | 提取字段与 action |
|-------|------|------------------|
| `UISlice` | `store/slices/ui-slice.ts` | `uiSize`, `shellChromeMode`, `settingsOpen`, `settingsTab`, `sidebarCollapsed`, `setUiSize()`, `toggleSettings()` |
| `TerminalSlice` | `store/slices/terminal-slice.ts` | `terminalLines`, `terminalBySession`, `addTerminalLine()`, `clearTerminalBySession()` |
| `PermissionSlice` | `store/slices/permission-slice.ts` | `permissionMode`, `commandPermissions`, `setPermissionMode()`, `addCommandPermission()`, `removeCommandPermission()` |
| `DiffSlice` | `store/slices/diff-slice.ts` | `diffFiles`, `activeDiffSource`, `pushDiffFile()`, `setActiveDiffSource()` |

**目标**：`layoutStore.ts` 瘦身至 ≤ 400 行（仅保留 Store 组装 + 中间件配置 + 初始化/hydrate 逻辑）。

---

## 七、任务 E-6：Zustand 状态突变审计

### 7.1 实际代码中的混用模式

审查 `useChatStream.ts` 发现两种 setState 模式混用：

**模式 A — immer draft（正确）**：
```typescript
// L879, L976, L1000, L1285, L1485
useLayoutStore.setState((state) => {
  const s = state.sessionsById[sid];
  if (s) s.engineLastRunId = runId;   // ← immer draft 内，安全
});
```

**模式 B — getState() + action 调用（正确但绕过 immer）**：
```typescript
// L526, L533, L684, L734, L797, L1208, L1460, L1967
const st = useLayoutStore.getState();
st.updateMessageToolCall(sid, messageId, toolId, updates);  // ← 通过 action 调用，安全
```

**潜在问题**：两种模式在同一个函数中交替使用（如 `onComplete` L1191-L1428 中，L1285 使用 `setState` draft，L1300-L1301 使用 `getState().setSessionMessageStatus`）。如果 action 内部也使用 `setState`，可能导致**嵌套 immer draft**，虽然 zustand-immer 支持，但增加了推理复杂度。

### 7.2 审计清单

```bash
# 搜索所有直接 setState 调用
grep -rn "useLayoutStore.setState" apps/crish-desktop/src/ --include='*.ts' --include='*.tsx'

# 搜索所有 getState + 修改模式
grep -rn "useLayoutStore.getState()" apps/crish-desktop/src/ --include='*.ts' --include='*.tsx'

# 搜索 sessionsById 直接赋值（immer draft 外危险）
grep -rn "sessionsById\[" apps/crish-desktop/src/store/ --include='*.ts' | grep -v "setState\|draft\|get()"
```

---

## 八、任务 E-7：流回调晚到覆盖竞态

### 8.1 实际竞态路径

`useChatStream.ts` L706-L709 中有 session 校验：

```typescript
const sid = resolveStreamSessionId(sessionIdOverride, getActiveSessionId());
if (!sid || !canStreamLocalSession(sid, !!getSessionById(sid))) return;
```

但 L866 `cancelFn = streamAssistantResponseApi(...)` 启动流后，所有回调（`onChunk`, `onToolSuccess`, `onComplete` 等）通过闭包捕获了 `sid`。当用户快速切换会话时：

1. 会话 A 的流正在运行（`sid = "session-A"`）
2. 用户切换到会话 B
3. 会话 A 的 `onChunk` 回调仍在执行，将文本写入 `session-A`（通过 `updateMessageText(sid, ...)`）
4. **如果 L711-L731 的 prevStream 清理未及时完成**（异步 flush），旧回调可能在新会话的 UI 上下文中执行

**现有防护**：`assertLive()` (L787-L793) 检查 `streamManagerRef.current!.get(sid)` 是否匹配当前 `assistantMsgId`。这是一个 **generation guard 的原始形式**，但存在漏洞：

```typescript
const assertLive = (): boolean => {
  if (runClosed) return false;
  return isLiveStreamRun(
    streamManagerRef.current!.get(sid),  // ← 按 sid 查找
    assistantMsgId                        // ← 按 assistantMsgId 匹配
  );
};
```

漏洞：如果新流恰好使用了相同的 `sid`（用户在同一会话中快速连发两条消息），旧流的 `assertLive` 会因 `assistantMsgId` 不匹配而正确返回 false。但**在 prevStream 的 flush 期间**（L716-L720），旧 buffer 的 `onFrame` 回调（L759-L765）不检查 `assertLive`：

```typescript
buffer.onFrame = (frame) => {
  if (runClosed && !frame.isFinal) return;  // ← 只检查 runClosed，不检查 assertLive
  updateMessageText(sid, assistantMsgId, frame.full);
};
```

### 8.2 修复方案

在 `buffer.onFrame` 中也加入 `assertLive` 检查：

```typescript
buffer.onFrame = (frame) => {
  if (runClosed && !frame.isFinal) return;
  if (!assertLive() && !frame.isFinal) return;  // ← 新增
  updateMessageText(sid, assistantMsgId, frame.full);
};
```

---

## 九、多 Agent 并行分配

| Agent | 独占文件 | 任务 |
|-------|---------|------|
| E1 | `sessionActions.ts`, `layoutStore.ts`, `layoutHelpers.ts` | E-3, E-4, E-5 |
| E2 | `useChatStream.ts` | E-1, E-7 |
| E3 | `useTabDrag.ts` | E-2 |
| E4 | Store 审计（多文件只读 + 修复）, `sessionIndex.ts` | E-6, E-8 |

### 执行顺序

```
E1 (Store 拆分) ── 独立，可立即启动
E3 (TabDrag 拆分) ── 独立，可立即启动
E4 (突变审计) ── 独立，可立即启动
E2 (ChatStream 拆分) ── 依赖 E1 完成（消费 sessionActions 路径变更）
```

---

## 十、验收标准

| 编号 | 检查项 | 验证方式 | 通过条件 |
|-----|--------|---------|---------|
| V-1 | useChatStream 主 Hook | `wc -l chat-stream/index.ts` | ≤ 300 行 |
| V-2 | useStreamCallbacks 子 Hook | `wc -l chat-stream/useStreamCallbacks.ts` | ≤ 500 行 |
| V-3 | useSlashSend 子 Hook | `wc -l chat-stream/useSlashSend.ts` | ≤ 400 行 |
| V-4 | useChatStream 返回签名不变 | TypeScript 编译 | 零类型错误 |
| V-5 | sessionActions 拆分 | `wc -l session*Actions.ts`（**historical plan used** `session-actions/*.ts`，dir deleted W4-2） | 每个子文件 ≤ 300 行 |
| V-6 | layoutStore 瘦身 | `wc -l layoutStore.ts` | ≤ 400 行 |
| V-7 | layoutHelpers 拆分 | `wc -l layout-helpers/*.ts` | 每个子文件 ≤ 300 行 |
| V-8 | useTabDrag 拆分 | `wc -l tab-drag/*.ts` | 每个子文件 ≤ 500 行 |
| V-9 | buffer.onFrame guard | 代码审查 | assertLive 检查已添加 |
| V-10 | Zustand setState 审计 | `grep -c "sessionsById\["` | 零 immer-draft-外直接修改 |
| V-11 | 全量构建 | `npm run build` | 零错误 |
| V-12 | 全量测试 | `npm test` | 零回归 |

---

## 十一、风险与缓解

| 风险 | 概率 | 影响 | 缓解策略 |
|-----|------|------|---------|
| useChatStream ref 共享跨子 Hook 后闭包过期 | 高 | 高 | 所有 ref 在主 Hook 中创建，通过参数对象传入子 Hook，不通过 Context |
| runStreamingAssistant 内部 `runClosed` 闭包拆分后行为变化 | 中 | 高 | 整个 `runStreamingAssistant` 保留在同一个 `useStreamCallbacks` 子文件中 |
| sessionActions 拆分后 `set`/`get` 类型推断失败 | 中 | 中 | 显式声明 `set: SetState<SessionStoreSlice>` 参数类型 |
| layoutStore 中间件栈顺序敏感 | 低 | 高 | 中间件栈顺序保持不变，仅提取 slice 内容 |
| useTabDrag 拆分后拖拽动画抖动 | 低 | 中 | 碰撞检测保持同步执行（不移到 rAF 或 Worker） |
