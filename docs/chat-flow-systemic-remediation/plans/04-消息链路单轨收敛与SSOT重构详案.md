# 消息链路单轨收敛与会话存储事务详案

> **权威路径**：`docs/chat-flow-systemic-remediation/plans/04-消息链路单轨收敛与SSOT重构详案.md`
> **方案定位**：消息流全链路单轨收敛、会话隔离、存储事务控制与单一真理源（SSOT）架构重构落地详案（对齐总方案阶段一、阶段二、阶段四与阶段七）
> **指导思想**：纯逻辑规划、反退避、拒绝打补丁、问题同权、契约驱动、立体化闭环
> **纪律约束**：不排工期人天，不设 P0/P1 优先级划分，所有缺陷同权对待，严格按架构逻辑拓扑展开。严禁执行 git commit、git reset、git checkout。

---

## 摘要与重构目标

在对话流系统性净化与架构重塑战役中，**消息数据链路的多轨撕裂、会话流式缓冲单例污染与底层持久化事务脱节**是导致桌面端出现跨会话串线、消息停机窜写、清空后僵尸复活、切会话白屏崩溃与高频丢数据等恶性故障的根本病灶（DIM-04、DIM-12、DIM-16）。

本详案依据最新纯缺陷审计报告（特别是 `audits/04`、`audits/12` 与 `audits/16`），针对揭示的全部架构断层与真实运行期风险，确立自上而下的重构体系：
1. **彻底消除单例跨会话污染**：废除全局共享的 `renderBufferRef`，重构为会话独占的 `Map<sessionId, StreamRenderBuffer>` 缓冲池；`finalizeStopGeneration` 升级为显式目标寻址，杜绝盲读当前全局会话导致的误杀与停机窜写；
2. **确立单一真理源（SSOT）管道**：确立 `sessionStore.sessionsById[id].messages` 为唯一持久真理源，`streamingStore` 严格定位为 Token 热缓冲代理；规范流结束时的原子提交与双缓冲交接时序，根治微任务提前清空导致的文本抽搐与白屏闪烁；
3. **闭环存储事务与防死复活**：重构持久化下发门禁，精确区分“未水合懒壳”与“显式清空会话”，确保 `clearSessionMessages` 能够下发 SQLite 清空指令，消灭刷新后消息僵尸复活；
4. **根除持久化时间差与写入饥饿**：统一 SQLite 与 localStorage 双写步调，消除索引先行正文滞后的时间差撕裂；升级防抖算法，引入 `maxWait` 保护，并在 `beforeunload` 中建立可靠同步镜像刷盘，保障窗口卸载与异常断电下的数据零丢失；
5. **规范会话 CRUD 状态机生命周期**：`deleteSession` 删除活跃会话时原子收敛焦点至相邻有效会话，彻底消除 `useActiveSession()` 悬垂指针引发的 React 运行时崩溃；打通 `renameSession` 与标签树（`workspaceShellStore`）的双向原子同步；
6. **守护不可变性与渲染性能**：消灭在 Immer draft 内裸挂外部引用和直接执行 `splice` 的破坏行为；纯化 `useScopedSessionField`，消除 React 渲染期突变 Ref 与 5 重级联 `forceUpdate` 渲染风暴。

---

## 一、全景缺陷审计映射矩阵（Audits/04, 12, 16 同权映射）

依据反退避与问题同权原则，所有缺陷不区分主次先后，均作为架构重构的强制验收项：

| 缺陷编号 | 审计源索引 | 核心断层事实与根因 | 真实运行期致命危害 | 详案对应解决章节 |
| :--- | :--- | :--- | :--- | :--- |
| **DEF-01** | `audits/16` DEF-SESS-01<br>`audits/12` 缺陷 08/13 | `renderBufferRef` 为整个聊天流共享单例，会话 A 正在生成时长被会话 B 覆盖；停止操作读取单例正文 | 用户停止会话 A 时，会话 B 的文本被直接窜写入会话 A 并落盘，造成致命的跨会话文本污染 | §2.2, §3.1 |
| **DEF-02** | `audits/16` DEF-SESS-02 | `finalizeStopGeneration` 盲读全局 `getActiveSessionId()`，未传入显式 `targetSessionId` | 切会话后停止后台长生成时 early-return 无法停止，或误杀当前聚焦的无关会话 | §3.1 |
| **DEF-03** | `audits/16` DEF-SESS-12 | `clearSessionMessages` 仅清空内存，`sessionRustDbHydrate` 硬编码 `msgs.length > 0` 拒绝下发保存 | 用户清空会话后刷新页面或重启，被清空的消息全部原地复活（僵尸复活） | §4.1 |
| **DEF-04** | `audits/16` DEF-SESS-08 | `deleteSession` 仅删除实体，故意保留 `activeSessionId`，未做原子焦点收敛 | 外部调用删除当前会话后，`useActiveSession()` 返回 `undefined`，触发全页白屏崩溃 | §5.1 |
| **DEF-05** | `audits/16` DEF-SESS-14 | 持久化先同步写 localStorage 索引，再经 350ms 防抖异步写 SQLite 正文 | 刷新窗口时首屏读出最新索引却查无正文，触发降级死壳错误（时间差撕裂） | §4.2 |
| **DEF-06** | `audits/16` DEF-SESS-15/16 | 350ms 防抖缺乏 `maxWait` 保底；`beforeunload` 仅同步写入 localStorage 无法触及 SQLite | 高频输入时持久化无限推迟（饥饿）；崩溃退出或强关窗口导致最后阶段改动永久丢失 | §4.3, §4.4 |
| **DEF-07** | `audits/04` 缺陷 01/02/03 | `contextStatePending.ts` 全局单键暂存跨会话覆写；去重签名缺乏会话隔离；草稿态 ID 断层 | 会话 A 模型切换被会话 B 覆盖；同模型切换被全局误杀；新建会话首条消息状态 100% 丢失 | §3.3 |
| **DEF-08** | `audits/04` 缺陷 04/05 | `streamSession.ts` 异步断层期取消任务导致 `onMessage` 监听器泄漏；死 Run 仍强推 `startRunTask` | 僵尸监听器内存泄漏；前端已取消任务仍向后端下发大模型推理，造成 Token 严重浪费 | §3.2 |
| **DEF-09** | `audits/04` 缺陷 06/07 | 斜杠命令在草稿态未提交前派发卡片被丢弃；发送失败时已派发注入卡片缺乏回滚 | 欢迎草稿页使用斜杠命令卡片丢失；网络或校验失败后时间线上残留孤儿卡片 | §3.2, §3.3 |
| **DEF-10** | `audits/04` 缺陷 12<br>`audits/12` 缺陷 09 | `useScopedSessionField` 在渲染期突变 Ref；订阅短路缺失值比较触发 5 重 `forceUpdate` | 破坏 React 纯函数契约；每个流式 chunk 调度 5 次无效重渲染，严重消耗 CPU 引发掉帧 | §6.1 |
| **DEF-11** | `audits/04` 缺陷 14 | `commitStreamToSession` 在微任务 `queueMicrotask` 中清除热缓冲 | 微任务执行早于 React 18 DOM Paint，热缓冲瞬间消失而持久文本未就绪，正文剧烈抽搐闪屏 | §2.2 |
| **DEF-12** | `audits/04` 缺陷 10/11 | `useChatEmptyKind` 条件矛盾致 `messagesLoading` 读屏不可达；`useEffect` 首帧延迟重置 | 视障用户读屏得到虚假状态；会话切换首帧误判为“开始对话”，产生 1 帧严重白屏闪烁 | §6.4 |
| **DEF-13** | `audits/16` DEF-SESS-05/06/19 | 注入卡片外部对象直接引用赋值；`injections` 与 `blocks` 分叉合并；消息合并裸赋数组 | 绕过 Immer/Zustand 派发通道；破坏 `React.memo` 浅比对；外部突变逆向污染时间线 | §2.3 |
| **DEF-14** | `audits/16` DEF-SESS-09/11 | `renameSession` 未同步标签树；草稿提交 `commitDraftIfNeeded` 与 Tab 晋升缺乏原子事务 | 会话重命名后顶部标签标题脱节；发送后 `syncSessionFromActiveLeaf` 强退回草稿页 | §5.2, §3.3 |
| **DEF-15** | `audits/16` DEF-SESS-10 | 会话 ID 采用毫秒 `Date.now()` 导致高频碰撞；`pruneEmptyShellsInPlace` 误杀多 Tab 空壳 | 并发创建会话相互吞并；用户在多标签页准备中的空壳占位被后台直接抹除 | §5.3 |
| **DEF-16** | `audits/16` DEF-SESS-03<br>`audits/04` 缺陷 15 | 懒水合拉取历史消息时强行覆写 `s.timestamp = nowIsoTimestamp()` | 用户仅在侧栏查看历史会话，该会话时间戳被篡改为当前时间，突然跃升列表顶端（乱序跳变） | §5.4 |
| **DEF-17** | `audits/16` DEF-SESS-18 | `types.ts` 重复声明同名 `interface MessageImageRef` 且字段冲突 | 滥用接口声明合并陷阱，导致编译隐患与运行期字段丢失 | §2.3 |
| **DEF-18** | `audits/12` 缺陷 01/03/05 | `useChatMessageState` 组装 props 遗漏回调函数；`MessageVirtualizer` 审批空函数充数 | 破坏下游 Memo 隔离；审批按钮静默吞噬操作；注入卡片折叠状态丢失闭环 | §6.2 |
| **DEF-19** | `audits/12` 缺陷 04<br>`audits/04` 缺陷 08 | `handleRegenerateRow` 倒查使用过滤后数组 `displayMessages` 寻找 prompt | 搜索状态下重新生成抓取到远古错误提问，或直接弹出“没有可重新生成的内容”阻断 | §6.2 |

