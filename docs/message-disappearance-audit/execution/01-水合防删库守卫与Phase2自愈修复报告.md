# 01 — 水合防删库守卫与 Phase 2 自愈修复报告

> **执行角色**：Task-1 水合防删库守卫、Phase 2 自动自愈与持久化链路修复专员  
> **依据方案**：`docs/message-disappearance-audit/00-总方案.md`、`docs/message-disappearance-audit/audits/02-会话水合与持久化链路断层审计.md`、`docs/message-disappearance-audit/audits/08-启动水合与切会话全生命周期竞态审计.md`  
> **负责文件域**：
>
> 1. `apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts`
> 2. `apps/crish-desktop/src/store/sessionActivateHydrate.ts`
> 3. `apps/crish-desktop/src/store/sessionActivateHydrate.test.ts`
> 4. `apps/crish-desktop/src/store/layout-helpers/store-persistence.ts`
> 5. `apps/crish-desktop/src/api/session-persistence/migrateFromLocalStorage.ts`  
>    **报告时间**：2026-10-12  
>    **遵循纪律**：严格限定 5 个指定文件；严禁 Git 提交（提交权归主控）；测试 100% 通过；UTF-8 无 BOM。

---

## 一、执行概述与核心战果

本次任务针对导致 79 个历史会话消息被物理覆写清空以及切会话无法自愈恢复的核心链路断层，完成了前端持久化与水合状态机的彻底根治与加固。

### 核心战果速览

1. **纠正懒壳判定与建立持久化防删库硬守卫（`sessionRustDbHydrate.ts`）**：
   - 根治了 `isLazySessionShell` 判定反转的历史缺陷：只要 `session.messages?.length > 0` 强行认定为非懒壳；当消息为空且 `messagesHydrated === false` 时，**无条件判定为懒壳**，不再因 `hydratedFromEngine === true` 或 `id === activeSessionId` 误判为非懒壳。
   - 非焦点懒壳在启动构建时严格保持 `messages: [], messagesHydrated: false`，且 `hydratedFromEngine` 标记仅在焦点会话（`isActive`）挂载，彻底阻断向未水合懒壳泄露。
   - 在 `persistAllSessionsRust` 写入循环中注入双重硬守卫：当 `msgs.length === 0 && s.messagesHydrated !== true` 时，**绝对禁止调用 `saveSessionBody` 向 SQLite 写入空数组 `[]`**，物理切断启动删库链路。

2. **Phase 2 引擎事件重放自愈与 SQLite 写回链路落地（`sessionActivateHydrate.ts`）**：
   - 重构 `shouldSkipSessionHydrate`：仅在明确已完成水合且有消息、或明确已水合且已完成引擎重放的真实空会话时跳过；**绝不在未完成水合（`messagesHydrated !== true`）时因 `hydratedFromEngine === true` 误跳过**。
   - 在 `triggerSessionMessageHydrateIfNeeded` 中建立双阶段（Phase 1 本地 SQLite 权威恢复 → Phase 2 引擎事件重放自愈）强保障：当 Phase 1 SQLite 载入为空时，无条件触发 Phase 2 `hydrateSessionMessagesFromEngine`。
   - 当 Phase 2 从 `events` 表成功恢复出历史消息（`engineMessages.length > 0`）时，除更新 Store 外，**立即调用 `saveSessionBody` 写回 SQLite `session_messages` 表**，实现用户点击会话即自动永久物理自愈。
   - 增加错误安全防护：若 Phase 1 IPC 抛错失败且引擎未恢复消息时，严禁置 `messagesHydrated = true`，确保后续激活可再次重试。

3. **解耦循环依赖与补全状态合并（`store-persistence.ts`）**：
   - 修复会话状态合并（merge）时丢失 `messagesHydrated` 标记的隐患，明确补齐 `messagesHydrated: r.messagesHydrated ?? s.messagesHydrated`。
   - 落地 `syncActiveSessionToEmptyLayoutLeaf`：当焦点叶为无 Tab 空态（`tabs.length === 0`）时自动绑定主面板 Tab；采用动态 `import('../layout-tree')` 彻底根除 `store-persistence -> layout-tree -> ... -> store-persistence` 的循环依赖 TDZ 死锁。

