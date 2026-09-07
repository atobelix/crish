# 会话存储与CRUD数据竞态缺陷审计报告

## 一、会话串线与异步回调跨会话污染缺陷

### 【DEF-SESS-01】单例 `renderBufferRef` 跨会话生成被覆盖导致停止操作将外部会话正文窜写进目标会话
- **【代码文件与精确行号】**：
  - `apps/crish-desktop/src/hooks/chat-stream/useRunStreamingAssistant.ts:150-151`
  - `apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:71-76, 82, 99-108`
- **【断层事实】**
  ```typescript
  // useRunStreamingAssistant.ts:150-151
  const buffer = new StreamRenderBuffer();
  renderBufferRef.current = buffer;
  buffer.reset();
  ```
  ```typescript
  // useStreamCallbacks.ts:82, 99-108
  const stopBuf = renderBufferRef.current;
  // ...
  const stopBufFull = stopBuf?.currentText() ?? '';
  const partialText =
    stopBufFull ||
    getStreamText(sid, cur.assistantMsgId) ||
    buildMessageIndex(getSessionById(sid)).get(cur.assistantMsgId)?.text ||
    '';
  const stopText = (partialText || '').trim();
  commitStreamToolsToSession(sid, cur.assistantMsgId);
  if (stopText) {
    commitStreamToSession(sid, cur.assistantMsgId, { text: stopText });
  ```
  `renderBufferRef` 是整个聊天流共享的单例 Ref（`MutableRefObject<StreamRenderBuffer | null>`）。当会话 A 正处于流式生成阶段，用户分屏或切换至会话 B 发送新请求时，`useRunStreamingAssistant` 再次执行 `renderBufferRef.current = buffer`，直接无条件覆盖单例句柄。此时用户切回会话 A 并触发停止生成（`finalizeStopGeneration`），`stopBuf` 取得的是会话 B 正在生成的 buffer 实例，`stopBuf.currentText()` 读出会话 B 的文字内容，随后在 `commitStreamToSession(sid, cur.assistantMsgId, { text: stopText })` 中，以会话 A 的 `sid` 将会话 B 的生成文本写入并持久化落盘。
- **【危害后果 / 真实运行期隐患】**
  致命的跨会话数据污染（会话串线）。会话 A 的助手消息被会话 B 的代码与文字覆盖，且该错误数据经过持久化直接污染本地数据库，破坏用户会话数据的真实性与隔离性。

---

### 【DEF-SESS-02】`finalizeStopGeneration` 盲目读取全局 `getActiveSessionId()` 导致停止指令定向错位与误杀
- **【代码文件与精确行号】**：`apps/crish-desktop/src/hooks/chat-stream/useStreamCallbacks.ts:71-79`
- **【断层事实】**
  ```typescript
  const finalizeStopGeneration = (force: boolean) => {
    const sid = resolveStreamSessionId(
      null,
      getCompositionRoot().session.getActiveSessionId()
    );
    if (!sid) return;
    const cur = streamManagerRef.current!.get(sid);
    if (!cur) return;
    streamManagerRef.current!.delete(sid);
  ```
  停止生成的入口函数未接受具体目标 `sessionId` 参数，而是通过 `getCompositionRoot().session.getActiveSessionId()` 动态解析。
- **【危害后果 / 真实运行期隐患】**
  当后台会话 A 正在生成长文本时，用户切到会话 B 查看代码。此时用户使用快捷键或点击全局停止，由于当前活动会话为 B，`sid` 判定为 B。若会话 B 未处于生成态，逻辑直接 early-return，后台会话 A 无法停止并持续空耗 Token；若会话 B 此时存在后台任务或定时任务，则会发生误杀，终止了无关会话。

---

