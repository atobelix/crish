# 03-方案-书签历史入conex-db目标表

> - **用途**：G-4 剩余项「书签/历史入 conex-db 目标表（目标表当前不存在，需设计）」的方案文档，可直接派实现 Agent。
> - **勘察基线**：git HEAD（4990d870）。`crates/conex-browser/src/import/` 无在途改动，勘察以已提交代码为准；`cdp/` 有并行 Agent 在途改动，与本文无关。
> - **范围**：解析层（bookmarks.rs/history.rs）已实现且 31 新测试全绿（G-4 登记），**本文不讨论解析层内部改动**，只做落库接入设计；其中解析层与文档口径的两处差异（去重键、历史默认上限）已按「以代码为准」标注（§1.4）。
> - **文件域**：实现 Agent 可写文件清单见 §4.2 各单元「文件域」；本文档为唯一方案产出，勘察阶段未修改任何代码。
> - **权威依据**：`docs/browser-collaboration/source/16-维度-数据导入与持久化.md` §6（§6.1 书签 / §6.2 历史 / §6.3 向导编排）；`docs/feature-gap-analysis/浏览器协同-已知不足与缺口.md` G-4 行。

---

## 1. 现状盘点

### 1.1 书签解析输出形状（`crates/conex-browser/src/import/bookmarks.rs`）

| 项 | 现状 | 位置 |
|---|---|---|
| 扁平化条目 | `BookmarkItem { folder_path: Vec<String>, name: String, url: String }`——`folder_path` 为顶层根映射名（「书签栏」/「其他书签」/「同步书签」/「移动端书签」）到父文件夹的路径链 | bookmarks.rs:51-59 |
| 解析报告 | `BookmarksReport { items: Vec<BookmarkItem>, skipped_invalid, depth_cutoff, dropped_dupes, truncated }` | bookmarks.rs:62-74 |
| 幂等去重键 | **`(url, name)`**（跨四树全局去重，`HashSet<(String, String)>`） | bookmarks.rs:117, 234-238 |
| 数量上限 | `BOOKMARKS_DEFAULT_LIMIT = 10_000`（可配） | bookmarks.rs:23 |
| 深度守卫 | `BOOKMARKS_MAX_DEPTH = 48`，超深子树整支跳过 | bookmarks.rs:30 |
| 顶层根 | 四树 + 未知根键按原名容错 | bookmarks.rs:119-131 |
| 来源字段 | 未解析 Chrome JSON 节点的 `guid` 字段（节点实际含 guid，解析层未产出） | — |

规模上限：单次解析 ≤ 10 000 条（limit 截断，`truncated` 计数由上层分批语义处理，bookmarks.rs:71-73）。

### 1.2 历史读取输出形状（`crates/conex-browser/src/import/history.rs`）

| 项 | 现状 | 位置 |
|---|---|---|
| 单条记录 | `HistoryItem { url: String, title: Option<String>, visited_at: i64 }`——`visited_at` 为 **Unix 秒**（WebKit 微秒换算：`visit_us / 1e6 - 11_644_473_600`） | history.rs:32-40, 141 |
| 读取报告 | `HistoryReport { items, total, skipped_invalid_url }` | history.rs:43-51 |
| 默认范围 | 最近 `HISTORY_DEFAULT_DAYS = 90` 天 | history.rs:22 |
| 默认上限 | `HISTORY_DEFAULT_LIMIT = 1000`（可配） | history.rs:24 |
| 无效行 | 非 http/https 或不可解析 URL 丢弃 | history.rs:135-139, 166-170 |
| 只读保证 | `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`，字节不变断言 | history.rs:92-99, tests:350-380 |
| 去重（目标表口径） | 维度 16 §6.2 定 `(url, visit_time)`；history.rs:14 注明「目标表 `imported_history` 按 (url, visit_time) 去重属 conex-db 接线遗留」 | history.rs:14 |

规模上限：单次读取 ≤ 1 000 条（可配上限）。**注意**：维度 16 §6.2（16-维度-数据导入与持久化.md:403）写「最多 10000 条」，代码实际默认 1000（history.rs:24 注「任务书口径：默认 1000」）——以代码为准，本方案按 1000 默认、可配处理，不引入新上限。

### 1.3 conex-db 现有表设计惯例（`crates/conex-db/src/`）

