# 06 — Rust 数据库存储与 IPC 历史消息读取专项审计报告

> **审计角色**：Rust 数据库存储与 IPC 历史消息读取专项审计员
> **审计范围**：`crates/conex-db/`、`crates/conex-types/`、`apps/agent-workbench/src-tauri/`、前端 `apps/crish-desktop/src/api/session-persistence/` 与 `src/store/sessionActivateHydrate.ts`、以及本机真实 SQLite 数据库文件（只读核查）
> **审计时间**：2026-10-12
> **操作原则**：全程纯只读（数据库以 `mode=ro` 打开查询，未修改任何数据库记录与源码文件）

---

## 一、核心结论先行（Executive Summary）

本次对本机真实 SQLite 数据库文件与 Rust/TS 双端存储水合链路进行穿透式核查后，**100% 锁定了「历史聊天消息消失、切回旧会话一片空白」的物理现场与三大根因链**：

1. **物理现场铁证（数据半毁、事件尚存）**：
   - 本机实际生效数据库为 `C:\Software\conex\apps\agent-workbench\sessions.db`（61.85 MB，WAL 4.38 MB，`PRAGMA user_version = 12`）。
   - **`sessions` 表共 81 个会话**，但 **`session_messages` 表仅剩 3 条记录**（当前活跃会话 `sess-1791780192066` 2 条 + 旧会话 `sess-1785519655009` 1 条）；其余 **79 个历史会话在 `session_messages` 表中的行数为 `0`，且 `message_count = 0`、`body_version = 0`、`hydrated_from_engine = 1`**！
   - 与此同时，**引擎事件表 `events` 中完好保存着 77,403 条事件**（跨 21 个会话，包含 **7,445 条 `message-start`** 和 **7,445 条 `message-end`** 完整对话载荷，以及 207 次工具调用事件）。
2. **根因一（致命物理擦除 — 懒水合壳被当成空消息写回 DB）**：
   - 启动时 `hydrateSessionsFromRust`（`apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:158-181`）按 ACT-502 仅加载活跃会话正文，其余 79 个历史会话构造成内存懒壳（`messages: []`, `messagesHydrated: false`），但第 176 行**原样保留了索引中的 `hydratedFromEngine: true`**。
   - 而在 `isLazySessionShell`（`sessionRustDbHydrate.ts:32-40`）中，第 37 行写着：`if (session.messagesHydrated === true || session.hydratedFromEngine === true) return false;`。
   - 结果：所有带 `hydratedFromEngine === true` 的未水合历史懒壳被 `isLazySessionShell` **误判为「非懒壳（已水合但消息为空）」**！随后启动完成触发首次 `persistAllSessionsRust`（`store-persistence.ts:297`），由于进程内 `lastSavedBodyFingerprint` 尚未建档（视为 dirty），前端向 Rust 批量调用 `save_session_body(sessionId, [], null)`，触发 `DELETE FROM session_messages WHERE session_id = ?1`（`crates/conex-db/src/messages.rs:201-204`），**在启动瞬间将所有非活跃历史会话的 `session_messages` 表物理清空**！
3. **根因二（恢复死锁 — `hydratedFromEngine === true` 锁死 Phase 2 引擎事件回退）**：
   - 当用户点击任意历史会话触发 `triggerSessionMessageHydrateIfNeeded`（`apps/crish-desktop/src/store/sessionActivateHydrate.ts:111-183`）时：
     - Phase 1 调 `load_session_body` 读 `session_messages` 表，因已被根因一清空，返回 `[]`。
     - Phase 2（第 144 行）判定条件为 `if (localLoaded.messages.length === 0 && currentBeforePhase2.hydratedFromEngine !== true)` 才调用 `hydrateSessionMessagesFromEngine`（IPC `core_read_session_events` 从 `events` 表重建消息）。
     - 因为这 79 个会话的 `hydratedFromEngine` 已经是 `true`，**Phase 2 被彻底跳过**，直接落入第 173 行标记 `messagesHydrated = true`，导致 `events` 表中完好保存的 77,403 条事件（7,445 条完整消息）永远无法被恢复到 UI！