### 【DEF-SESS-03】`triggerSessionMessageHydrateIfNeeded` 异步回包无条件重写时间戳引发侧栏乱序跳变
- **【代码文件与精确行号】**：`apps/crish-desktop/src/store/sessionCrudActions.ts:441-451`
- **【断层事实】**
  ```typescript
  void hydrateSessionMessagesFromEngine(sessionId).then((res) => {
    if (!res.ok) return;
    setter((draft) => {
      const s = getSessionForWrite(draft, sessionId);
      if (!s) return;
      if (res.messages.length > 0) {
        s.messages = mergeMessagesById(
          s.messages || [],
          res.messages
        );
        s.timestamp = nowIsoTimestamp();
        s.timestampSource = 'remote';
        maybeAutoTitleSession(draft, s);
  ```
  在点击会话触发懒水合（Lazy Hydrate）拉取正文时，网络回包后无视该会话真实最后消息时间，强制执行 `s.timestamp = nowIsoTimestamp()`。
- **【危害后果 / 真实运行期隐患】**
  用户仅是通过侧栏查看一个历史遗留会话，一旦触发正文水合，该会话的时间戳被立即覆写为当前系统物理时间。侧栏基于 `timestamp` 倒序排列，导致该旧会话在用户点击瞬间突然跳跃至列表首位，引发侧栏会话视图剧烈抖动与排序错乱。

---

### 【DEF-SESS-04】`setActiveSessionId` 异步动态加载项目上下文缺乏并发撤销引发工作区状态撕裂
- **【代码文件与精确行号】**：`apps/crish-desktop/src/store/sessionCrudActions.ts:172-176`
- **【断层事实】**
  ```typescript
  void import('../api/projectStore').then(
    ({ activateWorkspaceForSessionFolder }) => {
      activateWorkspaceForSessionFolder(sess.folder);
    }
  );
  ```
  会话切换时通过非阻塞 `import()` 异步加载 `projectStore` 并切换关联项目工作区。该异步 Promise 没有任何序列标识、取消令牌（AbortController）或竞态守卫。
- **【危害后果 / 真实运行期隐患】**
  当用户在不同项目归属的会话（例如属于 `Project_A` 的会话 1 和属于 `Project_B` 的会话 2）之间快速切换时，后发起的切换可能先执行完毕，先发起的动态 import 延迟完成回调。最终 `activateWorkspaceForSessionFolder` 以后执行的旧回调为准，导致界面处于会话 2，但全局项目工作区却错误停留于 `Project_A`，发生工作区面板与会话上下文的严重撕裂。

---

## 二、消息挂载注入与对象引用泄露/渲染失灵缺陷

### 【DEF-SESS-05】`appendInjectionToMessage` 与 `makeInjectionCarrierMessage` 裸挂外部对象破坏不可变性与 Memo 判定
- **【代码文件与精确行号】**：`apps/crish-desktop/src/store/sessionInjectionMount.ts:138, 174-177, 190, 196-204, 214-225`
- **【断层事实】**
  ```typescript
  // sessionInjectionMount.ts:193-205
  const existingBlock = msg.blocks.find(
    (b) => b.type === 'context_injection' && b.id === injection.id
  );
  if (existingBlock) {
    existingBlock.injection = injection;
  } else {
    const block: MessageTimelineBlock = {
      type: 'context_injection',
      id: injection.id,
      injection,
    };
    msg.blocks.push(block);
  }
  ```
  ```typescript
  // sessionInjectionMount.ts:214-225
  return {
    id: carrierId,
    sender: 'assistant',
    text: '',
    timestamp: injection.timestamp,
    injections: [injection],
    blocks: [
      { type: 'context_injection', id: injection.id, injection },
    ],
  };
  ```
  外部传入的 `injection: MessageContextInjection` 未经任何结构性克隆（Deep Clone），直接被引用赋值到 `msg.injections` 和 `block.injection`。此外，`msg.injections[i]` 与 `msg.blocks[j].injection` 共享同一个底层内存对象指针。