| 惯例 | 内容 | 位置 |
|---|---|---|
| 复合主键表 | 复合 TEXT 主键 + `WITHOUT ROWID`（events `(session_id, sequence)`、compression_blocks `(session_id, block_id)`、session_messages `(session_id, seq)`） | schema.rs:141-149, migrate.rs:535-563 |
| 单列主键表 | 单 TEXT 主键 + `WITHOUT ROWID`（sessions.id、run_id、session_meta.key） | schema.rs:123-139, 250-253 |
| 时间戳列 | `INTEGER`；毫秒列显式 `_ms` 后缀（`dropped_at_ms`、`warm_until_ms`），秒/未定精度裸名（`timestamp`、`created_at`、`updated_at`） | migrate.rs:549, 556; schema.rs:133-138 |
| JSON 存 TEXT | `*_json` 后缀列存 JSON 字符串（`tool_calls_json`、`pinned_message_ids`、`dropped_message_ids`、`allowed_write_paths_json`） | schema.rs:202, 227; migrate.rs:545 |
| 索引 | `CREATE INDEX IF NOT EXISTS idx_<表>_<列>`（idx_runs_session、idx_pending_session、idx_compression_blocks_session_gen） | schema.rs:171, 182; migrate.rs:560-561 |
| 幂等写入 | `INSERT OR IGNORE`（blocks.rs 行创建）、`ON CONFLICT ... DO UPDATE`（import.rs:52-69 upsert） | blocks.rs:15-16; import.rs:52 |
| 行类型叶子纪律 | 行结构在 conex-db 内独立定义（`CompactionBlockRow`），与引擎侧字段一一对应，转换由上层负责；conex-db 不引入引擎 crate 依赖 | blocks.rs:76-82 |
| 缺表降级 | 读写面先探测 `sqlite_master`（每连接缓存一次），缺表返回空集/Ok 并 `tracing::warn!`，绝不 SQL 报错 latch 死库 | blocks.rs:13-30 |
| 迁移 | `PRAGMA user_version` 驱动 v1→v7 逐版本、每版本独立事务、幂等可重试；user_version 写入迁移事务内；纯 ADD COLUMN/纯建表版本（v5/v6/v7）跳过 DROP 前备份 | migrate.rs:99-209 |
| 模块域 | 每域一文件（sessions/messages/agents/events/runs/import/blocks），lib.rs re-export 公共面 | lib.rs:19-35 |
| 版本常量 | `LATEST_VERSION` / `SCHEMA_VERSION_STRING`（当前 7/"7"），session_meta.schema_version 同步登记 | lib.rs:56-58; migrate.rs:212-224 |
| 既有库升级测试 | `tests/upgrade_e2e.rs`（v4 fixture 全链）+ `tests/blocks.rs`（v6 fixture → v7 断言 user_version/表/索引收敛，blocks.rs:82-134, 164-174） | tests/blocks.rs |

### 1.4 接线现状与文档差异标注

1. **ImportService 尚未接线到任何消费方**：`ImportService::import_bookmarks / import_history`（import/mod.rs:178-195）仅返回解析/读取报告，仓库内无 Tauri 命令、无前端调用引用它；mod.rs:177 自注「结果写入本地书签库属 conex-db 接线（遗留）」。
2. **crate 依赖方向（架构事实）**：`conex-browser/Cargo.toml` **不依赖** conex-db（也不依赖 conex-types）；`conex-db/Cargo.toml` 不依赖 conex-browser。维度 16 文档 line 60 曾规划「conex-browser 依赖 conex-db（只读 SQLite 辅助，历史/回读校验）」，**实际实现用 rusqlite 直连只读（history.rs:92-99、verify.rs），未引 conex-db**——以代码为准：解析层保持纯数据（无 DB 依赖），落库接线在 Tauri 壳层编排（§4.1）。
3. **书签去重键差异**：维度 16 §6.1（16-维度-数据导入与持久化.md:384）写目标表按 `(folder_path, name, url)` 唯一键；**代码解析层按 `(url, name)` 去重**（bookmarks.rs:117）——以代码为准：解析层输出中 `(url, name)` 已全局唯一，目标表主键与解析层对齐（§2.1）。
4. **导入统计类型撞名**：`conex-types::ImportStats { sessions, messages, agents }`（conex-types/src/lib.rs:274-281，会话导入统计）与 `conex-browser/import/storage_state.rs::ImportStats { cookies, dropped_dupes, ... }`（storage_state.rs:242-253，cookie 注入计划统计）已是两个同名不同类型——新统计类型不再使用 `ImportStats` 名（§2.5）。