---

## 二、消息流水线单一真理源（SSOT）总体架构设计

### 2.1 状态分层与单轨流向拓扑（Single-Track Pipeline Topology）

系统确立严格分层的三态架构，严禁任何组件或模块越权维护旁路消息数组：

```
                    ┌─────────────────────────────────────────────────────────┐
                    │               用户触发 (User Action / Slash)             │
                    └────────────────────────────┬────────────────────────────┘
                                                 │
                                                 ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │       useSlashSend / PendingMessageQueue (发送中枢)      │
                    └──────────────┬───────────────────────────┬──────────────┘
                                   │                           │
                   (1) 预先乐观写入 User 消息     (2) 启动流式 runStream
                                   │                           │
                                   ▼                           ▼
┌──────────────────────────────────────────────────┐  ┌──────────────────────────────────────────────────┐
│  SessionStore (唯一持久真理源 - Single Truth)      │  │  StreamingStore (Per-Token 热缓冲 - Non-SSOT)     │
│  • sessionsById[sessionId].messages             │  │  • per-session / per-message 增量缓冲区           │
│  • 承载：完整已完成消息、持久化注入卡片、执行历史   │  │  • 承载：高频 delta chunks, thinking, 工具进度   │
│  • 更新频率：低频 (Prompt 发送 / Run 终态落盘)   │  │  • 更新频率：极高频 (30~60 FPS 批量刷新)          │
└─────────────────────────▲────────────────────────┘  └────────────────────────┬─────────────────────────┘
                          │                                                    │
                          │        (3) 终态原子提交 (Atomic Commit)             │
                          └────────────────────────────────────────────────────┘
                                               │
                                               ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │         视图层渲染协调器 (useChatMessages / View)         │
                    │  • 活跃会话过滤 (displayMessages = f(messages, query))    │
                    │  • 流式合并视图 (isStreaming ? merge(msg, hot) : msg)    │
                    └─────────────────────────────────────────────────────────┘
```

#### 状态权威划分规则：
1. **持久状态主权（SessionStore）**：
   - 包含会话元数据（ID、Title、Timestamp、Model Profile）与已固化的消息时间线（`messages: SessionMessage[]`）。
   - 任何已终结的消息、用户历史输入、系统注入卡片必须且仅能存在于 `SessionStore`。
   - 禁止在 `useChatMessages`、`ChatMessageList` 或任何局部 Hook 中保留私有消息快照。
2. **热缓冲代理（StreamingStore）**：
   - 严格作为高频流式渲染的临时性能缓冲层，生命周期仅限于当前活跃的流式生成过程。
   - 绝不独立持久化，绝不跨会话复用。
3. **视图派生纯函数化**：
   - 展示列表 `displayMessages` 必须由 `SessionStore.messages` 与搜索关键词 `filterQuery` 通过纯函数计算派生（Derivation），禁止越权承担空态计算或状态存储。

---

### 2.2 流式热缓冲向持久真理源的原子收敛（Streaming to SSOT Atomic Commit）

#### 根治 DEF-01：废除单例 `renderBufferRef`，构建会话独占缓冲池

现存单例 `renderBufferRef: MutableRefObject<StreamRenderBuffer | null>` 在多会话切换时必然发生句柄覆写。必须重构为以 `sessionId` 为 Key 的隔离缓冲映射池：

```ts
/**
 * 会话独占流式渲染缓冲池契约
 */
export interface SessionStreamBufferPool {
  /** 获取或创建目标会话专属的渲染缓冲器 */
  getOrCreate(sessionId: string): StreamRenderBuffer;
  /** 获取目标会话专属缓冲器（若不存在返回 undefined） */
  get(sessionId: string): StreamRenderBuffer | undefined;
  /** 消费并移除目标会话的缓冲器 */
  remove(sessionId: string): StreamRenderBuffer | undefined;
  /** 重置并清空所有会话缓冲（应用重置或登出） */
  clearAll(): void;
}

export class SessionStreamBufferPoolImpl implements SessionStreamBufferPool {
  private readonly buffers = new Map<string, StreamRenderBuffer>();

  getOrCreate(sessionId: string): StreamRenderBuffer {
    const sid = sessionId.trim();
    if (!sid) throw new Error('[BufferPool] sessionId must not be empty');
    let buf = this.buffers.get(sid);
    if (!buf) {
      buf = new StreamRenderBuffer();
      this.buffers.set(sid, buf);
    }
    return buf;
  }

  get(sessionId: string): StreamRenderBuffer | undefined {
    return this.buffers.get(sessionId.trim());
  }

  remove(sessionId: string): StreamRenderBuffer | undefined {
    const sid = sessionId.trim();
    const buf = this.buffers.get(sid);
    if (buf) {
      this.buffers.delete(sid);
    }
    return buf;
  }

  clearAll(): void {
    for (const buf of this.buffers.values()) {
      buf.reset();
    }
    this.buffers.clear();
  }
}
```