- **【危害后果 / 真实运行期隐患】**
  1. 调用方若在外部直接修改 `injection` 属性（如就地更新 `status: 'injected'` 或改写 `metadata`），绕过了 Immer 与 Zustand 的派发通道，产生不受控的隐式内存突变。
  2. UI 渲染层（如 `ContextInjectionCard`）依赖 `React.memo` 基于属性浅比较（`prev.injection === next.injection`）优化性能。由于对象内存地址完全相同，组件判定为无变化而跳过更新，导致卡片状态（等待中/生效中/失败）无法在屏幕上同步重绘。

---

### 【DEF-SESS-06】context-state 原地更新时 injections 与 blocks 内部合并逻辑分叉导致数据真理源撕裂
- **【代码文件与精确行号】**：`apps/crish-desktop/src/store/sessionInjectionMount.ts:124-132, 150-165`
- **【断层事实】**
  ```typescript
  // 针对 msg.injections 的合并
  const prevInj = msg.injections[existingIdx];
  const mergedMetadata = {
    ...(prevInj?.metadata || {}),
    ...(injection.metadata || {}),
  };
  msg.injections[existingIdx] = {
    ...prevInj,
    ...injection,
    metadata: mergedMetadata,
  };
  // ...
  // 针对 msg.blocks 的合并
  const prevBlock = msg.blocks[existingBlockIdx];
  const prevInj = prevBlock?.injection;
  const mergedInj: MessageContextInjection = {
    ...(prevInj || injection),
    ...injection,
    metadata: {
      ...(prevInj?.metadata || {}),
      ...(injection.metadata || {}),
    },
  };
  msg.blocks[existingBlockIdx] = {
    ...prevBlock,
    type: 'context_injection',
    id: injection.id,
    injection: mergedInj,
  };
  ```
  对同一条消息中的状态元数据更新时，`msg.injections` 基于数组元素合并，而 `msg.blocks` 基于时间线块独立进行对象构造。
- **【危害后果 / 真实运行期隐患】**
  若历史数据中存在属性不对称（例如 blocks 曾由其他辅助函数补丁过额外字段），此逻辑使 `msg.injections` 与 `msg.blocks[...].injection` 各自生成互相冲突的独立对象。序列化落盘与时间线视图渲染分别读取不同字段源，产生双重真理源撕裂。

---

### 【DEF-SESS-07】`addContextInjection` 载体消息剪枝使用 `indexOf` 与贪婪 `splice` 破坏时间线完整性
- **【代码文件与精确行号】**：`apps/crish-desktop/src/store/sessionCrudActions.ts:363-375`
- **【断层事实】**
  ```typescript
  const targetIdx = sess.messages.indexOf(target);
  if (targetIdx > 0) {
    let pruneStart = targetIdx;
    while (
      pruneStart > 0 &&
      isContextStateCarrierMessage(sess.messages[pruneStart - 1])
    ) {
      pruneStart--;
    }
    if (pruneStart < targetIdx) {
      sess.messages.splice(pruneStart, targetIdx - pruneStart);
    }
  }
  ```
  当 `target` 是通过 `findInjectionMountTarget` 命中的进行中助手消息（`status === 'processing'`），该逻辑向前扫描并直接通过 `sess.messages.splice` 物理剔除所有连续载体消息。
- **【危害后果 / 真实运行期隐患】**
  1. 在 Immer draft 环境下，若 `target` 历经任何引用重组，`sess.messages.indexOf(target)` 极易返回 `-1`，导致清理逻辑在复杂时序下直接失效。
  2. 此物理删除未经过 `saveMessageSnapshot` 快照记录，未留下审计痕迹，使得被删除的状态载体消息彻底丢失，破坏撤回（withdraw）机制的重放一致性。

---

## 三、会话 CRUD 状态转移与并发竞态缺陷