---

## 2. 目标表设计

设计原则：与 §1.3 惯例逐项对齐（复合 TEXT 主键 + WITHOUT ROWID、`*_json` 存 JSON、`idx_*` 索引名、INSERT OR IGNORE 幂等、行类型叶子纪律）；「导入结果」语义——表归 conex-db 管理、与浏览器数据解耦（16-维度-数据导入与持久化.md:383）。

### 2.1 `imported_bookmarks` 表

```sql
CREATE TABLE IF NOT EXISTS imported_bookmarks (
    url              TEXT NOT NULL,
    name             TEXT NOT NULL,
    folder_path_json TEXT NOT NULL,            -- JSON 字符串数组，如 ["书签栏","工作"]（对齐 *_json 惯例）
    guid             TEXT,                     -- 来源 guid（Chrome JSON 节点字段；解析层暂不产出 → 恒 NULL，预留扩展）
    source           TEXT NOT NULL DEFAULT 'default',  -- 来源标识（family/profile），信息列不入主键
    imported_at      INTEGER NOT NULL,         -- 导入时刻（unix 秒），审计/排序
    PRIMARY KEY (url, name)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_imported_bookmarks_imported_at
    ON imported_bookmarks (imported_at DESC);
```

- **主键 `(url, name)`**：与解析层去重键（bookmarks.rs:117）逐字节对齐——到达落库层的数据 `(url, name)` 已全局唯一，`INSERT OR IGNORE` 天然幂等，重复导入（含跨批次重导）跳过。复合 TEXT 主键 + WITHOUT ROWID 对齐 events/compression_blocks 惯例（schema.rs:141-149; migrate.rs:535-563）。
- **`folder_path_json`**：解析层 `folder_path: Vec<String>`（bookmarks.rs:54）序列化为 JSON 字符串数组，对齐 `*_json` 惯例（schema.rs:202）。树形展示由应用层反序列化后按路径链渲染（量级 ≤ 1 万，全表扫描可接受，无需 SQL 层树索引；如未来需 SQL 层前缀查询再做路径规范化列，见 §7 待裁决项）。
- **`guid`**：Chrome Bookmarks JSON 节点实际含 `guid` 字段但解析层未产出（bookmarks.rs:50-59 无该字段）。首版全部 NULL 落库，列预留；是否升级解析层产出 guid 见 §7 待裁决项。
- **`source`**：多来源（Chrome/Edge 多 profile，discovery 三平台）导入到同一表时记录来源标识（如 `chrome/Default`、`edge/Profile 1`），**不参与主键**——语义是「用户书签集合」：跨来源同 (url, name) 合并为一条（与解析层跨树去重同哲学）。如需按来源保留重复条目，改为复合主键 `(source, url, name)`，见 §7 待裁决项。

### 2.2 `imported_history` 表

```sql
CREATE TABLE IF NOT EXISTS imported_history (
    url         TEXT NOT NULL,
    visited_at  INTEGER NOT NULL,              -- unix 秒（解析层已换算，history.rs:141）
    title       TEXT,                          -- 页面标题（来源 NULL → NULL）
    source      TEXT NOT NULL DEFAULT 'default',
    imported_at INTEGER NOT NULL,
    PRIMARY KEY (url, visited_at)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_imported_history_visited_at
    ON imported_history (visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_imported_history_url
    ON imported_history (url);
```

- **主键 `(url, visited_at)`**：落实 history.rs:14 与维度 16 §6.2（:404）的既定口径「目标表按 (url, visit_time) 去重（幂等重导）；同 URL 多次访问保留多条（历史语义）」——同 URL 不同秒的访问各保留一条。
- **`visited_at` 精度**：解析层输出为 Unix 秒（history.rs:9 契约），主键直接沿用——**同 URL 同一秒内多次访问合并为一条**（丢真实多访语义）。评估：Chrome visit_time 为微秒粒度，同 URL 同秒多访占比极低，可接受；如需保真须改解析层契约（见 §6 与 §7 待裁决项）。
- **`title`**：来源 NULL → NULL（Option 语义，对齐 history.rs:37 与 runs.warm_until_ms 的 NULL 兼容惯例 migrate.rs:477）。重复导入时冲突行被 IGNORE，标题不覆盖（幂等优先；如需「标题取最新」改 DO UPDATE，见 §7）。
- **索引**：`visited_at DESC` 为时间倒序浏览主查询面（对齐解析层 ORDER BY visit_time DESC 语义 history.rs:109）；`url` 索引供按站聚合。