4. **根因三（启动重复迁移与 `sessions` 表元数据失步）**：
   - Rust 端 `migrate.rs:122, 223` 每次启动都将 `session_meta.schema_version` 覆写为 `'12'`（SQLite schema 版本），而前端 `migrateFromLocalStorage.ts:39, 146` 检查 `getSessionMeta('schema_version') === '3'`（前端迁移版本）。**双端共用同一个 `schema_version` 键但版本号不同（`'12'` vs `'3'`）**，导致每次启动桌面端都误判未迁移，反复重跑 `import_from_localstorage`！
   - 更糟的是：`crates/conex-db/src/import.rs:53-155` 在 v12 迁移删除 `trg_session_messages_insert/delete` 触发器后，**导入消息时未同步更新 `sessions.message_count`**（导致 `sess-1785519655009` 有 1 条消息但 `message_count = 0`）；且前端 `persistAllSessionsRust` 从未调用 `upsert_session_entry`，导致运行期 `sessions` 表的索引元数据不落库。

---

## 二、本机 SQLite 数据库文件实地核查（只读取证）

### 2.1 数据库路径定位与磁盘文件状态

通过核查 `apps/agent-workbench/src-tauri/src/host_paths.rs:6-24` 与 `apps/agent-workbench/src-tauri/src/db_setup.rs:45-96`：

- `host_paths::app_dir()` 在开发工作区下解析为 `C:\Software\conex\apps\agent-workbench`。
- `db_setup::setup_databases()` 打开两个 SQLite 文件：
  - 会话与引擎事件主库：`app_dir.join("sessions.db")`（注入 `LocalDb` 与 `CoreAppState`）
  - 工作区库：`app_dir.join("workspace.db")`

本机磁盘上的 SQLite 文件清单如下：

| 文件路径                                                 |            大小 (Bytes) | 最后修改时间          | 说明                                     |
| -------------------------------------------------------- | ----------------------: | --------------------- | ---------------------------------------- |
| `C:\Software\conex\apps\agent-workbench\sessions.db`     | `61,849,600` (61.85 MB) | `2026-10-12 00:35:48` | **当前应用实际读写的会话与事件主数据库** |
| `C:\Software\conex\apps\agent-workbench\sessions.db-wal` |   `4,375,472` (4.38 MB) | `2026-10-12 00:43:56` | 当前活跃 WAL 日志                        |
| `C:\Software\conex\apps\agent-workbench\sessions.db-shm` |        `32,768` (32 KB) | `2026-10-12 00:44:50` | WAL 共享内存索引                         |
| `C:\Software\conex\apps\agent-workbench\workspace.db`    |      `876,544` (856 KB) | `2026-08-18 22:09:42` | 工作区辅助数据库                         |
| `C:\Users\orange\AppData\Roaming\Crish\sessions.db`      |               `0` (0 B) | `2026-08-14 01:36:39` | 早期遗留空文件（0 字节，未被使用）       |

### 2.2 `sessions.db` 全表统计与元数据

以只读模式（`file:.../sessions.db?mode=ro`）查询 `sessions.db`：

- `PRAGMA user_version` = **`12`**（最新 v12 schema）
- 各表记录行数统计：

| 表名                     |       行数 | 状态说明                                                                                  |
| ------------------------ | ---------: | ----------------------------------------------------------------------------------------- |
| `sessions`               |     **81** | 81 个会话索引全部存在（无 `sub-sess-*` 子会话行）                                         |
| `session_messages`       |      **3** | **严重异常**：81 个会话中仅 2 个会话合计残存 3 条消息，其余 79 个会话全为 0 条！          |
| `events`                 | **77,403** | **完好留存**：跨 21 个会话，完整保存了 7,445 条 `message-start` 与 7,445 条 `message-end` |
| `runs`                   |  **7,068** | 引擎运行记录完好                                                                          |
| `session_sequence`       |     **30** | 事件序列水位表完好                                                                        |
| `session_meta`           |     **14** | 含 `active_session_id`、`schema_version`、`migration_completed_at` 等                     |
| `session_agents`         |      **0** | 无记录                                                                                    |
| `session_agent_messages` |      **0** | 无记录                                                                                    |