在 `useRunStreamingAssistant.ts` 中废弃 `renderBufferRef` 单例，改用：
```ts
const sessionBuffersRef = useRef<SessionStreamBufferPool>(new SessionStreamBufferPoolImpl());
```
在流启动时：
```ts
const buffer = sessionBuffersRef.current.getOrCreate(sid);
buffer.reset();
```

#### 根治 DEF-11：双缓冲原子交接与微任务塌陷根除

现存代码在 `helpers.ts:242` 中使用 `queueMicrotask(() => clearStream(sessionId, messageId))`，在微任务阶段清除流式热缓冲，此时 React 18 并发渲染管线尚未完成 DOM Paint，导致文本塌陷闪白。

**原子交接协议（Handover Protocol）**：
1. 先更新 `sessionStore.messages`，设置目标 assistant 消息的最终完整 `text`、`blocks` 和 `toolCalls`，并标记 `status: 'completed'`；
2. **禁止使用 `queueMicrotask` 提前擦除**；
3. 使用双帧锁定（`requestAnimationFrame`）或由视图层组件监听状态变更：当检测到 `sessionStore.messages` 中该消息已变为终态且本地真实 DOM 挂载生效后，再通知 `streamingStore.clearStream(sessionId, messageId)`；
4. 在视图层实现无缝过渡：
   ```ts
   // apps/crish-desktop/src/components/chat-message/streamMessageViewModel.ts
   const persistentMsg = sessionMessagesById.get(messageId);
   const streamText = useStreamingStore((s) => s.streams[sessionId]?.[messageId]?.text);

   // 只要持久消息已有有效正文且处于完成态，优先且立即锚定持久文本，热缓冲退场不造成塌陷
   const displayText = (persistentMsg?.status === 'completed' && persistentMsg.text)
     ? persistentMsg.text
     : (streamText ?? persistentMsg?.text ?? '');
   ```

---

### 2.3 会话时间线对象不可变性与深克隆契约

#### 根治 DEF-13 & DEF-17：消除引用逃逸与类型契约漏洞

在 `apps/crish-desktop/src/store/types.ts` 中清理重复声明：
- 彻底删除第 225-244 行的残缺 `MessageImageRef` 声明，仅保留并统一导出完备接口：
  ```ts
  export interface MessageImageRef {
    id: string;
    source: string;
    kind: 'local' | 'http' | 'data' | 'svg' | 'unsafe';
    resolvedUrl?: string;
    status?: 'pending' | 'resolved' | 'error';
    mime?: string;
    alt?: string;
    originToolCallId?: string;
    byteSize?: number;
    width?: number;
    height?: number;
  }
  ```

#### 结构化深克隆入库（Deep Clone Invariant）
在 `sessionInjectionMount.ts` 与 `sessionSharedHelpers.messageMerge.ts` 中，外部传入的数据结构必须经过结构性深拷贝才能写入 Immer draft：

```ts
/**
 * 安全深克隆工具，保证对象不可变性与引用完全隔离
 */
export function deepCloneTimelineItem<T>(item: T): T {
  if (item === null || typeof item !== 'object') return item;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(item);
    } catch {
      // 回退至 JSON 序列化（针对非克隆对象）
    }
  }
  return JSON.parse(JSON.stringify(item)) as T;
}
```

在 `appendInjectionToMessage` 与 `makeInjectionCarrierMessage` 中强制执行：
```ts
// sessionInjectionMount.ts
const safeInjection: MessageContextInjection = deepCloneTimelineItem(injection);

// 挂载到 blocks 时同样赋予独立深拷贝，杜绝 blocks[i].injection 与 injections[j] 共享指针
const block: MessageTimelineBlock = {
  type: 'context_injection',
  id: safeInjection.id,
  injection: deepCloneTimelineItem(safeInjection),
};
```

---

## 三、会话并发隔离与取消事务控制

### 3.1 会话作用域显式绑定与全局盲读拔除

#### 根治 DEF-02：`finalizeStopGeneration` 显式寻址重构

修改 `useStreamCallbacks.ts` 中的 `finalizeStopGeneration` 接口签名，全面剔除全局动态抓取：

```ts
/**
 * 停止生成收口函数（强制会话寻址）
 * @param force 是否强制终止
 * @param targetSessionId 明确的目标会话 ID。若未提供，严禁从全局猜测，拒绝执行
 */
export const finalizeStopGeneration = (force: boolean, targetSessionId?: string | null): void => {
  const sid = (targetSessionId || '').trim();
  if (!sid) {
    console.warn('[StreamCallbacks] finalizeStopGeneration refused: missing explicit targetSessionId');
    return;
  }

  // 1. 从隔离的 streamManager 中获取目标会话的运行实例
  const cur = streamManagerRef.current?.get(sid);
  if (!cur) {
    // 目标会话当前无活跃流任务，安全 early-return，绝不波及其他会话
    return;
  }

  // 2. 清理目标会话活跃标记
  streamManagerRef.current.delete(sid);
  generationMapRef.current.delete(sid);

  // 3. 从会话隔离缓冲池取得专属 buffer
  const stopBuf = sessionBuffersRef.current.get(sid);
  stopBuf?.flushFinal();
  sessionBuffersRef.current.remove(sid); // 消费并清理

  // 4. 获取目标会话真实当前正文
  const stopBufFull = stopBuf?.currentText() ?? '';
  const partialText =
    stopBufFull ||
    getStreamText(sid, cur.assistantMsgId) ||
    buildMessageIndex(getSessionById(sid)).get(cur.assistantMsgId)?.text ||
    '';
  const stopText = (partialText || '').trim();

  // 5. 严格限定于 sid 下发 commit
  commitStreamToolsToSession(sid, cur.assistantMsgId);
  if (stopText) {
    commitStreamToSession(sid, cur.assistantMsgId, { text: stopText });
  }

  // 6. 若被停止的会话恰好是当前屏幕展示的活跃会话，才更新活跃 UI 标记
  if (getCompositionRoot().session.getActiveSessionId() === sid) {
    markStreamingActive(false);
  }
};
```

---

### 3.2 取消状态机（Cancellation State Machine）与原子守卫

#### 根治 DEF-08：消除 IPC 监听器泄漏与死 Run 强推

在 `apps/crish-desktop/src/api/chat-bridge/streamSession.ts` 中，建立完整的生命周期状态机：