4. **终结 Schema Version 争用（`migrateFromLocalStorage.ts`）**：
   - 解决前端 `'3'` 与 Rust 数据库 `'12'` 争用 `schema_version` 的冲突：判定放宽为 `current === '3' || Number(current) >= 3` 即视为已完成迁移，且已有更高版本号时不降级覆写为 `'3'`。

5. **立体化验证 100% 全绿**：
   - 补充并完善 `sessionActivateHydrate.test.ts` 专项测试，**17 项测试 100% 通过**；
   - 持久化相关测试全绿（`migrateFromLocalStorage.test.ts` 7/7、`sessionRustDbHydrateLazy.test.ts` 7/7、`sessionPersistence.test.ts` 38/38）；
   - 全局 TypeScript 类型检查（`npm run typecheck`）零错误。

---

## 二、详细代码修复与机制剖析

### 1. `sessionRustDbHydrate.ts`：懒壳判定与持久化双重守卫

#### 问题根因

启动时前端调用 `hydrateSessionsFromRust` 读取数据库，历史会话仅保留元数据。非活跃会话被赋予 `messages: []` 与 `messagesHydrated: false`。  
但旧版代码因历史混杂逻辑，若会话带有历史遗留的 `hydratedFromEngine: true` 标记，或者会话被选为活跃，`isLazySessionShell` 就会返回 `false`。随后 `persistAllSessionsRust` 判定 `!isLazySessionShell` 为真，误以为这是一个“用户清空了所有消息的正常会话”，向 Rust 数据库发起 `saveSessionBody(id, [], batchVersion)`，直接将 SQLite 中原本保存的数十条历史消息物理覆写清空！

#### 修复实现

1. 修正 `isLazySessionShell`：

```typescript
export function isLazySessionShell(
  session: SessionState,
  activeSessionId?: string | null
): boolean {
  // 1. 若内存中已经有消息，绝非懒壳
  if (Array.isArray(session.messages) && session.messages.length > 0) {
    return false;
  }
  // 2. 消息为空且明确未完成消息水合（messagesHydrated === false）：
  // 无条件判定为懒壳！绝不能因为 hydratedFromEngine === true 或 id === activeSessionId
  // 就误判为非懒壳，否则在切会话或启动批量落盘时会向 Rust 数据库写入空数组 []，
  // 导致历史消息被物理抹除！
  if (session.messagesHydrated === false) {
    return true;
  }
  // 3. 消息为空且未标记 messagesHydrated（undefined / null）：
  // 仅当非焦点且未完成引擎水合时视为懒壳
  if (!session.messages || session.messages.length === 0) {
    return session.id !== activeSessionId && !session.hydratedFromEngine;
  }
  return false;
}
```

2. 在 `hydrateSessionsFromRust` 中杜绝标记泄露：

```typescript
const isTargetActive = Boolean(targetActiveId && session.id === targetActiveId);
return {
  ...session,
  messages: [],
  messagesHydrated: false,
  // 仅活跃会话附加 hydratedFromEngine 提示，非活跃懒壳绝不附加，防止误判
  ...(isTargetActive && session.hydratedFromEngine
    ? { hydratedFromEngine: true }
    : {}),
};
```

3. 在 `persistAllSessionsRust` 中设立物理防空写硬守卫：

```typescript
const msgs = (s.messages || []).map((m) =>
  m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m
);
// 双重硬守卫：消息为空且未明确完成水合（messagesHydrated !== true）时，严禁调用 saveSessionBody 向 SQLite 写入空数组 []
const isUnconfirmedEmptyShell =
  msgs.length === 0 && s.messagesHydrated !== true;
const shouldSaveBody =
  !isUnconfirmedEmptyShell &&
  (msgs.length > 0 || !isLazySessionShell(s, activePersistable));
if (shouldSaveBody && isSessionBodyDirty(s.id, msgs)) {
  bodyJobs.push(
    saveSessionBody(s.id, msgs, batchVersion).then(() =>
      markSessionBodySaved(s.id, msgs)
    )
  );
}
```