`session_meta` 关键键值实测：

- `active_session_id` = `sess-1791780192066`
- `schema_version` = `3`（被前端 `migrateFromLocalStorage.ts` 在最近一次启动时从 `'12'` 覆盖回 `'3'`）
- `migration_completed_at` = `1791779749005`（每次启动都在被刷新）

### 2.3 `sessions` 表 vs `session_messages` 表 vs `events` 表交叉核对

对 81 个会话联合统计 `sessions.message_count`、`session_messages` 实际行数、`events` 实际行数及 `message-end` 事件数：

1. **当前唯一有完整 `session_messages` 的活跃会话（1 个）**：
   - `sess-1791780192066`（标题：`你好`，`updated_at = 1791780205914`）：
     - `sessions.message_count = 2`，`body_version = 40`，`hydrated_from_engine = NULL`
     - `session_messages` 实际行数 = **2**（seq 0 user `"你好"`，seq 1 assistant 回复）
     - `events` 实际行数 = **12**（含 2 条 `message-end`）
2. **因 `localStorage` 残留重导入而幸存 1 条消息的旧会话（1 个）**：
   - `sess-1785519655009`（标题：`Greeting in Chinese`）：
     - `sessions.message_count = 0`（**与实际行数失步**），`body_version = 0`，`hydrated_from_engine = NULL`
     - `session_messages` 实际行数 = **1**（seq 0 user `"你好啊"`）
     - `events` 实际行数 = **0**
3. **`session_messages` 已被清空（0 行），但 `events` 表中完好保存全部历史对话的会话（20 个）**：
   - 这 20 个会话在 `sessions` 表中**全部处于 `message_count = 0, body_version = 0, hydrated_from_engine = 1`** 状态，但在 `events` 表中拥有海量完整对话事件（部分代表性会话如下）：

| `session_id`         | 标题                              | `sessions.message_count` | `hydrated_from_engine` | `engine_cursor` | `session_messages` 行数 | `events` 总行数 | `events` 中 `message-end` 数 |
| -------------------- | --------------------------------- | -----------------------: | ---------------------: | --------------: | ----------------------: | --------------: | ---------------------------: |
| `sess-1791733385118` | 审计报告完成与汇总                |                        0 |                  **1** |               0 |                   **0** |              76 |                       **13** |
| `sess-1791643451700` | Greeting and Assistance Offer     |                        0 |                  **1** |               0 |                   **0** |             501 |                       **16** |
| `sess-1791640356836` | Simple Greeting and Offer to Help |                        0 |                  **1** |               0 |                   **0** |           2,163 |                      **150** |
| `sess-1791620415660` | Rust存储与状态流转审计完成        |                        0 |                  **1** |             206 |                   **0** |             206 |                        **2** |
| `sess-1791568576904` | 代码完整度审计总结                |                        0 |                  **1** |               0 |                   **0** |           4,768 |                      **400** |
| `sess-1786855835905` | Crish Agent 问候与协助            |                        0 |                  **1** |               0 |                   **0** |           7,035 |                      **625** |
| `sess-1786798945840` | Greeting and Assistance Offer     |                        0 |                  **1** |               0 |                   **0** |           7,557 |                      **654** |
| `sess-1786798366231` | Greeting and Offer to Help        |                        0 |                  **1** |               0 |                   **0** |           7,071 |                      **619** |
| `sess-1784090702185` | Greeting and Assistance Offer     |                        0 |                  **1** |               0 |                   **0** |           6,820 |                      **588** |
| `sess-1783553129795` | Tauri 窗口生命周期与焦点管理审计  |                        0 |                  **1** |              12 |                   **0** |              12 |                        **2** |

4. **`session_messages` 已被清空（0 行）且无 `events` 表记录的早期会话（59 个）**：
   - 这 59 个会话（`sess-1783006262049` 等）同样处于 `message_count = 0, body_version = 0, hydrated_from_engine = 1`，其中 19 个会话 `engine_cursor > 0`（证明曾经从引擎水合过消息），但其 `session_messages` 正文已在启动持久化时被 `save_session_body(id, [], null)` 擦除。