### 【DEF-SESS-08】`deleteSession` 纯数据删除未收敛 `activeSessionId` 导致前端组件空指针崩溃
- **【代码文件与精确行号】**：`apps/crish-desktop/src/store/sessionCrudActions.ts:304-315`
- **【断层事实】**
  ```typescript
  deleteSession: (sessionId: string) => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return false;
    let removed = false;
    set((state) => {
      removed = deleteSessionFromIndexed(state, id);
      if (!removed) return;
      dropTerminalForSession(state, id);
      // 纯数据面：只删目标。不拿 sessions[] 邻居覆盖画面，也不在删除路径
      // prune 邻居空壳（那会把未打开的历史会话一并 GC）。画面由
      // shell.deleteSessionAndCloseTab → syncSessionFromActiveLeaf 校正。
    });
  ```
  `deleteSession` 将会话从 `sessions` 数组及 `sessionsById` 映射中删除，但故意不对 `state.activeSessionId` 进行转移或收敛。
- **【危害后果 / 真实运行期隐患】**
  当外部通过快捷键、命令面板、右键清理或自动化通道直接调用 `useSessionStore.getState().deleteSession(activeId)`（而非走 shell 的封装）时，`state.activeSessionId` 依然指向已被销毁的会话 ID。此时 `useActiveSession()` 导出 `undefined`，主界面视图读取 `activeSession.messages` 立即抛出 `TypeError: Cannot read properties of undefined`，直接触发 React 全页白屏崩溃。

---

### 【DEF-SESS-09】`renameSession` 未与 Workspace Shell 标签树同步导致 UI 标签栏标题永久撕裂
- **【代码文件与精确行号】**：`apps/crish-desktop/src/store/sessionCrudActions.ts:202-211`
- **【断层事实】**
  ```typescript
  renameSession: (sessionId: string, title: string) =>
    set((state) => {
      const sess = getSessionForWrite(state, sessionId);
      if (!sess) return;
      const next = normalizeWritableSessionTitle(title);
      if (!next) return;
      if (sess.title === next) return;
      sess.title = next;
      state.sessionsById[sessionId] = sess;
    }),
  ```
  `renameSession` 仅更新了 `sessionStore` 内部的实体对象，既未通知 `workspaceShellStore.syncOpenTabTitles`，也未调用 `treeUpdateTabTitle` 更新布局树节点。
- **【危害后果 / 真实运行期隐患】**
  用户重命名会话后，顶部 Tab 标签依然显示旧标题。当后续发生 Tab 切换或调用 `syncSessionFromActiveLeaf` 时，由于 Tab 实体持有的老标题未更新，老标题可能被重新写回会话，导致重命名操作被逆向覆盖。

---

### 【DEF-SESS-10】`createSession` 时间戳生成 ID 碰撞且空壳剪枝误伤并发邻居标签
- **【代码文件与精确行号】**：`apps/crish-desktop/src/store/sessionCrudActions.ts:241-261`
- **【断层事实】**
  ```typescript
  const id = explicitId || `sess-${Date.now()}`;
  set((state) => {
    const existing = getSessionById(state, id);
    if (existing) {
      const prevActive = state.activeSessionId;
      // ...
      pruneEmptyShellsInPlace(
        state,
        shellPruneKeepIds(id, prevActive, { activating: activate })
      );
      return;
    }
  ```
  1. 在高并发调用（例如导入多个外部会话或脚本连续创建）时，依赖毫秒级 `Date.now()` 生成 ID 导致生成完全相同的会话 ID。
  2. 一旦命中 `existing`，执行第 257 行的 `pruneEmptyShellsInPlace`，无差别将除当前活跃会话外的所有其它空壳会话（例如在多标签页中打开的空白待输入 Tab）全部强制物理清除。
- **【危害后果 / 真实运行期隐患】**
  并发创建导致会话 ID 冲突并相互吞并。更严重的是触发对其它窗口或 Tab 空壳的误杀，导致用户在多 Tab 间准备工作的草稿与占位直接丢失。

---