### 2.3 写入/读取 API（conex-db 新模块 `imported.rs`）

对齐 blocks.rs 的模块模式（行类型叶子纪律，blocks.rs:76-82）——conex-db 不依赖 conex-browser，行类型在本 crate 内独立定义，`BookmarkItem/HistoryItem → Row` 转换由壳层完成（§4.2 U4）。

```rust
// crates/conex-db/src/imported.rs（新模块，lib.rs 声明 + re-export）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportedBookmarkRow {
    pub url: String,
    pub name: String,
    pub folder_path: Vec<String>,   // 落库时序列化为 folder_path_json
    pub guid: Option<String>,       // 首版恒 None
    pub source: String,             // 默认 "default"
    pub imported_at: i64,           // unix 秒
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportedHistoryRow {
    pub url: String,
    pub visited_at: i64,
    pub title: Option<String>,
    pub source: String,
    pub imported_at: i64,
}

/// 导入结果（INSERT OR IGNORE 影响行数统计）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportedWriteStats { pub inserted: u64, pub skipped_dupes: u64 }

impl LocalDb {
    /// 书签落库：单事务 + 1000 条/批提交（§6.1 分批语义，16-维度:385）；INSERT OR IGNORE 幂等。
    pub fn import_bookmarks(&self, rows: &[ImportedBookmarkRow]) -> Result<ImportedWriteStats, DbFailure>;
    /// 历史落库：同上；主键 (url, visited_at) 幂等。
    pub fn import_history(&self, rows: &[ImportedHistoryRow]) -> Result<ImportedWriteStats, DbFailure>;
    /// 查询面（面板书签侧栏/历史浏览/审计计数）。
    pub fn list_bookmarks(&self) -> Result<Vec<ImportedBookmarkRow>, DbFailure>;
    pub fn list_history(&self, since: Option<i64>, limit: usize) -> Result<Vec<ImportedHistoryRow>, DbFailure>;  // visited_at DESC
    pub fn count_bookmarks(&self) -> Result<u64, DbFailure>;
    pub fn count_history(&self) -> Result<u64, DbFailure>;
}
```

- 行类型/统计需 `Serialize` 以直通 Tauri IPC → conex-db 增加 `serde = { workspace = true }` 依赖（workspace 已有声明，零新增版本面；Cargo.toml:6 的「G5 清理：serde 本体无引用」注释随新增引用更新说明——G5 清理前提变化，属合理新增）。
- 缺表降级：对齐 blocks.rs:13-30（sqlite_master 探测 + 每连接缓存 + `tracing::warn!`，查询返回空集/Ok(0)、写入返回 Ok），旧库文件（v7）被新代码打开时经迁移升 v8 无缺表场景，但备份恢复/异常中间态下读写面不 latch（R12/P2-1 纪律）。

### 2.4 幂等与去重策略（汇总）

| 链路 | 唯一键 | 写入方式 | 幂等语义 |
|---|---|---|---|
| 书签 | `(url, name)`（表主键 = 解析层去重键） | INSERT OR IGNORE，1000 条/批事务 | 重复导入全部跳过；`skipped_dupes` 计数供 UI 明示 |
| 历史 | `(url, visited_at)`（16 §6.2 口径） | 同上 | 重导（同文件或 since 窗口重叠）跳过；同 URL 不同秒保留多条 |

不做「导入前清空重灌」（import.rs:90-95 的 DELETE 先清是 localStorage 一次性迁移语义，与增量书签/历史导入语义不同）；不做跨表依赖（两张表无外键——书签/历史与 sessions 无关联，对齐 compression_blocks 无 FK 先例 migrate.rs:537-559）。

### 2.5 统计类型（conex-types）

新增共享统计类型（放 `crates/conex-types/src/lib.rs`，与 ImportStats 同文件），**不复用/不扩展 `ImportStats`**（该类型是会话导入统计 `sessions/messages/agents`，conex-types/src/lib.rs:274-281；storage_state 已有同名撞车先例 §1.4-4）：