---

### 2. `sessionActivateHydrate.ts`：Phase 2 自动重放与写回自愈

#### 问题根因

当会话从懒壳激活时，旧逻辑中的 `shouldSkipSessionHydrate` 仅根据 `sess.hydratedFromEngine === true` 就会直接返回 `true`（跳过水合）。这导致由于历史脏标记存在，用户切换到该会话时，既不读 SQLite，也不读引擎事件，界面永久展示为空白。  
同时，旧版的 Phase 2 即使重放成功，也仅保存在前端内存中，一旦刷新依然是空白。

#### 修复实现

1. 修正 `shouldSkipSessionHydrate`：

```typescript
export function shouldSkipSessionHydrate(sess: SessionState): boolean {
  const hasMessages = Array.isArray(sess.messages) && sess.messages.length > 0;
  // 1. 已明确完成水合且已有消息：跳过
  if (sess.messagesHydrated === true && hasMessages) {
    return true;
  }
  // 2. 本地内存已有消息且非懒壳（messagesHydrated !== false）：跳过（兼容内存新建）
  if (hasMessages && sess.messagesHydrated !== false) {
    return true;
  }
  // 3. 真实空会话：必须【明确已水合】(messagesHydrated === true) 且已完成引擎重放(hydratedFromEngine === true)
  // 绝不能在 messagesHydrated !== true（未完成水合/懒壳/undefined）时因为 hydratedFromEngine === true 跳过！
  if (sess.messagesHydrated === true && sess.hydratedFromEngine === true) {
    return true;
  }
  return false;
}
```

2. 双阶段水合与自动写回自愈：

```typescript
// ── Phase 1：优先从本地 SQLite 恢复权威消息与 agents ────────────────
if (needSqlLoad) {
  try {
    localLoaded = await ensureSessionBodyHydrated(sessionId);
  } catch (err) {
    phase1LoadFailed = true;
    logger.warn('[sessionActivateHydrate] Phase 1 SQLite load failed, fallback to engine', { sessionId, err });
  }

  if (localLoaded.messages.length > 0) {
    set((draft) => {
      // 成功加载本地消息，标记 messagesHydrated = true
      ...
    });
    return;
  }
}

// ── Phase 2：当本地 SQLite 为空时，无条件执行引擎事件重放自愈 ──
if (localLoaded.messages.length === 0) {
  const res = await hydrateSessionMessagesFromEngine(sessionId);
  if (!res || !res.ok) {
    // 引擎回退不可用或失败：若 Phase 1 亦抛错/未成功，严禁置 messagesHydrated = true 锁死重试
    return;
  }

  const engineMessages = res.messages || [];

  // 关键自愈：当 Phase 2 成功重放恢复出消息时，立即写回 SQLite session_messages 表！
  if (engineMessages.length > 0) {
    try {
      await saveSessionBody(sessionId, engineMessages, null);
    } catch (err) {
      logger.warn('[sessionActivateHydrate] Auto-heal writeback to SQLite failed', { sessionId, err });
    }
  } else if (phase1LoadFailed) {
    // Phase 1 失败且引擎无消息，不设 messagesHydrated = true，留待重试
    return;
  }

  set((draft) => {
    // 写入内存并标记 messagesHydrated = true
    ...
  });
}
```

---

### 3. `store-persistence.ts`：状态合并标记保持与动态解耦叶片同步

1. **会话合并补全 `messagesHydrated`**：
   在 `initStorePersistence` 接收到存储返回的会话数据与当前 Store 合并时，保留水合标记：

   ```typescript
   messagesHydrated: r.messagesHydrated ?? s.messagesHydrated,
   ```