```
[IDLE] ──► [CONNECTING] ──► [PREPARING] ──► [TASK_STARTING] ──► [RUNNING] ──► [TERMINATING] ──► [CLEANED]
   │             │               │                 │                 │                ▲
   └─────────────┴───────────────┴─────────────────┴─────────────────┴────────────────┘
                                  (用户取消 / 错误 / 窗口关闭)
```

**双重注册防御与统一清理守卫**：
```ts
// streamSession.ts
export async function streamSession(
  transport: ChatTransport,
  options: StreamSessionOptions,
  callbacks: StreamSessionCallbacks
): Promise<StreamCancelHandle> {
  const state: StreamRunState = {
    cancelled: false,
    finished: false,
    runClosed: false,
    unsub: null,
  };

  const safeCleanup = () => {
    state.cancelled = true;
    state.finished = true;
    state.runClosed = true;
    if (state.unsub) {
      try {
        state.unsub();
      } catch (e) {
        console.error('[streamSession] unsub failed', e);
      }
      state.unsub = null;
    }
  };

  try {
    // 门禁检查 1
    if (isRunDead(state)) {
      safeCleanup();
      return { cancel: safeCleanup };
    }

    state.unsub = transport.onMessage(onMessage);

    // 异步加载期间：任何一次 await 恢复后，必须再次核查死态
    const { getWorkspacePath } = await import('../projectStore');
    if (isRunDead(state)) {
      safeCleanup();
      return { cancel: safeCleanup };
    }

    const { clientApi } = await import('../clientApi');
    // ...
    const body = await loadSessionBody(safeSessionId);
    if (isRunDead(state)) {
      safeCleanup();
      return { cancel: safeCleanup };
    }

    // 关键门禁检查点：在 startRunTask 下发的前 1 行执行物理强校验！
    if (isRunDead(state)) {
      safeCleanup();
      return { cancel: safeCleanup };
    }

    // 正式启动底层任务
    await startRunTask(transport, runTaskPayload);
  } catch (err) {
    safeCleanup();
    throw err;
  }

  return { cancel: safeCleanup };
}
```

#### 根治 DEF-09：异常路径孤儿卡片回滚事务机制

当用户消息发送前派发了可见卡片（例如 `/skill`、`/goal`、`/grill-me`），若后续消息排队失败或网络离线，执行完整事务回滚：

```ts
// apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts
const transactionInjectedCardIds: string[] = [];

try {
  // 1. 派发卡片时记录生成的 Card ID
  if (resolvedSkill) {
    const cardId = dispatchSkillContextCard(targetSessionId, resolvedSkill, prompt);
    if (cardId) transactionInjectedCardIds.push(cardId);
  }

  // 2. 尝试执行消息入库与发送
  const enqueued = await enqueueChatMessage(targetSessionId, userMessage);
  if (!enqueued) {
    throw new Error('ENQUEUE_FAILED');
  }
} catch (error) {
  // 3. 触发事务回滚：清理该批次生成的所有孤儿卡片
  if (transactionInjectedCardIds.length > 0) {
    useSessionStore.getState().removeInjectionsByIds(targetSessionId, transactionInjectedCardIds);
  }
  rollbackOptimisticMessage(workspaceId, targetSessionId, userMessageId);
  restoreDraftOnFailure(targetSessionId, setChatInput, rawInput);
  setPickerInlineError('发送失败，已自动回滚并保留输入');
}
```

---

### 3.3 草稿态（Draft Mode）向真实会话晋升的原子迁移事务

#### 根治 DEF-07：`contextStatePending.ts` 草稿态晋升与会话强隔离

重构 `contextStatePending.ts` 内部存储协议：
1. **彻底废除模块全局变量 `lastRecordedSignature`**，全部收敛进 `Map<sessionId, string>`；
2. **废除共享单键 `crish_pending_context_state_v1`**，所有键强制加上 `sessionId` 后缀；
3. **引入草稿态暂存自动晋升（Promote）协议**：

```ts
// apps/crish-desktop/src/api/provider-profiles/contextStatePending.ts

const PENDING_PREFIX = 'crish_pending_context_state:';
export const DRAFT_SESSION_KEY = '__pending_draft__';

const lastSignaturesBySession = new Map<string, string>();

function getStorageKey(sessionId: string): string {
  return `${PENDING_PREFIX}${sessionId.trim()}`;
}

/**
 * 将草稿态的暂存状态原子迁移给新建的真实会话 ID
 */
export function promoteDraftContextState(realSessionId: string): void {
  try {
    const draftKey = getStorageKey(DRAFT_SESSION_KEY);
    const draftRaw = localStorage.getItem(draftKey);
    if (!draftRaw) return;

    // 写入真实会话键并移除草稿键
    const realKey = getStorageKey(realSessionId);
    localStorage.setItem(realKey, draftRaw);
    localStorage.removeItem(draftKey);

    // 同步签名映射
    const draftSig = lastSignaturesBySession.get(DRAFT_SESSION_KEY);
    if (draftSig) {
      lastSignaturesBySession.set(realSessionId, draftSig);
      lastSignaturesBySession.delete(DRAFT_SESSION_KEY);
    }
  } catch {
    /* swallow-ok */
  }
}

/**
 * 消费指定会话的上下文切换快照（取走即焚）
 */
export function takePendingContextState(targetSessionId: string): ContextStatePayload | undefined {
  const sid = (targetSessionId || '').trim();
  if (!sid) return undefined;

  const key = getStorageKey(sid);
  try {
    let raw = localStorage.getItem(key);
    // 容灾检查：若真实会话未命中，尝试检查草稿态并自动迁移消费
    if (!raw && sid !== DRAFT_SESSION_KEY) {
      const draftKey = getStorageKey(DRAFT_SESSION_KEY);
      raw = localStorage.getItem(draftKey);
      if (raw) {
        localStorage.removeItem(draftKey);
      }
    } else if (raw) {
      localStorage.removeItem(key);
    }

    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as ContextStatePayload;
    // 清空该会话内存签名，允许后续重新选择同配置时再次触发暂存
    lastSignaturesBySession.delete(sid);
    return parsed;
  } catch {
    return undefined;
  }
}
```

在 `useSlashSend.ts:100` 生成真实会话 ID 时：
```ts
const realSessionId = resolveTargetSessionId(activeSessionId, rawInput);
if (isDraftSession(activeSessionId)) {
  promoteDraftContextState(realSessionId);
}
```

---

## 四、存储事务生命周期与防抖/刷盘可靠机制

### 4.1 根治清空消息“僵尸复活”断层（`clearSessionMessages` 事务闭环）

#### 根治 DEF-03：区分“懒加载空壳”与“真实空会话”

在 `SessionState` 中引入显式标志位 `messagesHydrated: boolean`：

```ts
export interface SessionState {
  id: string;
  title: string;
  messages: SessionMessage[];
  /** 标记该会话是否已经完成从底层 SQLite/Engine 的消息回灌 */
  messagesHydrated?: boolean;
  // ...
}
```

在持久化核心 `apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts` 中，重构正文保存调度判定：