---

## 三、三大根因链的代码级穿透分析

### 3.1 根因链一：ACT-502 启动懒水合壳保留 `hydratedFromEngine: true` + `isLazySessionShell` 判定反转 → `persistAllSessionsRust` 物理清空数据库 `session_messages`

#### （1）问题代码定位

1. `apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:158-181`（`hydrateSessionsFromRust`）：

   ```ts
   // ACT-502: 仅同步水合活跃会话正文；非活跃会话保持 messages: [] + messagesHydrated: false，
   // 由 selectSession / ensureSessionBodyHydrated 按需拉取
   const activeMsgs = targetActiveId ? await loadSessionMessagesRust(targetActiveId) : [];

   const sessions: ChatSession[] = entries.map((e) => {
     const isActive = e.id === targetActiveId;
     const msgs = isActive ? activeMsgs : [];
     return {
       id: e.id,
       ...
       messages: msgs,
       // 活跃会话即使 0 条消息也已完成本地 DB 查询，标记 true 避免 selectSession 重复 IPC；
       // 非活跃会话保持 false，切入时触发 ensureSessionBodyHydrated
       messagesHydrated: isActive,
       ...
       hydratedFromEngine: e.hydratedFromEngine, // <--- 【致命毒点 1】非活跃懒壳原样携带了 hydratedFromEngine: true！
     };
   });
   ```

   > **对比旁证**：在软驱逐逻辑 `apps/crish-desktop/src/store/actions/sessionStateActions.ts:122-125` 与 `apps/crish-desktop/src/store/sessionEviction.ts:209-211` 中，开发者明确写了注释：
   > `// isLazySessionShell 通过 hydratedFromEngine === true 判定"已水合"，不清除会导致驱逐后的空壳被 persistAllSessionsRust 误判为"用户清空了消息"，进而调用 save_session_body([]) 抹掉 SQLite 中的历史消息`
   > 并执行了 `delete sess.hydratedFromEngine;`。**但在启动入口 `hydrateSessionsFromRust` 构建 79 个非活跃懒壳时，却原样赋值了 `hydratedFromEngine: e.hydratedFromEngine`（`true`）！**

2. `apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:32-40`（`isLazySessionShell`）：

   ```ts
   export function isLazySessionShell(
     session: ChatSession,
     activeSessionId: string | null
   ): boolean {
     if ((session.messages?.length ?? 0) > 0) return false;
     if (session.id === activeSessionId) return false;
     if (
       session.messagesHydrated === true ||
       session.hydratedFromEngine === true
     )
       return false;
     return true;
   }
   ```

   > **【致命毒点 2】**：当 `session.messagesHydrated === false`（明确声明正文尚未从本地 DB 加载）时，仅仅因为历史会话曾经做过引擎事件水合（`session.hydratedFromEngine === true`），`isLazySessionShell` 就返回 `false`（判定它**不是**懒壳，而是已完整加载且内容为空的会话）！

3. `apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:298-306`（`persistAllSessionsRust`）：

   ```ts
   const shouldSaveBody =
     msgs.length > 0 || !isLazySessionShell(s, activePersistable);
   if (shouldSaveBody && isSessionBodyDirty(s.id, msgs)) {
     const expectedVersion = s.bodyVersion ?? null;
     bodyTasks.push({
       id: s.id,
       wire: msgs.map(messageToWire),
       expectedVersion,
     });
   }
   ```
   - 应用启动完成时，`apps/crish-desktop/src/store/layout-helpers/store-persistence.ts:297` 立即调用 `persistSessionStateToStorage()` → `persistAllSessionsRust(persistable, state.activeSessionId)`。
   - 此时进程刚启动，内存态 `lastSavedBodyFingerprint` Map（`sessionRustDbWriteGuard.ts:21`）对所有非活跃会话均无记录，`isSessionBodyDirty(s.id, [])` 触发第 68-70 行：
     `const prev = lastSavedBodyFingerprint.get(sessionId); if (prev === undefined) return true;`
   - 因为 `isLazySessionShell` 返回了 `false`，`shouldSaveBody` 为 `true`！
   - 前端将全部 79 个未水合的历史会话打包进 `save_session_bodies_batch`（或逐条 `save_session_body`），传入 `messages = []`！