2. **`syncActiveSessionToEmptyLayoutLeaf` 动态加载解耦**：
   在启动初始化若发现主活动叶没有任何 Tab 时，主动将活跃会话挂载到该叶：
   ```typescript
   function syncActiveSessionToEmptyLayoutLeaf(
     sessionId: string,
     sessionTitle?: string
   ): void {
     if (!sessionId) return;
     void import('../layout-tree')
       .then((mod: any) => {
         const { useLayoutTreeStore, collectLeaves } = mod;
         const treeState = useLayoutTreeStore?.getState?.();
         const leaves = collectLeaves?.(treeState?.tree?.root) || [];
         const activeLeafId = treeState?.activeLeafId || leaves[0]?.id;
         const activeLeaf = leaves.find((l: any) => l.id === activeLeafId);
         if (activeLeaf && (!activeLeaf.tabs || activeLeaf.tabs.length === 0)) {
           treeState?.openSession?.(sessionId, {
             activeLeafId,
             title: sessionTitle || '',
           });
         }
       })
       .catch(() => {
         /* ignore */
       });
   }
   ```
   此实现采用函数内部动态 `import('../layout-tree')`，彻底斩断了与 `sessionStore` 的静态模块环形依赖，杜绝了 Vitest 和运行时 SSR 中的未初始化访问异常。

---

### 4. `migrateFromLocalStorage.ts`：Schema Version 兼容

```typescript
export async function ensureMigrated(): Promise<void> {
  const current = await getSessionMeta(SCHEMA_VERSION_KEY);
  const curNum = Number(current);
  // 当已有版本为 '3' 或者数值 >= 3（例如 Rust conex-db 的 '12'），直接判定已迁移
  if (current === SCHEMA_VERSION_V3 || (Number.isFinite(curNum) && curNum >= 3)) return;

  ...
  // 写入时同样保护更高版本号不被降级覆盖
  if (!Number.isFinite(curNum) || curNum < 3) {
    await setSessionMeta(SCHEMA_VERSION_KEY, SCHEMA_VERSION_V3);
  }
}
```

---

## 三、立体化测试与验证结果

### 1. 单元测试全量通过

执行命令：

```powershell
npx vitest run apps/crish-desktop/src/store/sessionActivateHydrate.test.ts apps/crish-desktop/src/api/session-persistence/migrateFromLocalStorage.test.ts apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrateLazy.test.ts apps/crish-desktop/src/api/sessionPersistence.test.ts
```

**测试结果**：

- `apps/crish-desktop/src/store/sessionActivateHydrate.test.ts`：**17/17 通过**
  - 覆盖懒水合跳过逻辑、Phase 1 本地加载优先、Phase 2 引擎事件重放自愈、写回 SQLite `saveSessionBody`、Phase 1 抛错防锁死重试、并发 inFlight 防重入、Token 失效撤销等。
- `apps/crish-desktop/src/api/session-persistence/migrateFromLocalStorage.test.ts`：**7/7 通过**
  - 覆盖 v3 / v12 兼容性、迁移幂等、错误处理与 30 天清理机制。
- `apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrateLazy.test.ts`：**7/7 通过**
  - 覆盖活跃优先懒水合、无活跃会话默认行为、空正文不误覆盖。
- `apps/crish-desktop/src/api/sessionPersistence.test.ts`：**38/38 通过**
  - 覆盖全局持久化、降级探测、草稿会话豁免等。

**合计：69 个测试全部通过（0 失败，0 告警）**。

### 2. 全量 TypeScript 编译检查

执行命令：

```powershell
npm run typecheck
```

**结果**：0 编译错误，所有类型契约与模块导入均完全合规。

---

## 四、自检与纪律符合声明

1. **文件范围守则**：仅修改分配的 5 个指定文件，未触碰任何其他文件。
2. **Git 提交纪律**：本任务严格遵循协作纪律，改动均保留在工作区，**未执行任何 Git commit**，等待主 Agent 统筹验证提交。
3. **零补丁与架构收敛**：通过修复状态机条件、补充双重守卫与动态解耦，实现了数据流与水合生命周期的清晰单轨化。
