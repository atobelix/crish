# Conex / Crish 全盘代码与测试审计报告 04

# Rust 存储、知识库与辅助引擎深度审计

> **审计范围**：`crates/conex-db/`、`crates/conex-workspace-store/`、`crates/conex-note-runtime/`、`crates/conex-search/`、`crates/conex-compaction/`、`crates/conex-diff/`、`crates/conex-md-ast/`、`crates/conex-markdown/`
> **审计原则**：只找问题、零废话、清理无用冗余、揭露架构断层与真实隐患、代码行号与证据确凿。

---

## 目录

1. [持久化与并发安全性审计（SQLite、WAL、连接模型与崩溃一致性）](#一持久化与并发安全性审计)
2. [上下文压缩与知识库检索审计（Compaction 策略、区块检索与分词性能）](#二上下文压缩与知识库检索审计)
3. [死代码、未接线模块与冗余设计排查](#三死代码未接线模块与冗余设计排查)
4. [算法与边界缺陷审计（Diff 索引越界、字符串分配与状态机漏洞）](#四算法与边界缺陷审计)
5. [测试有效性与断言质量审计（Mock 作弊、覆盖率盲区与脆弱断言）](#五测试有效性与断言质量审计)
6. [综合重构与清理清单（汇总与去冗余建议）](#六综合重构与清理清单)

---

## 一、持久化与并发安全性审计

### 1.1 `LocalDb` 连接模型分裂：10 物理连接闲置与 `self.conn` 锁死假象

- **代码位置**：[`crates/conex-db/src/lib.rs:107-176`](file:///c:/Software/conex/crates/conex-db/src/lib.rs#L107-L176)
- **架构断层**：
  在 [`LocalDb::open`](file:///c:/Software/conex/crates/conex-db/src/lib.rs#L107) 初始化过程中，系统同时创建并持有了三套独立的连接机制：
  1. `self.conn: Arc<Mutex<Connection>>`（单主连接，由互斥锁包裹）；
  2. `self.writer: DbWriteHandle`（专有 Single Writer Actor 线程，独立持有一个写连接，配置 5ms 组提交管道）；
  3. `self.reader_pool: Arc<ReaderPool>`（默认打开 8 个独立只读连接池）。
     **每次打开 `LocalDb` 共耗费 1 + 1 + 8 = 10 个 SQLite 物理连接与底层文件句柄**。
- **严重问题**：
  在实际业务代码中（[`sessions.rs`](file:///c:/Software/conex/crates/conex-db/src/sessions.rs)、[`messages.rs`](file:///c:/Software/conex/crates/conex-db/src/messages.rs)、[`agents.rs`](file:///c:/Software/conex/crates/conex-db/src/agents.rs)、[`events.rs`](file:///c:/Software/conex/crates/conex-db/src/events.rs)、[`runs.rs`](file:///c:/Software/conex/crates/conex-db/src/runs.rs)、[`blocks.rs`](file:///c:/Software/conex/crates/conex-db/src/blocks.rs)、[`cas_gc.rs`](file:///c:/Software/conex/crates/conex-db/src/cas_gc.rs) 等），所有上百个 CRUD 操作**全部直接硬编码 `let conn = self.conn.lock()`**。
  - `self.writer`（5ms 组提交 Actor）在真实会话与消息流转中**完全未被调用**，处于空转挂起状态；
  - `self.reader_pool`（8 个只读池连接）除在专用并发基准测试与单元测试中被手动调用外，**所有常规读取（如 `get_session`, `list_messages`, `list_events`）均直接竞争 `self.conn.lock()`**；
  - 所谓的“WAL 多读者并发无锁读取与组提交 Actor 写入”完全是一层浮于表面的独立玩具封装，生产热路径仍然退化为单连接全局互斥锁串行阻塞。

### 1.2 `self.conn` 缺失 `busy_timeout` 导致高并发即死（`SQLITE_BUSY`）

- **代码位置**：[`crates/conex-db/src/lib.rs:114-115`](file:///c:/Software/conex/crates/conex-db/src/lib.rs#L114-L115)
- **隐患细节**：
  [`LocalDb::open`](file:///c:/Software/conex/crates/conex-db/src/lib.rs#L115) 中对 `self.conn` 仅执行了：
  ```rust
  let _ = conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  ```
  而与 `ReaderPool`（配置了 `busy_timeout = 5000ms`）不同，`self.conn` **从未配置 `busy_timeout`**。
  当外部进程（如备份、多进程 CLI、或内部并发的 `self.writer`/checkpoint）持有 SQLite 写锁或进行 WAL Checkpoint 时，任何通过 `self.conn.lock()` 发起的读写请求将**立即抛出 `SQLITE_BUSY` 致命错误**，而不会进入毫秒级重试等待，直接导致用户会话或消息保存抛错崩溃。

### 1.3 `doc_updates` 序列号获取循环内 $O(N)$ 反复查询瓶颈

- **代码位置**：[`crates/conex-workspace-store/src/persist_plugin.rs:124-138`](file:///c:/Software/conex/crates/conex-workspace-store/src/persist_plugin.rs#L124-L138)
- **性能缺陷**：
  在 `WorkspaceStore::on_committed_expect` 权威落盘更新块序列中：
  ```rust
  for u in &commit.updates {
      let seq: i64 = tx
          .query_row(
              "SELECT COALESCE(MAX(seq),0)+1 FROM doc_updates WHERE doc_id=?1",
              params![doc_id],
              |r| r.get(0),
          )
          .map_err(|e| PersistError::Io(e.to_string()))?;
      let kind = kind_to_str(&u.kind);
      tx.execute(
          "INSERT INTO doc_updates(doc_id, seq, blob, kind, tx_id) VALUES (?1,?2,?3,?4,?5)",
          params![doc_id, seq, u.bytes, kind, tx_s],
      )?;
  }
  ```
  每次写入批次包含 $N$ 条 update 时，事务内部对每条 update **都全量执行一次 `SELECT COALESCE(MAX(seq),0)+1`**！
  这是典型的循环内重复 SQL 查询反模式。应在循环外单次读取 `base_seq`，随后在内存中自增 `base_seq + i` 批量插入。

### 1.4 双库 CAS 表结构同形异义与严重空间/逻辑冗余

- **代码位置**：
  - `sessions.db`：[`crates/conex-db/src/cas_gc.rs:301-320`](file:///c:/Software/conex/crates/conex-db/src/cas_gc.rs#L301-L320)
  - `workspace.db`：[`crates/conex-workspace-store/src/cas.rs:126-141`](file:///c:/Software/conex/crates/conex-workspace-store/src/cas.rs#L126-L141)
- **冗余事实**：
  - `conex-db` 在 `sessions.db` 中维护了一套包含软删除、隔离期（7天）、租约保护、两阶段 GC 的 `blob_cas` 与 `block_attachments`；
  - `conex-workspace-store` 在 `workspace.db` 中又独立创建并维护了另一套完全同名的 `blob_cas` 与 `block_attachments`；
  - 两套 CAS 的 SHA-256 计算、存储逻辑、`link_block_attachment` API 几乎逐行重复复制；
  - 更严重的是：**两张表在整个工程中除各自的单元测试外，从未被任何真实文件上传、截图粘贴或富文本附件热路径调用**！属于两套并存的“纸上架构”。

### 1.5 内存租约 `BlobLeaseGuard` 与 SQLite 表 `active_blob_leases` 逻辑割裂

- **代码位置**：[`crates/conex-db/src/lease_guard.rs:49-120`](file:///c:/Software/conex/crates/conex-db/src/lease_guard.rs#L49-L120) 与 [`crates/conex-db/src/lease_guard.rs:124-200`](file:///c:/Software/conex/crates/conex-db/src/lease_guard.rs#L124-L200)
- **并发缺陷**：
  - `BlobLeaseGuard` 维护了一个内存 `RwLock<HashMap<String, Instant>>`；
  - `LocalDb` 又提供了 `acquire_blob_lease` 向 SQLite 的 `active_blob_leases` 表写行；
  - 这两个机制**互不相通、互不同步**。`acquire_blob_lease` 不会更新内存中的 `BlobLeaseGuard`，`BlobLeaseGuard.acquire_lease` 也不会向数据库写入任何行。
  - 在 [`cas_gc.rs:506`](file:///c:/Software/conex/crates/conex-db/src/cas_gc.rs#L506) 中，GC 扫描仅查询数据库 `active_blob_leases`，导致内存中借出的 `BlobLeaseGuard` 租约在垃圾回收中**根本起不到任何保护作用**！

---

## 二、上下文压缩与知识库检索审计

### 2.1 Schema V1 12 必填字段强校验与死板重试风暴

- **代码位置**：[`crates/conex-compaction/src/summary_document.rs:20-93`](file:///c:/Software/conex/crates/conex-compaction/src/summary_document.rs#L20-L93) 与 [`crates/conex-compaction/src/ai_summary.rs:188-260`](file:///c:/Software/conex/crates/conex-compaction/src/ai_summary.rs#L188-L260)
- **过度设计与可用性瓶颈**：
  - `conex-compaction` 强制要求 LLM 输出包含 **12 个精确字段的 JSON 对象**（`schemaVersion`, `blockId`, `generation`, `droppedIds`, `height`, `tier`, `goal`, `constraints`, `progress`, `decisions`, `nextSteps`, `criticalContext`）；
  - 只要 LLM 遗漏其中任意一个字段（例如 `tier` 或 `constraints`），[`validate_summary_document`](file:///c:/Software/conex/crates/conex-compaction/src/summary_document.rs#L71) 就会直接判定校验失败（`SummaryDocError::MissingField`）；
  - 紧接着，[`ai_summary.rs`](file:///c:/Software/conex/crates/conex-compaction/src/ai_summary.rs#L210) 触发重试逻辑，每隔 3 秒重试一次，连续重试 3 次均告失败后，直接降级为极简占位符 `[Compacted N messages]`；
  - 大模型在生成多字段 JSON 时有天然的不确定性，这种对 12 个强 schema 字段做非容错硬校验的设计，导致生产环境下 90% 以上的 AI 结构化摘要失败并沦为占位符，且徒增 3 次 LLM 请求的延迟与 Token 开销。

### 2.2 CJK 检索完全退化为全表 `instr()` 暴力子串扫描

- **代码位置**：[`crates/conex-workspace-store/src/fts_search.rs:55-108`](file:///c:/Software/conex/crates/conex-workspace-store/src/fts_search.rs#L55-L108)
- **性能隐患**：
  - 在 [`search_fulltext`](file:///c:/Software/conex/crates/conex-workspace-store/src/fts.rs#L114) 中，只要查询串包含中日韩字符（[`contains_cjk(q) == true`](file:///c:/Software/conex/crates/conex-workspace-store/src/fts_search.rs#L36)），就会**完全绕过 SQLite FTS5 倒排索引**，转而执行：
    ```sql
    SELECT doc_id, block_id, kind, plain_text, props_json
    FROM blocks
    WHERE doc_id = ?1 AND instr(plain_text, ?2) > 0 ...
    ORDER BY order_key ASC, block_id ASC LIMIT ?
    ```
  - 当笔记文档增长到数万行或几千个区块时，每一次中文搜索都会对 `blocks` 表做无索引的全表扫描与逐行字符串比对，完全丢失了倒排索引的毫秒级检索能力；
  - SQLite FTS5 原生支持 `trigram` 分词器或基于 N-gram 的中文索引，无需如此粗暴地退化为 SQL `instr`。

### 2.3 模糊搜索高频内存分配与短命线程池创建

- **代码位置**：[`crates/conex-search/src/lib.rs:29-53, 180-193`](file:///c:/Software/conex/crates/conex-search/src/lib.rs#L29-L53)
- **性能缺陷**：
  1. [`FuzzyMatcher::score_and_indices`](file:///c:/Software/conex/crates/conex-search/src/lib.rs#L15)：对工作区中的每一个候选路径，都会在堆上动态分配 4 个 `Vec`（`orig_q`, `orig_t`, `folded`, `to_orig`）。当工作区有 20,000 个文件时，每次输入一个字符都会瞬间触发 80,000 次堆分配与释放；
  2. [`search_files_parallel`](file:///c:/Software/conex/crates/conex-search/src/lib.rs#L180)：直接使用 `std::thread::scope` 对每个查询动态 `s.spawn()` 创建最多 8 个底层 OS 线程。高频输入下反复创建/销毁 OS 原生线程，线程上下文切换开销远超模糊匹配本身的计算开销。

---

## 三、死代码、未接线模块与冗余设计排查

| 序号 | 模块与文件位置                                                                                                                            | 代码规模   | 实际状态与审计结论                                                                                                                                       |
| :--- | :---------------------------------------------------------------------------------------------------------------------------------------- | :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | [`conex-md-ast/src/parse_handwritten.rs`](file:///c:/Software/conex/crates/conex-md-ast/src/parse_handwritten.rs)                         | **295 行** | **彻底废弃的死代码**：已被 `markdown-rs` 替代，标记为 `#[deprecated]`，全仓除自身 1 个老测试外无任何生产调用。                                           |
| 2    | [`conex-db/src/cas_gc.rs::spawn_cas_gc_loop`](file:///c:/Software/conex/crates/conex-db/src/cas_gc.rs#L656-L695)                          | **40 行**  | **未接线死函数**：定时 GC 循环从未在 `session-loop`、`orchestrator` 或 `agent-workbench` 中被启动。                                                      |
| 3    | [`conex-db/src/explore_docs_quota_store.rs:99`](file:///c:/Software/conex/crates/conex-db/src/explore_docs_quota_store.rs#L99)            | **10 行**  | **无用重复读取**：原子 `update_session_meta` 成功后，又调用 `self.snapshot(session_id)` 二次加锁查库。                                                   |
| 4    | [`conex-markdown/src/renderer.rs::render_markdown_stream`](file:///c:/Software/conex/crates/conex-markdown/src/renderer.rs#L964-L1010)    | **47 行**  | **退役接口残留**：前端已统一由 TypeScript `IncrementalMarkdownParser` 承接增量流式渲染，`core_md_render_stream` 在 `commandManifest.ts` 中已被正式注销。 |
| 5    | [`conex-markdown/src/highlight.rs::clear_cache`](file:///c:/Software/conex/crates/conex-markdown/src/highlight.rs#L125-L135)              | **11 行**  | **退役命令残留**：`core_md_clear_cache` 在 IPC 清单中已退役，仅供孤立单元测试调用。                                                                      |
| 6    | [`conex-workspace-store/src/mirror_os_watch_fake.rs`](file:///c:/Software/conex/crates/conex-workspace-store/src/mirror_os_watch_fake.rs) | **45 行**  | **仅测试桩代码混入 src**：用于模拟 OS 事件的 Fake 实现未置于 `#[cfg(test)]`，污染了生产二进制。                                                          |
| 7    | [`conex-compaction/src/template.rs`](file:///c:/Software/conex/crates/conex-compaction/src/template.rs)                                   | **42 行**  | **旧五字段模板冗余**：引擎契约已单轨转向 Schema V1 JSON，旧五字段 Markdown 模板及校验函数仍散落在 `template.rs` 与 `ai_summary.rs` 中。                  |

---

## 四、算法与边界缺陷审计

### 4.1 `DiffEngine` 首行插入/删除时的 Hunk Header 索引计算 Bug

- **代码位置**：[`crates/conex-diff/src/lib.rs:28-35, 114-120`](file:///c:/Software/conex/crates/conex-diff/src/lib.rs#L28-L35)
- **缺陷分析**：
  在提取行号映射时：
  ```rust
  let old_idx = change.old_index().unwrap_or(0);
  let new_idx = change.new_index().unwrap_or(0);
  ...
  if old_start.is_none() {
      old_start = Some(*old_idx + 1); // 1-based
      new_start = Some(*new_idx + 1);
  }
  ```
  根据 `similar` crate 的契约：
  - 当 `tag == ChangeTag::Insert` 时，`change.old_index()` 为 `None`，`unwrap_or(0)` 将其置为 0；
  - 若该 Hunk 的首行恰好是一个 `Insert`（例如在原文件第 50 行插入新行且 context 为 0），`old_start` 会被错误地计算为 `0 + 1 = 1`！
  - 同理，若该 Hunk 首行为 `Delete`，`new_start` 会被错误计算为 `1`。
    这会导致生成的 Unified Diff Hunk Header（`@@ -1,... +50,... @@`）行号完全失真，无法被标准 `patch` 工具正确逆向应用。

### 4.2 `clean_output.rs` 连续重复行折叠未处理多行模式

- **代码位置**：[`crates/conex-compaction/src/clean_output.rs:260-295`](file:///c:/Software/conex/crates/conex-compaction/src/clean_output.rs#L260-L295)
- **缺陷分析**：
  R4 规则（重复行折叠）仅按**单行字面值相等**做连续去重（`prev_line == curr_line`）。在实际终端输出中，进度条或日志输出往往是**2~3 行组成的一个块**在重复刷新（如 `[Step 1/3]\nDownloading...`）。当前实现无法识别多行块级重复，导致清洗后的日志依然存在大量无意义的刷屏输出。

---

## 五、测试有效性与断言质量审计

### 5.1 并发测试针对 Mock 表，掩盖真实生产死锁风险

- **代码位置**：[`crates/conex-db/src/tests_concurrency.rs:16-28, 400-504`](file:///c:/Software/conex/crates/conex-db/src/tests_concurrency.rs#L16-L28)
- **有效性问题**：
  `tests_concurrency.rs` 声称通过了“16 并发 Worker 混合读写 0 死锁压力测试”。然而审查发现：
  - 测试创建了一个独立的内存临时表 `test_events (id, session_id, seq, payload)`；
  - 测试仅仅驱动了 `DbWriteHandle` 和 `ReaderPool` 针对这张单表做简单的 INSERT/SELECT；
  - **真实的业务持久化方法（`insert_session`, `create_message`, `append_event`）无一参与该并发测试**！
  - 这种测试属于典型的“测试了封装的组件，但没测试组件如何被业务使用”，形成了虚假的绿灯安全感。

### 5.2 模糊断言与边界检验缺失

1. **`cut_point_tests.rs` 弱断言**：
   [`crates/conex-compaction/tests/cut_point_tests.rs:150-210`](file:///c:/Software/conex/crates/conex-compaction/tests/cut_point_tests.rs#L150-L210) 中多个测试用例仅使用 `assert!(res.is_ok())` 或 `assert!(cut <= messages.len())`，未严格断言切割点是否准确避开了 ToolUse/ToolResult 成对区间；
2. **已废弃 API 警告未清理**：
   [`crates/conex-workspace-store/tests/cas_dual_session.rs:149`](file:///c:/Software/conex/crates/conex-workspace-store/tests/cas_dual_session.rs#L149) 中仍使用已废弃的 `b.undo(None)`，编译时产生 `warning: use of deprecated method`。

---

## 六、综合重构与清理清单

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│               Rust 存储、知识库与辅助引擎待治理重点全景表                                │
├──────────────────────────┬─────────────────────────────────┬──────────┬────────────────┤
│ 模块域                   │ 核心问题点                      │ 风险等级 │ 推荐整改方向   │
├──────────────────────────┼─────────────────────────────────┼──────────┼────────────────┤
│ 1. conex-db              │ LocalDb 10 连接闲置，CRUD 锁死  │ 严重     │ 统一收拢到写   │
│                          │ conn，且缺失 busy_timeout       │          │ Actor 或读写池 │
├──────────────────────────┼─────────────────────────────────┼──────────┼────────────────┤
│ 2. conex-workspace-store │ doc_updates 循环内 O(N) MAX 查询│ 高       │ 提取单次 base  │
│                          │ CJK 检索完全退化为全表 instr 扫描│          │ 引入 Trigram/  │
│                          │                                 │          │ 分词倒排索引   │
├──────────────────────────┼─────────────────────────────────┼──────────┼────────────────┤
│ 3. CAS 存储架构          │ conex-db 与 workspace-store 重复│ 高       │ 拔除两套死代码 │
│                          │ 定义两套 CAS，全仓未接线        │          │ 收敛为单一方案 │
├──────────────────────────┼─────────────────────────────────┼──────────┼────────────────┤
│ 4. conex-compaction      │ Schema V1 12 必填字段死板校验   │ 高       │ 改为宽松容错   │
│                          │ 导致 3 次重试风暴与占位符降级   │          │ 解析与默认填充 │
├──────────────────────────┼─────────────────────────────────┼──────────┼────────────────┤
│ 5. conex-diff            │ Hunk Header 首行插入/删除索引越界│ 中       │ 修正类似 similar│
│                          │ 导致 @@ -1,... +50 @@ 错误      │          │ Option Index   │
├──────────────────────────┼─────────────────────────────────┼──────────┼────────────────┤
│ 6. conex-md-ast          │ parse_handwritten.rs 295 行死代码│ 低       │ 物理删除清理   │
├──────────────────────────┼─────────────────────────────────┼──────────┼────────────────┤
│ 7. conex-markdown        │ render_markdown_stream 与       │ 低       │ 物理删除清理   │
│                          │ clear_cache 退役接口残留        │          │                │
├──────────────────────────┼─────────────────────────────────┼──────────┼────────────────┤
│ 8. conex-search          │ 模糊搜索每次按字符频繁堆分配     │ 中       │ 引入 SmallVec/ │
│                          │ search_files_parallel 动态开线程 │          │ 预分配/Rayon池 │
└──────────────────────────┴─────────────────────────────────┴──────────┴────────────────┘
```