```rust
/// 浏览器数据落库统计（书签/历史导入，serde camelCase，对齐 ImportStats 惯例）
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserImportStats {
    #[serde(default)] pub bookmarks_inserted: u64,
    #[serde(default)] pub bookmarks_skipped_dupes: u64,
    #[serde(default)] pub history_inserted: u64,
    #[serde(default)] pub history_skipped_dupes: u64,
}
```

壳层把 conex-db 的 `ImportedWriteStats`（每批）聚合进 `BrowserImportStats` 返回给前端（parse 侧统计另有 BookmarksReport/HistoryReport 原样透传，不改造 conex-browser 类型——其无 serde derive 且属纯解析层，保持不动）。

---

## 3. 迁移与版本管理

### 3.1 现有版本推进方式（migrate.rs:99-209）

- `PRAGMA user_version` 为权威源；`LocalDb::open` 触发 `migrate()`（lib.rs:80）；从当前版本逐级迁到 `LATEST_VERSION`。
- 每版本独立事务；user_version 写入迁移事务内（T3.1 D1，migrate.rs:193-198）；`CREATE TABLE IF NOT EXISTS` 天然幂等（崩溃中间态重跑自愈）。
- 纯 ADD COLUMN/纯建表版本（v5/v6/v7）跳过「checkpoint + 备份」（migrate.rs:152-171 的 `!(5..=7).contains(&version)`），`upgrade_e2e_backup_*` 锚定不产备份。
- v7 先例：新表 DDL 直接写在迁移函数内（migrate_v6_to_v7，migrate.rs:535-563），不进 create_v5_schema（create_v5_schema 仅确保 v5 目标形态，migrate.rs:114-119 短路路径与 203-205 收尾路径都只跑它）；新表缺表兜底靠读写面的 sqlite_master 探测降级（blocks.rs 模式）。

### 3.2 v8 迁移接入（新增两张表，纯建表，完全对齐 v7 先例）

| 改动点 | 文件 | 内容 |
|---|---|---|
| 版本常量 | `crates/conex-db/src/lib.rs` | `LATEST_VERSION: u32 = 8`（lib.rs:56）、`SCHEMA_VERSION_STRING = "8"`（lib.rs:58），版本注释补 v8 说明 |
| 迁移分发 | `crates/conex-db/src/migrate.rs` | `match` 加 `8 => migrate_v7_to_v8(&tx)`（对齐 migrate.rs:175-182） |
| 备份跳过范围 | `crates/conex-db/src/migrate.rs` | `!(5..=7).contains(&version)` → `!(5..=8).contains(&version)`（migrate.rs:157，v8 纯建表不产备份，同步 `backup_file_contains_pre_migration_data` 锚定注释 migrate.rs:152-155） |
| 迁移函数 | `crates/conex-db/src/migrate.rs` | `fn migrate_v7_to_v8(tx)`：执行 §2.1/§2.2 两张表的 `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`（逐字对齐 migrate_v6_to_v7 风格 migrate.rs:535-563） |

- **create_v5_schema 不动**（对齐 v7 先例：新表不进目标 DDL 函数；短路/收尾 ensure 不含新表，缺表兜底走读写面探测降级）。
- 幂等：`IF NOT EXISTS` 天然满足「每版本独立事务、幂等可重试」约定。

### 3.3 既有库升级路径

| 场景 | 行为 |
|---|---|
| 全新库 | 建 v1 形态 → 走 v1..v8 完整链（fresh_db_full_chain 锚定模式，migrate.rs:122-124） |
| 既有 v7 生产库（当前真实形态） | user_version=7 → 仅执行 v7→v8 一步（迁移函数内建两张新表），老表零改动、数据完好；session_meta.schema_version 收敛为 "8"（record_schema_version，migrate.rs:212-224） |
| 更旧库（v1-v6） | 逐级迁移到 v7 后接 v8，链路不变 |
| 崩溃中间态重跑 | 表已建、版本仍 7 → `IF NOT EXISTS` 幂等自愈，user_version 在事务内推进（migrate.rs:193-198） |
| 备份恢复出 v8 缺表 | 读写面缺表降级（§2.3），不 latch |

升级测试模式对齐 `tests/blocks.rs`（v6 fixture → v7 断言，blocks.rs:82-134, 164-174）：构造 user_version=7 的完整 fixture 库（含 sessions/runs/events 数据行）→ `LocalDb::open` → 断言 user_version=8、老表行数不变、新表存在可写、schema_version 收敛。