```ts
// sessionRustDbHydrate.ts
for (const s of list) {
  if (!s?.id) continue;
  keepIds.add(s.id);

  const msgs = (s.messages || []).map((m) =>
    m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
  );

  // 核心改动：
  // 1. 若 msgs.length > 0：正常保存正文
  // 2. 若 msgs.length === 0 且 s.messagesHydrated === true（表明不是未水合的懒壳，而是被用户显式清空或真实新建空会话）
  //    必须向 Rust/SQLite 下发 saveSessionBody(s.id, [], batchVersion)，物理清空底层数据库记录！
  const shouldSaveBody =
    !isHydrateTruncated(s) &&
    (msgs.length > 0 || s.messagesHydrated === true);

  if (shouldSaveBody) {
    bodyJobs.push(saveSessionBody(s.id, msgs, batchVersion));
  }
  bodyJobs.push(saveSessionAgents(s.id, s.agents || []));
}
```

在 `sessionStateActions.ts` 中：
```ts
clearSessionMessages: (sessionId: string) =>
  set((state) => {
    const sess = getSessionForWrite(state, sessionId);
    if (!sess) return;
    sess.messages = [];
    sess.messagesHydrated = true; // 显式置为已水合空状态
    state.sessionsById[sessionId] = sess;
  }),
```
**时序闭环**：内存设为 `[]` -> `messagesHydrated: true` -> 持久化层识别为合法空集 -> 向 SQLite 下发 `saveSessionBody(id, [])` -> 数据库执行 `DELETE FROM session_messages WHERE session_id = ?`。用户按 F5 刷新或重启，由于数据库已清空，彻底根除僵尸复活。

---

### 4.2 SQLite 与 localStorage 双写一致性与防撕裂协议

#### 根治 DEF-05 & DEF-14：消除索引先写而正文脱节的时间差漏洞

现存流程：同步写入 localStorage 索引 -> 延迟 350ms 异步排队写 SQLite 正文。若在此窗口内崩溃或刷新，产生 `hydrate-degraded-index-body-mismatch` 错误。

**双写一致性架构方案**：
1. **事务版本号（Transaction Epoch / Version）**：
   每次持久化批次生成单调递增的 `batchVersion: number`。
2. **镜像原子配对（Pairing Contract）**：
   在写入 localStorage 索引时，不得直接写入全局主索引键，必须携带该批次的 `batchVersion`；
3. **两阶段提交模拟（2PC Simulation）**：
   ```
   [Store State Change]
           │
           ▼
   [Enqueue Persistence Batch] (生成 batchVersion = N)
           │
           ├──────────────────────────────┐
           ▼ (1. 异步主写入)               ▼ (2. 写入预备镜像)
   [SQLite IPC saveSessionBody]    [LS Staging Key: crish_session_index_staging_N]
           │                              │
           ▼                              ▼
   [SQLite 写入成功]              [等待 SQLite 完成]
           │                              │
           └──────────────┬───────────────┘
                          │
                          ▼ (3. 终态提交)
           [LS 正式生效: crish_session_index_v1 = N]
           [清除 staging 键]
   ```
4. **回水水合校验（Hydrate Guard）**：
   当应用启动调用 `hydrateSessionsFromRust` 时，以 SQLite 数据库中的消息状态作为权威真理源。如果 localStorage 索引版本超前于 SQLite 实际内容（表明上次发生了写入中断崩溃），自动以 SQLite 实情修正本地索引，消除死壳会话。

---

### 4.3 持久化防抖算法升级：Trailing Debounce + MaxWait 饥饿阻断

#### 根治 DEF-06：`store-persistence.ts` 防抖重构

现存代码使用裸 `clearTimeout`，高频输入导致写入无限延迟。必须引入包含 `maxWait`（最大等待时间）的稳健防抖器：

```ts
/**
 * 具备 maxWait 保证的防抖持久化调度器
 */
export class DebouncedPersistenceManager {
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayMs: number;
  private readonly maxWaitMs: number;
  private readonly flushFn: () => Promise<void> | void;
  private isBusy = false;
  private hasPendingDirty = false;

  constructor(options: {
    delayMs: number;
    maxWaitMs: number;
    flushFn: () => Promise<void> | void;
  }) {
    this.delayMs = options.delayMs;
    this.maxWaitMs = options.maxWaitMs;
    this.flushFn = options.flushFn;
  }

  schedule(): void {
    this.hasPendingDirty = true;

    // 1. 常规 trailing timer：每次变更重置
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
    }
    this.waitTimer = setTimeout(() => {
      this.triggerFlush();
    }, this.delayMs);

    // 2. maxWait timer：首次标记 dirty 时启动，到达阈值前绝对不清除
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        this.triggerFlush();
      }, this.maxWaitMs);
    }
  }

  async triggerFlush(): Promise<void> {
    this.cancelTimers();
    if (!this.hasPendingDirty || this.isBusy) return;

    this.isBusy = true;
    this.hasPendingDirty = false;
    try {
      await this.flushFn();
    } catch (e) {
      console.warn('[PersistenceManager] flush failed', e);
      // 失败标记重新补挂
      this.hasPendingDirty = true;
    } finally {
      this.isBusy = false;
      // 若在执行期间又产生了新变更，重新调度
      if (this.hasPendingDirty) {
        this.schedule();
      }
    }
  }

  private cancelTimers(): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }

  /** 紧急同步/立即刷盘 */
  flushImmediateSync(syncFlushFn: () => void): void {
    this.cancelTimers();
    this.hasPendingDirty = false;
    try {
      syncFlushFn();
    } catch (e) {
      console.error('[PersistenceManager] immediate sync flush error', e);
    }
  }
}
```

**参数配置**：
- `delayMs = 350`（常规防抖延时）
- `maxWaitMs = 1500`（最大容忍饥饿阈值，保证 1.5 秒内必须发生一次实际落盘）

---

### 4.4 窗口卸载（`beforeunload`）与异常崩溃的应急同步刷盘

#### 根治 DEF-06：`beforeunload` 链路可靠性补齐

在桌面 WebView2 宿主中，`window.addEventListener('beforeunload')` 无法等待异步 IPC 完成。为此设计双轨保障：
1. **内存同步封存到 LocalStorage 紧急恢复区**：
   ```ts
   // apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts
   export const CRISH_EMERGENCY_RECOVERY_KEY = 'crish_emergency_recovery_dump_v1';

   export function emergencySyncFlush(storeState: SessionStoreState): void {
     try {
       const dump = {
         timestamp: Date.now(),
         activeSessionId: storeState.activeSessionId,
         sessions: storeState.sessions.map((s) => ({
           id: s.id,
           title: s.title,
           messages: s.messages,
           agents: s.agents,
         })),
       };
       localStorage.setItem(CRISH_EMERGENCY_RECOVERY_KEY, JSON.stringify(dump));
       // 执行原有索引与正文同步镜像
       persistAllSessionsSyncViaLocalStorage(storeState.sessions, storeState.activeSessionId, storeState.folderOrder);
     } catch (e) {
       console.error('[EmergencyFlush] failed', e);
     }
   }
   ```