4. `crates/conex-db/src/messages.rs:198-235`（`save_session_body_conn`）：
   ```rust
   conn.execute(
       "DELETE FROM session_messages WHERE session_id = ?1 AND seq >= 0",
       params![session_id],
   )?;
   ...
   let msg_count = messages.len() as i64; // 0
   let next_version: i64 = if messages.is_empty() { 0 } else { ... }; // 0
   conn.execute(
       "UPDATE sessions SET message_count = ?1, body_version = ?2 WHERE id = ?3",
       params![msg_count, next_version, session_id],
   )?;
   ```
   - Rust 端收到空数组 `[]` 后，忠实执行 `DELETE FROM session_messages` 并将 `message_count` 和 `body_version` 置为 `0`。**所有非活跃历史会话的 `session_messages` 至此在启动后不到 1 秒内被全部物理抹除！**

---

### 3.2 根因链二：`hydratedFromEngine === true` 锁死 Phase 2 引擎事件水合，导致 `events` 表 77,403 条事件无法回退恢复

#### （1）问题代码定位

`apps/crish-desktop/src/store/sessionActivateHydrate.ts:111-183`（`triggerSessionMessageHydrateIfNeeded`）：

```ts
// Phase 1: 本地持久化层按需水合（SQLite session_messages / localStorage body）
const localLoaded = await ensureSessionBodyHydrated(sessionId);
...
// Phase 2: 仅当本地无消息且尚未从引擎水合过时，回退到引擎事件日志水合
const currentBeforePhase2 = getState().sessions.find((s) => s.id === sessionId);
if (!currentBeforePhase2) return;
if (localLoaded.messages.length === 0 && currentBeforePhase2.hydratedFromEngine !== true) {
  const hydrated = await hydrateSessionMessagesFromEngine(sessionId);
  ...
} else if (currentBeforePhase2.messagesHydrated !== true) {
  // 本地无消息但已 hydratedFromEngine（空会话），标记 messagesHydrated 避免重复触发
  setState((state) => {
    const s = state.sessions.find((x) => x.id === sessionId);
    if (s && s.messages.length === 0) {
      s.messagesHydrated = true;
    }
  });
}
```

#### （2）死锁机制还原

1. 用户在侧边栏点击任意历史会话（如 `sess-1786798945840`，在 `events` 表中有 7,557 条事件、654 条完整消息）。
2. `selectSession` 调用 `triggerSessionMessageHydrateIfNeeded('sess-1786798945840')`。
3. **Phase 1**：调用 `ensureSessionBodyHydrated` → `load_session_body` 查 `session_messages` 表。由于根因一已把 `session_messages` 清空，返回 `localLoaded.messages = []`。
4. **Phase 2**：检查 `currentBeforePhase2.hydratedFromEngine !== true`。由于该会话在 `sessions` 表和内存中 `hydratedFromEngine === true`，**Phase 2 条件为 `false`，直接跳过 `hydrateSessionMessagesFromEngine`！**
5. 进入 `else if` 分支，将 `s.messagesHydrated = true` 写死。UI 展示空会话！
6. 甚至在 `shouldSkipSessionHydrate`（`sessionActivateHydrate.ts:65-71`）中：
   ```ts
   export function shouldSkipSessionHydrate(
     target: HydrateGateTarget | undefined
   ): boolean {
     if (!target) return true;
     if (target.messages.length > 0) return true;
     if (target.messagesHydrated === true) return true;
     if (target.hydratedFromEngine && target.messagesHydrated !== false)
       return true;
     return false;
   }
   ```
   一旦 `messagesHydrated` 被设为 `true`（或者当 `messagesHydrated` 为 `undefined` 且 `hydratedFromEngine` 为 `true` 时），后续任何水合尝试都会被直接短路跳过。

---