---

## 4. 接线点清单

### 4.1 架构约束（为什么写入不挂在 ImportService 上）

任务书问「ImportService → conex-db 哪个 API」——**ImportService 不能直接持有 conex-db 写入面**：`conex-browser` 不依赖 conex-db（§1.4-2），而 `conex-db` 生产依赖 agent-tools（conex-db/Cargo.toml:16-21），若 conex-browser 引 conex-db 会把 agent-tools 拉进浏览器 crate 依赖图（结构不干净）。既有架构的分工是：conex-browser = 纯解析（叶子）、conex-db = 存储（叶子）、**编排在 Tauri 壳层**（session_commands.rs 的 import_from_localstorage 即此模式：壳层命令 → spawn_blocking → LocalDb API，session_commands.rs:318-337）。本方案写入路径：

```
前端 invoke
  → 壳层命令（apps/agent-workbench/src-tauri/src/import_commands.rs，新）
      → conex-browser::ImportService::import_bookmarks / import_history   （解析/读取，同步纯函数）
      → 壳层转换 BookmarkItem/HistoryItem → ImportedBookmarkRow/ImportedHistoryRow（补 source/imported_at）
      → LocalDb::import_bookmarks / import_history                          （conex-db 新 API，§2.3）
  → 返回 BrowserImportStats + 解析侧报告（BookmarksReport/HistoryReport 壳层自定 serde 形状）
```

### 4.2 任务单元（文件域 + 实现顺序依赖）

| 单元 | 文件域（可写） | 内容 | 依赖 |
|---|---|---|---|
| **U1 表 DDL + v8 迁移** | `crates/conex-db/src/migrate.rs`、`crates/conex-db/src/lib.rs` | §3.2 四项改动；单元测试（表存在/索引/幂等/版本收敛） | 无（最先） |
| **U2 读写 API** | `crates/conex-db/src/imported.rs`（新）、`crates/conex-db/src/lib.rs`（mod + re-export）、`crates/conex-db/Cargo.toml`（serde 依赖） | §2.3 行类型 + 6 个方法 + 缺表降级；Cargo.toml:6 G5 注释更新 | U1 |
| **U3 统计类型** | `crates/conex-types/src/lib.rs` | §2.5 `BrowserImportStats`（含 serde 往返测试） | 无（可与 U1/U2 并行） |
| **U4 壳层命令** | `apps/agent-workbench/src-tauri/src/import_commands.rs`（新）、`apps/agent-workbench/src-tauri/src/main.rs`（mod + `build_invoke_handler` 注册，对齐 main.rs:168-176）、`apps/agent-workbench/src-tauri/src/command_manifest.rs`（登记，对齐 command_manifest.rs:136） | 4 条命令：`browser_import_bookmarks` / `browser_import_history`（spawn_blocking + SharedDb 模式，session_commands.rs:33-64, 318-337）/ `browser_list_bookmarks` / `browser_list_history`；行转换 + 统计聚合；错误映射 CoreError（InvalidInput/NotFound/Internal） | U1+U2+U3 |
| **U5 既有库升级 e2e** | `crates/conex-db/tests/imported_upgrade.rs`（新，或并入 tests/blocks.rs 模式单测） | §3.3 v7 fixture 全链断言 | U1（可与 U2-U4 并行） |
| **U6 前端入口（可选）** | `apps/crish-desktop/src/...`（面板设置区「书签/历史导入」常驻入口，16 §6.3；具体文件由实现 Agent 依 BrowserPanel 现状定位） | 调 U4 命令 + 结果明示（条数/跳过数）；是否本轮包含见 §7 待裁决项 | U4 |

**实现顺序**：U1 →（U2 ∥ U3 可并行）→ U4 → U5 可在 U1 后任意点；U6 最后且可选。U1-U5 不触碰 `crates/conex-browser/src/import/`（解析层零改动，31 新测试门禁不受影响）。

---

## 5. 验收断言

门禁口径（AGENTS.md）：改动 conex-db 后 `cargo test -p conex-db` 全绿；全仓 `cargo test --workspace` 无回归；不碰前端则 typecheck 不受影响（U6 另计）。