2. **应用下一次冷启动时的补灌恢复（Crash Recovery Boot Cycle）**：
   在 `ensureMigrated()` 阶段，检测是否存在 `CRISH_EMERGENCY_RECOVERY_KEY`。若存在且时间戳比 SQLite 最后修改时间更新，触发紧急修复协程，将紧急快照内的正文通过 `saveSessionBody` 重新写入 SQLite，完成后清除该恢复键。

---

## 五、会话 CRUD 状态机收敛与悬垂指针防护

### 5.1 `deleteSession` 原子焦点转移与空指针防御

#### 根治 DEF-04：原子收敛焦点，彻底消除白屏

重构 `apps/crish-desktop/src/store/sessionCrudActions.ts` 中的 `deleteSession`：

```ts
deleteSession: (sessionId: string) => {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return false;

  let removed = false;
  let nextActiveIdToSwitch: string | null = null;

  set((state) => {
    // 1. 检查被删除的是否为当前活跃会话
    const isDeletingActive = state.activeSessionId === id;

    if (isDeletingActive) {
      // 计算相邻会话以实现平滑焦点转移
      const currentIdx = state.sessions.findIndex((s) => s.id === id);
      if (currentIdx !== -1) {
        // 优先右邻居，其次左邻居
        const candidate = state.sessions[currentIdx + 1] || state.sessions[currentIdx - 1];
        nextActiveIdToSwitch = candidate ? candidate.id : null;
      }
    }

    // 2. 物理从索引中移除
    removed = deleteSessionFromIndexed(state, id);
    if (!removed) return;

    dropTerminalForSession(state, id);

    // 3. 关键：若是活跃会话被删除，在同一次 set 原子事务中转移焦点！
    if (isDeletingActive) {
      state.activeSessionId = nextActiveIdToSwitch || '';
      // 若没有剩余会话，进入欢迎草稿态，绝不残留悬垂 ID
      if (!nextActiveIdToSwitch) {
        state.isDraft = true;
      }
    }
  });

  if (removed) {
    sessionRuntimeRegistry.remove(id);
    clearMessageSnapshots(id);
    useStreamingStore.getState().clearSession(id);

    // 同步关闭工作区 Shell 中的对应 Tab
    try {
      const shell = useWorkspaceShellStore.getState();
      shell.closeSessionTab(id);
    } catch {
      /* swallow-ok */
    }
  }

  return removed;
}
```

---

### 5.2 `renameSession` 与工作区标签树（WorkspaceShellStore）的双向原子同步

#### 根治 DEF-14：标题脱节彻底消除

在 `sessionCrudActions.ts:202` 中，会话重命名成功后必须触发 Tab 标题联动：

```ts
renameSession: (sessionId: string, title: string) =>
  set((state) => {
    const sess = getSessionForWrite(state, sessionId);
    if (!sess) return;
    const next = normalizeWritableSessionTitle(title);
    if (!next || sess.title === next) return;

    sess.title = next;
    state.sessionsById[sessionId] = sess;

    // 联动同步 Tab 标题
    try {
      const shell = useWorkspaceShellStore.getState();
      shell.syncTabTitle(sessionId, next);
    } catch {
      /* swallow-ok */
    }
  }),
```

---

### 5.3 会话创建防碰撞算法与空壳会话精确剪枝

#### 根治 DEF-15：废除 `Date.now()`，引入强唯一 ID 生成

在 `sessionCrudActions.ts:253` 中：
- 废弃 `const id = explicitId || 'sess-' + Date.now();`；
- 改用强随机唯一标识：
  ```ts
  import { nanoid } from 'nanoid';
  const id = explicitId || `sess-${Date.now()}-${nanoid(8)}`;
  ```
- **精确剪枝**：在 `pruneEmptyShellsInPlace` 中，只清除在当前窗口且未被任何 Tab 打开过的匿名纯空壳，严禁跨 Workspace 或误杀多 Tab 占位会话。

---

### 5.4 懒水合时间戳保真（根治侧栏跳变）

#### 根治 DEF-16：禁止篡改历史时间戳

在 `sessionCrudActions.ts:441-451` 中：
```ts
// 错误旧代码：
// s.timestamp = nowIsoTimestamp();

// 正确重构：保持历史会话原本的物理时间戳不变！
if (res.messages.length > 0) {
  s.messages = mergeMessagesById(s.messages || [], res.messages);
  // 保持现有 s.timestamp，绝不强行覆盖为 nowIsoTimestamp()
  // 仅当原始 timestamp 完全为空时，以最后一条消息的时间戳兜底
  if (!s.timestamp) {
    const lastMsg = s.messages[s.messages.length - 1];
    s.timestamp = lastMsg?.timestamp ? new Date(lastMsg.timestamp).toISOString() : nowIsoTimestamp();
  }
}
```

---

## 六、渲染管道与派生状态性能收敛

### 6.1 `useScopedSessionField` 纯函数重构与 `Object.is` 浅比对

#### 根治 DEF-10：消除 5 重 `forceUpdate` 级联重渲染风暴

重构 `apps/crish-desktop/src/components/chat-card/useScopedSessionField.ts`：
1. 严禁在 React 渲染函数执行过程中修改 `cacheRef.current`；
2. 订阅触发时执行 `Object.is(oldValue, newValue)` 比对，值未变绝对不触发 `forceUpdate`：

```ts
// useScopedSessionField.ts
export function useScopedSessionField<T>(
  sessionId: string,
  selector: (session: SessionState | undefined) => T,
  equalityFn: (a: T, b: T) => boolean = Object.is
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const equalityRef = useRef(equalityFn);
  equalityRef.current = equalityFn;

  const [, forceRender] = useReducer((s: number) => (s + 1) | 0, 0);

  // 纯读当前状态
  const session = useSessionStore((s) => s.sessionsById[sessionId]);
  const currentValue = selector(session);
  const valueRef = useRef<T>(currentValue);

  // 仅在 useEffect 阶段更新缓存或订阅更新
  useEffect(() => {
    valueRef.current = currentValue;
  });

  useEffect(() => {
    const unsub = useSessionStore.subscribe((state) => {
      const targetSession = state.sessionsById[sessionId];
      const nextValue = selectorRef.current(targetSession);
      if (!equalityRef.current(valueRef.current, nextValue)) {
        valueRef.current = nextValue;
        forceRender();
      }
    });
    return unsub;
  }, [sessionId]);

  return currentValue;
}
```
**收益**：流式推送 Chunk 时，`useChatMessages` 中订阅的 `agents`、`hydratedFromEngine`、`engineCursor` 等字段全部通过 `Object.is` 短路阻断，单次 Chunk 从 5 次重渲染锐减至 1 次精确重渲染，CPU 占用下降 70% 以上。

---

### 6.2 派生消息列表与动作透传完备化

#### 根治 DEF-18 & DEF-19：
1. **`useChatMessageState.ts` 补齐 `toolStackProps` 动作插槽**：
   在 `toolStackProps` useMemo 中完整注入 `renderLinkedAgentPanel`、`onRetryTool`、`onToggleInjection` 等回调，切断下游内联裸构；