### 【DEF-SESS-11】`commitDraftIfNeeded` 与 `promoteDraftTab` 缺乏事务原子性导致草稿态死循环
- **【代码文件与精确行号】**：
  - `apps/crish-desktop/src/store/sessionDraftActions.ts:98-123`
  - `apps/crish-desktop/src/store/workspace-shell/workspaceShellStore.ts:86-108, 321-336`
- **【断层事实】**
  ```typescript
  // sessionDraftActions.ts:115-123
  const id = createSessionFn({
    ...(opts?.title !== undefined ? { title: opts.title } : {}),
    folder,
    activate: true,
  });
  recordDraftCommit();
  return id;
  ```
  ```typescript
  // workspaceShellStore.ts:99-107
  if (isPendingDraft(tab.sessionId)) {
    session.enterDraftMode(tab.workspaceKey, {
      draftSessionId: tab.sessionId,
    });
    return;
  }
  ```
  `commitDraftIfNeeded` 仅在 `sessionStore` 内部创建并激活了真实会话 ID（`sess-xxx`），但无法原子同步更新 `workspaceShellStore` 的 Tab 树（当前 Tab 依然记录为 `draft-xxx`）。
- **【危害后果 / 真实运行期隐患】**
  在用户发送消息提交草稿后，若外部组件在调用 `promoteDraftTab` 之前发生任何重新渲染或窗口焦点切换，`syncSessionFromActiveLeaf` 立即被触发。它读出当前 Tab 仍然是 `draft-xxx`，强行执行 `session.enterDraftMode`，把刚刚创建的真会话从活动态踢出，用户界面瞬间被重置回欢迎草稿页，呈现消息“发送后消失并重置”的恶性体验。

---

## 四、本地持久化脱节、防抖丢失与非原子事务缺陷

### 【DEF-SESS-12】`clearSessionMessages` 内存清空后持久化层拒绝写入导致被清消息“僵尸复活”
- **【代码文件与精确行号】**：
  - `apps/crish-desktop/src/store/sessionStateActions.ts:93-100`
  - `apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:264-266`
- **【断层事实】**
  ```typescript
  // sessionStateActions.ts:93-100
  clearSessionMessages: (sessionId: string) =>
    set((state) => {
      const sess = getSessionForWrite(state, sessionId);
      if (!sess) return;
      if (!sess.messages?.length) return;
      sess.messages = [];
      state.sessionsById[sessionId] = sess;
    }),
  ```
  ```typescript
  // sessionRustDbHydrate.ts:264-266
  if (msgs.length > 0 && !isHydrateTruncated(s)) {
    bodyJobs.push(saveSessionBody(s.id, msgs, batchVersion));
  }
  ```
  清空消息 action 将 `sess.messages` 设为空数组 `[]`。但在底层持久化 `persistAllSessionsRust` 中，第 264 行硬编码约束：`if (msgs.length > 0) ...`，直接跳过对该会话调用 `saveSessionBody`。
- **【危害后果 / 真实运行期隐患】**
  用户清空会话消息后，前端内存虽然为空，但 SQLite 数据库中的历史正文由于未下发保存而**完好保留**。用户一旦按 F5 刷新或重启应用，系统从 SQLite 重新回灌，已经被用户清空的消息全部原地复活，产生极其严重的持久化不同步。

---

### 【DEF-SESS-13】`persistAllSessionsRust` 采用 `Promise.allSettled` 并发批量持久化导致半成功脏状态
- **【代码文件与精确行号】**：`apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:257-270, 289-292`
- **【断层事实】**
  ```typescript
  for (const s of list) {
    // ...
    if (msgs.length > 0 && !isHydrateTruncated(s)) {
      bodyJobs.push(saveSessionBody(s.id, msgs, batchVersion));
    }
    bodyJobs.push(saveSessionAgents(s.id, s.agents || []));
  }
  await Promise.allSettled(bodyJobs);
  // ...
  if (keepIds.size > 0) {
    await cleanupOrphanSessions(Array.from(keepIds));
  }
  ```
  批量会话持久化缺乏事务包装，拆分成几十个并发的细粒度 IPC 调用，并使用 `Promise.allSettled` 静默吞掉个别错误。