**U1 表 DDL + v8 迁移**
1. `LocalDb::open_in_memory()` 后 `user_version() == 8`（对齐 tests.rs:375 `schema_version_is_current` 模式）。
2. `sqlite_master` 含 `imported_bookmarks`、`imported_history` 及 3 个索引（idx_imported_bookmarks_imported_at、idx_imported_history_visited_at、idx_imported_history_url）；`PRAGMA table_info` 列清单与 §2.1/§2.2 逐列一致。
3. 新建 v7 fixture 库（含 sessions/runs/events 有数据行，user_version=7）→ `open` → `user_version() == 8`，老表行数不变（对齐 tests/blocks.rs:164-174 断言模式）。
4. 迁移幂等重跑：v8 库再次执行 migrate 路径（短路 + 收尾 ensure）不报错、行数不变（对齐 tests.rs:741 `migrate_v4_to_v5_idempotent_rerun` 模式）。
5. `SCHEMA_VERSION_STRING == "8"` 且 `session_meta.schema_version == "8"`；v8 迁移**不产生** `.bak-v8` 备份（备份跳过范围 5..=8，对齐 upgrade_e2e_backup_* 锚定）。

**U2 读写 API**
6. 往返：`import_bookmarks(3 行)` → `list_bookmarks()` 3 行，url/name/folder_path（反序列化后逐元素）/guid/source/imported_at 全等。
7. 书签幂等：同一批 3 行再导 → `count_bookmarks() == 3`，`ImportedWriteStats.skipped_dupes == 3`、`inserted == 0`；同 (url, name) 不同 folder_path → 1 行（IGNORE 语义）。
8. 历史幂等：同 (url, visited_at) 两次 → 1 行；同 url 不同 visited_at → 2 行；title None 往返（读回 None）；title Some 往返。
9. `list_history(since, limit)`：visited_at DESC 排序 + since 过滤 + limit 截断（对齐解析层语义 history.rs:100-111）。
10. 分批事务：2 005 行一次 `import_bookmarks` 全部落库（多批 1000/1000/5，无部分提交丢失）。
11. 缺表降级：手工删表后（模拟备份恢复异常态）查询返回空集、写入返回 Ok 且 `tracing::warn!` 出现，不 latch（对齐 blocks.rs 缺表测试）。

**U3 统计类型**
12. `BrowserImportStats` serde 往返（camelCase 字段名）；`default()` 全 0；与既有 `ImportStats`（conex-types/src/lib.rs:274）并存编译无冲突。

**U4 壳层命令**
13. `browser_import_bookmarks`：非法 JSON → `CoreError::InvalidInput`；合法树 → 返回 `BrowserImportStats.bookmarks_inserted` 与解析侧报告（items 数一致）；同树二次导入 → `skipped_dupes` 全量、inserted 0。
14. `browser_import_history`：库缺失 → `CoreError::NotFound`；损坏库 → Internal（对齐 HistoryError 映射 history.rs:72-81）；正常 → history_inserted 正确。
15. `browser_list_bookmarks / browser_list_history` 可 invoke 并返回行数据（Tauri 命令测试用 in-memory LocalDb + SharedDb 模式，对齐 session_commands.rs:611-618）。
16. `command_manifest.rs` 登记 4 条命令（对齐 command_manifest.rs:136 格式）。

**U5 既有库升级 e2e**
17. v7 fixture（含老表数据 + `user_version=7`）→ open → v8：老表行数/内容不变；新表写入读回正常；`session_meta.schema_version` 收敛 "8"；全程无 `.bak-v8`。

**U6 前端（若含）**
18. 面板设置区入口可触发导入并明示「导入 N 条 / 跳过 M 条」；重复触发幂等（跳过数 = 上轮条数）。

---

## 6. 风险与边界