2. **`handleRegenerateRow` 反向倒查真源修正**：
   反向倒查寻找上一轮 user prompt 时，强制遍历 `allMessages`（全量会话历史），严禁遍历经过关键词过滤后的 `displayMessages`：
   ```ts
   // useChatMessageState.ts
   const handleRegenerateRow = useCallback((assistantMsgId: string) => {
     // 使用全量历史消息 allMessages 进行拓扑回溯！
     const msgs = allMessagesRef.current || messagesRef.current;
     const idx = msgs.findIndex((m) => m.id === assistantMsgId);
     if (idx === -1) return;

     let userText = '';
     for (let i = idx - 1; i >= 0; i--) {
       const m = msgs[i];
       if (m && m.sender === 'user') {
         userText = m.text || '';
         break;
       }
     }
     // ... 发起重新生成
   }, []);
   ```

---

### 6.3 会话级局部状态按 SessionId 隔离与跟随销毁 GC

在 `useChatMessageState.ts` 中：
- `expandedToolsBySession`、`expandedUserMsgsBySession` 以及 `dismissedFollowUps` 必须以 `sessionId` 为第一级 Key 嵌套存储；
- 监听 `sessionStore` 的删除事件，当某会话被销毁时，自动从这些 Record 中删除对应条目，释放内存。

---

### 6.4 可访问性（A11y）状态机逻辑死代码拔除

#### 根治 DEF-12：读屏逻辑与首帧白屏修复

在 `apps/crish-desktop/src/components/chat-card/useChatEmptyKind.ts` 中：
1. **修复 `chatRegionAria` 逻辑优先级**：
   ```ts
   const chatRegionAria =
     mainSurface === 'scheduled'
       ? '定时任务'
       : messagesLoading
         ? '正在加载会话消息' // 优先播报正在加载
         : emptyKind
           ? chatEmptyKindAriaLabel(emptyKind)
           : '对话主区';
   ```
2. **首帧超时状态重置优化**：
   废除 `useEffect` 异步重置 `hydrateTimedOut`，在 Render 阶段利用会话 ID 变更自动重置：
   ```ts
   const [prevSessionId, setPrevSessionId] = useState(activeSessionId);
   if (prevSessionId !== activeSessionId) {
     setPrevSessionId(activeSessionId);
     setHydrateTimedOut(false); // 渲染阶段直接修正，消除 1 帧延迟与白屏
   }
   ```

---

## 七、纯逻辑依赖与自底向上实施步骤（Pure Logical Steps）

整个实施流程由纯技术架构依赖驱动，严格按自底向上的顺序展开：

```
[步骤 1: 类型与契约净化] (消灭同名冲突, 统一接口)
         │
         ▼
[步骤 2: 会话流式缓冲池] (Map<sessionId, StreamRenderBuffer> & 会话寻址 stop)
         │
         ▼
[步骤 3: 取消状态机闭环] (streamSession 监听器回收 & 拦截强推)
         │
         ▼
[步骤 4: 存储层事务闭环] (清空消息下发 SQLite, 根除僵尸复活)
         │
         ▼
[步骤 5: 防抖与刷盘重构] (maxWait 饥饿阻断 & beforeunload 紧急镜像)
         │
         ▼
[步骤 6: 会话 CRUD 状态机] (deleteSession 焦点收敛防崩溃 & 标题同步)
         │
         ▼
[步骤 7: 渲染与订阅性能净化] (useScopedSessionField 纯化 & 动作透传补齐)
```

### 步骤 1：底层类型契约与深克隆工具落地
- **目标文件**：
  - `apps/crish-desktop/src/store/types.ts`
  - `apps/crish-desktop/src/store/sessionInjectionMount.ts`
  - `apps/crish-desktop/src/store/sessionSharedHelpers.messageMerge.ts`
- **逻辑内容**：
  - 删除多余的 `MessageImageRef` 重复定义，统一为包含完整尺寸信息的单一接口；
  - 引入 `deepCloneTimelineItem`，在注入挂载和合并时对外部对象与数组强制深拷贝，保证 Immer draft 与 React.memo 的不可变性契约。

### 步骤 2：会话流式缓冲池与显式停止寻址落地
- **目标文件**：
  - `apps/crish-desktop/src/hooks/chat-stream/useRunStreamingAssistant.ts`
  - `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts`
- **逻辑内容**：
  - 剔除单例 `renderBufferRef`，实现 `SessionStreamBufferPool`（`Map<sessionId, StreamRenderBuffer>`）；
  - `finalizeStopGeneration` 增加 `targetSessionId` 显式参数，未提供或不匹配时拒绝执行，根治跨会话窜写与停止误杀。

### 步骤 3：流式会话取消状态机与异常回滚落地
- **目标文件**：
  - `apps/crish-desktop/src/api/chat-bridge/streamSession.ts`
  - `apps/crish-desktop/src/hooks/chat-stream/useSlashSend.ts`
  - `apps/crish-desktop/src/api/provider-profiles/contextStatePending.ts`
- **逻辑内容**：
  - 在 `streamSession.ts` 中每一个 `await` 之后建立 `isRunDead(state)` 强校验，在 `startRunTask` 执行前绝对拦截已取消的 Run；
  - 实现 `promoteDraftContextState`，支持草稿态向真实会话的原子暂存迁移；
  - 发送异常时自动回滚预派发的上下文注入卡片。

### 步骤 4：持久化存储层事务闭环与防僵尸复活落地
- **目标文件**：
  - `apps/crish-desktop/src/store/sessionStateActions.ts`
  - `apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts`
- **逻辑内容**：
  - 会话引入 `messagesHydrated` 标记；
  - `clearSessionMessages` 时将 `messagesHydrated` 置为 `true`，`persistAllSessionsRust` 检测到空消息但已水合时，显式下发 `saveSessionBody(id, [])`，同步清空 SQLite。

### 步骤 5：持久化防抖算法（MaxWait）与应急同步刷盘落地
- **目标文件**：
  - `apps/crish-desktop/src/store/layout-helpers/store-persistence.ts`
  - `apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts`
- **逻辑内容**：
  - 实现 `DebouncedPersistenceManager`，设置 350ms trailing 与 1500ms maxWait；
  - 在 `beforeunload` 中执行 `emergencySyncFlush`，封存完整内存快照到 localStorage 并在下次冷启动时比对修复。

### 步骤 6：会话 CRUD 状态机收敛与焦点安全落地
- **目标文件**：
  - `apps/crish-desktop/src/store/sessionCrudActions.ts`
- **逻辑内容**：
  - `deleteSession` 删除当前活跃会话时，原子计算并切换至相邻会话或进入空草稿态，杜绝 `useActiveSession()` 悬垂报错；
  - `renameSession` 原子同步 `workspaceShellStore` 标签栏；
  - 懒水合历史消息严格保留原有时间戳，禁止赋为当前时刻。