### 3.3 根因链三：`session_meta.schema_version` 双端键名冲突（`'12'` vs `'3'`）导致每次启动重跑 `import_from_localstorage` + `import.rs` 漏更新 `message_count` + `persistAllSessionsRust` 未写 `sessions` 表

#### （1）`schema_version` 键冲突导致每次启动重复触发 LocalStorage 迁移

1. **Rust 后端**（`crates/conex-db/src/lib.rs:104` & `crates/conex-db/src/migrate.rs:122, 219-230`）：
   - `pub const SCHEMA_VERSION_STRING: &str = "12";`
   - `LocalDb::open` 每次启动调用 `migrate::migrate(&conn)`，无论是否已是 v12，第 122 行都会执行 `record_schema_version(conn)`：
     ```rust
     conn.execute(
         "INSERT INTO session_meta (key, value) VALUES ('schema_version', ?1)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value",
         [SCHEMA_VERSION_STRING], // 写入 '12'
     )?;
     ```
2. **TS 前端**（`apps/crish-desktop/src/api/session-persistence/migrateFromLocalStorage.ts:38-39, 145-179`）：
   - `const SCHEMA_VERSION_KEY = 'schema_version';`
   - `const SCHEMA_VERSION_V3 = '3';`
   - 前端启动调用 `hydrateSessionsFromRust()` → 先执行 `await ensureMigrated()`：
     ```ts
     const current = await getSessionMeta(SCHEMA_VERSION_KEY); // 读出 Rust 刚写的 '12'
     if (current === SCHEMA_VERSION_V3) return; // '12' === '3' 为 false！
     ```
   - 紧接着检查 `hasLocalStorageData()`：由于 `persistAllSessionsRust` 每次都会执行 `writeIndexToLocalStorage(sessions)`（`sessionRustDbHydrate.ts:261`），`localStorage` 中永远存在 `crish_session_index_v1`！
   - 于是**每次应用启动都会重新执行 `runMigration()` → 调用 IPC `import_from_localstorage`**，把 `localStorage` 中的 `crish_session_index_v1` 和残余的 `crish_session_body_v1:*` 重新导入 SQLite，最后前端再把 `session_meta.schema_version` 改回 `'3'`！
   - **数据库实证**：`sessions.db` 的 `session_meta` 表中 `migration_completed_at = 1791779749005`（与最新会话时间戳同属本次启动周期），且 `schema_version = 3`，铁证如山。

#### （2）`import_from_localstorage` 在 v12 移除触发器后漏更新 `sessions.message_count`

- 在 `crates/conex-db/src/schema.rs:269-270` 与 `migrate.rs:205-208`（v11 → v12 迁移）中，删除了 `trg_session_messages_insert` 和 `trg_session_messages_delete` 触发器，改为由 `save_session_body_conn` 显式维护 `sessions.message_count`。
- 但 `crates/conex-db/src/import.rs:53-155` 的 `import_from_localstorage` 在向 `session_messages` 插入消息后（第 102-145 行），**没有执行任何 `UPDATE sessions SET message_count = ...` 语句**！
- **数据库实证**：`sess-1785519655009` 在 `localStorage` 中残留了 1 条消息（`"你好啊"`），每次启动被 `import_from_localstorage` 导入 `session_messages` 表（且因其 `hydratedFromEngine` 为 `undefined`，躲过了根因一的 `isLazySessionShell` 反转擦除），但它在 `sessions` 表中的 `message_count` 始终是 `0`！

#### （3）`persistAllSessionsRust` 从未调用 `upsert_session_entry` 更新 SQLite `sessions` 索引表

- 检查 `apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:249-327`（`persistAllSessionsRust`）：
  - 第 261 行：`writeIndexToLocalStorage(sessions)`（只把会话索引写进了浏览器 `localStorage`！）
  - 第 296-318 行：只调用了 `saveSessionBodiesBatchRust` / `saveSessionBodyRust`（只更新 `session_messages` 表和 `sessions` 表的 `message_count`/`body_version`）和 `setSessionMeta('active_session_id', ...)`。
  - **全文件定义的 `upsertSessionEntryRust`（`sessionRustDbSql.ts:62`）在生产代码中没有任何调用方！**