- **【危害后果 / 真实运行期隐患】**
  若某个会话因数据序列化异常或数据库行锁超时失败，其它会话依然写入，且无任何事务回滚机制。更恶劣的是，紧接着执行的 `cleanupOrphanSessions` 依然以全部 `keepIds` 为基准运行，导致数据库处于部分会话丢正文、部分会话丢 agents 的严重撕裂状态。

---

### 【DEF-SESS-14】索引优先写 localStorage 与正文异步写 SQLite 产生时间差撕裂
- **【代码文件与精确行号】**：
  - `apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:228-235, 257-270`
  - `apps/crish-desktop/src/store/layout-helpers/store-persistence.ts:154-167`
- **【断层事实】**
  ```typescript
  // sessionRustDbHydrate.ts:228-235
  if (options?.sessionsToIndex) {
    try {
      const entries = options.sessionsToIndex(list);
      lsSaveSessionIndex(entries);
    } catch {
      /* swallow-ok */
    }
  }
  // 随后才执行异步 IPC 写入 SQLite 正文
  ```
  持久化启动时，前端首先同步将索引写入 localStorage，之后才通过 `enqueuePersist` 排队向 SQLite 发起 IPC 写入会话正文。整个过程叠加了 350ms 的防抖时延。
- **【危害后果 / 真实运行期隐患】**
  若用户在此时间差内刷新页面，`hydrateSessionsFromRust` 启动时首先从 localStorage 读取到了最新索引（包含新建会话与消息计数），但随后向 SQLite 查询该会话正文时却返回空，直接触发 `hydrate-degraded-index-body-mismatch` 错误，导致会话变成无法加载内容的死壳。

---

### 【DEF-SESS-15】`beforeunload` 同步持久化未覆盖 SQLite 造成刷新前夕改动丢失
- **【代码文件与精确行号】**：`apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:362-426`
- **【断层事实】**
  ```typescript
  export function persistAllSessionsSyncViaLocalStorage(
    // ...
  ): void {
    // 仅同步写入 localStorage，完全无法触及 SQLite
  ```
  在页面卸载与关闭事件（`beforeunload`）中，由于无法执行异步 IPC，系统仅调用了 `persistAllSessionsSyncViaLocalStorage` 写入 localStorage。
- **【危害后果 / 真实运行期隐患】**
  若用户在关闭或刷新窗口前刚刚进行了编辑，改动仅进入了 localStorage。若下一次应用从 SQLite 全量加载，或者用户在多窗口模式中开启，SQLite 中完全没有这批最后改动，导致关窗前的改动永久丢失。

---

### 【DEF-SESS-16】持久化 350ms 防抖机制在高频操作下导致写入饥饿与异常崩溃数据丢失
- **【代码文件与精确行号】**：`apps/crish-desktop/src/store/layout-helpers/store-persistence.ts:154-167`
- **【断层事实】**
  ```typescript
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const cur = store.getState();
      void persistAllSessions(
        cur.sessions,
        cur.activeSessionId,
        cur.folderOrder
      );
    } catch (e) {
      console.warn('[sessionPersistence] save failed', e);
    }
  }, 350);
  ```
  对 Store 的每次订阅触发都重置 350ms 定时器（`clearTimeout`），缺乏最大等待阈值（Max Wait Timeout）保障。
- **【危害后果 / 真实运行期隐患】**
  在高频更新场景下，持久化被不断推迟（Starvation），长达数秒乃至数十秒无法真正落盘。若应用在此期间遭遇崩溃、强制退出或进程被操作系统杀死，最后阶段的所有 CRUD 改动荡然无存。