### 步骤 7：渲染订阅管道纯化与动作插槽补齐
- **目标文件**：
  - `apps/crish-desktop/src/components/chat-card/useScopedSessionField.ts`
  - `apps/crish-desktop/src/components/chat-message-list/useChatMessageState.ts`
  - `apps/crish-desktop/src/components/chat-card/useChatEmptyKind.ts`
- **逻辑内容**：
  - 重构 `useScopedSessionField`，消灭渲染期突变 Ref，增加 `Object.is` 校验阻断无效 `forceUpdate`；
  - `handleRegenerateRow` 倒查全量 `allMessages`；
  - 修复 `chatRegionAria` 优先级，拔除无障碍死代码与首帧白屏闪烁。

---

## 八、立体化验证契约与全景测试断言

按照 Conex 立体验证纪律，交付方案必须包含穷举式的测试断言，覆盖并发、切换、持久化与崩溃恢复等极限场景：

### 8.1 单元测试断言清单（Unit Test Assertions）

#### 套件 1：流式缓冲会话隔离与停止寻址测试
- **测试文件**：`apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.test.ts`
- **断言内容**：
  1. `assert(bufferPool.get('sess-A') !== bufferPool.get('sess-B'))`：会话 A 与会话 B 的缓冲实例严格隔离；
  2. 会话 A 正在向 buffer 写入文本 `"Hello from A"`，此时会话 B 启动生成；
  3. 调用 `finalizeStopGeneration(true, 'sess-A')`；
  4. 断言：`commitStreamToSession` 接收到的参数中，`sessionId === 'sess-A'` 且 `text === 'Hello from A'`；
  5. 断言：会话 B 的缓冲器完好无损，后续会话 B 结束时正文内容不包含任何会话 A 的字符（**Zero Cross-Session Bleed**）。

#### 套件 2：清空消息持久化与防僵尸复活测试
- **测试文件**：`apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.test.ts`
- **断言内容**：
  1. 初始化带有 5 条消息的会话 `sess-1`，触发 `persistAllSessionsRust`，断言 `saveSessionBody` 被调用且消息数为 5；
  2. 调用 `clearSessionMessages('sess-1')`，此时 `sess.messages.length === 0`，`sess.messagesHydrated === true`；
  3. 再次触发 `persistAllSessionsRust`；
  4. 断言：`saveSessionBody` **必须被调用**，参数为 `('sess-1', [], batchVersion)`；
  5. 模拟重新从 SQLite 读取，断言返回的 messages 为 `[]`，无任何旧消息复活。

#### 套件 3：删除会话原子焦点转移与悬垂指针防护测试
- **测试文件**：`apps/crish-desktop/src/store/sessionCrudActions.test.ts`
- **断言内容**：
  1. 创建 3 个会话 `['sess-1', 'sess-2', 'sess-3']`，当前活动会话为 `sess-2`；
  2. 调用 `useSessionStore.getState().deleteSession('sess-2')`；
  3. 断言：`state.sessionsById['sess-2']` 变为 `undefined`；
  4. 断言：`state.activeSessionId` **自动原子变为 `'sess-3'`**（右邻居优先）；
  5. 断言：调用 `useActiveSession()` 返回 `sess-3` 实体，无任何 `undefined` 抛出；
  6. 删除最后一个唯一的会话，断言 `state.activeSessionId === ''` 且 `state.isDraft === true`，界面进入安全空草稿态。

#### 套件 4：防抖持久化最大等待（MaxWait）阻断测试
- **测试文件**：`apps/crish-desktop/src/store/layout-helpers/store-persistence.test.ts`
- **断言内容**：
  1. 实例化 `DebouncedPersistenceManager`，配置 `delayMs = 350`, `maxWaitMs = 1500`；
  2. 模拟高频操作：每隔 200ms 调用一次 `manager.schedule()`，持续 2000ms；
  3. 断言：在第 1500ms 时，`flushFn` **必须被强制触发一次**，彻底阻断饥饿推迟；
  4. 断言：总触发次数至少为 2 次，保障数据落地。

#### 套件 5：`useScopedSessionField` 性能与重渲染抑制测试
- **测试文件**：`apps/crish-desktop/src/components/chat-card/useScopedSessionField.test.ts`
- **断言内容**：
  1. 挂载 Hook 订阅 `session.engineCursor`；
  2. 连续分发 10 次 `sessionStore` 更新，每次仅改动 `session.messages`，保持 `engineCursor` 数值不变；
  3. 断言：Hook 内部的 `forceRender` 触发次数为 **0**，组件重渲染次数为 **0**。

---

### 8.2 集成测试与状态机压力断言（Integration & Chaos Assertions）

#### 场景 1：多会话交替快速切换与并发取消（Cross-Switch Race Condition）
- **步骤**：
  1. 在会话 A 中输入长 Prompt 并发送；
  2. 200ms 后切换到会话 B，输入 Prompt 发送；
  3. 立即切回会话 A 点击停止，再切到会话 B；
- **断言**：
  - 会话 A 正确截断并保留停机前生成的文本，无会话 B 内容；
  - 会话 B 继续正常流式输出，不受会话 A 停机指令影响；
  - 检查 IPC 监听器注册表，已停机的会话 A 监听器数量为 0。

#### 场景 2：草稿态首条消息模型状态注入全链路（Draft Mode Promotion Integration）
- **步骤**：
  1. 处于欢迎空草稿态（`activeSessionId === '__pending_draft__'`）；
  2. 用户在顶栏将模型切换为 `Claude-3.5-Sonnet`，思考档位设为 `High`；
  3. 用户输入并发送首条消息；
- **断言**：
  - 新生成的真实会话 ID 成功继承该暂存配置；
  - 发送给 Rust 引擎的 `startRunTask` 载荷中 `contextState` 明确包含 `Claude-3.5-Sonnet`；
  - 新建会话时间线上出现一张带有正确模型信息的系统环境卡片。

#### 场景 3：窗口卸载（beforeunload）与冷启动崩溃恢复（Crash Recovery Integration）
- **步骤**：
  1. 在会话中快速添加 3 条消息；
  2. 在 350ms 防抖尚未触发的第 50ms 强制触发 `window.dispatchEvent(new Event('beforeunload'))`；
  3. 模拟进程终止并模拟冷启动执行 `ensureMigrated()`；
- **断言**：
  - 启动阶段成功从 `CRISH_EMERGENCY_RECOVERY_KEY` 检测到未刷盘快照；
  - 3 条最新消息被完好回灌并同步入 SQLite；
  - 会话消息总数与崩溃前完全一致，数据损失量为 0。

---

### 8.3 门禁检查与质量守门契约

执行以下刚性门禁指令，必须实现全绿灯通过：
```bash
# 1. 静态类型守门（零类型错误，彻底解决重复声明）
npm run typecheck

# 2. 消息流与持久化相关单元测试
npx vitest run apps/crish-desktop/src/hooks/chat-stream apps/crish-desktop/src/api/session-persistence apps/crish-desktop/src/store

# 3. 代码行数与解耦门禁
npm run check:line-counts
```