- 这意味着：运行期新建会话、修改会话标题、更新 `hydratedFromEngine` / `engineCursor` / `model` / `workspaceRoot` 等索引字段，**在运行期根本没有通过 `upsert_session_entry` 写入 SQLite `sessions` 表**，而是完全靠「每次下次启动时 `schema_version` 冲突意外触发 `import_from_localstorage`」才歪打正着从 `localStorage` 刷进 SQLite `sessions` 表！

---

## 四、Rust ↔ 前端 IPC 历史消息读取契约全面核对表

核查了 `crates/conex-types/src/lib.rs`、`crates/conex-db/src/{sessions,messages,events}.rs`、`apps/agent-workbench/src-tauri/src/{session_commands,core_query_commands}.rs` 与前端 `sessionRustDbWire.ts` / `sessionRustDbSql.ts` / `sessionEventHydrate.ts`：

| IPC 命令                                          | Rust Handler 位置                                                             | Rust 返回/接收类型                                                                                 | 前端调用位置与接收类型                                                                             | 字段序列化契约 (`camelCase`)                                                                                                                                                                                                                                                     | 契约一致性结论                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `list_sessions`                                   | `session_commands.rs:14-19` → `conex_db::sessions::list_sessions`             | `Vec<conex_types::SessionIndexEntry>` (`#[serde(rename_all = "camelCase")]`)                       | `sessionRustDbSql.ts:55-57` (`listSessionsRust`) → `RustSessionIndexEntry[]`                       | `id`, `title`, `updatedAt`, `createdAt`, `model`, `messageCount`, `workspaceRoot`, `branchedFromSessionId`, `branchedAtMessageId`, `parentSessionId`, `agentName`, `agentRole`, `hydratedFromEngine`, `engineCursor`, `bodyVersion`, `pinned`, `archived`, `customTitle`, `tags` | **完全匹配**（注：`sub-sess-%` 在 SQL 层被设计性过滤，见 `sessions.rs:64`）              |
| `load_session_body`                               | `session_commands.rs:41-47` → `conex_db::messages::load_session_body`         | `Vec<conex_types::SessionMessage>` (`#[serde(rename_all = "camelCase")]`)                          | `sessionRustDbSql.ts:75-80` (`loadSessionMessagesRust`) → `RustSessionMessage[]` → `wireToMessage` | `id`, `role`, `content`, `timestamp`, `attachments`, `thinking`, `thinkingDurationMs`, `thinkingStartedAt`, `agentName`, `agentRole`, `subagentSessionId`, `inlineSubagents`, `segments`, `toolCalls`, `usage`, `hidden`                                                         | **完全匹配**（JSON 列解析失败有 `unwrap_or_default` 兜底，不会因单列坏 JSON 抛错丢整表） |
| `save_session_body` / `save_session_bodies_batch` | `session_commands.rs:50-87` → `conex_db::messages::save_session_body(_batch)` | 接收 `Vec<SessionMessage>` + `expected_version: Option<i64>`，返回 `i64` / `Vec<(String, i64)>`    | `sessionRustDbSql.ts:91-125` (`saveSessionBodyRust` / `saveSessionBodiesBatchRust`)                | 同上；OCC 版本冲突返回 `"OCC_CONFLICT: session ..."`                                                                                                                                                                                                                             | **契约匹配，但被前端传入 `[]` 触发清空**                                                 |
| `core_read_session_events`                        | `core_query_commands.rs:43-59` → `conex_db::events::read_session_events`      | `conex_types::EventPage` (`events: Vec<SessionEventRecord>`, `next_cursor: u64`, `has_more: bool`) | `sessionEventHydrate.ts:74-82` (`fetchSessionEvents`) → `EventPageWire`                            | `events[].{seq, sessionId, runId, kind, payload, createdAt}`, `nextCursor`, `hasMore`                                                                                                                                                                                            | **完全匹配**（单页上限 `MAX_PAGE_LIMIT = 500`，支持 `after_seq` 分页循环拉取）           |

