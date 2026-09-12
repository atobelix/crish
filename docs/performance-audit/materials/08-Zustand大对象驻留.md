# 08 · 扫描素材：Zustand Store 大对象与驻留

> 日期：2026-09-13  
> 范围：sessionStore / streamingStore / terminalStore / layoutTreeStore / MessageSnapshots 等内存驻留。

## 1. sessionStore 全量会话驻留

### 1.1 结构

`store/sessionStore.ts:26-35,51-59`：
- `sessions: SessionState[]` + `sessionsById: Record<string, SessionState>` 双索引
- 每个 SessionState 内嵌 `messages: SessionMessage[]`（含 toolCalls.output 全文）
- `agents: SessionAgent[]` 内嵌 `agents[].messages`（MAX_MESSAGES_PER_AGENT=2000）
- `composerDrafts: Record<string, string>` 全量草稿

### 1.2 上限

`packages/shared-utils/src/bounds.ts`：
- MAX_MESSAGES_PER_SESSION = 500
- MAX_MESSAGES_PER_AGENT = 2000
- MAX_AGENTS_PER_SESSION = 40
- MAX_SESSIONS = 200

理论最坏：200 会话 × (500 主消息 + 40×2000 agent 消息) —— 实际受懒水合限制。

### 1.3 懒水合（正面）

`api/session-persistence/sessionRustDbHydrate.ts:142-239`：冷启动仅活跃会话全量 body+agents；历史会话 `messages: []`、`messagesHydrated: false`。激活时 `sessionActivateHydrate.ts:50-78` 再拉引擎。

**缺口**：会话切换后**不驱逐**已水合的非活跃会话 messages。用户在 20 个会话间点开后，20 份全文（含工具输出）同时驻留内存，直到删会话或 `clearSessionMessages`（仅 UnitChromeActions 用户手势调用）。

### 1.4 双持久化（高危）

`sessionStore.ts:49-70`：
```
withPersist(immer(...), {
  name: 'crish_session_store',
  partialize: (s) => ({
    sessions: s.sessions,   // ← 全量 messages 数组
    folderOrder, activeSessionId, composerDrafts
  })
})
```
zustand persist 默认 localStorage、**每次 set 同步 JSON.stringify**。与 `initStorePersistence`（store-persistence.ts:155-166，350ms debounce → SQLite persistAllSessions）**并行双写**：

1. zustand persist：任意 sessionStore 变更 → 全量 sessions（含所有已水合消息正文）序列化进 localStorage `crish_session_store`。
2. initStorePersistence：debounce 350ms → persistAllSessionsRust → SQLite。

内存峰值：同一份消息树在「内存对象 + JSON 字符串 + IPC 序列化缓冲」三份并存；流式收口 / 大工具输出落地时尤甚。

`localStorageApi.ts:48-51` 注册了 `crish_session_store_v1` 键名，但 sessionStore 实际 name 为 `crish_session_store`（无 _v1）——注册表与实现键名漂移（低危一致性问题）。

### 1.5 composerDrafts 删除不清理

`sessionIndex.ts:296-313` deleteSessionFromIndexed 只删 sessions/sessionsById。`sessionCrudActions.ts:306-377` deleteSession 未 `delete composerDrafts[id]`。删除会话后草稿字符串仍驻留并被 persist 捕获。

## 2. streamingStore

`store/streamingStore.ts`：byKey = `sessionId::messageId`。收口后 clearStreams / clearSession 清理（sessionAgentActions.ts:203-208 microtask；SessionCoordinator 级联 clearSession）。Delta 可丢设计正确。

**残余风险**：setStreamTool 将完整 output 字符串放进 StreamToolLive；运行中长工具输出在 streaming + commit 后又进 sessionStore —— 双份窗口期（设计内，可接受）。

## 3. MessageSnapshots

`api/MessageSnapshots.ts`：
- MAX_STACK_DEPTH=20 / MAX_MEMORY_BYTES=5MB
- SnapshotEntry **同时**持有 `messages: SessionMessage[]`（完整副本）与 `delta.inserted`（差异段）
- estimateBytes 只计 delta.inserted（:175-191），**不计 entry.messages 全量副本** → 5MB 预算低估实际占用（约 2×）

## 4. terminalStore / PTY history

`api/ptySessionApi.ts:52-117`：每 PTY 256KB 环形缓冲，字节感知截断（正面）。多终端 tab 各持一份。与 02 X1 交叉：隐藏终端仍 record。

## 5. 正面

- 流式热缓冲与持久投影分离（streamingStore 注释 :8-15）
- ACT-502 懒水合 K=5
- MessageSnapshots 增量 delta + 全局 5MB 上限（预算口径需修正）
- clearSessionCascade 五级清理（SessionCoordinator.ts:26-51）