| 风险 | 评估 | 处置 |
|---|---|---|
| 历史同秒合并 | 解析层输出 Unix 秒（history.rs:9 契约），主键 `(url, visited_at)` 使同 URL 同秒多次访问合并为一条；真实数据占比极低 | 接受（§2.2）；如需保真须改解析层契约（HistoryItem 加微秒列）→ §7 待裁决 |
| 书签去重键口径 | 维度 16 §6.1 文档写 `(folder_path, name, url)`，代码实际 `(url, name)` | 以代码为准，表主键对齐解析层（§2.1）；文档差异已在 §1.4-3 标注 |
| 历史默认上限口径 | 文档写 10000（:403），代码默认 1000（history.rs:24） | 以代码为准（§1.2），可配 |
| 数据规模 | 单次书签 ≤ 10 000 / 历史 ≤ 1 000；表累计无硬上限（SQLite TEXT 主键 + WITHOUT ROWID 无压力）；每批 1000 条事务避免长事务锁 | 分批事务（§2.3）；若未来全量重导超过解析上限，走多次导入幂等累积（主键保证） |
| URL 长度边界 | 书签/历史 URL 可为数 KB 长字符串（TEXT 无长度限制，SQLite 主键索引 OK）；极端长 URL 不影响正确性 | 无特殊处理；不设 VARCHAR(n)（SQLite 不强制） |
| 时间戳精度 | visited_at 秒精度（见上）；imported_at 用 unix 秒足够（审计粒度） | 接受 |
| 隐私面：备份含历史 | 迁移备份轮转 `.bak-v{n}`（BACKUP_KEEP=2，migrate.rs:62-67）在 v8 后含 imported_history URL 数据；v8 本身不产新备份，但既有备份轮转语义延续 | 标注：与 sessions.db 同库的固有属性，符合 16 §6.2 隐私提示口径（导入前确认对话框）；不新增处置 |
| 与 storage_state 共存 | storage_state 走 CDP 注入（不落库，mod.rs:155-173），书签/历史落 conex-db——互不冲突；共享 DB 连接由 LocalDb 单写模型串行（lib.rs:41-49） | 无冲突；注意统计类型命名避免再撞车（§2.5） |
| 多来源合并 | 不同浏览器/profile 导入同 (url, name)/(url, visited_at) 合并（source 列记录来源） | 主方案接受；按源保留为备选（§7） |
| 并行 Agent 在途改动 | cdp/、import/ 部分文件被并行修改（git status 见 M），勘察以 HEAD 为准 | 实现 Agent 开工前重读 import/mod.rs 最新状态；U1-U5 文件域不重叠 |
| conex-db 依赖面新增 serde | G5 曾清理「serde 本体无引用」 | 本次新增真实引用，属合理新增；更新 Cargo.toml 注释说明（U2） |

---

## 7. 待主控裁决项

1. **书签 `guid` 是否本轮解析**：列已预留（恒 NULL）；解析层加 guid 字段（BookmarkItem 增列 + JSON 读取）会触碰已全绿门禁的 bookmarks.rs——建议首版不解析，列为后续增强。**默认：不解析。**
2. **重导时 folder_path/title 是否覆盖更新**：主方案 INSERT OR IGNORE（纯幂等，信息保持首版）；备选 `ON CONFLICT DO UPDATE`（书签同步最新路径、历史同步最新标题）。**默认：IGNORE。**
3. **多来源是否按源保留重复**：主方案 `(url, name)`/`(url, visited_at)` 跨源合并（source 信息列）；备选主键加 source 前缀。**默认：合并。**
4. **历史精度保真**：默认按秒（同秒合并）；如需微秒保真，须改解析层 HistoryItem 契约（新增精度列），涉及解析层改动与门禁回归。**默认：不改。**
5. **U6 前端入口是否本轮包含**：核心验收 U1-U5 不含前端；前端面板设置区入口依赖 U4 且涉 crish-desktop 文件。**默认：U6 列为下一轮（或本轮尾部）可裁剪单元。**

---

## 附：关键证据索引（file:line）

- 解析层形状：bookmarks.rs:51-74 / history.rs:32-51
- 解析层去重键：bookmarks.rs:117, 234-238；目标表口径：history.rs:14、16-维度-数据导入与持久化.md:384, 404
- 数量上限：bookmarks.rs:23 / history.rs:24
- ImportService 遗留注：import/mod.rs:177-183, 186-195
- 表设计惯例：schema.rs:141-149, 250-253；migrate.rs:535-563（v7 先例）
- 迁移机制：migrate.rs:99-209（user_version 事务内 :193-198；备份范围 :152-171）
- 版本常量：lib.rs:56-58
- 幂等写入先例：blocks.rs:15-16；import.rs:52-69
- 缺表降级：blocks.rs:13-30
- 壳层命令模式：session_commands.rs:33-64（SharedDb）、318-337（spawn_blocking 导入）；main.rs:168-176（注册）；command_manifest.rs:136
- 统计类型现状：conex-types/src/lib.rs:274-281；storage_state.rs:242-253（撞名先例）
- 升级测试模式：tests/blocks.rs:82-134, 164-174；tests.rs:375, 741