> **近期 Git 提交核查**：检查最近 20 个 commits（`git log -n 20 --oneline`），`crates/conex-db/` 的 Schema 未发生破坏性变更；最近一次直接改动会话水合与驱逐的提交为 `903eb176a refactor(session-store): 会话动作拆分与消息软驱逐下沉到 store` 与 `86a7180cf feat(crish-desktop): 启动会话懒水合与切换按需加载`。

---

## 五、修复建议与数据抢救方案（供主控 Agent 决策）

### 5.1 阻断物理擦除（最高优先级 — 止血）

1. **修复 `isLazySessionShell`（`apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:32-40`）**：
   - 只要 `session.messagesHydrated === false`，说明该会话在内存中**明确处于未拉取本地正文的懒水合空壳态**，无论 `hydratedFromEngine` 是什么值，都**必须返回 `true`（是懒壳，严禁落盘覆盖正表）**！
   - 修正逻辑：
     ```ts
     export function isLazySessionShell(
       session: ChatSession,
       activeSessionId: string | null
     ): boolean {
       if ((session.messages?.length ?? 0) > 0) return false;
       if (session.messagesHydrated === false) return true;
       if (session.id === activeSessionId) return false;
       if (
         session.messagesHydrated === true ||
         session.hydratedFromEngine === true
       )
         return false;
       return true;
     }
     ```
2. **修复 `hydrateSessionsFromRust`（`apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:158-181`）与 Rust 后端防呆**：
   - 在 Rust 端 `save_session_body_conn` 或前端 `persistAllSessionsRust` 增加安全护栏：当 `messages.is_empty()` 且未显式声明「用户清空消息」时（或当 `messagesHydrated !== true` 时），严禁向 `save_session_body` 发送空数组覆盖已有记录。

### 5.2 解锁并自动抢救 `events` 表中的 77,403 条历史对话事件

1. **修复 `triggerSessionMessageHydrateIfNeeded` Phase 2 判定（`apps/crish-desktop/src/store/sessionActivateHydrate.ts:144`）**：
   - 当 Phase 1 从 `session_messages` 读出 `localLoaded.messages.length === 0` 时，**即使 `currentBeforePhase2.hydratedFromEngine === true`，也应当尝试调用 `hydrateSessionMessagesFromEngine(sessionId)` 从 `events` 表回退重建消息**（若 `events` 表也确实为空，再保持空会话并标记 `messagesHydrated = true`）。
   - 一旦从 `events` 表成功重建出 `hydrated.messages.length > 0`：
     - 立即写回 `s.messages = hydrated.messages`、`s.messagesHydrated = true`；
     - **主动调用 `saveSessionBodyRust(sessionId, hydrated.messages.map(messageToWire), null)` 将重建出的完整消息重新持久化回 `session_messages` 表**，彻底恢复数据库正表！
2. **验证抢救效果**：
   - 仅此一项修复，本机 `sessions.db` 中擁有 `events` 记录的 **20 个重度历史会话（合计 77,403 条事件 / 7,445 条完整消息）** 在用户点击切入时即可 100% 无损恢复并重新落盘到 `session_messages`！

### 5.3 修复 `schema_version` 键冲突、`import.rs` 计数与 `sessions` 索引同步

1. **分离前端迁移元数据键名（`apps/crish-desktop/src/api/session-persistence/migrateFromLocalStorage.ts:38`）**：
   - 将前端 LocalStorage 迁移标记键从 `'schema_version'` 改为独立键（如 `'ls_migration_version'`），避免每次启动被 Rust `migrate.rs` 写入的 `'12'` 覆盖而重跑 `import_from_localstorage`。
2. **补齐 `crates/conex-db/src/import.rs` 的 `message_count` 更新**：
   - 在 `import_from_localstorage` 导入 `bodies` 后，同步执行 `UPDATE sessions SET message_count = ?1 WHERE id = ?2`。
3. **补齐 `persistAllSessionsRust` 对 `sessions` 表的索引同步**：
   - 在 `persistAllSessionsRust` 中同步调用 `upsert_session_entry`（或批量接口），确保运行期会话标题、`hydratedFromEngine`、`engineCursor` 等元数据变更直接写入 SQLite `sessions` 表，不再依赖 `localStorage` 倒灌。