---

## 五、架构断层、物理文件缺失与类型契约漏洞

### 【DEF-SESS-17】审计文件 `activeWorkspaceState.ts` 物理缺失且 `workspaceStore.ts` 伪门面脱节未监听
- **【代码文件与精确行号】**：`apps/crish-desktop/src/store/workspaceStore.ts:2-5, 49-75`
- **【断层事实】**
  ```typescript
  // workspaceStore.ts:2-5
  * 工作区域 facade — 与 useLayoutStore **同一 zustand 实例**（非独立 create）。
  // workspaceStore.ts:49-55
  export const useWorkspaceStore = create<WorkspaceStore>()(
    withDevtools(
      withPersist(
        immer((set, get) => ({
          workspaces: _initialWorkspaces,
          activeWorkspaceIndex: clampActiveWorkspaceIndex(_initialWorkspaces, 0),
          tabModeEnabled: useLayoutStore.getState().tabModeEnabled,
  ```
  1. 需求指定的 `apps/crish-desktop/src/store/activeWorkspaceState.ts` 文件在代码仓库中物理缺失，相关状态与操作散落在 `workspaceStore.ts` 与 `workspaceActionsCore.ts`。
  2. `workspaceStore.ts` 头部注释声称“与 useLayoutStore 同一 zustand 实例”，但第 49 行明确通过 `create<WorkspaceStore>()` 建立了独立实例。第 55 行在初始化时仅单次读取了 `useLayoutStore.getState().tabModeEnabled`，后续从未建立任何订阅或监听。
- **【危害后果 / 真实运行期隐患】**
  严重的架构宣称与实现事实背离。当用户在布局层通过 `layoutStore.setTabModeEnabled` 切换模式时，`workspaceStore` 中的 `tabModeEnabled` 永远停留在初始化值，依赖它的所有工作区和标签页逻辑获取到过期甚至相反的状态，产生界面渲染错乱。

---

### 【DEF-SESS-18】`types.ts` 重复声明 `MessageImageRef` 引发类型声明合并陷阱
- **【代码文件与精确行号】**：`apps/crish-desktop/src/store/types.ts:225-244, 270-293`
- **【断层事实】**
  ```typescript
  // types.ts:225-244
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
  }
  // ...
  // types.ts:270-293
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
  在同一公共类型文件内重复两次导出同名 `interface MessageImageRef`，且字段定义不一致（后一次多了 `width` 与 `height`）。
- **【危害后果 / 真实运行期隐患】**
  滥用 TypeScript 接口声明合并，造成类型契约定义模棱两可。开发者维护时极易误判字段可用范围，未来若仅重构其中一处，将造成无声的编译盲区与运行期字段丢失。

---

### 【DEF-SESS-19】`sessionSharedHelpers.messageMerge.ts` 复杂嵌套数组直接引用赋值
- **【代码文件与精确行号】**：`apps/crish-desktop/src/store/sessionSharedHelpers.messageMerge.ts:239-243, 264-276`
- **【断层事实】**
  ```typescript
  if (incoming.toolCalls !== undefined) {
    if (incoming.toolCalls.length > 0 || !existing.toolCalls?.length) {
      existing.toolCalls = incoming.toolCalls;
    }
  }
  // ...
  if (incoming.blocks !== undefined) {
    if (incoming.blocks.length > 0 || !existing.blocks?.length) {
      existing.blocks = incoming.blocks;
    }
  }
  ```
  在合并消息时，对 `toolCalls` 和 `blocks` 这类富引用数组直接执行引用赋值，未进行浅拷贝（`slice()` / `[...arr]`）或深拷贝。
- **【危害后果 / 真实运行期隐患】**
  外部网络回包或上游数据流持有的数组指针被直接内联到 Store。一旦上游后续对该数组执行任何就地操作（如清空或压入新对象），会直接无预警破坏 Store 内保存的历史记录，导致数据状态失控。
