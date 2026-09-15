# Conex (Crish) vs DeepSeek Harness (dsh) 会话持久化与事件溯源机制代码级深度审计报告

> **审计范围**：Conex 与 DeepSeek Harness（以下简称 DSH）两套系统在「会话持久化、事件日志流、状态投影、数据一致性保障与崩溃恢复机制」层面的纯代码级实现。  
> **审计约束**：穿透抽象表象，杜绝文档宣称，完全以工程源码、底层系统调用、数据结构与恢复断言为准绳，严格附注 `文件路径:行号` 证据链。

---

## 目录
1. [架构哲学与存储介质选型对比](#一架构哲学与存储介质选型对比)
2. [写入原子性、批处理与组提交机制](#二写入原子性批处理与组提交机制)
3. [二进制帧压缩与物理存储工程（Zstd vs 纯文本）](#三二进制帧压缩与物理存储工程zstd-vs-纯文本)
4. [跨版本/跨世代迁移与沙箱验证机制](#四跨版本跨世代迁移与沙箱验证机制)
5. [崩溃恢复、断头尾部自愈与回放一致性](#五崩溃恢复断头尾部自愈与回放一致性)
6. [状态修剪、垃圾回收与大对象治理（CAS GC vs 目录清理）](#六状态修剪垃圾回收与大对象治理cas-gc-vs-目录清理)
7. [优劣裁决与各自技术破绽/技术债务剖析](#七优劣裁决与各自技术破绽技术债务剖析)
8. [Conex 架构吸收与演进路线图](#八conex-架构吸收与演进路线图)

---

## 一、架构哲学与存储介质选型对比

### 1.1 Conex：混合型关系数据库 + 事件流模式（Hybrid Relational DB + Event Log）

Conex 采用典型的嵌入式关系型数据库作为核心持久化载体，物理形态为单一 SQLite 数据库文件（`sessions.db`），并通过配置 WAL 模式提供单写多读并发能力。

```
                    ┌────────────────────────────────────────────────────────┐
                    │                    Conex LocalDb                       │
                    └──────────────────────────┬─────────────────────────────┘
                                               │
             ┌─────────────────────────────────┴─────────────────────────────────┐
             ▼                                                                   ▼
┌─────────────────────────┐                                         ┌─────────────────────────┐
│     DbWriteHandle       │ (Single Writer Actor)                   │       ReaderPool        │ (8 Slots TryLock)
│  (group_commit.rs:101)  │ 5ms / 50-item 组提交管道                  │   (reader_pool.rs:120)  │ PRAGMA query_only=ON
└────────────┬────────────┘                                         └────────────┬────────────┘
             │                                                                   │
             └─────────────────────────────────┬─────────────────────────────────┘
                                               ▼
                              ┌──────────────────────────────────┐
                              │  SQLite Database (WAL Enabled)   │
                              │  (lib.rs:122-124)                │
                              ├──────────────────────────────────┤
                              │ • sessions (schema.rs:128)       │
                              │ • events (schema.rs:146)         │
                              │ • session_messages (schema:195)  │
                              │ • compression_blocks (schema:324)│
                              │ • blob_cas (schema.rs:275)       │
                              │ • runs / pending_inputs          │
                              └──────────────────────────────────┘
```

- **存储物理介质**：
  - 单一 SQLite 数据库（`c:/Software/conex/crates/conex-db/src/lib.rs:113-135`），初始化时强制注入优化参数：
    ```rust
    PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
    ```
- **表结构拓扑与事实分层**：
  - `sessions` 表（`crates/conex-db/src/schema.rs:128-144`）：存储会话元数据（`id`, `title`, `folder`, `updated_at`, `engine_cursor`, `hydrated_from_engine` 等），使用 `WITHOUT ROWID`。
  - `events` 表（`crates/conex-db/src/schema.rs:146-155`）：追加写事件日志，以 `(session_id, sequence)` 作为复合主键，外键级联关联 `sessions(id) ON DELETE CASCADE`。包含 `run_id` 与毫秒级 `created_at`。
  - `session_messages` 表（`crates/conex-db/src/schema.rs:195-212`）：存储正文消息投影，复合主键为 `(session_id, seq)`。
  - `compression_blocks` 表（`crates/conex-db/src/schema.rs:324-346`）：上下文压缩摘要块，以 `(session_id, block_id)` 为复合主键。
  - `blob_cas` 表（`crates/conex-db/src/schema.rs:275-285`）：CAS 内容寻址存储大附件，以 `hash` 为主键，支持两阶段软删除。
  - 外部快照文件：由 `restore_snapshot.rs:277-356` 管理的磁盘 JSON 快照文件（主快照 `{path}` 与上一版本备份 `{path}.prev`），并计算 FNV-1a 64 校验和。

### 1.2 DSH：纯事件溯源与分代不可变日志（Pure Event Sourcing & Generational JSONL）

DSH 拒绝使用集中式关系型数据库，采用纯事件溯源（Pure Event Sourcing）思想与“会话即目录、版本即文件”的不可变世代（Generations）文件布局。

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                               DSH Session Filesystem                                   │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │
         ┌─────────────────────────────────┴─────────────────────────────────┐
         ▼                                                                   ▼
┌─────────────────────────────────┐                         ┌─────────────────────────────────┐
│ Project Dir: --project-key--    │                         │ Project Dir: _no-cwd            │
│ (format.ts:224-256)             │                         │ (format.ts:254)                 │
└────────────────┬────────────────┘                         └─────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Session Dir: encodeSegment(id)  │ (format.ts:198-213, 266-268)
├─────────────────────────────────┤
│ • v1.jsonl.zstd (只读旧世代)     │ (format.ts:50-76)
│ • v2.jsonl.zstd (当前活跃世代)   │ (index.ts:1097-1114)
│ • .session.lease (内核文件写锁)  │ (lease.ts:15-45)
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ Streamed Concatenated Checksummed Zstandard Frames (zstd.ts:8-39, index.ts:900)  │
├─────────────────────────────────────────────────────────────────────────────────┤
│ Frame 0: Header Line (assertZstdHeaderFrame, zstd.ts:74-78, format.ts:82-94)   │
│ Frame 1: Batch 1 Event Rows (JSONL records)                                     │
│ Frame 2: Batch 2 Event Rows (JSONL records)                                     │
│ ...                                                                             │
│ Frame N: Torn Tail Frame (Crash Recoverable via ZSTD_e_flush, zstd.ts:148-156)  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

- **存储物理介质**：
  - 目录树组织：`root / projectKey(cwd) / encodeSegment(sessionId) / vN.jsonl.zstd`（`reference/deepseek-harness/packages/session/session-persistence-jsonl/src/format.ts:246-287`）。
  - 编码安全：`SessionId` 在落盘前必须经过 `encodeSegment`（`format.ts:198-213`）逐字符转义（非安全字符编码为 `~XXXX`，彻底消除路径穿越 `../` 与 NUL 截断隐患）。
- **事件模型哲学**：
  - 单一真实来源（SSOT）：会话在物理磁盘上**只存在单一事件日志**，没有关系表，没有独立的消息表。
  - 内存与存储同构：内存中 `Session.log` 是不可变的 `SessionEvent[]` 数组（`reference/deepseek-harness/packages/core/session/src/index.ts:581`）。
  - 状态投影（Projections as Views）：
    - 消息历史：通过 `SurfaceManager` 依赖每条事件上的 `surfaceOp: 'append' | { op: 'replace', startSeq, endSeq }` 动态将事件序列折叠为 LLM 消息（`reference/deepseek-harness/packages/core/session/src/surface.ts:420-450`，`index.ts:800-846`）。
    - 业务状态：通过 `sessionProjections` 服务驱动注册的 `ProjectionDefinition`（纯同步函数 `apply(state, event)`）计算派生视图（`reference/deepseek-harness/packages/session/session-projection/src/index.ts:48-93`），其落盘缓存 `(sessionId, key, ver, seq, val)` 纯属折叠加速器，随时可丢弃并由事件全量重建。

---

## 二、写入原子性、批处理与组提交机制

### 2.1 Conex：5ms/50-item 组提交管道与 SAVEPOINT 隔离

Conex 在 SQLite 层面设计了专职的单写 Actor（`DbWriteHandle`）来规避多线程锁争用与频繁 fsync：

- **组提交聚合模型**（`c:/Software/conex/crates/conex-db/src/group_commit.rs:17-43, 207-241`）：
  - 写入者循环 `run_actor_loop` 收到首个任务后，开启一个 5ms 的超时窗口（`DEFAULT_GROUP_COMMIT_TIMEOUT_MS = 5`），最多汇聚 50 个写入请求（`DEFAULT_GROUP_COMMIT_MAX_BATCH = 50`）合并提交。
- **单条快速路径 vs 多条 SAVEPOINT 隔离**（`group_commit.rs:252-396`）：
  - 当 `batch_len == 1` 时，直接走单条快速事务：`BEGIN IMMEDIATE` -> 执行闭包 -> `COMMIT`（`group_commit.rs:252-270`）。
  - 当 `batch_len > 1` 时，最外层开启单一 `BEGIN IMMEDIATE`，内部为每个子任务分配一个独立的 SQLite 保存点：
    ```rust
    // group_commit.rs:319-324
    let sp_name = format!("gc_sp_{idx}");
    let sp_begin = format!("SAVEPOINT {sp_name};");
    let sp_release = format!("RELEASE {sp_name};");
    let sp_rollback = format!("ROLLBACK TO {sp_name};");
    ```
  - **Panic 安全网**：在执行写闭包时注入 `catch_unwind(AssertUnwindSafe(|| op(conn)))`（`group_commit.rs:258, 336`）。若某项任务内部触发 Panic，自动捕获并在保存点执行 `ROLLBACK TO gc_sp_{idx}`，同时记录日志并向该任务 channel 返回错误，**完全不污染同批次其余健康任务的外层 COMMIT**！

#### ⚠️ Conex 严重破绽：持久化路径存在严重的“双轨制”与全量重写债务

1. **核心持久化未走组提交**：
   `DbWriteHandle` 的设计非常亮眼，但审查 `crates/conex-db/src/events.rs:20-34` 的 `append_event` 与 `crates/conex-db/src/messages.rs:54-68` 的 `save_session_body` 发现：
   ```rust
   // events.rs:21-24
   let conn = self.conn.lock().map_err(|e| DbFailure {
       message: format!("lock poisoned: {e}"),
       kind: DbFailureKind::Lock,
   })?;
   conn.execute("INSERT INTO events ...", ...);
   ```
   **核心事件追加与正文写入完全绕过了 `DbWriteHandle`！** 它们直接争抢 `self.conn` 全局互斥锁同步执行 SQL！组提交管道沦为仅供外部异步调用的空架子，高并发下仍然会引发激烈的互斥锁争用与短事务 I/O 放大。
2. **`session_messages` 全量“先删后插”导致严重写放大**：
   审查 `crates/conex-db/src/messages.rs:64-96`：
   ```rust
   tx.execute("DELETE FROM session_messages WHERE session_id = ?1", params![session_id])?;
   for (seq, msg) in messages.iter().enumerate() {
       tx.execute("INSERT INTO session_messages ...", ...)?;
   }
   ```
   每次会话生成或更新消息，不是增量追加，而是全表物理 `DELETE` 然后逐条重新 `INSERT`！在长会话（成百上千条消息）中，会引发严重的 SQLite WAL 日志膨胀与 B-Tree 页频繁重平衡。

### 2.2 DSH：单句柄链式串行、200ms 批处理与物理截断回滚

DSH 基于文件系统打造了一套端到端的单写者租约与追加批处理系统：

- **单句柄 Promise 队列**（`reference/deepseek-harness/packages/session/session-persistence-jsonl/src/storage.ts:86, 187-196`）：
  - 每个会话句柄维护私有 Promise 链：`private chain: Promise<unknown> = Promise.resolve()`。所有 `append`、`flush`、`drainLive` 均挂载在该链尾部排队，天然杜绝同句柄并发重入。
- **后台写缓冲（Write-Behind Buffer）**（`storage.ts:35-36, 89-91, 268-281`）：
  - `LIVE_WRITE_BATCH_MAX_DELAY_MS = 200ms`。事件发生时不阻塞 LLM 执行循环，直接暂存进 `buffered: SessionEvent[]`，启动 200ms 计时器聚合后续连续事件（如流式思考过程中的连续中间态）。
  - 若在缓冲期内触发了显式 `session/flush`，计时器被取消并立即排空写入（`storage.ts:294-298`）。
- **物理追加原子性与失败回滚（Rollback Append）**（`reference/deepseek-harness/packages/session/session-persistence-jsonl/src/index.ts:1246-1284`）：
  - 在向底层文件写入前，先通过 `handle.stat()` 记录当前物理文件大小 `before`。
  - 写入并在写连接上调用 `handle.sync()`（强制 fsync）。
  - **异常回滚机制**：若 `writeFile` 或 `sync` 抛出错误，catch 块立即接管，关闭追加句柄并调用 `rollbackAppend`：
    ```typescript
    // index.ts:1276-1284
    private async rollbackAppend(path: string, size: number): Promise<void> {
      const handle = await open(path, 'r+')
      try {
        await handle.truncate(size)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    ```
    通过操作系统级 `truncate` 将文件硬截断回 `before` 字节位置，彻底防止残缺半帧污染磁盘！

---

## 三、二进制帧压缩与物理存储工程（Zstd vs 纯文本）

| 比较维度 | Conex (Crish) | DeepSeek Harness (DSH) | 高下裁决 |
| :--- | :--- | :--- | :--- |
| **物理编码格式** | SQLite 内部 B-Tree 页面存储（纯文本 JSON 字符串） | 串联多帧 Zstandard 二进制容器（`.jsonl.zstd`） | **DSH 碾压级优势** |
| **存储空间压缩率** | 零压缩（纯文本存入 SQLite `TEXT` 列，膨胀率高） | RFC 8878 Zstandard 压缩，针对 JSONL 通常达到 5:1 ~ 8:1 压缩比 | **DSH 胜出** |
| **元数据探测开销** | 需打开 SQLite DB，解析 WAL 索引，执行 SQL 解析 | 第一帧独立存放 Header，无需解压事件体（`assertZstdHeaderFrame`） | **DSH 胜出** |
| **帧级数据完整性** | 依赖 SQLite 页面级 Checksum（WAL 校验） | 强制开启硬件级 Zstd 帧校验和（`ZSTD_c_checksumFlag: 1`） | **平手** |
| **无反序列化扫描** | 无法直接跳过记录，必须经 B-Tree 读取行 | 裸二进制扫描器 `scanZstdFrames` 快速定位所有帧边界 | **DSH 碾压级优势** |
| **事件循环防死锁** | Tokio blocking 线程池隔离（`read_async` / `tokio::spawn_blocking`） | 自适应时间切片让渡（`await scheduler.yield()`） | **平手** |

### 3.1 DSH 的 Zstd 物理层深度工程实现

DSH 在 `packages/session/session-persistence-jsonl/src/zstd.ts` 中展现了极致的二进制系统编程能力：

1. **裸二进制帧边界探测器（`scanZstdFrames`）**（`zstd.ts:48-103`）：
   DSH 完全不依赖任何第三方解压器，直接用 Node.js Buffer 操作 Zstandard RFC 8878 规范：
   - 验证 Magic Number：`0xFD2FB528`（`zstd.ts:15, 55`）；
   - 解析帧头描述符（Frame Header Descriptor）、单段标记（Single Segment Flag）、校验和标记（Checksum Flag，`zstd.ts:67-70`）；
   - 遍历解析 Block Header：读取 3 字节小端整数，位运算解出 `lastBlock`（第 0 位）、`blockType`（第 1-2 位）、`blockSize`（高 21 位，`zstd.ts:81-86`）；
   - 在完全不进行解压的情况下，以 O(N) 极速扫描出全部帧的物理区间 `[{ start, end }]`，且能精确抓取因异常断电导致的断头帧起始点 `tornStart`（`zstd.ts:38, 54, 76, 91`）。
2. **首帧 Header 隔离设计**（`zstd.ts:74-78`, `index.ts:1206-1221`）：
   在落盘物料时，DSH 强制将 Header 独立压缩为一个单独的 Zstd 帧：
   ```typescript
   // index.ts:1218-1220
   const headerFrame = await compressZstdFrame(header)
   const eventFrame = await compressZstdFrame(body)
   return Buffer.concat([headerFrame, eventFrame])
   ```
   这意味着系统在执行 `stat`、`list` 等操作提取会话 Header 时，仅需解压首个微秒级小帧（`readFirstZstdLine`，`index.ts:1016`），避免了解压动辄数百 MB 的后续长事件历史。
3. **私有解码器复用与时间切片让渡**：
   - 支持从 Node.js 运行时借用内部上下文 `NodePrivateZstdFrameDecoder`（`zstd.ts:12, 139`），消除内存碎片；
   - 在遍历解码长日志时，设置 `ZSTD_DECODE_YIELD_INTERVAL_MS = 500ms`，一旦耗时超标自动执行 `await scheduler.yield()`（`index.ts:906, 922-926`），杜绝阻塞主事件循环。

---

## 四、跨版本/跨世代迁移与沙箱验证机制

### 4.1 Conex：原地 SQLite DDL 迁移链与单表缺表降级

Conex 的版本管理遵循关系型数据库的典型做法：

- **版本驱动**：基于 SQLite `PRAGMA user_version`（当前为版本 11，`crates/conex-db/src/lib.rs:100`）。
- **迁移编排**（`crates/conex-db/src/migrate.rs:37-124`）：
  - 启动时对比 `current_version` 与 `LATEST_VERSION`，逐级递增调用 `migrate_steps.rs` 中的迁移函数（如 `migrate_v1_to_v2`, `migrate_v2_to_v3`, ..., `migrate_v6_to_v7`）。
  - **整库热备份防线**：在执行涉及表重建的破坏性步骤前，执行整库物理拷贝 `sessions.db.bak-v{n}`，保留最近 2 份（`lib.rs:107-108`）。
  - **单表缺表降级（Missing Table Fallback）**（`crates/conex-db/src/blocks.rs:104-143`）：
    新代码读老版本库（如 v6 库访问 `compression_blocks`）时，先通过 `sqlite_master` 探测表是否存在（缓存单连接结果）。若表缺失，读操作返回空，写操作静默返回 Ok 并打印 `tracing::warn!`，**绝不抛出 SQL 错误 latch 死整库**。

#### ⚠️ Conex 破绽：原地修改的单向性与锁库风险
SQLite 的 `ALTER TABLE` 原地升级虽然有 DDL 事务保障，但一旦涉及表重构（如 `migrate_v3_to_v4` 对 `events` 表的改写），必须执行 `RENAME -> CREATE -> INSERT INTO SELECT -> DROP`（`migrate_steps.rs:136-170`）。如果线上有几十万条事件，该操作不仅耗时数秒甚至数十秒（全量拷贝），且在升级后写入新数据后，无法再安全降级回退。

### 4.2 DSH：世代不可变性与 Worker 沙箱全量重放验证

DSH 的迁移机制堪称分布式系统与不可变架构的教科书级典范：

```
[旧世代文件: v1.jsonl.zstd] (保持只读，永不就地修改)
             │
             ├─► 1. 读请求到来：以只读流式解码 (prepareJsonlMigration, generation.ts:68)
             │      准备好在内存中变换为 v2 格式，返回 PreparedStoredLog (index.ts:122-132)
             │
             └─► 2. 写句柄打开：触发正式发布 (publishStoredMigration, index.ts:373-378)
                    │
                    ├─► 2a. 写入带随机 Token 的临时阶段文件：session.migration.xxxx.tmp
                    │       (generation.ts:720-763)
                    │
                    ├─► 2b. 启动独立 Node.js Worker 线程执行沙箱硬重放验证！
                    │       (verifyCurrentGenerationInWorker, generation.ts:82-90, 488-546)
                    │       • 校验 Header ID 与事件数
                    │       • Session.fromRestore 状态机构建
                    │       • BlockAssembler 反向展开 Assistant Stream 与 Message Content 完全对账！
                    │
                    └─► 2c. 物理原子防撞发布：
                            • Win32: publishNewFileWin32 (硬链接/原子创建防撞)
                            • POSIX: fs.link() (EEXIST 冲突拒绝，generation.ts:812-838)
```

1. **不可变世代（Generational Immutability）**：
   旧版本文件（如 `v1.jsonl.zstd`）在升级时**完全不被修改或覆盖**，新版本生成为同目录下的 `v2.jsonl.zstd`。
2. **只读时懒准备，只有写入时才发布**：
   只读模式下调用 `open(id, 'read')`，即使发现是老版本，也仅在内存中执行无锁单遍解码准备（`PreparedStoredLog`，`index.ts:346-361`），不污染磁盘；只有写入者调用 `open(id, 'write')` 时，才执行持久化发布（`index.ts:373-378`）。
3. **隔离 Worker 沙箱中的“魔鬼对账”**（`generation.ts:548-572`）：
   在正式发布新世代文件之前，DSH 会在独立的 Worker 线程中重新读取该文件，并执行严苛的流重放校验：
   ```typescript
   // generation.ts:550-571
   for (const [index, event] of events.entries()) {
     if (event.type !== 'assistant/message') continue
     const assembler = new BlockAssembler()
     const timed = expandAssistantStream(event.data.stream)
     for (const member of timed) assembler.push(member.chunk)
     // 严格断言：事件外层的 message.content 必须与流式 chunk 累加结果 100% 严格一致！
     if (!isDeepStrictEqual(event.data.message.content, assembler.blocks())) {
       throw new Error(`seed assistant/message at index ${index} content disagrees with its embedded stream`)
     }
     if (!isDeepStrictEqual(event.data.usage, assembler.usage)) {
       throw new Error(`seed assistant/message at index ${index} usage disagrees with its embedded stream`)
     }
   }
   ```
   这种在升级门禁前对模型流式底料做语义对账的设计，彻底杜绝了迁移产生不可见的语义漂移。

---

## 五、崩溃恢复、断头尾部自愈与回放一致性

### 5.1 Conex：状态机扫表打断 + 快照增量恢复 + 终态矛盾审计

Conex 的冷启动恢复由 `crates/orchestrator/src/restore_manager.rs` 统领：

- **快照回退防线**（`restore_snapshot.rs:298-312`）：
  - 启动时首先读取主快照并校验 FNV-1a 64 校验和。
  - 若主快照损坏，尝试回退到 `.prev` 备份快照（`restore_snapshot.rs:360-372`）。
  - 若两者均不可用，平滑回退到无快照的“全量事件重放”（`FullReplay`）模式。
- **In-flight 状态扫表打断**（`restore_manager.rs:60-135`）：
  - 扫描 `runs` 表中所有非终态记录（`queued`, `initializing`, `running`, `awaiting-approval`, `completing`, `cancelling`）；
  - 将其中途截断为 `failed`（或 `cancelled`），并向 `events` 表写入 `run-interrupted` 审计事件，记录原状态 `previous_status`，保证审计链完整。
- **子代理 running 状态归一**（`restore_manager.rs:137-176`）：
  - 扫描 `session_agents` 中处于 `running` 的孤儿子代理，将其状态重置为 `failed`，避免调度图永久阻塞在等待中。
- **G-29 终态矛盾对账**（`restore_manager.rs:360-400`）：
  - 针对每个 run，通过 SQL 下推查询 `query_events_by_type(.., "run-terminal", 0, Some(1))`，检查 `runs` 记录状态与事件流是否冲突（例如：记录说 `completed` 但事件流无 `run-terminal`，或反之）。

#### ⚠️ Conex 致命技术债务：对账“只报不修”与双源漂移
审查 `crates/orchestrator/src/restore_manager.rs:178-184`：
```rust
// 3c. G-29 终态矛盾对账（DM-08）：只读校验 events 表 run-terminal
// 与 runs 记录终态的矛盾，显式上报（tracing::warn + outcome 计数），
// **不自动修正**（不翻写 runs 表、不改事件——修正语义归恢复策略
// 后续裁决）。
```
Conex 发现了事件流与关系表记录存在矛盾，但**明确拒绝修正**，只打 `tracing::warn`。一旦在崩溃瞬间 `runs` 表更新成功而 `events` 插入失败（或反之），该矛盾将在数据库中成为永久疤痕，每次启动都会持续报出矛盾警告，缺乏单向权威强制收敛的决断力。

### 5.2 DSH：物理断头残帧解压 + 语义级回合闭合自愈（Repair Mechanics）

DSH 展现了从操作系统底层到大模型应用层无懈可击的双层自愈体系：

#### 1. 物理层：断头残帧利用 `ZSTD_e_flush` 提取 + 截断重写（Torn Tail Auto-Healing）
当发生突发断电导致文件末尾留下残缺半帧时：
- `scanZstdFrames`（`zstd.ts:48-103`）精确定位到残帧字节偏移量 `tornStart`；
- 调用 `decompressZstdPrefix`（`zstd.ts:148-156`），传入 `{ finishFlush: constants.ZSTD_e_flush }`，强制 Zstd 解码器吐出残帧中已经到达的有效明文字节；
- `SessionLogScanner`（`format.ts:416-474`）过滤掉最后一行未打 `\n` 的破损 JSON 碎片，成功提取出已成型的有效事件放入 `recoveredTail`；
- 记录 `tornTruncateTo = tornStart`（`index.ts:963-965`）；
- **静默物理修复**：当下一个写入请求进入时（`storage.ts:328-338`），句柄首先调用 `truncateTornTail` 物理截断文件尾部损坏的字节，随后将 `recoveredTail` 重新以正规完整帧格式写回磁盘，最后追加新数据。整个过程对上层应用**完全透明且零数据丢失**！

#### 2. 应用层：未闭合 Turn 与悬空工具调用的语义合成（`repair.ts`）
这是 DSH 最具独创性的设计之一（`reference/deepseek-harness/packages/core/session/src/repair.ts:29-135`）：
如果崩溃发生在 Agent 生成了 `tool-call` 但尚未收到外部执行工具的结果时，重启后如果直接继续，LLM 上下文会因为存在“悬空的 tool_call 而无 tool_result”直接报错（各大主流模型 API 均硬性要求 tool-call 必须有成对的 tool-result）。
DSH 的 `interruptedTurnClosers` 逐事件扫描整个流：
```typescript
// repair.ts:93-126
for (const [callId, { step, callSeq }] of pendingCalls) {
  const started = callSeq !== undefined
  const message: ToolResultMessage = deepFreeze({
    id: brandString<MessageId>(`interrupted-tool-result-${callId}-${seq}`),
    role: 'user',
    source: { kind: 'tool', callId },
    content: [{
      type: 'tool-result',
      toolCallId: callId,
      isError: true,
      content: [{
        type: 'text',
        text: started
          ? 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.'
          : 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
      }],
    }],
  })
  closers.push({
    type: 'tool/result',
    seq: SessionSeq(seq++),
    time,
    data: { turn: openTurn, step, message, error: ... },
    surfaceOp: 'append',
    ...started ? { sourceEventSeqs: [callSeq] } : {},
  })
}
// 依次闭合 step/end 与 turn/end
if (openStep !== null) {
  closers.push({ type: 'step/end', seq: SessionSeq(seq++), time, data: { turn: openTurn, step: openStep } })
}
closers.push({ type: 'turn/end', seq: SessionSeq(seq++), time, data: { turn: openTurn, reason: { kind: 'interrupted' } } })
```
系统**确定性地合成对冲事件**，不仅关闭了悬空的工具调用，还在注入的 Prompt 中精妙地指导大模型：“工具调用已被系统重启中断，结果未知，请根据幂等性自行判断是否重新调用，切勿盲目重试”。这彻底解决了大模型长程任务中断恢复后的“幽灵调用”问题！

---

## 六、状态修剪、垃圾回收与大对象治理（CAS GC vs 目录清理）

### 6.1 Conex：卓越的多源联合引用 CAS 垃圾回收与 7 天软删除隔离

在大对象（Blobs、图片、大文档快照、Undo 历史）治理上，Conex 展现了极高水平的工业级设计（`c:/Software/conex/crates/conex-db/src/cas_gc.rs`）：

- **多源联合引用网**（`cas_gc.rs:484-508`）：
  一个 CAS 数据块（`blob_cas`）只要被以下任意一处引用，就**绝对不允许回收**：
  1. `block_attachments`（当前文档 Head 块引用）；
  2. `doc_snapshots_attachments`（历史 CRDT 快照引用）；
  3. `session_undo_blobs`（Undo/Redo 栈历史附件）；
  4. `active_blob_leases`（持有中且未过期的租约，`expires_at > datetime('now')`）；
  5. `pinned == 1`（用户显式置顶保护）。
- **两阶段隔离期与读自愈（Quarantine & Heal-on-Read）**：
  - **阶段 1 软隔离**：扫描发现的孤儿不执行物理删除，仅标记 `marked_for_delete_at = CURRENT_TIMESTAMP`，进入 7 天隔离期（`DEFAULT_QUARANTINE_SECS = 7 * 86400`，`cas_gc.rs:24, 520-530`）；
  - **反隔离自愈**：如果在 7 天内有任何读请求命中了该 Blob（`get_blob` / `get_blob_meta`），系统自动触发自愈逻辑，原子抹除 `marked_for_delete_at = NULL`，将其拉回健康态（`cas_gc.rs:334-339, 374-380`）！
  - **阶段 2 物理清除**：只有处于隔离期超过 7 天且依然无任何引用的孤儿，才执行物理 `DELETE`，并联动对物理磁盘上的外置存储文件调用 `remove_file` 彻底清除（`cas_gc.rs:570-597`）。
- **会话级孤儿清理多重豁免**（`crates/conex-db/src/sessions.rs:214-276`）：
  孤儿清理包含 5 分钟宽限期、引擎子代理会话豁免（`hydrated_from_engine == 1`）、活跃运行中 run 豁免、未消费 `pending_inputs` 豁免，确保并发运行中的会话绝不被误伤。

### 6.2 DSH：基于文件系统的粗粒度清理及其局限

- **DSH 的优势**：
  会话数据以独立目录存在，删除会话只需执行操作系统级 `rm -rf`，操作系统立即回收元数据和物理块，完全没有数据库常见的 B-Tree 碎片和页空洞问题。
- **DSH 的严重短板**：
  - **无跨会话大对象去重能力**：如果多个会话或子代理引用了同一份 50MB 的工程文件或图片，DSH 的纯 JSONL 架构必须在每个会话中全量内联或重复存储，导致磁盘占用剧烈膨胀；
  - **内存无界性**：DSH 会话的所有事件历史在运行时常驻内存数组（`this.log`，`core/session/src/index.ts:581`），面对百万级超长事件日志，Node.js 极易触发 OOM。

---

## 七、优劣裁决与各自技术破绽/技术债务剖析

### 7.1 综合高下裁决

| 评测维度 | Conex (Crish) 得分 / 表现 | DSH (DeepSeek Harness) 得分 / 表现 | 裁决结论 |
| :--- | :---: | :---: | :--- |
| **存储介质与架构纯粹度** | 7.5 / 10（关系表+事件流双轨，存在三源漂移） | **9.8 / 10**（纯事件溯源，无状态折叠，极简干净） | **DSH 明显胜出** |
| **物理层压缩与帧级工程** | 4.0 / 10（纯文本无压缩，仅上层业务摘要） | **9.9 / 10**（RFC 8878 Zstd 裸二进制扫描与帧校验） | **DSH 碾压级胜出** |
| **跨版本跨世代迁移验证** | 6.5 / 10（SQLite 原地 DDL，缺表降级） | **9.5 / 10**（世代不可变文件，Worker 线程展开流对账） | **DSH 明显胜出** |
| **崩溃扫描与语义级自愈** | 7.0 / 10（扫表打断，但对账只报不修） | **9.8 / 10**（物理截断残帧+语义合成对冲工具结果） | **DSH 明显胜出** |
| **全局检索与元数据治理** | **9.5 / 10**（SQL 复合索引、ReaderPool 无锁读） | 5.0 / 10（全目录遍历，O(N) 读 Header，I/O 瓶颈） | **Conex 明显胜出** |
| **大附件/CAS 垃圾回收** | **9.8 / 10**（多源联合引用、7天软删除隔离、读自愈）| 3.0 / 10（完全缺失跨会话 CAS 存储与 GC） | **Conex 碾压级胜出** |

---

### 7.2 技术破绽与技术债务深度曝光

#### Conex 的具体破绽与技术债务
1. **组提交“双轨制”掩耳盗铃**：
   `group_commit.rs` 构建了精密的 5ms/50-item Actor 管道，但最核心的业务写路径 `events.rs:21`（`append_event`）与 `messages.rs:55`（`save_session_body`）居然完全不走 `DbWriteHandle`，而是直接通过 `self.conn.lock()` 拿全局锁同步执行。这导致组提交管道基本沦为摆设，并发时依旧存在严重的写锁排队与 I/O 抖动。
2. **`session_messages` 全量“先删后插”的反模式**：
   `messages.rs:65-95` 依然保留了早期的暴力重写逻辑，每一轮对话都对当前会话的消息表全表清空后重新逐行写入。这与底层引入事件溯源的增量设计思想发生严重脱节。
3. **终态矛盾对账“掩耳盗铃”（只报不修）**：
   `restore_manager.rs:178-194` 明确说明对账矛盾“只上报不修正”。关系表（`runs`）和事件流（`events`）各说各话，导致系统启动后日志常态化充斥矛盾告警，降低了系统的可观测性信任度。
4. **缺乏物理层压缩**：
   长会话的事件与消息正文在 SQLite 中完全裸存，导致单库物理体积随时间单调线性剧增，缺乏 Zstd 或 Snappy 页面级压缩机制。

#### DSH 的具体破绽与技术债务
1. **全局列表与元数据检索存在严重的 I/O 放大风险**：
   审查 `packages/session/session-persistence-jsonl/src/index.ts:975-1006` 的 `listArtifacts`：获取会话列表需要调用 `readdir` 遍历所有项目目录、遍历所有会话目录，并逐个打开每个会话文件的第一帧解压解析 Header。在生产环境中，如果有 5 万个历史会话，一次简单的 `list` 操作将产生数十万次系统调用（`stat`, `open`, `read`, `close`），极易触发磁盘 I/O 锁死。
2. **内存中事件日志无界常驻风险**：
   `core/session/src/index.ts:581` 强制将整个会话的所有历史事件全量 push 到内存数组 `this.log` 中。对于运行数天、包含数十万步骤的长程自主 Agent，单会话内存消耗可达数 GB，极易引发 Node.js 堆内存溢出崩溃。
3. **缺乏跨会话的大文件去重（CAS）**：
   DSH 完全依赖单文件内联存储，所有大工具载荷、文件切片均以 JSON 字符串形式嵌入事件行，无法在多个会话之间实现 SHA-256 内容寻址去重，空间冗余度高。

---

## 八、Conex 架构吸收与演进路线图

结合 DSH 的先进实践与 Conex 现有的 Rust/SQLite 工业底座，提出针对 Conex 的四步架构演进方案：

```
                    ┌────────────────────────────────────────────────────────┐
                    │              Conex 演进后统一架构目标                  │
                    └──────────────────────────┬─────────────────────────────┘
                                               │
             ┌─────────────────────────────────┴─────────────────────────────────┐
             ▼                                                                   ▼
┌─────────────────────────────────┐                         ┌─────────────────────────────────┐
│     SQL 索引与元数据查询层       │                         │      事件溯源存储与自愈引擎     │
│  (保留 Conex 原有绝对优势)      │                         │  (全面吸收 DSH 核心工业级工程)  │
├─────────────────────────────────┤                         ├─────────────────────────────────┤
│ • sessions 表 (毫秒级过滤索引)  │                         │ • 统一走 DbWriteHandle 组提交   │
│ • ReaderPool 8 槽位并发无锁读   │                         │ • 废除 session_messages 暴力重写│
│ • CAS GC 多源联合引用安全网     │                         │ • 引入 interruptedTurnClosers   │
│ • usage_records 时序监控        │                         │ • G-29 终态矛盾以事件流强制收敛 │
│ • 杜绝 DSH 遍历目录的 I/O 灾难  │                         │ • 超长事件载荷支持透明 Zstd 压缩│
└─────────────────────────────────┘                         └─────────────────────────────────┘
```

### 步骤 1：闭环组提交管道，废除 `session_messages` 暴力全量重写
- **全面收敛写入入口**：修改 `crates/conex-db/src/events.rs:20` 与 `crates/conex-db/src/messages.rs:50`，严禁业务代码直接 `self.conn.lock()`。所有写操作必须通过 `self.writer.write(...)` 统一交由 `DbWriteHandle` 组提交 Actor 调度。
- **正文增量化**：废除 `save_session_body` 的 `DELETE + 逐条 INSERT` 模式。借鉴 DSH `SurfaceManager` 的思想，`session_messages` 仅作为只读缓存视图，根据新落库的事件做增量 `INSERT/UPDATE`，不再全表刷写。

### 步骤 2：吸收 DSH `repair.ts`，实现“语义级回合闭合对冲自愈”
- **移植 `interruptedTurnClosers` 机制**：在 `crates/orchestrator/src/restore_manager.rs` 恢复流程中，在打断 run 的同时，深入扫描事件流。
- **自动合成合法对冲事件**：若发现悬空的 `ToolCall`，由恢复管理器在事件流中自动合成合法的 `ToolResult`（携带结构化错误原因 `ToolOutcomeUnknown`，并明确注入指导大模型判断幂等性的提示词），随后补齐 `step-end` 与 `turn-end`。
- **杜绝大模型 400 报错**：确保会话在物理崩溃重启后，向 LLM 投递的消息上下文永远保持合法闭合。

### 步骤 3：确立事件流唯一真相（SSOT），终结 G-29“只报不修”
- **确立事实权威规则**：确立 `events` 表为不可动摇的系统第一真实来源，`runs` 表仅为关系型查询索引。
- **终态强制单向收敛**：重构 `reconcile_terminal_conflicts`（`restore_manager.rs:360`）。当发现事件流存在 `run-terminal` 但 `runs` 表处于 `failed`/`cancelled` 时，以事件流的事实为准，自动将 `runs` 表更新收敛为最终一致状态，彻底清除不一致告警。

### 步骤 4：引入透明 Zstd 块压缩机制
- **大载荷透明压缩**：对 `events.payload` 大于 4KB 的记录（如长工具输出、超大分析上下文），借鉴 DSH `zstd.ts`，在落库前执行 Zstd 帧压缩存储在 BLOB 列中，读取时透明解压。
- **保持极致查询性能**：元数据列（`session_id`, `sequence`, `event_type`, `run_id`）继续走 SQLite 复合索引，兼得 DSH 的高压缩比与 Conex 的毫秒级索引定位能力。
